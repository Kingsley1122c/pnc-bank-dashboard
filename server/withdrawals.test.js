import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDatabase, initializeDatabase } from './database.js';
import { createWithdrawalRequest, listWithdrawals, WithdrawalError } from './withdrawals.js';

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