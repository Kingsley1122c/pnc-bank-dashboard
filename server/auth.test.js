import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAuthService } from './auth.js';

test('login migrates only the authenticated legacy password and persists a hashed session', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-auth-'));
  const sessionsFile = path.join(directory, 'sessions.json');
  let accounts = [
    { id: 'USR-1', role: 'user', status: 'Active', email: 'user@example.com', phone: '+10000000000', password: 'legacy-pass' },
  ];
  const auth = createAuthService({
    sessionsFile,
    readAccounts: async () => structuredClone(accounts),
    saveAccounts: async (nextAccounts) => { accounts = structuredClone(nextAccounts); },
  });

  const result = await auth.login('USER@example.com', 'legacy-pass');

  assert.ok(result?.token);
  assert.equal(result.account.password, undefined);
  assert.equal(result.account.passwordHash, undefined);
  assert.equal(accounts[0].password, undefined);
  assert.match(accounts[0].passwordHash, /^scrypt\$/);

  const persisted = JSON.parse(await readFile(sessionsFile, 'utf8'));
  assert.equal(persisted.sessions.length, 1);
  assert.equal(JSON.stringify(persisted).includes(result.token), false);
});

test('invalid credentials and suspended accounts do not create sessions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pnc-auth-'));
  const auth = createAuthService({
    sessionsFile: path.join(directory, 'sessions.json'),
    readAccounts: async () => [{ id: 'USR-1', role: 'user', status: 'Suspended', email: 'user@example.com', password: 'legacy-pass' }],
    saveAccounts: async () => {},
  });

  assert.equal(await auth.login('user@example.com', 'wrong-pass'), null);
  assert.deepEqual(await auth.login('user@example.com', 'legacy-pass'), { suspended: true });
});