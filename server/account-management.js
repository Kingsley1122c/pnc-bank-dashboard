import { randomUUID } from 'node:crypto';

import { enqueueEmail } from './email-service.js';

export class AccountManagementError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AccountManagementError';
    this.status = status;
    this.code = code;
  }
}

function requireAdmin(db, adminId) {
  const admin = db.prepare("SELECT id FROM users WHERE id = ? AND role IN ('admin', 'owner') AND status != 'Suspended'").get(adminId);
  if (!admin) throw new AccountManagementError(403, 'ADMIN_REQUIRED', 'Administrator authorization is required.');
}

function requireExpectedUpdate(value) {
  const expectedUpdatedAt = String(value ?? '').trim();
  if (!expectedUpdatedAt) throw new AccountManagementError(400, 'VERSION_REQUIRED', 'The account version is required. Refresh and try again.');
  return expectedUpdatedAt;
}

function getTarget(db, targetUserId) {
  return db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user' AND status != 'Deleted'").get(targetUserId);
}

function accountResult(db, targetUserId) {
  const user = db.prepare('SELECT id, role, status, verification_status, updated_at FROM users WHERE id = ?').get(targetUserId);
  const balances = db.prepare('SELECT label, amount_minor, currency FROM account_balances WHERE user_id = ? ORDER BY rowid').all(targetUserId);
  return {
    id: user.id,
    role: user.role,
    status: user.status,
    verificationStatus: user.verification_status,
    updatedAt: user.updated_at,
    accounts: balances.map((entry) => ({ label: entry.label, amount: entry.amount_minor / 100, currency: entry.currency })),
  };
}

function notify(db, { userId, eventType, title, message, idempotencyKey, createdAt, metadata }) {
  db.prepare(`
    INSERT INTO notifications (id, user_id, event_type, title, message, idempotency_key, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`NOTICE-${randomUUID()}`, userId, eventType, title, message, idempotencyKey, createdAt, JSON.stringify(metadata));
}

function audit(db, { adminId, action, targetUserId, details, createdAt }) {
  db.prepare(`
    INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at)
    VALUES (?, ?, 'user', ?, ?, ?)
  `).run(adminId, action, targetUserId, JSON.stringify(details), createdAt);
}

export function updateAccountStatus(db, { adminId, targetUserId, status, expectedUpdatedAt }) {
  const normalizedStatus = String(status ?? '').trim();
  if (!['Active', 'Suspended', 'Flagged'].includes(normalizedStatus)) {
    throw new AccountManagementError(400, 'INVALID_STATUS', 'Choose Active, Suspended, or Flagged.');
  }
  const expectedVersion = requireExpectedUpdate(expectedUpdatedAt);

  const execute = db.transaction(() => {
    requireAdmin(db, adminId);
    const target = getTarget(db, targetUserId);
    if (!target) throw new AccountManagementError(404, 'ACCOUNT_NOT_FOUND', 'Customer account not found.');
    if (target.updated_at !== expectedVersion) throw new AccountManagementError(409, 'ACCOUNT_CONFLICT', 'This account changed. Refresh and try again.');

    const updatedAt = new Date().toISOString();
    const result = db.prepare(`
      UPDATE users SET status = ?, updated_at = ?
      WHERE id = ? AND role = 'user' AND updated_at = ?
    `).run(normalizedStatus, updatedAt, targetUserId, expectedVersion);
    if (result.changes !== 1) throw new AccountManagementError(409, 'ACCOUNT_CONFLICT', 'This account changed. Refresh and try again.');

    if (normalizedStatus === 'Suspended') {
      db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), targetUserId);
    }
    notify(db, {
      userId: targetUserId,
      eventType: 'account-status',
      title: `Account ${normalizedStatus.toLowerCase()}`,
      message: `Your account status is now ${normalizedStatus}. Please contact support if you need a review.`,
      idempotencyKey: `account-status:${targetUserId}:${updatedAt}`,
      createdAt: updatedAt,
      metadata: { status: normalizedStatus },
    });
    enqueueEmail(db, {
      idempotencyKey: `email:account-status:${targetUserId}:${updatedAt}`,
      eventType: 'account.status-changed', aggregateType: 'user', aggregateId: targetUserId,
      recipient: target.email, recipientUserId: targetUserId, templateId: 'account-status',
      payload: { name: target.name, subject: `Your Nevora Core account is ${normalizedStatus.toLowerCase()}`, message: `Your account status is now ${normalizedStatus}. Contact support if you need a review.`, occurredAt: updatedAt }, createdAt: updatedAt,
    });
    audit(db, { adminId, action: 'account.status-changed', targetUserId, details: { previousStatus: target.status, status: normalizedStatus }, createdAt: updatedAt });
    return { account: accountResult(db, targetUserId) };
  });

  return execute.immediate();
}

export function verifyAccount(db, { adminId, targetUserId, expectedUpdatedAt }) {
  const expectedVersion = requireExpectedUpdate(expectedUpdatedAt);
  const execute = db.transaction(() => {
    requireAdmin(db, adminId);
    const target = getTarget(db, targetUserId);
    if (!target) throw new AccountManagementError(404, 'ACCOUNT_NOT_FOUND', 'Customer account not found.');
    if (target.updated_at !== expectedVersion) throw new AccountManagementError(409, 'ACCOUNT_CONFLICT', 'This account changed. Refresh and try again.');
    if (target.verification_status === 'Verified') throw new AccountManagementError(409, 'ALREADY_VERIFIED', 'This account is already verified.');

    const destination = db.prepare(`
      SELECT * FROM account_balances WHERE user_id = ? AND currency = 'USD'
      ORDER BY CASE WHEN label = 'Current' THEN 0 ELSE 1 END, rowid LIMIT 1
    `).get(targetUserId);
    if (!destination) throw new AccountManagementError(409, 'ACCOUNT_UNAVAILABLE', 'This customer has no eligible deposit account.');
    const holds = db.prepare('SELECT * FROM pending_transfers WHERE recipient_user_id = ? ORDER BY created_at').all(targetUserId);
    const releasedAmountMinor = holds.reduce((total, hold) => total + hold.amount_minor, 0);
    const updatedAt = new Date().toISOString();

    if (releasedAmountMinor > 0) {
      db.prepare(`
        UPDATE account_balances SET amount_minor = amount_minor + ?, version = version + 1, updated_at = ?
        WHERE user_id = ? AND label = ? AND currency = 'USD'
      `).run(releasedAmountMinor, updatedAt, targetUserId, destination.label);
      const updateTransaction = db.prepare("UPDATE transactions SET status = 'Completed', updated_at = ? WHERE id = ? AND status = 'Pending Verification'");
      for (const hold of holds) updateTransaction.run(updatedAt, hold.transaction_id);
      db.prepare('DELETE FROM pending_transfers WHERE recipient_user_id = ?').run(targetUserId);
    }

    const result = db.prepare(`
      UPDATE users SET verification_status = 'Verified', updated_at = ?
      WHERE id = ? AND role = 'user' AND updated_at = ?
    `).run(updatedAt, targetUserId, expectedVersion);
    if (result.changes !== 1) throw new AccountManagementError(409, 'ACCOUNT_CONFLICT', 'This account changed. Refresh and try again.');

    notify(db, {
      userId: targetUserId,
      eventType: 'verification-complete',
      title: 'Account verification complete',
      message: holds.length > 0
        ? `Your account verification is complete. ${holds.length} held incoming transfer(s) have been released.`
        : 'Your account verification is complete and your account is now fully verified.',
      idempotencyKey: `account-verified:${targetUserId}`,
      createdAt: updatedAt,
      metadata: { releasedTransferCount: holds.length, releasedAmountMinor },
    });
    enqueueEmail(db, {
      idempotencyKey: `email:account-verified:${targetUserId}`,
      eventType: 'account.verified', aggregateType: 'user', aggregateId: targetUserId,
      recipient: target.email, recipientUserId: targetUserId, templateId: 'account-status',
      payload: {
        name: target.name,
        subject: 'Your Nevora Core account verification is complete',
        message: holds.length > 0 ? `${holds.length} held incoming transfer(s) have now been released.` : 'Your account verification is complete.',
        occurredAt: updatedAt,
      },
      createdAt: updatedAt,
    });
    for (const hold of holds) {
      const transaction = db.prepare(`
        SELECT transactions.*, sender.name AS sender_name, sender.email AS sender_email
        FROM transactions LEFT JOIN users sender ON sender.id = transactions.initiator_user_id
        WHERE transactions.id = ?
      `).get(hold.transaction_id);
      const common = { amount: (hold.amount_minor / 100).toFixed(2), currency: hold.currency, status: 'Completed', reference: hold.transaction_id, occurredAt: updatedAt };
      enqueueEmail(db, {
        idempotencyKey: `email:${hold.transaction_id}:recipient:completed`, eventType: 'transfer.completed', aggregateType: 'transaction', aggregateId: hold.transaction_id,
        recipient: target.email, recipientUserId: targetUserId, templateId: 'transfer-received', payload: { ...common, name: target.name, senderName: transaction.sender_name }, createdAt: updatedAt,
      });
      enqueueEmail(db, {
        idempotencyKey: `email:${hold.transaction_id}:sender:completed`, eventType: 'transfer.completed', aggregateType: 'transaction', aggregateId: hold.transaction_id,
        recipient: transaction.sender_email, recipientUserId: hold.sender_user_id, templateId: 'transfer-sent', payload: { ...common, name: transaction.sender_name, recipientName: target.name }, createdAt: updatedAt,
      });
    }
    audit(db, { adminId, action: 'account.verified', targetUserId, details: { releasedTransferCount: holds.length, releasedAmountMinor }, createdAt: updatedAt });
    return { account: accountResult(db, targetUserId), releasedTransferCount: holds.length, releasedAmountMinor };
  });

  return execute.immediate();
}

export function deleteAccount(db, { adminId, targetUserId, expectedUpdatedAt, confirmation }) {
  const expectedVersion = requireExpectedUpdate(expectedUpdatedAt);

  const execute = db.transaction(() => {
    requireAdmin(db, adminId);
    const target = getTarget(db, targetUserId);
    if (!target) throw new AccountManagementError(404, 'ACCOUNT_NOT_FOUND', 'Customer account not found.');
    if (target.updated_at !== expectedVersion) throw new AccountManagementError(409, 'ACCOUNT_CONFLICT', 'This account changed. Refresh and try again.');
    const requiredConfirmation = `DELETE ${target.email}`;
    if (confirmation !== requiredConfirmation) {
      throw new AccountManagementError(400, 'CONFIRMATION_REQUIRED', `Enter ${requiredConfirmation} to delete this account.`);
    }

    const balanceMinor = db.prepare('SELECT COALESCE(SUM(amount_minor), 0) total FROM account_balances WHERE user_id = ?').get(targetUserId).total;
    if (balanceMinor !== 0) throw new AccountManagementError(409, 'NONZERO_BALANCE', 'Move or withdraw all customer funds before deleting this account.');
    const pendingTransferCount = db.prepare('SELECT COUNT(*) count FROM pending_transfers WHERE recipient_user_id = ? OR sender_user_id = ?').get(targetUserId, targetUserId).count;
    if (pendingTransferCount > 0) throw new AccountManagementError(409, 'PENDING_TRANSFERS', 'Resolve all pending transfers before deleting this account.');
    const openWithdrawalCount = db.prepare("SELECT COUNT(*) count FROM withdrawal_requests WHERE requester_user_id = ? AND status NOT IN ('Rejected', 'Failed')").get(targetUserId).count;
    if (openWithdrawalCount > 0) throw new AccountManagementError(409, 'OPEN_WITHDRAWALS', 'Resolve all open withdrawal requests before deleting this account.');

    const deletedAt = new Date().toISOString();
    const result = db.prepare(`
      UPDATE users SET
        status = 'Deleted', verification_status = 'Deleted', name = ?, email = ?, phone = NULL,
        password_hash = ?, segment = NULL, avatar = NULL, avatar_image = NULL, date_of_birth = NULL,
        gender = NULL, account_number = NULL, routing_number = NULL, raw_json = '{}', updated_at = ?
      WHERE id = ? AND role = 'user' AND status != 'Deleted' AND updated_at = ?
    `).run(
      `Deleted customer ${targetUserId}`,
      `deleted-${randomUUID()}@deleted.nevoracore.invalid`,
      `deleted$${randomUUID()}`,
      deletedAt,
      targetUserId,
      expectedVersion,
    );
    if (result.changes !== 1) throw new AccountManagementError(409, 'ACCOUNT_CONFLICT', 'This account changed. Refresh and try again.');

    db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), targetUserId);
    db.prepare('DELETE FROM auth_action_tokens WHERE user_id = ?').run(targetUserId);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(targetUserId);
    db.prepare('DELETE FROM saved_banks WHERE user_id = ?').run(targetUserId);
    db.prepare('DELETE FROM issued_cards WHERE user_id = ?').run(targetUserId);
    db.prepare('DELETE FROM account_balances WHERE user_id = ?').run(targetUserId);
    db.prepare(`
      UPDATE email_outbox SET status = 'suppressed', provider_status = 'suppressed',
        last_error = 'Recipient account deleted before delivery', updated_at = ?, next_attempt_at = NULL
      WHERE recipient_user_id = ? AND status IN ('pending', 'processing', 'failed')
    `).run(deletedAt, targetUserId);
    audit(db, { adminId, action: 'account.deleted', targetUserId, details: { retainedFinancialHistory: true }, createdAt: deletedAt });
    return { deletedUserId: targetUserId, deletedAt };
  });

  return execute.immediate();
}