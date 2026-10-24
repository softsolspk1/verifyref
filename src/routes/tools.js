// routes/tools.js - Reference Style, Manuscript Format, Verify Citations, Find Evidence, Find a Journal,
// Find & Check a Conference, Thesis/Paper Assistant and Find by Author. Long runs are background jobs; on the
// desktop, online-only tools are queued while offline and run when the connection returns.
const express = require('express');
const multer = require('multer');
const cfg = require('../config');
const auth = require('../auth');
const P = require('../parse');
const F = require('../format');
const W = require('../docx');
const { isOnline } = require('../http');
const { defineJob, createJob, getJob } = require('../jobs');
const { enqueue, registerQueued } = require('../queue');
const { restyleList, restyleDocx } = require('../tools/restyle');
const { formatManuscript } = require('../tools/msformat');
const { verifyCitations } = require('../tools/verify');
const { runCitationsModule, citationProblems } = require('../tools/citationsModule');
const { saveResult, normalizeMeta } = require('../pipeline');
const { findEvidence } = require('../tools/evidence');
const { findJournals } = require('../tools/journalFinder');
const { findConferences, checkConference } = require('../tools/conferences');
const { runAssistant } = require('../tools/assistant');
const { searchAuthors, authorWorks } = require('../tools/authors');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 41 } });
const mod = auth.requireModule;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function sendFile(res, buffer, filename, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`);
  res.send(buffer);
}

/**
 * Start a tool job, or on the desktop while offline queue it (online-only tools).
 * Returns { jobId } or { queued, message }.
 */
async function start(req, res, kind, input, { onlineOnly = false, label = kind } = {}) {
  if (cfg.DESKTOP && onlineOnly && !isOnline()) {
    await enqueue(req.user.id, { kind: 'job', input: { job: kind, data: input }, label });
    return res.json({ success: true, queued: true, message: 'No internet connection — this run was added to the offline queue and will start automatically when the connection returns. The result will appear in My Activity.' });
  }
  const job = await createJob(req.user.id, kind, input);
  res.json({ success: true, jobId: job.id });
}

/** Register a job kind for both the job runner and the offline queue */
function tool(kind, fn) {
  defineJob(kind, fn);
  registerQueued(kind, fn);
}

const fileOf = req => (req.file ? { name: req.file.originalname, base64: req.file.buffer.toString('base64') } : null);
const bool = (v, d = true) => (v === undefined || v === '' ? d : !(v === false || v === 'false' || v === '0'));

// ------------------------------------------------------------------ Reference Style

router.post('/restyle', mod('restyle'), upload.single('file'), wrap(async (req, res) => {
  const b = req.body || {};
  const file = fileOf(req);
  if (!file && !String(b.text || '').trim()) return res.status(400).json({ success: false, message: 'Upload a Word document or paste a reference list.' });
  if (file && !/\.docx$/i.test(file.name)) return res.status(400).json({ success: false, message: 'Upload an editable Word document (.docx). PDF does not keep an editable structure.' });
  await start(req, res, 'restyle', { file, text: b.text || '', style: b.style || 'pjps', lookup: bool(b.lookup), save: bool(b.save), track: bool(b.track, false), trackAuthor: req.user.name, manuscriptCode: b.manuscriptCode || '' }, { label: `Reference Style: ${file?.name || 'reference list'}` });
}));

tool('restyle', async (input, { userId, update }) => {
  const onProgress = (d, n) => update(`Matching references to registered records (${d}/${n})`, 5 + d / n * 80);
  let result, out = null;
  if (input.file) {
    const r = await restyleDocx(Buffer.from(input.file.base64, 'base64'), input.style, { lookup: input.lookup, onProgress, track: input.track, trackAuthor: `${input.trackAuthor || 'Editor'} (PJPS Reference Checker)` });
    result = r.result;
    out = { base64: r.buffer.toString('base64'), name: input.file.name.replace(/\.docx$/i, `-${result.style}.docx`) };
  } else {
    result = await restyleList(input.text, input.style, { lookup: input.lookup, onProgress });
  }
  result.kind = 'restyle';
  result.filename = input.file?.name || null;
  const cs = result.compliance?.summary;
  if (input.save) await saveResult(userId, 'restyle', result, { title: `${result.styleLabel}: ${input.file?.name || 'reference list'}`, manuscriptCode: input.manuscriptCode, refTotal: result.counts.total, problems: cs && cs.nonCompliant ? [`${cs.nonCompliant} of ${cs.total} references not in PJPS style (${cs.score}% compliant)`] : [] });
  return { ...result, file: out };
});

// ------------------------------------------------------------------ Manuscript Format

router.post('/format', mod('format'), upload.single('file'), wrap(async (req, res) => {
  const b = req.body || {};
  const file = fileOf(req);
  if (!file || !/\.docx$/i.test(file.name)) return res.status(400).json({ success: false, message: 'Upload the manuscript as an editable Word document (.docx).' });
  await start(req, res, 'format', { file, template: b.template || 'springer', articleType: b.articleType || 'research', style: b.style || '', restyle: bool(b.restyle), lookup: bool(b.lookup), save: bool(b.save) }, { label: `Manuscript Format: ${file.name}` });
}));

tool('format', async (input, { userId, update }) => {
  update('Converting citations and references', 5);
  const r = await formatManuscript(Buffer.from(input.file.base64, 'base64'), { ...input, style: input.style || undefined, onProgress: (d, n) => update(`Matching references (${d}/${n})`, 5 + d / n * 80) });
  update('Applying the template', 92);
  const result = { kind: 'format', filename: input.file.name, ...r.result };
  if (input.save) await saveResult(userId, 'format', result, { title: `${result.templateLabel}: ${input.file.name}`, refTotal: result.restyle?.counts?.total || 0 });
  return { ...result, file: { base64: r.buffer.toString('base64'), name: input.file.name.replace(/\.docx$/i, `-${input.template}.docx`) } };
});

// ------------------------------------------------------------------ Verify Citations

router.post('/verify', mod('verify'), upload.fields([{ name: 'manuscript', maxCount: 1 }, { name: 'sources', maxCount: 40 }]), wrap(async (req, res) => {
  const b = req.body || {};
  const input = { meta: { title: b.title || '', manuscriptCode: b.manuscriptCode || '' }, mapping: b.mapping ? JSON.parse(b.mapping) : {}, save: bool(b.save) };
  const ms = req.files?.manuscript?.[0];
  if (ms) {
    const doc = await P.extractDocument(ms.buffer, ms.originalname, ms.mimetype);
    const sec = P.findReferenceSection(doc.text);
    if (!sec.found) return res.status(400).json({ success: false, message: 'No "References" section was found in the manuscript.' });
    Object.assign(input, { bodyText: sec.body, referencesText: sec.references });
    if (!input.meta.title) input.meta.title = P.extractManuscriptMeta(sec.body).title || ms.originalname;
  } else if (String(b.text || '').trim()) {
    input.text = b.text;
  } else {
    return res.status(400).json({ success: false, message: 'Upload the manuscript or paste its text including the reference list.' });
  }
  input.files = (req.files?.sources || []).map(f => ({ name: f.originalname, base64: f.buffer.toString('base64') }));
  await start(req, res, 'verify', input, { onlineOnly: input.files.length === 0, label: `Verify Citations: ${input.meta.title || 'manuscript'}` });
}));

tool('verify', async (input, { userId, update }) => {
  const files = (input.files || []).map(f => ({ name: f.name, buffer: Buffer.from(f.base64, 'base64') }));
  const result = await verifyCitations(input, files, update);
  if (input.save !== false) {
    const s = result.summary;
    await saveResult(userId, 'verify', result, {
      title: input.meta?.title || 'Verify Citations', manuscriptCode: input.meta?.manuscriptCode, refTotal: result.references.summary.total,
      counts: { verified: s.full, unverified: s.partial + s.couldNotVerify, suspicious: s.unsupported, retracted: result.references.summary.retracted },
      problems: [s.unsupported ? `${s.unsupported} unsupported citation(s)` : null, s.partial ? `${s.partial} partially supported` : null].filter(Boolean),
      pending: result.references.summary.pending || 0
    });
  }
  return result;
});

// ------------------------------------------------------------------ Module 3: Citations (list matching + claim support + patterns)

router.post('/citations', mod('citations'), upload.fields([{ name: 'manuscript', maxCount: 1 }, { name: 'sources', maxCount: 40 }]), wrap(async (req, res) => {
  const b = req.body || {};
  const input = {
    meta: { title: b.title || '', manuscriptCode: b.manuscriptCode || '', authors: String(b.authors || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean), abstract: b.abstract || '', keywords: String(b.keywords || '').split(',').map(s => s.trim()).filter(Boolean) },
    mapping: b.mapping ? JSON.parse(b.mapping) : {}, claims: bool(b.claims), save: bool(b.save)
  };
  const ms = req.files?.manuscript?.[0];
  if (ms) {
    const doc = await P.extractDocument(ms.buffer, ms.originalname, ms.mimetype);
    const sec = P.findReferenceSection(doc.text);
    if (!sec.found) return res.status(400).json({ success: false, message: 'No "References" section was found in the manuscript.' });
    Object.assign(input, { bodyText: sec.body, referencesText: sec.references });
    const meta = P.extractManuscriptMeta(sec.body);
    if (!input.meta.title) input.meta.title = meta.title || ms.originalname;
    if (!input.meta.authors.length) input.meta.authors = (meta.authors || []).map(a => a.name);
    if (!input.meta.abstract) input.meta.abstract = meta.abstract || '';
  } else if (String(b.text || '').trim()) {
    input.text = b.text;
  } else {
    return res.status(400).json({ success: false, message: 'Upload the manuscript or paste its text including the reference list.' });
  }
  input.meta = normalizeMeta(input.meta);
  input.files = (req.files?.sources || []).map(f => ({ name: f.originalname, base64: f.buffer.toString('base64') }));
  await start(req, res, 'citations-module', input, { label: `Citations: ${input.meta.title || 'manuscript'}` });
}));

tool('citations-module', async (input, { userId, update }) => {
  const files = (input.files || []).map(f => ({ name: f.name, buffer: Buffer.from(f.base64, 'base64') }));
  const result = await runCitationsModule(input, files, update);
  if (input.save !== false) {
    const s = result.summary;
    await saveResult(userId, 'citations', result, {
      title: input.meta?.title || 'Citations', manuscriptCode: input.meta?.manuscriptCode, refTotal: s.references,
      counts: { verified: s.full, suspicious: s.unsupported, unverified: s.partial + s.couldNotVerify, retracted: result.claims?.references?.summary?.retracted || 0 },
      problems: citationProblems(result)
    });
  }
  return result;
});

// ------------------------------------------------------------------ Find Evidence

router.post('/evidence', mod('evidence'), wrap(async (req, res) => {
  const b = req.body || {};
  if (String(b.claim || '').trim().length < 15) return res.status(400).json({ success: false, message: 'Enter the sentence that needs a source.' });
  await start(req, res, 'evidence', { claim: b.claim, context: b.context || '', style: b.style || 'apa7', scope: b.scope || 'any', save: b.save !== false }, { onlineOnly: true, label: `Find Evidence: ${String(b.claim).slice(0, 60)}` });
}));

tool('evidence', async (input, { userId, update }) => {
  const result = await findEvidence(input, update);
  if (input.save !== false) await saveResult(userId, 'evidence', result, { title: `Evidence: ${input.claim}`, refTotal: result.results.length });
  return result;
});

// ------------------------------------------------------------------ Find a Journal

router.post('/journal-finder', mod('journal-finder'), wrap(async (req, res) => {
  const b = req.body || {};
  if (String(b.title || '').trim().length < 10) return res.status(400).json({ success: false, message: 'Enter the paper title (the abstract improves the match).' });
  await start(req, res, 'journal-finder', { title: b.title, abstract: b.abstract || '', yearsBack: 3, save: b.save !== false }, { onlineOnly: true, label: `Find a Journal: ${String(b.title).slice(0, 60)}` });
}));

tool('journal-finder', async (input, { userId, update }) => {
  const result = await findJournals(input, update);
  if (input.save !== false) await saveResult(userId, 'journal-finder', result, { title: `Journals for: ${input.title}`, refTotal: result.journals.length });
  return result;
});

router.post('/journal-finder/export', mod('journal-finder'), wrap(async (req, res) => {
  const list = req.body?.journals || [];
  const csv = F.toCsv(['Journal', 'Publisher', 'ISSN', 'Similar papers (3 yrs)', 'Scope match', 'Scopus', 'SJR quartile', 'Web of Science', 'JCR quartile', 'HEC HJRS', 'MEDLINE', 'DOAJ', 'Open access', 'APC (USD)', 'Diamond OA', 'Weeks to publication', 'Articles last year', 'Risk signals', 'Example paper', 'Homepage'],
    list.map(j => [j.name, j.publisher || '', (j.issns || []).join(' '), j.similar, j.scopeMatch, j.indexing.scopus === null ? 'unknown' : j.indexing.scopus ? 'yes' : 'no', j.indexing.sjrQuartile ? `Q${j.indexing.sjrQuartile}` : '', (j.indexing.wos || []).join(' '),
      j.indexing.jcrQuartile ? `Q${j.indexing.jcrQuartile}` : '', j.indexing.hjrs || '', j.indexing.medline === null ? '' : j.indexing.medline ? 'yes' : 'no', j.doaj ? 'yes' : 'no', j.oa ? 'yes' : 'no', j.apcUsd ?? '', j.diamond ? 'yes' : 'no',
      j.weeksToPublication || '', j.worksLastYear, (j.flags || []).map(f => f.message).join('; '), j.samples?.[0]?.title || '', j.homepage || '']));
  sendFile(res, Buffer.from(csv, 'utf8'), 'journal-suggestions.csv', 'text/csv; charset=utf-8');
}));

// ------------------------------------------------------------------ Conferences

router.post('/conferences/find', mod('conferences'), wrap(async (req, res) => {
  const b = req.body || {};
  if (String(b.title || '').trim().length < 10) return res.status(400).json({ success: false, message: 'Enter the paper title.' });
  await start(req, res, 'conferences', { title: b.title, abstract: b.abstract || '', save: b.save !== false }, { onlineOnly: true, label: `Find a Conference: ${String(b.title).slice(0, 60)}` });
}));

tool('conferences', async (input, { userId, update }) => {
  const result = await findConferences(input, update);
  if (input.save !== false) await saveResult(userId, 'conferences', result, { title: `Conferences for: ${input.title}`, refTotal: result.conferences.length });
  return result;
});

router.get('/conferences/check', mod('conferences'), wrap(async (req, res) => {
  if (cfg.DESKTOP && !isOnline()) return res.status(503).json({ success: false, message: 'Checking a conference needs an internet connection.' });
  res.json({ success: true, ...(await checkConference({ query: req.query.q })) });
}));

// ------------------------------------------------------------------ Thesis / Paper Assistant

router.post('/assistant', mod('assistant'), wrap(async (req, res) => {
  const b = req.body || {};
  if (String(b.topic || '').trim().length < 4) return res.status(400).json({ success: false, message: 'Enter a topic or a few keywords.' });
  const input = {
    topic: b.topic, draftType: b.draftType === 'thesis' ? 'thesis' : 'article', section: b.section || 'introduction', style: b.style || 'apa7', focus: b.focus || '',
    yearFrom: b.yearFrom || '', yearTo: b.yearTo || '', keyPapers: (Array.isArray(b.keyPapers) ? b.keyPapers : String(b.keyPapers || '').split('\n')).map(s => s.trim()).filter(Boolean).slice(0, 3), save: b.save !== false
  };
  await start(req, res, 'assistant', input, { onlineOnly: true, label: `Thesis/Paper Assistant: ${String(b.topic).slice(0, 60)}` });
}));

tool('assistant', async (input, { userId, update }) => {
  const result = await runAssistant(input, update);
  if (input.save !== false) await saveResult(userId, 'assistant', result, { title: `${{ introduction: 'Introduction', review: 'Literature review', gap: 'Research gaps' }[result.section]}: ${input.topic}`, refTotal: result.references.length });
  return result;
});

// ------------------------------------------------------------------ Find by Author

router.get('/authors', mod('authors'), wrap(async (req, res) => {
  if (cfg.DESKTOP && !isOnline()) return res.status(503).json({ success: false, message: 'Author search needs an internet connection.' });
  res.json({ success: true, ...(await searchAuthors({ name: req.query.name, topic: req.query.topic })) });
}));

router.get('/authors/:id/works', mod('authors'), wrap(async (req, res) => {
  if (cfg.DESKTOP && !isOnline()) return res.status(503).json({ success: false, message: 'Author search needs an internet connection.' });
  res.json({ success: true, ...(await authorWorks({ id: req.params.id, style: req.query.style, topic: req.query.topic })) });
}));

/** Re-format a list of records in another style (author lists, evidence, assistant references) */
router.post('/format-records', auth.requireUser, (req, res) => {
  const ST = require('../styles');
  const style = ST.styleKey(req.body?.style);
  const records = (req.body?.records || []).slice(0, 500);
  const items = ST.orderBibliography(records.map((r, i) => ({ record: r, firstCited: i })), style);
  res.json({ success: true, style, entries: items.map((it, i) => { const e = ST.entry(it.record, style); const pre = ST.getStyle(style).kind === 'numeric' ? `${i + 1}. ` : ''; return { text: pre + ST.toText(e), html: pre + ST.toHtml(e) }; }) });
});

// ------------------------------------------------------------------ files and exports

/** Converted Word file produced by a restyle/format job */
router.get('/jobs/:id/file', auth.requireUser, wrap(async (req, res) => {
  const j = await getJob(req.params.id, req.user.id);
  const f = j?.status === 'done' && j.result?.file;
  if (!f) return res.status(404).json({ success: false, message: 'The converted file is no longer available (files are kept for one day). Run the conversion again.' });
  sendFile(res, Buffer.from(f.base64, 'base64'), f.name, DOCX);
}));

/** Word report for a tool result held in the browser or saved in My Activity */
router.post('/export/docx', auth.requireUser, wrap(async (req, res) => {
  const { kind, data } = req.body || {};
  const builders = { citations: W.citationsBlocks, papermill: W.papermillBlocks, verify: W.verifyBlocks, evidence: W.evidenceBlocks, assistant: W.assistantBlocks, 'journal-finder': W.journalFinderBlocks, conferences: W.conferenceBlocks, restyle: W.restyleBlocks, format: W.formatBlocks, authors: W.authorBlocks };
  if (!builders[kind] || !data) return res.status(400).json({ success: false, message: 'Nothing to export.' });
  sendFile(res, await W.buildDocx(builders[kind](data)), `${kind}-report.docx`, DOCX);
}));

router.post('/export/csv', auth.requireUser, wrap(async (req, res) => {
  const { kind, data } = req.body || {};
  if (kind === 'verify') {
    const rows = data.claims.flatMap(c => c.citations.map(x => [c.claim, x.refIndex, x.refStatusLabel, x.verdictLabel, x.score ?? '', x.evidence?.quote || '', x.evidence ? `${x.evidence.origin}${x.evidence.page ? ' p.' + x.evidence.page : ''}` : '', x.notes.join('; '), x.refRaw]));
    return sendFile(res, Buffer.from(F.toCsv(['Claim', 'Reference #', 'Reference status', 'Verdict', 'Match score', 'Evidence', 'Evidence source', 'Notes', 'Reference'], rows), 'utf8'), 'verify-citations.csv', 'text/csv; charset=utf-8');
  }
  if (kind === 'authors') {
    return sendFile(res, Buffer.from(F.toCsv(['Year', 'Title', 'Journal', 'DOI', 'Citations', 'Reference'], data.works.map(w => [w.year, w.title, w.journal, w.doi || '', w.citedBy ?? '', w.text])), 'utf8'), 'author-publications.csv', 'text/csv; charset=utf-8');
  }
  if (kind === 'bibtex' || kind === 'ris') {
    const recs = data.records || [];
    return sendFile(res, Buffer.from(kind === 'bibtex' ? F.toBibtex(recs) : F.toRis(recs), 'utf8'), `references.${kind === 'bibtex' ? 'bib' : 'ris'}`, 'text/plain; charset=utf-8');
  }
  res.status(400).json({ success: false, message: 'Unknown export.' });
}));

/** Save a result shown in the browser (e.g. an author's publication list) to My Activity */
router.post('/activity/save', auth.requireUser, wrap(async (req, res) => {
  const { kind, title, result } = req.body || {};
  if (!['authors', 'conferences', 'evidence'].includes(kind) || !result) return res.status(400).json({ success: false, message: 'Nothing to save.' });
  const id = await saveResult(req.user.id, kind, { ...result, kind }, { title: String(title || kind).slice(0, 300) });
  res.json({ success: true, id });
}));

module.exports = router;
