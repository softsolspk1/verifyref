// routes/sync.js - web platform endpoints used by the desktop application: device sign-in (desktop access only),
// account refresh, password change, and download/upload of datasets, journal lists, reports and notifications.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
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
  const { lists, ...st } = await D.listStatus();
  res.json({ success: true, ...st, lists: await db.all('SELECT list_type, filename, row_count, uploaded_at FROM journal_lists') });
}));

// Every dataset table the desktop copies, with a stable order for paging
const TABLE_ORDER = {
  retractions: 'doi', predatory: 'id', journal_list_entries: 'list_type, title_norm, issn, eissn', pps_fingerprints: 'kind, terms', fda_orange_book: 'id',
  nlm_journals: 'nlm_id', doaj_journals: 'title_norm, issn, eissn', ltwa_words: 'word, prefix, abbrev', crossref_journals: 'title_norm, crossref_id, issn', email_domains: 'domain',
  openalex_journals: 'openalex_id', publisher_journals: 'publisher_key, title_norm, issns', cello_problematic: 'name_key, accession',
  journal_abbrevs: 'title_norm, list', flagged_papers: 'doi, source'
};
// wide rows: smaller pages keep each response under the 4.5 MB Vercel limit (the desktop pages by what it receives)
const PAGE_MAX = { openalex_journals: 3000 };
router.get('/sync/table/:name', wrap(device), wrap(async (req, res) => {
  const order = TABLE_ORDER[req.params.name];
  if (!order) return res.status(404).json({ success: false, message: 'Unknown table.' });
  const limit = Math.min(parseInt(req.query.limit || '10000', 10), PAGE_MAX[req.params.name] || 10000);
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
  await require('../reportStore').loadRows(rows); // the desktop keeps full reports locally
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
      ON CONFLICT (uid) DO NOTHING RETURNING id`, [req.user.id, issueId, ...CHECK_COLS.map(col => (['problems', 'result'].includes(col) && c[col] ? JSON.stringify(c[col]) : col === 'origin' ? 'desktop' : c[col]))]);
    saved += r.rowCount || 0;
    if (r.rows?.[0]?.id && c.result) await require('../reportStore').offload(r.rows[0].id, c.result);
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

// ------------------------------------------------------------------ data files and Module 5 for the desktop

const STORE = require('../datasetStore');
const R2 = require('../uploads');
const FILE_MAX = 60e6; // benchmark archives (BioFors 2 GB, RSIID) stay online

/** Data folder files on R2 that the desktop keeps a copy of */
router.get('/sync/files', wrap(device), wrap(async (req, res) => {
  const rows = (await STORE.list()).filter(r => r.name.startsWith('files/') && Number(r.size) <= FILE_MAX && !r.name.startsWith('files/benchmark/'));
  res.json({ success: true, files: rows.map(r => ({ path: r.name.slice(6), size: Number(r.size), sha256: r.sha256 })) });
}));

/** One data file: a short-lived R2 link (the R2 keys never leave the platform) */
router.get('/sync/file', wrap(device), wrap(async (req, res) => {
  const name = String(req.query.name || '');
  const row = name && !name.includes('..') ? await db.one('SELECT name FROM dataset_files WHERE name = $1', [`files/${name}`]) : null;
  if (!row || !R2.enabled()) return res.status(404).json({ success: false, message: 'File not available.' });
  res.redirect(302, R2.presign('GET', STORE.PREFIX + row.name, { expires: 900 }));
}));

/** Module 5 from the desktop: PJPS-wide manuscript fingerprints and the image reference databases */
router.post('/sync/images/match', wrap(device), wrap(async (req, res) => {
  const IMG = require('../images');
  const REFS = require('../imageRefs');
  const isHex = h => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h);
  const panels = (req.body?.panels || []).slice(0, 60).map(p => ({ id: String(p.id), label: String(p.label || '').slice(0, 160), type: String(p.type || ''),
    hashes: (p.hashes || []).filter(isHex).slice(0, 8), windows: (p.windows || []).filter(isHex).slice(0, 5), thumb: typeof p.thumb === 'string' && p.thumb.length <= 40000 ? p.thumb : null, w: p.w | 0, h: p.h | 0 }));
  const charts = REFS.cleanSeries(req.body?.charts);
  const excludeCode = req.body?.excludeCode || null;
  await STORE.ensureLocal(['new/', 'public-images/']);
  const [earlier, earlierCharts, refs] = await Promise.all([
    IMG.compareWithEarlier(panels, { excludeCode }), IMG.compareChartsWithEarlier(charts, { excludeCode }),
    REFS.matchManuscript(panels, charts).catch(e => ({ matches: [], charts: [], searched: null, error: e.message }))
  ]);
  res.json({ success: true, earlier, earlierCharts, refs });
}));

/** Similarity report from the desktop: matching documents of the PJPS text repository (texts read from R2) */
router.post('/sync/corpus/candidates', wrap(device), wrap(async (req, res) => {
  const hashes = (Array.isArray(req.body?.hashes) ? req.body.hashes : []).map(Number).filter(Number.isFinite).slice(0, 4000);
  const docs = await require('../corpus').candidatesByHashes(hashes, { excludeCode: req.body?.excludeCode || null, limit: Math.min(12, parseInt(req.body?.limit, 10) || 12) });
  res.json({ success: true, docs: docs.map(d => ({ ...d, text: d.text.slice(0, 400000) })) });
}));

/** Module 1 from the desktop: Google Scholar and Google web search run here with the platform's SerpApi key (cached 30 days) */
router.post('/sync/serpapi', wrap(device), wrap(async (req, res) => {
  const engine = String(req.body?.engine || '');
  if (!['google_scholar', 'google'].includes(engine)) return res.status(400).json({ success: false, message: 'Unknown search engine.' });
  if (!cfg.SERPAPI_KEY) return res.json({ success: true, skipped: true });
  const query = String(req.body?.q || '').slice(0, 400);
  const num = Math.min(10, Math.max(1, parseInt(req.body?.num, 10) || 5));
  const r = await require('../sources').serpSearch(engine, query, num);
  res.json({ success: true, ok: !!r.ok, status: r.status, data: { organic_results: r.data?.organic_results || [], error: r.data?.error || null } });
}));

router.get('/sync/images/refs/:id/thumb', wrap(device), wrap(async (req, res) => {
  const REFS = require('../imageRefs');
  const buf = await REFS.refThumb(await REFS.thumbKey(parseInt(req.params.id, 10) || 0));
  if (!buf) return res.status(404).json({ success: false, message: 'Thumbnail not available.' });
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }).send(buf);
}));

// ------------------------------------------------------------------ desktop installer downloads (web portal)
// scripts/publish-desktop.js uploads the Windows installer and portable build to R2 (downloads/) and records the
// release in meta 'desktop_release'; signed-in users download it from the "Desktop application" page.

async function release() {
  try { return JSON.parse((await db.getMeta('desktop_release')) || 'null'); } catch { return null; }
}

router.get('/desktop-app', auth.requireUser, wrap(async (req, res) => {
  const r = await release();
  res.json({
    success: true, release: r && { version: r.version, publishedAt: r.publishedAt, notes: r.notes || null, files: (r.files || []).map(f => ({ kind: f.kind, name: f.name, size: f.size })) },
    allowed: req.user.role === 'super_admin' || !!req.user.allow_desktop, platformUrl: cfg.PUBLIC_URL || `${String(req.get('x-forwarded-proto') || req.protocol).split(',')[0]}://${req.get('host')}`, storage: R2.enabled()
  });
}));

// Public: the sign-in page offers the download (signing in to the desktop still needs an account with desktop access)
router.get('/desktop-app/latest', wrap(async (req, res) => {
  const r = await release();
  res.json({ success: true, release: r && R2.enabled() ? { version: r.version, publishedAt: r.publishedAt, files: (r.files || []).map(f => ({ kind: f.kind, name: f.name, size: f.size, sha512: f.sha512 || null })) } : null });
}));

// Automatic updates of installed desktops (electron-updater, generic provider): latest.yml, then the installer it names
router.get('/desktop-app/update/latest.yml', wrap(async (req, res) => {
  const r = await release();
  if (!r?.updateYml || !R2.enabled()) return res.status(404).type('text/plain').send('No desktop release published.');
  res.set({ 'Content-Type': 'text/yaml; charset=utf-8', 'Cache-Control': 'no-store' }).send(r.updateYml);
}));
router.get('/desktop-app/update/:file', wrap(async (req, res) => {
  const f = ((await release())?.files || []).find(x => x.name === req.params.file);
  if (!f || !R2.enabled()) return res.status(404).type('text/plain').send('Not found.');
  res.set('Cache-Control', 'no-store').redirect(302, R2.presign('GET', f.key, { expires: 3600 }));
}));

router.get('/desktop-app/download/:kind', wrap(async (req, res) => {
  const f = ((await release())?.files || []).find(x => x.kind === req.params.kind);
  if (!f || !R2.enabled()) return res.status(404).json({ success: false, message: 'The desktop application has not been published yet. Ask the Super Admin.' });
  await auth.audit(req, 'desktop-download', f.name, { kind: f.kind });
  res.redirect(302, R2.presign('GET', f.key, { expires: 600, query: { 'response-content-disposition': `attachment; filename="${f.name}"` } }));
}));

router.get('/sync/images/databases', wrap(device), wrap(async (req, res) => res.json({ success: true, ...(await require('../imageRefs').status()) })));

module.exports = router;
