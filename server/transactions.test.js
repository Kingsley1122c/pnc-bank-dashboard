import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDatabase, initializeDatabase } from './database.js';
import { createAdminAdjustment, createInternalTransfer, TransactionError } from './transactions.js';

async function createFixture({ recipientVerification = 'Verified', senderBalance = 100 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-transfer-'));
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify([
    { id: 'USR-SENDER', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'Sender', email: 'sender@example.com', phone: '+15550000001', password: 'sender-password', accountNumber: '1000000001', accounts: [{ label: 'Current', amount: senderBalance }] },
    { id: 'USR-RECIPIENT', role: 'user', status: 'Active', verificationStatus: recipientVerification, name: 'Recipient', email: 'recipient@example.com', phone: '+15550000002', password: 'recipient-password', accountNumber: '1000000002', accounts: [{ label: 'Current', amount: 25 }] },
    { id: 'ADM-OPERATOR', role: 'admin', status: 'Active', verificationStatus: 'Verified', name: 'Operator', email: 'operator@example.com', phone: '+15550000003', password: 'operator-password', accounts: [] },
  ]));
  await writeFile(path.join(directory, 'admin-workspace.json'), '{}');
  return { directory, db: await initializeDatabase({ dataDir: directory }) };
}

function transfer(db, overrides = {}) {
  return createInternalTransfer(db, {
    senderId: 'USR-SENDER', sourceAccount: 'Current', recipientAccountNumber: '1000000002',
    amount: '20.25', note: 'Test transfer', idempotencyKey: 'request-0001', ...overrides,
  });
}

test('verified internal transfer commits balanced money movement and durable events', async () => {
  const { db } = await createFixture();
  try {
    const result = transfer(db);
    assert.equal(result.receipt.status, 'Completed');
    assert.equal(result.sender.accounts[0].amount, 79.75);
    assert.equal(result.recipient.accounts[0].amount, 45.25);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM transactions').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM notifications').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM email_outbox').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM audit_logs').get().count, 1);
  } finally { closeDatabase(db); }
});

test('idempotency replay does not move money or duplicate events', async () => {
  const { db } = await createFixture();
  try {
    const first = transfer(db);
    const second = transfer(db);
    assert.equal(second.replayed, true);
    assert.equal(second.transactionId, first.transactionId);
    assert.equal(second.sender.accounts[0].amount, 79.75);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM transactions').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM email_outbox').get().count, 1);
  } finally { closeDatabase(db); }
});

test('insufficient funds and invalid amounts roll back without side effects', async () => {
  const { db } = await createFixture({ senderBalance: 10 });
  try {
    assert.throws(() => transfer(db), (error) => error instanceof TransactionError && error.code === 'INSUFFICIENT_FUNDS');
    for (const amount of ['0', '-1', 'NaN', '1.001', 'Infinity']) {
      assert.throws(() => transfer(db, { amount, idempotencyKey: `invalid-${amount}` }), TransactionError);
    }
    assert.equal(db.prepare("SELECT amount_minor FROM account_balances WHERE user_id = 'USR-SENDER'").get().amount_minor, 1000);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM transactions').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM notifications').get().count, 0);
  } finally { closeDatabase(db); }
});

test('unverified recipient creates a hold without crediting recipient', async () => {
  const { db } = await createFixture({ recipientVerification: 'Pending' });
  try {
    const result = transfer(db);
    assert.equal(result.receipt.status, 'Pending Verification');
    assert.equal(result.sender.accounts[0].amount, 79.75);
    assert.equal(result.recipient.accounts[0].amount, 25);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM pending_transfers').get().count, 1);
  } finally { closeDatabase(db); }
});

test('recipient and source account authorization reject invalid targets atomically', async () => {
  const { db } = await createFixture();
  try {
    assert.throws(() => transfer(db, { sourceAccount: 'Business', idempotencyKey: 'wrong-source' }), (error) => error.code === 'SOURCE_NOT_FOUND');
    assert.throws(() => transfer(db, { recipientAccountNumber: '9999999999', idempotencyKey: 'wrong-recipient' }), (error) => error.code === 'RECIPIENT_NOT_FOUND');
    assert.equal(db.prepare("SELECT amount_minor FROM account_balances WHERE user_id = 'USR-SENDER'").get().amount_minor, 10000);
  } finally { closeDatabase(db); }
});

test('admin adjustment is authorized, audited, durable, and idempotent', async () => {
  const { db } = await createFixture();
  try {
    const command = { adminId: 'ADM-OPERATOR', targetUserId: 'USR-SENDER', accountLabel: 'Current', amount: '12.34', note: 'Approved credit', idempotencyKey: 'admin-credit-0001' };
    const first = createAdminAdjustment(db, command);
    const replay = createAdminAdjustment(db, command);
    assert.equal(first.account.accounts[0].amount, 112.34);
    assert.equal(replay.replayed, true);
    assert.equal(replay.transactionId, first.transactionId);
    assert.equal(replay.account.accounts[0].amount, 112.34);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM transactions WHERE type = 'Admin Credit'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action = 'balance.admin-credit'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM email_outbox WHERE event_type = 'account.admin-credit'").get().count, 1);
  } finally { closeDatabase(db); }
});

test('non-admin and invalid admin adjustments cannot change balances', async () => {
  const { db } = await createFixture();
  try {
    assert.throws(() => createAdminAdjustment(db, { adminId: 'USR-SENDER', targetUserId: 'USR-RECIPIENT', accountLabel: 'Current', amount: '10', idempotencyKey: 'denied-credit-0001' }), (error) => error.code === 'ADMIN_REQUIRED');
    assert.throws(() => createAdminAdjustment(db, { adminId: 'ADM-OPERATOR', targetUserId: 'USR-RECIPIENT', accountLabel: 'Current', amount: '-10', idempotencyKey: 'invalid-credit-0001' }), (error) => error.code === 'INVALID_AMOUNT');
    assert.equal(db.prepare("SELECT amount_minor FROM account_balances WHERE user_id = 'USR-RECIPIENT'").get().amount_minor, 2500);
  } finally { closeDatabase(db); }
});

test('competing debits cannot overdraw the source balance', async () => {
  const { db } = await createFixture({ senderBalance: 100 });
  try {
    const outcomes = ['competing-transfer-0001', 'competing-transfer-0002'].map((idempotencyKey) => {
      try {
        return { ok: true, result: transfer(db, { amount: '60', idempotencyKey }) };
      } catch (error) {
        return { ok: false, error };
      }
    });
    assert.equal(outcomes.filter((entry) => entry.ok).length, 1);
    assert.equal(outcomes.filter((entry) => !entry.ok && entry.error.code === 'INSUFFICIENT_FUNDS').length, 1);
    assert.equal(db.prepare("SELECT amount_minor FROM account_balances WHERE user_id = 'USR-SENDER'").get().amount_minor, 4000);
    assert.equal(db.prepare("SELECT amount_minor FROM account_balances WHERE user_id = 'USR-RECIPIENT'").get().amount_minor, 8500);
  } finally { closeDatabase(db); }
});