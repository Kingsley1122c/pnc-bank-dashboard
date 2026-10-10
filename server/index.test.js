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
  const browserOrigin = 'http://localhost:5173';
  const missingAssetResponse = await fetch(`${baseUrl}/assets/missing-build-asset.js`, { headers: { Origin: 'https://deployment.example' } });
  assert.equal(missingAssetResponse.status, 404);
  assert.equal(missingAssetResponse.headers.get('cache-control'), 'no-store');

  const disallowedOriginResponse = await fetch(`${baseUrl}/api/accounts`, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(disallowedOriginResponse.status, 403);

  const anonymousResponse = await fetch(`${baseUrl}/api/accounts`);
  assert.equal(anonymousResponse.status, 401);
  const anonymousEventsResponse = await fetch(`${baseUrl}/api/events`);
  assert.equal(anonymousEventsResponse.status, 401);
  const originlessLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'example@pnc.bank', password: 'example123' }),
  });
  assert.equal(originlessLoginResponse.status, 403);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: browserOrigin, 'Content-Type': 'application/json' },
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
  assert.deepEqual(accountsPayload.accounts.map((account) => account.id), ['USR-0001']);
  const saveResponse = await fetch(`${baseUrl}/api/accounts`, {
    method: 'PUT',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accounts: accountsPayload.accounts }),
  });
  assert.equal(saveResponse.status, 403);

  const userWorkspaceResponse = await fetch(`${baseUrl}/api/admin-workspace`, { headers: { Cookie: sessionCookie } });
  assert.equal(userWorkspaceResponse.status, 403);
  const injectedEmailResponse = await fetch(`${baseUrl}/api/emails/important-message`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Example User', email: 'example@pnc.bank', subject: 'Update\r\nBcc: attacker@example.com', message: 'Account update' }),
  });
  assert.equal(injectedEmailResponse.status, 400);
  const disabledEmailResponse = await fetch(`${baseUrl}/api/emails/important-message`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Example User', email: 'example@pnc.bank', subject: 'Account update', message: 'Account update' }),
  });
  assert.equal(disabledEmailResponse.status, 503);

  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { Origin: browserOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Transfer Recipient', email: 'recipient@example.com', phone: '+1 202 555 0199',
      password: 'recipient-password', dateOfBirth: '1990-01-01', gender: 'Other',
    }),
  });
  assert.equal(registerResponse.status, 201);
  const registered = await registerResponse.json();
  const idempotencyKey = 'server-test-transfer-0001';
  const transferRequest = {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ sourceAccount: 'Savings', accountNumber: registered.user.accountNumber, amount: '9.00', note: 'Integration test' }),
  };
  const transferResponse = await fetch(`${baseUrl}/api/transfers/internal`, transferRequest);
  assert.equal(transferResponse.status, 201);
  const transfer = await transferResponse.json();
  assert.equal(transfer.receipt.status, 'Pending Verification');
  assert.equal(transfer.sender.accounts.find((account) => account.label === 'Savings').amount, 72931.67);

  const replayResponse = await fetch(`${baseUrl}/api/transfers/internal`, transferRequest);
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.transactionId, transfer.transactionId);
  assert.equal(replay.sender.accounts.find((account) => account.label === 'Savings').amount, 72931.67);

  const requester = accountsPayload.accounts[0];
  const withdrawalResponse = await fetch(`${baseUrl}/api/withdrawals`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'server-test-withdrawal-0001' },
    body: JSON.stringify({ bankId: requester.savedBanks[0].id, amount: '12.50', message: 'Integration test' }),
  });
  assert.equal(withdrawalResponse.status, 201);
  const withdrawal = await withdrawalResponse.json();
  assert.equal(withdrawal.request.requesterId, 'USR-0001');
  assert.equal(withdrawal.request.amountValue, 12.5);
  const userWithdrawalsResponse = await fetch(`${baseUrl}/api/withdrawals`, { headers: { Cookie: sessionCookie } });
  assert.deepEqual((await userWithdrawalsResponse.json()).withdrawals.map((entry) => entry.id), [withdrawal.request.id]);

  const deniedAdjustment = await fetch(`${baseUrl}/api/admin/balance-adjustments`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'denied-adjustment-0001' },
    body: JSON.stringify({ targetUserId: registered.user.id, accountLabel: 'Current', amount: '5.00' }),
  });
  assert.equal(deniedAdjustment.status, 403);

  const adminLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: browserOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin@pnc.bank', password: 'admin123' }),
  });
  assert.equal(adminLoginResponse.status, 200);
  const adminCookie = adminLoginResponse.headers.get('set-cookie')?.split(';')[0];
  const adminAccountsResponse = await fetch(`${baseUrl}/api/accounts`, { headers: { Cookie: adminCookie } });
  assert.equal(adminAccountsResponse.status, 200);
  const adminAccounts = (await adminAccountsResponse.json()).accounts;
  assert.ok(adminAccounts.some((account) => account.id === 'USR-0001'));
  assert.ok(adminAccounts.some((account) => account.id === registered.user.id));
  const adminWithdrawalsResponse = await fetch(`${baseUrl}/api/withdrawals`, { headers: { Cookie: adminCookie } });
  assert.ok((await adminWithdrawalsResponse.json()).withdrawals.some((entry) => entry.id === withdrawal.request.id));
  const adjustmentResponse = await fetch(`${baseUrl}/api/admin/balance-adjustments`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: adminCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'approved-adjustment-0001' },
    body: JSON.stringify({ targetUserId: registered.user.id, accountLabel: 'Current', amount: '5.00', note: 'Integration test' }),
  });
  assert.equal(adjustmentResponse.status, 201);
  const adjustment = await adjustmentResponse.json();
  assert.equal(adjustment.account.accounts.find((account) => account.label === 'Current').amount, 5);

  const secondLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: browserOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'example@pnc.bank', password: 'example123' }),
  });
  assert.equal(secondLoginResponse.status, 200);
});