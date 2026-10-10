import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccountManagementError, updateAccountStatus, verifyAccount } from './account-management.js';
import { closeDatabase, initializeDatabase } from './database.js';
import { createInternalTransfer } from './transactions.js';

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-account-management-'));
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify([
    { id: 'USR-SENDER', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'Sender', email: 'sender@example.com', password: 'sender-password', accountNumber: '1000000001', accounts: [{ label: 'Current', amount: 100 }] },
    { id: 'USR-TARGET', role: 'user', status: 'Active', verificationStatus: 'Pending', name: 'Target', email: 'target@example.com', password: 'target-password', accountNumber: '1000000002', accounts: [{ label: 'Current', amount: 10 }] },
    { id: 'ADM-OPERATOR', role: 'admin', status: 'Active', verificationStatus: 'Verified', name: 'Operator', email: 'operator@example.com', password: 'operator-password', accounts: [] },
  ]));
  await writeFile(path.join(directory, 'admin-workspace.json'), '{}');
  return initializeDatabase({ dataDir: directory });
}

test('account status changes are authorized, versioned, audited, and cannot alter roles', async () => {
  const db = await createFixture();
  try {
    const target = db.prepare("SELECT * FROM users WHERE id = 'USR-TARGET'").get();
    assert.throws(
      () => updateAccountStatus(db, { adminId: 'USR-SENDER', targetUserId: target.id, status: 'Suspended', expectedUpdatedAt: target.updated_at }),
      (error) => error instanceof AccountManagementError && error.code === 'ADMIN_REQUIRED',
    );
    const result = updateAccountStatus(db, { adminId: 'ADM-OPERATOR', targetUserId: target.id, status: 'Suspended', expectedUpdatedAt: target.updated_at });
    assert.equal(result.account.status, 'Suspended');
    assert.equal(result.account.role, 'user');
    assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action = 'account.status-changed'").get().count, 1);
    assert.throws(
      () => updateAccountStatus(db, { adminId: 'ADM-OPERATOR', targetUserId: target.id, status: 'Active', expectedUpdatedAt: target.updated_at }),
      (error) => error.code === 'ACCOUNT_CONFLICT',
    );
  } finally { closeDatabase(db); }
});

test('verification atomically releases held transfers once without changing total funds', async () => {
  const db = await createFixture();
  try {
    createInternalTransfer(db, { senderId: 'USR-SENDER', sourceAccount: 'Current', recipientAccountNumber: '1000000002', amount: '25', idempotencyKey: 'verification-hold-0001' });
    const target = db.prepare("SELECT * FROM users WHERE id = 'USR-TARGET'").get();
    const result = verifyAccount(db, { adminId: 'ADM-OPERATOR', targetUserId: target.id, expectedUpdatedAt: target.updated_at });
    assert.equal(result.releasedTransferCount, 1);
    assert.equal(result.releasedAmountMinor, 2500);
    assert.equal(result.account.accounts[0].amount, 35);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM pending_transfers').get().count, 0);
    assert.equal(db.prepare("SELECT status FROM transactions WHERE idempotency_key = 'transfer:USR-SENDER:verification-hold-0001'").get().status, 'Completed');
    assert.equal(db.prepare("SELECT amount_minor FROM account_balances WHERE user_id = 'USR-SENDER'").get().amount_minor, 7500);
    assert.throws(
      () => verifyAccount(db, { adminId: 'ADM-OPERATOR', targetUserId: target.id, expectedUpdatedAt: target.updated_at }),
      (error) => ['ACCOUNT_CONFLICT', 'ALREADY_VERIFIED'].includes(error.code),
    );
    assert.equal(db.prepare("SELECT amount_minor FROM account_balances WHERE user_id = 'USR-TARGET'").get().amount_minor, 3500);
  } finally { closeDatabase(db); }
});

test('invalid targets and statuses roll back without notifications or audits', async () => {
  const db = await createFixture();
  try {
    const target = db.prepare("SELECT * FROM users WHERE id = 'USR-TARGET'").get();
    assert.throws(() => updateAccountStatus(db, { adminId: 'ADM-OPERATOR', targetUserId: target.id, status: 'owner', expectedUpdatedAt: target.updated_at }), (error) => error.code === 'INVALID_STATUS');
    assert.throws(() => updateAccountStatus(db, { adminId: 'ADM-OPERATOR', targetUserId: 'ADM-OPERATOR', status: 'Suspended', expectedUpdatedAt: target.updated_at }), (error) => error.code === 'ACCOUNT_NOT_FOUND');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM notifications').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM audit_logs').get().count, 0);
  } finally { closeDatabase(db); }
});