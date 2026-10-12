import { randomInt, randomUUID } from 'node:crypto';

import { enqueueEmail } from './email-service.js';
import { hashPassword, verifyPassword } from './security.js';

const REVIEW_WINDOW_MS = 5 * 60 * 1000;

export class WithdrawalError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'WithdrawalError';
    this.status = status;
    this.code = code;
  }
}

function parseAmountMinor(value) {
  const normalized = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(normalized)) {
    throw new WithdrawalError(400, 'INVALID_AMOUNT', 'Enter a valid positive amount with no more than two decimal places.');
  }

  const [whole, fraction = ''] = normalized.split('.');
  const amountMinor = (Number(whole) * 100) + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new WithdrawalError(400, 'INVALID_AMOUNT', 'Withdrawal amount must be greater than zero.');
  }
  return amountMinor;
}

function formatWithdrawal(row) {
  const raw = JSON.parse(row.raw_json || '{}');
  return {
    ...raw,
    id: row.id,
    requesterId: row.requester_user_id,
    requesterName: row.requester_name ?? raw.requesterName ?? '',
    amount: `$${(row.amount_minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    amountValue: row.amount_minor / 100,
    destination: row.destination,
    status: row.status,
    requested: row.requested_at,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    code: row.approval_code_hash ? 'Issued securely' : 'Awaiting approval',
  };
}

function findWithdrawal(db, id) {
  return db.prepare(`
    SELECT withdrawal_requests.*, users.name AS requester_name, users.email AS requester_email
    FROM withdrawal_requests
    LEFT JOIN users ON users.id = withdrawal_requests.requester_user_id
    WHERE withdrawal_requests.id = ?
  `).get(id);
}

function parseRaw(row) {
  try {
    return JSON.parse(row.raw_json || '{}');
  } catch {
    return {};
  }
}

function requireExpectedUpdate(value) {
  const expectedUpdatedAt = String(value ?? '').trim();
  if (!expectedUpdatedAt) {
    throw new WithdrawalError(400, 'VERSION_REQUIRED', 'The withdrawal version is required. Refresh and try again.');
  }
  return expectedUpdatedAt;
}

function insertNotification(db, { id, userId, eventType, title, message, createdAt, metadata }) {
  db.prepare(`
    INSERT INTO notifications (id, user_id, event_type, title, message, idempotency_key, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, eventType, title, message, `notification:${id}`, createdAt, JSON.stringify(metadata));
}

function insertAudit(db, { actorUserId, action, withdrawalId, details, createdAt }) {
  db.prepare(`
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at)
    VALUES (?, ?, 'withdrawal', ?, ?, ?)
  `).run(actorUserId, action, withdrawalId, JSON.stringify(details), createdAt);
}

function enqueueWithdrawalEmail(db, row, { status, message, createdAt, eventKey }) {
  enqueueEmail(db, {
    idempotencyKey: `email:${row.id}:withdrawal:${eventKey}`,
    eventType: `withdrawal.${eventKey}`,
    aggregateType: 'withdrawal',
    aggregateId: row.id,
    recipient: row.requester_email,
    recipientUserId: row.requester_user_id,
    templateId: 'withdrawal',
    payload: {
      name: row.requester_name,
      amount: (row.amount_minor / 100).toFixed(2),
      currency: row.currency,
      reference: row.id,
      occurredAt: createdAt,
      status,
      message,
    },
    createdAt,
  });
}

export function listWithdrawals(db, { requesterId = null } = {}) {
  const rows = requesterId
    ? db.prepare(`
        SELECT withdrawal_requests.*, users.name AS requester_name
        FROM withdrawal_requests
        LEFT JOIN users ON users.id = withdrawal_requests.requester_user_id
        WHERE withdrawal_requests.requester_user_id = ?
        ORDER BY withdrawal_requests.requested_at DESC
      `).all(requesterId)
    : db.prepare(`
        SELECT withdrawal_requests.*, users.name AS requester_name
        FROM withdrawal_requests
        LEFT JOIN users ON users.id = withdrawal_requests.requester_user_id
        ORDER BY withdrawal_requests.requested_at DESC
      `).all();

  return rows.map(formatWithdrawal);
}

export function createWithdrawalRequest(db, { requesterId, bankId, amount, message = '', idempotencyKey }) {
  const normalizedKey = String(idempotencyKey ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalizedKey)) {
    throw new WithdrawalError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
  }

  const amountMinor = parseAmountMinor(amount);
  const normalizedBankId = String(bankId ?? '').trim();
  const normalizedMessage = String(message ?? '').trim().slice(0, 500);
  if (!normalizedBankId) throw new WithdrawalError(400, 'BANK_REQUIRED', 'Select a saved bank for this withdrawal.');
  const scopedIdempotencyKey = `withdrawal:${requesterId}:${normalizedKey}`;

  const execute = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM withdrawal_requests WHERE idempotency_key = ?').get(scopedIdempotencyKey);
    if (existing) return { replayed: true, request: formatWithdrawal(findWithdrawal(db, existing.id)) };

    const requester = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'user' AND status != 'Suspended'").get(requesterId);
    if (!requester) throw new WithdrawalError(403, 'REQUESTER_NOT_ELIGIBLE', 'This account cannot submit withdrawal requests.');

    const bank = db.prepare('SELECT * FROM saved_banks WHERE id = ? AND user_id = ?').get(normalizedBankId, requesterId);
    if (!bank) throw new WithdrawalError(404, 'BANK_NOT_FOUND', 'The selected saved bank is unavailable.');

    const destination = `${bank.bank_name} • ${bank.masked_account_number}`;
    const requestedAt = new Date().toISOString();
    const requestId = `WD-${randomUUID()}`;
    const raw = { message: normalizedMessage };
    db.prepare(`
      INSERT INTO withdrawal_requests (
        id, requester_user_id, amount_minor, currency, destination, status, requested_at, updated_at,
        idempotency_key, raw_json
      ) VALUES (?, ?, ?, 'USD', ?, 'Pending', ?, ?, ?, ?)
    `).run(requestId, requesterId, amountMinor, destination, requestedAt, requestedAt, scopedIdempotencyKey, JSON.stringify(raw));
    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at)
      VALUES (?, 'withdrawal.requested', 'withdrawal', ?, ?, ?)
    `).run(requesterId, requestId, JSON.stringify({ amountMinor, bankId: normalizedBankId }), requestedAt);
    enqueueWithdrawalEmail(db, findWithdrawal(db, requestId), {
      status: 'Pending', eventKey: 'requested', createdAt: requestedAt,
      message: 'Your withdrawal request was received and is pending review. No payout has been completed.',
    });

    return { replayed: false, request: formatWithdrawal(findWithdrawal(db, requestId)) };
  });

  try {
    return execute.immediate();
  } catch (error) {
    if (error instanceof WithdrawalError) throw error;
    if (String(error?.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
      const existing = db.prepare('SELECT id FROM withdrawal_requests WHERE idempotency_key = ?').get(scopedIdempotencyKey);
      if (existing) return { replayed: true, request: formatWithdrawal(findWithdrawal(db, existing.id)) };
    }
    throw error;
  }
}

export async function decideWithdrawal(db, { adminId, withdrawalId, decision, expectedUpdatedAt, note = '' }) {
  const normalizedDecision = String(decision ?? '').trim().toLowerCase();
  if (!['approve', 'reject'].includes(normalizedDecision)) {
    throw new WithdrawalError(400, 'INVALID_DECISION', 'Choose approve or reject.');
  }
  const expectedVersion = requireExpectedUpdate(expectedUpdatedAt);
  const normalizedNote = String(note ?? '').trim().slice(0, 500);
  const approvalCode = normalizedDecision === 'approve' ? `NVC-${randomInt(100000, 1000000)}` : null;
  const approvalCodeHash = approvalCode ? await hashPassword(approvalCode) : null;

  const execute = db.transaction(() => {
    const admin = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('admin', 'owner') AND status != 'Suspended'").get(adminId);
    if (!admin) throw new WithdrawalError(403, 'ADMIN_REQUIRED', 'Administrator authorization is required.');

    const row = findWithdrawal(db, withdrawalId);
    if (!row) throw new WithdrawalError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
    if (row.requester_user_id === adminId) throw new WithdrawalError(403, 'SELF_REVIEW_FORBIDDEN', 'You cannot review your own withdrawal request.');
    if (row.status !== 'Pending' || row.updated_at !== expectedVersion) {
      throw new WithdrawalError(409, 'WITHDRAWAL_CONFLICT', 'This withdrawal changed. Refresh and review its current status.');
    }

    const createdAt = new Date().toISOString();
    const status = normalizedDecision === 'approve' ? 'Approved' : 'Rejected';
    const raw = { ...parseRaw(row), reviewerNote: normalizedNote, reviewedBy: adminId, reviewedAt: createdAt };
    const result = db.prepare(`
      UPDATE withdrawal_requests
      SET status = ?, approval_code_hash = ?, updated_at = ?, raw_json = ?
      WHERE id = ? AND status = 'Pending' AND updated_at = ?
    `).run(status, approvalCodeHash, createdAt, JSON.stringify(raw), withdrawalId, expectedVersion);
    if (result.changes !== 1) throw new WithdrawalError(409, 'WITHDRAWAL_CONFLICT', 'This withdrawal changed. Refresh and try again.');

    const message = normalizedDecision === 'approve'
      ? `Withdrawal ${withdrawalId} was approved. Contact support for the secure withdrawal code.`
      : `Withdrawal ${withdrawalId} was rejected. No payout was completed and no funds were debited.`;
    insertNotification(db, {
      id: `NOTICE-${withdrawalId}-${normalizedDecision}`,
      userId: row.requester_user_id,
      eventType: `withdrawal-${status.toLowerCase()}`,
      title: `Withdrawal ${status.toLowerCase()}`,
      message,
      createdAt,
      metadata: { withdrawalId, status },
    });
    insertAudit(db, {
      actorUserId: adminId,
      action: `withdrawal.${status.toLowerCase()}`,
      withdrawalId,
      details: { requesterUserId: row.requester_user_id, note: normalizedNote },
      createdAt,
    });
    enqueueWithdrawalEmail(db, findWithdrawal(db, withdrawalId), {
      status, eventKey: status.toLowerCase(), createdAt, message,
    });

    return { request: formatWithdrawal(findWithdrawal(db, withdrawalId)), approvalCode };
  });

  return execute.immediate();
}

export async function submitWithdrawalCode(db, { requesterId, withdrawalId, code, expectedUpdatedAt, now = () => Date.now() }) {
  const normalizedCode = String(code ?? '').trim().toUpperCase();
  if (!/^(?:NVC|PNC)-\d{6}$/.test(normalizedCode)) {
    throw new WithdrawalError(400, 'INVALID_CODE', 'Enter a valid withdrawal code.');
  }
  const expectedVersion = requireExpectedUpdate(expectedUpdatedAt);
  const row = findWithdrawal(db, withdrawalId);
  if (!row || row.requester_user_id !== requesterId) {
    throw new WithdrawalError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
  }
  if (row.status !== 'Approved' || row.updated_at !== expectedVersion) {
    throw new WithdrawalError(409, 'WITHDRAWAL_CONFLICT', 'This withdrawal changed. Refresh and try again.');
  }
  if (!row.approval_code_hash || !(await verifyPassword(normalizedCode, row.approval_code_hash))) {
    throw new WithdrawalError(400, 'INVALID_CODE', 'Invalid withdrawal code. Please check and try again.');
  }

  const execute = db.transaction(() => {
    const current = findWithdrawal(db, withdrawalId);
    if (!current || current.requester_user_id !== requesterId || current.status !== 'Approved' || current.updated_at !== expectedVersion) {
      throw new WithdrawalError(409, 'WITHDRAWAL_CONFLICT', 'This withdrawal changed. Refresh and try again.');
    }

    const enteredAtMs = now();
    const enteredAt = new Date(enteredAtMs).toISOString();
    const expectedFailureAt = new Date(enteredAtMs + REVIEW_WINDOW_MS).toISOString();
    const raw = { ...parseRaw(current), payoutState: 'Code Entered', codeEnteredAt: enteredAt, expectedFailureAt, failureReason: '' };
    const result = db.prepare(`
      UPDATE withdrawal_requests
      SET status = 'Pending', approval_code_hash = NULL, updated_at = ?, raw_json = ?
      WHERE id = ? AND requester_user_id = ? AND status = 'Approved' AND updated_at = ?
    `).run(enteredAt, JSON.stringify(raw), withdrawalId, requesterId, expectedVersion);
    if (result.changes !== 1) throw new WithdrawalError(409, 'WITHDRAWAL_CONFLICT', 'This withdrawal changed. Refresh and try again.');

    insertNotification(db, {
      id: `NOTICE-${withdrawalId}-code-entered`,
      userId: requesterId,
      eventType: 'withdrawal-code-entered',
      title: 'Withdrawal code received',
      message: `Code received for ${withdrawalId}. The withdrawal remains pending for compliance review.`,
      createdAt: enteredAt,
      metadata: { withdrawalId, expectedFailureAt },
    });
    insertAudit(db, {
      actorUserId: requesterId,
      action: 'withdrawal.code-submitted',
      withdrawalId,
      details: { expectedFailureAt },
      createdAt: enteredAt,
    });
    enqueueWithdrawalEmail(db, findWithdrawal(db, withdrawalId), {
      status: 'Pending', eventKey: 'code-entered', createdAt: enteredAt,
      message: `Code received for ${withdrawalId}. The withdrawal remains pending for compliance review. No payout has been completed.`,
    });
    return { request: formatWithdrawal(findWithdrawal(db, withdrawalId)) };
  });

  return execute.immediate();
}

export function expireWithdrawalReview(db, { requesterId, withdrawalId, expectedUpdatedAt, now = () => Date.now() }) {
  const expectedVersion = requireExpectedUpdate(expectedUpdatedAt);
  const execute = db.transaction(() => {
    const row = findWithdrawal(db, withdrawalId);
    if (!row || row.requester_user_id !== requesterId) {
      throw new WithdrawalError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal request not found.');
    }
    const raw = parseRaw(row);
    const deadline = new Date(raw.expectedFailureAt ?? '').getTime();
    if (row.status !== 'Pending' || !raw.codeEnteredAt || row.updated_at !== expectedVersion) {
      throw new WithdrawalError(409, 'WITHDRAWAL_CONFLICT', 'This withdrawal changed. Refresh and try again.');
    }
    if (!Number.isFinite(deadline) || now() < deadline) {
      throw new WithdrawalError(409, 'REVIEW_NOT_EXPIRED', 'This withdrawal is still under compliance review.');
    }

    const failedAt = new Date(now()).toISOString();
    const nextRaw = { ...raw, failedAt, payoutState: 'Failed', failureReason: 'Compliance timeout' };
    const result = db.prepare(`
      UPDATE withdrawal_requests SET status = 'Failed', updated_at = ?, raw_json = ?
      WHERE id = ? AND requester_user_id = ? AND status = 'Pending' AND updated_at = ?
    `).run(failedAt, JSON.stringify(nextRaw), withdrawalId, requesterId, expectedVersion);
    if (result.changes !== 1) throw new WithdrawalError(409, 'WITHDRAWAL_CONFLICT', 'This withdrawal changed. Refresh and try again.');

    insertNotification(db, {
      id: `NOTICE-${withdrawalId}-failed`,
      userId: requesterId,
      eventType: 'withdrawal-failed',
      title: 'Withdrawal failed',
      message: `Withdrawal ${withdrawalId} failed after pending review. No payout was completed and your funds remain available.`,
      createdAt: failedAt,
      metadata: { withdrawalId, failedAt },
    });
    insertAudit(db, {
      actorUserId: requesterId,
      action: 'withdrawal.failed',
      withdrawalId,
      details: { reason: 'Compliance timeout' },
      createdAt: failedAt,
    });
    enqueueWithdrawalEmail(db, findWithdrawal(db, withdrawalId), {
      status: 'Failed', eventKey: 'failed', createdAt: failedAt,
      message: `Withdrawal ${withdrawalId} failed after pending review. No payout was completed and your funds remain available.`,
    });
    return { request: formatWithdrawal(findWithdrawal(db, withdrawalId)) };
  });
  return execute.immediate();
}