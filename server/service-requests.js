import { randomUUID } from 'node:crypto';

import { enqueueEmail } from './email-service.js';

export class ServiceRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ServiceRequestError';
    this.status = status;
    this.code = code;
  }
}

function requireKey(value) {
  const key = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) throw new ServiceRequestError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
  return key;
}

function userRow(db, userId) {
  return db.prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'user' AND status != 'Suspended'").get(userId);
}

function requireAdmin(db, userId) {
  const admin = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('admin', 'owner') AND status = 'Active'").get(userId);
  if (!admin) throw new ServiceRequestError(403, 'ADMIN_REQUIRED', 'Administrator authorization is required.');
}

function parse(row) {
  return row ? {
    ...JSON.parse(row.raw_json || '{}'), id: row.id, requesterId: row.requester_user_id, type: row.type,
    subject: row.subject, status: row.status, priority: row.priority, assignee: row.assignee,
    requested: row.requested_at, createdAt: row.requested_at ?? row.created_at, updatedAt: row.updated_at,
  } : null;
}

function notify(db, row, { eventType, subject, message, createdAt }) {
  const user = userRow(db, row.requester_user_id);
  if (!user) return;
  enqueueEmail(db, {
    idempotencyKey: `email:${row.id}:${eventType}`, eventType, aggregateType: row.requested_at ? 'card-request' : 'case', aggregateId: row.id,
    recipient: user.email, recipientUserId: user.id, templateId: 'account-status',
    payload: { name: user.name, subject, message, reference: row.id, occurredAt: createdAt }, createdAt,
  });
}

export function createCardRequest(db, { requesterId, cardType, idempotencyKey }) {
  const key = `card:${requesterId}:${requireKey(idempotencyKey)}`;
  const type = String(cardType ?? '').trim();
  if (!['Virtual Card', 'Physical Card'].includes(type)) throw new ServiceRequestError(400, 'INVALID_CARD_TYPE', 'Choose a virtual or physical card.');
  const execute = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM card_requests WHERE idempotency_key = ?').get(key);
    if (existing) return { replayed: true, request: parse(existing) };
    const user = userRow(db, requesterId);
    if (!user) throw new ServiceRequestError(403, 'REQUESTER_NOT_ELIGIBLE', 'This account cannot request a card.');
    const createdAt = new Date().toISOString();
    const id = `CARD-${randomUUID()}`;
    const raw = { requesterName: user.name, type: `${type} ATM Card` };
    db.prepare("INSERT INTO card_requests (id, requester_user_id, type, status, requested_at, updated_at, idempotency_key, raw_json) VALUES (?, ?, ?, 'Pending', ?, ?, ?, ?)")
      .run(id, requesterId, type, createdAt, createdAt, key, JSON.stringify(raw));
    const row = db.prepare('SELECT * FROM card_requests WHERE id = ?').get(id);
    notify(db, row, { eventType: 'card.requested', subject: 'Your Nevora Core card request was received', message: `${type} request ${id} is pending review.`, createdAt });
    return { replayed: false, request: parse(row) };
  });
  return execute.immediate();
}

export function decideCardRequest(db, { adminId, requestId, status, reason = '' }) {
  const nextStatus = String(status ?? '').trim();
  if (!['Approved', 'Rejected', 'Production', 'Dispatched', 'Delivered', 'Active'].includes(nextStatus)) throw new ServiceRequestError(400, 'INVALID_STATUS', 'Choose a supported card status.');
  const note = String(reason ?? '').trim().slice(0, 1000);
  if (nextStatus === 'Rejected' && !note) throw new ServiceRequestError(400, 'REASON_REQUIRED', 'A rejection reason is required.');
  const execute = db.transaction(() => {
    requireAdmin(db, adminId);
    const row = db.prepare('SELECT * FROM card_requests WHERE id = ?').get(requestId);
    if (!row) throw new ServiceRequestError(404, 'CARD_REQUEST_NOT_FOUND', 'Card request not found.');
    const createdAt = new Date().toISOString();
    const raw = { ...JSON.parse(row.raw_json || '{}'), reason: note, reviewedBy: adminId };
    db.prepare('UPDATE card_requests SET status = ?, updated_at = ?, raw_json = ? WHERE id = ?').run(nextStatus, createdAt, JSON.stringify(raw), requestId);
    const updated = db.prepare('SELECT * FROM card_requests WHERE id = ?').get(requestId);
    notify(db, updated, { eventType: `card.${nextStatus.toLowerCase()}`, subject: `Your Nevora Core card request is ${nextStatus.toLowerCase()}`, message: note || `Card request ${requestId} is now ${nextStatus}.`, createdAt });
    return { request: parse(updated) };
  });
  return execute.immediate();
}

export function createCase(db, { requesterId, type, subject, details = {}, idempotencyKey }) {
  const caseType = String(type ?? '').trim();
  if (!['Support', 'Loan', 'Investment'].includes(caseType)) throw new ServiceRequestError(400, 'INVALID_CASE_TYPE', 'Choose a supported request type.');
  const normalizedSubject = String(subject ?? '').trim().slice(0, 200);
  if (!normalizedSubject) throw new ServiceRequestError(400, 'SUBJECT_REQUIRED', 'A request subject is required.');
  const key = `case:${requesterId}:${requireKey(idempotencyKey)}`;
  const execute = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM cases WHERE id = (SELECT id FROM cases WHERE json_extract(raw_json, \'$.idempotencyKey\') = ?)').get(key);
    if (existing) return { replayed: true, request: parse(existing) };
    const user = userRow(db, requesterId);
    if (!user) throw new ServiceRequestError(403, 'REQUESTER_NOT_ELIGIBLE', 'This account cannot submit this request.');
    const createdAt = new Date().toISOString();
    const id = `CASE-${randomUUID()}`;
    const raw = { ...details, requesterName: user.name, idempotencyKey: key };
    db.prepare("INSERT INTO cases (id, requester_user_id, type, subject, status, priority, assignee, created_at, updated_at, raw_json) VALUES (?, ?, ?, ?, 'Open', ?, ?, ?, ?, ?)")
      .run(id, requesterId, caseType, normalizedSubject, details.priority || 'Medium', details.assignee || `${caseType} Desk`, createdAt, createdAt, JSON.stringify(raw));
    const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
    notify(db, row, { eventType: `${caseType.toLowerCase()}.submitted`, subject: `${caseType} request received`, message: `Request ${id} was received and is open for review.`, createdAt });
    return { replayed: false, request: parse(row) };
  });
  return execute.immediate();
}

export function decideCase(db, { adminId, caseId, status, reason = '' }) {
  const nextStatus = String(status ?? '').trim();
  if (!['Reviewing', 'Approved', 'Rejected', 'Resolved', 'Escalated'].includes(nextStatus)) throw new ServiceRequestError(400, 'INVALID_STATUS', 'Choose a supported case status.');
  const note = String(reason ?? '').trim().slice(0, 2000);
  if (nextStatus === 'Rejected' && !note) throw new ServiceRequestError(400, 'REASON_REQUIRED', 'A rejection reason is required.');
  const execute = db.transaction(() => {
    requireAdmin(db, adminId);
    const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    if (!row) throw new ServiceRequestError(404, 'CASE_NOT_FOUND', 'Request not found.');
    const createdAt = new Date().toISOString();
    const raw = { ...JSON.parse(row.raw_json || '{}'), adminNote: note, reviewedBy: adminId };
    db.prepare('UPDATE cases SET status = ?, updated_at = ?, raw_json = ? WHERE id = ?').run(nextStatus, createdAt, JSON.stringify(raw), caseId);
    const updated = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
    notify(db, updated, { eventType: `${row.type.toLowerCase()}.${nextStatus.toLowerCase()}`, subject: `${row.type} request ${nextStatus.toLowerCase()}`, message: note || `Request ${caseId} is now ${nextStatus}.`, createdAt });
    return { request: parse(updated) };
  });
  return execute.immediate();
}

export function listServiceRequests(db, { requesterId = null } = {}) {
  const cards = requesterId ? db.prepare('SELECT * FROM card_requests WHERE requester_user_id = ? ORDER BY requested_at DESC').all(requesterId) : db.prepare('SELECT * FROM card_requests ORDER BY requested_at DESC').all();
  const cases = requesterId ? db.prepare('SELECT * FROM cases WHERE requester_user_id = ? ORDER BY created_at DESC').all(requesterId) : db.prepare('SELECT * FROM cases ORDER BY created_at DESC').all();
  return { cards: cards.map(parse), cases: cases.map(parse) };
}