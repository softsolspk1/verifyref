// pipeline.js - full manuscript check: references -> citations -> journals -> citation pattern; saving results
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

  const result = { kind, meta, createdAt: new Date().toISOString(), truncated, totalFound };

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
    update('Analysing the citation pattern', 97);
    result.pattern = analyzeCitationPattern(meta, result.references.results);
  }
  if (result.citations?.error && kind === 'manuscript') delete result.citations.summary;
  return result;
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
      missing_citations, uncited_references, journal_flags, self_citation_rate, problems, result)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id, created_at`,
  [userId, issueId || null, result.kind, meta.manuscriptCode || null, version, meta.title || null, s.total || 0, s.verified || 0, s.suspicious || 0, s.unverified || 0,
    s.miscited || 0, s.retracted || 0, result.citations?.summary?.missing || 0, result.citations?.summary?.uncited || 0, result.journals?.summary?.highRisk || 0,
    result.pattern?.summary?.selfCitationRate || 0, JSON.stringify(problems), saveMode === 'counts' ? null : JSON.stringify(result)]);
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

module.exports = { runCheck, saveCheck, loadCheck, prepare, normalizeMeta };
