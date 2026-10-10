import { randomUUID } from 'node:crypto';

import { enqueueEmail } from './email-service.js';

export class TransactionError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'TransactionError';
    this.status = status;
    this.code = code;
  }
}

function parseAmountMinor(value) {
  const normalized = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(normalized)) {
    throw new TransactionError(400, 'INVALID_AMOUNT', 'Enter a valid positive amount with no more than two decimal places.');
  }

  const [whole, fraction = ''] = normalized.split('.');
  const amountMinor = (Number(whole) * 100) + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new TransactionError(400, 'INVALID_AMOUNT', 'Transfer amount must be greater than zero.');
  }
  return amountMinor;
}

function serializeAccount(db, userId) {
  const user = db.prepare('SELECT id, name, email, account_number, verification_status FROM users WHERE id = ?').get(userId);
  const accounts = db.prepare('SELECT label, amount_minor, currency FROM account_balances WHERE user_id = ? ORDER BY rowid').all(userId);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    accountNumber: user.account_number,
    verificationStatus: user.verification_status,
    accounts: accounts.map((entry) => ({ label: entry.label, amount: entry.amount_minor / 100, currency: entry.currency })),
  };
}

function createReceipt(transaction, sender, recipient) {
  return {
    id: transaction.id,
    name: recipient.name,
    type: 'Transfer',
    amount: `-$${(transaction.amount_minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    date: transaction.created_at,
    status: transaction.status,
    owner: sender.name,
    reviewStatus: transaction.status === 'Pending Verification' || transaction.amount_minor >= 500000 ? 'Pending Review' : 'Monitored',
    destination: `PNC Bank • **** ${recipient.account_number.slice(-4)}`,
    note: transaction.note ?? '',
  };
}

function getExistingTransfer(db, senderId, scopedIdempotencyKey) {
  const transaction = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(scopedIdempotencyKey);
  if (!transaction) return null;
  if (transaction.initiator_user_id !== senderId) {
    throw new TransactionError(409, 'IDEMPOTENCY_CONFLICT', 'That request key is already in use.');
  }
  const sender = db.prepare('SELECT id, name FROM users WHERE id = ?').get(senderId);
  const recipient = db.prepare('SELECT id, name, account_number FROM users WHERE id = ?').get(transaction.recipient_user_id);
  return {
    replayed: true,
    transactionId: transaction.id,
    receipt: createReceipt(transaction, sender, recipient),
    sender: serializeAccount(db, senderId),
    recipient: serializeAccount(db, transaction.recipient_user_id),
  };
}

export function createInternalTransfer(db, { senderId, sourceAccount, recipientAccountNumber, amount, note = '', idempotencyKey }) {
  const normalizedKey = String(idempotencyKey ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalizedKey)) {
    throw new TransactionError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
  }
  const normalizedSource = String(sourceAccount ?? '').trim();
  const normalizedRecipientNumber = String(recipientAccountNumber ?? '').replace(/\D/g, '');
  const normalizedNote = String(note ?? '').trim().slice(0, 500);
  if (!normalizedSource || normalizedRecipientNumber.length !== 10) {
    throw new TransactionError(400, 'INVALID_TRANSFER', 'Choose a source account and enter a valid 10-digit PNC account number.');
  }
  const amountMinor = parseAmountMinor(amount);
  const scopedIdempotencyKey = `transfer:${senderId}:${normalizedKey}`;

  const execute = db.transaction(() => {
    const existing = getExistingTransfer(db, senderId, scopedIdempotencyKey);
    if (existing) return existing;

    const sender = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND status != 'Suspended'").get(senderId);
    if (!sender) throw new TransactionError(403, 'SENDER_NOT_ELIGIBLE', 'This account cannot submit transfers.');
    const recipient = db.prepare("SELECT * FROM users WHERE account_number = ? AND role = 'user' AND status != 'Suspended'").get(normalizedRecipientNumber);
    if (!recipient) throw new TransactionError(404, 'RECIPIENT_NOT_FOUND', 'Only active registered PNC account numbers are allowed.');
    if (recipient.id === sender.id) throw new TransactionError(400, 'SELF_TRANSFER', 'Choose another PNC account as the recipient.');

    const source = db.prepare('SELECT * FROM account_balances WHERE user_id = ? AND label = ? AND currency = ?').get(sender.id, normalizedSource, 'USD');
    if (!source) throw new TransactionError(400, 'SOURCE_NOT_FOUND', 'The selected source account is unavailable.');
    const debit = db.prepare(`
      UPDATE account_balances
      SET amount_minor = amount_minor - ?, version = version + 1, updated_at = ?
      WHERE user_id = ? AND label = ? AND currency = 'USD' AND amount_minor >= ?
    `);
    const createdAt = new Date().toISOString();
    if (debit.run(amountMinor, createdAt, sender.id, normalizedSource, amountMinor).changes !== 1) {
      throw new TransactionError(409, 'INSUFFICIENT_FUNDS', 'Insufficient funds in the selected account.');
    }

    const recipientVerified = recipient.verification_status === 'Verified';
    const recipientBalance = db.prepare(`
      SELECT * FROM account_balances WHERE user_id = ? AND currency = 'USD'
      ORDER BY CASE WHEN label = 'Current' THEN 0 ELSE 1 END, rowid LIMIT 1
    `).get(recipient.id);
    if (!recipientBalance) throw new TransactionError(409, 'RECIPIENT_ACCOUNT_UNAVAILABLE', 'The recipient has no eligible deposit account.');
    if (recipientVerified) {
      db.prepare(`
        UPDATE account_balances SET amount_minor = amount_minor + ?, version = version + 1, updated_at = ?
        WHERE user_id = ? AND label = ? AND currency = 'USD'
      `).run(amountMinor, createdAt, recipient.id, recipientBalance.label);
    }

    const transactionId = `TX-${randomUUID()}`;
    const status = recipientVerified ? 'Completed' : 'Pending Verification';
    db.prepare(`
      INSERT INTO transactions (
        id, idempotency_key, initiator_user_id, recipient_user_id, type, status, amount_minor, currency,
        source_account_label, destination_account_label, counterparty_name, reference, note, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'Transfer', ?, ?, 'USD', ?, ?, ?, ?, ?, '{}', ?, ?)
    `).run(transactionId, scopedIdempotencyKey, sender.id, recipient.id, status, amountMinor, normalizedSource, recipientBalance.label, recipient.name, transactionId, normalizedNote, createdAt, createdAt);

    if (!recipientVerified) {
      db.prepare(`
        INSERT INTO pending_transfers (id, transaction_id, recipient_user_id, sender_user_id, amount_minor, currency, created_at, raw_json)
        VALUES (?, ?, ?, ?, ?, 'USD', ?, '{}')
      `).run(`HOLD-${transactionId}`, transactionId, recipient.id, sender.id, amountMinor, createdAt);
    }

    const recipientMessage = recipientVerified
      ? `${sender.name} sent you $${(amountMinor / 100).toFixed(2)}.`
      : `${sender.name} sent you $${(amountMinor / 100).toFixed(2)}. The funds are on hold until your PNC verification is complete.`;
    db.prepare(`
      INSERT INTO notifications (id, user_id, event_type, title, message, idempotency_key, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`NOTICE-${transactionId}`, recipient.id, recipientVerified ? 'transfer-received' : 'verification-hold', recipientVerified ? 'Transfer received' : 'Transfer pending verification', recipientMessage, `notification:${transactionId}:recipient`, createdAt, JSON.stringify({ transactionId }));
    db.prepare(`
      INSERT INTO notifications (id, user_id, event_type, title, message, idempotency_key, created_at, metadata_json)
      VALUES (?, ?, 'transfer-sent', 'Transfer sent', ?, ?, ?, ?)
    `).run(`NOTICE-SENDER-${transactionId}`, sender.id, `$${(amountMinor / 100).toFixed(2)} sent to ${recipient.name}.`, `notification:${transactionId}:sender`, createdAt, JSON.stringify({ transactionId }));
    const emailPayload = { amount: (amountMinor / 100).toFixed(2), currency: 'USD', status, reference: transactionId, occurredAt: createdAt };
    enqueueEmail(db, {
      idempotencyKey: `email:${transactionId}:recipient`, eventType: 'transfer.received', aggregateType: 'transaction', aggregateId: transactionId,
      recipient: recipient.email, recipientUserId: recipient.id, templateId: 'transfer-received', payload: { ...emailPayload, name: recipient.name, senderName: sender.name }, createdAt,
    });
    enqueueEmail(db, {
      idempotencyKey: `email:${transactionId}:sender`, eventType: 'transfer.sent', aggregateType: 'transaction', aggregateId: transactionId,
      recipient: sender.email, recipientUserId: sender.id, templateId: 'transfer-sent', payload: { ...emailPayload, name: sender.name, recipientName: recipient.name }, createdAt,
    });
    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at)
      VALUES (?, 'transfer.created', 'transaction', ?, ?, ?)
    `).run(sender.id, transactionId, JSON.stringify({ recipientUserId: recipient.id, amountMinor, status }), createdAt);

    const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
    return {
      replayed: false,
      transactionId,
      receipt: createReceipt(transaction, sender, recipient),
      sender: serializeAccount(db, sender.id),
      recipient: serializeAccount(db, recipient.id),
    };
  });

  try {
    return execute.immediate();
  } catch (error) {
    if (error instanceof TransactionError) throw error;
    if (String(error?.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) {
      const replay = getExistingTransfer(db, senderId, scopedIdempotencyKey);
      if (replay) return replay;
    }
    throw error;
  }
}

export function createAdminAdjustment(db, { adminId, targetUserId, accountLabel, amount, note = '', idempotencyKey }) {
  const normalizedKey = String(idempotencyKey ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalizedKey)) {
    throw new TransactionError(400, 'INVALID_IDEMPOTENCY_KEY', 'A valid idempotency key is required.');
  }
  const amountMinor = parseAmountMinor(amount);
  const normalizedLabel = String(accountLabel ?? '').trim();
  const normalizedNote = String(note ?? '').trim().slice(0, 500);
  if (!normalizedLabel) throw new TransactionError(400, 'ACCOUNT_REQUIRED', 'Choose an account to credit.');
  const scopedIdempotencyKey = `adjustment:${adminId}:${normalizedKey}`;

  const execute = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ?').get(scopedIdempotencyKey);
    if (existing) {
      const target = serializeAccount(db, existing.recipient_user_id);
      return {
        replayed: true,
        transactionId: existing.id,
        account: target,
        receipt: { transactionId: existing.id, accountId: target.id, userName: target.name, accountLabel: existing.destination_account_label, amount: existing.amount_minor / 100, note: existing.note ?? '', createdAt: existing.created_at },
      };
    }

    const admin = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'admin' AND status != 'Suspended'").get(adminId);
    if (!admin) throw new TransactionError(403, 'ADMIN_REQUIRED', 'Administrator authorization is required.');
    const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND status != 'Suspended'").get(targetUserId);
    if (!target) throw new TransactionError(404, 'TARGET_NOT_FOUND', 'The selected retail account is unavailable.');
    const balance = db.prepare('SELECT * FROM account_balances WHERE user_id = ? AND label = ? AND currency = ?').get(target.id, normalizedLabel, 'USD');
    if (!balance) throw new TransactionError(400, 'ACCOUNT_NOT_FOUND', 'The selected balance account is unavailable.');

    const createdAt = new Date().toISOString();
    db.prepare(`
      UPDATE account_balances SET amount_minor = amount_minor + ?, version = version + 1, updated_at = ?
      WHERE user_id = ? AND label = ? AND currency = 'USD'
    `).run(amountMinor, createdAt, target.id, normalizedLabel);
    const transactionId = `ADM-${randomUUID()}`;
    db.prepare(`
      INSERT INTO transactions (
        id, idempotency_key, initiator_user_id, recipient_user_id, type, status, amount_minor, currency,
        destination_account_label, counterparty_name, reference, note, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'Admin Credit', 'Completed', ?, 'USD', ?, ?, ?, ?, '{}', ?, ?)
    `).run(transactionId, scopedIdempotencyKey, admin.id, target.id, amountMinor, normalizedLabel, target.name, transactionId, normalizedNote, createdAt, createdAt);
    db.prepare(`
      INSERT INTO notifications (id, user_id, event_type, title, message, idempotency_key, created_at, metadata_json)
      VALUES (?, ?, 'admin-credit', 'Funds credited', ?, ?, ?, ?)
    `).run(`NOTICE-${transactionId}`, target.id, `$${(amountMinor / 100).toFixed(2)} was credited to your ${normalizedLabel} account.`, `notification:${transactionId}:recipient`, createdAt, JSON.stringify({ transactionId, adminId: admin.id }));
    enqueueEmail(db, {
      idempotencyKey: `email:${transactionId}:recipient`, eventType: 'account.admin-credit', aggregateType: 'transaction', aggregateId: transactionId,
      recipient: target.email, recipientUserId: target.id, templateId: 'admin-credit',
      payload: { name: target.name, amount: (amountMinor / 100).toFixed(2), currency: 'USD', accountLabel: normalizedLabel, reference: transactionId, occurredAt: createdAt }, createdAt,
    });
    db.prepare(`
      INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at)
      VALUES (?, 'balance.admin-credit', 'user', ?, ?, ?)
    `).run(admin.id, target.id, JSON.stringify({ transactionId, amountMinor, accountLabel: normalizedLabel, note: normalizedNote }), createdAt);

    const account = serializeAccount(db, target.id);
    return {
      replayed: false,
      transactionId,
      account,
      receipt: { transactionId, accountId: target.id, userName: target.name, accountLabel: normalizedLabel, amount: amountMinor / 100, note: normalizedNote, createdAt },
    };
  });

  return execute.immediate();
}