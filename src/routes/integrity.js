// routes/integrity.js - Module 4 Paper Mill Detection (integrity screening with risk score, peer-review integrity, cases
// and dashboard), Module 1 published-article monitoring, integrity reports (Word / PDF) and the Research Integrity API keys.
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const W = require('../docx');
const { buildPdf } = require('../pdf');
const { defineJob, createJob } = require('../jobs');
const { normalizeMeta, saveResult, loadShared } = require('../pipeline');
const { manuscriptFrom } = require('./screening');
const { runIntegrity, saveIntegrity } = require('../integrity');
const { analyzePeerReview, storeReviews } = require('../integrity/peerReview');
const { scoreIntegrity } = require('../integrity/scoring');
const R = require('../integrity/reports');
const M = require('../integrity/monitoring');
const C = require('../cases');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = require('../uploads').upload();
const mod = auth.requireModule;
// Module 1 published-article monitoring is an editor tool: Module 1 access and an editor or Super Admin role
const monitorMod = (req, res, next) => mod('references')(req, res, () => (req.user.role === 'researcher' ? res.status(403).json({ success: false, message: 'Published-article monitoring is for editors.' }) : next()));
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const lines = v => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map(s => String(s).trim()).filter(Boolean);

function sendFile(res, buffer, filename, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`);
  res.send(buffer);
}
const sendBlocks = async (res, blocks, name, format) => (format === 'pdf' ? sendFile(res, await buildPdf(blocks), `${name}.pdf`, 'application/pdf') : sendFile(res, await W.buildDocx(blocks), `${name}.docx`, DOCX));

// ------------------------------------------------------------------ Integrity Screening

/** Build the job input from an upload / pasted text and the form fields (shared with the API) */
async function integrityInput(req) {
  const b = req.body || {};
  const ms = await manuscriptFrom(req);
  if (!ms) return null;
  const d = ms.detected;
  const meta = normalizeMeta({
    title: b.title || d.title || ms.filename, manuscriptCode: b.manuscriptCode || d.manuscriptCode || '', abstract: b.abstract || d.abstract || '',
    authors: lines(b.authors).length ? lines(b.authors) : (d.authors || []).map(a => a.name),
    affiliations: lines(b.affiliations).length ? lines(b.affiliations) : d.affiliations || [], keywords: b.keywords || d.keywords || [], version: b.version || null
  });
  return { text: ms.text, bodyText: ms.bodyText, referencesText: ms.referencesText, meta, suggestedReviewers: b.suggestedReviewers || '', imagesCheckId: b.imagesCheckId || null,
    deep: b.deep === true || b.deep === 'true' || b.deep === '1', online: !(b.external === false || b.external === 'false'), save: b.save !== 'false' && b.save !== false };
}

async function integrityJob(input, { userId, update }) {
  const result = await runIntegrity(input, update);
  if (input.save !== false) await saveIntegrity(userId, result, input);
  else { delete result._hashes; delete result._record; delete result._shingles; }
  return result;
}
defineJob('integrity', integrityJob);

router.post('/integrity', mod('papermill'), upload.single('file'), wrap(async (req, res) => {
  const input = await integrityInput(req);
  if (!input) return res.status(400).json({ success: false, message: 'Upload the full manuscript (Word or PDF) or paste its complete text.' });
  const job = await createJob(req.user.id, 'integrity', input);
  res.json({ success: true, jobId: job.id });
}));

/** Word / PDF report of an Integrity Screening or Peer-Review Integrity check */
router.get('/checks/:id/integrity-report', auth.requireUser, wrap(async (req, res) => {
  const c = await loadShared(req.user, req.params.id);
  if (!c?.result || !['integrity', 'peer-review'].includes(c.row.kind)) return res.status(404).json({ success: false, message: 'Report not found.' });
  const blocks = c.row.kind === 'integrity' ? R.integrityBlocks(c.result) : R.peerReviewBlocks(c.result);
  await auth.audit(req, 'report-export', `check ${c.row.id}`, { kind: c.row.kind, format: req.query.format || 'docx' });
  await sendBlocks(res, blocks, `${c.row.kind}-${c.row.manuscript_code || c.row.id}-CONFIDENTIAL`, req.query.format);
}));

// ------------------------------------------------------------------ Peer-Review Integrity

async function peerInput(req) {
  const b = req.body || {};
  let reviewers = b.reviewers;
  if (typeof reviewers === 'string') { try { reviewers = JSON.parse(reviewers); } catch (e) { reviewers = []; } }
  reviewers = (Array.isArray(reviewers) ? reviewers : []).filter(r => r && (r.name || r.email)).slice(0, 10).map(r => ({ name: String(r.name || '').slice(0, 200), email: String(r.email || '').slice(0, 200), orcid: String(r.orcid || '').slice(0, 40), institution: String(r.institution || '').slice(0, 300), report: String(r.report || '').slice(0, 60000), invitedAt: r.invitedAt || null, returnedAt: r.returnedAt || null }));
  if (!reviewers.length) return null;
  let text = '';
  if (req.file) text = (await require('../parse').extractDocument(req.file.buffer, req.file.originalname, req.file.mimetype)).text || '';
  else text = String(b.text || '');
  let meta = normalizeMeta({ title: b.title || '', manuscriptCode: b.manuscriptCode || '', authors: lines(b.authors), affiliations: lines(b.affiliations) });
  let authorEmails = lines(b.authorEmails).join(' ').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
  if (b.fromCheckId) {
    const c = await loadShared(req.user, b.fromCheckId);
    if (c?.result?.meta) {
      const m = c.result.meta;
      meta = normalizeMeta({ title: meta.title || m.title, manuscriptCode: meta.manuscriptCode || m.manuscriptCode, authors: meta.authors.length ? meta.authors : (m.authors || []).map(a => a.name), affiliations: meta.affiliations.length ? meta.affiliations : m.affiliations || [] });
      if (!authorEmails.length) authorEmails = c.result.dimensions?.find(d => d.key === 'network')?.details?.emails || [];
    }
  }
  if (text && !authorEmails.length) authorEmails = require('../papermill').emailsOf(text);
  return { meta, reviewers, authorEmails, manuscriptText: text.slice(0, 400000), suggestedReviewers: String(b.suggestedReviewers || ''), online: !(b.external === false || b.external === 'false'), save: b.save !== 'false' && b.save !== false };
}

async function peerJob(input, { userId, update }) {
  update('Checking reviewer identities, conflicts and reports', 10);
  const dim = await analyzePeerReview({ ...input.meta, manuscriptCode: input.meta.manuscriptCode, title: input.meta.title, authors: input.meta.authors, affiliations: input.meta.affiliations, authorEmails: input.authorEmails, manuscriptText: input.manuscriptText, suggestedReviewers: input.suggestedReviewers, reviewers: input.reviewers }, { online: require('../http').isOnline() && input.online !== false });
  const reviews = dim._reviews;
  delete dim._reviews;
  const result = { kind: 'peer-review', meta: { ...input.meta, authors: input.meta.authors.map(a => ({ name: a.name, given: a.given, family: a.family })) }, createdAt: new Date().toISOString(), dimensions: [dim], risk: scoreIntegrity([dim]),
    disclaimer: 'Screening aid for the editor. A flagged reviewer is not proof of misconduct; verify identities and relationships before acting. Confidential.' };
  if (input.save !== false) {
    await saveResult(userId, 'peer-review', result, { title: input.meta.title || 'Peer-review integrity', manuscriptCode: input.meta.manuscriptCode, problems: [`Peer-review risk ${result.risk.level}`, ...dim.signals.filter(s => s.severity !== 'low').slice(0, 4).map(s => s.title)] });
    await storeReviews(result.id, input.meta.manuscriptCode, reviews).catch(e => console.error('Review records not stored:', e.message));
  }
  return result;
}
defineJob('peer-review', peerJob);

router.post('/peer-review', mod('papermill'), upload.single('file'), wrap(async (req, res) => {
  const input = await peerInput(req);
  if (!input) return res.status(400).json({ success: false, message: 'Add at least one reviewer (name or e-mail).' });
  const job = await createJob(req.user.id, 'peer-review', input);
  res.json({ success: true, jobId: job.id });
}));

// ------------------------------------------------------------------ Published Article Monitoring

defineJob('monitor', async (input, { update }) => {
  if (input.action === 'import') { update(`Importing articles of ISSN ${input.issn} from Crossref`, 10); return M.importJournal(input.issn, input.userId, { fromYear: input.fromYear }); }
  if (input.action === 'rescreen') { update('Rescreening the archive (articles and saved reports)', 10); return M.rescreenArchive(); }
  update('Checking articles for retractions, corrections and concerns', 10);
  return M.runMonitor({ force: true, ids: input.ids || null, limit: 500 });
});

router.get('/monitoring', monitorMod, wrap(async (req, res) => {
  const params = [];
  let where = 'TRUE';
  if (req.query.status) { params.push(String(req.query.status).split(',')); where += ` AND status = ANY($${params.length}::text[])`; }
  if (req.query.q) { params.push(`%${req.query.q}%`); where += ` AND (title ILIKE $${params.length} OR doi ILIKE $${params.length} OR authors ILIKE $${params.length})`; }
  const items = await db.all(`SELECT * FROM monitored_articles WHERE ${where} ORDER BY CASE status WHEN 'retracted' THEN 0 WHEN 'concern' THEN 1 WHEN 'corrected' THEN 2 WHEN 'cites-retracted' THEN 3 ELSE 4 END, year DESC NULLS LAST, id DESC LIMIT 500`, params);
  const counts = await db.all('SELECT status, COUNT(*)::int AS n FROM monitored_articles GROUP BY status');
  const last = await db.one('SELECT MAX(last_checked) AS at FROM monitored_articles');
  res.json({ success: true, items, counts, lastChecked: last?.at || null, issn: require('../config').HOME_JOURNAL.issn });
}));

router.post('/monitoring/articles', monitorMod, wrap(async (req, res) => {
  const dois = lines(String(req.body?.dois || '').replace(/[,;]\s*/g, '\n'));
  if (!dois.length) return res.status(400).json({ success: false, message: 'Enter one or more DOIs.' });
  const out = await M.addArticles(dois, req.user.id, { manuscriptCode: req.body?.manuscriptCode || null });
  await auth.audit(req, 'monitoring-add', null, out);
  res.json({ success: true, ...out });
}));

router.post('/monitoring/import', monitorMod, wrap(async (req, res) => {
  const issn = String(req.body?.issn || '').trim();
  if (!/^\d{4}-\d{3}[\dX]$/i.test(issn)) return res.status(400).json({ success: false, message: 'Enter an ISSN such as 1011-601X.' });
  const job = await createJob(req.user.id, 'monitor', { action: 'import', issn, fromYear: parseInt(req.body?.fromYear, 10) || new Date().getFullYear() - 5, userId: req.user.id });
  await auth.audit(req, 'monitoring-import', issn);
  res.json({ success: true, jobId: job.id });
}));

router.post('/monitoring/check', monitorMod, wrap(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : null;
  const job = await createJob(req.user.id, 'monitor', { action: req.body?.rescreen ? 'rescreen' : 'check', ids });
  res.json({ success: true, jobId: job.id });
}));

router.delete('/monitoring/articles/:id', monitorMod, wrap(async (req, res) => {
  await db.query('DELETE FROM monitored_articles WHERE id = $1', [req.params.id]);
  await auth.audit(req, 'monitoring-remove', `article ${req.params.id}`);
  res.json({ success: true });
}));

// ------------------------------------------------------------------ Editorial Dashboard & Case Management

router.get('/cases/dashboard', mod('papermill'), wrap(async (req, res) => res.json({ success: true, ...(await C.dashboard()) })));

router.get('/cases', mod('papermill'), wrap(async (req, res) => {
  const params = [];
  let where = 'TRUE';
  if (req.query.status) { params.push(String(req.query.status).split(',')); where += ` AND c.status = ANY($${params.length}::text[])`; }
  if (req.query.q) { params.push(`%${req.query.q}%`); where += ` AND (c.title ILIKE $${params.length} OR c.manuscript_code ILIKE $${params.length})`; }
  if (req.query.mine) { params.push(req.user.id); where += ` AND c.assigned_to = $${params.length}`; }
  const items = await db.all(`SELECT c.*, a.name AS assigned_name FROM cases c LEFT JOIN users a ON a.id = c.assigned_to WHERE ${where} ORDER BY c.updated_at DESC LIMIT 500`, params);
  res.json({ success: true, items, labels: { statuses: C.STATUSES, priorities: C.PRIORITIES, outcomes: C.OUTCOMES } });
}));

router.get('/cases/assignees', mod('papermill'), wrap(async (req, res) => {
  const rows = await db.all("SELECT id, name, role, permissions FROM users WHERE status = 'active' AND role IN ('super_admin', 'editor') ORDER BY name");
  const { permissionsOf } = require('../modules');
  res.json({ success: true, users: rows.filter(u => permissionsOf(u).includes('papermill')).map(u => ({ id: u.id, name: u.name })) });
}));

router.post('/cases', mod('papermill'), wrap(async (req, res) => {
  const b = req.body || {};
  for (const id of b.checkIds || []) if (!(await loadShared(req.user, id))) return res.status(404).json({ success: false, message: `Report #${id} not found.` });
  const row = await C.createCase(req.user, b);
  await auth.audit(req, 'case-created', `case ${row.id}`, { checkIds: b.checkIds || [] });
  res.json({ success: true, case: row });
}));

router.get('/cases/:id', mod('papermill'), wrap(async (req, res) => {
  const c = await C.getCase(req.params.id);
  if (!c) return res.status(404).json({ success: false, message: 'Case not found.' });
  res.json({ success: true, case: c, labels: { statuses: C.STATUSES, priorities: C.PRIORITIES, outcomes: C.OUTCOMES } });
}));

router.patch('/cases/:id', mod('papermill'), wrap(async (req, res) => {
  for (const id of req.body?.linkChecks || []) if (!(await db.one('SELECT 1 FROM checks WHERE id = $1', [id]))) return res.status(404).json({ success: false, message: `Report #${id} not found.` });
  const c = await C.updateCase(req.params.id, req.user, req.body || {});
  if (!c) return res.status(404).json({ success: false, message: 'Case not found.' });
  await auth.audit(req, 'case-updated', `case ${c.id}`, { status: req.body?.status, assignedTo: req.body?.assignedTo, priority: req.body?.priority });
  res.json({ success: true, case: c });
}));

router.post('/cases/:id/events', mod('papermill'), wrap(async (req, res) => {
  if (!(await db.one('SELECT 1 FROM cases WHERE id = $1', [req.params.id]))) return res.status(404).json({ success: false, message: 'Case not found.' });
  const c = await C.addEvent(req.params.id, req.user, req.body || {});
  await auth.audit(req, `case-${req.body?.kind || 'note'}`, `case ${req.params.id}`);
  res.json({ success: true, case: c });
}));

router.get('/cases/:id/draft-query', mod('papermill'), wrap(async (req, res) => {
  const q = await C.draftQuery(req.params.id);
  if (!q) return res.status(404).json({ success: false, message: 'Case not found.' });
  res.json({ success: true, ...q });
}));

/** Case report with evidence links and the full audit trail */
router.get('/cases/:id/report', mod('papermill'), wrap(async (req, res) => {
  const c = await C.getCase(req.params.id);
  if (!c) return res.status(404).json({ success: false, message: 'Case not found.' });
  const reports = [];
  for (const r of c.reports) {
    const full = await db.one('SELECT result FROM checks WHERE id = $1', [r.id]);
    reports.push({ row: r, result: full?.result ? await require('../reportStore').load(full.result) : null });
  }
  const targets = [`case ${c.id}`, ...c.reports.map(r => `check ${r.id}`)];
  const audit = await db.all('SELECT created_at, actor_email, action, target FROM audit_log WHERE target = ANY($1::text[]) ORDER BY created_at LIMIT 500', [targets]);
  await C.addEvent(c.id, req.user, { kind: 'note', body: `Case report generated (${req.query.format === 'pdf' ? 'PDF' : 'Word'}).` }).catch(() => {});
  await sendBlocks(res, R.caseBlocks(c, reports, audit, { statuses: C.STATUSES, priorities: C.PRIORITIES, outcomes: C.OUTCOMES }), `integrity-case-${c.id}${c.manuscript_code ? '-' + c.manuscript_code : ''}-CONFIDENTIAL`, req.query.format);
}));

// ------------------------------------------------------------------ Research Integrity API keys (Super Admin)

const SCOPES = { screen: 'Submit manuscripts for Module 4 Paper Mill Detection', 'peer-review': 'Peer-review integrity checks', reports: 'Read results and download reports', monitoring: 'Read published-article monitoring status' };

router.get('/admin/api-keys', auth.requireSuperAdmin, wrap(async (req, res) => {
  const keys = await db.all('SELECT k.id, k.name, k.prefix, k.scopes, k.webhook_url, k.revoked, k.last_used, k.created_at, u.name AS user_name, u.email AS user_email FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.created_at DESC');
  res.json({ success: true, keys, scopes: SCOPES });
}));

router.post('/admin/api-keys', auth.requireSuperAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (name.length < 3) return res.status(400).json({ success: false, message: 'Name the integration (e.g. "PJPS submission system").' });
  const userId = Number(b.userId) || req.user.id;
  if (!(await db.one("SELECT 1 FROM users WHERE id = $1 AND status = 'active'", [userId]))) return res.status(400).json({ success: false, message: 'Choose an active account for the key to act as.' });
  const scopes = (Array.isArray(b.scopes) ? b.scopes : Object.keys(SCOPES)).filter(s => SCOPES[s]);
  const webhook = String(b.webhookUrl || '').trim();
  if (webhook && !/^https:\/\/[^\s]+$/i.test(webhook)) return res.status(400).json({ success: false, message: 'The webhook must be an https:// address.' });
  const key = `pjps_${crypto.randomBytes(24).toString('base64url')}`;
  const row = await db.one('INSERT INTO api_keys(name, prefix, key_hash, user_id, scopes, webhook_url) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [name.slice(0, 120), key.slice(0, 12), auth.sha256(key), userId, JSON.stringify(scopes), webhook || null]);
  await auth.audit(req, 'api-key-created', `api-key ${row.id}`, { name, scopes, userId });
  res.json({ success: true, id: row.id, key, message: 'Copy the key now: it is shown only once.' });
}));

router.delete('/admin/api-keys/:id', auth.requireSuperAdmin, wrap(async (req, res) => {
  await db.query('UPDATE api_keys SET revoked = true WHERE id = $1', [req.params.id]);
  await auth.audit(req, 'api-key-revoked', `api-key ${req.params.id}`);
  res.json({ success: true });
}));

module.exports = router;
module.exports.integrityInput = integrityInput;
module.exports.peerInput = peerInput;
module.exports.SCOPES = SCOPES;
