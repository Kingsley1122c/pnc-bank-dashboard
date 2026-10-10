import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CommunicationError, createCampaign, listCampaigns, previewCampaign, retryCampaign } from './communications.js';
import { closeDatabase, initializeDatabase } from './database.js';

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-communications-'));
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify([
    { id: 'USR-ONE', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'One', email: 'one@example.com', password: 'one-password', accounts: [] },
    { id: 'USR-TWO', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'Two', email: 'two@example.com', password: 'two-password', accounts: [] },
    { id: 'USR-SUSPENDED', role: 'user', status: 'Suspended', verificationStatus: 'Verified', name: 'Suspended', email: 'suspended@example.com', password: 'suspended-password', accounts: [] },
    { id: 'ADM-ONE', role: 'admin', status: 'Active', verificationStatus: 'Verified', name: 'Admin', email: 'admin@example.com', password: 'admin-password', accounts: [] },
  ]));
  await writeFile(path.join(directory, 'admin-workspace.json'), '{}');
  return initializeDatabase({ dataDir: directory });
}

test('announcement preview and creation target only eligible intended customers', async () => {
  const db = await createFixture();
  try {
    const preview = previewCampaign(db, { actorUserId: 'ADM-ONE', title: 'Maintenance', message: 'Service window', audienceType: 'all', deliveryMethod: 'both' });
    assert.equal(preview.recipientCount, 2);
    assert.equal(preview.confirmation, 'SEND TO 2 CUSTOMERS');
    const result = createCampaign(db, { actorUserId: 'ADM-ONE', idempotencyKey: 'campaign-request-0001', confirmation: preview.confirmation, title: 'Maintenance', message: 'Service window', audienceType: 'all', deliveryMethod: 'both' });
    assert.equal(result.campaign.recipientCount, 2);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM notifications').get().count, 2);
    assert.deepEqual(db.prepare('SELECT recipient FROM email_outbox ORDER BY recipient').all().map((row) => row.recipient), ['one@example.com', 'two@example.com']);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM email_outbox WHERE recipient = 'suspended@example.com'").get().count, 0);
  } finally { closeDatabase(db); }
});

test('campaign idempotency and confirmation prevent duplicate or accidental bulk sends', async () => {
  const db = await createFixture();
  const input = { actorUserId: 'ADM-ONE', idempotencyKey: 'campaign-request-0002', title: 'Policy update', message: 'Review the policy', audienceType: 'all', deliveryMethod: 'email' };
  try {
    assert.throws(() => createCampaign(db, input), (error) => error instanceof CommunicationError && error.code === 'CONFIRMATION_REQUIRED');
    const first = createCampaign(db, { ...input, confirmation: 'SEND TO 2 CUSTOMERS' });
    const replay = createCampaign(db, { ...input, confirmation: 'SEND TO 2 CUSTOMERS' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.campaign.id, first.campaign.id);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM email_campaigns').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM email_outbox').get().count, 2);
  } finally { closeDatabase(db); }
});

test('customers cannot create or inspect campaigns and retries only requeue failed jobs', async () => {
  const db = await createFixture();
  try {
    assert.throws(() => previewCampaign(db, { actorUserId: 'USR-ONE', title: 'Denied', message: 'Denied', audienceType: 'selected', recipientIds: ['USR-TWO'], deliveryMethod: 'email' }), (error) => error.code === 'ADMIN_REQUIRED');
    const result = createCampaign(db, { actorUserId: 'ADM-ONE', idempotencyKey: 'campaign-request-0003', title: 'One customer', message: 'Account message', audienceType: 'selected', recipientIds: ['USR-ONE'], deliveryMethod: 'email' });
    db.prepare("UPDATE email_outbox SET status = 'failed', provider_status = 'failed', attempt_count = 1 WHERE aggregate_id = ?").run(result.campaign.id);
    assert.equal(retryCampaign(db, { actorUserId: 'ADM-ONE', campaignId: result.campaign.id }).queuedCount, 1);
    assert.equal(listCampaigns(db, { actorUserId: 'ADM-ONE' }).length, 1);
    assert.throws(() => listCampaigns(db, { actorUserId: 'USR-ONE' }), (error) => error.code === 'ADMIN_REQUIRED');
  } finally { closeDatabase(db); }
});
