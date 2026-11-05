// routes/screening.js - PJPS v4 editor modules: Module 4 Paper Mill Detection, Module 5 Image Integrity Detection,
// the editor's decision record on a saved report, and the Module 1 reference-age rule.
const express = require('express');
const db = require('../db');
const cfg = require('../config');
const auth = require('../auth');
const P = require('../parse');
const W = require('../docx');
const { defineJob, createJob } = require('../jobs');
const { prepare, normalizeMeta, saveResult, loadCheck, screeningSummary } = require('../pipeline');
const { checkReferences } = require('../checks/reference');
const { analyzeCitationPattern } = require('../editor/pattern');
const { detectPaperMill, storeFingerprint, papermillProblems } = require('../papermill');
const IMG = require('../images');
const { ageRule, setAgeRule } = require('../checks/indicators');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = require('../uploads').upload();
const mod = auth.requireModule;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const lines = v => String(v || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);

function sendFile(res, buffer, filename, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`);
  res.send(buffer);
}

/** Manuscript from an upload or pasted text: { text, bodyText, referencesText, detected meta } */
async function manuscriptFrom(req) {
  const b = req.body || {};
  let text = '';
  if (req.file) text = (await P.extractDocument(req.file.buffer, req.file.originalname, req.file.mimetype)).text || '';
  else text = String(b.text || '');
  if (text.trim().length < 300) return null;
  const sec = P.findReferenceSection(text);
  const detected = P.extractManuscriptMeta(sec.found ? sec.body : text);
  return { text, bodyText: sec.found ? sec.body : text, referencesText: sec.found ? sec.references : '', detected, filename: req.file?.originalname || '' };
}

// ------------------------------------------------------------------ Module 4: Paper Mill Detection

router.post('/papermill', mod('papermill'), upload.single('file'), wrap(async (req, res) => {
  const b = req.body || {};
  const ms = await manuscriptFrom(req);
  if (!ms) return res.status(400).json({ success: false, message: 'Upload the full manuscript (Word or PDF) or paste its complete text.' });
  const d = ms.detected;
  const meta = normalizeMeta({
    title: b.title || d.title || ms.filename, manuscriptCode: b.manuscriptCode || d.manuscriptCode || '', abstract: b.abstract || d.abstract || '',
    authors: lines(b.authors).length ? lines(b.authors) : (d.authors || []).map(a => a.name),
    affiliations: lines(b.affiliations).length ? lines(b.affiliations) : d.affiliations || [], keywords: b.keywords || d.keywords || [], version: b.version || null, fileName: ms.filename
  });
  const job = await createJob(req.user.id, 'papermill', { text: ms.text, bodyText: ms.bodyText, referencesText: ms.referencesText, meta, suggestedReviewers: b.suggestedReviewers || '', coverLetter: String(b.coverLetter || '').slice(0, 20000), imagesCheckId: b.imagesCheckId || null, save: b.save !== 'false' });
  res.json({ success: true, jobId: job.id });
}));

async function runPaperMill(input, { userId, update }) {
  let references = [], pattern = null;
  if (input.referencesText) {
    const { refs } = prepare({ referencesText: input.referencesText, bodyText: input.bodyText });
    if (refs.length) {
      update(`Checking ${refs.length} references (fabrication, retractions)`, 3);
      const rc = await checkReferences(refs, { checkLinks: false, onProgress: (k, n) => update(`Checking references (${k}/${n})`, 3 + k / n * 50) });
      references = rc.results;
      pattern = analyzeCitationPattern(input.meta, references);
    }
  }
  let images = null;
  if (input.imagesCheckId) {
    const c = await loadCheck(userId, input.imagesCheckId);
    if (c?.result?.summary) images = { findings: c.result.summary.byLevel || {}, categories: c.result.summary.byCategory || {}, level: c.result.summary.level };
  }
  const result = await detectPaperMill({ text: input.text, body: input.bodyText, meta: input.meta, references, pattern, suggestedReviewers: input.suggestedReviewers, coverLetter: input.coverLetter || '', images },
    (s, p) => update(s, 55 + (p || 0) * 0.43));
  const shingles = result._shingles;
  delete result._shingles;
  result.referenceSummary = references.length ? { total: references.length, suspicious: references.filter(r => r.status === 'suspicious').length, retracted: references.filter(r => r.status === 'retracted').length } : null;
  if (input.save !== false) {
    await saveResult(userId, 'papermill', result, { title: input.meta.title || 'Paper mill screening', manuscriptCode: input.meta.manuscriptCode, refTotal: references.length, problems: papermillProblems(result), counts: { suspicious: result.risk.highSignals } });
    await storeFingerprint({ checkId: result.id, userId, meta: input.meta, shingles, text: input.bodyText || input.text }).catch(e => console.error('Fingerprint not stored:', e.message));
  }
  return result;
}
defineJob('papermill', runPaperMill);

// ------------------------------------------------------------------ Module 5: Image Integrity (analysis runs in the browser)

// The knowledge base and public image data live in the data folder, which is mirrored on Cloudflare R2: copy them
// into DATA_DIR on first use where the folder is not deployed (Vercel)
const STORE = require('../datasetStore');
router.use('/images', (req, res, next) => STORE.ensureLocal(['new/', 'public-images/']).then(() => next(), next));

/** Thumbnail of a figure panel in the image reference databases (kept on R2) */
const REFS = require('../imageRefs');
router.get('/images/refs/:id/thumb', mod('images'), wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  // desktop: the reference databases (and their thumbnails) are on the web platform
  const buf = cfg.DESKTOP ? await require('../desktop').remoteRefThumb(req.user.id, id) : await REFS.refThumb(await REFS.thumbKey(id));
  if (!buf) return res.status(404).json({ success: false, message: 'Thumbnail not available.' });
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }).send(buf);
}));

/** What the PJPS image databases hold (shown on the Module 5 page) */
router.get('/images/databases', mod('images'), wrap(async (req, res) => {
  if (cfg.DESKTOP) {
    const r = await require('../desktop').remoteImageDatabases(req.user.id);
    if (r) return res.json({ ...r, success: true, onPlatform: true });
  }
  res.json({ success: true, ...(await REFS.status()) });
}));

/** Save the browser's image analysis; compares the panel fingerprints with earlier PJPS manuscripts */
router.post('/images', mod('images'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.result || !Array.isArray(b.result.findings)) return res.status(400).json({ success: false, message: 'No image analysis received.' });
  const out = await IMG.saveImageCheck(req.user.id, b.result, { save: b.save !== false });
  res.json({ success: true, ...out });
}));

/** Earlier PJPS manuscripts sharing a figure with these panel hashes (without saving) */
router.post('/images/compare', mod('images'), wrap(async (req, res) => {
  const panels = Array.isArray(req.body?.panels) ? req.body.panels.slice(0, 400) : [];
  res.json({ success: true, matches: await IMG.compareWithEarlier(panels, { excludeCode: req.body?.manuscriptCode || null }) });
}));

/** Sharper pictures of the panels that match a reference / earlier figure, sent by the browser after saving: { views: { panelId: { src, w, h } } } */
router.put('/images/:id/views', mod('images'), wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c?.result || c.row.kind !== 'images') return res.status(404).json({ success: false, message: 'Report not found.' });
  const known = new Set((c.result.panels || []).map(p => p.id));
  const views = { ...(c.result.panelViews || {}) };
  for (const [id, v] of Object.entries(req.body?.views || {})) {
    if (Object.keys(views).length >= 40) break;
    if (known.has(id) && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(v?.src || '')) && v.src.length <= 120000) views[id] = { src: v.src, w: v.w | 0, h: v.h | 0 };
  }
  c.result.panelViews = views;
  delete c.result.id; delete c.result.createdAt; delete c.result.issueId;
  await db.query('UPDATE checks SET result = $1 WHERE id = $2 AND user_id = $3', [JSON.stringify(c.result), c.row.id, req.user.id]);
  await require('../reportStore').offload(c.row.id, c.result);
  res.json({ success: true, views: Object.keys(views).length });
}));

/** 5.6 - the authors' own open-access figures (Europe PMC) compared with this manuscript's panels; runs as a background job */
const AF = require('../authorFigures');
const { splitName } = require('../text');
defineJob('author-figures', async (input, { userId, update }) => {
  const authors = (input.authors || []).slice(0, 8).map(a => {
    const name = String(a.name || '').replace(/\(?\d{4}-\d{4}-\d{4}-\d{3}[\dX]\)?/g, '').trim();
    const orcid = String(a.orcid || a.name || '').match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/)?.[0] || null;
    return { ...splitName(name), orcid };
  });
  const out = await AF.checkAuthorFigures({ authors, panels: input.panels }, update);
  for (const m of out.matches || []) Object.assign(m, require('../imageScore').matchConfidence(m));
  out.checkedAt = new Date().toISOString();
  if (input.checkId) {
    const c = await loadCheck(userId, input.checkId);
    if (c?.result && c.row.kind === 'images') {
      c.result.authorFigures = out;
      delete c.result.id; delete c.result.createdAt; delete c.result.issueId;
      c.result.summary = { ...c.result.summary, authorFigureMatches: out.matches.length };
      await db.query('UPDATE checks SET result = $1 WHERE id = $2 AND user_id = $3', [JSON.stringify(c.result), c.row.id, userId]);
      await require('../reportStore').offload(c.row.id, c.result);
    }
  }
  return out;
});

router.post('/images/author-figures', mod('images'), wrap(async (req, res) => {
  const b = req.body || {};
  const authors = (Array.isArray(b.authors) ? b.authors : lines(b.authors).map(name => ({ name }))).slice(0, 8);
  if (!authors.length) return res.status(400).json({ success: false, message: 'Enter the authors (one per line, optionally with an ORCID iD).' });
  let panels = Array.isArray(b.panels) ? b.panels : [];
  if (b.checkId && !panels.length) {
    const c = await loadCheck(req.user.id, b.checkId);
    panels = (c?.result?.panels || []).map(p => ({ id: p.id, label: p.label, hashes: p.hashes || [] }));
  }
  const job = await createJob(req.user.id, 'author-figures', { authors, panels: panels.slice(0, 300), checkId: b.checkId || null });
  res.json({ success: true, jobId: job.id });
}));

/** Author query-letter templates (from the ImageTwin / Proofig knowledge base in data/new) */
router.get('/images/letters', mod('images'), wrap(async (req, res) => res.json({ success: true, letters: require('../imageKnowledge').letters() })));

/** Public reference data: datasets, retracted papers with image problems, engine benchmark */
const PUB = require('../publicImageData');
router.get('/images/public', mod('images'), wrap(async (req, res) => {
  const remote = Object.fromEntries((await db.all("SELECT name, size FROM dataset_files WHERE name LIKE 'files/%'")).map(r => [r.name.slice(6), Number(r.size)]));
  const counts = (cfg.DESKTOP && (await require('../desktop').remoteImageDatabases(req.user.id))?.bySource) || await REFS.sourceCounts().catch(() => ({}));
  res.json({ success: true, datasets: PUB.catalog(remote, counts), benchmark: PUB.benchmark() });
}));
router.get('/images/public/cases', mod('images'), wrap(async (req, res) => res.json({ success: true, ...PUB.cases({ q: req.query.q, oa: req.query.oa === '1', reason: req.query.reason, page: Math.max(1, parseInt(req.query.page, 10) || 1) }) })));
router.get('/images/public/figures/:pmcid', mod('images'), wrap(async (req, res) => {
  try { res.json({ success: true, ...(await PUB.figures(req.params.pmcid)) }); } catch (e) { res.status(404).json({ success: false, message: e.message }); }
}));

router.get('/images/vendor', mod('images'), wrap(async (req, res) => res.json({ success: true, ...(await IMG.vendorStatus()) })));

/**
 * One figure checked by the external image service before the Module 5 report is saved: { src: JPEG data URL, w, h,
 * label } -> AI-generated image estimate and copies of the figure on the web (src/externalSimilarity.js)
 */
router.post('/images/external', mod('images'), wrap(async (req, res) => {
  const X = require('../externalSimilarity');
  if (!X.imagesEnabled()) return res.status(404).json({ success: false, message: 'The external image check is not set up.' });
  const b = req.body || {};
  const m = String(b.src || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  if (!m || m[1].length > 12_000_000) return res.status(400).json({ success: false, message: 'Send one figure as a JPEG (at most 9 MB).' });
  const check = await X.checkFigure({ base64: m[1], filename: `${String(b.label || 'figure').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'figure'}.jpg`, width: b.w | 0, height: b.h | 0 });
  res.json({ success: true, ...check });
}));

// ------------------------------------------------------------------ editor decision record (Modules 4, 5, Full Screening Report)

const DECISIONS = { cleared: 'Cleared', investigate: 'Needs investigation', committee: 'Referred to the integrity committee', 'return': 'Returned to the authors', proceed: 'Proceed to peer review' };

router.put('/checks/:id/decision', auth.requireUser, wrap(async (req, res) => {
  const row = await db.one('SELECT id, kind, result FROM checks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row?.result) return res.status(404).json({ success: false, message: 'Report not found.' });
  const b = req.body || {};
  if (b.decision && !DECISIONS[b.decision]) return res.status(400).json({ success: false, message: 'Unknown decision.' });
  const r = await require('../reportStore').load(row.result);
  const notes = String(b.notes || '').slice(0, 5000);
  let entry = r.decision || null;
  // Only a changed decision or note is a new entry in the history (saving finding marks alone is not)
  if (!entry || entry.decision !== (b.decision || null) || entry.notes !== notes) {
    entry = { decision: b.decision || null, label: DECISIONS[b.decision] || null, notes, by: req.user.name, at: new Date().toISOString() };
    r.decision = entry;
    if (entry.decision || entry.notes) r.decisionHistory = [...(r.decisionHistory || []), entry].slice(-20);
  }
  if (Array.isArray(b.findingMarks)) r.findingMarks = b.findingMarks.slice(0, 500);
  // Module 5: findings the editor left out of the Word / PDF report, and the lowest confidence shown (ImageTwin default 33 %)
  if (Array.isArray(b.reportExclude)) r.reportExclude = b.reportExclude.map(String).slice(0, 500);
  if (Number.isFinite(b.confidenceThreshold)) r.confidenceThreshold = Math.max(0, Math.min(100, Math.round(b.confidenceThreshold)));
  await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(r), row.id]);
  await require('../reportStore').offload(row.id, r);
  await auth.audit(req, 'decision', `check ${row.id}`, { kind: row.kind, decision: entry?.decision || null });
  res.json({ success: true, decision: entry });
}));

const confidentialBlocks = async (c, userId) => (c.row.kind === 'papermill' ? W.papermillBlocks(c.result) : c.row.kind === 'images' ? W.imagesBlocks(await IMG.withExportThumbs(c.result, userId)) : c.row.kind === 'integrity' ? require('../integrity/reports').integrityBlocks(c.result)
  : c.row.kind === 'verify' ? W.verifyBlocks(c.result) : c.row.kind === 'citations' ? W.citationsBlocks(c.result) : null);

/** Confidential Word export of a Module 4 / Module 5 report */
router.get('/checks/:id/confidential', auth.requireUser, wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c?.result) return res.status(404).json({ success: false, message: 'Report not found.' });
  const kind = c.row.kind;
  // CSV of the findings (Module 4 signals, Module 5 findings and matches), confidential like the Word / PDF
  if (req.query.format === 'csv') {
    const CSV = require('../moduleCsv');
    const csv = kind === 'papermill' ? CSV.papermill(c.result) : kind === 'images' ? CSV.images(c.result) : null;
    if (!csv) return res.status(400).json({ success: false, message: 'No CSV export for this report.' });
    await auth.audit(req, 'export', `check ${c.row.id}`, { format: 'csv', kind });
    return sendFile(res, Buffer.from(csv, 'utf8'), `${kind}-${c.row.manuscript_code || c.row.id}-CONFIDENTIAL.csv`, 'text/csv; charset=utf-8');
  }
  const blocks = await confidentialBlocks(c, req.user.id);
  if (!blocks) return res.status(400).json({ success: false, message: 'No confidential export for this report.' });
  if (req.query.format === 'pdf') return sendFile(res, await require('../pdf').buildPdf(blocks), `${kind}-${c.row.manuscript_code || c.row.id}-CONFIDENTIAL.pdf`, 'application/pdf');
  sendFile(res, await W.buildDocx(blocks), `${kind}-${c.row.manuscript_code || c.row.id}-CONFIDENTIAL.docx`, DOCX);
}));

// ---- shared link (as ImageTwin's "Shared link"): a read-only link to the PDF of a Module 4 / 5 report, for a colleague
// without an account (e.g. the integrity committee). It expires (1-30 days, default 7), can be revoked, and every
// opening is written to the audit log. Only the owner of the report can create or revoke it.
const crypto = require('crypto');
const SHARE_KINDS = ['papermill', 'images', 'integrity', 'verify', 'citations'];

router.post('/checks/:id/share', auth.requireUser, wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c?.result || !SHARE_KINDS.includes(c.row.kind)) return res.status(404).json({ success: false, message: 'Report not found.' });
  const days = Math.max(1, Math.min(30, parseInt(req.body?.days, 10) || 7));
  if (c.result.share?.token) await db.setMeta(`share:${c.result.share.token}`, '');
  const token = crypto.randomBytes(24).toString('base64url');
  const share = { token, expires: new Date(Date.now() + days * 864e5).toISOString(), by: req.user.name, at: new Date().toISOString() };
  await db.setMeta(`share:${token}`, JSON.stringify({ checkId: c.row.id, userId: req.user.id, expires: share.expires }));
  const r = await require('../reportStore').load(c.row.result);
  r.share = share;
  await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(r), c.row.id]);
  await require('../reportStore').offload(c.row.id, r);
  await auth.audit(req, 'share-create', `check ${c.row.id}`, { kind: c.row.kind, days });
  res.json({ success: true, share, url: `/api/shared/${token}` });
}));

router.delete('/checks/:id/share', auth.requireUser, wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c?.result) return res.status(404).json({ success: false, message: 'Report not found.' });
  if (c.result.share?.token) await db.setMeta(`share:${c.result.share.token}`, '');
  const r = await require('../reportStore').load(c.row.result);
  delete r.share;
  await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(r), c.row.id]);
  await require('../reportStore').offload(c.row.id, r);
  await auth.audit(req, 'share-revoke', `check ${c.row.id}`, {});
  res.json({ success: true });
}));

/** The shared report itself (no sign-in): the confidential PDF while the link is valid */
router.get('/shared/:token', wrap(async (req, res) => {
  const token = String(req.params.token || '');
  let entry = null;
  if (/^[\w-]{20,64}$/.test(token)) { try { entry = JSON.parse((await db.getMeta(`share:${token}`)) || 'null'); } catch { entry = null; } }
  if (!entry) return res.status(404).type('text/plain').send('This shared link does not exist or was revoked.');
  if (new Date(entry.expires) < new Date()) return res.status(410).type('text/plain').send('This shared link has expired. Ask the editor for a new one.');
  const c = await loadCheck(entry.userId, entry.checkId);
  if (!c?.result || c.result.share?.token !== token) return res.status(404).type('text/plain').send('This shared link does not exist or was revoked.');
  const blocks = await confidentialBlocks(c, entry.userId);
  await auth.audit({ ip: req.ip, user: { id: entry.userId, email: 'shared link' } }, 'share-open', `check ${c.row.id}`, null);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${`${c.row.kind}-${c.row.manuscript_code || c.row.id}-CONFIDENTIAL.pdf`.replace(/[^\w.\-]+/g, '_')}"`);
  res.send(await require('../pdf').buildPdf(blocks));
}));

/** Full Screening Report as Word: editor version (all modules) or author version (Modules 1-3) */
router.get('/checks/:id/screening', auth.requireUser, wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c?.result?.screening) return res.status(404).json({ success: false, message: 'Full Screening Report not found.' });
  const version = req.query.version === 'author' ? 'author' : 'editor';
  if (version === 'author' && !require('../modules').permissionsOf(req.user).includes('reports')) return res.status(403).json({ success: false, message: 'Only editors can prepare the author version.' });
  // editor version: the full Module 5 report attached to the screening goes in as section 5
  if (version === 'editor' && c.result.images?.checkId) {
    const img = await loadCheck(req.user.id, c.result.images.checkId).catch(() => null);
    if (img?.result) c.result.images.report = await IMG.withExportThumbs(img.result, req.user.id);
  }
  if (req.query.format === 'pdf') return sendFile(res, await require('../pdf').buildPdf(W.screeningBlocks(c.result, version)), `screening-${version}-${c.row.manuscript_code || c.row.id}.pdf`, 'application/pdf');
  sendFile(res, await W.buildDocx(W.screeningBlocks(c.result, version)), `screening-${version}-${c.row.manuscript_code || c.row.id}.docx`, DOCX);
}));

// ------------------------------------------------------------------ similarity report (Turnitin-style filters)

// the editor's filters - excluded sources and sections, minimum match length, minimum source share - saved with the
// report, so the export uses them
router.patch('/checks/:id/similarity', auth.requireUser, wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  const pl = c?.result?.plagiarism;
  if (!pl || pl.error) return res.status(404).json({ success: false, message: 'Similarity report not found.' });
  if ((pl.version || 0) < 3) return res.status(409).json({ success: false, message: 'This report was made with an earlier method; run the screening again to use the filters.' });
  const b = req.body || {};
  const next = await require('../checks/plagiarism').applySettings(pl, { excluded: b.excluded, minWords: b.minWords, excludeSections: b.excludeSections, minPercent: b.minPercent, minSourceWords: b.minSourceWords, includeQuotes: b.includeQuotes === true });
  const store = require('../reportStore');
  const r = await store.load(c.row.result);
  r.plagiarism = next;
  // the Full Screening front page quotes the Similarity Index: it follows the saved filters
  if (r.screening && r.references?.summary) r.screening = screeningSummary(r);
  await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(r), c.row.id]);
  await store.offload(c.row.id, r);
  await auth.audit(req, 'similarity-filters', `check ${c.row.id}`, next.settings);
  res.json({ success: true, plagiarism: next });
}));

/** The similarity report alone, as Word or PDF (confidential: it holds the manuscript text), or its sources as CSV */
router.get('/checks/:id/similarity', auth.requireUser, wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  const pl = c?.result?.plagiarism;
  if (!pl || pl.error) return res.status(404).json({ success: false, message: 'Similarity report not found.' });
  const blocks = W.similarityReportBlocks({ ...c.result, id: c.row.id });
  const name = `similarity-${c.row.manuscript_code || c.row.id}`;
  if (req.query.format === 'csv') {
    if ((pl.version || 0) < 3) return res.status(409).json({ success: false, message: 'This report was made with an earlier method; run the screening again to export its sources.' });
    return sendFile(res, Buffer.from(require('../checks/plagiarism').toCsv(pl), 'utf8'), `${name}-sources.csv`, 'text/csv; charset=utf-8');
  }
  // Turnitin's layout (cover page, Integrity Overview, top sources, highlighted submission); reports made with the
  // earliest method have no match data for it and keep the plain layout
  const X = (pl.version || 0) >= 3 ? require('../similarityExport') : null;
  const report = { ...c.result, id: c.row.id, createdAt: c.result.createdAt || c.row.created_at };
  if (req.query.format === 'pdf') return sendFile(res, X ? await X.buildSimilarityPdf(report) : await require('../pdf').buildPdf(blocks), `${name}.pdf`, 'application/pdf');
  sendFile(res, X ? await X.buildSimilarityDocx(report) : await W.buildDocx(blocks), `${name}.docx`, DOCX);
}));

// ------------------------------------------------------------------ Module 1 settings (Super Admin)

router.get('/settings/age-rule', auth.requireUser, wrap(async (req, res) => res.json({ success: true, rule: await ageRule() })));
router.put('/settings/age-rule', auth.requireSuperAdmin, wrap(async (req, res) => {
  const rule = await setAgeRule(req.body || {});
  await auth.audit(req, 'setting', 'recent_rule', rule);
  res.json({ success: true, rule });
}));

router.get('/settings/tortured', auth.requireUser, wrap(async (req, res) => {
  let list = [];
  try { list = JSON.parse((await db.getMeta('tortured_custom')) || '[]'); } catch (e) { /* empty */ }
  res.json({ success: true, list, builtIn: require('../papermill/lists').TORTURED.length });
}));
router.put('/settings/tortured', mod('papermill'), wrap(async (req, res) => {
  const list = (Array.isArray(req.body?.list) ? req.body.list : []).map(x => ({ phrase: String(x.phrase || '').trim().toLowerCase(), correct: String(x.correct || '').trim() })).filter(x => x.phrase.length >= 5 && x.correct).slice(0, 2000);
  await db.setMeta('tortured_custom', JSON.stringify(list));
  await auth.audit(req, 'setting', 'tortured_custom', { count: list.length });
  res.json({ success: true, list });
}));

// Module 4 editorial watchlist (STM Integrity Hub style): e-mails, domains, names, ORCID iDs, institutions, phones, phrases
const WL = require('../papermill/watchlist');
router.get('/settings/watchlist', mod('papermill'), wrap(async (req, res) => res.json({ success: true, list: await WL.load(), types: WL.TYPES })));
router.put('/settings/watchlist', mod('papermill'), wrap(async (req, res) => {
  const list = await WL.save(req.body?.list, req.user.name);
  await auth.audit(req, 'setting', 'papermill_watchlist', { count: list.length });
  res.json({ success: true, list });
}));
router.post('/settings/watchlist', mod('papermill'), wrap(async (req, res) => {
  const e = WL.entryOf(req.body || {}, req.user.name);
  if (!e) return res.status(400).json({ success: false, message: 'Give a type and a valid value (e-mail, domain, name, ORCID iD, institution, phone or phrase).' });
  const list = await WL.save([...(await WL.load()), e], req.user.name);
  await auth.audit(req, 'setting', 'papermill_watchlist', { added: e.type });
  res.json({ success: true, list });
}));

module.exports = router;
module.exports.runPaperMill = runPaperMill;
module.exports.manuscriptFrom = manuscriptFrom;
