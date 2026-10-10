import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

test('account API requires a session and never returns password material', async (context) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'pnc-server-'));
  process.env.DATA_DIR = dataDirectory;
  process.env.NODE_ENV = 'test';
  process.env.APP_BASE_URL = 'http://localhost:5173';
  process.env.RESEND_API_KEY = 're_test_only';
  const webhookKey = Buffer.from('pnc-webhook-test-key');
  process.env.RESEND_WEBHOOK_SECRET = `whsec_${webhookKey.toString('base64')}`;
  process.env.EMAIL_FROM = 'no-reply@example.com';
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
  const invalidWebhookResponse = await fetch(`${baseUrl}/api/webhooks/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'svix-id': 'invalid', 'svix-timestamp': '1', 'svix-signature': 'invalid' },
    body: JSON.stringify({ id: 'event-invalid', type: 'email.delivered', data: { email_id: 'message-invalid' } }),
  });
  assert.equal(invalidWebhookResponse.status, 400);
  const webhookId = 'event-standard-headers';
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const webhookBody = JSON.stringify({ type: 'email.delivered', data: { email_id: 'message-standard-headers' } });
  const webhookSignature = createHmac('sha256', webhookKey)
    .update(`${webhookId}.${webhookTimestamp}.${webhookBody}`)
    .digest('base64');
  const validWebhookResponse = await fetch(`${baseUrl}/api/webhooks/resend`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': `v1,${webhookSignature}`,
    },
    body: webhookBody,
  });
  assert.equal(validWebhookResponse.status, 200);
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
  const userOwnershipResponse = await fetch(`${baseUrl}/api/admin/ownership`, { headers: { Cookie: sessionCookie } });
  assert.equal(userOwnershipResponse.status, 403);
  const injectedEmailResponse = await fetch(`${baseUrl}/api/emails/important-message`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Example User', email: 'example@pnc.bank', subject: 'Update\r\nBcc: attacker@example.com', message: 'Account update' }),
  });
  assert.equal(injectedEmailResponse.status, 410);
  const disabledEmailResponse = await fetch(`${baseUrl}/api/emails/important-message`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Example User', email: 'example@pnc.bank', subject: 'Account update', message: 'Account update' }),
  });
  assert.equal(disabledEmailResponse.status, 410);

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
  const testDatabase = new Database(path.join(dataDirectory, 'pnc-bank.sqlite'));
  context.after(() => testDatabase.close());
  assert.deepEqual(
    testDatabase.prepare('SELECT template_id FROM email_outbox WHERE recipient_user_id = ? ORDER BY template_id').all(registered.user.id).map((row) => row.template_id),
    ['email-verification', 'welcome'],
  );
  const resetRequest = await fetch(`${baseUrl}/api/auth/request-password-reset`, {
    method: 'POST', headers: { Origin: browserOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: registered.user.email }),
  });
  const unknownResetRequest = await fetch(`${baseUrl}/api/auth/request-password-reset`, {
    method: 'POST', headers: { Origin: browserOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'unknown@example.com' }),
  });
  assert.equal(resetRequest.status, 202);
  assert.equal(unknownResetRequest.status, 202);
  assert.deepEqual(await resetRequest.json(), await unknownResetRequest.json());
  const resetJob = testDatabase.prepare("SELECT payload_json FROM email_outbox WHERE recipient_user_id = ? AND template_id = 'password-reset'").get(registered.user.id);
  const resetToken = new URL(JSON.parse(resetJob.payload_json).actionUrl).searchParams.get('token');
  assert.ok(resetToken);
  const resetResponse = await fetch(`${baseUrl}/api/auth/reset-password`, {
    method: 'POST', headers: { Origin: browserOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: resetToken, password: 'replacement-password' }),
  });
  assert.equal(resetResponse.status, 200);
  const reusedResetResponse = await fetch(`${baseUrl}/api/auth/reset-password`, {
    method: 'POST', headers: { Origin: browserOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: resetToken, password: 'another-password' }),
  });
  assert.equal(reusedResetResponse.status, 400);
  assert.equal(testDatabase.prepare("SELECT COUNT(*) count FROM email_outbox WHERE recipient_user_id = ? AND template_id = 'password-changed'").get(registered.user.id).count, 1);
  const deniedCampaignResponse = await fetch(`${baseUrl}/api/admin/communications`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'denied-campaign-0001' },
    body: JSON.stringify({ title: 'Denied', message: 'Denied', audienceType: 'selected', recipientIds: [registered.user.id], deliveryMethod: 'email' }),
  });
  assert.equal(deniedCampaignResponse.status, 403);
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
  const campaignResponse = await fetch(`${baseUrl}/api/admin/communications`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: adminCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'approved-campaign-0001' },
    body: JSON.stringify({ title: 'Account notice', message: 'Controlled integration message', audienceType: 'selected', recipientIds: [registered.user.id], deliveryMethod: 'email' }),
  });
  assert.equal(campaignResponse.status, 202);
  const campaign = await campaignResponse.json();
  assert.equal(campaign.campaign.recipientCount, 1);
  const campaignHistoryResponse = await fetch(`${baseUrl}/api/admin/communications`, { headers: { Cookie: adminCookie } });
  assert.equal(campaignHistoryResponse.status, 200);
  assert.ok((await campaignHistoryResponse.json()).campaigns.some((entry) => entry.id === campaign.campaign.id));
  const ownershipResponse = await fetch(`${baseUrl}/api/admin/ownership`, { headers: { Cookie: adminCookie } });
  assert.equal(ownershipResponse.status, 200);
  const ownershipState = await ownershipResponse.json();
  assert.equal(ownershipState.ownership.ownerUserId, null);
  const claimResponse = await fetch(`${baseUrl}/api/admin/ownership/claim`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin123', confirmation: 'CLAIM PLATFORM OWNERSHIP', expectedVersion: ownershipState.ownership.version }),
  });
  assert.equal(claimResponse.status, 200);
  const claimedOwnership = await claimResponse.json();
  assert.equal(claimedOwnership.ownership.ownerUserId, 'ADM-0001');
  const forgedWorkspaceResponse = await fetch(`${baseUrl}/api/admin-workspace`, {
    method: 'PUT',
    headers: { Origin: browserOrigin, Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: { adminWithdrawalRecords: [{ id: withdrawal.request.id, status: 'Approved' }] } }),
  });
  assert.equal(forgedWorkspaceResponse.status, 400);
  const forgedAccountWorkspaceResponse = await fetch(`${baseUrl}/api/admin-workspace`, {
    method: 'PUT',
    headers: { Origin: browserOrigin, Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: { adminUserRecords: [{ accountId: registered.user.id, role: 'admin', status: 'Active' }] } }),
  });
  assert.equal(forgedAccountWorkspaceResponse.status, 400);
  const adminAccountsResponse = await fetch(`${baseUrl}/api/accounts`, { headers: { Cookie: adminCookie } });
  assert.equal(adminAccountsResponse.status, 200);
  const adminAccounts = (await adminAccountsResponse.json()).accounts;
  assert.ok(adminAccounts.some((account) => account.id === 'USR-0001'));
  assert.ok(adminAccounts.some((account) => account.id === registered.user.id));
  const registeredAdminAccount = adminAccounts.find((account) => account.id === registered.user.id);
  const adminWithdrawalsResponse = await fetch(`${baseUrl}/api/withdrawals`, { headers: { Cookie: adminCookie } });
  assert.ok((await adminWithdrawalsResponse.json()).withdrawals.some((entry) => entry.id === withdrawal.request.id));
  const customerDecisionResponse = await fetch(`${baseUrl}/api/admin/withdrawals/${withdrawal.request.id}/decision`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', expectedUpdatedAt: withdrawal.request.updatedAt }),
  });
  assert.equal(customerDecisionResponse.status, 403);
  const customerStatusResponse = await fetch(`${baseUrl}/api/admin/accounts/${registered.user.id}/status`, {
    method: 'PATCH',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Suspended', expectedUpdatedAt: registered.user.updatedAt }),
  });
  assert.equal(customerStatusResponse.status, 403);
  const approvalResponse = await fetch(`${baseUrl}/api/admin/withdrawals/${withdrawal.request.id}/decision`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'approve', expectedUpdatedAt: withdrawal.request.updatedAt }),
  });
  assert.equal(approvalResponse.status, 200);
  const approval = await approvalResponse.json();
  assert.match(approval.approvalCode, /^PNC-\d{6}$/);
  const foreignCodeResponse = await fetch(`${baseUrl}/api/withdrawals/${withdrawal.request.id}/code`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: approval.approvalCode, expectedUpdatedAt: approval.request.updatedAt }),
  });
  assert.equal(foreignCodeResponse.status, 404);
  const codeResponse = await fetch(`${baseUrl}/api/withdrawals/${withdrawal.request.id}/code`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: approval.approvalCode, expectedUpdatedAt: approval.request.updatedAt }),
  });
  assert.equal(codeResponse.status, 200);
  const verifyResponse = await fetch(`${baseUrl}/api/admin/accounts/${registered.user.id}/verify`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedUpdatedAt: registeredAdminAccount.updatedAt }),
  });
  assert.equal(verifyResponse.status, 200);
  const verified = await verifyResponse.json();
  assert.equal(verified.releasedTransferCount, 1);
  assert.equal(verified.account.verificationStatus, 'Verified');
  const adjustmentResponse = await fetch(`${baseUrl}/api/admin/balance-adjustments`, {
    method: 'POST',
    headers: { Origin: browserOrigin, Cookie: adminCookie, 'Content-Type': 'application/json', 'Idempotency-Key': 'approved-adjustment-0001' },
    body: JSON.stringify({ targetUserId: registered.user.id, accountLabel: 'Current', amount: '5.00', note: 'Integration test' }),
  });
  assert.equal(adjustmentResponse.status, 201);
  const adjustment = await adjustmentResponse.json();
  assert.equal(adjustment.account.accounts.find((account) => account.label === 'Current').amount, 14);

  const secondLoginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: browserOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'example@pnc.bank', password: 'example123' }),
  });
  assert.equal(secondLoginResponse.status, 200);
});