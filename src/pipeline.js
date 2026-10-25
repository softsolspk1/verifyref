// pipeline.js - checks on one upload. 'references' = Module 1 (Check Bibliography); 'citations' = list matching only;
// 'manuscript' = the Full Screening Report: Module 1 + Module 2 compliance + Module 3 (list matching, pattern) +
// Module 4 paper-mill signals (+ Module 5 image findings when an image report is attached), with a front-page summary.
const db = require('./db');
const cfg = require('./config');
const P = require('./parse');
const { checkReferences } = require('./checks/reference');
const { checkCitations } = require('./checks/citation');
const { checkCitedJournals } = require('./checks/journal');
const { analyzeCitationPattern } = require('./editor/pattern');
const { problemsOf } = require('./editor/reports');
const { splitName } = require('./text');

/** Split a whole manuscript (or a bare list) into body + parsed references */
function prepare({ text, referencesText, bodyText, entries }) {
  let body = bodyText || '';
  let refsText = referencesText || '';
  if (!refsText && text) {
    const sec = P.findReferenceSection(text);
    if (sec.found) { body = body || sec.body; refsText = sec.references; }
    else refsText = text;
  }
  let refs;
  if (Array.isArray(entries) && entries.length) {
    // Structured entries (BibTeX / RIS): parsed fields override the heuristic parse where present
    refs = entries.map((e, i) => {
      const base = P.parseReferenceEntry(typeof e === 'string' ? e : e.raw, i + 1);
      if (typeof e === 'string') return base;
      const given = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
      return { ...base, ...given, index: i + 1 };
    });
  } else {
    const { entries: split, strategy } = P.splitReferences(refsText);
    refs = split.map((e, i) => P.parseReferenceEntry(e, i + 1));
    refs.strategy = strategy;
  }
  return { body, refs: refs.slice(0, cfg.MAX_REFERENCES), truncated: refs.length > cfg.MAX_REFERENCES, totalFound: refs.length };
}

function normalizeMeta(meta = {}) {
  const authors = (Array.isArray(meta.authors) ? meta.authors : String(meta.authors || '').split(/\s*[;\n]\s*|\s*,\s*(?=[A-Z])/))
    .map(a => (typeof a === 'string' ? { name: a.trim(), ...splitName(a.trim()) } : { ...a, ...(a.family ? {} : splitName(a.name || '')) }))
    .filter(a => a.family);
  return {
    title: (meta.title || '').trim(),
    abstract: (meta.abstract || '').trim(),
    keywords: Array.isArray(meta.keywords) ? meta.keywords : String(meta.keywords || '').split(/[;,]/).map(s => s.trim()).filter(Boolean),
    authors,
    affiliations: Array.isArray(meta.affiliations) ? meta.affiliations : String(meta.affiliations || '').split('\n').map(s => s.trim()).filter(Boolean),
    manuscriptCode: (meta.manuscriptCode || '').trim(),
    version: meta.version ? parseInt(meta.version, 10) : null
  };
}

/**
 * kind: 'manuscript' (everything) | 'references' (Reference + Journal check) | 'citations' (Citation Check only)
 */
async function runCheck(input, update) {
  const kind = input.kind || 'manuscript';
  const opts = { citations: kind !== 'references', journals: kind !== 'citations', pattern: kind === 'manuscript', ...(input.options || {}) };
  const meta = normalizeMeta(input.meta);
  update('Reading the reference list', 2);
  const { body, refs, truncated, totalFound } = prepare(input);
  if (!refs.length) throw new Error('No references were found. Paste the reference list or upload the full manuscript with a "References" heading.');

  const result = { kind, meta, createdAt: new Date().toISOString(), truncated, totalFound, datasets: await require('./datasets').datasetHealth() };

  if (kind === 'citations') {
    update('Matching in-text citations with the reference list', 30);
    result.citations = checkCitations(body, refs);
    result.references = { results: refs.map(r => ({ index: r.index, raw: r.raw, parsed: r, status: 'unchecked', statusLabel: 'Not checked', issues: [], notices: [], links: [], matchedIn: [], checked: {} })), summary: { total: refs.length } };
    return result;
  }

  const refWeight = opts.journals ? 65 : 90;
  update(`Checking ${refs.length} references against 12 databases`, 5);
  result.references = await checkReferences(refs, {
    onProgress: (d, n) => update(`Checking references (${d}/${n}) against 12 databases`, 5 + d / n * refWeight)
  });

  if (opts.citations && body && body.trim().length > 200) {
    update('Matching in-text citations with the reference list', 72);
    result.citations = checkCitations(body, refs);
  } else if (opts.citations) {
    result.citations = { error: 'Upload the full manuscript to check in-text citations (only a reference list was provided).' };
  }

  if (opts.journals) {
    update('Checking cited journals (indexing, quartile, predatory lists)', 75);
    result.journals = await checkCitedJournals(result.references.results, {
      onProgress: (d, n) => update(`Checking cited journals (${d}/${n})`, 75 + d / n * 20)
    });
  }

  if (opts.pattern) {
    update('Analysing the citation pattern', 96);
    result.pattern = analyzeCitationPattern(meta, result.references.results);
  }
  update('Bibliography quality indicators', 96);
  const { bibliographyIndicators } = require('./checks/indicators');
  result.indicators = await bibliographyIndicators(meta, result.references.results, result.journals);
  if (result.citations?.error && kind === 'manuscript') delete result.citations.summary;

  if (kind === 'manuscript') await screening(result, { input, body, refs, meta, update });
  return result;
}

/** Full Screening Report: add Module 2 compliance and Module 4 (+5) to a manuscript check, then the front page */
async function screening(result, { input, body, refs, meta, update }) {
  const { checkCompliance } = require('./checks/compliance');
  update('Module 2: PJPS style compliance', 97);
  const recById = new Map(result.references.results.map(r => [r.index, r.record && r.status !== 'suspicious' ? r.record : null]));
  result.compliance = checkCompliance(refs, { records: refs.map(r => recById.get(r.index) || null), body });

  update('Module 4: paper-mill signals', 98);
  const { detectPaperMill } = require('./papermill');
  let images = null;
  if (input.imagesCheckId && input.userId) {
    const c = await loadCheck(input.userId, input.imagesCheckId);
    if (c?.result?.summary) images = { findings: c.result.summary.byLevel || {}, level: c.result.summary.level, checkId: c.row.id, summary: c.result.summary };
  }
  const text = input.text || [input.bodyText || '', input.referencesText || ''].join('\n');
  const pm = await detectPaperMill({ text, body, meta, references: result.references.results, pattern: result.pattern, suggestedReviewers: input.suggestedReviewers || '', images });
  result._shingles = pm._shingles;
  delete pm._shingles;
  result.papermill = pm;
  if (images) result.images = { checkId: images.checkId, summary: images.summary };
  result.screening = screeningSummary(result);
}

/** Front page: one line per module and the desk-review recommendation */
function screeningSummary(r) {
  const s = r.references.summary;
  const c = r.citations?.summary;
  const cp = r.compliance?.summary;
  const pm = r.papermill?.risk;
  const im = r.images?.summary;
  const reasons = [];
  let rec = 'proceed';
  const escalate = (level, why) => { reasons.push(why); if (level === 'investigate' || (level === 'return' && rec === 'proceed')) rec = level; };
  if (pm?.level === 'HIGH') escalate('investigate', `Paper mill risk HIGH (${r.papermill.signals.filter(x => x.severity === 'high').map(x => x.title).slice(0, 2).join('; ')})`);
  if (im?.level === 'HIGH') escalate('investigate', `Image integrity: ${im.byLevel?.high || 0} strong finding(s)`);
  if (s.suspicious >= 3) escalate('investigate', `${s.suspicious} references not found in any database (possibly fabricated)`);
  else if (s.suspicious) escalate('return', `${s.suspicious} reference(s) could not be found`);
  if (s.retracted) escalate('return', `${s.retracted} retracted work(s) cited`);
  if (pm?.level === 'MEDIUM') escalate('return', 'Paper mill risk MEDIUM — check the signals before review');
  if (im?.level === 'MEDIUM') escalate('return', `Image integrity: ${im.byLevel?.medium || 0} finding(s) to check`);
  if (c && (c.missing >= 3 || c.uncited >= 5)) escalate('return', `${c.missing} citation(s) missing from the list, ${c.uncited} reference(s) never cited`);
  if (cp && cp.score < 60) escalate('return', `Only ${cp.score}% of references follow PJPS style`);
  if (s.miscited >= 5) escalate('return', `${s.miscited} references with wrong details`);
  const label = { proceed: 'Proceed to peer review', return: 'Return to the authors for corrections', investigate: 'Investigate before any further processing' }[rec];
  return {
    recommendation: rec, recommendationLabel: label, reasons,
    lines: {
      bibliography: `${s.verified} verified, ${s.miscited} miscited, ${s.suspicious} suspicious, ${s.retracted} retracted (of ${s.total})`,
      style: cp ? `${cp.score}% PJPS compliant (${cp.nonCompliant} reference(s) to fix${cp.inTextIssues ? `, ${cp.inTextIssues} in-text problem(s)` : ''})` : 'not checked',
      citations: c ? `${c.missing} missing, ${c.uncited} uncited, ${(c.yearMismatch || 0) + (c.etAlIssues || 0)} year / “et al.” problem(s)` : 'manuscript text not available',
      papermill: pm ? `${pm.level} (score ${pm.score})` : 'not checked',
      images: im ? `${im.level} — ${im.findings} finding(s) in ${im.panels} panels` : 'not checked (run Module 5 and attach the report)'
    }
  };
}

/** Persist a check; saveMode 'counts' keeps only the numbers (no manuscript content) */
async function saveCheck(userId, result, { issueId = null, saveMode = 'full' } = {}) {
  const meta = result.meta || {};
  let version = meta.version;
  if (meta.manuscriptCode && !version) {
    const row = await db.one('SELECT COALESCE(MAX(version), 0) AS v FROM checks WHERE user_id = $1 AND manuscript_code = $2', [userId, meta.manuscriptCode]);
    version = (row?.v || 0) + 1;
  }
  version = version || 1;
  result.meta.version = version;
  const s = result.references?.summary || {};
  const problems = problemsOf(result);
  const row = await db.one(`INSERT INTO checks(user_id, issue_id, kind, manuscript_code, version, title, ref_total, verified, suspicious, unverified, miscited, retracted,
      missing_citations, uncited_references, journal_flags, self_citation_rate, problems, result, origin, pending_online)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id, created_at`,
  [userId, issueId || null, result.kind, meta.manuscriptCode || null, version, meta.title || null, s.total || 0, s.verified || 0, s.suspicious || 0, s.unverified || 0,
    s.miscited || 0, s.retracted || 0, result.citations?.summary?.missing || 0, result.citations?.summary?.uncited || 0, result.journals?.summary?.highRisk || 0,
    result.pattern?.summary?.selfCitationRate || 0, JSON.stringify(problems), saveMode === 'counts' ? null : JSON.stringify(result),
    cfg.DESKTOP ? 'desktop' : 'web', s.pending || 0]);
  result.id = row.id;
  result.createdAt = row.created_at;
  return row.id;
}

/**
 * Save the result of any other tool to My Activity. fields: { title, manuscriptCode, refTotal, problems[], counts:{verified,...}, pending }
 */
async function saveResult(userId, kind, result, fields = {}) {
  const c = fields.counts || {};
  const row = await db.one(`INSERT INTO checks(user_id, kind, manuscript_code, title, ref_total, verified, suspicious, unverified, miscited, retracted, problems, result, origin, pending_online)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, created_at`,
  [userId, kind, fields.manuscriptCode || null, String(fields.title || kind).slice(0, 300), fields.refTotal || 0, c.verified || 0, c.suspicious || 0, c.unverified || 0, c.miscited || 0, c.retracted || 0,
    JSON.stringify(fields.problems || []), JSON.stringify(result), cfg.DESKTOP ? 'desktop' : 'web', fields.pending || 0]);
  result.id = row.id;
  result.createdAt = row.created_at;
  return row.id;
}

async function loadCheck(userId, id) {
  const row = await db.one('SELECT * FROM checks WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!row) return null;
  const result = row.result || null;
  if (result) { result.id = row.id; result.createdAt = row.created_at; result.issueId = row.issue_id; }
  return { row, result };
}

module.exports = { runCheck, saveCheck, saveResult, loadCheck, prepare, normalizeMeta };
