import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDatabase, initializeDatabase } from './database.js';
import { claimOwnership, getOwnership, OwnershipError, transferOwnership } from './ownership.js';

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-ownership-'));
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify([
    { id: 'ADM-FIRST', role: 'admin', status: 'Active', verificationStatus: 'Verified', name: 'First Admin', email: 'first@example.com', password: 'first-password', accounts: [] },
    { id: 'ADM-SECOND', role: 'admin', status: 'Active', verificationStatus: 'Verified', name: 'Second Admin', email: 'second@example.com', password: 'second-password', accounts: [] },
    { id: 'USR-CUSTOMER', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'Customer', email: 'customer@example.com', password: 'customer-password', accounts: [] },
  ]));
  await writeFile(path.join(directory, 'admin-workspace.json'), '{}');
  return initializeDatabase({ dataDir: directory });
}

test('ownership claim requires reauthentication and exact confirmation', async () => {
  const db = await createFixture();
  try {
    assert.equal(getOwnership(db).ownerUserId, null);
    await assert.rejects(
      () => claimOwnership(db, { actorUserId: 'ADM-FIRST', password: 'wrong-password', confirmation: 'CLAIM PLATFORM OWNERSHIP', expectedVersion: 0 }),
      (error) => error instanceof OwnershipError && error.code === 'REAUTHENTICATION_FAILED',
    );
    const ownership = await claimOwnership(db, { actorUserId: 'ADM-FIRST', password: 'first-password', confirmation: 'CLAIM PLATFORM OWNERSHIP', expectedVersion: 0 });
    assert.equal(ownership.ownerUserId, 'ADM-FIRST');
    assert.equal(ownership.version, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action = 'ownership.claimed'").get().count, 1);
  } finally { closeDatabase(db); }
});

test('only the current owner can transfer to another active admin', async () => {
  const db = await createFixture();
  try {
    await claimOwnership(db, { actorUserId: 'ADM-FIRST', password: 'first-password', confirmation: 'CLAIM PLATFORM OWNERSHIP', expectedVersion: 0 });
    await assert.rejects(
      () => transferOwnership(db, { actorUserId: 'ADM-SECOND', targetUserId: 'ADM-FIRST', password: 'second-password', confirmation: 'TRANSFER OWNERSHIP TO first@example.com', expectedVersion: 1 }),
      (error) => error.code === 'OWNER_REQUIRED',
    );
    await assert.rejects(
      () => transferOwnership(db, { actorUserId: 'ADM-FIRST', targetUserId: 'USR-CUSTOMER', password: 'first-password', confirmation: 'TRANSFER OWNERSHIP TO customer@example.com', expectedVersion: 1 }),
      (error) => error.code === 'TARGET_NOT_ELIGIBLE',
    );
    const ownership = await transferOwnership(db, { actorUserId: 'ADM-FIRST', targetUserId: 'ADM-SECOND', password: 'first-password', confirmation: 'TRANSFER OWNERSHIP TO second@example.com', expectedVersion: 1 });
    assert.equal(ownership.ownerUserId, 'ADM-SECOND');
    assert.equal(ownership.version, 2);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action = 'ownership.transferred'").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM email_outbox WHERE event_type = 'ownership.transferred'").get().count, 2);
    assert.equal(db.prepare("SELECT role FROM users WHERE id = 'ADM-FIRST'").get().role, 'admin');
    assert.equal(db.prepare("SELECT role FROM users WHERE id = 'ADM-SECOND'").get().role, 'admin');
  } finally { closeDatabase(db); }
});

test('ownership version prevents duplicate and concurrent transfers', async () => {
  const db = await createFixture();
  try {
    await claimOwnership(db, { actorUserId: 'ADM-FIRST', password: 'first-password', confirmation: 'CLAIM PLATFORM OWNERSHIP', expectedVersion: 0 });
    await transferOwnership(db, { actorUserId: 'ADM-FIRST', targetUserId: 'ADM-SECOND', password: 'first-password', confirmation: 'TRANSFER OWNERSHIP TO second@example.com', expectedVersion: 1 });
    await assert.rejects(
      () => transferOwnership(db, { actorUserId: 'ADM-FIRST', targetUserId: 'ADM-SECOND', password: 'first-password', confirmation: 'TRANSFER OWNERSHIP TO second@example.com', expectedVersion: 1 }),
      (error) => ['OWNER_REQUIRED', 'OWNERSHIP_CONFLICT'].includes(error.code),
    );
    assert.equal(getOwnership(db).version, 2);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM audit_logs WHERE action = 'ownership.transferred'").get().count, 1);
  } finally { closeDatabase(db); }
});