import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Resend } from 'resend';

import { escapeHtml, isValidEmail, isValidEmailHeader, normalizeEmail } from './security.js';

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000];
const FINAL_PROVIDER_STATUSES = new Set(['delivered', 'bounced', 'complained', 'failed', 'suppressed']);
const SERVICE_DISCLOSURE = 'Nevora Core is a financial operations platform. Regulated banking services require separately disclosed licensed providers.';

function asText(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function money(amount, currency = 'USD') {
  const numericAmount = Number(amount);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number.isFinite(numericAmount) ? numericAmount : 0);
}

function dateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC'
    : 'Not available';
}

function brandLayout({ preheader, heading, name, paragraphs, details = [], action = null, appBaseUrl, supportEmail }) {
  const safePreheader = escapeHtml(preheader);
  const safeHeading = escapeHtml(heading);
  const safeName = escapeHtml(name || 'Customer');
  const detailsHtml = details.length > 0
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0;border-collapse:collapse;background:#f4f7fa;border-radius:8px">${details.map(([label, value]) => `<tr><td style="padding:10px 14px;color:#52606d;font-size:13px;border-bottom:1px solid #dde4ea">${escapeHtml(label)}</td><td style="padding:10px 14px;color:#102a43;font-size:14px;font-weight:700;text-align:right;border-bottom:1px solid #dde4ea">${escapeHtml(value)}</td></tr>`).join('')}</table>`
    : '';
  const actionHtml = action
    ? `<p style="margin:28px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#f58025;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:6px">${escapeHtml(action.label)}</a></p>`
    : '';
  const support = supportEmail ? ` Contact us at ${supportEmail}.` : '';
  const text = [heading, '', `Hello ${name || 'Customer'},`, '', ...paragraphs, '', ...details.map(([label, value]) => `${label}: ${value}`), action ? `Open: ${action.url}` : '', '', `For help, visit ${appBaseUrl}.${support}`, '', SERVICE_DISCLOSURE, '', 'Nevora Core'].filter(Boolean).join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#eef2f6;color:#102a43;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">${safePreheader}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fff;border-radius:8px;overflow:hidden"><tr><td style="background:#073b4c;padding:20px 28px;color:#fff"><span style="display:inline-block;width:34px;height:34px;line-height:34px;text-align:center;border-radius:6px;background:#16a085;font-weight:800;margin-right:10px">NC</span><strong style="font-size:20px;vertical-align:middle">NEVORA CORE</strong></td></tr><tr><td style="padding:30px 28px"><h1 style="font-size:26px;line-height:1.25;margin:0 0 18px">${safeHeading}</h1><p style="font-size:16px;line-height:1.6">Hello ${safeName},</p>${paragraphs.map((paragraph) => `<p style="font-size:16px;line-height:1.6">${escapeHtml(paragraph)}</p>`).join('')}${detailsHtml}${actionHtml}<p style="font-size:14px;line-height:1.6;color:#52606d">For help, visit <a href="${escapeHtml(appBaseUrl)}" style="color:#005ea8">${escapeHtml(appBaseUrl)}</a>.${escapeHtml(support)}</p></td></tr><tr><td style="background:#f4f7fa;padding:18px 28px;color:#627d98;font-size:12px;line-height:1.5"><strong>${escapeHtml(SERVICE_DISCLOSURE)}</strong><br><br>This service message was sent individually to protect customer privacy. Never reply with a password, verification code, or full account number.</td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}

export function renderEmail(templateId, payload, options = {}) {
  const appBaseUrl = options.appBaseUrl || 'http://localhost:5173';
  const supportEmail = options.supportEmail || '';
  const name = asText(payload.name, 120);
  const reference = asText(payload.reference || payload.transactionId || payload.withdrawalId, 160);
  const occurredAt = dateTime(payload.occurredAt || payload.createdAt || new Date().toISOString());
  const amount = money(payload.amount, payload.currency || 'USD');
  let subject;
  let content;

  switch (templateId) {
    case 'welcome':
      subject = 'Welcome to Nevora Core';
      content = brandLayout({ preheader: 'Your Nevora Core account has been created.', heading: 'Your account is ready', name, paragraphs: ['Welcome to Nevora Core. Your account was created successfully.', 'Sign in to review your account details and complete any outstanding verification steps.'], details: [['Account', `Ending ${asText(payload.accountLast4, 4)}`], ['Status', 'Created']], action: { label: 'Open Nevora Core', url: appBaseUrl }, appBaseUrl, supportEmail });
      break;
    case 'email-verification':
      subject = 'Verify your Nevora Core email';
      content = brandLayout({ preheader: 'Verify the email address for your Nevora Core profile.', heading: 'Verify your email', name, paragraphs: ['Use the secure link below to confirm this email address. The link expires in 24 hours.'], action: { label: 'Verify email', url: payload.actionUrl }, appBaseUrl, supportEmail });
      break;
    case 'password-reset':
      subject = 'Reset your Nevora Core password';
      content = brandLayout({ preheader: 'A password reset was requested.', heading: 'Reset your password', name, paragraphs: ['Use the secure link below to choose a new password. The link expires in 30 minutes.', 'If you did not request this, you can ignore this email.'], action: { label: 'Reset password', url: payload.actionUrl }, appBaseUrl, supportEmail });
      break;
    case 'password-changed':
      subject = 'Your Nevora Core password was changed';
      content = brandLayout({ preheader: 'Your password has been changed.', heading: 'Password changed', name, paragraphs: ['Your Nevora Core password was changed successfully.', 'If you did not make this change, contact support immediately.'], details: [['Date', occurredAt]], action: { label: 'Open Nevora Core', url: appBaseUrl }, appBaseUrl, supportEmail });
      break;
    case 'transfer-sent':
      subject = payload.status === 'Completed' ? 'Nevora Core transfer completed' : 'Nevora Core transfer submitted';
      content = brandLayout({ preheader: `${amount} transfer update.`, heading: subject, name, paragraphs: [payload.status === 'Completed' ? `Your transfer to ${asText(payload.recipientName, 120)} completed.` : `Your transfer to ${asText(payload.recipientName, 120)} is pending recipient verification.`], details: [['Amount', amount], ['Reference', reference], ['Date', occurredAt], ['Status', asText(payload.status, 80)]], appBaseUrl, supportEmail });
      break;
    case 'transfer-received':
      subject = payload.status === 'Completed' ? 'You received a Nevora Core transfer' : 'Incoming transfer pending verification';
      content = brandLayout({ preheader: `${amount} incoming transfer update.`, heading: subject, name, paragraphs: [payload.status === 'Completed' ? `${asText(payload.senderName, 120)} sent money to your Nevora Core account.` : `${asText(payload.senderName, 120)} sent money that remains on hold until account verification is complete.`], details: [['Amount', amount], ['Reference', reference], ['Date', occurredAt], ['Status', asText(payload.status, 80)]], appBaseUrl, supportEmail });
      break;
    case 'admin-credit':
      subject = 'Deposit posted to your Nevora Core account';
      content = brandLayout({ preheader: `${amount} was credited to your account.`, heading: 'Deposit completed', name, paragraphs: [`A deposit was posted to your ${asText(payload.accountLabel, 80)} account.`], details: [['Amount', amount], ['Reference', reference], ['Date', occurredAt], ['Status', 'Completed']], appBaseUrl, supportEmail });
      break;
    case 'withdrawal':
      subject = `Withdrawal ${asText(payload.status, 80).toLowerCase()}`;
      content = brandLayout({ preheader: `${amount} withdrawal update.`, heading: subject, name, paragraphs: [asText(payload.message, 500)], details: [['Amount', amount], ['Reference', reference], ['Date', occurredAt], ['Status', asText(payload.status, 80)]], appBaseUrl, supportEmail });
      break;
    case 'account-status':
      subject = asText(payload.subject, 160) || 'Important Nevora Core account update';
      content = brandLayout({ preheader: subject, heading: subject, name, paragraphs: [asText(payload.message, 2000)], details: payload.reference ? [['Reference', reference], ['Date', occurredAt]] : [['Date', occurredAt]], action: { label: 'Open Nevora Core', url: appBaseUrl }, appBaseUrl, supportEmail });
      break;
    case 'announcement':
      subject = asText(payload.subject, 160);
      content = brandLayout({ preheader: subject, heading: subject, name, paragraphs: [asText(payload.message, 5000)], action: { label: 'Open Nevora Core', url: appBaseUrl }, appBaseUrl, supportEmail });
      break;
    default:
      throw new Error(`Unknown email template: ${templateId}`);
  }

  if (!isValidEmailHeader(subject)) throw new Error('Email subject is invalid.');
  return { subject, ...content };
}

export function enqueueEmail(db, { idempotencyKey, eventType, aggregateType = null, aggregateId = null, recipient, recipientUserId = null, templateId, payload, createdAt = new Date().toISOString() }) {
  const normalizedRecipient = normalizeEmail(recipient);
  if (!isValidEmail(normalizedRecipient)) throw new Error('Email recipient is invalid.');
  const result = db.prepare(`
    INSERT INTO email_outbox (
      idempotency_key, event_type, aggregate_type, aggregate_id, recipient, recipient_user_id,
      template_id, payload_json, status, provider_status, created_at, updated_at, next_attempt_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'queued', ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING
  `).run(idempotencyKey, eventType, aggregateType, aggregateId, normalizedRecipient, recipientUserId, templateId, JSON.stringify(payload), createdAt, createdAt, createdAt);
  return result.changes === 1;
}

export function createResendProvider(env = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const fromEmail = env.EMAIL_FROM?.trim();
  const fromName = env.EMAIL_FROM_NAME?.trim() || 'Nevora Core';
  if (!apiKey || !isValidEmail(fromEmail)) return null;
  const resend = new Resend(apiKey);
  return {
    async send(message, idempotencyKey) {
      const response = await resend.emails.send({ from: `${fromName} <${fromEmail}>`, ...message }, { idempotencyKey });
      if (response.error) {
        const error = new Error(response.error.message || 'Resend rejected the email.');
        error.name = response.error.name || 'ResendError';
        throw error;
      }
      return { id: response.data?.id };
    },
    verifyWebhook(payload, headers, webhookSecret) {
      return resend.webhooks.verify({ payload, headers, webhookSecret });
    },
  };
}

export function createEmailProcessor({ db, env = process.env, provider = createResendProvider(env), now = () => Date.now() }) {
  const mode = ['disabled', 'restricted', 'live'].includes(String(env.EMAIL_MODE).toLowerCase()) ? String(env.EMAIL_MODE).toLowerCase() : 'disabled';
  const testRecipient = normalizeEmail(env.EMAIL_TEST_RECIPIENT);
  const appBaseUrl = String(env.APP_BASE_URL || 'http://localhost:5173').replace(/\/$/, '');
  const supportEmail = normalizeEmail(env.EMAIL_REPLY_TO);

  async function processOne(row) {
    const claimedAt = new Date(now()).toISOString();
    const claim = db.prepare(`UPDATE email_outbox SET status = 'processing', attempt_count = attempt_count + 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'failed')`).run(claimedAt, row.id);
    if (claim.changes !== 1) return false;
    if (mode === 'restricted' && (!testRecipient || row.recipient !== testRecipient)) {
      db.prepare("UPDATE email_outbox SET status = 'suppressed', provider_status = 'suppressed', last_error = 'Restricted recipient', updated_at = ? WHERE id = ?").run(claimedAt, row.id);
      return true;
    }
    try {
      const rendered = renderEmail(row.template_id, JSON.parse(row.payload_json), { appBaseUrl, supportEmail });
      const response = await provider.send({ to: row.recipient, replyTo: supportEmail || undefined, ...rendered }, row.idempotency_key);
      const acceptedAt = new Date(now()).toISOString();
      db.prepare(`UPDATE email_outbox SET status = 'accepted', provider_status = 'accepted', provider_message_id = ?, last_error = NULL, sent_at = ?, updated_at = ?, next_attempt_at = NULL WHERE id = ?`).run(response.id || null, acceptedAt, acceptedAt, row.id);
    } catch (error) {
      const attemptCount = row.attempt_count + 1;
      const failedAt = new Date(now()).toISOString();
      const nextAttemptAt = attemptCount < MAX_ATTEMPTS ? new Date(now() + RETRY_DELAYS_MS[Math.min(attemptCount - 1, RETRY_DELAYS_MS.length - 1)]).toISOString() : null;
      db.prepare(`UPDATE email_outbox SET status = 'failed', provider_status = 'failed', last_error = ?, updated_at = ?, next_attempt_at = ? WHERE id = ?`).run(asText(error?.message || 'Email provider unavailable.', 500), failedAt, nextAttemptAt, row.id);
    }
    return true;
  }

  async function processBatch(limit = 20) {
    if (!provider || mode === 'disabled') return { processed: 0, configured: Boolean(provider), mode };
    const currentTime = new Date(now()).toISOString();
    const rows = db.prepare(`SELECT * FROM email_outbox WHERE status = 'pending' OR (status = 'failed' AND attempt_count < ? AND next_attempt_at <= ?) ORDER BY created_at, id LIMIT ?`).all(MAX_ATTEMPTS, currentTime, Math.max(1, Math.min(Number(limit) || 20, 100)));
    let processed = 0;
    for (const row of rows) if (await processOne(row)) processed += 1;
    return { processed, configured: true, mode };
  }

  return { processBatch, mode, configured: Boolean(provider) };
}

export function recordResendWebhook(db, event) {
  const eventId = asText(event?.id, 200);
  const eventType = asText(event?.type, 100);
  const providerMessageId = asText(event?.data?.email_id || event?.data?.id, 200);
  if (!eventId || !eventType || !providerMessageId) throw new Error('Webhook event is incomplete.');
  const receivedAt = new Date().toISOString();
  const inserted = db.prepare(`INSERT INTO email_webhook_events (provider_event_id, event_type, provider_message_id, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider_event_id) DO NOTHING`).run(eventId, eventType, providerMessageId, receivedAt);
  if (inserted.changes === 0) return { duplicate: true };
  const providerStatus = eventType.replace(/^email\./, '');
  const status = providerStatus === 'delivered' ? 'delivered' : ['bounced', 'failed'].includes(providerStatus) ? 'failed' : providerStatus === 'complained' ? 'suppressed' : 'accepted';
  const deliveredAt = providerStatus === 'delivered' ? receivedAt : null;
  db.prepare(`UPDATE email_outbox SET status = ?, provider_status = ?, delivered_at = COALESCE(?, delivered_at), last_error = CASE WHEN ? IN ('bounced', 'complained', 'failed') THEN ? ELSE last_error END, updated_at = ? WHERE provider_message_id = ?`).run(status, providerStatus, deliveredAt, providerStatus, providerStatus, receivedAt, providerMessageId);
  return { duplicate: false, status: FINAL_PROVIDER_STATUSES.has(providerStatus) ? providerStatus : 'accepted' };
}

export function issueActionToken(db, { userId, purpose, lifetimeMs, now = () => Date.now() }) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const id = randomUUID();
  const createdAt = new Date(now()).toISOString();
  const expiresAt = new Date(now() + lifetimeMs).toISOString();
  db.prepare(`UPDATE auth_action_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL`).run(createdAt, userId, purpose);
  db.prepare(`INSERT INTO auth_action_tokens (id, user_id, purpose, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, userId, purpose, tokenHash, expiresAt, createdAt);
  return { id, token, expiresAt };
}

export function consumeActionToken(db, { token, purpose, now = () => Date.now() }) {
  const tokenHash = createHash('sha256').update(String(token || '')).digest('hex');
  const currentTime = new Date(now()).toISOString();
  const row = db.prepare(`SELECT * FROM auth_action_tokens WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?`).get(tokenHash, purpose, currentTime);
  if (!row) return null;
  const result = db.prepare(`UPDATE auth_action_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`).run(currentTime, row.id);
  return result.changes === 1 ? row : null;
}
