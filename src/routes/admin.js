// routes/admin.js - Super Admin: user accounts (all users are created here), roles, module permissions, web/desktop
// access, password resets, desktop devices, audit log, usage statistics, integrity datasets and journal index lists.
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const cfg = require('../config');
const auth = require('../auth');
const D = require('../datasets');
const { MODULES, ROLES, ALL, defaultPermissions, storePermissions } = require('../modules');
const { createJob, defineJob } = require('../jobs');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// User administration happens on the web platform only; the desktop edition mirrors accounts from it
function webOnly(req, res, next) {
  if (cfg.DESKTOP) return res.status(400).json({ success: false, message: 'User management is done on the web platform. Changes reach this computer at the next synchronisation.' });
  next();
}

router.use('/admin', auth.requireUser, auth.requireSuperAdmin);

const generatePassword = () => crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 10) + 'a7';

function cleanPermissions(p, role) {
  if (!Array.isArray(p)) return null;
  const list = [...new Set(p.filter(k => ALL.includes(k)))];
  const def = defaultPermissions(role);
  return list.length === def.length && list.every(k => def.includes(k)) ? null : storePermissions(list);
}

async function activeSuperAdmins(exceptId) {
  return (await db.one("SELECT COUNT(*)::int AS n FROM users WHERE role = 'super_admin' AND status = 'active' AND id <> $1", [exceptId || 0])).n;
}

router.get('/admin/meta', (req, res) => res.json({ success: true, modules: MODULES, roles: ROLES, defaults: Object.fromEntries(Object.keys(ROLES).map(r => [r, defaultPermissions(r)])) }));

router.get('/admin/users', webOnly, wrap(async (req, res) => {
  const rows = await db.all(`SELECT u.id, u.email, u.name, u.role, u.status, u.journal, u.editor_role, u.designation, u.orcid, u.permissions, u.allow_web, u.allow_desktop,
      u.offline_days, u.must_change_password, u.created_at, u.last_login_at, c.name AS created_by_name,
      (SELECT COUNT(*)::int FROM devices d WHERE d.user_id = u.id AND NOT d.revoked) AS devices,
      (SELECT COUNT(*)::int FROM checks k WHERE k.user_id = u.id AND k.created_at > now() - interval '30 days') AS runs_30d
    FROM users u LEFT JOIN users c ON c.id = u.created_by ORDER BY (u.role = 'super_admin') DESC, u.name`);
  res.json({ success: true, users: rows });
}));

router.post('/admin/users', webOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!auth.validEmail(email)) return res.status(400).json({ success: false, message: 'A valid e-mail address is required.' });
  if (!b.name || String(b.name).trim().length < 3) return res.status(400).json({ success: false, message: 'Enter the user’s full name.' });
  const role = ROLES[b.role] ? b.role : 'editor';
  if (await db.one('SELECT id FROM users WHERE email = $1', [email])) return res.status(409).json({ success: false, message: 'An account with this e-mail already exists.' });
  const password = b.password ? String(b.password) : generatePassword();
  if (password.length < 8) return res.status(400).json({ success: false, message: 'The password must be at least 8 characters.' });
  if (b.orcid && !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(b.orcid)) return res.status(400).json({ success: false, message: 'ORCID iD format: 0000-0000-0000-0000.' });
  const u = await db.one(`INSERT INTO users(email, name, password_hash, role, status, journal, editor_role, designation, orcid, permissions, allow_web, allow_desktop, offline_days,
      must_change_password, created_by, approved_at)
    VALUES($1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now()) RETURNING *`,
  [email, String(b.name).trim(), auth.hashPassword(password), role, (b.journal || cfg.HOME_JOURNAL.name).trim(), (b.editorRole || ROLES[role].label).trim(), (b.designation || '').trim() || null,
    b.orcid || null, JSON.stringify(cleanPermissions(b.permissions, role)), b.allowWeb !== false, !!b.allowDesktop, Math.min(Math.max(parseInt(b.offlineDays || '14', 10), 1), 90),
    b.mustChangePassword !== false, req.user.id]);
  await auth.audit(req, 'user-created', email, { role, allowWeb: u.allow_web, allowDesktop: u.allow_desktop });
  res.json({ success: true, user: auth.publicUser(u), password: b.password ? undefined : password });
}));

router.patch('/admin/users/:id', webOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = await db.one('SELECT * FROM users WHERE id = $1', [id]);
  if (!u) return res.status(404).json({ success: false, message: 'User not found.' });
  const b = req.body || {};
  const role = b.role && ROLES[b.role] ? b.role : u.role;
  const status = ['active', 'suspended'].includes(b.status) ? b.status : u.status;
  const losingSuper = u.role === 'super_admin' && u.status === 'active' && (role !== 'super_admin' || status !== 'active');
  if (losingSuper && id === req.user.id) return res.status(400).json({ success: false, message: 'You cannot remove your own Super Admin access or suspend yourself.' });
  if (losingSuper && (await activeSuperAdmins(id)) === 0) return res.status(400).json({ success: false, message: 'At least one active Super Admin is required.' });
  if (b.email !== undefined) {
    const email = String(b.email).trim().toLowerCase();
    if (!auth.validEmail(email)) return res.status(400).json({ success: false, message: 'A valid e-mail address is required.' });
    if (email !== u.email && await db.one('SELECT id FROM users WHERE email = $1', [email])) return res.status(409).json({ success: false, message: 'Another account uses this e-mail.' });
  }
  if (b.orcid && !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(b.orcid)) return res.status(400).json({ success: false, message: 'ORCID iD format: 0000-0000-0000-0000.' });
  const permissions = 'permissions' in b ? cleanPermissions(b.permissions, role) : role !== u.role ? null : u.permissions;
  await db.query(`UPDATE users SET email = COALESCE($1, email), name = COALESCE($2, name), role = $3, status = $4, journal = COALESCE($5, journal), editor_role = COALESCE($6, editor_role),
      designation = COALESCE($7, designation), orcid = $8, permissions = $9, allow_web = $10, allow_desktop = $11, offline_days = $12, must_change_password = $13 WHERE id = $14`,
  [b.email ? String(b.email).trim().toLowerCase() : null, b.name ? String(b.name).trim() : null, role, status, b.journal ?? null, b.editorRole ?? null, b.designation ?? null,
    'orcid' in b ? (b.orcid || null) : u.orcid, JSON.stringify(permissions), 'allowWeb' in b ? !!b.allowWeb : u.allow_web, 'allowDesktop' in b ? !!b.allowDesktop : u.allow_desktop,
    'offlineDays' in b ? Math.min(Math.max(parseInt(b.offlineDays, 10) || 14, 1), 90) : u.offline_days, 'mustChangePassword' in b ? !!b.mustChangePassword : u.must_change_password, id]);
  if (status !== 'active') { await db.query('DELETE FROM sessions WHERE user_id = $1', [id]); await db.query('UPDATE devices SET revoked = true WHERE user_id = $1', [id]); }
  if ('allowDesktop' in b && !b.allowDesktop && role !== 'super_admin') await db.query('UPDATE devices SET revoked = true WHERE user_id = $1', [id]);
  if ('allowWeb' in b && !b.allowWeb && role !== 'super_admin') await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  const changed = Object.keys(b).filter(k => k !== 'password');
  await auth.audit(req, status !== u.status ? (status === 'active' ? 'user-activated' : 'user-suspended') : 'user-updated', u.email, { changed });
  res.json({ success: true });
}));

router.post('/admin/users/:id/password', webOnly, wrap(async (req, res) => {
  const u = await db.one('SELECT id, email FROM users WHERE id = $1', [req.params.id]);
  if (!u) return res.status(404).json({ success: false, message: 'User not found.' });
  const password = req.body?.password ? String(req.body.password) : generatePassword();
  if (password.length < 8) return res.status(400).json({ success: false, message: 'The password must be at least 8 characters.' });
  await db.query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [auth.hashPassword(password), u.id]);
  await db.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
  await auth.audit(req, 'password-reset', u.email);
  res.json({ success: true, password: req.body?.password ? undefined : password });
}));

router.delete('/admin/users/:id', webOnly, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
  const u = await db.one('SELECT * FROM users WHERE id = $1', [id]);
  if (!u) return res.status(404).json({ success: false, message: 'User not found.' });
  if (u.role === 'super_admin' && (await activeSuperAdmins(id)) === 0) return res.status(400).json({ success: false, message: 'At least one active Super Admin is required.' });
  await db.query('DELETE FROM users WHERE id = $1', [id]);
  await auth.audit(req, 'user-deleted', u.email);
  res.json({ success: true });
}));

router.get('/admin/users/:id/devices', webOnly, wrap(async (req, res) => {
  res.json({ success: true, devices: await db.all('SELECT id, name, app_version, revoked, created_at, last_seen FROM devices WHERE user_id = $1 ORDER BY created_at DESC', [req.params.id]) });
}));

router.post('/admin/devices/:id/revoke', webOnly, wrap(async (req, res) => {
  const d = await db.one('UPDATE devices SET revoked = true WHERE id = $1 RETURNING user_id, name', [req.params.id]);
  if (d) await auth.audit(req, 'device-revoked', String(d.user_id), { device: d.name });
  res.json({ success: true });
}));

router.get('/admin/audit', webOnly, wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  res.json({ success: true, entries: await db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [limit]) });
}));

router.get('/admin/stats', wrap(async (req, res) => {
  const days = Math.min(parseInt(req.query.days || '30', 10), 365);
  const [byKind, byUser, totals] = await Promise.all([
    db.all(`SELECT kind, COUNT(*)::int AS runs, COALESCE(SUM(ref_total), 0)::int AS refs, COALESCE(SUM(suspicious), 0)::int AS suspicious, COALESCE(SUM(retracted), 0)::int AS retracted
      FROM checks WHERE created_at > now() - ($1 || ' days')::interval GROUP BY kind ORDER BY runs DESC`, [String(days)]),
    db.all(`SELECT u.id, u.name, u.email, COUNT(c.id)::int AS runs, COALESCE(SUM(c.ref_total), 0)::int AS refs, MAX(c.created_at) AS last_run
      FROM users u LEFT JOIN checks c ON c.user_id = u.id AND c.created_at > now() - ($1 || ' days')::interval GROUP BY u.id ORDER BY runs DESC`, [String(days)]),
    db.one(`SELECT (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM users WHERE status = 'active') AS active,
      (SELECT COUNT(*)::int FROM users WHERE allow_desktop OR role = 'super_admin') AS desktop_users, (SELECT COUNT(*)::int FROM devices WHERE NOT revoked) AS devices`)
  ]);
  res.json({ success: true, days, byKind, byUser, totals });
}));

// ------------------------------------------------------------------ datasets and journal lists

router.get('/admin/datasets', wrap(async (req, res) => res.json({ success: true, ...(await D.listStatus()) })));

/** Image Integrity (Module 5) sources: public datasets, ImageTwin / Proofig knowledge base, retracted image cases, benchmark */
router.get('/admin/image-sources', wrap(async (req, res) => {
  const PUB = require('../publicImageData');
  res.json({ success: true, datasets: PUB.catalog(), knowledge: PUB.knowledgeStatus(), benchmark: PUB.benchmark(), cases: PUB.cases({ per: 1 }).summary });
}));

router.post('/admin/datasets/refresh', wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'datasets', {});
  res.json({ success: true, jobId: job.id });
}));

defineJob('datasets', async (input, { update }) => {
  update('Downloading Retraction Watch and Beall\'s list', 10);
  return D.ensureDatasets({ force: true });
});

router.get('/admin/lists/:type/entries', wrap(async (req, res) => {
  if (!D.LIST_TYPES[req.params.type]) return res.status(400).json({ success: false, message: 'Unknown list type.' });
  res.json({ success: true, ...(await D.listEntries(req.params.type, req.query)) });
}));

router.post('/admin/lists/:type', webOnly, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Choose a CSV file.' });
  if (!D.LIST_TYPES[req.params.type]) return res.status(400).json({ success: false, message: 'Unknown list type.' });
  if (/\.xlsx?$/i.test(req.file.originalname)) return res.status(400).json({ success: false, message: 'Please save the spreadsheet as CSV (File → Save As → CSV UTF-8) and upload that.' });
  const n = await D.importJournalList(req.params.type, req.file.originalname, req.file.buffer.toString('utf8'));
  await auth.audit(req, 'list-uploaded', req.params.type, { file: req.file.originalname, rows: n });
  res.json({ success: true, rows: n });
}));

router.delete('/admin/lists/:type', webOnly, wrap(async (req, res) => {
  await db.query('DELETE FROM journal_list_entries WHERE list_type = $1', [req.params.type]);
  await db.query('DELETE FROM journal_lists WHERE list_type = $1', [req.params.type]);
  await auth.audit(req, 'list-removed', req.params.type);
  res.json({ success: true });
}));

router.post('/admin/alerts/run', webOnly, wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'alerts', {});
  res.json({ success: true, jobId: job.id });
}));
defineJob('alerts', async (input, { update }) => {
  update('Checking followed authors, topics, conferences, citations and retractions', 10);
  return require('../alerts').runAlerts({ force: true });
});

module.exports = router;
