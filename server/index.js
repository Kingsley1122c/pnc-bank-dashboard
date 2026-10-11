import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuthService } from './auth.js';
import { AccountManagementError, updateAccountStatus, verifyAccount } from './account-management.js';
import { CommunicationError, createCampaign, listCampaigns, previewCampaign, retryCampaign } from './communications.js';
import {
  createDatabaseAccount,
  createDatabaseSessionStore,
  initializeDatabase,
  readDatabaseAccounts,
  readDatabaseAdminWorkspace,
  saveDatabaseAdminWorkspace,
  updateDatabaseAccountPassword,
} from './database.js';
import { consumeActionToken, createEmailProcessor, createResendProvider, enqueueEmail, issueActionToken, recordResendWebhook } from './email-service.js';
import { hashPassword, isValidEmail, normalizeEmail, sanitizeAccount } from './security.js';
import { claimOwnership, getOwnership, listOwnershipCandidates, OwnershipError, transferOwnership } from './ownership.js';
import { createAdminAdjustment, createInternalTransfer, TransactionError } from './transactions.js';
import {
  createWithdrawalRequest,
  decideWithdrawal,
  expireWithdrawalReview,
  listWithdrawals,
  submitWithdrawalCode,
  WithdrawalError,
} from './withdrawals.js';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const host = '0.0.0.0';
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), 'server', 'data');
const accountsFile = path.join(dataDir, 'accounts.json');
const adminWorkspaceFile = path.join(dataDir, 'admin-workspace.json');
const sessionsFile = path.join(dataDir, 'sessions.json');
const distDir = path.resolve(process.cwd(), 'dist');
const eventClients = new Set();

function getAppBaseUrl() {
  return process.env.APP_BASE_URL?.trim().replace(/\/$/, '') || '';
}

function getAllowedOrigins() {
  const configuredOrigins = String(process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const appBaseUrl = getAppBaseUrl();
  const developmentOrigins = process.env.NODE_ENV === 'production'
    ? []
    : ['http://localhost:5173', 'http://127.0.0.1:5173'];

  return new Set([appBaseUrl, ...configuredOrigins, ...developmentOrigins].filter(Boolean));
}

function createRateLimiter({ windowMs, limit }) {
  const requestsByClient = new Map();

  return (request, response, next) => {
    const now = Date.now();
    const clientKey = request.ip || request.socket.remoteAddress || 'unknown';
    const current = requestsByClient.get(clientKey);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;

    bucket.count += 1;
    requestsByClient.set(clientKey, bucket);

    if (bucket.count > limit) {
      response.status(429).json({ message: 'Too many requests. Please try again later.' });
      return;
    }

    next();
  };
}

function getSeedIssuedCards(account) {
  const existingIssuedCards = account.issuedCards ?? [];

  if (existingIssuedCards.length > 0 || account.role === 'admin') {
    return existingIssuedCards;
  }

  const isSeedExampleUser = account.id === 'USR-0001' || String(account.email ?? '').toLowerCase() === 'example@pnc.bank';

  if (!isSeedExampleUser) {
    return existingIssuedCards;
  }

  return [
    {
      id: 'CARD-SEED-USR-0001',
      requestId: 'CARD-SEED-USR-0001',
      type: 'Physical Debit Card - Generated',
      cardMode: 'Physical Card',
      status: 'Active',
      requested: 'Apr 05, 2026',
      issuedAt: '2026-04-05T09:30:00.000Z',
      network: 'Mastercard World',
      maskedNumber: '**** 8842',
      issuedBy: 'PNC Account Services',
    },
  ];
}

function normalizeStoredAccount(account) {
  return {
    ...account,
    issuedCards: getSeedIssuedCards(account),
  };
}

function formatAccountNumber(accountNumber) {
  const cleaned = String(accountNumber ?? '').replace(/\D/g, '');

  if (cleaned.length < 10) {
    return accountNumber || 'Not available';
  }

  return `${cleaned.slice(0, 3)} ${cleaned.slice(3, 6)} ${cleaned.slice(6)}`;
}

function generatePncAccountNumber(seed) {
  const normalizedSeed = String(seed ?? 'PNC').trim().toUpperCase();
  let hash = 0;

  for (const char of normalizedSeed) {
    hash = ((hash * 31) + char.charCodeAt(0)) % 900000000;
  }

  return String(1000000000 + hash).slice(0, 10);
}

function broadcastEvent(type) {
  const payload = `data: ${JSON.stringify({ type, timestamp: new Date().toISOString() })}\n\n`;

  for (const client of eventClients) {
    client.write(payload);
  }
}

const defaultAccounts = [
  {
    id: 'USR-0001',
    role: 'user',
    status: 'Active',
    name: 'Example User',
    email: 'example@pnc.bank',
    phone: '+1 202 555 0146',
    password: 'example123',
    segment: 'Platinum Client',
    avatar: 'EU',
    accounts: [
      { label: 'Savings', amount: 72940.67 },
      { label: 'Current', amount: 46800.23 },
      { label: 'Business', amount: 8710.0 },
    ],
    savedBanks: [
      { id: 'BNK-1001', bankName: 'Chase Bank', accountName: 'Example User', accountNumber: '**** 1048' },
      { id: 'BNK-1002', bankName: 'Bank of America', accountName: 'Example User', accountNumber: '**** 2204' },
    ],
  },
  {
    id: 'ADM-0001',
    role: 'admin',
    status: 'Active',
    name: 'Admin Control',
    email: 'admin@pnc.bank',
    phone: '+1 202 555 0188',
    password: 'admin123',
    segment: 'Super Admin',
    avatar: 'AD',
    accounts: [],
    savedBanks: [],
  },
];

async function ensureAccountsFile() {
  await mkdir(dataDir, { recursive: true });

  if (!existsSync(accountsFile)) {
    await writeFile(accountsFile, JSON.stringify(defaultAccounts, null, 2), 'utf8');
  }

  if (!existsSync(adminWorkspaceFile)) {
    await writeFile(adminWorkspaceFile, JSON.stringify({}, null, 2), 'utf8');
  }
}

async function readAccounts() {
  return readDatabaseAccounts(database).map(normalizeStoredAccount);
}

async function readAdminWorkspace() {
  return readDatabaseAdminWorkspace(database);
}

async function saveAdminWorkspace(workspace, expectedUpdatedAt) {
  return saveDatabaseAdminWorkspace(database, workspace, expectedUpdatedAt);
}

if (process.env.NODE_ENV !== 'production') await ensureAccountsFile();
const database = await initializeDatabase({ dataDir });
const resendProvider = createResendProvider(process.env);
const emailProcessor = createEmailProcessor({ db: database, env: process.env, provider: resendProvider });
let emailProcessingPromise = null;

function processEmailOutbox() {
  if (!emailProcessingPromise) {
    emailProcessingPromise = emailProcessor.processBatch(25).catch(() => ({ processed: 0 })).finally(() => {
      emailProcessingPromise = null;
    });
  }
  return emailProcessingPromise;
}

function scheduleEmailProcessing() {
  setImmediate(() => void processEmailOutbox());
}

const authService = createAuthService({
  sessionsFile,
  sessionStore: createDatabaseSessionStore(database),
  readAccounts,
  saveAccounts: async () => {},
  migrateAccountPassword: (userId, passwordHash) => updateDatabaseAccountPassword(database, userId, passwordHash),
  secureCookies: getAppBaseUrl().startsWith('https://') || process.env.NODE_ENV === 'production',
});
const authRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 20 });
const allowedOrigins = getAllowedOrigins();

function isTrustedRequestOrigin(request) {
  const normalizedOrigin = request.get('origin')?.replace(/\/$/, '');
  if (!normalizedOrigin) return false;

  try {
    return new URL(normalizedOrigin).host === request.get('host') || allowedOrigins.has(normalizedOrigin);
  } catch {
    return false;
  }
}

app.disable('x-powered-by');
app.post('/api/webhooks/resend', express.raw({ type: 'application/json', limit: '256kb' }), (request, response) => {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!resendProvider || !webhookSecret) {
    response.status(503).json({ message: 'Email webhook verification is not configured.' });
    return;
  }
  try {
    const webhookId = request.get('webhook-id') || request.get('svix-id');
    const event = resendProvider.verifyWebhook(request.body.toString('utf8'), {
      id: webhookId,
      timestamp: request.get('webhook-timestamp') || request.get('svix-timestamp'),
      signature: request.get('webhook-signature') || request.get('svix-signature'),
    }, webhookSecret);
    response.json(recordResendWebhook(database, { ...event, id: event.id || webhookId }));
  } catch (error) {
    console.warn('Resend webhook verification failed.', {
      error: error?.message || 'Unknown verification error',
      hasWebhookHeaders: Boolean(request.get('webhook-id') && request.get('webhook-timestamp') && request.get('webhook-signature')),
      hasSvixHeaders: Boolean(request.get('svix-id') && request.get('svix-timestamp') && request.get('svix-signature')),
    });
    response.status(400).json({ message: 'Invalid webhook signature.' });
  }
});
app.use('/api', (request, response, next) => cors({
  credentials: true,
  origin(origin, callback) {
    const normalizedOrigin = origin?.replace(/\/$/, '');
    let isSameHost = false;
    try {
      isSameHost = Boolean(normalizedOrigin) && new URL(normalizedOrigin).host === request.get('host');
    } catch {
      isSameHost = false;
    }

    if (!normalizedOrigin || isSameHost || allowedOrigins.has(normalizedOrigin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin is not allowed by CORS.'));
  },
})(request, response, next));
app.use('/api', (error, _request, response, next) => {
  if (error?.message === 'Origin is not allowed by CORS.') {
    response.status(403).json({ message: error.message });
    return;
  }
  next(error);
});
app.use('/api', (request, response, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || isTrustedRequestOrigin(request)) {
    next();
    return;
  }

  response.status(403).json({ message: 'A trusted request origin is required.' });
});
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, port });
});

app.post('/api/auth/login', authRateLimit, async (request, response) => {
  const { identifier, password } = request.body ?? {};

  if (!String(identifier ?? '').trim() || !String(password ?? '')) {
    response.status(400).json({ message: 'Email or phone and password are required.' });
    return;
  }

  try {
    const result = await authService.login(identifier, password);

    if (!result) {
      response.status(401).json({ message: 'Invalid email, phone, or password.' });
      return;
    }

    if (result.suspended) {
      response.status(403).json({ message: 'This account is unavailable. Contact support for assistance.' });
      return;
    }

    authService.setSessionCookie(response, result.token);
    response.json({ user: result.account, expiresAt: new Date(result.session.expiresAt).toISOString() });
  } catch {
    response.status(500).json({ message: 'Unable to sign in right now.' });
  }
});

app.post('/api/auth/register', authRateLimit, async (request, response) => {
  const { name, email, phone, password, dateOfBirth, gender, avatarImage = '' } = request.body ?? {};
  const normalizedName = String(name ?? '').trim();
  const normalizedEmailAddress = normalizeEmail(email);
  const normalizedPhone = String(phone ?? '').trim();

  if (!normalizedName || !isValidEmail(normalizedEmailAddress) || !normalizedPhone || !dateOfBirth || !gender) {
    response.status(400).json({ message: 'Complete all required registration fields with a valid email address.' });
    return;
  }

  if (String(password ?? '').length < 8) {
    response.status(400).json({ message: 'Password must be at least 8 characters long.' });
    return;
  }

  try {
    const accounts = await readAccounts();
    const alreadyExists = accounts.some(
      (account) => normalizeEmail(account.email) === normalizedEmailAddress || String(account.phone ?? '').trim() === normalizedPhone,
    );

    if (alreadyExists) {
      response.status(409).json({ message: 'An account already exists for those credentials.' });
      return;
    }

    const nextUserNumber = accounts.reduce((highest, account) => {
      const numericId = Number(String(account.id ?? '').replace(/^USR-/, ''));
      return Number.isFinite(numericId) ? Math.max(highest, numericId) : highest;
    }, 0) + 1;
    const accountNumber = generatePncAccountNumber(`${normalizedEmailAddress}-${normalizedPhone}`);
    const newAccount = normalizeStoredAccount({
      id: `USR-${String(nextUserNumber).padStart(4, '0')}`,
      role: 'user',
      status: 'Active',
      verificationStatus: 'Pending',
      name: normalizedName,
      email: normalizedEmailAddress,
      phone: normalizedPhone,
      passwordHash: await hashPassword(password),
      dateOfBirth,
      gender,
      segment: 'Digital Client',
      avatar: normalizedName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(),
      avatarImage: String(avatarImage).slice(0, 1_500_000),
      accounts: [
        { label: 'Savings', amount: 0 },
        { label: 'Current', amount: 0 },
        { label: 'Business', amount: 0 },
      ],
      accountNumber,
      routingNumber: '031100089',
      notifications: [],
      pendingIncomingTransfers: [],
      savedBanks: [],
      issuedCards: [],
    });

    createDatabaseAccount(database, newAccount, {
      afterInsert(db, createdAt) {
        const verification = issueActionToken(db, { userId: newAccount.id, purpose: 'email-verification', lifetimeMs: 24 * 60 * 60 * 1000 });
        enqueueEmail(db, {
          idempotencyKey: `email:welcome:${newAccount.id}`, eventType: 'account.created', aggregateType: 'user', aggregateId: newAccount.id,
          recipient: newAccount.email, recipientUserId: newAccount.id, templateId: 'welcome',
          payload: { name: newAccount.name, accountLast4: accountNumber.slice(-4) }, createdAt,
        });
        enqueueEmail(db, {
          idempotencyKey: `email:verification:${newAccount.id}`, eventType: 'account.email-verification-requested', aggregateType: 'user', aggregateId: newAccount.id,
          recipient: newAccount.email, recipientUserId: newAccount.id, templateId: 'email-verification',
          payload: { name: newAccount.name, actionUrl: `${getAppBaseUrl()}/verify-email?token=${encodeURIComponent(verification.token)}` }, createdAt,
        });
      },
    });
    const loginResult = await authService.login(normalizedEmailAddress, password);
    authService.setSessionCookie(response, loginResult.token);

    broadcastEvent('accounts');
    scheduleEmailProcessing();
    response.status(201).json({ user: sanitizeAccount(newAccount), emailQueued: true });
  } catch {
    response.status(500).json({ message: 'Unable to create the account right now.' });
  }
});

app.post('/api/auth/request-password-reset', authRateLimit, (request, response) => {
  const email = normalizeEmail(request.body?.email);
  if (isValidEmail(email)) {
    const user = database.prepare("SELECT id, name, email FROM users WHERE email = ? AND role = 'user' AND status != 'Suspended'").get(email);
    if (user) {
      database.transaction(() => {
        const reset = issueActionToken(database, { userId: user.id, purpose: 'password-reset', lifetimeMs: 30 * 60 * 1000 });
        enqueueEmail(database, {
          idempotencyKey: `email:password-reset:${reset.id}`, eventType: 'account.password-reset-requested', aggregateType: 'user', aggregateId: user.id,
          recipient: user.email, recipientUserId: user.id, templateId: 'password-reset',
          payload: { name: user.name, actionUrl: `${getAppBaseUrl()}/reset-password?token=${encodeURIComponent(reset.token)}` },
        });
      }).immediate();
      scheduleEmailProcessing();
    }
  }
  response.status(202).json({ message: 'If that account is eligible, a password-reset email has been queued.' });
});

app.post('/api/auth/reset-password', authRateLimit, async (request, response) => {
  const token = String(request.body?.token ?? '');
  const password = String(request.body?.password ?? '');
  if (!token || password.length < 8) {
    response.status(400).json({ message: 'Enter a valid reset link and a password of at least 8 characters.' });
    return;
  }
  const passwordHash = await hashPassword(password);
  try {
    database.transaction(() => {
      const action = consumeActionToken(database, { token, purpose: 'password-reset' });
      if (!action) throw new Error('INVALID_RESET_TOKEN');
      const user = database.prepare("SELECT id, name, email FROM users WHERE id = ? AND role = 'user'").get(action.user_id);
      if (!user) throw new Error('INVALID_RESET_TOKEN');
      const changedAt = new Date().toISOString();
      database.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, changedAt, user.id);
      database.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(Date.now(), user.id);
      enqueueEmail(database, {
        idempotencyKey: `email:password-changed:${action.id}`, eventType: 'account.password-changed', aggregateType: 'user', aggregateId: user.id,
        recipient: user.email, recipientUserId: user.id, templateId: 'password-changed', payload: { name: user.name, occurredAt: changedAt }, createdAt: changedAt,
      });
      database.prepare("INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'account.password-reset', 'user', ?, '{}', ?)").run(user.id, user.id, changedAt);
    }).immediate();
    scheduleEmailProcessing();
    response.json({ message: 'Your password has been reset. Sign in with the new password.' });
  } catch (error) {
    if (error?.message === 'INVALID_RESET_TOKEN') {
      response.status(400).json({ message: 'This reset link is invalid or expired.' });
      return;
    }
    response.status(500).json({ message: 'Unable to reset the password right now.' });
  }
});

app.post('/api/auth/verify-email', authRateLimit, (request, response) => {
  try {
    const verifiedAt = new Date().toISOString();
    const userId = database.transaction(() => {
      const action = consumeActionToken(database, { token: request.body?.token, purpose: 'email-verification' });
      if (!action) throw new Error('INVALID_VERIFICATION_TOKEN');
      database.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ? WHERE id = ?').run(verifiedAt, verifiedAt, action.user_id);
      database.prepare("INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details_json, created_at) VALUES (?, 'account.email-verified', 'user', ?, '{}', ?)").run(action.user_id, action.user_id, verifiedAt);
      return action.user_id;
    }).immediate();
    response.json({ message: 'Your email address has been verified.', userId });
  } catch (error) {
    if (error?.message === 'INVALID_VERIFICATION_TOKEN') {
      response.status(400).json({ message: 'This verification link is invalid or expired.' });
      return;
    }
    response.status(500).json({ message: 'Unable to verify the email address right now.' });
  }
});

app.get('/api/auth/session', async (request, response) => {
  const authentication = await authService.authenticate(request);
  response.json({ user: authentication ? sanitizeAccount(authentication.account) : null });
});

app.post('/api/auth/logout', authService.requireAuth, async (request, response) => {
  await authService.logout(request);
  authService.clearSessionCookie(response);
  response.status(204).end();
});

app.get('/api/accounts', authService.requireAuth, async (request, response) => {
  const accounts = await readAccounts();
  const visibleAccounts = request.auth.account.role === 'admin'
    ? accounts
    : accounts.filter((account) => account.id === request.auth.account.id);
  response.json({ accounts: visibleAccounts.map(sanitizeAccount), updatedAt: new Date().toISOString() });
});

app.put('/api/accounts', authService.requireAuth, async (request, response) => {
  response.status(403).json({ message: 'Account snapshots are read-only. Use an authorized operation endpoint.' });
});

app.get('/api/admin-workspace', authService.requireAuth, authService.requireRole('admin'), async (_request, response) => {
  const result = await readAdminWorkspace();
  response.json(result);
});

app.put('/api/admin-workspace', authService.requireAuth, authService.requireRole('admin'), async (request, response) => {
  const { workspace } = request.body ?? {};

  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    response.status(400).json({ message: 'Workspace payload must be an object.' });
    return;
  }

  if (Object.hasOwn(workspace, 'adminWithdrawalRecords') || Object.hasOwn(workspace, 'adminUserRecords')) {
    response.status(400).json({ message: 'Account and withdrawal records must use authorized operation endpoints.' });
    return;
  }

  try {
    const updatedAt = await saveAdminWorkspace(workspace, request.body?.expectedUpdatedAt);
    broadcastEvent('admin-workspace');
    response.json({ ok: true, updatedAt });
  } catch (error) {
    if (error?.code === 'WORKSPACE_VERSION_REQUIRED') {
      response.status(400).json({ code: error.code, message: error.message });
      return;
    }
    if (error?.code === 'WORKSPACE_CONFLICT') {
      response.status(409).json({ code: error.code, message: error.message });
      return;
    }
    throw error;
  }
});

app.post('/api/transfers/internal', authService.requireAuth, async (request, response) => {
  try {
    const result = createInternalTransfer(database, {
      senderId: request.auth.account.id,
      sourceAccount: request.body?.sourceAccount,
      recipientAccountNumber: request.body?.accountNumber,
      amount: request.body?.amount,
      note: request.body?.note,
      idempotencyKey: request.get('Idempotency-Key'),
    });
    broadcastEvent('accounts');
    scheduleEmailProcessing();
    response.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof TransactionError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to complete the transfer right now.' });
  }
});

app.post('/api/admin/balance-adjustments', authService.requireAuth, authService.requireRole('admin'), async (request, response) => {
  try {
    const result = createAdminAdjustment(database, {
      adminId: request.auth.account.id,
      targetUserId: request.body?.targetUserId,
      accountLabel: request.body?.accountLabel,
      amount: request.body?.amount,
      note: request.body?.note,
      idempotencyKey: request.get('Idempotency-Key'),
    });
    broadcastEvent('accounts');
    scheduleEmailProcessing();
    response.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof TransactionError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to post the balance adjustment right now.' });
  }
});

app.patch('/api/admin/accounts/:userId/status', authService.requireAuth, authService.requireRole('admin'), (request, response) => {
  try {
    const result = updateAccountStatus(database, {
      adminId: request.auth.account.id,
      targetUserId: request.params.userId,
      status: request.body?.status,
      expectedUpdatedAt: request.body?.expectedUpdatedAt,
    });
    broadcastEvent('accounts');
    scheduleEmailProcessing();
    response.json(result);
  } catch (error) {
    if (error instanceof AccountManagementError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to update the account status right now.' });
  }
});

app.post('/api/admin/accounts/:userId/verify', authService.requireAuth, authService.requireRole('admin'), (request, response) => {
  try {
    const result = verifyAccount(database, {
      adminId: request.auth.account.id,
      targetUserId: request.params.userId,
      expectedUpdatedAt: request.body?.expectedUpdatedAt,
    });
    broadcastEvent('accounts');
    scheduleEmailProcessing();
    response.json(result);
  } catch (error) {
    if (error instanceof AccountManagementError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to verify the account right now.' });
  }
});

app.get('/api/admin/ownership', authService.requireAuth, authService.requireRole('admin'), (_request, response) => {
  response.json({ ownership: getOwnership(database), candidates: listOwnershipCandidates(database) });
});

app.post('/api/admin/ownership/claim', authService.requireAuth, authService.requireRole('admin'), async (request, response) => {
  try {
    const ownership = await claimOwnership(database, {
      actorUserId: request.auth.account.id,
      password: request.body?.password,
      confirmation: request.body?.confirmation,
      expectedVersion: request.body?.expectedVersion,
    });
    response.json({ ownership });
  } catch (error) {
    if (error instanceof OwnershipError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to claim platform ownership right now.' });
  }
});

app.post('/api/admin/ownership/transfer', authService.requireAuth, authService.requireRole('admin'), async (request, response) => {
  try {
    const ownership = await transferOwnership(database, {
      actorUserId: request.auth.account.id,
      targetUserId: request.body?.targetUserId,
      password: request.body?.password,
      confirmation: request.body?.confirmation,
      expectedVersion: request.body?.expectedVersion,
    });
    response.json({ ownership });
  } catch (error) {
    if (error instanceof OwnershipError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to transfer platform ownership right now.' });
  }
});

app.get('/api/withdrawals', authService.requireAuth, (request, response) => {
  const requesterId = request.auth.account.role === 'admin' ? null : request.auth.account.id;
  response.json({ withdrawals: listWithdrawals(database, { requesterId }), updatedAt: new Date().toISOString() });
});

app.post('/api/withdrawals', authService.requireAuth, async (request, response) => {
  try {
    const result = createWithdrawalRequest(database, {
      requesterId: request.auth.account.id,
      bankId: request.body?.bankId,
      amount: request.body?.amount,
      message: request.body?.message,
      idempotencyKey: request.get('Idempotency-Key'),
    });
    broadcastEvent('withdrawals');
    scheduleEmailProcessing();
    response.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    if (error instanceof WithdrawalError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to submit the withdrawal request right now.' });
  }
});

app.post('/api/admin/withdrawals/:withdrawalId/decision', authService.requireAuth, authService.requireRole('admin'), async (request, response) => {
  try {
    const result = await decideWithdrawal(database, {
      adminId: request.auth.account.id,
      withdrawalId: request.params.withdrawalId,
      decision: request.body?.decision,
      expectedUpdatedAt: request.body?.expectedUpdatedAt,
      note: request.body?.note,
    });
    broadcastEvent('withdrawals');
    broadcastEvent('accounts');
    scheduleEmailProcessing();
    response.json(result);
  } catch (error) {
    if (error instanceof WithdrawalError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to review the withdrawal right now.' });
  }
});

app.post('/api/withdrawals/:withdrawalId/code', authService.requireAuth, async (request, response) => {
  try {
    const result = await submitWithdrawalCode(database, {
      requesterId: request.auth.account.id,
      withdrawalId: request.params.withdrawalId,
      code: request.body?.code,
      expectedUpdatedAt: request.body?.expectedUpdatedAt,
    });
    broadcastEvent('withdrawals');
    broadcastEvent('accounts');
    scheduleEmailProcessing();
    response.json(result);
  } catch (error) {
    if (error instanceof WithdrawalError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to submit the withdrawal code right now.' });
  }
});

app.post('/api/withdrawals/:withdrawalId/expire', authService.requireAuth, (request, response) => {
  try {
    const result = expireWithdrawalReview(database, {
      requesterId: request.auth.account.id,
      withdrawalId: request.params.withdrawalId,
      expectedUpdatedAt: request.body?.expectedUpdatedAt,
    });
    broadcastEvent('withdrawals');
    broadcastEvent('accounts');
    scheduleEmailProcessing();
    response.json(result);
  } catch (error) {
    if (error instanceof WithdrawalError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to update the withdrawal review right now.' });
  }
});

function handleCommunicationError(response, error, fallbackMessage) {
  if (error instanceof CommunicationError) {
    response.status(error.status).json({ code: error.code, message: error.message });
    return;
  }
  response.status(500).json({ message: fallbackMessage });
}

app.post('/api/admin/communications/preview', authService.requireAuth, authService.requireRole('admin'), (request, response) => {
  try {
    response.json(previewCampaign(database, { actorUserId: request.auth.account.id, ...request.body }));
  } catch (error) {
    handleCommunicationError(response, error, 'Unable to preview this announcement right now.');
  }
});

app.post('/api/admin/communications', authService.requireAuth, authService.requireRole('admin'), (request, response) => {
  try {
    const result = createCampaign(database, {
      actorUserId: request.auth.account.id,
      idempotencyKey: request.get('Idempotency-Key'),
      ...request.body,
    });
    broadcastEvent('accounts');
    broadcastEvent('communications');
    scheduleEmailProcessing();
    response.status(result.replayed ? 200 : 202).json(result);
  } catch (error) {
    handleCommunicationError(response, error, 'Unable to queue this announcement right now.');
  }
});

app.get('/api/admin/communications', authService.requireAuth, authService.requireRole('admin'), (request, response) => {
  try {
    const campaigns = listCampaigns(database, { actorUserId: request.auth.account.id });
    const totals = database.prepare(`
      SELECT COUNT(*) attempted,
        SUM(CASE WHEN status IN ('pending', 'processing') THEN 1 ELSE 0 END) pending,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) accepted,
        SUM(CASE WHEN provider_status = 'delivered' THEN 1 ELSE 0 END) delivered,
        SUM(CASE WHEN status IN ('failed', 'suppressed') THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN provider_status = 'bounced' THEN 1 ELSE 0 END) bounced,
        SUM(CASE WHEN provider_status = 'complained' THEN 1 ELSE 0 END) complained
      FROM email_outbox
    `).get();
    response.json({ campaigns, totals, provider: { configured: emailProcessor.configured, mode: emailProcessor.mode } });
  } catch (error) {
    handleCommunicationError(response, error, 'Unable to load communication history right now.');
  }
});

app.post('/api/admin/communications/:campaignId/retry', authService.requireAuth, authService.requireRole('admin'), (request, response) => {
  try {
    const result = retryCampaign(database, { actorUserId: request.auth.account.id, campaignId: request.params.campaignId });
    scheduleEmailProcessing();
    response.json(result);
  } catch (error) {
    handleCommunicationError(response, error, 'Unable to retry failed deliveries right now.');
  }
});

app.use('/api/emails', authService.requireAuth, (_request, response) => {
  response.status(410).json({ message: 'Direct email endpoints were retired. Use the event-driven communication service.' });
});

app.get('/api/events', authService.requireAuth, (request, response) => {
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders?.();

  response.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  eventClients.add(response);

  request.on('close', () => {
    eventClients.delete(response);
  });
});

if (existsSync(distDir)) {
  app.use('/assets', express.static(path.join(distDir, 'assets'), {
    fallthrough: true,
    immutable: true,
    maxAge: '1y',
  }));
  app.use('/assets', (_request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(404).json({ message: 'Asset not found.' });
  });
  app.use(express.static(distDir, { index: false }));

  app.get(['/', '/reset-password', '/verify-email'], async (_request, response, next) => {
    try {
      const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
      response.setHeader('Cache-Control', 'no-store');
      response.type('html').send(indexHtml);
    } catch (error) {
      next(error);
    }
  });
}

export async function startServer() {
  await ensureAccountsFile();
  const server = app.listen(port, host, () => {
    console.log(`PNC app server running on http://${host}:${port}`);
  });
  const emailInterval = setInterval(() => void processEmailOutbox(), 30_000);
  emailInterval.unref();
  server.on('close', () => clearInterval(emailInterval));
  scheduleEmailProcessing();
  return server;
}

export { app };

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startServer();
}
