PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_runs (
  migration_key TEXT PRIMARY KEY,
  source_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  backup_directory TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS legacy_snapshots (
  source_name TEXT PRIMARY KEY,
  source_digest TEXT NOT NULL,
  content_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin', 'owner')),
  status TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  phone TEXT COLLATE NOCASE UNIQUE,
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

CREATE TABLE IF NOT EXISTS account_balances (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, label, currency)
);

CREATE TABLE IF NOT EXISTS saved_banks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  masked_account_number TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS issued_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT,
  status TEXT NOT NULL,
  card_mode TEXT,
  masked_number TEXT,
  issued_at TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  initiator_user_id TEXT REFERENCES users(id),
  recipient_user_id TEXT REFERENCES users(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (length(currency) = 3),
  source_account_label TEXT,
  destination_account_label TEXT,
  counterparty_name TEXT,
  reference TEXT NOT NULL,
  note TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_transfers (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id),
  sender_user_id TEXT REFERENCES users(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  created_at TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  read_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id TEXT PRIMARY KEY,
  requester_user_id TEXT REFERENCES users(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  destination TEXT,
  status TEXT NOT NULL,
  approval_code_hash TEXT,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS card_requests (
  id TEXT PRIMARY KEY,
  requester_user_id TEXT REFERENCES users(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  requester_user_id TEXT REFERENCES users(id),
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  assignee TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  aggregate_type TEXT,
  aggregate_id TEXT,
  recipient TEXT NOT NULL,
  template_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'accepted', 'delivered', 'failed', 'suppressed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS platform_ownership (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  owner_user_id TEXT REFERENCES users(id),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_workspace_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  workspace_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
CREATE INDEX IF NOT EXISTS idx_balances_user ON account_balances(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_initiator_created ON transactions(initiator_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_recipient_created ON transactions(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawals_requester_status ON withdrawal_requests(requester_user_id, status);
CREATE INDEX IF NOT EXISTS idx_card_requests_requester_status ON card_requests(requester_user_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_expires ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_status_created ON email_outbox(status, created_at);

INSERT OR IGNORE INTO platform_ownership (singleton_id, owner_user_id, version, updated_at)
VALUES (1, NULL, 0, datetime('now'));