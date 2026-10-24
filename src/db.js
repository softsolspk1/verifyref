// db.js - PostgreSQL storage. Server/web: node-postgres pool (Neon, Supabase…). Desktop: embedded PGlite
// (PostgreSQL compiled to WebAssembly) in the user's profile folder, so both editions share one schema and one SQL dialect.
require('./config');

const EMBEDDED = !!process.env.PGLITE_DIR;

let pool = null;   // pg.Pool (server)
let lite = null;   // PGlite instance (desktop)

if (EMBEDDED) {
  const { PGlite } = require('@electric-sql/pglite');
  lite = new PGlite(process.env.PGLITE_DIR);
} else {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Add your PostgreSQL connection string to .env');
  }
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX || (process.env.VERCEL ? '5' : '8'), 10),
    idleTimeoutMillis: 30000
  });
  pool.on('error', err => console.error('PostgreSQL pool error:', err.message));
  // On Vercel, close idle connections before an instance is suspended
  try { require('@vercel/functions').attachDatabasePool(pool); } catch (e) { /* not on Vercel */ }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',          -- super_admin | editor | researcher
  status TEXT NOT NULL DEFAULT 'active',        -- active | suspended
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
  kind TEXT NOT NULL,                    -- manuscript | references | citations | reviewer-report | restyle | verify | evidence | format | journal-finder | conferences | assistant | authors
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

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  input JSONB,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | running | done | error
  progress INTEGER NOT NULL DEFAULT 0,
  step TEXT,
  result JSONB,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  heartbeat TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

-- Super Admin user management (v3)
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions JSONB;              -- module keys; NULL = role defaults
ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_web BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS allow_desktop BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS offline_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS remote_id INTEGER;             -- desktop: id of this user on the web platform
ALTER TABLE users ADD COLUMN IF NOT EXISTS offline_until TIMESTAMPTZ;     -- desktop: offline sign-in allowed until
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_alerts BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE checks ADD COLUMN IF NOT EXISTS uid TEXT;                     -- stable id shared by web and desktop copies
ALTER TABLE checks ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'web';
ALTER TABLE checks ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;
ALTER TABLE checks ADD COLUMN IF NOT EXISTS pending_online INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checks ALTER COLUMN uid SET DEFAULT md5(random()::text || clock_timestamp()::text);
UPDATE checks SET uid = md5(id::text || random()::text || clock_timestamp()::text) WHERE uid IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_checks_uid ON checks(uid);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER,
  actor_email TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details JSONB,
  ip TEXT,
  channel TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  app_version TEXT,
  revoked BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS follows (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- author | topic | conference | citations
  key TEXT NOT NULL,                     -- OpenAlex author/source id, topic text, ORCID
  label TEXT,
  state JSONB,
  last_checked TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, kind, key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- retraction | citation | topic | author | conference | queue | system
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  data JSONB,
  read BOOLEAN NOT NULL DEFAULT false,
  emailed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at);

CREATE TABLE IF NOT EXISTS community_conferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  acronym TEXT,
  country TEXT,
  url TEXT,
  topics TEXT,
  indexed_in TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PJPS v4: authors of retracted papers (Module 4 author signals)
ALTER TABLE retractions ADD COLUMN IF NOT EXISTS authors TEXT;

-- PJPS v4: fingerprints of every screened manuscript (duplicate submissions, re-used figures)
CREATE TABLE IF NOT EXISTS fingerprints (
  id SERIAL PRIMARY KEY,
  check_id INTEGER REFERENCES checks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  manuscript_code TEXT,
  kind TEXT NOT NULL,                    -- text | image
  title TEXT,
  data JSONB NOT NULL,                   -- text: { shingles:[int], title, abstract } ; image: { hashes:[{ h, label }] }
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_kind ON fingerprints(kind, created_at);

CREATE TABLE IF NOT EXISTS offline_queue (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                    -- recheck (a saved check with pending references) | job (a whole online-only tool run)
  check_id INTEGER,
  input JSONB,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'waiting', -- waiting | running | done | error
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at TIMESTAMPTZ
);
`;

// One-off data migrations from the editor-approval model (v2) to Super Admin management (v3)
const MIGRATE = `
UPDATE users SET role = 'super_admin' WHERE role = 'admin';
UPDATE users SET status = 'active' WHERE status = 'approved';
UPDATE users SET status = 'suspended' WHERE status IN ('pending', 'rejected', 'disabled');
UPDATE users SET allow_desktop = true WHERE role = 'super_admin' AND allow_desktop = false AND created_by IS NULL;
`;

async function rawQuery(sql, params = []) {
  if (lite) return lite.query(sql, params);
  return pool.query(sql, params);
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      if (lite) await lite.exec(SCHEMA);
      else await pool.query(SCHEMA);
      if ((await rawQuery("SELECT value FROM meta WHERE key = 'schema_v3'")).rows.length === 0) {
        if (lite) await lite.exec(MIGRATE); else await pool.query(MIGRATE);
        await rawQuery("INSERT INTO meta(key, value) VALUES('schema_v3', now()::text) ON CONFLICT(key) DO NOTHING");
      }
      return true;
    })().catch(e => { ready = null; throw e; });
  }
  return ready;
}

async function query(sql, params = []) {
  await init();
  return rawQuery(sql, params);
}
async function one(sql, params) {
  const r = await query(sql, params);
  return r.rows[0] || null;
}
async function all(sql, params) {
  const r = await query(sql, params);
  return r.rows;
}

/** Run fn(client) inside a transaction; client.query(sql, params) */
async function transaction(fn) {
  await init();
  if (lite) return lite.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) }));
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

async function close() {
  if (lite) await lite.close();
  else if (pool) await pool.end();
}

module.exports = { pool, EMBEDDED, init, query, one, all, transaction, getMeta, setMeta, bulkInsert, close };
