import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuthService } from './auth.js';
import { hashPassword, isValidEmail, normalizeEmail, sanitizeAccount } from './security.js';

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
        send: (message) => transporter.sendMail({
          from: smtpConfig.from,
          ...message,
        }),
      };
    }
  }

  const sendGridClient = await getSendGridClient();
  if (!sendGridClient) {
    return null;
  }

  return {
    from: sendGridClient.from,
    send: (message) => sendGridClient.sgMail.send({
      from: sendGridClient.from,
      ...message,
    }),
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
      <p>Hello ${name},</p>
      <p>Your PNC Bank account has been created successfully.</p>
      <p><strong>Account number:</strong> ${formattedAccountNumber}<br /><strong>Routing number:</strong> 031100089</p>
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
      <p>Hello ${name},</p>
      <p>You have received a transfer of <strong>$${amount}</strong> to your account (<strong>${toAccount}</strong>).</p>
      ${fromAccount ? `<p><strong>From:</strong> ${fromAccount}</p>` : ''}
      ${transferDate ? `<p><strong>Date:</strong> ${transferDate}</p>` : ''}
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
      <h2 style="margin-bottom: 12px;">${emailSubject}</h2>
      <p>Hello ${name},</p>
      <p>${message}</p>
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
  await ensureAccountsFile();

  try {
    const content = await readFile(accountsFile, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed.map(normalizeStoredAccount) : defaultAccounts.map(normalizeStoredAccount);
  } catch {
    return defaultAccounts.map(normalizeStoredAccount);
  }
}

async function saveAccounts(accounts) {
  await ensureAccountsFile();
  await writeFile(accountsFile, JSON.stringify(accounts, null, 2), 'utf8');
}

async function readAdminWorkspace() {
  await ensureAccountsFile();

  try {
    const content = await readFile(adminWorkspaceFile, 'utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveAdminWorkspace(workspace) {
  await ensureAccountsFile();
  await writeFile(adminWorkspaceFile, JSON.stringify(workspace, null, 2), 'utf8');
}

const authService = createAuthService({
  sessionsFile,
  readAccounts,
  saveAccounts,
  secureCookies: getAppBaseUrl().startsWith('https://') || process.env.NODE_ENV === 'production',
});
const authRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 20 });
const emailRateLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 30 });
const allowedOrigins = getAllowedOrigins();

app.disable('x-powered-by');
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ''))) {
      callback(null, true);
      return;
    }

    callback(new Error('Origin is not allowed by CORS.'));
  },
}));
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

    await saveAccounts([...accounts, newAccount]);
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

app.get('/api/accounts', authService.requireAuth, async (_request, response) => {
  const accounts = await readAccounts();
  response.json({ accounts: accounts.map(sanitizeAccount), updatedAt: new Date().toISOString() });
});

app.put('/api/accounts', authService.requireAuth, async (request, response) => {
  const { accounts } = request.body ?? {};

  if (!Array.isArray(accounts)) {
    response.status(400).json({ message: 'Accounts payload must be an array.' });
    return;
  }

  const storedAccounts = await readAccounts();
  const storedById = new Map(storedAccounts.map((account) => [account.id, account]));
  const mergedAccounts = accounts.map((account) => {
    const storedAccount = storedById.get(account.id);
    const safeAccount = sanitizeAccount(account);

    if (!storedAccount) {
      return safeAccount;
    }

    return {
      ...safeAccount,
      ...(storedAccount.passwordHash ? { passwordHash: storedAccount.passwordHash } : {}),
      ...(!storedAccount.passwordHash && storedAccount.password ? { password: storedAccount.password } : {}),
    };
  });

  await saveAccounts(mergedAccounts);
  broadcastEvent('accounts');
  response.json({ ok: true, updatedAt: new Date().toISOString() });
});

app.get('/api/admin-workspace', authService.requireAuth, async (_request, response) => {
  const workspace = await readAdminWorkspace();
  response.json({ workspace, updatedAt: new Date().toISOString() });
});

app.put('/api/admin-workspace', authService.requireAuth, async (request, response) => {
  const { workspace } = request.body ?? {};

  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    response.status(400).json({ message: 'Workspace payload must be an object.' });
    return;
  }

  await saveAdminWorkspace(workspace);
  broadcastEvent('admin-workspace');
  response.json({ ok: true, updatedAt: new Date().toISOString() });
});

app.post('/api/emails/welcome', emailRateLimit, authService.requireAuth, authService.requireRole('admin'), async (request, response) => {
  const { name, email, accountNumber } = request.body ?? {};

  if (!name || !email || !accountNumber) {
    response.status(400).json({ ok: false, message: 'Name, email, and account number are required.' });
    return;
  }

  try {
    const result = await sendWelcomeEmail({ name, email, accountNumber });

    if (!result.ok && result.configured === false) {
      response.status(503).json(result);
      return;
    }

    response.json(result);
  } catch (error) {
    response.status(500).json({
      ok: false,
      configured: true,
      message: error instanceof Error ? error.message : 'Failed to send welcome email.',
    });
  }
});

app.post('/api/emails/transfer-received', emailRateLimit, authService.requireAuth, authService.requireRole('admin'), async (request, response) => {
  const { name, email, amount, fromAccount, toAccount, transferDate } = request.body ?? {};

  if (!name || !email || !amount || !toAccount) {
    response.status(400).json({ ok: false, message: 'Name, email, amount, and toAccount are required.' });
    return;
  }

  try {
    const result = await sendTransferReceivedEmail({ name, email, amount, fromAccount, toAccount, transferDate });

    if (!result.ok && result.configured === false) {
      response.status(503).json(result);
      return;
    }

    response.json(result);
  } catch (error) {
    response.status(500).json({
      ok: false,
      configured: true,
      message: error instanceof Error ? error.message : 'Failed to send transfer received email.',
    });
  }
});

app.post('/api/emails/important-message', emailRateLimit, authService.requireAuth, async (request, response) => {
  const { name, email, subject, message } = request.body ?? {};

  if (!name || !email || !message) {
    response.status(400).json({ ok: false, message: 'Name, email, and message are required.' });
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
  } catch (error) {
    response.status(500).json({
      ok: false,
      configured: true,
      message: error instanceof Error ? error.message : 'Failed to send important message email.',
    });
  }
});

app.get('/api/events', (request, response) => {
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
    fallthrough: false,
    immutable: true,
    maxAge: '1y',
  }));
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
