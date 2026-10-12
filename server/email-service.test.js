import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeDatabase, initializeDatabase } from './database.js';
import { consumeActionToken, createEmailProcessor, enqueueEmail, issueActionToken, recordResendWebhook, renderEmail, resolveResendSender } from './email-service.js';

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

test('email rendering preserves Nevora Core while applying supported Unicode locales', () => {
  const korean = renderEmail('transfer-sent', { locale: 'ko', name: '고객', recipientName: '받는 사람', amount: '25.50', currency: 'USD', status: 'Completed', reference: 'TX-KO', occurredAt: '2026-10-10T12:00:00.000Z' }, { appBaseUrl: 'https://nevoracore.com' });
  const chinese = renderEmail('welcome', { locale: 'zh-CN', name: '客户', accountLast4: '1234' }, { appBaseUrl: 'https://nevoracore.com' });
  const japanese = renderEmail('login-alert', { locale: 'ja', name: '顧客', occurredAt: '2026-10-10T12:00:00.000Z' }, { appBaseUrl: 'https://nevoracore.com' });
  const traditionalChinese = renderEmail('withdrawal', { locale: 'zh-TW', name: '客戶', amount: '10', currency: 'USD', status: 'Rejected', eventKey: 'rejected', reason: '資料不符', reference: 'WD-1', occurredAt: '2026-10-10T12:00:00.000Z' }, { appBaseUrl: 'https://nevoracore.com' });
  assert.match(korean.html, /<html lang="ko">/);
  assert.match(korean.text, /안녕하세요 고객/);
  assert.match(korean.subject, /송금 완료/);
  assert.match(korean.html, /NEVORA CORE/);
  assert.match(chinese.html, /<html lang="zh-CN">/);
  assert.match(chinese.text, /账户/);
  assert.match(chinese.subject, /欢迎使用/);
  assert.match(japanese.subject, /新しいサインイン/);
  assert.match(traditionalChinese.text, /原因: 資料不符/);
  assert.doesNotMatch(traditionalChinese.text, /Withdrawal|Rejected/);
});

test('Resend sender accepts the required named mailbox format without duplicating the name', () => {
  assert.equal(resolveResendSender({ EMAIL_FROM: 'Nevora Core <no-reply@nevoracore.com>' }), 'Nevora Core <no-reply@nevoracore.com>');
  assert.equal(resolveResendSender({ EMAIL_FROM: 'no-reply@nevoracore.com', EMAIL_FROM_NAME: 'Nevora Core' }), 'Nevora Core <no-reply@nevoracore.com>');
  assert.equal(resolveResendSender({ EMAIL_FROM: 'Nevora Core\r\nBcc: attacker@example.com <no-reply@nevoracore.com>' }), null);
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

test('stale processing claims recover after restart with the original idempotency key', async () => {
  const db = await createFixture();
  const sentKeys = [];
  try {
    queueTransfer(db);
    db.prepare("UPDATE email_outbox SET status = 'processing', attempt_count = 1, updated_at = '2026-10-10T11:00:00.000Z'").run();
    const processor = createEmailProcessor({
      db,
      env: { EMAIL_MODE: 'live' },
      provider: { async send(_message, idempotencyKey) { sentKeys.push(idempotencyKey); return { id: 'resend-message-recovered' }; } },
      now: () => Date.parse('2026-10-10T12:00:00.000Z'),
    });

    assert.equal((await processor.processBatch()).processed, 1);
    assert.deepEqual(sentKeys, ['email:TX-1:sender']);
    const row = db.prepare('SELECT status, attempt_count, provider_message_id FROM email_outbox').get();
    assert.deepEqual(row, { status: 'accepted', attempt_count: 2, provider_message_id: 'resend-message-recovered' });
  } finally { closeDatabase(db); }
});

test('production live mode fails closed without an activation cutoff and suppresses older jobs with one', async () => {
  const db = await createFixture();
  try {
    queueTransfer(db);
    const blocked = createEmailProcessor({
      db,
      env: { NODE_ENV: 'production', EMAIL_MODE: 'live' },
      provider: { async send() { throw new Error('must not send'); } },
    });
    assert.equal(blocked.mode, 'disabled');

    const guarded = createEmailProcessor({
      db,
      env: { NODE_ENV: 'production', EMAIL_MODE: 'live', EMAIL_SEND_AFTER: '2026-10-11T00:00:00.000Z' },
      provider: { async send() { throw new Error('must not send'); } },
      now: () => Date.parse('2026-10-11T00:01:00.000Z'),
    });
    assert.equal((await guarded.processBatch()).processed, 0);
    assert.deepEqual(db.prepare('SELECT status, provider_status, last_error FROM email_outbox').get(), {
      status: 'suppressed', provider_status: 'suppressed', last_error: 'Queued before email activation',
    });
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
