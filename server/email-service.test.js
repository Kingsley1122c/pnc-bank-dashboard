import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDatabase, initializeDatabase } from './database.js';
import { consumeActionToken, createEmailProcessor, enqueueEmail, issueActionToken, recordResendWebhook, renderEmail } from './email-service.js';

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-email-'));
  await writeFile(path.join(directory, 'accounts.json'), JSON.stringify([
    { id: 'USR-EMAIL', role: 'user', status: 'Active', verificationStatus: 'Verified', name: 'Email User', email: 'user@example.com', password: 'email-password', accountNumber: '1000000001', accounts: [] },
  ]));
  await writeFile(path.join(directory, 'admin-workspace.json'), '{}');
  return initializeDatabase({ dataDir: directory });
}

function queueTransfer(db) {
  return enqueueEmail(db, {
    idempotencyKey: 'email:TX-1:sender', eventType: 'transfer.sent', aggregateType: 'transaction', aggregateId: 'TX-1',
    recipient: 'user@example.com', recipientUserId: 'USR-EMAIL', templateId: 'transfer-sent',
    payload: { name: 'Email User', recipientName: 'Recipient', amount: '25.50', currency: 'USD', status: 'Completed', reference: 'TX-1', occurredAt: '2026-10-10T12:00:00.000Z' },
    createdAt: '2026-10-10T12:00:00.000Z',
  });
}

test('email templates include authoritative details in HTML and plain text', () => {
  const rendered = renderEmail('transfer-sent', { name: 'Email User', recipientName: 'Recipient', amount: '25.50', currency: 'USD', status: 'Completed', reference: 'TX-1', occurredAt: '2026-10-10T12:00:00.000Z' }, { appBaseUrl: 'https://nevoracore.com' });
  assert.match(rendered.subject, /completed/i);
  assert.match(rendered.text, /\$25\.50/);
  assert.match(rendered.text, /TX-1/);
  assert.match(rendered.html, /NEVORA CORE/);
  assert.match(rendered.html, /https:\/\/nevoracore\.com/);
  assert.match(rendered.text, /financial operations platform/);
});

test('outbox accepts an email once and records provider acceptance separately from delivery', async () => {
  const db = await createFixture();
  const sent = [];
  try {
    assert.equal(queueTransfer(db), true);
    assert.equal(queueTransfer(db), false);
    const processor = createEmailProcessor({
      db,
      env: { EMAIL_MODE: 'live', APP_BASE_URL: 'https://nevoracore.com' },
      provider: { async send(message, idempotencyKey) { sent.push({ message, idempotencyKey }); return { id: 'resend-message-1' }; } },
      now: () => Date.parse('2026-10-10T12:01:00.000Z'),
    });
    assert.deepEqual(await processor.processBatch(), { processed: 1, configured: true, mode: 'live' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].idempotencyKey, 'email:TX-1:sender');
    const row = db.prepare('SELECT * FROM email_outbox').get();
    assert.equal(row.status, 'accepted');
    assert.equal(row.provider_status, 'accepted');
    assert.equal(row.delivered_at, null);
  } finally { closeDatabase(db); }
});

test('provider failures remain retryable without duplicating the underlying event', async () => {
  const db = await createFixture();
  let attempts = 0;
  try {
    queueTransfer(db);
    const processor = createEmailProcessor({
      db,
      env: { EMAIL_MODE: 'live' },
      provider: { async send() { attempts += 1; throw new Error('Temporary provider failure'); } },
      now: () => Date.parse('2026-10-10T12:01:00.000Z'),
    });
    await processor.processBatch();
    const row = db.prepare('SELECT * FROM email_outbox').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.attempt_count, 1);
    assert.ok(row.next_attempt_at);
    assert.equal(attempts, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM email_outbox').get().count, 1);
  } finally { closeDatabase(db); }
});

test('signed webhook results can update delivery once and duplicate events are ignored', async () => {
  const db = await createFixture();
  try {
    queueTransfer(db);
    db.prepare("UPDATE email_outbox SET status = 'accepted', provider_status = 'accepted', provider_message_id = 'resend-message-1'").run();
    const event = { id: 'event-1', type: 'email.delivered', data: { email_id: 'resend-message-1' } };
    assert.deepEqual(recordResendWebhook(db, event), { duplicate: false, status: 'delivered' });
    assert.deepEqual(recordResendWebhook(db, event), { duplicate: true });
    const row = db.prepare('SELECT * FROM email_outbox').get();
    assert.equal(row.status, 'delivered');
    assert.equal(row.provider_status, 'delivered');
    assert.ok(row.delivered_at);
  } finally { closeDatabase(db); }
});

test('action tokens are hashed, expiring, replaced, and single use', async () => {
  const db = await createFixture();
  const issuedAt = Date.parse('2026-10-10T12:00:00.000Z');
  try {
    const first = issueActionToken(db, { userId: 'USR-EMAIL', purpose: 'password-reset', lifetimeMs: 30 * 60 * 1000, now: () => issuedAt });
    const stored = db.prepare('SELECT token_hash, consumed_at FROM auth_action_tokens WHERE id = ?').get(first.id);
    assert.notEqual(stored.token_hash, first.token);
    assert.equal(stored.consumed_at, null);

    const replacement = issueActionToken(db, { userId: 'USR-EMAIL', purpose: 'password-reset', lifetimeMs: 30 * 60 * 1000, now: () => issuedAt + 1000 });
    assert.equal(consumeActionToken(db, { token: first.token, purpose: 'password-reset', now: () => issuedAt + 2000 }), null);
    assert.equal(consumeActionToken(db, { token: replacement.token, purpose: 'email-verification', now: () => issuedAt + 2000 }), null);
    assert.equal(consumeActionToken(db, { token: replacement.token, purpose: 'password-reset', now: () => issuedAt + 2000 })?.user_id, 'USR-EMAIL');
    assert.equal(consumeActionToken(db, { token: replacement.token, purpose: 'password-reset', now: () => issuedAt + 3000 }), null);

    const expiring = issueActionToken(db, { userId: 'USR-EMAIL', purpose: 'email-verification', lifetimeMs: 1000, now: () => issuedAt });
    assert.equal(consumeActionToken(db, { token: expiring.token, purpose: 'email-verification', now: () => issuedAt + 1000 }), null);
  } finally { closeDatabase(db); }
});
