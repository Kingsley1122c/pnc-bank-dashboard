import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDatabase, initializeDatabase } from './database.js';
import {
  createWithdrawalRequest,
  decideWithdrawal,
  expireWithdrawalReview,
  listWithdrawals,
  submitWithdrawalCode,
  WithdrawalError,
} from './withdrawals.js';

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-withdrawal-'));
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify([
    {
      id: 'USR-REQUESTER', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'Requester',
      email: 'requester@example.com', password: 'requester-password', accountNumber: '1000000001', accounts: [{ label: 'Current', amount: 100 }],
      savedBanks: [{ id: 'BANK-OWN', bankName: 'Own Bank', accountName: 'Requester', accountNumber: '**** 1001' }],
    },
    {
      id: 'USR-OTHER', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'Other User',
      email: 'other@example.com', password: 'other-password', accountNumber: '1000000002', accounts: [{ label: 'Current', amount: 50 }],
      savedBanks: [{ id: 'BANK-OTHER', bankName: 'Other Bank', accountName: 'Other User', accountNumber: '**** 2002' }],
    },
    { id: 'ADM-OPERATOR', role: 'admin', status: 'Active', verificationStatus: 'Verified', name: 'Operator', email: 'operator@example.com', password: 'operator-password', accounts: [] },
  ]));
  await writeFile(path.join(directory, 'admin-workspace.json'), '{}');
  return initializeDatabase({ dataDir: directory });
}

test('withdrawal creation is durable, audited, scoped, and idempotent', async () => {
  const db = await createFixture();
  try {
    const command = { requesterId: 'USR-REQUESTER', bankId: 'BANK-OWN', amount: '25.50', message: 'Savings transfer', idempotencyKey: 'withdrawal-request-0001' };
    const first = createWithdrawalRequest(db, command);
    const replay = createWithdrawalRequest(db, command);

    assert.equal(first.replayed, false);
    assert.equal(first.request.status, 'Pending');
    assert.equal(first.request.amountValue, 25.5);
    assert.equal(first.request.destination, 'Own Bank • **** 1001');
    assert.equal(replay.replayed, true);
    assert.equal(replay.request.id, first.request.id);
    assert.deepEqual(listWithdrawals(db, { requesterId: 'USR-REQUESTER' }).map((entry) => entry.id), [first.request.id]);
    assert.equal(listWithdrawals(db, { requesterId: 'USR-OTHER' }).length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action = 'withdrawal.requested'").get().count, 1);
  } finally { closeDatabase(db); }
});

test('withdrawal rejects invalid amounts and banks owned by another user', async () => {
  const db = await createFixture();
  try {
    assert.throws(
      () => createWithdrawalRequest(db, { requesterId: 'USR-REQUESTER', bankId: 'BANK-OTHER', amount: '10', idempotencyKey: 'withdrawal-request-0002' }),
      (error) => error instanceof WithdrawalError && error.code === 'BANK_NOT_FOUND',
    );
    assert.throws(
      () => createWithdrawalRequest(db, { requesterId: 'USR-REQUESTER', bankId: 'BANK-OWN', amount: '-10', idempotencyKey: 'withdrawal-request-0003' }),
      (error) => error instanceof WithdrawalError && error.code === 'INVALID_AMOUNT',
    );
    assert.equal(db.prepare('SELECT COUNT(*) count FROM withdrawal_requests').get().count, 0);
  } finally { closeDatabase(db); }
});

test('admin approval and customer code submission are atomic, audited, and preserve funds', async () => {
  const db = await createFixture();
  try {
    const created = createWithdrawalRequest(db, { requesterId: 'USR-REQUESTER', bankId: 'BANK-OWN', amount: '25.50', idempotencyKey: 'withdrawal-lifecycle-0001' }).request;
    const approved = await decideWithdrawal(db, { adminId: 'ADM-OPERATOR', withdrawalId: created.id, decision: 'approve', expectedUpdatedAt: created.updatedAt });
    assert.match(approved.approvalCode, /^PNC-\d{6}$/);
    assert.equal(approved.request.status, 'Approved');
    assert.equal(db.prepare('SELECT approval_code_hash FROM withdrawal_requests WHERE id = ?').get(created.id).approval_code_hash.includes(approved.approvalCode), false);

    const submitted = await submitWithdrawalCode(db, {
      requesterId: 'USR-REQUESTER', withdrawalId: created.id, code: approved.approvalCode,
      expectedUpdatedAt: approved.request.updatedAt, now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(submitted.request.status, 'Pending');
    assert.equal(submitted.request.payoutState, 'Code Entered');
    assert.equal(db.prepare("SELECT amount_minor FROM account_balances WHERE user_id = 'USR-REQUESTER'").get().amount_minor, 10000);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE target_id = ? AND action LIKE 'withdrawal.%'").get(created.id).count, 3);
  } finally { closeDatabase(db); }
});

test('stale, cross-user, duplicate, and unauthorized withdrawal decisions fail without partial changes', async () => {
  const db = await createFixture();
  try {
    const created = createWithdrawalRequest(db, { requesterId: 'USR-REQUESTER', bankId: 'BANK-OWN', amount: '10', idempotencyKey: 'withdrawal-lifecycle-0002' }).request;
    await assert.rejects(
      () => decideWithdrawal(db, { adminId: 'USR-OTHER', withdrawalId: created.id, decision: 'approve', expectedUpdatedAt: created.updatedAt }),
      (error) => error instanceof WithdrawalError && error.code === 'ADMIN_REQUIRED',
    );
    const rejected = await decideWithdrawal(db, { adminId: 'ADM-OPERATOR', withdrawalId: created.id, decision: 'reject', expectedUpdatedAt: created.updatedAt });
    assert.equal(rejected.request.status, 'Rejected');
    await assert.rejects(
      () => decideWithdrawal(db, { adminId: 'ADM-OPERATOR', withdrawalId: created.id, decision: 'approve', expectedUpdatedAt: created.updatedAt }),
      (error) => error instanceof WithdrawalError && error.code === 'WITHDRAWAL_CONFLICT',
    );
    await assert.rejects(
      () => submitWithdrawalCode(db, { requesterId: 'USR-OTHER', withdrawalId: created.id, code: 'PNC-123456', expectedUpdatedAt: rejected.request.updatedAt }),
      (error) => error instanceof WithdrawalError && error.code === 'WITHDRAWAL_NOT_FOUND',
    );
    assert.equal(db.prepare('SELECT COUNT(*) count FROM notifications WHERE user_id = ?').get('USR-REQUESTER').count, 1);
  } finally { closeDatabase(db); }
});

test('review expiry enforces its deadline and rolls forward once', async () => {
  const db = await createFixture();
  try {
    const created = createWithdrawalRequest(db, { requesterId: 'USR-REQUESTER', bankId: 'BANK-OWN', amount: '10', idempotencyKey: 'withdrawal-lifecycle-0003' }).request;
    const approved = await decideWithdrawal(db, { adminId: 'ADM-OPERATOR', withdrawalId: created.id, decision: 'approve', expectedUpdatedAt: created.updatedAt });
    const entered = await submitWithdrawalCode(db, {
      requesterId: 'USR-REQUESTER', withdrawalId: created.id, code: approved.approvalCode,
      expectedUpdatedAt: approved.request.updatedAt, now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });
    assert.throws(
      () => expireWithdrawalReview(db, { requesterId: 'USR-REQUESTER', withdrawalId: created.id, expectedUpdatedAt: entered.request.updatedAt, now: () => Date.parse('2026-01-01T00:04:59.000Z') }),
      (error) => error.code === 'REVIEW_NOT_EXPIRED',
    );
    const expired = expireWithdrawalReview(db, { requesterId: 'USR-REQUESTER', withdrawalId: created.id, expectedUpdatedAt: entered.request.updatedAt, now: () => Date.parse('2026-01-01T00:05:00.000Z') });
    assert.equal(expired.request.status, 'Failed');
    assert.throws(
      () => expireWithdrawalReview(db, { requesterId: 'USR-REQUESTER', withdrawalId: created.id, expectedUpdatedAt: entered.request.updatedAt, now: () => Date.parse('2026-01-01T00:05:01.000Z') }),
      (error) => error.code === 'WITHDRAWAL_CONFLICT',
    );
  } finally { closeDatabase(db); }
});