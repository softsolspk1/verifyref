// papermill/index.js - Module 4 Paper Mill Detection. Collects risk signals with evidence and weights:
//   text (tortured phrases, AI-text leftovers, template wording, vague methods), references (fabricated references,
//   citations to papers retracted for paper-mill reasons, predatory/hijacked journals, citation stacking), authors
//   (earlier retractions, free e-mail addresses, ORCID, affiliations, authorship changes, suggested reviewers) and data
//   (misidentified cell lines, duplicate submissions, image findings from Module 5).
// The result is a screening aid: LOW / MEDIUM / HIGH with the evidence for every signal. It never decides on its own.
const db = require('../db');
const D = require('../datasets');
const { getJson } = require('../http');
const { nameMatch, splitName, titleSimilarity, normalizeJournal } = require('../text');
const { TORTURED, AI_LEFTOVERS, TEMPLATES, CELL_LINES, FREE_MAIL, DISPOSABLE_MAIL } = require('./lists');
const DC = require('./dataChecks');
const { isOnline } = require('../http');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ctx = (text, i, len) => text.slice(Math.max(0, i - 70), i + len + 70).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ text signals

async function customPhrases() {
  try { return JSON.parse((await db.getMeta('tortured_custom')) || '[]'); } catch (e) { return []; }
}

function torturedPhrases(text, extra = []) {
  const hits = new Map();
  for (const t of [...TORTURED, ...extra]) {
    const re = new RegExp(`\\b${esc(t.phrase)}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      const k = t.phrase.toLowerCase();
      if (!hits.has(k)) hits.set(k, { phrase: t.phrase, correct: t.correct, count: 0, examples: [] });
      const h = hits.get(k);
      h.count++;
      if (h.examples.length < 2) h.examples.push(ctx(text, m.index, m[0].length));
    }
  }
  return [...hits.values()].sort((a, b) => b.count - a.count);
}

const isWordChar = c => !!c && /[\p{L}\p{N}]/u.test(c);

/** First whole-word occurrence of a lower-case phrase in lower-case text, or -1 */
function findWhole(lower, term) {
  for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + 1)) {
    if (!isWordChar(lower[i - 1]) && !isWordChar(lower[i + term.length])) return i;
  }
  return -1;
}

/**
 * Problematic Paper Screener fingerprints (tortured phrases, SCIgen text): every phrase of a fingerprint must occur.
 * Returns { tortured: [{phrase, correct, count, examples}], scigen: [{phrase, examples}] }
 */
async function screenerMatches(text) {
  const out = { tortured: [], scigen: [], suspect: [] };
  const fps = await D.ppsFingerprints().catch(() => []);
  if (!fps.length) return out;
  const lower = text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
  for (const fp of fps) {
    const at = fp.terms.map(t => findWhole(lower, t));
    if (at.some(i => i === -1)) continue;
    const phrase = fp.terms.join(' + ');
    const example = ctx(lower, at[0], fp.terms[0].length);
    if (fp.kind === 'scigen') out.scigen.push({ phrase, examples: [example] });
    else if (fp.kind === 'suspect') out.suspect.push({ phrase, note: fp.expected || '', examples: [example] });
    else out.tortured.push({ phrase, correct: fp.expected || '', count: 1, examples: [example] });
  }
  return out;
}

function aiLeftovers(text) {
  const out = [];
  for (const [re, label] of AI_LEFTOVERS) {
    const m = text.match(re);
    if (m) out.push({ label, found: m[0], example: ctx(text, m.index, m[0].length) });
  }
  return out;
}

function templateWording(text) {
  const out = [];
  for (const [re, label] of TEMPLATES) {
    const m = text.match(re);
    if (m) out.push({ label, found: m[0], example: ctx(text, m.index, m[0].length) });
  }
  return out;
}

/** Methods that cannot be repeated: no supplier, catalogue number, dose, sample size or ethics approval */
function methodsGaps(text) {
  const methods = (text.match(/(?:^|\n)\s*(?:\d+\.?\s*)?(?:materials? and methods|methods?|methodology|experimental(?: section| procedures)?)\s*\n([\s\S]{200,30000}?)(?:\n\s*(?:\d+\.?\s*)?(?:results|results and discussion|discussion)\s*\n|$)/i) || [])[1] || '';
  const scope = methods || text;
  const animals = /\b(rats?|mice|mouse|rabbits?|guinea pigs?|animals?)\b/i.test(scope);
  const humans = /\b(patients?|participants?|volunteers?|subjects? were|respondents?)\b/i.test(scope);
  const reagents = /\b(reagents?|chemicals?|antibod(?:y|ies)|kits?|cell lines?|media|serum)\b/i.test(scope);
  const gaps = [];
  if ((animals || humans) && !/\b(ethic(?:s|al)? (?:committee|board|approval|review)|institutional review board|IRB|IACUC|animal care|approval (?:no|number|letter|ref)|ERC|IREB|bioethics)\b/i.test(text)) {
    gaps.push({ code: 'ethics', message: `${animals ? 'Animal' : 'Human'} study with no ethics approval (committee or approval number) stated` });
  } else if ((animals || humans) && !/\b(?:approval|ref(?:erence)?|protocol|letter)\s*(?:no\.?|number|#|:)\s*[\w/.-]*\d/i.test(text)) {
    gaps.push({ code: 'ethics-number', message: 'Ethics approval mentioned without an approval / reference number' });
  }
  if (reagents && !/\b(purchased from|obtained from|supplied by|procured from|gift from|Sigma|Merck|Thermo|Invitrogen|Abcam|ATCC|Bio-?Rad|Santa Cruz|Cell Signaling|BDH|Fluka|Daejung|Scharlau)\b/i.test(scope)) {
    gaps.push({ code: 'supplier', message: 'Reagents, kits or cells used without naming the supplier' });
  }
  if (animals && !/\b\d+(?:\.\d+)?\s*(?:mg|µg|μg|g|ml|mL)\s*\/\s*kg\b/i.test(scope)) gaps.push({ code: 'dose', message: 'Animal study without doses in mg/kg' });
  if ((animals || humans) && !/\b(?:n\s*=\s*\d+|\d+\s+(?:rats|mice|animals|patients|participants|subjects|volunteers)|(?:groups?|each) of \d+|sample size)\b/i.test(scope)) gaps.push({ code: 'sample', message: 'No sample size (n = …) stated' });
  return { checked: !!methods || animals || humans, methodsFound: !!methods, gaps };
}

function cellLines(text) {
  const out = [];
  for (const c of CELL_LINES) {
    const re = new RegExp(`(?<![\\w-])${esc(c.name)}(?![\\w-])`, 'g');
    for (const m of text.matchAll(re)) {
      const around = text.slice(Math.max(0, m.index - 80), m.index + 80);
      if (!/\bcells?\b|\bcell lines?\b|\bline\b/i.test(around)) continue;
      out.push({ name: c.name, actual: c.actual, nonVerifiable: !!c.nonVerifiable, example: ctx(text, m.index, m[0].length) });
      break;
    }
  }
  return out;
}

// Immune-cell and marker names that read like cell lines ("CD4 cells", "Th17 cells", "M1 cells")
const NOT_CELL_LINE = /^(?:CD\d|Th\d|Tc\d|IL-?\d|M[12]$|B\d|T\d|NK\d|G[0-2]$|S$|ES$|iPS)/i;

/** Cell-line names written as "X cells" / "X cell line" (must contain a digit), minus those already reported */
function cellLineCandidates(text, skip = new Set()) {
  const out = new Map();
  for (const m of text.matchAll(/\b([A-Z][A-Za-z]{0,7}-?\d[A-Za-z0-9]{0,6}(?:-[A-Za-z0-9]{1,6})?)\s+(cell lines?|cells?)\b/g)) {
    const name = m[1].trim();
    const k = name.toLowerCase();
    if (skip.has(k) || NOT_CELL_LINE.test(name) || /^\d/.test(name)) continue;
    const prev = out.get(k);
    const calledLine = /line/i.test(m[2]) || /\bcell lines?\b/i.test(text.slice(Math.max(0, m.index - 40), m.index));
    if (!prev) out.set(k, { name, calledLine, example: ctx(text, m.index, m[0].length) });
    else if (calledLine) prev.calledLine = true;
  }
  return [...out.values()];
}

/** Zero-width characters and look-alike letters from other alphabets: used to slip past plagiarism software */
function hiddenText(text) {
  // zero-width characters only: soft hyphens are ordinary typesetting in publisher files and not a disguise
  const zero = (text.match(/[\u200B-\u200D\u2060\uFEFF]/g) || []).length;
  const mixed = [];
  // Greek letters are routine in science (TNFα, ΔΔCt, NF-κB). Only Cyrillic letters, or Greek capitals that look like Latin ones
  // (Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ), inside an otherwise Latin word are used to slip past plagiarism software.
  const lookalikeGreek = /[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/u;
  for (const m of text.matchAll(/\p{L}{4,}/gu)) {
    const w = m[0];
    if (!/\p{Script=Latin}/u.test(w)) continue;
    const latin = (w.match(/\p{Script=Latin}/gu) || []).length;
    if (/\p{Script=Cyrillic}/u.test(w) || (lookalikeGreek.test(w) && latin >= 3 && !/[α-ω]/u.test(w))) { mixed.push(w); if (mixed.length >= 8) break; }
  }
  return { zero, mixed };
}

/**
 * A paper with the same title is already published or posted (duplicate / redundant publication): Crossref (DOIs),
 * OpenAlex (journals, preprints) and CORE (repositories, theses, preprint servers). Merged by DOI / title.
 */
async function publishedElsewhere(title) {
  if (!title || title.length < 25) return [];
  const S = require('../sources');
  const [cr, oa, core] = await Promise.all([
    getJson('https://api.crossref.org/works?rows=4&select=DOI,title,container-title,issued&query.bibliographic=' + encodeURIComponent(title), { ttl: 7 * 86400, timeout: 12000, retries: 1 })
      .then(r => (r.ok ? (r.data?.message?.items || []).map(it => ({ title: (it.title || [])[0] || '', journal: (it['container-title'] || [])[0] || '', year: it.issued?.['date-parts']?.[0]?.[0] || null, doi: it.DOI, source: 'Crossref' })) : [])).catch(() => []),
    S.openalexSearch({ title }).then(r => (r.records || []).map(x => ({ title: x.title, journal: x.journal, year: x.year, doi: x.doi, url: x.url, source: 'OpenAlex' }))).catch(() => []),
    S.coreSearch({ title }).then(r => (r.records || []).map(x => ({ title: x.title, journal: x.journal || x.publisher, year: x.year, doi: x.doi, url: x.url, source: 'CORE' }))).catch(() => [])
  ]);
  const out = new Map();
  for (const x of [...cr, ...oa, ...core]) {
    const sim = titleSimilarity(title, x.title || '');
    if (sim < 0.92) continue;
    const key = x.doi ? String(x.doi).toLowerCase() : String(x.title).toLowerCase().replace(/\W+/g, '');
    const prev = out.get(key);
    if (prev) { if (!prev.sources.includes(x.source)) prev.sources.push(x.source); continue; }
    out.set(key, { ...x, sim, sources: [x.source] });
  }
  return [...out.values()];
}

// ------------------------------------------------------------------ author signals

const ORCID_RE = /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/g;

function orcidValid(id) {
  const d = id.replace(/-/g, '');
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + parseInt(d[i], 10)) * 2;
  const r = (12 - (total % 11)) % 11;
  return (r === 10 ? 'X' : String(r)) === d[15];
}

async function orcidProfile(id) {
  const [works, rec] = await Promise.all([
    getJson(`https://pub.orcid.org/v3.0/${id}/works`, { ttl: 7 * 86400, timeout: 12000, retries: 1 }),
    getJson(`https://pub.orcid.org/v3.0/${id}/person`, { ttl: 7 * 86400, timeout: 12000, retries: 1 })
  ]);
  if (works.status === 404) return { id, exists: false };
  if (!works.ok) return { id, error: works.error || `HTTP ${works.status}` };
  const name = rec.ok ? `${rec.data?.name?.['given-names']?.value || ''} ${rec.data?.name?.['family-name']?.value || ''}`.trim() : '';
  const created = rec.ok ? rec.data?.['last-modified-date']?.value : null;
  const dois = [...new Set((works.data?.group || []).flatMap(g => (g['external-ids']?.['external-id'] || []).filter(x => x['external-id-type'] === 'doi').map(x => String(x['external-id-value'] || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim())).filter(Boolean))];
  return { id, exists: true, works: (works.data?.group || []).length, name, dois, lastModified: created ? new Date(created).toISOString().slice(0, 10) : null };
}

function emailsOf(text) {
  return [...new Set((text.slice(0, 12000).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(e => e.toLowerCase().replace(/[.,;]+$/, '')))];
}

const AFF_STOP = new Set(['university', 'universit', 'department', 'faculty', 'college', 'institute', 'school', 'hospital', 'centre', 'center', 'pakistan', 'the', 'and', 'of', 'for', 'sciences', 'science', 'medical', 'pharmacy', 'pharmaceutical', 'research', 'national']);
const affTokens = s => new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/).filter(t => t.length > 3 && !AFF_STOP.has(t)));

/**
 * Retraction Watch lists authors by name only, so a name match can be another person. Each hit carries a confidence:
 *   high   - first name agrees (not only the initial) and the retracted paper's institution/country matches an affiliation
 *   medium - first name agrees in full
 *   low    - surname + initial only (common names such as "Wei Zhang" or "Muhammad Ali" land here)
 */
async function authorRetractions(authors, affiliations = []) {
  const out = [];
  const myAff = affTokens((affiliations || []).join(' '));
  const myPk = /pakistan|\bpk\b/i.test((affiliations || []).join(' '));
  for (const a of authors.slice(0, 15)) {
    if (!a.family || a.family.length < 3) continue;
    const rows = await D.retractionsByAuthor(a.family).catch(() => []);
    for (const r of rows) {
      const names = String(r.authors || '').split(/\s*;\s*/).map(n => splitName(n.trim())).filter(n => n.family);
      if (!names.some(n => nameMatch(n, a) === 'exact' || (nameMatch(n, a) === 'likely' && n.given && a.given && n.given[0] === a.given[0]))) continue;
      const theirName = names.find(n => nameMatch(n, a) === 'exact' || nameMatch(n, a) === 'likely');
      const fullFirst = !!(theirName?.given && a.given && theirName.given.replace(/[.\s]/g, '').length > 1 && a.given.replace(/[.\s]/g, '').length > 1 && theirName.given.toLowerCase().split(/\s+/)[0].replace(/\./g, '') === a.given.toLowerCase().split(/\s+/)[0].replace(/\./g, ''));
      const theirAff = affTokens(r.institution);
      const sharedAff = [...myAff].filter(t => theirAff.has(t));
      const sameCountry = myPk && /pakistan/i.test(r.country || '');
      const confidence = fullFirst && (sharedAff.length >= 1 || (sameCountry && !r.institution)) ? 'high' : fullFirst ? 'medium' : 'low';
      out.push({ confidence, institutionMatch: sharedAff.slice(0, 3), sameCountry, institution: (r.institution || '').slice(0, 160), author: `${a.given} ${a.family}`.trim(), title: r.title, journal: r.journal, date: r.retraction_date, doi: r.doi, reason: r.reason, mill: D.MILL_REASON_RE.test(r.reason || '') });
    }
  }
  return out;
}

const NON_BIOMED = /\b(?:mechanical|electrical|civil|chemical engineering|computer science|software|business|management sciences|economics|commerce|mathematics|physics|english|law|architecture|mass communication|islamic studies)\b/i;

// ------------------------------------------------------------------ duplicate submissions (text fingerprints)

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Sampled 6-word shingles of the manuscript text */
function shingles(text) {
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
  const out = new Set();
  for (let i = 0; i + 6 <= words.length; i++) {
    const h = fnv(words.slice(i, i + 6).join(' '));
    if (h % 8 === 0) out.add(h);
  }
  return [...out].slice(0, 6000);
}

async function duplicateSubmissions({ body, meta, excludeCode }) {
  const mine = new Set(shingles(body));
  const rows = await db.all("SELECT id, check_id, manuscript_code, title, data, created_at FROM fingerprints WHERE kind = 'text' ORDER BY created_at DESC LIMIT 3000");
  const out = [];
  for (const r of rows) {
    if (excludeCode && r.manuscript_code && r.manuscript_code === excludeCode) continue;
    const theirs = r.data?.shingles || [];
    let inter = 0;
    for (const h of theirs) if (mine.has(h)) inter++;
    const overlap = mine.size && theirs.length ? inter / Math.min(mine.size, theirs.length) : 0;
    const tsim = meta.title && r.title ? titleSimilarity(meta.title, r.title) : 0;
    if (overlap >= 0.2 || tsim >= 0.9) out.push({ manuscriptCode: r.manuscript_code, title: r.title, checkId: r.check_id, date: r.created_at, textOverlap: Math.round(overlap * 100), titleSimilarity: Math.round(tsim * 100) });
  }
  return { compared: rows.length, matches: out.sort((a, b) => b.textOverlap - a.textOverlap).slice(0, 10), shingles: [...mine] };
}

async function previousAuthors(code, version) {
  if (!code) return null;
  const row = await db.one("SELECT data FROM fingerprints WHERE kind = 'text' AND manuscript_code = $1 ORDER BY created_at DESC LIMIT 1", [code]);
  return row?.data?.authors || null;
}

/** Store the fingerprint of a screened manuscript (after the check is saved) */
async function storeFingerprint({ checkId, userId, meta, shingles: sh, text }) {
  // the full text goes into the PJPS text repository (R2), where later similarity checks compare with it word for word
  if (text && checkId) await require('../corpus').addDoc({ kind: 'submission', sourceKey: `check:${checkId}`, title: meta?.title || '', meta: { manuscriptCode: meta?.manuscriptCode || null, checkId }, text }).catch(e => console.error('Repository: submission not stored:', e.message));
  if (!sh?.length) return;
  await db.query("INSERT INTO fingerprints(check_id, user_id, manuscript_code, kind, title, data) VALUES($1, $2, $3, 'text', $4, $5)",
    [checkId || null, userId || null, meta.manuscriptCode || null, (meta.title || '').slice(0, 300), JSON.stringify({ shingles: sh, authors: (meta.authors || []).map(a => `${a.given} ${a.family}`.trim()), abstract: (meta.abstract || '').slice(0, 1500) })]);
}

// ------------------------------------------------------------------ scoring

function riskLevel(signals) {
  const score = signals.reduce((a, s) => a + s.weight, 0);
  const highs = signals.filter(s => s.severity === 'high').length;
  let level = score >= 8 || highs >= 2 ? 'HIGH' : score >= 4 || highs === 1 ? 'MEDIUM' : 'LOW';
  return { level, score, highSignals: highs };
}

/** The text-only signals (no network): the exact logic used by detectPaperMill and by the benchmark. */
async function textSignals(text, body = text, custom = []) {
  const signals = [];
  const sig = (group, code, title, severity, weight, evidence = [], note = '') => signals.push({ group, code, title, severity, weight, evidence, note });
  const screener = await screenerMatches(body);
  const tortured = torturedPhrases(body, custom);
  const known = new Set(tortured.map(t => t.phrase.toLowerCase()));
  for (const t of screener.tortured) if (!known.has(t.phrase.toLowerCase())) tortured.push(t);
  if (screener.scigen.length >= 2) sig('text', 'scigen', `Text matching computer-generated (SCIgen) papers: ${screener.scigen.length} fingerprint(s)`, screener.scigen.length >= 4 ? 'high' : 'medium', screener.scigen.length >= 4 ? 5 : 3,
    screener.scigen.slice(0, 8).map(s => ({ text: `“${s.phrase}”`, quote: s.examples[0] })), 'Sentences found in papers generated by SCIgen-style programs (Problematic Paper Screener fingerprints).');
  if (screener.suspect.length) sig('text', 'suspect', `${screener.suspect.length} suspect expression(s) (typos or template residue)`, 'low', Math.min(2, screener.suspect.length),
    screener.suspect.slice(0, 8).map(s => ({ text: `“${s.phrase}”${s.note ? ` — ${s.note}` : ''}`, quote: s.examples[0] })), 'Typos and leftovers that the Problematic Paper Screener has seen in problematic papers; weak on their own.');
  if (tortured.length) sig('text', 'tortured', `${tortured.length} tortured phrase(s): ${tortured.slice(0, 3).map(t => `“${t.phrase}” (= ${t.correct})`).join(', ')}`, tortured.length >= 3 ? 'high' : 'medium', tortured.length >= 3 ? 5 : 2,
    tortured.map(t => ({ text: `“${t.phrase}” → ${t.correct}${t.count > 1 ? ` (×${t.count})` : ''}`, quote: t.examples[0] })), 'Odd synonyms produced by paraphrasing tools to hide copied text (Problematic Paper Screener).');
  const ai = aiLeftovers(text);
  if (ai.length) sig('text', 'ai-leftover', `AI-generated text or template left in the manuscript (${ai.length})`, 'high', Math.min(6, 4 + ai.length - 1), ai.map(a => ({ text: a.label, quote: a.example })), 'Only definite traces are flagged; no AI-probability score is used.');
  const tmpl = templateWording(body);
  if (tmpl.length >= 3) sig('text', 'template', `Wording typical of paper-mill templates (${tmpl.length} features)`, tmpl.length >= 5 ? 'medium' : 'low', tmpl.length >= 5 ? 2 : 1, tmpl.map(t => ({ text: t.label, quote: t.example })), 'These methods are legitimate on their own; several together are typical of templated mill papers.');
  const methods = methodsGaps(body);
  if (methods.gaps.length) sig('text', 'methods', `Methods too vague to repeat (${methods.gaps.length})`, methods.gaps.some(g => g.code === 'ethics') ? 'medium' : 'low', methods.gaps.some(g => g.code === 'ethics') ? 1 : 0, methods.gaps.map(g => ({ text: g.message })));

  const hid = hiddenText(text);
  if (hid.zero >= 5 || hid.mixed.length) {
    const strongHid = hid.mixed.length >= 2 || hid.zero >= 20;
    sig('text', 'hidden-text', `Hidden characters or mixed-alphabet words (${hid.zero} invisible characters, ${hid.mixed.length} mixed-alphabet words)`, strongHid ? 'high' : 'medium', strongHid ? 4 : 2,
      [...(hid.zero ? [{ text: `${hid.zero} zero-width / soft-hyphen characters` }] : []), ...hid.mixed.map(w => ({ text: `Word mixing Latin and Cyrillic/Greek letters: “${w}”` }))], 'Used to defeat plagiarism-detection software; normal text contains neither.');
  }

  const cells = cellLines(body);
  if (cells.length) sig('data', 'cell-lines', `${cells.length} misidentified or contaminated cell line(s) named`, 'medium', Math.min(4, 2 * cells.length), cells.map(c => ({ text: c.nonVerifiable ? `${c.name}: ${c.actual}` : `${c.name} is actually ${c.actual} (ICLAC register)`, quote: c.example })), 'Results attributed to the named tissue may be invalid; ask for authentication (STR profile).');
  // ---- phase 3: statistics that do not add up, primer sanity
  const stats = DC.statisticsCheck(text);
  const gross = stats.findings.filter(f => f.gross);
  const impossible = stats.findings.filter(f => f.kind === 'impossible');
  if (gross.length >= 2 || impossible.length) sig('data', 'statistics', `Reported statistics do not add up (${stats.findings.length}; ${gross.length} change the conclusion)`, gross.length >= 3 || impossible.length ? 'medium' : 'low', gross.length >= 3 || impossible.length ? 3 : 1.5,
    stats.findings.slice(0, 8).map(f => ({ text: `${f.reported} - recalculated: ${f.recalculated}${f.gross ? ' (changes the conclusion)' : ''}`, quote: f.quote })), 'p-values are recalculated from the reported t, F, chi-square, r or z statistic, and percentages from their counts. Honest rounding or typing errors exist in many papers; look at the pattern, not one value.');
  else if (gross.length === 1) sig('data', 'statistics', 'One reported statistic does not add up', 'low', 1, [{ text: `${gross[0].reported} - recalculated: ${gross[0].recalculated}`, quote: gross[0].quote }], 'A single inconsistent value is often a typing error; check the original data.');
  else if (stats.findings.length >= 4) sig('data', 'statistics-minor', `Several small rounding inconsistencies in reported statistics (${stats.findings.length})`, 'low', 0.5, stats.findings.slice(0, 6).map(f => ({ text: `${f.reported} - recalculated: ${f.recalculated}`, quote: f.quote })));
  const primers = DC.findPrimers(text);
  const primerIssues = DC.primerSanity(primers);
  if (primerIssues.length) sig('data', 'primers', `Primer / sequence problems (${primerIssues.length})`, primerIssues.some(i => /identical|different genes|reverse complement/.test(i.message)) ? 'medium' : 'low', primerIssues.some(i => /identical|different genes|reverse complement/.test(i.message)) ? 2 : 1,
    primerIssues.slice(0, 8).map(i => ({ text: `${i.primer.gene || 'primer'} ${i.primer.direction} 5'-${i.primer.sequence}-3': ${i.message}`, quote: i.primer.quote })), 'Primer sequences were read from the text and checked for sense (length, GC content, forward = reverse, one primer for two genes).');
  signals.details = { tortured, ai, tmpl, methods, hid, cells, stats, primers, primerIssues };
  return signals;
}

/**
 * input: { text (whole manuscript), body, meta, references: reference-check results, pattern?, suggestedReviewers?,
 *          images?: Module 5 summary { findings, level } }
 */
async function detectPaperMill(input, update = () => {}) {
  const text = input.text || input.body || '';
  const body = input.body || text;
  const meta = input.meta || {};
  const refs = input.references || [];
  const signals = [];
  const sig = (group, code, title, severity, weight, evidence = [], note = '') => signals.push({ group, code, title, severity, weight, evidence, note });

  await D.warmEmailDomains();
  update('Searching for tortured phrases and AI-text leftovers', 2);
  const textSigs = await textSignals(text, body, await customPhrases());
  signals.push(...textSigs);
  const { tortured, ai, tmpl, methods, hid, cells, stats, primers, primerIssues } = textSigs.details;

  // Seek & Blastn: does each primer match the gene it is claimed to amplify? (NCBI BLAST, online only)
  let blast = [];
  if (primers.length && input.blast !== false && isOnline()) {
    update('Checking primers against NCBI (Seek & Blastn)', 8);
    blast = await DC.seekAndBlast(primers, { limit: 4, update: s => update(s, 9) }).catch(() => []);
    const wrong = blast.filter(b => b.checked && !b.matches);
    if (wrong.length) signals.push({ group: 'data', code: 'primer-gene', title: `${wrong.length} primer(s) do not match the gene they are said to amplify`, severity: wrong.length >= 2 ? 'high' : 'medium', weight: wrong.length >= 2 ? 4 : 3,
      evidence: wrong.map(b => ({ text: `${b.primer.gene} ${b.primer.direction} 5'-${b.primer.sequence}-3' - top NCBI hits: ${b.hits.slice(0, 3).join(' | ') || 'none'}`, quote: b.primer.quote })), note: 'The primer was searched in NCBI BLAST (RefSeq RNA). A primer that hits other genes, or nothing, points to a wrong or invented sequence (Seek & Blastn method). Check the full BLAST result before drawing a conclusion.' });
  }

  // Cellosaurus (SIB / ExPASy): every named cell line that the built-in ICLAC list did not already report is looked up
  // for a "Problematic cell line" note (contaminated, misidentified) and, when called a cell line, for its existence
  // (offline - desktop - the bulk copy of Cellosaurus's problematic lines still answers; "not found" needs the live API)
  if (input.cellosaurus !== false) {
    const names = cellLineCandidates(body, new Set(cells.map(c => c.name.toLowerCase()))).slice(0, 12);
    if (names.length) {
      update('Checking named cell lines in Cellosaurus', 10);
      const found = await Promise.all(names.map(async c => ({ ...c, rec: await D.cellosaurusLookup(c.name).catch(() => null) })));
      const flagged = found.filter(c => c.rec?.found && c.rec.problematic);
      // "Misclassified" (e.g. HepG2: hepatoblastoma, long described as hepatocellular carcinoma) is a labelling note;
      // contamination and misidentification mean the cells are not what the paper says
      const problematic = flagged.filter(c => !/^Misclassified/i.test(c.rec.problematic));
      const misclassified = flagged.filter(c => /^Misclassified/i.test(c.rec.problematic));
      const ev = c => ({ text: `${c.rec.name} (${c.rec.accession}): ${c.rec.problematic}`, quote: c.example, link: c.rec.accession ? `https://www.cellosaurus.org/${c.rec.accession}` : null });
      const unknown = isOnline() ? found.filter(c => c.rec && !c.rec.found && c.calledLine) : [];
      if (problematic.length) sig('data', 'cellosaurus-problematic', `${problematic.length} contaminated or misidentified cell line(s) in Cellosaurus`, 'medium', Math.min(4, 2 * problematic.length),
        problematic.map(ev), 'Cellosaurus records contamination and misidentification reported in the literature. Ask the authors for an STR authentication profile.');
      if (misclassified.length) sig('data', 'cellosaurus-misclassified', `${misclassified.length} cell line(s) with a Cellosaurus misclassification note`, 'low', 0.5,
        misclassified.map(ev), 'Check that the paper describes the cell line\'s tissue of origin correctly; not a sign of misconduct by itself.');
      if (unknown.length) sig('data', 'cellosaurus-unknown', `${unknown.length} named cell line(s) not found in Cellosaurus`, 'low', 1,
        unknown.map(c => ({ text: `${c.name} - no Cellosaurus entry under this name or its synonyms`, quote: c.example })), 'Often a spelling variant; an invented cell line name is a known paper-mill sign. Ask for the supplier and catalogue number.');
    }
  }

  // Institutions far apart
  const spread = DC.affiliationSpread(meta.affiliations || [], (meta.authors || []).length);
  if (spread.far) signals.push({ group: 'authors', code: 'institutions-far', title: `Authors' institutions are in ${spread.countries.length} countries (${spread.countries.join(', ')})`, severity: 'low', weight: spread.countries.length >= 3 && (meta.authors || []).length <= 4 ? 2 : 1,
      evidence: Object.entries(spread.byCountry).map(([c, a]) => ({ text: `${c}: ${a[0]}` })), note: 'Many countries on a short author list with no stated collaboration is a paper-mill pattern (authorship for sale). International teams are common; ask the corresponding author how the group worked together if it is not clear.' });

  update('Checking whether the paper is already published', 15);
  const pub = await publishedElsewhere(meta.title).catch(() => []);
  if (pub.length) sig('data', 'published', `A paper with the same title is already published (${pub.length})`, 'medium', 3,
    pub.map(p => ({ text: `“${p.title}” — ${p.journal || 'journal unknown'}${p.year ? ', ' + p.year : ''} (found in ${p.sources.join(', ')})`, link: p.doi ? `https://doi.org/${p.doi}` : p.url })), "Possible duplicate publication or resubmission; it may also be the authors' own preprint or thesis - check before concluding.");

  update('Checking reference signals', 25);
  const fake = refs.filter(r => r.status === 'suspicious');
  if (fake.length) sig('references', 'fabricated', `${fake.length} reference(s) not found in any database (possibly fabricated)`, fake.length >= 3 ? 'high' : 'medium', fake.length >= 3 ? 4 : 2, fake.slice(0, 10).map(r => ({ text: `[${r.index}] ${r.raw.slice(0, 160)}`, note: r.reason })));
  const millRetracted = refs.filter(r => r.retraction && D.MILL_REASON_RE.test(r.retraction.reason || ''));
  if (millRetracted.length) sig('references', 'mill-retraction', `${millRetracted.length} cited paper(s) retracted for paper-mill reasons`, 'high', Math.min(8, 4 * millRetracted.length), millRetracted.map(r => ({ text: `[${r.index}] ${r.record?.title || r.raw.slice(0, 140)}`, note: r.retraction.reason?.split(';').slice(0, 3).join('; ') })));
  const otherRetracted = refs.filter(r => r.status === 'retracted' && !millRetracted.includes(r));
  if (otherRetracted.length) sig('references', 'retracted', `${otherRetracted.length} retracted paper(s) cited`, 'low', 1, otherRetracted.map(r => ({ text: `[${r.index}] ${r.record?.title || r.raw.slice(0, 140)}` })));

  const journals = new Map();
  for (const r of refs) {
    const j = r.record?.journal || r.parsed?.journal;
    if (!j) continue;
    const k = normalizeJournal(j);
    if (!journals.has(k)) journals.set(k, { name: j, issns: new Set(), refs: [] });
    journals.get(k).refs.push(r.index);
    for (const i of r.record?.issn || []) journals.get(k).issns.add(i);
  }
  const refList = idx => idx.map(i => `[${i}]`).join(' ');
  const yearOf = new Map(refs.map(r => [r.index, parseInt(r.record?.year || r.parsed?.year, 10) || null]));
  const risky = [], clones = [], citejacked = [], dropped = [];
  for (const j of [...journals.values()].slice(0, 80)) {
    const m = await D.predatoryMatches({ journal: j.name, issns: [...j.issns] }).catch(() => []);
    // a hijacked-list name match only says that a clone of the journal exists (most such journals are genuine and indexed)
    if (m.some(x => x.kind !== 'hijacked')) risky.push({ ...j, kind: 'predatory' });
    else if (m.some(D.isCitejacked)) citejacked.push({ ...j, papers: m.find(D.isCitejacked).papers });
    else if (m.length) clones.push({ ...j, clone: m[0].domain, genuine: m[0].genuine_url });
    // Scopus discontinued the journal (Elsevier's Discontinued Titles sheet): references from its last covered year on
    const hit = (await D.listLookupAll([...j.issns], j.name).catch(() => ({}))).scopus_discontinued;
    if (hit && !/policy/i.test(hit.data?.['Indexation Change'] || '')) {
      const year = parseInt(hit.data?.Year, 10) || null;
      const after = year ? j.refs.filter(i => (yearOf.get(i) || 0) >= year) : j.refs;
      if (after.length) dropped.push({ ...j, refs: after, year });
    }
  }
  // the reference's own link on a clone website
  for (const r of refs) {
    const url = r.parsed?.url || r.record?.url;
    if (!url || risky.some(j => j.refs.includes(r.index))) continue;
    const h = (await D.predatoryMatches({ homepage: url }).catch(() => [])).find(x => x.kind === 'hijacked');
    if (h) risky.push({ name: `${h.name} (clone site ${h.domain})`, refs: [r.index], kind: 'hijacked' });
  }
  const riskyRefs = risky.reduce((a, j) => a + j.refs.length, 0);
  if (riskyRefs) sig('references', 'predatory', `${riskyRefs} reference(s) to predatory or hijacked journals`, riskyRefs >= 3 ? 'medium' : 'low', riskyRefs >= 3 ? 3 : 1, risky.map(j => ({ text: `${j.name} (${j.kind}) — refs ${refList(j.refs)}` })));
  const droppedRefs = dropped.reduce((a, j) => a + j.refs.length, 0);
  if (droppedRefs) sig('references', 'scopus-discontinued', `${droppedRefs} reference(s) to journals discontinued by Scopus, published after Scopus stopped covering them`, 'low', droppedRefs >= 3 ? 1 : 0,
    dropped.map(j => ({ text: `${j.name} — Scopus coverage ends ${j.year || '(year not given)'} — refs ${refList(j.refs)}` })), 'Scopus drops journals after re-evaluation for publication concerns. On the benchmark (150 paper-mill retractions vs 126 ordinary papers) one or two such references were equally common in both groups, so they do not add to the risk score; three or more count a little.');
  // the screener's citejacked detector flags papers that cite these journals (the citations usually point to the hijacked version)
  const cjRefs = citejacked.reduce((a, j) => a + j.refs.length, 0);
  if (cjRefs) sig('references', 'citejacked', `${cjRefs} reference(s) to journals on the Problematic Paper Screener "citejacked" list`, cjRefs >= 2 ? 'medium' : 'low', cjRefs >= 2 ? 2 : 1,
    citejacked.map(j => ({ text: `${j.name}${j.papers ? ` (${j.papers.toLocaleString('en')} papers found citing its hijacked version)` : ''} — refs ${refList(j.refs)}` })), 'The hijacked versions of these journals publish mill-type papers that are then cited. Check whether each cited article is from the genuine journal (its DOI resolves to the genuine site).');
  const cloneRefs = clones.reduce((a, j) => a + j.refs.length, 0);
  if (cloneRefs) sig('references', 'hijacked-clone', `${cloneRefs} reference(s) to journals with a known hijacked clone website`, 'low', 0,
    clones.map(j => ({ text: `${j.name} — clone ${j.clone}${j.genuine ? `, genuine site ${j.genuine}` : ''} — refs ${refList(j.refs)}` })), 'Check that the cited articles come from the genuine journal (its DOI resolves to the genuine site) and not from the clone.');
  for (const f of (input.pattern?.flags || []).filter(f => ['citation-stacking', 'author-concentration', 'journal-concentration', 'irrelevant-self-citation', 'citation-blocks'].includes(f.code))) {
    sig('references', 'stacking', f.message, f.severity === 'high' ? 'medium' : 'low', f.severity === 'high' ? 2 : 1, [], f.guidance);
  }
  // Journals with many paper-mill retractions (Retraction Watch). Benchmark (150 mill-retracted vs 126 ordinary papers):
  // >= 3 references and >= 15% of the list: 16/150 vs 3/126; >= 5 and >= 20%: 9/150 vs 1/126 (scripts/benchmark-papermill-refs.js).
  const millByJournal = new Map();   // full and abbreviated forms of one journal are grouped under its Retraction Watch name
  for (const j of [...journals.values()].slice(0, 80)) {
    const m = await D.millJournalFor(j.name).catch(() => null);
    if (!m) continue;
    if (!millByJournal.has(m.norm)) millByJournal.set(m.norm, { name: m.name, refs: [], mill: m.mill, total: m.total });
    millByJournal.get(m.norm).refs.push(...j.refs);
  }
  const millJ = [...millByJournal.values()];
  const millJRefs = millJ.reduce((a, j) => a + j.refs.length, 0);
  const millJShare = refs.length ? millJRefs / refs.length : 0;
  if (millJRefs >= 3 && millJShare >= 0.15) {
    const strongJ = millJRefs >= 5 && millJShare >= 0.2;
    sig('references', 'mill-journals', `${millJRefs} reference(s) (${Math.round(millJShare * 100)}%) to journals with many paper-mill retractions`, strongJ ? 'medium' : 'low', strongJ ? 2 : 1,
      millJ.sort((a, b) => b.refs.length - a.refs.length).map(j => ({ text: `${j.name} - ${j.mill} paper-mill retractions in Retraction Watch - refs ${j.refs.map(i => `[${i}]`).join(' ')}` })),
      'These journals published large numbers of paper-mill articles that were later retracted (Retraction Watch). Citing them is not wrong in itself; a reference list built largely on them is a pattern seen in mill papers. Check that the cited papers are sound and relevant.');
  }

  update('Checking authors (retractions, ORCID, e-mail addresses)', 40);
  const authors = (meta.authors || []).filter(a => a.family);
  const orcids = [...new Set([...text.slice(0, 15000).matchAll(ORCID_RE)].map(m => m[1]))];
  const orcidResults = [];
  if (!orcids.length) sig('authors', 'no-orcid', 'No ORCID iD given for any author', 'low', 1);
  for (const id of orcids.slice(0, 10)) {
    if (!orcidValid(id)) { orcidResults.push({ id, valid: false }); continue; }
    const p = await orcidProfile(id).catch(e => ({ id, error: e.message }));
    orcidResults.push({ ...p, valid: true });
  }
  const badOrcid = orcidResults.filter(o => o.valid === false || o.exists === false);
  const emptyOrcid = orcidResults.filter(o => o.exists && o.works === 0);
  if (badOrcid.length) sig('authors', 'orcid-invalid', `${badOrcid.length} ORCID iD(s) invalid or not registered`, 'medium', 2, badOrcid.map(o => ({ text: o.id })));
  if (emptyOrcid.length) sig('authors', 'orcid-empty', `${emptyOrcid.length} ORCID record(s) with no publications`, 'low', 1, emptyOrcid.map(o => ({ text: `${o.id}${o.name ? ' — ' + o.name : ''}`, link: `https://orcid.org/${o.id}` })));
  // Retracted papers on the authors' own ORCID records: exact DOI match with Retraction Watch (identity confirmed by ORCID)
  const orcidRetr = [];
  const ownDois = orcidResults.flatMap(o => (o.dois || []).map(doi => ({ doi, o })));
  if (ownDois.length) {
    const rw = await D.retractionsFor(ownDois.map(x => x.doi)).catch(() => new Map());
    for (const { doi, o } of ownDois) {
      const r = rw.get(doi);
      if (r && /retraction/i.test(r.nature || '') && !orcidRetr.some(x => x.doi === doi)) orcidRetr.push({ orcid: o.id, name: o.name, doi, title: r.title, journal: r.journal, date: r.retraction_date, reason: r.reason, mill: D.MILL_REASON_RE.test(r.reason || '') });
    }
  }
  const orcidEv = r => ({ text: `${r.name || r.orcid} (ORCID ${r.orcid}): “${r.title}” (${r.journal}, retracted ${r.date})`, note: r.reason?.split(';').slice(0, 3).join('; '), link: `https://doi.org/${r.doi}` });
  const orcidMill = orcidRetr.filter(r => r.mill);
  if (orcidMill.length) sig('authors', 'orcid-mill-retraction', `ORCID record(s) list paper(s) retracted for paper-mill or fake-peer-review reasons (${orcidMill.length})`, 'high', 5, orcidMill.map(orcidEv), "The DOI on the author's own ORCID record matches a Retraction Watch entry exactly. Confirm that the ORCID iD belongs to the author named in the manuscript.");
  const orcidOther = orcidRetr.filter(r => !r.mill);
  if (orcidOther.length) sig('authors', 'orcid-retraction', `ORCID record(s) list retracted paper(s) (${orcidOther.length})`, 'medium', 2, orcidOther.map(orcidEv), "Exact DOI match between the author's ORCID record and Retraction Watch. Retractions for honest error happen; read the reason.");
  // Name matching in Retraction Watch; a paper already found through an ORCID record is not counted twice
  const orcidRetrDois = new Set(orcidRetr.map(r => r.doi));
  const retr = (await authorRetractions(authors, meta.affiliations)).filter(r => !orcidRetrDois.has(String(r.doi || '').toLowerCase()));
  const sure = r => r.confidence !== 'low';
  const millRetr = retr.filter(r => r.mill && sure(r));
  const confNote = r => `${r.confidence} confidence${r.institutionMatch?.length ? ` (institution matches: ${r.institutionMatch.join(', ')})` : r.confidence === 'low' ? ' - surname and initial only, may be a different person' : ''}`;
  if (millRetr.length) sig('authors', 'author-mill-retraction', `Author(s) with earlier retractions for paper-mill or fake-peer-review reasons (${millRetr.length})`, 'high', 5, millRetr.map(r => ({ text: `${r.author}: “${r.title}” (${r.journal}, retracted ${r.date}) - ${confNote(r)}`, note: r.reason?.split(';').slice(0, 3).join('; '), link: r.doi ? `https://doi.org/${r.doi}` : null })), 'Matched by name in Retraction Watch — confirm it is the same person (affiliation, ORCID).');
  else if (retr.some(sure)) sig('authors', 'author-retraction', `Author(s) with earlier retractions (${retr.filter(sure).length})`, 'medium', 2, retr.filter(sure).map(r => ({ text: `${r.author}: “${r.title}” (${r.journal}, retracted ${r.date}) - ${confNote(r)}`, note: r.reason?.split(';').slice(0, 2).join('; '), link: r.doi ? `https://doi.org/${r.doi}` : null })), 'Matched by name in Retraction Watch — confirm it is the same person.');
  const unsure = retr.filter(r => !sure(r));
  if (unsure.length) sig('authors', 'author-retraction-name', `Possible earlier retraction(s) under a similar name (${unsure.length}) - probably other people`, 'low', 0.5, unsure.slice(0, 6).map(r => ({ text: `${r.author}: “${r.title}” (${r.journal}, retracted ${r.date}) - ${confNote(r)}`, link: r.doi ? `https://doi.org/${r.doi}` : null })), 'Retraction Watch gives author names only. These hits match the surname and first initial only; for common names they are usually different people. Check ORCID and affiliation before drawing any conclusion.');

  const emails = emailsOf(text);
  const disposable = emails.filter(e => DISPOSABLE_MAIL.test(e));
  if (disposable.length) sig('authors', 'disposable-mail', `Disposable (throw-away) e-mail address(es) given for authors (${disposable.length})`, 'medium', 2, disposable.map(e => ({ text: e })), 'Throw-away mailboxes expire after minutes or days, so the author cannot be reached later. Domain listed in the disposable-email-domains register.');
  const free = emails.filter(e => FREE_MAIL.test(e));
  if (emails.length && free.length === emails.length) sig('authors', 'free-mail', `All author e-mail addresses are free-mail accounts (${free.length})`, 'low', 1, free.map(e => ({ text: e })), 'Common and often legitimate in Pakistan; counts only together with other signals.');

  const offTopicAff = (meta.affiliations || []).filter(a => NON_BIOMED.test(a));
  if (offTopicAff.length && (meta.affiliations || []).length) sig('authors', 'affiliation', 'Affiliation(s) unrelated to a pharmaceutical/biomedical topic', 'low', 1, offTopicAff.map(a => ({ text: a })), 'Interdisciplinary teams are common; check that each author\'s contribution is plausible.');

  const prev = await previousAuthors(meta.manuscriptCode, meta.version).catch(() => null);
  if (prev && authors.length) {
    const now = authors.map(a => `${a.given} ${a.family}`.trim());
    const same = (x, y) => !!nameMatch(splitName(x), splitName(y));
    const added = now.filter(n => !prev.some(p => same(p, n)));
    const removed = prev.filter(p => !now.some(n => same(p, n)));
    const reordered = !added.length && !removed.length && prev.join('|') !== now.join('|');
    if (added.length || removed.length || reordered) sig('authors', 'authorship-change', 'Authors changed since the earlier version', added.length ? 'medium' : 'low', added.length ? 2 : 1,
      [...added.map(n => ({ text: `Added: ${n}` })), ...removed.map(n => ({ text: `Removed: ${n}` })), ...(reordered ? [{ text: `Order changed: ${prev.join(', ')} → ${now.join(', ')}` }] : [])], 'Authorship sold by paper mills often appears as authors added during revision.');
  }

  const revText = String(input.suggestedReviewers || '');
  if (revText.trim()) {
    const revEmails = [...new Set((revText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(e => e.toLowerCase()))];
    const authorDomains = new Set(emails.map(e => e.split('@')[1]).filter(d => !FREE_MAIL.test('@' + d)));
    const issues = [];
    for (const e of revEmails) {
      if (DISPOSABLE_MAIL.test(e)) issues.push({ text: `${e} — disposable (throw-away) address for a suggested reviewer` });
      else if (FREE_MAIL.test(e)) issues.push({ text: `${e} — free-mail address for a suggested reviewer` });
      else if (authorDomains.has(e.split('@')[1])) issues.push({ text: `${e} — same institution e-mail domain as an author` });
    }
    for (const a of authors) if (new RegExp(`\\b${esc(a.family)}\\b`, 'i').test(revText) && a.family.length > 3) issues.push({ text: `A suggested reviewer shares the surname “${a.family}” with an author` });
    if (issues.length) sig('authors', 'reviewers', `Suggested reviewers raise concerns (${issues.length})`, issues.length >= 2 ? 'medium' : 'low', issues.length >= 2 ? 2 : 1, issues, 'Fake reviewer accounts with free-mail addresses are a known paper-mill technique.');
  }

  update('Checking cell lines and earlier submissions', 70);

  const dup = await duplicateSubmissions({ body, meta, excludeCode: meta.manuscriptCode }).catch(e => ({ compared: 0, matches: [], shingles: [], error: e.message }));
  const strong = dup.matches.filter(m => m.textOverlap >= 50 || m.titleSimilarity >= 90);
  if (strong.length) sig('data', 'duplicate', `Matches an earlier PJPS submission (${strong.length})`, 'high', 5, strong.map(m => ({ text: `${m.manuscriptCode || 'check #' + m.checkId}: “${m.title || ''}” — ${m.textOverlap}% text overlap${m.titleSimilarity >= 90 ? `, title ${m.titleSimilarity}% similar` : ''}`, checkId: m.checkId })));
  else if (dup.matches.length) sig('data', 'duplicate-partial', `Partial text overlap with earlier PJPS submission(s) (${dup.matches.length})`, 'medium', 3, dup.matches.map(m => ({ text: `${m.manuscriptCode || 'check #' + m.checkId}: “${m.title || ''}” — ${m.textOverlap}% overlap`, checkId: m.checkId })));

  if (input.images?.findings) {
    const f = input.images.findings;
    const cat = input.images.categories || {};
    const catText = Object.entries({ duplication: 'duplicated', manipulation: 'manipulated', ai: 'AI-generated', chart: 'duplicated-chart' }).filter(([k]) => cat[k]).map(([k, l]) => `${cat[k]} ${l}`).join(', ');
    if (f.high) sig('data', 'images', `Image Integrity (Module 5): ${f.high} strong finding(s)${catText ? ` (${catText})` : ' of duplicated or edited figures'}`, 'high', 5);
    else if (f.medium) sig('data', 'images', `Image Integrity (Module 5): ${f.medium} finding(s) to check`, 'medium', 2);
  }

  const risk = riskLevel(signals);
  const groups = ['text', 'references', 'authors', 'data'];
  return {
    kind: 'papermill',
    module: 4,
    meta: { ...meta, authors: authors.map(a => ({ name: a.name || `${a.given} ${a.family}`.trim(), given: a.given, family: a.family })) },
    createdAt: new Date().toISOString(),
    datasets: await require('../datasets').datasetHealth(),
    risk,
    signals: signals.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || b.weight - a.weight),
    details: {
      tortured, aiLeftovers: ai, templates: tmpl, methods, cellLines: cells, statistics: { findings: stats.findings.slice(0, 30), checked: stats.checked }, primers: { found: primers.length, issues: primerIssues.length, blast: blast.map(b => ({ gene: b.primer.gene, direction: b.primer.direction, sequence: b.primer.sequence, checked: b.checked, matches: b.matches ?? null, hits: b.hits || [], error: b.error || null })) }, affiliationSpread: spread, emails, freeMail: free, orcids: orcidResults,
      authorRetractions: retr, orcidRetractions: orcidRetr, millJournals: millJ.map(j => ({ name: j.name, refs: j.refs, mill: j.mill })), duplicates: { compared: dup.compared, matches: dup.matches }, publishedElsewhere: pub, hiddenText: hid,
      references: { total: refs.length, fabricated: fake.length, retracted: refs.filter(r => r.status === 'retracted').length, millRetracted: millRetracted.length, riskyJournals: risky }
    },
    checked: {
      text: true, statistics: stats.checked.pTests + stats.checked.percentages, primers: primers.length, primersBlasted: blast.filter(b => b.checked).length, references: refs.length > 0, authors: authors.length > 0, orcid: orcids.length > 0, reviewers: !!revText.trim(),
      previousVersion: !!prev, images: !!input.images, earlierSubmissions: dup.compared
    },
    disclaimer: 'Screening aid only. The risk level shows where to look closer; it is not proof of misconduct and never rejects a paper by itself. The editor decides. Confidential — not for authors or reviewers.',
    _shingles: dup.shingles
  };
}

function papermillProblems(r) {
  return [`Paper mill risk ${r.risk.level} (score ${r.risk.score})`, ...r.signals.filter(s => s.severity !== 'low').slice(0, 5).map(s => s.title)];
}

module.exports = { textSignals, methodsGaps, screenerMatches, detectPaperMill, publishedElsewhere, storeFingerprint, papermillProblems, torturedPhrases, aiLeftovers, templateWording, cellLines, cellLineCandidates, orcidValid, orcidProfile, emailsOf, hiddenText, shingles, fnv, riskLevel };
