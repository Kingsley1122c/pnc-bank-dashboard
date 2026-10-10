import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('account API requires a session and never returns password material', async (context) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'pnc-server-'));
  process.env.DATA_DIR = dataDirectory;
  process.env.NODE_ENV = 'test';
  process.env.APP_BASE_URL = 'http://localhost:5173';
  const { app } = await import(`./index.js?test=${Date.now()}`);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const missingAssetResponse = await fetch(`${baseUrl}/assets/missing-build-asset.js`);
  assert.equal(missingAssetResponse.status, 404);

  const anonymousResponse = await fetch(`${baseUrl}/api/accounts`);
  assert.equal(anonymousResponse.status, 401);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'example@pnc.bank', password: 'example123' }),
  });
  assert.equal(loginResponse.status, 200);
  const sessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(sessionCookie);

  const accountsResponse = await fetch(`${baseUrl}/api/accounts`, { headers: { Cookie: sessionCookie } });
  assert.equal(accountsResponse.status, 200);
  const body = await accountsResponse.text();
  assert.equal(body.includes('"password"'), false);
  assert.equal(body.includes('passwordHash'), false);
  assert.equal(body.includes('example123'), false);

  const accountsPayload = JSON.parse(body);
  const saveResponse = await fetch(`${baseUrl}/api/accounts`, {
    method: 'PUT',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accounts: accountsPayload.accounts }),
  });
  assert.equal(saveResponse.status, 200);

  const secondLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'example@pnc.bank', password: 'example123' }),
  });
  assert.equal(secondLoginResponse.status, 200);
});