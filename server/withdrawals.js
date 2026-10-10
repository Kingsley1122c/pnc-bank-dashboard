import { randomUUID } from 'node:crypto';

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
    SELECT withdrawal_requests.*, users.name AS requester_name
    FROM withdrawal_requests
    LEFT JOIN users ON users.id = withdrawal_requests.requester_user_id
    WHERE withdrawal_requests.id = ?
  `).get(id);
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