import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  isValidEmail,
  isValidPublicUrl,
  sanitizeAccount,
  verifyPassword,
  verifyStoredPassword,
} from './security.js';

test('password hashes verify without retaining the plaintext value', async () => {
  const passwordHash = await hashPassword('correct-horse');

  assert.equal(passwordHash.includes('correct-horse'), false);
  assert.equal(await verifyPassword('correct-horse', passwordHash), true);
  assert.equal(await verifyPassword('wrong-password', passwordHash), false);
});

test('legacy plaintext passwords remain verifiable for a safe migration', async () => {
  assert.equal(await verifyStoredPassword({ password: 'legacy-pass' }, 'legacy-pass'), true);
  assert.equal(await verifyStoredPassword({ password: 'legacy-pass' }, 'not-the-password'), false);
});

test('sanitized accounts never expose password material', () => {
  const account = sanitizeAccount({ id: 'USR-1', password: 'secret123', passwordHash: 'hash', email: 'user@example.com' });

  assert.deepEqual(account, { id: 'USR-1', email: 'user@example.com' });
});

test('session tokens are random and stored by one-way hash', () => {
  const firstToken = createSessionToken();
  const secondToken = createSessionToken();

  assert.notEqual(firstToken, secondToken);
  assert.notEqual(hashSessionToken(firstToken), firstToken);
  assert.equal(hashSessionToken(firstToken), hashSessionToken(firstToken));
});

test('email and public URL validation accepts intended deployment values', () => {
  assert.equal(isValidEmail('owner@pnc-core.com'), true);
  assert.equal(isValidEmail('invalid-address'), false);
  assert.equal(isValidPublicUrl('https://pnc-core.com'), true);
  assert.equal(isValidPublicUrl('http://localhost:5173'), true);
  assert.equal(isValidPublicUrl('javascript:alert(1)'), false);
});