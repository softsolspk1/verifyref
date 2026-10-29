// routes/admin.js - Super Admin: user accounts (all users are created here), roles, module permissions, web/desktop
// access, password resets, desktop devices, audit log, usage statistics, integrity datasets and journal index lists.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const auth = require('../auth');
const D = require('../datasets');
const { MODULES, ROLES, ALL, defaultPermissions, storePermissions } = require('../modules');
const { createJob, defineJob } = require('../jobs');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = require('../uploads').upload();

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
    b.orcid || null, JSON.stringify(cleanPermissions(b.permissions, role)), b.allowWeb !== false, b.allowDesktop !== false, Math.min(Math.max(parseInt(b.offlineDays || '14', 10), 1), 90),
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
  await STORE.ensureLocal(['new/', 'public-images/']);
  const PUB = require('../publicImageData');
  res.json({ success: true, datasets: PUB.catalog(await remoteSizes(), await REFS.sourceCounts().catch(() => ({}))), knowledge: PUB.knowledgeStatus(), benchmark: PUB.benchmark(), cases: PUB.cases({ per: 1 }).summary });
}));

// ------------------------------------------------------------------ Cloudflare R2 dataset storage

const STORE = require('../datasetStore');
const remoteSizes = async () => Object.fromEntries((await db.all("SELECT name, size FROM dataset_files WHERE name LIKE 'files/%'")).map(r => [r.name.slice(6), Number(r.size)]));

router.get('/admin/storage', wrap(async (req, res) => res.json({ success: true, ...(await STORE.status()), list: await STORE.list() })));

/** Copy the server's data folder to R2 (new and changed files only) */
router.post('/admin/storage/sync', webOnly, wrap(async (req, res) => {
  if (!STORE.enabled()) return res.status(400).json({ success: false, message: 'Cloudflare R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).' });
  const job = await createJob(req.user.id, 'storage-sync', {});
  res.json({ success: true, jobId: job.id });
}));
defineJob('storage-sync', async (input, { update }) => {
  let n = 0;
  const out = await STORE.pushDataDir({ onFile: rel => update(`Copying ${rel} to Cloudflare R2`, Math.min(95, 5 + ++n)) });
  if (!out.files) out.note = 'This server has no data folder (the web platform reads its datasets from R2). Run "npm run datasets:push" on the computer that holds the data folder.';
  return out;
});

/** Download one stored dataset file (Super Admin) */
router.get('/admin/storage/file', wrap(async (req, res) => {
  const name = String(req.query.name || '');
  const row = await db.one('SELECT name, content_type FROM dataset_files WHERE name = $1', [name]);
  if (!row) return res.status(404).json({ success: false, message: 'Not found.' });
  res.redirect(require('../uploads').presign('GET', STORE.PREFIX + row.name, { expires: 600 }));
}));

// ------------------------------------------------------------------ Module 5 image reference databases

const REFS = require('../imageRefs');

router.get('/admin/image-databases', wrap(async (req, res) => res.json({ success: true, ...(await REFS.status()), sources: REFS.SOURCES })));
router.get('/admin/image-databases/docs', wrap(async (req, res) => res.json({ success: true, ...(await REFS.listDocs(req.query)) })));
router.get('/admin/image-databases/docs/:id/panels', wrap(async (req, res) => res.json({ success: true, panels: await REFS.panelsOf(parseInt(req.params.id, 10) || 0) })));
router.delete('/admin/image-databases/docs/:id', webOnly, wrap(async (req, res) => {
  await REFS.deleteDoc(parseInt(req.params.id, 10) || 0);
  await auth.audit(req, 'image-reference-removed', String(req.params.id));
  res.json({ success: true });
}));

const intOr = (v, d, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : d; };

/** Index published PJPS papers from pjps.pk (default: articles newer than the newest indexed one) */
router.post('/admin/image-databases/pjps', webOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const job = await createJob(req.user.id, 'imgref-pjps', { from: intOr(b.from, null, 1e6), to: intOr(b.to, null, 1e6), limit: intOr(b.limit, 100, 2000), force: !!b.force });
  await auth.audit(req, 'image-database-pjps', `${b.from || 'new'}-${b.to || 'latest'}`);
  res.json({ success: true, jobId: job.id });
}));
defineJob('imgref-pjps', (input, { update }) => REFS.indexPjps({ ...input, budgetMs: process.env.VERCEL ? 270000 : Infinity }, update));

/** Index open-access papers retracted / corrected for image problems (strongest cases first) */
router.post('/admin/image-databases/retracted', webOnly, wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'imgref-retracted', { limit: intOr(req.body?.limit, 100, 2000), force: !!req.body?.force });
  await auth.audit(req, 'image-database-retracted', String(req.body?.limit || 100));
  res.json({ success: true, jobId: job.id });
}));
defineJob('imgref-retracted', (input, { update }) => REFS.indexRetracted({ ...input, budgetMs: process.env.VERCEL ? 270000 : Infinity }, update));

/** Open-access PubMed Central papers in pharmacy / pharmacology / medicinal plants (continues where the last run stopped) */
router.post('/admin/image-databases/pmc', webOnly, wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'imgref-pmc', { limit: intOr(req.body?.limit, 100, 2000), restart: !!req.body?.restart });
  await auth.audit(req, 'image-database-pmc', String(req.body?.limit || 100));
  res.json({ success: true, jobId: job.id });
}));
defineJob('imgref-pmc', (input, { update }) => REFS.indexPmc({ ...input, budgetMs: process.env.VERCEL ? 270000 : Infinity }, update));

/** Open-access papers of the major publishers via Europe PMC (the publishers take turns; continues where the last run stopped) */
router.post('/admin/image-databases/publisher', webOnly, wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'imgref-publisher', { limit: intOr(req.body?.limit, 100, 2000), restart: !!req.body?.restart });
  await auth.audit(req, 'image-database-publisher', String(req.body?.limit || 100));
  res.json({ success: true, jobId: job.id });
}));
defineJob('imgref-publisher', (input, { update }) => REFS.indexPublisherOa({ ...input, budgetMs: process.env.VERCEL ? 270000 : Infinity }, update));

/** Public image-integrity research datasets in the data folder: RSIID, BioFors, BINDER (resumes where it stopped) */
const DATASET_INDEXERS = { rsiid: REFS.indexRsiid, biofors: REFS.indexBiofors, binder: REFS.indexBinder };
router.post('/admin/image-databases/dataset/:name', webOnly, wrap(async (req, res) => {
  if (!DATASET_INDEXERS[req.params.name]) return res.status(400).json({ success: false, message: 'Unknown dataset.' });
  const job = await createJob(req.user.id, 'imgref-dataset', { name: req.params.name, limit: intOr(req.body?.limit, 1e6, 1e6) });
  await auth.audit(req, 'image-database-dataset', req.params.name);
  res.json({ success: true, jobId: job.id });
}));
defineJob('imgref-dataset', async (input, { update }) => {
  await STORE.ensureLocal(input.name === 'biofors' ? 'benchmark/biofors/ann/' : 'public-images/');
  return DATASET_INDEXERS[input.name]({ limit: input.limit, budgetMs: process.env.VERCEL ? 270000 : Infinity }, update);
});

/** Reference figures uploaded by the Super Admin: PDF, Word or image files of one paper */
router.post('/admin/image-databases/upload', webOnly, upload.fields([{ name: 'files', maxCount: 20 }]), wrap(async (req, res) => {
  const files = (req.files?.files || []).map(f => ({ name: f.originalname, buffer: f.buffer }));
  if (!files.length) return res.status(400).json({ success: false, message: 'Choose a PDF, Word (.docx), PNG or JPEG file.' });
  const b = req.body || {};
  const out = await REFS.indexUpload(files, { title: String(b.title || '').trim(), doi: String(b.doi || '').trim() || null, journal: String(b.journal || '').trim() || null, year: String(b.year || '').trim() || null, url: String(b.url || '').trim() || null, note: String(b.note || '').trim() || null });
  await auth.audit(req, 'image-reference-uploaded', out.doc.title || '', { figures: out.figures, panels: out.panels });
  res.json({ success: true, ...out });
}));

/** View: a searchable page of one stored dataset (publisher_journals: ?publisher=elsevier ...) */
router.get('/admin/datasets/:name/rows', wrap(async (req, res) => {
  const out = await D.datasetRows(req.params.name, req.query);
  if (!out) return res.status(404).json({ success: false, message: 'Unknown dataset.' });
  res.json({ success: true, ...out });
}));

/** Download the major publisher journal lists now (about 2 minutes) instead of waiting for the monthly refresh */
router.post('/admin/datasets/publishers/load', webOnly, wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'publisher-journals', {});
  await auth.audit(req, 'dataset-load', 'publisher journal lists');
  res.json({ success: true, jobId: job.id });
}));
defineJob('publisher-journals', async (input, { update }) => {
  update('Downloading the journal lists of Elsevier, Springer Nature, Wiley, Taylor & Francis, SAGE, MDPI, OUP, CUP, Wolters Kluwer Health, ACS and IEEE (about 2 minutes)', 10);
  const count = await D.loadPublisherJournals({ log: m => update(m, 50) });
  return { count };
});

router.post('/admin/datasets/refresh', wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'datasets', {});
  res.json({ success: true, jobId: job.id });
}));

defineJob('datasets', async (input, { update }) => {
  update('Refreshing Retraction Watch, Beall\'s list, Problematic Paper Screener, FDA Orange Book, NLM Catalog, DOAJ, Crossref journals, LTWA, e-mail domain lists and the OpenAlex journal list (continued on later runs)', 10);
  return D.ensureDatasets({ force: true });
});

router.post('/admin/orange-book/download', wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'orange-book', {});
  res.json({ success: true, jobId: job.id });
}));

defineJob('orange-book', async (input, { update }) => {
  update('Downloading FDA Orange Book from FDA and updating approved drug records', 15);
  const count = await D.loadFdaOrangeBook();
  return { count };
});

router.post('/admin/lists/ebsco/download', webOnly, wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'ebsco-download', {});
  res.json({ success: true, jobId: job.id });
}));

defineJob('ebsco-download', async (input, { update }) => {
  update('Downloading and compiling EBSCO title lists (CINAHL, Academic Search, Business Source)', 10);
  const { downloadAndCompileEbsco } = require('../../scripts/download-ebsco');
  const { csvContent } = await downloadAndCompileEbsco(msg => update(msg, 40));
  update('Importing into database', 80);
  const rows = await D.importJournalList('ebsco', 'ebsco.csv', csvContent);
  return { rows };
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
