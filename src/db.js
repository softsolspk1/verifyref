// db.js - PostgreSQL storage (Neon). All helpers are async.
const { Pool } = require('pg');
require('./config');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Add your PostgreSQL connection string to .env');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '8', 10),
  idleTimeoutMillis: 30000
});
pool.on('error', err => console.error('PostgreSQL pool error:', err.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',          -- editor | admin
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | approved | rejected | disabled
  journal TEXT,
  editor_role TEXT,
  orcid TEXT,
  co_editors TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issue_id INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,                    -- manuscript | references | citations | reviewer-report
  manuscript_code TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT,
  ref_total INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  suspicious INTEGER DEFAULT 0,
  unverified INTEGER DEFAULT 0,
  miscited INTEGER DEFAULT 0,
  retracted INTEGER DEFAULT 0,
  missing_citations INTEGER DEFAULT 0,
  uncited_references INTEGER DEFAULT 0,
  journal_flags INTEGER DEFAULT 0,
  self_citation_rate REAL DEFAULT 0,
  problems JSONB,
  result JSONB,                          -- full result (NULL when saved as "counts only")
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checks_user ON checks(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_checks_ms ON checks(user_id, manuscript_code, version);

CREATE TABLE IF NOT EXISTS retractions (
  doi TEXT PRIMARY KEY,
  retraction_doi TEXT,
  retraction_date TEXT,
  nature TEXT,
  reason TEXT,
  title TEXT,
  journal TEXT,
  journal_norm TEXT
);
CREATE INDEX IF NOT EXISTS idx_retractions_journal ON retractions(journal_norm);

CREATE TABLE IF NOT EXISTS predatory (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                    -- publisher | journal | hijacked
  name TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  url TEXT,
  domain TEXT,
  genuine_url TEXT,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_predatory_name ON predatory(name_norm);
CREATE INDEX IF NOT EXISTS idx_predatory_domain ON predatory(domain);

CREATE TABLE IF NOT EXISTS journal_lists (
  list_type TEXT PRIMARY KEY,
  filename TEXT,
  row_count INTEGER,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_list_entries (
  list_type TEXT NOT NULL,
  issn TEXT,
  eissn TEXT,
  title TEXT,
  title_norm TEXT,
  data JSONB
);
CREATE INDEX IF NOT EXISTS idx_jle_issn ON journal_list_entries(list_type, issn);
CREATE INDEX IF NOT EXISTS idx_jle_eissn ON journal_list_entries(list_type, eissn);
CREATE INDEX IF NOT EXISTS idx_jle_title ON journal_list_entries(list_type, title_norm);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value JSONB,
  expires_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
`;

let ready = null;
function init() {
  if (!ready) ready = pool.query(SCHEMA).then(() => true);
  return ready;
}

async function query(sql, params = []) {
  await init();
  return pool.query(sql, params);
}
async function one(sql, params) {
  const r = await query(sql, params);
  return r.rows[0] || null;
}
async function all(sql, params) {
  const r = await query(sql, params);
  return r.rows;
}

/** Run fn(client) inside a transaction */
async function transaction(fn) {
  await init();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function getMeta(key) {
  const row = await one('SELECT value FROM meta WHERE key = $1', [key]);
  return row ? row.value : null;
}
async function setMeta(key, value) {
  await query('INSERT INTO meta(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value', [key, String(value)]);
}

/**
 * Fast bulk insert using unnest() — columns: [{name, type}], rows: array of arrays.
 * Sends rows in chunks to stay below parameter/packet limits.
 */
async function bulkInsert(client, table, columns, rows, chunk = 5000) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const arrays = columns.map((_, ci) => part.map(r => (r[ci] === undefined ? null : r[ci])));
    const sql = `INSERT INTO ${table}(${columns.map(c => c.name).join(', ')})
      SELECT * FROM unnest(${columns.map((c, ci) => `$${ci + 1}::${c.type}[]`).join(', ')})`;
    await client.query(sql, arrays);
  }
}

module.exports = { pool, init, query, one, all, transaction, getMeta, setMeta, bulkInsert };
