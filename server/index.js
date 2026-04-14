import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import nodemailer from 'nodemailer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const host = '0.0.0.0';
const dataDir = path.resolve(process.cwd(), 'server', 'data');
const accountsFile = path.join(dataDir, 'accounts.json');
const adminWorkspaceFile = path.join(dataDir, 'admin-workspace.json');
const distDir = path.resolve(process.cwd(), 'dist');
const eventClients = new Set();
let mailTransporter = null;

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
      issuedBy: 'PNC Demo Seed',
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

function getMailConfig() {
  const host = process.env.SMTP_HOST?.trim();
  const portValue = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.EMAIL_FROM?.trim() || user || 'no-reply@pnc.bank';
  const secure = String(process.env.SMTP_SECURE ?? '').toLowerCase() === 'true' || portValue === 465;

  if (!host || !portValue || !user || !pass) {
    return null;
  }

  return {
    host,
    port: portValue,
    secure,
    auth: {
      user,
      pass,
    },
    from,
  };
}

function getMailTransporter() {
  const config = getMailConfig();

  if (!config) {
    return null;
  }

  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth,
    });
  }

  return {
    transporter: mailTransporter,
    from: config.from,
  };
}

async function sendWelcomeEmail({ name, email, accountNumber }) {
  const mailer = getMailTransporter();

  if (!mailer) {
    return {
      ok: false,
      configured: false,
      message: 'Welcome email is not configured on the server.',
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

  await mailer.transporter.sendMail({
    from: mailer.from,
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

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, port });
});

app.get('/api/accounts', async (_request, response) => {
  const accounts = await readAccounts();
  response.json({ accounts, updatedAt: new Date().toISOString() });
});

app.put('/api/accounts', async (request, response) => {
  const { accounts } = request.body ?? {};

  if (!Array.isArray(accounts)) {
    response.status(400).json({ message: 'Accounts payload must be an array.' });
    return;
  }

  await saveAccounts(accounts);
  broadcastEvent('accounts');
  response.json({ ok: true, updatedAt: new Date().toISOString() });
});

app.get('/api/admin-workspace', async (_request, response) => {
  const workspace = await readAdminWorkspace();
  response.json({ workspace, updatedAt: new Date().toISOString() });
});

app.put('/api/admin-workspace', async (request, response) => {
  const { workspace } = request.body ?? {};

  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
    response.status(400).json({ message: 'Workspace payload must be an object.' });
    return;
  }

  await saveAdminWorkspace(workspace);
  broadcastEvent('admin-workspace');
  response.json({ ok: true, updatedAt: new Date().toISOString() });
});

app.post('/api/emails/welcome', async (request, response) => {
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
  app.use(express.static(distDir));

  app.get(/^(?!\/api).*/, async (_request, response, next) => {
    try {
      const indexHtml = await readFile(path.join(distDir, 'index.html'), 'utf8');
      response.type('html').send(indexHtml);
    } catch (error) {
      next(error);
    }
  });
}

ensureAccountsFile().then(() => {
  app.listen(port, host, () => {
    console.log(`PNC app server running on http://${host}:${port}`);
  });
});