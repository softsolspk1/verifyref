// routes/core.js - document intake, Reference / Citation / full manuscript checks, saved checks and their exports,
// editor report (decision summary, letters, revision comparison), Journal Check, Reviewer Finder,
// Reviewer report check and issue reports.
const express = require('express');
const cfg = require('../config');
const db = require('../db');
const auth = require('../auth');
const { permissionsOf } = require('../modules');
const { defineJob, createJob, getJob } = require('../jobs');
const P = require('../parse');
const { runCheck, saveCheck, loadCheck } = require('../pipeline');
const { checkJournal } = require('../checks/journal');
const { findReviewers } = require('../editor/reviewers');
const { checkReviewerReport } = require('../editor/reviewerReport');
const R = require('../editor/reports');
const F = require('../format');
const W = require('../docx');
const { isOnline } = require('../http');
const { enqueue, registerQueued } = require('../queue');
const { createUpload } = require('../uploads');

const router = express.Router();
const upload = require('../uploads').upload();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const user = auth.requireUser;
const mod = auth.requireModule;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function sendFile(res, buffer, filename, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`);
  res.send(buffer);
}

// ------------------------------------------------------------------ document intake

/** Presigned upload slot on Cloudflare R2 for a file too large to send through the server ({ enabled: false } when not configured) */
router.post('/uploads', user, wrap(async (req, res) => {
  res.json({ success: true, ...createUpload(req.user.id, req.body || {}) });
}));

/** Upload a manuscript / reference file: returns text, detected metadata, body & reference section */
router.post('/extract', user, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
  const doc = await P.extractDocument(req.file.buffer, req.file.originalname, req.file.mimetype).catch(e => { res.status(400).json({ success: false, message: e.message }); return null; });
  if (!doc) return;
  if (doc.entries) {
    return res.json({ success: true, filename: req.file.originalname, format: doc.format, structured: doc.entries, referencesText: doc.entries.map(e => e.raw).join('\n'), bodyText: '', meta: {}, referenceCount: doc.entries.length });
  }
  const sec = P.findReferenceSection(doc.text);
  const meta = sec.found ? P.extractManuscriptMeta(sec.body) : {};
  const { entries } = P.splitReferences(sec.found ? sec.references : doc.text);
  res.json({
    success: true, filename: req.file.originalname, format: doc.format,
    fullManuscript: sec.found && sec.body.trim().length > 500,
    referencesText: sec.found ? sec.references : doc.text, bodyText: sec.found ? sec.body : '', meta, referenceCount: entries.length
  });
}));

router.post('/parse', user, (req, res) => {
  let text = req.body.text || '';
  let bodyText = '';
  // a whole manuscript: take the list under the References heading
  if (req.body.full) {
    const sec = P.findReferenceSection(text);
    if (sec.found) { text = sec.references; bodyText = sec.body; }
  }
  const { entries, strategy } = P.splitReferences(text, req.body.strategy || 'auto');
  res.json({ success: true, strategy, bodyText, references: entries.map((e, i) => P.parseReferenceEntry(e, i + 1)) });
});

// ------------------------------------------------------------------ checks (Reference / Citation / full manuscript)

const CHECK_MODULE = { manuscript: 'manuscript', references: 'references', citations: 'citations' };

router.post('/checks', user, wrap(async (req, res) => {
  const b = req.body || {};
  const kind = CHECK_MODULE[b.kind] ? b.kind : 'manuscript';
  if (!permissionsOf(req.user).includes(CHECK_MODULE[kind])) return res.status(403).json({ success: false, message: 'Your account does not have access to this tool.' });
  if (!b.text && !b.referencesText && !(b.entries || []).length) return res.status(400).json({ success: false, message: 'Provide a manuscript or a reference list.' });
  const job = await createJob(req.user.id, 'check', { ...b, kind });
  res.json({ success: true, jobId: job.id, offline: cfg.DESKTOP && !isOnline() });
}));

async function runAndSaveCheck(b, { userId, update }) {
  const result = await runCheck({ ...b, userId }, update);
  const shingles = result._shingles;
  delete result._shingles;
  if (b.save !== false) {
    await saveCheck(userId, result, { issueId: b.issueId || null, saveMode: b.saveMode || 'full' });
    if (shingles) await require('../papermill').storeFingerprint({ checkId: result.id, userId, meta: result.meta, shingles }).catch(e => console.error('Fingerprint not stored:', e.message));
    if (b.recheckOf) result.changes = await changesSince(userId, b.recheckOf, result);
    // Desktop: references that could not be verified offline are re-checked when the connection returns
    if (cfg.DESKTOP && result.references?.summary?.pending && result.id && (b.saveMode || 'full') === 'full') {
      await enqueue(userId, { kind: 'recheck', checkId: result.id, label: `Online verification: ${result.meta.manuscriptCode || result.meta.title || 'check #' + result.id}` });
      result.queuedForOnline = result.references.summary.pending;
    }
  }
  return result;
}
defineJob('check', runAndSaveCheck);

/** Module 1 re-check: what changed since the earlier run of the same reference list */
async function changesSince(userId, prevId, result) {
  const prev = await loadCheck(userId, prevId);
  const before = new Map((prev?.result?.references?.results || []).map(r => [r.raw.trim(), r]));
  const rows = [];
  for (const r of result.references.results) {
    const p = before.get(r.raw.trim());
    if (!p) rows.push({ index: r.index, change: 'new', after: r.statusLabel, raw: r.raw });
    else if (p.status !== r.status || !!p.retraction !== !!r.retraction) rows.push({ index: r.index, change: 'status', before: p.statusLabel, after: r.statusLabel, raw: r.raw, reason: r.reason });
    before.delete(r.raw.trim());
  }
  for (const p of before.values()) rows.push({ index: p.index, change: 'removed', before: p.statusLabel, raw: p.raw });
  return { previousId: prevId, previousDate: prev?.row?.created_at || null, rows };
}

/** Re-check a saved bibliography check; the new report lists only what changed */
router.post('/checks/:id/recheck', user, wrap(async (req, res) => {
  const c = await checkOr404(req, res);
  if (!c) return;
  if (!['references', 'manuscript'].includes(c.row.kind)) return res.status(400).json({ success: false, message: 'Only bibliography checks can be re-checked.' });
  const refs = c.result.references?.results || [];
  const job = await createJob(req.user.id, 'check', { kind: 'references', referencesText: refs.map(r => r.raw).join('\n'), meta: { ...c.result.meta, version: null }, recheckOf: c.row.id, issueId: c.row.issue_id });
  res.json({ success: true, jobId: job.id });
}));
registerQueued('check', runAndSaveCheck);

router.get('/jobs/:id', user, wrap(async (req, res) => {
  const j = await getJob(req.params.id, req.user.id);
  if (!j) return res.status(404).json({ success: false, message: 'Job not found or expired.' });
  let result;
  if (j.status === 'done') {
    result = j.result;
    // Converted files are downloaded separately (GET /api/jobs/:id/file)
    if (result?.file) result = { ...result, file: { name: result.file.name, available: true } };
  }
  res.json({ success: true, status: j.status, progress: j.progress, step: j.step, error: j.error, result });
}));

router.get('/checks', user, wrap(async (req, res) => {
  const params = [req.user.id];
  let where = 'user_id = $1';
  if (req.query.issue) { params.push(req.query.issue); where += ` AND issue_id = $${params.length}`; }
  if (req.query.code) { params.push(req.query.code); where += ` AND manuscript_code = $${params.length}`; }
  if (req.query.kind) { params.push(String(req.query.kind).split(',')); where += ` AND kind = ANY($${params.length}::text[])`; }
  const rows = await db.all(`SELECT id, issue_id, kind, manuscript_code, version, title, ref_total, verified, suspicious, unverified, miscited, retracted,
    missing_citations, uncited_references, journal_flags, self_citation_rate, problems, created_at, origin, synced_at, pending_online, (result IS NOT NULL) AS has_result
    FROM checks WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params);
  res.json({ success: true, checks: rows });
}));

async function checkOr404(req, res) {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c) { res.status(404).json({ success: false, message: 'Check not found.' }); return null; }
  if (!c.result) { res.status(410).json({ success: false, message: 'This check was saved as counts only; the full report is not stored.' }); return null; }
  return c;
}

router.get('/checks/:id', user, wrap(async (req, res) => {
  const c = await checkOr404(req, res);
  if (c) res.json({ success: true, kind: c.row.kind, result: c.result });
}));

router.patch('/checks/:id', user, wrap(async (req, res) => {
  const b = req.body || {};
  const row = await db.one('SELECT id, result FROM checks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ success: false, message: 'Check not found.' });
  if ('issueId' in b) await db.query('UPDATE checks SET issue_id = $1 WHERE id = $2', [b.issueId || null, row.id]);
  if ('manuscriptCode' in b || 'title' in b) {
    await db.query('UPDATE checks SET manuscript_code = COALESCE($1, manuscript_code), title = COALESCE($2, title) WHERE id = $3', [b.manuscriptCode ?? null, b.title ?? null, row.id]);
    if (row.result?.meta) {
      const r = row.result;
      if (b.manuscriptCode !== undefined) r.meta.manuscriptCode = b.manuscriptCode;
      if (b.title !== undefined) r.meta.title = b.title;
      await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(r), row.id]);
    }
  }
  res.json({ success: true });
}));

router.delete('/checks/:id', user, wrap(async (req, res) => {
  await db.query('DELETE FROM checks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

// ------------------------------------------------------------------ editor report: decision summary, correction letter, revision comparison

router.get('/checks/:id/summary', mod('reports'), wrap(async (req, res) => {
  const c = await checkOr404(req, res);
  if (!c) return;
  const ds = R.decisionSummary(c.result);
  if (req.query.format === 'docx') return sendFile(res, await W.buildDocx(W.decisionSummaryBlocks(ds)), `decision-summary-${c.row.manuscript_code || c.row.id}.docx`, DOCX);
  res.json({ success: true, summary: ds });
}));

router.get('/checks/:id/letter', mod('reports'), wrap(async (req, res) => {
  const c = await checkOr404(req, res);
  if (!c) return;
  const letter = R.correctionLetter(c.result, req.query.lang === 'ur' ? 'ur' : 'en');
  if (req.query.format === 'docx') return sendFile(res, await W.buildDocx(W.letterBlocks(letter), { rtl: letter.rtl }), `correction-letter-${letter.lang}-${c.row.manuscript_code || c.row.id}.docx`, DOCX);
  if (req.query.format === 'txt') return sendFile(res, Buffer.from('﻿' + letter.text, 'utf8'), `correction-letter-${letter.lang}.txt`, 'text/plain; charset=utf-8');
  res.json({ success: true, letter });
}));

router.get('/checks/:id/compare/:otherId', mod('reports'), wrap(async (req, res) => {
  const a = await loadCheck(req.user.id, req.params.otherId);
  const b = await loadCheck(req.user.id, req.params.id);
  if (!a?.result || !b?.result) return res.status(404).json({ success: false, message: 'Both checks must exist with full reports saved.' });
  if (![a, b].every(c => ['manuscript', 'references'].includes(c.row.kind))) return res.status(400).json({ success: false, message: 'Only manuscript or reference checks can be compared.' });
  const cmp = R.compareRevisions(a.result, b.result);
  if (req.query.format === 'docx') return sendFile(res, await W.buildDocx(W.revisionBlocks(cmp)), `revision-comparison-${b.row.manuscript_code || b.row.id}.docx`, DOCX);
  res.json({ success: true, comparison: cmp });
}));

/** Reference report exports: CSV, BibTeX, RIS, Word, corrected list (any style) */
router.get('/checks/:id/export', user, wrap(async (req, res) => {
  const c = await checkOr404(req, res);
  if (!c) return;
  const results = c.result.references?.results || [];
  const base = `references-${c.row.manuscript_code || c.row.id}`;
  const fmt = req.query.format;
  if (fmt === 'csv') {
    const csv = F.toCsv(['#', 'Status', 'Confidence', 'Reference as written', 'Finding', 'Issues', 'Registered title', 'Registered authors', 'Year', 'Journal', 'DOI', 'Found in', 'Retraction', 'Suggested correction', 'Links'],
      results.map(r => [r.index, r.statusLabel, r.confidence, r.raw, r.reason, (r.issues || []).map(i => i.message).join('; '), r.record?.title || '', (r.record?.authors || []).map(a => `${a.family} ${a.given || ''}`.trim()).join('; '),
        r.record?.year || '', r.record?.journal || '', r.record?.doi || r.parsed?.doi || '', (r.matchedIn || []).join('; '), r.retraction ? `${r.retraction.nature} ${r.retraction.date || ''}` : '', r.suggestion || '', (r.links || []).map(l => `${l.url} (${l.status})`).join('; ')]));
    return sendFile(res, Buffer.from(csv, 'utf8'), `${base}.csv`, 'text/csv; charset=utf-8');
  }
  const records = results.map(r => r.record || { ...r.parsed, authors: r.parsed?.authors || [] });
  if (fmt === 'bibtex') return sendFile(res, Buffer.from(F.toBibtex(records), 'utf8'), `${base}.bib`, 'application/x-bibtex; charset=utf-8');
  if (fmt === 'ris') return sendFile(res, Buffer.from(F.toRis(records), 'utf8'), `${base}.ris`, 'application/x-research-info-systems; charset=utf-8');
  const blocksOf = r => (c.row.kind === 'citations' ? W.citationsBlocks(r) : c.row.kind === 'papermill' ? W.papermillBlocks(r) : c.row.kind === 'images' ? W.imagesBlocks(r)
    : c.row.kind === 'screening' ? W.screeningBlocks(r, 'editor') : W.referenceReportBlocks(r));
  if (fmt === 'docx') return sendFile(res, await W.buildDocx(blocksOf(c.result)), `${base}.docx`, DOCX);
  if (fmt === 'pdf') return sendFile(res, await require('../pdf').buildPdf(blocksOf(c.result)), `${base}.pdf`, 'application/pdf');
  if (fmt === 'corrected') {
    const style = req.query.style || c.result.references.style || 'pjps';
    const txt = results.map((r, i) => `${i + 1}. ${r.record && !['suspicious', 'pending'].includes(r.status) ? F.formatReference(r.record, style) : r.raw.replace(/^\s*(\[\d+\]|\d+[.)])\s*/, '')}`).join('\n');
    return sendFile(res, Buffer.from('﻿' + txt, 'utf8'), `${base}-corrected.txt`, 'text/plain; charset=utf-8');
  }
  res.status(400).json({ success: false, message: 'Unknown export format.' });
}));

// ------------------------------------------------------------------ Journal Check (single journal lookup)

router.post('/journal-check', mod('journal-check'), wrap(async (req, res) => {
  const { name, issn } = req.body || {};
  if (!name && !issn) return res.status(400).json({ success: false, message: 'Enter a journal name or ISSN.' });
  res.json({ success: true, journal: await checkJournal({ name: String(name || '').trim(), issn: String(issn || '').trim() }) });
}));

// ------------------------------------------------------------------ Reviewer Finder

router.post('/reviewers', mod('reviewers'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title || b.title.trim().length < 10) return res.status(400).json({ success: false, message: 'Enter the manuscript title (and ideally the abstract).' });
  const input = {
    title: b.title.trim(),
    abstract: (b.abstract || '').trim(),
    keywords: Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[;,]/).map(s => s.trim()).filter(Boolean),
    authors: String(b.authors || '').split(/\s*[;\n]\s*|\s*,\s*(?=[A-Z])/).map(s => s.trim()).filter(Boolean),
    affiliations: String(b.affiliations || '').split('\n').map(s => s.trim()).filter(Boolean),
    exclude: String(b.exclude || '').split(/\s*[;\n]\s*/).map(s => s.trim()).filter(Boolean),
    yearsBack: parseInt(b.yearsBack || '5', 10),
    limit: Math.min(parseInt(b.limit || '25', 10), 50)
  };
  if (cfg.DESKTOP && !isOnline()) return res.status(503).json({ success: false, message: 'Reviewer Finder needs an internet connection (it searches recent publications).' });
  const job = await createJob(req.user.id, 'reviewers', input);
  res.json({ success: true, jobId: job.id });
}));

defineJob('reviewers', (input, { update }) => findReviewers(input, { onProgress: update }));

router.post('/reviewers/export', mod('reviewers'), wrap(async (req, res) => {
  const data = req.body?.data;
  if (!data?.candidates) return res.status(400).json({ success: false, message: 'Nothing to export.' });
  if (req.body.format === 'csv') {
    const csv = F.toCsv(['Name', 'ORCID', 'Institution', 'Country', 'h-index', 'Works', 'Relevant papers', 'Works this year', 'Conflicts of interest', 'Retractions', 'Evidence', 'OpenAlex'],
      data.candidates.map(c => [c.name, c.orcid || '', c.institution || '', c.country || '', c.hIndex ?? '', c.worksCount ?? '', c.relevantCount, c.workloadThisYear, c.coi.map(x => x.message).join('; '), c.retractions.length, c.relevantWorks.map(w => `${w.title} (${w.year}${w.doi ? ', doi:' + w.doi : ''})`).join(' | '), c.profileUrl]));
    return sendFile(res, Buffer.from(csv, 'utf8'), 'reviewer-candidates.csv', 'text/csv; charset=utf-8');
  }
  sendFile(res, await W.buildDocx(W.reviewersBlocks(data)), 'reviewer-candidates.docx', DOCX);
}));

// ------------------------------------------------------------------ Reviewer report check

router.post('/reviewer-report', mod('reviewer-report'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.text || b.text.trim().length < 30) return res.status(400).json({ success: false, message: 'Paste the reviewer report text.' });
  let manuscript = { title: b.title || '', abstract: b.abstract || '', keywords: String(b.keywords || '').split(/[;,]/).map(s => s.trim()).filter(Boolean) };
  if (b.checkId) {
    const c = await loadCheck(req.user.id, b.checkId);
    if (c?.result?.meta) manuscript = { title: manuscript.title || c.result.meta.title, abstract: manuscript.abstract || c.result.meta.abstract, keywords: manuscript.keywords.length ? manuscript.keywords : c.result.meta.keywords };
  }
  const job = await createJob(req.user.id, 'reviewer-report', { b, manuscript });
  res.json({ success: true, jobId: job.id });
}));

defineJob('reviewer-report', async ({ b, manuscript }, { userId, update }) => {
  update('Extracting citation requests', 5);
  const out = await checkReviewerReport({ text: b.text, reviewer: { name: b.reviewerName || '', orcid: b.reviewerOrcid || '' }, manuscript }, {
    onProgress: (d, n) => update(`Verifying requested references (${d}/${n})`, 10 + d / n * 80)
  });
  out.manuscript = manuscript;
  if (b.save !== false) {
    await db.query(`INSERT INTO checks(user_id, kind, manuscript_code, title, ref_total, problems, result, origin) VALUES($1, 'reviewer-report', $2, $3, $4, $5, $6, $7)`,
      [userId, b.manuscriptCode || null, `Reviewer report${b.reviewerName ? ' — ' + b.reviewerName : ''}${manuscript.title ? ': ' + manuscript.title : ''}`.slice(0, 300), out.items.length, JSON.stringify(out.flags.map(f => f.message)), JSON.stringify(out), cfg.DESKTOP ? 'desktop' : 'web']);
  }
  return out;
});

// ------------------------------------------------------------------ issues & issue report

router.get('/issues', user, wrap(async (req, res) => {
  const rows = await db.all(`SELECT i.*, COUNT(c.id)::int AS manuscripts FROM issues i LEFT JOIN checks c ON c.issue_id = i.id AND c.kind IN ('manuscript','references')
    WHERE i.user_id = $1 GROUP BY i.id ORDER BY i.created_at DESC`, [req.user.id]);
  res.json({ success: true, issues: rows });
}));

router.post('/issues', mod('issues'), wrap(async (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ success: false, message: 'Enter an issue label, e.g. "Vol. 39, No. 6 (2026)".' });
  const row = await db.one('INSERT INTO issues(user_id, label) VALUES($1, $2) RETURNING *', [req.user.id, label]);
  res.json({ success: true, issue: row });
}));

router.delete('/issues/:id', mod('issues'), wrap(async (req, res) => {
  await db.query('DELETE FROM issues WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

/** Issue report (by issue id) or period report (?months=1|3|6|12) */
router.get('/issue-report', mod('issues'), wrap(async (req, res) => {
  let rows, label;
  if (req.query.issue) {
    const issue = await db.one('SELECT * FROM issues WHERE id = $1 AND user_id = $2', [req.query.issue, req.user.id]);
    if (!issue) return res.status(404).json({ success: false, message: 'Issue not found.' });
    label = issue.label;
    rows = await db.all(`SELECT * FROM checks WHERE user_id = $1 AND issue_id = $2 AND kind IN ('manuscript','references') ORDER BY manuscript_code, version`, [req.user.id, issue.id]);
  } else {
    const months = Math.min(parseInt(req.query.months || '3', 10), 24);
    label = `Last ${months} month(s)`;
    rows = await db.all(`SELECT * FROM checks WHERE user_id = $1 AND kind IN ('manuscript','references') AND created_at > now() - ($2 || ' months')::interval ORDER BY created_at DESC`, [req.user.id, String(months)]);
  }
  // Latest version per manuscript only
  const latest = new Map();
  for (const r of rows) {
    const k = r.manuscript_code || `#${r.id}`;
    if (!latest.has(k) || latest.get(k).version < r.version) latest.set(k, r);
  }
  const rep = R.issueReport([...latest.values()]);
  if (req.query.format === 'docx') return sendFile(res, await W.buildDocx(W.issueReportBlocks(label, rep)), `issue-report.docx`, DOCX);
  if (req.query.format === 'csv') {
    const csv = F.toCsv(['Manuscript', 'Version', 'Title', 'Date', 'References', 'Verified', 'Suspicious', 'Retracted', 'Miscited', 'Unverified', 'Missing citations', 'Uncited', 'High-risk journals', 'Self-citation %', 'Problems'],
      rep.rows.map(r => [r.manuscriptCode, r.version, r.title, new Date(r.date).toISOString().slice(0, 10), r.references, r.verified, r.suspicious, r.retracted, r.miscited, r.unverified, r.missingCitations, r.uncited, r.journalFlags, r.selfCitationRate, r.problems.join('; ')]));
    return sendFile(res, Buffer.from(csv, 'utf8'), 'issue-report.csv', 'text/csv; charset=utf-8');
  }
  res.json({ success: true, label, report: rep });
}));

module.exports = router;
