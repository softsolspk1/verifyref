// routes/screening.js - PJPS v4 editor modules: Module 4 Paper Mill Detection, Module 5 Image Integrity Detection,
// the editor's decision record on a saved report, and the Module 1 reference-age rule.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const P = require('../parse');
const W = require('../docx');
const { defineJob, createJob } = require('../jobs');
const { prepare, normalizeMeta, saveResult, loadCheck } = require('../pipeline');
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
    title: b.title || d.title || ms.filename, manuscriptCode: b.manuscriptCode || '', abstract: b.abstract || d.abstract || '',
    authors: lines(b.authors).length ? lines(b.authors) : (d.authors || []).map(a => a.name),
    affiliations: lines(b.affiliations).length ? lines(b.affiliations) : d.affiliations || [], keywords: b.keywords || d.keywords || [], version: b.version || null
  });
  const job = await createJob(req.user.id, 'papermill', { text: ms.text, bodyText: ms.bodyText, referencesText: ms.referencesText, meta, suggestedReviewers: b.suggestedReviewers || '', imagesCheckId: b.imagesCheckId || null, save: b.save !== 'false' });
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
  const result = await detectPaperMill({ text: input.text, body: input.bodyText, meta: input.meta, references, pattern, suggestedReviewers: input.suggestedReviewers, images },
    (s, p) => update(s, 55 + (p || 0) * 0.43));
  const shingles = result._shingles;
  delete result._shingles;
  result.referenceSummary = references.length ? { total: references.length, suspicious: references.filter(r => r.status === 'suspicious').length, retracted: references.filter(r => r.status === 'retracted').length } : null;
  if (input.save !== false) {
    await saveResult(userId, 'papermill', result, { title: input.meta.title || 'Paper mill screening', manuscriptCode: input.meta.manuscriptCode, refTotal: references.length, problems: papermillProblems(result), counts: { suspicious: result.risk.highSignals } });
    await storeFingerprint({ checkId: result.id, userId, meta: input.meta, shingles }).catch(e => console.error('Fingerprint not stored:', e.message));
  }
  return result;
}
defineJob('papermill', runPaperMill);

// ------------------------------------------------------------------ Module 5: Image Integrity (analysis runs in the browser)

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
  out.checkedAt = new Date().toISOString();
  if (input.checkId) {
    const c = await loadCheck(userId, input.checkId);
    if (c?.result && c.row.kind === 'images') {
      c.result.authorFigures = out;
      delete c.result.id; delete c.result.createdAt; delete c.result.issueId;
      c.result.summary = { ...c.result.summary, authorFigureMatches: out.matches.length };
      await db.query('UPDATE checks SET result = $1 WHERE id = $2 AND user_id = $3', [JSON.stringify(c.result), c.row.id, userId]);
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
router.get('/images/public', mod('images'), wrap(async (req, res) => res.json({ success: true, datasets: PUB.catalog(), benchmark: PUB.benchmark() })));
router.get('/images/public/cases', mod('images'), wrap(async (req, res) => res.json({ success: true, ...PUB.cases({ q: req.query.q, oa: req.query.oa === '1', reason: req.query.reason, page: Math.max(1, parseInt(req.query.page, 10) || 1) }) })));
router.get('/images/public/figures/:pmcid', mod('images'), wrap(async (req, res) => {
  try { res.json({ success: true, ...(await PUB.figures(req.params.pmcid)) }); } catch (e) { res.status(404).json({ success: false, message: e.message }); }
}));

router.get('/images/vendor', mod('images'), wrap(async (req, res) => res.json({ success: true, ...(await IMG.vendorStatus()) })));

// ------------------------------------------------------------------ editor decision record (Modules 4, 5, Full Screening Report)

const DECISIONS = { cleared: 'Cleared', investigate: 'Needs investigation', committee: 'Referred to the integrity committee', 'return': 'Returned to the authors', proceed: 'Proceed to peer review' };

router.put('/checks/:id/decision', auth.requireUser, wrap(async (req, res) => {
  const row = await db.one('SELECT id, kind, result FROM checks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row?.result) return res.status(404).json({ success: false, message: 'Report not found.' });
  const b = req.body || {};
  if (b.decision && !DECISIONS[b.decision]) return res.status(400).json({ success: false, message: 'Unknown decision.' });
  const r = row.result;
  const notes = String(b.notes || '').slice(0, 5000);
  let entry = r.decision || null;
  // Only a changed decision or note is a new entry in the history (saving finding marks alone is not)
  if (!entry || entry.decision !== (b.decision || null) || entry.notes !== notes) {
    entry = { decision: b.decision || null, label: DECISIONS[b.decision] || null, notes, by: req.user.name, at: new Date().toISOString() };
    r.decision = entry;
    if (entry.decision || entry.notes) r.decisionHistory = [...(r.decisionHistory || []), entry].slice(-20);
  }
  if (Array.isArray(b.findingMarks)) r.findingMarks = b.findingMarks.slice(0, 500);
  await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(r), row.id]);
  await auth.audit(req, 'decision', `check ${row.id}`, { kind: row.kind, decision: entry?.decision || null });
  res.json({ success: true, decision: entry });
}));

/** Confidential Word export of a Module 4 / Module 5 report */
router.get('/checks/:id/confidential', auth.requireUser, wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c?.result) return res.status(404).json({ success: false, message: 'Report not found.' });
  const kind = c.row.kind;
  const blocks = kind === 'papermill' ? W.papermillBlocks(c.result) : kind === 'images' ? W.imagesBlocks(c.result) : null;
  if (!blocks) return res.status(400).json({ success: false, message: 'No confidential export for this report.' });
  if (req.query.format === 'pdf') return sendFile(res, await require('../pdf').buildPdf(blocks), `${kind}-${c.row.manuscript_code || c.row.id}-CONFIDENTIAL.pdf`, 'application/pdf');
  sendFile(res, await W.buildDocx(blocks), `${kind}-${c.row.manuscript_code || c.row.id}-CONFIDENTIAL.docx`, DOCX);
}));

/** Full Screening Report as Word: editor version (all modules) or author version (Modules 1-3) */
router.get('/checks/:id/screening', auth.requireUser, wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c?.result?.screening) return res.status(404).json({ success: false, message: 'Full Screening Report not found.' });
  const version = req.query.version === 'author' ? 'author' : 'editor';
  if (version === 'author' && !require('../modules').permissionsOf(req.user).includes('reports')) return res.status(403).json({ success: false, message: 'Only editors can prepare the author version.' });
  if (req.query.format === 'pdf') return sendFile(res, await require('../pdf').buildPdf(W.screeningBlocks(c.result, version)), `screening-${version}-${c.row.manuscript_code || c.row.id}.pdf`, 'application/pdf');
  sendFile(res, await W.buildDocx(W.screeningBlocks(c.result, version)), `screening-${version}-${c.row.manuscript_code || c.row.id}.docx`, DOCX);
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

module.exports = router;
module.exports.runPaperMill = runPaperMill;
module.exports.manuscriptFrom = manuscriptFrom;
