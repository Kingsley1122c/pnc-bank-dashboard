import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDatabase, initializeDatabase } from './database.js';
import { createCardRequest, createCase, decideCardRequest, decideCase, ServiceRequestError } from './service-requests.js';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'nevora-services-'));
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify([
    { id: 'USR-ONE', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'Customer', email: 'customer@example.com', password: 'customer-pass', accountNumber: '1000000001', locale: 'ja', accounts: [] },
    { id: 'ADM-ONE', role: 'admin', status: 'Active', verificationStatus: 'Verified', name: 'Admin', email: 'admin@example.com', password: 'admin-pass', accounts: [] },
  ]));
  await writeFile(path.join(directory, 'admin-workspace.json'), '{}');
  return initializeDatabase({ dataDir: directory });
}

test('card request lifecycle is durable, idempotent, and queues localized status email', async () => {
  const db = await fixture();
  try {
    const command = { requesterId: 'USR-ONE', cardType: 'Physical Card', idempotencyKey: 'card-request-0001' };
    const created = createCardRequest(db, command);
    assert.equal(createCardRequest(db, command).replayed, true);
    const approved = decideCardRequest(db, { adminId: 'ADM-ONE', requestId: created.request.id, status: 'Approved' });
    assert.equal(approved.request.status, 'Approved');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM card_requests').get().count, 1);
    const payloads = db.prepare('SELECT payload_json FROM email_outbox ORDER BY id').all().map((row) => JSON.parse(row.payload_json));
    assert.equal(payloads.length, 2);
    assert.ok(payloads.every((payload) => payload.locale === 'ja'));
  } finally { closeDatabase(db); }
});

test('loan and investment decisions preserve reviewer reason and reject without one', async () => {
  const db = await fixture();
  try {
    const created = createCase(db, { requesterId: 'USR-ONE', type: 'Loan', subject: 'Home loan request', details: { amount: '25000', currency: 'USD' }, idempotencyKey: 'loan-request-0001' });
    assert.throws(() => decideCase(db, { adminId: 'ADM-ONE', caseId: created.request.id, status: 'Rejected' }), (error) => error instanceof ServiceRequestError && error.code === 'REASON_REQUIRED');
    const rejected = decideCase(db, { adminId: 'ADM-ONE', caseId: created.request.id, status: 'Rejected', reason: 'Income documentation was incomplete.' });
    assert.equal(rejected.request.adminNote, 'Income documentation was incomplete.');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM cases').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM email_outbox').get().count, 2);
  } finally { closeDatabase(db); }
});