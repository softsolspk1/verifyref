// server.js - PJPS Reference Checker by Softsols Pakistan
const express = require('express');
const path = require('path');
const multer = require('multer');

const cfg = require('./src/config');
const db = require('./src/db');
const auth = require('./src/auth');
const { defineJob, createJob, getJob, purgeJobs } = require('./src/jobs');
const P = require('./src/parse');
const D = require('./src/datasets');
const { runCheck, saveCheck, loadCheck } = require('./src/pipeline');
const { checkJournal } = require('./src/checks/journal');
const { findReviewers } = require('./src/editor/reviewers');
const { checkReviewerReport } = require('./src/editor/reviewerReport');
const R = require('./src/editor/reports');
const F = require('./src/format');
const W = require('./src/docx');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20mb' }));

// Schema + first administrator, once per instance (on Vercel there is no start-up hook)
let ready = null;
app.use((req, res, next) => {
  if (!ready) ready = db.init().then(() => auth.seedAdmin()).catch(err => { ready = null; throw err; });
  ready.then(() => next(), next);
});

app.use(auth.sessionMiddleware);
// Locally Express serves public/; on Vercel the CDN does (express.static is ignored there)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const editor = auth.requireEditor;
const admin = auth.requireAdmin;

function sendFile(res, buffer, filename, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`);
  res.send(buffer);
}
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ------------------------------------------------------------------ public

app.get('/api/app', wrap(async (req, res) => {
  res.json({ name: cfg.APP_NAME, vendor: cfg.APP_VENDOR, homeJournal: cfg.HOME_JOURNAL, user: auth.publicUser(req.user) || null });
}));

app.post('/api/auth/register', auth.throttle, wrap(auth.register));
app.post('/api/auth/login', auth.throttle, wrap(auth.login));
app.post('/api/auth/logout', wrap(auth.logout));
app.get('/api/auth/me', (req, res) => res.json({ user: auth.publicUser(req.user) || null }));
app.post('/api/auth/password', editor, wrap(auth.changePassword));

// ------------------------------------------------------------------ document intake

/** Upload a manuscript / reference file: returns text, detected metadata, body & reference section */
app.post('/api/extract', editor, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
  const doc = await P.extractDocument(req.file.buffer, req.file.originalname, req.file.mimetype);
  if (doc.entries) {
    return res.json({ success: true, filename: req.file.originalname, format: doc.format, structured: doc.entries, referencesText: doc.entries.map(e => e.raw).join('\n'), bodyText: '', meta: {}, referenceCount: doc.entries.length });
  }
  const sec = P.findReferenceSection(doc.text);
  const meta = sec.found ? P.extractManuscriptMeta(sec.body) : {};
  const { entries } = P.splitReferences(sec.found ? sec.references : doc.text);
  res.json({
    success: true,
    filename: req.file.originalname,
    format: doc.format,
    fullManuscript: sec.found && sec.body.trim().length > 500,
    referencesText: sec.found ? sec.references : doc.text,
    bodyText: sec.found ? sec.body : '',
    meta,
    referenceCount: entries.length
  });
}));

app.post('/api/parse', editor, (req, res) => {
  const { entries, strategy } = P.splitReferences(req.body.text || '', req.body.strategy || 'auto');
  res.json({ success: true, strategy, references: entries.map((e, i) => P.parseReferenceEntry(e, i + 1)) });
});

// ------------------------------------------------------------------ checks (Reference / Citation / Journal / full manuscript)

app.post('/api/checks', editor, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.text && !b.referencesText && !(b.entries || []).length) return res.status(400).json({ success: false, message: 'Provide a manuscript or a reference list.' });
  const job = await createJob(req.user.id, 'check', b);
  res.json({ success: true, jobId: job.id });
}));

defineJob('check', async (b, { userId, update }) => {
  const result = await runCheck(b, update);
  if (b.save !== false) await saveCheck(userId, result, { issueId: b.issueId || null, saveMode: b.saveMode || 'full' });
  return result;
});

app.get('/api/jobs/:id', editor, wrap(async (req, res) => {
  const j = await getJob(req.params.id, req.user.id);
  if (!j) return res.status(404).json({ success: false, message: 'Job not found or expired.' });
  res.json({ success: true, status: j.status, progress: j.progress, step: j.step, error: j.error, result: j.status === 'done' ? j.result : undefined });
}));

app.get('/api/checks', editor, wrap(async (req, res) => {
  const params = [req.user.id];
  let where = 'user_id = $1';
  if (req.query.issue) { params.push(req.query.issue); where += ` AND issue_id = $${params.length}`; }
  if (req.query.code) { params.push(req.query.code); where += ` AND manuscript_code = $${params.length}`; }
  if (req.query.kind) { params.push(req.query.kind); where += ` AND kind = $${params.length}`; }
  const rows = await db.all(`SELECT id, issue_id, kind, manuscript_code, version, title, ref_total, verified, suspicious, unverified, miscited, retracted,
    missing_citations, uncited_references, journal_flags, self_citation_rate, problems, created_at, (result IS NOT NULL) AS has_result
    FROM checks WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params);
  res.json({ success: true, checks: rows });
}));

async function checkOr404(req, res) {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c) { res.status(404).json({ success: false, message: 'Check not found.' }); return null; }
  if (!c.result) { res.status(410).json({ success: false, message: 'This check was saved as counts only; the full report is not stored.' }); return null; }
  return c;
}

app.get('/api/checks/:id', editor, wrap(async (req, res) => {
  const c = await checkOr404(req, res);
  if (c) res.json({ success: true, result: c.result });
}));

app.patch('/api/checks/:id', editor, wrap(async (req, res) => {
  const b = req.body || {};
  const row = await db.one('SELECT id, result FROM checks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ success: false, message: 'Check not found.' });
  if ('issueId' in b) await db.query('UPDATE checks SET issue_id = $1 WHERE id = $2', [b.issueId || null, row.id]);
  if ('manuscriptCode' in b || 'title' in b) {
    await db.query('UPDATE checks SET manuscript_code = COALESCE($1, manuscript_code), title = COALESCE($2, title) WHERE id = $3', [b.manuscriptCode ?? null, b.title ?? null, row.id]);
    if (row.result) {
      const r = row.result;
      if (b.manuscriptCode !== undefined) r.meta.manuscriptCode = b.manuscriptCode;
      if (b.title !== undefined) r.meta.title = b.title;
      await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(r), row.id]);
    }
  }
  res.json({ success: true });
}));

app.delete('/api/checks/:id', editor, wrap(async (req, res) => {
  await db.query('DELETE FROM checks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

// ------------------------------------------------------------------ editor report: decision summary, correction letter, revision comparison

app.get('/api/checks/:id/summary', editor, wrap(async (req, res) => {
  const c = await checkOr404(req, res);
  if (!c) return;
  const ds = R.decisionSummary(c.result);
  if (req.query.format === 'docx') return sendFile(res, await W.buildDocx(W.decisionSummaryBlocks(ds)), `decision-summary-${c.row.manuscript_code || c.row.id}.docx`, DOCX);
  res.json({ success: true, summary: ds });
}));

app.get('/api/checks/:id/letter', editor, wrap(async (req, res) => {
  const c = await checkOr404(req, res);
  if (!c) return;
  const letter = R.correctionLetter(c.result, req.query.lang === 'ur' ? 'ur' : 'en');
  if (req.query.format === 'docx') return sendFile(res, await W.buildDocx(W.letterBlocks(letter), { rtl: letter.rtl }), `correction-letter-${letter.lang}-${c.row.manuscript_code || c.row.id}.docx`, DOCX);
  if (req.query.format === 'txt') return sendFile(res, Buffer.from('﻿' + letter.text, 'utf8'), `correction-letter-${letter.lang}.txt`, 'text/plain; charset=utf-8');
  res.json({ success: true, letter });
}));

app.get('/api/checks/:id/compare/:otherId', editor, wrap(async (req, res) => {
  const a = await loadCheck(req.user.id, req.params.otherId);
  const b = await loadCheck(req.user.id, req.params.id);
  if (!a?.result || !b?.result) return res.status(404).json({ success: false, message: 'Both checks must exist with full reports saved.' });
  if (![a, b].every(c => ['manuscript', 'references'].includes(c.row.kind))) return res.status(400).json({ success: false, message: 'Only manuscript or reference checks can be compared.' });
  const cmp = R.compareRevisions(a.result, b.result);
  if (req.query.format === 'docx') return sendFile(res, await W.buildDocx(W.revisionBlocks(cmp)), `revision-comparison-${b.row.manuscript_code || b.row.id}.docx`, DOCX);
  res.json({ success: true, comparison: cmp });
}));

/** Reference report exports: CSV, BibTeX, RIS, Word, corrected list */
app.get('/api/checks/:id/export', editor, wrap(async (req, res) => {
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
  if (fmt === 'docx') return sendFile(res, await W.buildDocx(W.referenceReportBlocks(c.result)), `${base}.docx`, DOCX);
  if (fmt === 'corrected') {
    const style = req.query.style || c.result.references.style || 'pjps';
    const txt = results.map((r, i) => `${i + 1}. ${r.record && r.status !== 'suspicious' ? F.formatReference(r.record, style) : r.raw.replace(/^\s*(\[\d+\]|\d+[.)])\s*/, '')}`).join('\n');
    return sendFile(res, Buffer.from('﻿' + txt, 'utf8'), `${base}-corrected.txt`, 'text/plain; charset=utf-8');
  }
  res.status(400).json({ success: false, message: 'Unknown export format.' });
}));

// ------------------------------------------------------------------ Journal Check (single journal lookup)

app.post('/api/journal-check', editor, wrap(async (req, res) => {
  const { name, issn } = req.body || {};
  if (!name && !issn) return res.status(400).json({ success: false, message: 'Enter a journal name or ISSN.' });
  res.json({ success: true, journal: await checkJournal({ name: String(name || '').trim(), issn: String(issn || '').trim() }) });
}));

// ------------------------------------------------------------------ Reviewer Finder

app.post('/api/reviewers', editor, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title || b.title.trim().length < 10) return res.status(400).json({ success: false, message: 'Enter the manuscript title (and ideally the abstract).' });
  const job = await createJob(req.user.id, 'reviewers', {
    title: b.title.trim(),
    abstract: (b.abstract || '').trim(),
    keywords: Array.isArray(b.keywords) ? b.keywords : String(b.keywords || '').split(/[;,]/).map(s => s.trim()).filter(Boolean),
    authors: String(b.authors || '').split(/\s*[;\n]\s*|\s*,\s*(?=[A-Z])/).map(s => s.trim()).filter(Boolean),
    affiliations: String(b.affiliations || '').split('\n').map(s => s.trim()).filter(Boolean),
    exclude: String(b.exclude || '').split(/\s*[;\n]\s*/).map(s => s.trim()).filter(Boolean),
    yearsBack: parseInt(b.yearsBack || '5', 10),
    limit: Math.min(parseInt(b.limit || '25', 10), 50)
  });
  res.json({ success: true, jobId: job.id });
}));

defineJob('reviewers', (input, { update }) => findReviewers(input, { onProgress: update }));

app.post('/api/reviewers/export', editor, wrap(async (req, res) => {
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

app.post('/api/reviewer-report', editor, wrap(async (req, res) => {
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
    await db.query(`INSERT INTO checks(user_id, kind, manuscript_code, title, ref_total, problems, result) VALUES($1, 'reviewer-report', $2, $3, $4, $5, $6)`,
      [userId, b.manuscriptCode || null, `Reviewer report${b.reviewerName ? ' — ' + b.reviewerName : ''}${manuscript.title ? ': ' + manuscript.title : ''}`.slice(0, 300), out.items.length, JSON.stringify(out.flags.map(f => f.message)), JSON.stringify(out)]);
  }
  return out;
});

// ------------------------------------------------------------------ issues & issue report

app.get('/api/issues', editor, wrap(async (req, res) => {
  const rows = await db.all(`SELECT i.*, COUNT(c.id)::int AS manuscripts FROM issues i LEFT JOIN checks c ON c.issue_id = i.id AND c.kind IN ('manuscript','references')
    WHERE i.user_id = $1 GROUP BY i.id ORDER BY i.created_at DESC`, [req.user.id]);
  res.json({ success: true, issues: rows });
}));

app.post('/api/issues', editor, wrap(async (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ success: false, message: 'Enter an issue label, e.g. "Vol. 39, No. 6 (2026)".' });
  const row = await db.one('INSERT INTO issues(user_id, label) VALUES($1, $2) RETURNING *', [req.user.id, label]);
  res.json({ success: true, issue: row });
}));

app.delete('/api/issues/:id', editor, wrap(async (req, res) => {
  await db.query('DELETE FROM issues WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

/** Issue report (by issue id) or period report (?months=1|3|6) */
app.get('/api/issue-report', editor, wrap(async (req, res) => {
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

// ------------------------------------------------------------------ administration

app.get('/api/admin/users', admin, wrap(async (req, res) => {
  const rows = await db.all('SELECT id, email, name, role, status, journal, editor_role, orcid, co_editors, note, created_at, approved_at FROM users ORDER BY (status = \'pending\') DESC, created_at DESC');
  res.json({ success: true, users: rows });
}));

app.post('/api/admin/users/:id', admin, wrap(async (req, res) => {
  const { status, role } = req.body || {};
  if (status && !['approved', 'rejected', 'disabled', 'pending'].includes(status)) return res.status(400).json({ success: false, message: 'Invalid status.' });
  if (role && !['editor', 'admin'].includes(role)) return res.status(400).json({ success: false, message: 'Invalid role.' });
  if (Number(req.params.id) === req.user.id && (status && status !== 'approved' || role === 'editor')) return res.status(400).json({ success: false, message: 'You cannot remove your own administrator access.' });
  await db.query(`UPDATE users SET status = COALESCE($1, status), role = COALESCE($2, role), approved_at = CASE WHEN $1 = 'approved' THEN now() ELSE approved_at END WHERE id = $3`, [status || null, role || null, req.params.id]);
  if (status && status !== 'approved') await db.query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
  res.json({ success: true });
}));

app.get('/api/admin/datasets', admin, wrap(async (req, res) => res.json({ success: true, ...(await D.listStatus()) })));

app.post('/api/admin/datasets/refresh', admin, wrap(async (req, res) => {
  const job = await createJob(req.user.id, 'datasets', {});
  res.json({ success: true, jobId: job.id });
}));

defineJob('datasets', async (input, { update }) => {
  update('Downloading Retraction Watch and Beall\'s list', 10);
  return D.ensureDatasets({ force: true });
});

// Vercel Cron (vercel.json): dataset refresh (weekly freshness rule) and job clean-up
app.get('/api/cron/daily', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  await purgeJobs();
  res.json({ success: true, datasets: await D.ensureDatasets() });
}));

app.post('/api/admin/lists/:type', admin, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Choose a CSV file.' });
  if (/\.xlsx?$/i.test(req.file.originalname)) return res.status(400).json({ success: false, message: 'Please save the spreadsheet as CSV (File → Save As → CSV UTF-8) and upload that.' });
  const n = await D.importJournalList(req.params.type, req.file.originalname, req.file.buffer.toString('utf8'));
  res.json({ success: true, rows: n });
}));

app.delete('/api/admin/lists/:type', admin, wrap(async (req, res) => {
  await db.query('DELETE FROM journal_list_entries WHERE list_type = $1', [req.params.type]);
  await db.query('DELETE FROM journal_lists WHERE list_type = $1', [req.params.type]);
  res.json({ success: true });
}));

// ------------------------------------------------------------------ errors & startup

app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Unexpected server error.' });
});

async function start() {
  await db.init();
  await auth.seedAdmin();
  const listen = port => {
    const server = app.listen(port, () => console.log(`${cfg.APP_NAME} running at http://localhost:${port}`));
    server.on('error', err => {
      if (err.code === 'EADDRINUSE') { console.log(`Port ${port} in use, trying ${port + 1}…`); listen(port + 1); }
      else throw err;
    });
  };
  listen(cfg.PORT);
  // Keep Retraction Watch / Beall's list fresh (weekly) without blocking startup
  D.ensureDatasets().catch(e => console.error('Dataset refresh failed:', e.message));
  setInterval(() => { purgeJobs(); D.ensureDatasets().catch(() => {}); }, 24 * 3600 * 1000).unref();
}

if (require.main === module && !process.env.VERCEL) start().catch(e => { console.error('Startup failed:', e); process.exit(1); });

module.exports = app;
