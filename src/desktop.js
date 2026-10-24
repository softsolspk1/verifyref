// desktop.js - desktop edition: sign-in against the web platform (with offline sign-in afterwards), and
// synchronisation of the account, integrity datasets, journal lists, saved reports and notifications.
const os = require('os');
const db = require('./db');
const cfg = require('./config');
const auth = require('./auth');
const { probe, isOnline } = require('./http');

const TIMEOUT = 15000;

async function remoteUrl() {
  return ((await db.getMeta('remote_url')) || cfg.REMOTE_URL || '').replace(/\/+$/, '');
}

class RemoteError extends Error {
  constructor(message, status, network = false) { super(message); this.status = status; this.network = network; }
}

/** Call the web platform. Throws RemoteError (network=true when unreachable). */
async function remote(path, { method = 'GET', body, token, timeout = TIMEOUT, raw = false } = {}) {
  if (process.env.SIMULATE_OFFLINE === '1') throw new RemoteError('The web platform could not be reached.', 0, true);
  const base = await remoteUrl();
  if (!base) throw new RemoteError('The web platform address is not set. Open Settings on the sign-in screen.', 0, true);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(base + path, {
      method, signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Client': `pjps-desktop/${cfg.APP_VERSION}`, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new RemoteError('The web platform could not be reached.', 0, true);
  } finally { clearTimeout(timer); }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new RemoteError(data.message || `Web platform error (${res.status})`, res.status);
  return data;
}

const tokenKey = userId => `device_token:${userId}`;
async function deviceToken(userId) { return db.getMeta(tokenKey(userId)); }

/** Insert or update the local copy of a web account (password hash is computed locally from the typed password) */
async function upsertLocalUser(u, password) {
  const offlineUntil = new Date(Date.now() + Math.max(1, u.offlineDays || 14) * 86400000);
  const existing = await db.one('SELECT id FROM users WHERE email = $1', [u.email]);
  const vals = [u.name, u.role, u.status, u.journal || null, u.editorRole || null, u.designation || null, u.orcid || null, JSON.stringify(u.permissions || []),
    !!u.allowWeb, !!u.allowDesktop, u.offlineDays || 14, !!u.mustChangePassword, u.id, offlineUntil];
  if (existing) {
    await db.query(`UPDATE users SET name = $1, role = $2, status = $3, journal = $4, editor_role = $5, designation = $6, orcid = $7, permissions = $8,
      allow_web = $9, allow_desktop = $10, offline_days = $11, must_change_password = $12, remote_id = $13, offline_until = $14${password ? ', password_hash = $16' : ''} WHERE id = $15`,
    password ? [...vals, existing.id, auth.hashPassword(password)] : [...vals, existing.id]);
    return existing.id;
  }
  const row = await db.one(`INSERT INTO users(name, role, status, journal, editor_role, designation, orcid, permissions, allow_web, allow_desktop, offline_days, must_change_password, remote_id, offline_until, email, password_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`, [...vals, u.email, auth.hashPassword(password || require('crypto').randomBytes(16).toString('hex'))]);
  return row.id;
}

async function login(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ success: false, message: 'Enter your e-mail and password.' });
  try {
    const r = await remote('/api/desktop/login', { method: 'POST', body: { email, password, device: { name: `${os.hostname()} (${os.platform()})`, version: cfg.APP_VERSION } } });
    const id = await upsertLocalUser(r.user, password);
    await db.setMeta(tokenKey(id), r.token);
    await auth.createSession(res, id);
    const u = await db.one('SELECT * FROM users WHERE id = $1', [id]);
    // First sign-in on this computer: start downloading datasets and reports in the background
    syncInBackground(id, { datasets: !(await db.getMeta('datasets_synced_at')) });
    return res.json({ success: true, user: auth.publicUser(u), online: true });
  } catch (e) {
    if (!e.network) {
      // The platform answered: wrong password, suspended, no desktop access… keep the local copy in step
      if (e.status === 403) await db.query("UPDATE users SET status = 'suspended' WHERE email = $1 AND $2 ILIKE '%suspend%'", [email, e.message]);
      return res.status(e.status || 401).json({ success: false, message: e.message });
    }
  }
  // Offline sign-in
  const u = await db.one('SELECT * FROM users WHERE email = $1', [email]);
  if (!u) return res.status(503).json({ success: false, message: 'No internet connection. The first sign-in on this computer must be online.' });
  if (!auth.verifyPassword(password, u.password_hash)) return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
  if (u.status !== 'active') return res.status(403).json({ success: false, message: 'This account is suspended. Contact the Super Admin.' });
  if (!u.offline_until || new Date(u.offline_until) < new Date()) return res.status(403).json({ success: false, message: `The offline period allowed for your account (${u.offline_days} days) has ended. Connect to the internet to sign in.` });
  await auth.createSession(res, u.id);
  res.json({ success: true, user: auth.publicUser(u), online: false, message: `Signed in offline. Offline use is allowed until ${new Date(u.offline_until).toLocaleDateString()}.` });
}

async function changePassword(req, res, current, next) {
  const token = await deviceToken(req.user.id);
  try {
    await remote('/api/desktop/password', { method: 'POST', token, body: { current, next } });
  } catch (e) {
    return res.status(e.network ? 503 : e.status || 400).json({ success: false, message: e.network ? 'Changing the password needs an internet connection.' : e.message });
  }
  await db.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [auth.hashPassword(next), req.user.id]);
  res.json({ success: true });
}

// ------------------------------------------------------------------ synchronisation

const TABLES = {
  retractions: { cols: ['doi', 'retraction_doi', 'retraction_date', 'nature', 'reason', 'title', 'journal', 'journal_norm'], types: ['text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'], meta: ['rw_loaded_at', 'rw_count'] },
  predatory: { cols: ['kind', 'name', 'name_norm', 'url', 'domain', 'genuine_url', 'source'], types: ['text', 'text', 'text', 'text', 'text', 'text', 'text'], meta: ['beall_loaded_at', 'beall_count'] },
  journal_list_entries: { cols: ['list_type', 'issn', 'eissn', 'title', 'title_norm', 'data'], types: ['text', 'text', 'text', 'text', 'text', 'jsonb'] }
};

async function pullTable(name, token, update) {
  const t = TABLES[name];
  const rows = [];
  let offset = 0;
  for (;;) {
    const r = await remote(`/api/sync/table/${name}?offset=${offset}&limit=10000`, { token, timeout: 120000 });
    rows.push(...r.rows);
    offset += r.rows.length;
    update?.(`Downloading ${name.replace(/_/g, ' ')} (${rows.length.toLocaleString()} of ${r.total.toLocaleString()})`);
    if (!r.rows.length || offset >= r.total) break;
  }
  await db.transaction(async client => {
    await client.query(`DELETE FROM ${name}`);
    await db.bulkInsert(client, name, t.cols.map((c, i) => ({ name: c, type: t.types[i] })), rows.map(r => t.cols.map(c => (c === 'data' && r[c] ? JSON.stringify(r[c]) : r[c]))));
  });
  return rows.length;
}

async function syncDatasets(token, update) {
  const m = await remote('/api/sync/manifest', { token });
  const out = {};
  const local = async k => db.getMeta(k);
  if (m.retractionWatch.count && m.retractionWatch.loadedAt !== await local('rw_loaded_at')) {
    out.retractions = await pullTable('retractions', token, update);
    await db.setMeta('rw_loaded_at', m.retractionWatch.loadedAt); await db.setMeta('rw_count', out.retractions);
  }
  if (m.beall.count && m.beall.loadedAt !== await local('beall_loaded_at')) {
    out.predatory = await pullTable('predatory', token, update);
    await db.setMeta('beall_loaded_at', m.beall.loadedAt); await db.setMeta('beall_count', out.predatory);
  }
  const listsSig = JSON.stringify(m.lists.map(l => [l.list_type, l.uploaded_at, l.row_count]));
  if (listsSig !== await local('lists_sig')) {
    out.lists = await pullTable('journal_list_entries', token, update);
    await db.transaction(async client => {
      await client.query('DELETE FROM journal_lists');
      for (const l of m.lists) await client.query('INSERT INTO journal_lists(list_type, filename, row_count, uploaded_at) VALUES($1, $2, $3, $4)', [l.list_type, l.filename, l.row_count, l.uploaded_at]);
    });
    await db.setMeta('lists_sig', listsSig);
  }
  if (!m.retractionWatch.count) {
    // The platform has no Retraction Watch copy yet: download it from the source directly
    update?.('Downloading Retraction Watch and Beall’s list from their sources');
    out.direct = await require('./datasets').ensureDatasets().catch(e => ({ error: e.message }));
  }
  await db.setMeta('datasets_synced_at', new Date().toISOString());
  return out;
}

const CHECK_COLS = ['uid', 'kind', 'manuscript_code', 'version', 'title', 'ref_total', 'verified', 'suspicious', 'unverified', 'miscited', 'retracted', 'missing_citations', 'uncited_references', 'journal_flags', 'self_citation_rate', 'problems', 'result', 'created_at', 'origin', 'pending_online'];

async function pushChecks(userId, token) {
  const rows = await db.all(`SELECT c.*, i.label AS issue_label FROM checks c LEFT JOIN issues i ON i.id = c.issue_id
    WHERE c.user_id = $1 AND c.synced_at IS NULL AND c.pending_online = 0 ORDER BY c.id LIMIT 200`, [userId]);
  let pushed = 0;
  for (let i = 0; i < rows.length; i += 10) {
    const batch = rows.slice(i, i + 10);
    await remote('/api/sync/checks', { method: 'POST', token, timeout: 60000, body: { checks: batch.map(r => ({ ...Object.fromEntries(CHECK_COLS.map(c => [c, r[c]])), issueLabel: r.issue_label })) } });
    await db.query('UPDATE checks SET synced_at = now() WHERE id = ANY($1::int[])', [batch.map(r => r.id)]);
    pushed += batch.length;
  }
  return pushed;
}

async function issueIdFor(userId, label) {
  if (!label) return null;
  const row = await db.one('SELECT id FROM issues WHERE user_id = $1 AND label = $2', [userId, label]);
  return row ? row.id : (await db.one('INSERT INTO issues(user_id, label) VALUES($1, $2) RETURNING id', [userId, label])).id;
}

async function pullChecks(userId, token) {
  const { uids } = await remote('/api/sync/checks/uids', { token });
  const have = new Set((await db.all('SELECT uid FROM checks WHERE user_id = $1', [userId])).map(r => r.uid));
  const missing = uids.filter(u => !have.has(u)).slice(0, 300);
  let pulled = 0;
  for (let i = 0; i < missing.length; i += 20) {
    const { checks } = await remote('/api/sync/checks/pull', { method: 'POST', token, timeout: 60000, body: { uids: missing.slice(i, i + 20) } });
    for (const c of checks) {
      const issueId = await issueIdFor(userId, c.issueLabel);
      await db.query(`INSERT INTO checks(user_id, issue_id, ${CHECK_COLS.join(', ')}, synced_at) VALUES($1, $2, ${CHECK_COLS.map((_, k) => `$${k + 3}`).join(', ')}, now()) ON CONFLICT (uid) DO NOTHING`,
        [userId, issueId, ...CHECK_COLS.map(col => (['problems', 'result'].includes(col) && c[col] ? JSON.stringify(c[col]) : c[col]))]);
      pulled++;
    }
  }
  return pulled;
}

async function pullNotifications(userId, token) {
  const after = parseInt((await db.getMeta(`notif_after:${userId}`)) || '0', 10);
  const { notifications } = await remote(`/api/sync/notifications?after=${after}`, { token });
  for (const n of notifications) {
    await db.query('INSERT INTO notifications(user_id, kind, title, body, link, data, read, created_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8)',
      [userId, n.kind, n.title, n.body, n.link, n.data ? JSON.stringify(n.data) : null, n.read, n.created_at]);
  }
  if (notifications.length) await db.setMeta(`notif_after:${userId}`, String(Math.max(...notifications.map(n => n.id))));
  return notifications.length;
}

/** Full sync for one user. update(step, progress) */
async function syncAll(userId, { datasets = true } = {}, update = () => {}) {
  if (!(await probe())) throw new Error('No internet connection — synchronisation will run when the connection returns.');
  const token = await deviceToken(userId);
  if (!token) throw new Error('Sign in again online to link this computer to your account.');
  const out = {};
  update('Refreshing your account', 5);
  try {
    const me = await remote('/api/desktop/me', { token });
    const local = await db.one('SELECT email FROM users WHERE id = $1', [userId]);
    if (local) await upsertLocalUser({ ...me.user, email: local.email });
  } catch (e) {
    if (!e.network && [401, 403].includes(e.status)) {
      await db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userId]);
      await db.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      throw new Error(e.message || 'This computer is no longer authorised for your account.');
    }
    throw e;
  }
  if (datasets) { update('Synchronising integrity datasets and journal lists', 15); out.datasets = await syncDatasets(token, s => update(s, 30)); }
  update('Uploading reports created on this computer', 70);
  out.pushed = await pushChecks(userId, token);
  update('Downloading reports from the web platform', 80);
  out.pulled = await pullChecks(userId, token);
  update('Downloading notifications', 92);
  out.notifications = await pullNotifications(userId, token);
  await db.setMeta(`last_sync:${userId}`, new Date().toISOString());
  require('./queue').processQueue().catch(() => {});
  return out;
}

const syncing = new Set();
function syncInBackground(userId, opts) {
  if (syncing.has(userId)) return;
  syncing.add(userId);
  syncAll(userId, opts).catch(e => console.log('Background sync:', e.message)).finally(() => syncing.delete(userId));
}

/** Periodic background sync for the signed-in users of this computer */
function startSyncTimer() {
  if (!cfg.DESKTOP) return;
  const tick = async () => {
    if (!isOnline()) return;
    const users = await db.all("SELECT DISTINCT u.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > now() AND u.status = 'active'").catch(() => []);
    for (const u of users) {
      const last = await db.getMeta(`last_sync:${u.id}`);
      if (!last || Date.now() - new Date(last).getTime() > 30 * 60000) syncInBackground(u.id, { datasets: !last || Date.now() - new Date(last).getTime() > 24 * 3600000 });
    }
  };
  setInterval(() => tick().catch(() => {}), 5 * 60000).unref();
  require('./http').onConnectivity(online => { if (online) setTimeout(() => tick().catch(() => {}), 3000); });
}

async function status(userId) {
  const q = await db.all('SELECT status, COUNT(*)::int AS n FROM offline_queue WHERE user_id = $1 GROUP BY status', [userId]);
  const u = await db.one('SELECT offline_until, offline_days FROM users WHERE id = $1', [userId]);
  return {
    online: isOnline(), remoteUrl: await remoteUrl(), lastSync: await db.getMeta(`last_sync:${userId}`),
    datasetsSyncedAt: await db.getMeta('datasets_synced_at'), syncing: syncing.has(userId),
    queue: Object.fromEntries(q.map(r => [r.status, r.n])), offlineUntil: u?.offline_until || null, offlineDays: u?.offline_days || null,
    dataDir: process.env.PGLITE_DIR || null, version: cfg.APP_VERSION
  };
}

module.exports = { login, changePassword, syncAll, syncInBackground, startSyncTimer, status, remote, remoteUrl, RemoteError, TABLES, CHECK_COLS };
