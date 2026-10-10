import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuthService } from './auth.js';
import { AccountManagementError, updateAccountStatus, verifyAccount } from './account-management.js';
import {
  createDatabaseAccount,
  createDatabaseSessionStore,
  initializeDatabase,
  readDatabaseAccounts,
  readDatabaseAdminWorkspace,
  saveDatabaseAdminWorkspace,
  updateDatabaseAccountPassword,
} from './database.js';
import { escapeHtml, hashPassword, isValidEmail, isValidEmailHeader, normalizeEmail, sanitizeAccount } from './security.js';
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
let nodemailerPromise;
let sendGridMailPromise;

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

function getEmailFromAddress() {
  return process.env.EMAIL_FROM?.trim() || 'no-reply@pnc.bank';
}

function getEmailMode() {
  const mode = String(process.env.EMAIL_MODE ?? 'disabled').trim().toLowerCase();
  return ['disabled', 'restricted', 'live'].includes(mode) ? mode : 'disabled';
}

function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, from: getEmailFromAddress() };
}

function getSmtpConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();

  if (!host || !user || !pass) {
    return null;
  }

  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: String(process.env.SMTP_SECURE ?? 'false').toLowerCase() === 'true',
    user,
    pass,
    from: getEmailFromAddress(),
  };
}

function getSendGridConfig() {
  const apiKey = process.env.SENDGRID_API_KEY?.trim();
  const from = getEmailFromAddress();
  if (!apiKey) return null;
  return { apiKey, from };
}

async function getNodemailer() {
  if (!nodemailerPromise) {
    nodemailerPromise = import('nodemailer')
      .then((module) => module.default ?? module)
      .catch((error) => {
        if (error?.code === 'ERR_MODULE_NOT_FOUND') {
          return null;
        }

        throw error;
      });
  }

  return nodemailerPromise;
}

async function getSendGridMail() {
  if (!sendGridMailPromise) {
    sendGridMailPromise = import('@sendgrid/mail')
      .then((module) => module.default ?? module)
      .catch((error) => {
        if (error?.code === 'ERR_MODULE_NOT_FOUND') {
          return null;
        }

        throw error;
      });
  }

  return sendGridMailPromise;
}

async function getSendGridClient() {
  const config = getSendGridConfig();
  if (!config) return null;

  const sgMail = await getSendGridMail();
  if (!sgMail) return null;

  sgMail.setApiKey(config.apiKey);
  return { sgMail, from: config.from };
}

async function getMailClient() {
  const mode = getEmailMode();
  if (mode === 'disabled') return null;

  const replyTo = process.env.EMAIL_REPLY_TO?.trim();
  const testRecipient = normalizeEmail(process.env.EMAIL_TEST_RECIPIENT);
  const restrictSend = (send) => async (message) => {
    if (mode === 'restricted' && (!testRecipient || normalizeEmail(message.to) !== testRecipient)) {
      throw new Error('Restricted email recipient rejected.');
    }
    return send(replyTo ? { ...message, replyTo } : message);
  };
  const resendConfig = getResendConfig();

  if (resendConfig) {
    return {
      from: resendConfig.from,
      send: restrictSend(async (message) => {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: resendConfig.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
            ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          }),
        });
        if (!response.ok) throw new Error('Resend delivery failed.');
        return response.json();
      }),
    };
  }

  const smtpConfig = getSmtpConfig();

  if (smtpConfig) {
    const nodemailer = await getNodemailer();

    if (nodemailer) {
      const transporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        auth: {
          user: smtpConfig.user,
          pass: smtpConfig.pass,
        },
      });

      return {
        from: smtpConfig.from,
        send: restrictSend((message) => transporter.sendMail({
          from: smtpConfig.from,
          ...message,
        })),
      };
    }
  }

  const sendGridClient = await getSendGridClient();
  if (!sendGridClient) {
    return null;
  }

  return {
    from: sendGridClient.from,
    send: restrictSend((message) => sendGridClient.sgMail.send({
      from: sendGridClient.from,
      ...message,
    })),
  };
}

async function sendWelcomeEmail({ name, email, accountNumber }) {
  const mailer = await getMailClient();
  if (!mailer) {
    return {
      ok: false,
      configured: false,
      message: 'Email provider is not configured on the server.',
    };
  }

  const formattedAccountNumber = formatAccountNumber(accountNumber);
  const safeName = escapeHtml(name);
  const safeAccountNumber = escapeHtml(formattedAccountNumber);
  const subject = 'Welcome to PNC Bank';
  const text = [
    `Hello ${name},`,
    '',
    'Your PNC Bank account has been created successfully.',
    `Account number: ${formattedAccountNumber}`,
    'Routing number: 031100089',
    '',
    'Your account may require verification before certain incoming transfers can be released.',
    'If you need help, contact customer support.',
    '',
    'PNC Bank',
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">
      <h2 style="margin-bottom: 12px;">Welcome to PNC Bank</h2>
      <p>Hello ${safeName},</p>
      <p>Your PNC Bank account has been created successfully.</p>
      <p><strong>Account number:</strong> ${safeAccountNumber}<br /><strong>Routing number:</strong> 031100089</p>
      <p>Your account may require verification before certain incoming transfers can be released.</p>
      <p>If you need help, contact customer support.</p>
      <p style="margin-top: 24px;">PNC Bank</p>
    </div>
  `;

  await mailer.send({
    to: email,
    subject,
    text,
    html,
  });

  return {
    ok: true,
    configured: true,
    message: `Welcome email sent to ${email}.`,
  };
}

async function sendTransferReceivedEmail({ name, email, amount, fromAccount, toAccount, transferDate }) {
  const mailer = await getMailClient();
  if (!mailer) {
    return {
      ok: false,
      configured: false,
      message: 'Email provider is not configured on the server.',
    };
  }

  const subject = 'You have received a transfer';
  const safeName = escapeHtml(name);
  const safeAmount = escapeHtml(amount);
  const safeFromAccount = escapeHtml(fromAccount);
  const safeToAccount = escapeHtml(toAccount);
  const safeTransferDate = escapeHtml(transferDate);
  const text = [
    `Hello ${name},`,
    '',
    `You have received a transfer of $${amount} to your account (${toAccount}).`,
    fromAccount ? `From: ${fromAccount}` : '',
    transferDate ? `Date: ${transferDate}` : '',
    '',
    'If you have any questions, contact customer support.',
    '',
    'PNC Bank',
  ].filter(Boolean).join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">
      <h2 style="margin-bottom: 12px;">You have received a transfer</h2>
      <p>Hello ${safeName},</p>
      <p>You have received a transfer of <strong>$${safeAmount}</strong> to your account (<strong>${safeToAccount}</strong>).</p>
      ${fromAccount ? `<p><strong>From:</strong> ${safeFromAccount}</p>` : ''}
      ${transferDate ? `<p><strong>Date:</strong> ${safeTransferDate}</p>` : ''}
      <p>If you have any questions, contact customer support.</p>
      <p style="margin-top: 24px;">PNC Bank</p>
    </div>
  `;

  await mailer.send({
    to: email,
    subject,
    text,
    html,
  });

  return {
    ok: true,
    configured: true,
    message: `Transfer received email sent to ${email}.`,
  };
}

async function sendImportantMessageEmail({ name, email, subject, message }) {
  const mailer = await getMailClient();
  if (!mailer) {
    return {
      ok: false,
      configured: false,
      message: 'Email provider is not configured on the server.',
    };
  }

  const emailSubject = subject || 'Important message from PNC Bank';
  const safeSubject = escapeHtml(emailSubject);
  const safeName = escapeHtml(name);
  const safeMessage = escapeHtml(message).replaceAll('\n', '<br />');
  const text = [
    `Hello ${name},`,
    '',
    message,
    '',
    'If you have any questions, contact customer support.',
    '',
    'PNC Bank',
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">
      <h2 style="margin-bottom: 12px;">${safeSubject}</h2>
      <p>Hello ${safeName},</p>
      <p>${safeMessage}</p>
      <p>If you have any questions, contact customer support.</p>
      <p style="margin-top: 24px;">PNC Bank</p>
    </div>
  `;

  await mailer.send({
    to: email,
    subject: emailSubject,
    text,
    html,
  });

  return {
    ok: true,
    configured: true,
    message: `Important message email sent to ${email}.`,
  };
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
const authService = createAuthService({
  sessionsFile,
  sessionStore: createDatabaseSessionStore(database),
  readAccounts,
  saveAccounts: async () => {},
  migrateAccountPassword: (userId, passwordHash) => updateDatabaseAccountPassword(database, userId, passwordHash),
  secureCookies: getAppBaseUrl().startsWith('https://') || process.env.NODE_ENV === 'production',
});
const authRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 20 });
const emailRateLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 30 });
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

    createDatabaseAccount(database, newAccount);
    const loginResult = await authService.login(normalizedEmailAddress, password);
    authService.setSessionCookie(response, loginResult.token);

    let emailQueued = false;
    try {
      const emailResult = await sendWelcomeEmail({ name: newAccount.name, email: newAccount.email, accountNumber });
      emailQueued = emailResult.ok;
    } catch {
      emailQueued = false;
    }

    broadcastEvent('accounts');
    response.status(201).json({ user: sanitizeAccount(newAccount), emailQueued });
  } catch {
    response.status(500).json({ message: 'Unable to create the account right now.' });
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
    response.json(result);
  } catch (error) {
    if (error instanceof WithdrawalError) {
      response.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    response.status(500).json({ message: 'Unable to update the withdrawal review right now.' });
  }
});

app.post('/api/emails/welcome', emailRateLimit, authService.requireAuth, authService.requireRole('admin'), async (request, response) => {
  const { name, email, accountNumber } = request.body ?? {};

  if (!isValidEmailHeader(name, 120) || !isValidEmail(email) || !/^\d{10}$/.test(String(accountNumber ?? '').replace(/\D/g, ''))) {
    response.status(400).json({ ok: false, message: 'Enter a valid name, email, and 10-digit account number.' });
    return;
  }

  try {
    const result = await sendWelcomeEmail({ name, email, accountNumber });

    if (!result.ok && result.configured === false) {
      response.status(503).json(result);
      return;
    }

    response.json(result);
  } catch {
    response.status(500).json({
      ok: false,
      configured: true,
      message: 'Failed to send welcome email.',
    });
  }
});

app.post('/api/emails/transfer-received', emailRateLimit, authService.requireAuth, authService.requireRole('admin'), async (request, response) => {
  const { name, email, amount, fromAccount, toAccount, transferDate } = request.body ?? {};

  if (!isValidEmailHeader(name, 120) || !isValidEmail(email) || !/^\d+(?:\.\d{1,2})?$/.test(String(amount ?? '')) || !isValidEmailHeader(toAccount, 120)) {
    response.status(400).json({ ok: false, message: 'Enter valid transfer email details.' });
    return;
  }

  try {
    const result = await sendTransferReceivedEmail({ name, email, amount, fromAccount, toAccount, transferDate });

    if (!result.ok && result.configured === false) {
      response.status(503).json(result);
      return;
    }

    response.json(result);
  } catch {
    response.status(500).json({
      ok: false,
      configured: true,
      message: 'Failed to send transfer received email.',
    });
  }
});

app.post('/api/emails/important-message', emailRateLimit, authService.requireAuth, async (request, response) => {
  const { name, email, subject, message } = request.body ?? {};

  const normalizedSubject = subject || 'Important message from PNC Bank';
  if (!isValidEmailHeader(name, 120) || !isValidEmail(email) || !isValidEmailHeader(normalizedSubject) || !String(message ?? '').trim() || String(message).length > 5000) {
    response.status(400).json({ ok: false, message: 'Enter a valid name, email, subject, and message.' });
    return;
  }

  const isAdmin = request.auth.account.role === 'admin';
  const isOwnAddress = normalizeEmail(request.auth.account.email) === normalizeEmail(email);
  if (!isAdmin && !isOwnAddress) {
    response.status(403).json({ ok: false, message: 'You are not authorized to send this message.' });
    return;
  }

  try {
    const result = await sendImportantMessageEmail({ name, email, subject, message });

    if (!result.ok && result.configured === false) {
      response.status(503).json(result);
      return;
    }

    response.json(result);
  } catch {
    response.status(500).json({
      ok: false,
      configured: true,
      message: 'Failed to send important message email.',
    });
  }
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

  app.get(/^(?!\/api|\/assets).*/, async (_request, response, next) => {
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
  return app.listen(port, host, () => {
    console.log(`PNC app server running on http://${host}:${port}`);
  });
}

export { app };

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  startServer();
}
