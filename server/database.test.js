import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDatabase, getMigrationStatus, initializeDatabase, readDatabaseAccounts } from './database.js';

async function writeFixture(directory) {
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify([
    {
      id: 'USR-1000', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'Migration User',
      email: 'migration@example.com', phone: '+15550001000', password: 'short', accountNumber: '1000001000', routingNumber: '031100089',
      accounts: [{ label: 'Current', amount: 125.45 }], savedBanks: [], issuedCards: [], pendingIncomingTransfers: [],
      notifications: [{ id: 'NOTICE-1', type: 'account-update', title: 'Imported', message: 'Preserved', createdAt: '2026-01-01T00:00:00.000Z', readAt: null }],
    },
    {
      id: 'ADM-1000', role: 'admin', status: 'Active', verificationStatus: 'Verified', name: 'Migration Admin',
      email: 'admin-migration@example.com', phone: '+15550001001', password: 'admin-pass', accounts: [], notifications: [], savedBanks: [], issuedCards: [],
    },
  ], null, 2));
  await writeFile(path.join(directory, 'admin-workspace.json'), JSON.stringify({
    adminTransactionRecords: [{ id: 'TX-IMPORT-1', owner: 'Migration User', name: 'Imported Counterparty', type: 'Transfer', status: 'Completed', amount: '-$10.00', date: '2026-01-02T00:00:00.000Z' }],
    adminWithdrawalRecords: [], adminCardRecords: [], adminCaseRecords: [], adminActivityRecords: ['Imported audit entry'],
  }, null, 2));
  await writeFile(path.join(directory, 'sessions.json'), JSON.stringify({ sessions: [['hashed-token', { userId: 'USR-1000', role: 'user', createdAt: 1, expiresAt: 9999999999999 }]] }, null, 2));
}

test('JSON migration preserves accounts, balances, notifications, sessions, and creates backups', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-db-'));
  await writeFixture(directory);
  const db = await initializeDatabase({ dataDir: directory });

  try {
    const accounts = readDatabaseAccounts(db);
    const user = accounts.find((entry) => entry.id === 'USR-1000');
    assert.equal(accounts.length, 2);
    assert.equal(user.accounts[0].amount, 125.45);
    assert.equal(user.notifications[0].id, 'NOTICE-1');
    assert.deepEqual(user.pendingIncomingTransfers, []);
    assert.match(user.passwordHash, /^scrypt\$/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count, 1);
    assert.equal(getMigrationStatus(db).status, 'completed');
    const backupRoot = path.join(directory, 'backups');
    const backupDirectories = await readdir(backupRoot);
    assert.equal(backupDirectories.length, 1);
    assert.equal(JSON.parse(await readFile(path.join(backupRoot, backupDirectories[0], 'accounts.json'), 'utf8')).length, 2);
  } finally {
    closeDatabase(db);
  }
});

test('migration retry is idempotent and does not duplicate records or backups', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-db-'));
  await writeFixture(directory);
  let db = await initializeDatabase({ dataDir: directory });
  closeDatabase(db);
  db = await initializeDatabase({ dataDir: directory });

  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM transactions').get().count, 1);
    assert.equal((await readdir(path.join(directory, 'backups'))).length, 1);
  } finally {
    closeDatabase(db);
  }
});

test('invalid JSON data aborts without creating imported users', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-db-'));
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify([
    { id: 'USR-1', role: 'user', name: 'First', email: 'duplicate@example.com', password: 'password1', accounts: [] },
    { id: 'USR-2', role: 'user', name: 'Second', email: 'duplicate@example.com', password: 'password2', accounts: [] },
  ]));
  await writeFile(path.join(directory, 'admin-workspace.json'), '{}');

  await assert.rejects(() => initializeDatabase({ dataDir: directory }), /Duplicate account email/);
});