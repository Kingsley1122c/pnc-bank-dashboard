import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { hashLegacyPassword } from './security.js';

const schemaFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'database', 'schema.sql');
const JSON_IMPORT_KEY = 'json-import-v1';

function isoNow() {
  return new Date().toISOString();
}

function toMinorUnits(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`Invalid non-negative amount: ${value}`);
  return Math.round(amount * 100);
}

function parseCurrencyAmount(value) {
  const text = String(value ?? '0');
  const negative = text.trim().startsWith('-');
  const amount = Number(text.replace(/[^0-9.]/g, ''));
  return { amountMinor: Number.isFinite(amount) ? Math.round(amount * 100) : 0, negative };
}

function sourceDigest(sources) {
  return createHash('sha256').update(sources.map((entry) => `${entry.name}\0${entry.content}`).join('\0')).digest('hex');
}

function validateAccounts(accounts) {
  if (!Array.isArray(accounts)) throw new Error('accounts.json must contain an array.');
  const ids = new Set();
  const emails = new Set();
  const accountNumbers = new Set();

  for (const account of accounts) {
    if (!account?.id || !account?.name || !account?.email || !account?.role) throw new Error('Every account requires id, name, email, and role.');
    const email = String(account.email).trim().toLowerCase();
    if (ids.has(account.id)) throw new Error(`Duplicate account id: ${account.id}`);
    if (emails.has(email)) throw new Error(`Duplicate account email: ${email}`);
    if (account.accountNumber && accountNumbers.has(account.accountNumber)) throw new Error(`Duplicate account number: ${account.accountNumber}`);
    ids.add(account.id);
    emails.add(email);
    if (account.accountNumber) accountNumbers.add(account.accountNumber);

    for (const balance of account.accounts ?? []) {
      toMinorUnits(balance.amount);
    }
  }
}

function validateWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) throw new Error('admin-workspace.json must contain an object.');
}

async function readJsonSource(name, filePath, fallback) {
  try {
    const content = await readFile(filePath, 'utf8');
    return { name, filePath, content, value: JSON.parse(content) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { name, filePath, content: JSON.stringify(fallback), value: fallback, missing: true };
    throw new Error(`Unable to read ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function backupSources(dataDir, sources) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDirectory = path.join(dataDir, 'backups', `json-import-${timestamp}`);
  await mkdir(backupDirectory, { recursive: true });

  for (const source of sources) {
    if (!source.missing) await copyFile(source.filePath, path.join(backupDirectory, source.name));
  }

  return backupDirectory;
}

function accountRawWithoutCollections(account) {
  const { accounts, notifications, savedBanks, issuedCards, password, passwordHash, ...raw } = account;
  return raw;
}

async function prepareAccounts(accounts) {
  return Promise.all(accounts.map(async (account) => ({
    account,
    passwordHash: account.passwordHash || await hashLegacyPassword(String(account.password ?? '')),
  })));
}

function insertImportedData(db, preparedAccounts, workspace, sessions, sources, digest, backupDirectory) {
  const now = isoNow();
  const insertUser = db.prepare(`
    INSERT INTO users (
      id, role, status, verification_status, name, email, phone, password_hash, segment, avatar,
      avatar_image, date_of_birth, gender, account_number, routing_number, raw_json, created_at, updated_at
    ) VALUES (
      @id, @role, @status, @verificationStatus, @name, @email, @phone, @passwordHash, @segment, @avatar,
      @avatarImage, @dateOfBirth, @gender, @accountNumber, @routingNumber, @rawJson, @createdAt, @updatedAt
    ) ON CONFLICT(id) DO UPDATE SET
      role = excluded.role, status = excluded.status, verification_status = excluded.verification_status,
      name = excluded.name, email = excluded.email, phone = excluded.phone, password_hash = excluded.password_hash,
      segment = excluded.segment, avatar = excluded.avatar, avatar_image = excluded.avatar_image,
      date_of_birth = excluded.date_of_birth, gender = excluded.gender, account_number = excluded.account_number,
      routing_number = excluded.routing_number, raw_json = excluded.raw_json, updated_at = excluded.updated_at
  `);
  const insertBalance = db.prepare(`
    INSERT INTO account_balances (user_id, label, currency, amount_minor, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, label, currency) DO UPDATE SET amount_minor = excluded.amount_minor, updated_at = excluded.updated_at
  `);
  const insertNotification = db.prepare(`
    INSERT INTO notifications (id, user_id, event_type, title, message, idempotency_key, created_at, read_at, metadata_json)
    VALUES (@id, @userId, @eventType, @title, @message, @idempotencyKey, @createdAt, @readAt, @metadataJson)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertSavedBank = db.prepare(`
    INSERT INTO saved_banks (id, user_id, bank_name, account_name, masked_account_number, raw_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `);
  const insertCard = db.prepare(`
    INSERT INTO issued_cards (id, user_id, request_id, status, card_mode, masked_number, issued_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `);
  const insertTransaction = db.prepare(`
    INSERT INTO transactions (
      id, initiator_user_id, recipient_user_id, type, status, amount_minor, currency, counterparty_name,
      reference, note, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `);

  for (const { account, passwordHash } of preparedAccounts) {
    insertUser.run({
      id: account.id,
      role: ['user', 'admin', 'owner'].includes(account.role) ? account.role : 'user',
      status: account.status ?? 'Active',
      verificationStatus: account.verificationStatus ?? 'Verified',
      name: account.name,
      email: String(account.email).trim().toLowerCase(),
      phone: account.phone || null,
      passwordHash,
      segment: account.segment || null,
      avatar: account.avatar || null,
      avatarImage: account.avatarImage || null,
      dateOfBirth: account.dateOfBirth || null,
      gender: account.gender || null,
      accountNumber: account.accountNumber || null,
      routingNumber: account.routingNumber || null,
      rawJson: JSON.stringify(accountRawWithoutCollections(account)),
      createdAt: account.createdAt || now,
      updatedAt: now,
    });

    for (const balance of account.accounts ?? []) insertBalance.run(account.id, balance.label, balance.currency ?? 'USD', toMinorUnits(balance.amount), now);
    for (const bank of account.savedBanks ?? []) insertSavedBank.run(bank.id, account.id, bank.bankName, bank.accountName, bank.accountNumber, JSON.stringify(bank));
    for (const card of account.issuedCards ?? []) insertCard.run(card.id, account.id, card.requestId ?? null, card.status ?? 'Active', card.cardMode ?? null, card.maskedNumber ?? null, card.issuedAt ?? null, JSON.stringify(card));
    for (const entry of account.notifications ?? []) {
      const notificationId = entry.id ?? `LEGACY-${account.id}-${createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16)}`;
      insertNotification.run({
        id: notificationId,
        userId: account.id,
        eventType: entry.type ?? 'account-update',
        title: entry.title ?? 'Account update',
        message: entry.message ?? '',
        idempotencyKey: `legacy-notification:${notificationId}`,
        createdAt: entry.createdAt ?? now,
        readAt: entry.readAt ?? null,
        metadataJson: JSON.stringify(entry),
      });
    }
  }

  const usersByName = new Map(preparedAccounts.map(({ account }) => [String(account.name).toLowerCase(), account.id]));
  for (const entry of workspace.adminTransactionRecords ?? []) {
    const parsed = parseCurrencyAmount(entry.amount);
    insertTransaction.run(
      entry.id,
      usersByName.get(String(entry.owner ?? '').toLowerCase()) ?? null,
      usersByName.get(String(entry.name ?? '').toLowerCase()) ?? null,
      entry.type ?? 'Legacy',
      entry.status ?? 'Completed',
      parsed.amountMinor,
      entry.name ?? null,
      entry.id,
      entry.note ?? null,
      JSON.stringify({ ...entry, legacyNegative: parsed.negative }),
      entry.createdAt ?? entry.date ?? now,
      now,
    );
  }

  const insertWithdrawal = db.prepare(`
    INSERT INTO withdrawal_requests (id, requester_user_id, amount_minor, currency, destination, status, requested_at, updated_at, raw_json)
    VALUES (?, ?, ?, 'USD', ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `);
  for (const entry of workspace.adminWithdrawalRecords ?? []) {
    insertWithdrawal.run(entry.id, entry.requesterId ?? null, parseCurrencyAmount(entry.amount).amountMinor, entry.destination ?? null, entry.status ?? 'Pending', entry.createdAt ?? entry.requested ?? now, now, JSON.stringify(entry));
  }

  const insertCardRequest = db.prepare(`
    INSERT INTO card_requests (id, requester_user_id, type, status, requested_at, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `);
  for (const entry of workspace.adminCardRecords ?? []) insertCardRequest.run(entry.id, entry.requesterId ?? null, entry.type ?? 'Card', entry.status ?? 'Pending', entry.createdAt ?? entry.requested ?? now, now, JSON.stringify(entry));

  const insertCase = db.prepare(`
    INSERT INTO cases (id, requester_user_id, type, subject, status, priority, assignee, created_at, updated_at, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `);
  for (const entry of workspace.adminCaseRecords ?? []) insertCase.run(entry.id, entry.requesterId ?? null, entry.type ?? 'Support', entry.subject ?? 'Account case', entry.status ?? 'Open', entry.priority ?? null, entry.assignee ?? null, entry.createdAt ?? now, now, JSON.stringify(entry));

  const insertAudit = db.prepare('INSERT INTO audit_logs (action, details_json, created_at) VALUES (?, ?, ?)');
  for (const entry of workspace.adminActivityRecords ?? []) insertAudit.run('legacy.admin.activity', JSON.stringify({ message: entry }), now);

  const insertSession = db.prepare(`
    INSERT INTO sessions (token_hash, user_id, role, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET expires_at = excluded.expires_at
  `);
  for (const [tokenHash, session] of Array.isArray(sessions.sessions) ? sessions.sessions : []) {
    if (preparedAccounts.some(({ account }) => account.id === session.userId)) insertSession.run(tokenHash, session.userId, session.role, session.createdAt, session.expiresAt);
  }

  db.prepare(`
    INSERT INTO admin_workspace_state (singleton_id, workspace_json, updated_at) VALUES (1, ?, ?)
    ON CONFLICT(singleton_id) DO UPDATE SET workspace_json = excluded.workspace_json, updated_at = excluded.updated_at
  `).run(JSON.stringify(workspace), now);

  for (const source of sources) {
    db.prepare(`
      INSERT INTO legacy_snapshots (source_name, source_digest, content_json, imported_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_name) DO UPDATE SET source_digest = excluded.source_digest, content_json = excluded.content_json, imported_at = excluded.imported_at
    `).run(source.name, createHash('sha256').update(source.content).digest('hex'), source.content, now);
  }

  db.prepare(`
    INSERT INTO migration_runs (migration_key, source_digest, status, backup_directory, details_json, started_at, completed_at)
    VALUES (?, ?, 'completed', ?, ?, ?, ?)
    ON CONFLICT(migration_key) DO UPDATE SET status = 'completed', completed_at = excluded.completed_at, details_json = excluded.details_json
  `).run(JSON_IMPORT_KEY, digest, backupDirectory, JSON.stringify({ users: preparedAccounts.length }), now, now);
}

function removeLegacyPhoneUniqueConstraint(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!/phone\s+TEXT\s+COLLATE\s+NOCASE\s+UNIQUE/i.test(table?.sql ?? '')) return;

  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (userCount !== 0) throw new Error('Cannot repair the legacy phone constraint after users have been imported.');

  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE users_rebuilt (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('user', 'admin', 'owner')),
        status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        phone TEXT COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        segment TEXT,
        avatar TEXT,
        avatar_image TEXT,
        date_of_birth TEXT,
        gender TEXT,
        account_number TEXT UNIQUE,
        routing_number TEXT,
        raw_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      DROP TABLE users;
      ALTER TABLE users_rebuilt RENAME TO users;
      CREATE INDEX idx_users_status_role ON users(status, role);
      COMMIT;
    `);
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

export async function initializeDatabase({ dataDir, databaseFile = path.join(dataDir, 'pnc-bank.sqlite'), allowEmptyImport = process.env.NODE_ENV !== 'production' }) {
  await mkdir(dataDir, { recursive: true });
  const schema = await readFile(schemaFile, 'utf8');
  const db = new Database(databaseFile);

  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    db.exec(schema);
    removeLegacyPhoneUniqueConstraint(db);
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(isoNow());
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(isoNow());

    const accountsSource = await readJsonSource('accounts.json', path.join(dataDir, 'accounts.json'), []);
    const workspaceSource = await readJsonSource('admin-workspace.json', path.join(dataDir, 'admin-workspace.json'), {});
    const sessionsSource = await readJsonSource('sessions.json', path.join(dataDir, 'sessions.json'), { sessions: [] });
    validateAccounts(accountsSource.value);
    validateWorkspace(workspaceSource.value);
    const sources = [accountsSource, workspaceSource, sessionsSource];
    const digest = sourceDigest(sources);
    const completed = db.prepare("SELECT source_digest FROM migration_runs WHERE migration_key = ? AND status = 'completed'").get(JSON_IMPORT_KEY);

    if (!completed) {
      if (accountsSource.missing && !allowEmptyImport) {
        throw new Error('Refusing to initialize a production database without accounts.json.');
      }
      const backupDirectory = await backupSources(dataDir, sources);
      const preparedAccounts = await prepareAccounts(accountsSource.value);
      db.transaction(() => insertImportedData(db, preparedAccounts, workspaceSource.value, sessionsSource.value, sources, digest, backupDirectory))();
    }

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function closeDatabase(db) {
  if (db?.open) db.close();
}

export function getMigrationStatus(db) {
  return db.prepare('SELECT * FROM migration_runs WHERE migration_key = ?').get(JSON_IMPORT_KEY) ?? null;
}

export function readDatabaseAccounts(db) {
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  const balances = db.prepare('SELECT * FROM account_balances ORDER BY user_id, rowid').all();
  const notifications = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all();
  const savedBanks = db.prepare('SELECT * FROM saved_banks ORDER BY rowid').all();
  const issuedCards = db.prepare('SELECT * FROM issued_cards ORDER BY rowid').all();
  const pendingTransfers = db.prepare(`
    SELECT pending_transfers.*, users.name AS sender_name
    FROM pending_transfers LEFT JOIN users ON users.id = pending_transfers.sender_user_id
    ORDER BY pending_transfers.created_at DESC
  `).all();

  return users.map((user) => {
    const raw = JSON.parse(user.raw_json);
    const databasePendingTransfers = pendingTransfers.filter((entry) => entry.recipient_user_id === user.id).map((entry) => ({
      id: entry.id,
      senderName: entry.sender_name ?? '',
      senderId: entry.sender_user_id,
      amountValue: entry.amount_minor / 100,
      transactionId: entry.transaction_id,
      createdAt: entry.created_at,
      ...JSON.parse(entry.raw_json),
    }));

    return {
    ...raw,
    id: user.id,
    role: user.role,
    status: user.status,
    verificationStatus: user.verification_status,
    updatedAt: user.updated_at,
    name: user.name,
    email: user.email,
    phone: user.phone ?? '',
    passwordHash: user.password_hash,
    segment: user.segment ?? '',
    avatar: user.avatar ?? '',
    avatarImage: user.avatar_image ?? '',
    dateOfBirth: user.date_of_birth ?? '',
    gender: user.gender ?? '',
    accountNumber: user.account_number ?? '',
    routingNumber: user.routing_number ?? '',
    accounts: balances.filter((entry) => entry.user_id === user.id).map((entry) => ({ label: entry.label, amount: entry.amount_minor / 100, currency: entry.currency })),
    notifications: notifications.filter((entry) => entry.user_id === user.id).map((entry) => ({ ...JSON.parse(entry.metadata_json), id: entry.id, type: entry.event_type, title: entry.title, message: entry.message, createdAt: entry.created_at, readAt: entry.read_at })),
    savedBanks: savedBanks.filter((entry) => entry.user_id === user.id).map((entry) => JSON.parse(entry.raw_json)),
    issuedCards: issuedCards.filter((entry) => entry.user_id === user.id).map((entry) => JSON.parse(entry.raw_json)),
    pendingIncomingTransfers: [...databasePendingTransfers, ...(raw.pendingIncomingTransfers ?? [])],
  };
  });
}

export async function databaseExists(databaseFile) {
  try {
    return (await stat(databaseFile)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function createDatabaseSessionStore(db) {
  return {
    delete(tokenHash) {
      return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash).changes > 0;
    },
    deleteExpired(now) {
      return db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(now).changes;
    },
    get(tokenHash) {
      const row = db.prepare('SELECT user_id, role, created_at, expires_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL').get(tokenHash);
      return row ? { userId: row.user_id, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at } : null;
    },
    set(tokenHash, session) {
      db.prepare(`
        INSERT INTO sessions (token_hash, user_id, role, created_at, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, role = excluded.role,
          created_at = excluded.created_at, expires_at = excluded.expires_at, revoked_at = NULL
      `).run(tokenHash, session.userId, session.role, session.createdAt, session.expiresAt);
    },
  };
}

export function updateDatabaseAccountPassword(db, userId, passwordHash) {
  const now = isoNow();
  const result = db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, now, userId);
  if (result.changes !== 1) throw new Error('Account does not exist.');
}

export function createDatabaseAccount(db, account) {
  const now = isoNow();
  const execute = db.transaction(() => {
    db.prepare(`
      INSERT INTO users (
        id, role, status, verification_status, name, email, phone, password_hash, segment, avatar,
        avatar_image, date_of_birth, gender, account_number, routing_number, raw_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      account.id, account.role, account.status, account.verificationStatus, account.name,
      String(account.email).trim().toLowerCase(), account.phone, account.passwordHash, account.segment ?? null,
      account.avatar ?? null, account.avatarImage ?? null, account.dateOfBirth ?? null, account.gender ?? null,
      account.accountNumber ?? null, account.routingNumber ?? null, JSON.stringify(accountRawWithoutCollections(account)), now, now,
    );
    const insertBalance = db.prepare('INSERT INTO account_balances (user_id, label, currency, amount_minor, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const balance of account.accounts ?? []) insertBalance.run(account.id, balance.label, balance.currency ?? 'USD', toMinorUnits(balance.amount), now);
  });
  execute.immediate();
  return readDatabaseAccounts(db).find((entry) => entry.id === account.id);
}

export function readDatabaseAdminWorkspace(db) {
  const row = db.prepare('SELECT workspace_json, updated_at FROM admin_workspace_state WHERE singleton_id = 1').get();
  return row ? { workspace: JSON.parse(row.workspace_json), updatedAt: row.updated_at } : { workspace: {}, updatedAt: null };
}

export function saveDatabaseAdminWorkspace(db, workspace, expectedUpdatedAt) {
  const expected = String(expectedUpdatedAt ?? '').trim();
  if (!expected) {
    const error = new Error('The workspace version is required. Refresh and try again.');
    error.code = 'WORKSPACE_VERSION_REQUIRED';
    throw error;
  }
  const now = isoNow();
  const updatedAt = now > expected ? now : new Date(Date.parse(expected) + 1).toISOString();
  const result = db.prepare(`
    UPDATE admin_workspace_state SET workspace_json = ?, updated_at = ?
    WHERE singleton_id = 1 AND updated_at = ?
  `).run(JSON.stringify(workspace), updatedAt, expected);
  if (result.changes !== 1) {
    const error = new Error('The admin workspace changed. Refresh and try again.');
    error.code = 'WORKSPACE_CONFLICT';
    throw error;
  }
  return updatedAt;
}