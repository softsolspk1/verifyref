// routes/sync.js - web platform endpoints used by the desktop application: device sign-in (desktop access only),
// account refresh, password change, and download/upload of datasets, journal lists, reports and notifications.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../auth');
const D = require('../datasets');
const { CHECK_COLS } = require('../desktop');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Authorise a desktop device by its bearer token */
async function device(req, res, next) {
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/);
  if (!m) return res.status(401).json({ success: false, message: 'Sign in again online to link this computer.' });
  const d = await db.one(`SELECT d.id AS device_id, d.revoked, u.* FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = $1`, [auth.sha256(m[1])]);
  if (!d || d.revoked) return res.status(401).json({ success: false, message: 'This computer is no longer authorised for your account. Ask the Super Admin.' });
  if (d.status !== 'active') return res.status(403).json({ success: false, message: 'This account is suspended. Contact the Super Admin.' });
  if (d.role !== 'super_admin' && !d.allow_desktop) return res.status(403).json({ success: false, message: 'Desktop access has been removed from your account.' });
  req.user = d;
  req.deviceId = d.device_id;
  db.query('UPDATE devices SET last_seen = now() WHERE id = $1', [d.device_id]).catch(() => {});
  next();
}

router.post('/desktop/login', auth.throttle, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const r = await auth.checkCredentials(email, req.body?.password);
  if (!r.user) { await auth.audit(req, 'desktop-login-failed', email, { email }); return res.status(r.status).json({ success: false, message: r.message }); }
  if (r.user.role !== 'super_admin' && !r.user.allow_desktop) return res.status(403).json({ success: false, message: 'Your account is not enabled for the desktop application. Ask the Super Admin for desktop access.' });
  const token = crypto.randomBytes(32).toString('hex');
  const dev = req.body?.device || {};
  await db.query('INSERT INTO devices(user_id, name, token_hash, app_version, last_seen) VALUES($1, $2, $3, $4, now())', [r.user.id, String(dev.name || 'Desktop').slice(0, 120), auth.sha256(token), String(dev.version || '').slice(0, 20)]);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [r.user.id]);
  req.user = r.user;
  await auth.audit(req, 'desktop-login', email, { device: dev.name });
  res.json({ success: true, token, user: auth.publicUser(r.user) });
}));

router.get('/desktop/me', wrap(device), (req, res) => res.json({ success: true, user: auth.publicUser(req.user) }));

router.post('/desktop/password', wrap(device), wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!auth.verifyPassword(String(current || ''), req.user.password_hash)) return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
  if (!next || String(next).length < 8) return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
  await db.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [auth.hashPassword(String(next)), req.user.id]);
  await auth.audit(req, 'password-changed', req.user.email, { via: 'desktop' });
  res.json({ success: true });
}));

router.get('/sync/manifest', wrap(device), wrap(async (req, res) => {
  const st = await D.listStatus();
  res.json({ success: true, retractionWatch: st.retractionWatch, beall: st.beall, lists: await db.all('SELECT list_type, filename, row_count, uploaded_at FROM journal_lists') });
}));

const TABLE_ORDER = { retractions: 'doi', predatory: 'id', journal_list_entries: 'list_type, title_norm, issn, eissn' };
router.get('/sync/table/:name', wrap(device), wrap(async (req, res) => {
  const order = TABLE_ORDER[req.params.name];
  if (!order) return res.status(404).json({ success: false, message: 'Unknown table.' });
  const limit = Math.min(parseInt(req.query.limit || '10000', 10), 10000);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const total = (await db.one(`SELECT COUNT(*)::int AS n FROM ${req.params.name}`)).n;
  const rows = await db.all(`SELECT * FROM ${req.params.name} ORDER BY ${order} LIMIT $1 OFFSET $2`, [limit, offset]);
  for (const r of rows) delete r.id;
  res.json({ success: true, total, rows });
}));

router.get('/sync/checks/uids', wrap(device), wrap(async (req, res) => {
  const rows = await db.all('SELECT uid FROM checks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 2000', [req.user.id]);
  res.json({ success: true, uids: rows.map(r => r.uid) });
}));

router.post('/sync/checks/pull', wrap(device), wrap(async (req, res) => {
  const uids = (req.body?.uids || []).slice(0, 50).map(String);
  const rows = await db.all(`SELECT c.*, i.label AS issue_label FROM checks c LEFT JOIN issues i ON i.id = c.issue_id WHERE c.user_id = $1 AND c.uid = ANY($2::text[])`, [req.user.id, uids]);
  res.json({ success: true, checks: rows.map(r => ({ ...Object.fromEntries(CHECK_COLS.map(c => [c, r[c]])), issueLabel: r.issue_label })) });
}));

router.post('/sync/checks', wrap(device), wrap(async (req, res) => {
  let saved = 0;
  for (const c of (req.body?.checks || []).slice(0, 50)) {
    if (!c.uid || !c.kind) continue;
    let issueId = null;
    if (c.issueLabel) {
      const i = await db.one('SELECT id FROM issues WHERE user_id = $1 AND label = $2', [req.user.id, c.issueLabel]);
      issueId = i ? i.id : (await db.one('INSERT INTO issues(user_id, label) VALUES($1, $2) RETURNING id', [req.user.id, c.issueLabel])).id;
    }
    const r = await db.query(`INSERT INTO checks(user_id, issue_id, ${CHECK_COLS.join(', ')}, synced_at) VALUES($1, $2, ${CHECK_COLS.map((_, k) => `$${k + 3}`).join(', ')}, now())
      ON CONFLICT (uid) DO NOTHING`, [req.user.id, issueId, ...CHECK_COLS.map(col => (['problems', 'result'].includes(col) && c[col] ? JSON.stringify(c[col]) : col === 'origin' ? 'desktop' : c[col]))]);
    saved += r.rowCount || 0;
  }
  res.json({ success: true, saved });
}));

router.get('/sync/notifications', wrap(device), wrap(async (req, res) => {
  const rows = await db.all('SELECT id, kind, title, body, link, data, read, created_at FROM notifications WHERE user_id = $1 AND id > $2 ORDER BY id LIMIT 200', [req.user.id, parseInt(req.query.after || '0', 10)]);
  res.json({ success: true, notifications: rows });
}));

// Follows are kept on the web platform, where the scheduled alert run happens; the desktop manages them through here
router.get('/sync/follows', wrap(device), wrap(async (req, res) => {
  res.json({ success: true, follows: await db.all('SELECT id, kind, key, label, last_checked, created_at FROM follows WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]) });
}));
router.post('/sync/follows', wrap(device), wrap(async (req, res) => {
  const { createFollow } = require('./activity');
  res.json(await createFollow(req.user, req.body || {}));
}));
router.delete('/sync/follows/:id', wrap(device), wrap(async (req, res) => {
  await db.query('DELETE FROM follows WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

module.exports = router;
