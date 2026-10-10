import { randomUUID } from 'node:crypto';

import { enqueueEmail } from './email-service.js';
import { isValidEmailHeader } from './security.js';

export class CommunicationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'CommunicationError';
    this.status = status;
    this.code = code;
  }
}

function requireAdmin(db, actorUserId) {
  const admin = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('admin', 'owner') AND status = 'Active'").get(actorUserId);
  if (!admin) throw new CommunicationError(403, 'ADMIN_REQUIRED', 'Administrator authorization is required.');
}

function normalizeInput(input) {
  const title = String(input.title ?? '').trim();
  const message = String(input.message ?? '').trim();
  const audienceType = input.audienceType === 'selected' ? 'selected' : 'all';
  const deliveryMethod = ['in-app', 'email', 'both'].includes(input.deliveryMethod) ? input.deliveryMethod : '';
  const recipientIds = [...new Set((Array.isArray(input.recipientIds) ? input.recipientIds : []).map(String))];
  if (!isValidEmailHeader(title) || !message || message.length > 5000) throw new CommunicationError(400, 'INVALID_MESSAGE', 'Enter a title and message of no more than 5,000 characters.');
  if (!deliveryMethod) throw new CommunicationError(400, 'INVALID_DELIVERY_METHOD', 'Choose in-app, email, or both.');
  if (audienceType === 'selected' && recipientIds.length === 0) throw new CommunicationError(400, 'RECIPIENTS_REQUIRED', 'Choose at least one customer.');
  return { title, message, audienceType, deliveryMethod, recipientIds };
}

function resolveRecipients(db, input) {
  if (input.audienceType === 'all') return db.prepare("SELECT id, name, email FROM users WHERE role = 'user' AND status != 'Suspended' ORDER BY id").all();
  const placeholders = input.recipientIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, name, email FROM users WHERE role = 'user' AND status != 'Suspended' AND id IN (${placeholders}) ORDER BY id`).all(...input.recipientIds);
  if (rows.length !== input.recipientIds.length) throw new CommunicationError(400, 'INVALID_RECIPIENTS', 'One or more selected customers are unavailable.');
  return rows;
}

export function previewCampaign(db, { actorUserId, ...input }) {
  requireAdmin(db, actorUserId);
  const normalized = normalizeInput(input);
  const recipients = resolveRecipients(db, normalized);
  return {
    recipientCount: recipients.length,
    confirmation: recipients.length > 1 ? `SEND TO ${recipients.length} CUSTOMERS` : '',
    recipients: recipients.map(({ id, name }) => ({ id, name })),
  };
}

function campaignSummary(db, campaignId) {
  const campaign = db.prepare('SELECT * FROM email_campaigns WHERE id = ?').get(campaignId);
  if (!campaign) return null;
  const statuses = db.prepare(`SELECT status, provider_status, COUNT(*) count FROM email_outbox WHERE aggregate_type = 'campaign' AND aggregate_id = ? GROUP BY status, provider_status`).all(campaignId);
  const attempted = statuses.reduce((sum, entry) => sum + entry.count, 0);
  const count = (predicate) => statuses.filter(predicate).reduce((sum, entry) => sum + entry.count, 0);
  return {
    id: campaign.id,
    title: campaign.title,
    message: campaign.message,
    audienceType: campaign.audience_type,
    deliveryMethod: campaign.delivery_method,
    recipientCount: campaign.recipient_count,
    createdAt: campaign.created_at,
    attempted,
    pending: count((entry) => ['pending', 'processing'].includes(entry.status)),
    accepted: count((entry) => entry.status === 'accepted'),
    delivered: count((entry) => entry.provider_status === 'delivered'),
    failed: count((entry) => ['failed', 'suppressed'].includes(entry.status)),
    bounced: count((entry) => entry.provider_status === 'bounced'),
    complained: count((entry) => entry.provider_status === 'complained'),
  };
}

export function createCampaign(db, { actorUserId, idempotencyKey, confirmation = '', ...input }) {
  const normalizedKey = String(idempotencyKey ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalizedKey)) throw new CommunicationError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
  const normalized = normalizeInput(input);
  const execute = db.transaction(() => {
    requireAdmin(db, actorUserId);
    const existing = db.prepare('SELECT id FROM email_campaigns WHERE idempotency_key = ?').get(normalizedKey);
    if (existing) return { replayed: true, campaign: campaignSummary(db, existing.id) };
    const recipients = resolveRecipients(db, normalized);
    if (recipients.length === 0) throw new CommunicationError(400, 'NO_RECIPIENTS', 'No eligible customers match this audience.');
    const requiredConfirmation = recipients.length > 1 ? `SEND TO ${recipients.length} CUSTOMERS` : '';
    if (requiredConfirmation && confirmation !== requiredConfirmation) throw new CommunicationError(400, 'CONFIRMATION_REQUIRED', `Enter ${requiredConfirmation} to send this announcement.`);
    const campaignId = `CAM-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO email_campaigns (id, idempotency_key, actor_user_id, title, message, audience_type, delivery_method, recipient_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(campaignId, normalizedKey, actorUserId, normalized.title, normalized.message, normalized.audienceType, normalized.deliveryMethod, recipients.length, createdAt);
    for (const recipient of recipients) {
      if (['in-app', 'both'].includes(normalized.deliveryMethod)) {
        db.prepare(`INSERT INTO notifications (id, user_id, event_type, title, message, idempotency_key, created_at, metadata_json) VALUES (?, ?, 'admin-announcement', ?, ?, ?, ?, ?)`)
          .run(`NOTICE-${campaignId}-${recipient.id}`, recipient.id, normalized.title, normalized.message, `notification:${campaignId}:${recipient.id}`, createdAt, JSON.stringify({ campaignId }));
      }
      if (['email', 'both'].includes(normalized.deliveryMethod)) {
        enqueueEmail(db, {
          idempotencyKey: `email:${campaignId}:${recipient.id}`, eventType: 'campaign.announcement', aggregateType: 'campaign', aggregateId: campaignId,
          recipient: recipient.email, recipientUserId: recipient.id, templateId: 'announcement',
          payload: { name: recipient.name, subject: normalized.title, message: normalized.message }, createdAt,
        });
      }
    }
    db.prepare(`INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'campaign.created', 'campaign', ?, ?, ?)`)
      .run(actorUserId, campaignId, JSON.stringify({ recipientCount: recipients.length, audienceType: normalized.audienceType, deliveryMethod: normalized.deliveryMethod }), createdAt);
    return { replayed: false, campaign: campaignSummary(db, campaignId) };
  });
  try {
    return execute.immediate();
  } catch (error) {
    if (error instanceof CommunicationError) throw error;
    if (String(error?.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
      const existing = db.prepare('SELECT id FROM email_campaigns WHERE idempotency_key = ?').get(normalizedKey);
      if (existing) return { replayed: true, campaign: campaignSummary(db, existing.id) };
    }
    throw error;
  }
}

export function listCampaigns(db, { actorUserId, limit = 50 }) {
  requireAdmin(db, actorUserId);
  return db.prepare('SELECT id FROM email_campaigns ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(Number(limit) || 50, 100))).map((entry) => campaignSummary(db, entry.id));
}

export function retryCampaign(db, { actorUserId, campaignId }) {
  requireAdmin(db, actorUserId);
  const campaign = db.prepare('SELECT id FROM email_campaigns WHERE id = ?').get(campaignId);
  if (!campaign) throw new CommunicationError(404, 'CAMPAIGN_NOT_FOUND', 'Announcement not found.');
  const updatedAt = new Date().toISOString();
  const result = db.prepare(`UPDATE email_outbox SET status = 'pending', provider_status = 'queued', next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE aggregate_type = 'campaign' AND aggregate_id = ? AND status = 'failed' AND attempt_count < 5`).run(updatedAt, updatedAt, campaignId);
  db.prepare(`INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'campaign.retry-requested', 'campaign', ?, ?, ?)`)
    .run(actorUserId, campaignId, JSON.stringify({ queuedCount: result.changes }), updatedAt);
  return { queuedCount: result.changes, campaign: campaignSummary(db, campaignId) };
}
