import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (db) return db
  const dataDir = process.env.DATA_DIR || '.data'
  mkdirSync(dataDir, { recursive: true })
  db = new DatabaseSync(join(dataDir, 'aiusageatlas.db'))
  db.exec('PRAGMA journal_mode = WAL;')
  migrate(db)
  // 轻量列迁移：老库补 icon 列
  try {
    db.exec(`ALTER TABLE provider ADD COLUMN icon TEXT DEFAULT ''`)
  } catch {
    /* 列已存在 */
  }
  return db
}

function migrate(d: DatabaseSync) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS provider (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    category TEXT NOT NULL,
    icon TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS account_profile (
    provider_id TEXT PRIMARY KEY,
    user_name TEXT DEFAULT '',
    masked_contact TEXT DEFAULT '',
    region TEXT DEFAULT '',
    avatar_text TEXT DEFAULT '',
    joined_at TEXT
  );
  CREATE TABLE IF NOT EXISTS subscription (
    provider_id TEXT NOT NULL,
    plan_name TEXT NOT NULL,
    plan_id TEXT DEFAULT '',
    billing_mode TEXT DEFAULT 'subscription',
    price REAL DEFAULT 0,
    currency TEXT DEFAULT 'CNY',
    renewal_date TEXT,
    auto_renew INTEGER DEFAULT 0,
    starts_at TEXT,
    expires_at TEXT,
    PRIMARY KEY (provider_id, plan_name)
  );
  CREATE TABLE IF NOT EXISTS quota_window (
    provider_id TEXT NOT NULL,
    plan_name TEXT NOT NULL,
    name TEXT NOT NULL,
    used_pct REAL DEFAULT 0,
    used_value REAL,
    limit_value REAL,
    unit TEXT DEFAULT 'pct',
    reset_at TEXT,
    extra_usage_enabled INTEGER DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider_id, plan_name, name)
  );
  CREATE TABLE IF NOT EXISTS usage_daily (
    provider_id TEXT NOT NULL,
    plan_name TEXT NOT NULL,
    date TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_tokens INTEGER DEFAULT 0,
    requests INTEGER DEFAULT 0,
    cost_amount REAL DEFAULT 0,
    cost_currency TEXT DEFAULT 'CNY',
    source TEXT DEFAULT 'scrape',
    PRIMARY KEY (provider_id, plan_name, date)
  );
  CREATE TABLE IF NOT EXISTS usage_model_daily (
    provider_id TEXT NOT NULL,
    date TEXT NOT NULL,
    model_id TEXT NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cached_tokens INTEGER DEFAULT 0,
    thinking_tokens INTEGER DEFAULT 0,
    requests INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    PRIMARY KEY (provider_id, date, model_id)
  );
  CREATE TABLE IF NOT EXISTS balance_snapshot (
    provider_id TEXT NOT NULL,
    date TEXT NOT NULL,
    balance REAL DEFAULT 0,
    currency TEXT DEFAULT 'CNY',
    recharged_amount REAL DEFAULT 0,
    PRIMARY KEY (provider_id, date)
  );
  CREATE TABLE IF NOT EXISTS credential (
    provider_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_enc TEXT DEFAULT '',
    expires_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider_id, kind)
  );
  CREATE TABLE IF NOT EXISTS sync_config (
    provider_id TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1,
    interval_sec INTEGER DEFAULT 3600,
    jitter_sec INTEGER DEFAULT 300,
    timeout_sec INTEGER DEFAULT 60
  );
  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL,
    duration_ms INTEGER DEFAULT 0,
    error_type TEXT,
    error_msg TEXT
  );
  CREATE TABLE IF NOT EXISTS alert_rule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    threshold REAL NOT NULL,
    enabled INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS model_price (
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    source TEXT DEFAULT 'litellm',
    currency TEXT DEFAULT 'USD',
    input_per_m REAL DEFAULT 0,
    output_per_m REAL DEFAULT 0,
    cached_read_per_m REAL DEFAULT 0,
    cached_write_per_m REAL DEFAULT 0,
    context_window INTEGER DEFAULT 0,
    effective_from TEXT NOT NULL DEFAULT (date('now')),
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (provider_id, model_id, effective_from)
  );
  CREATE TABLE IF NOT EXISTS api_token (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `)
}
