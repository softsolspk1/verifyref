// checks/refQuality.js - Module 1 reference quality, as Proofig RefGuard reports it:
//   paratexts   - references whose matched record is not a research paper but an erratum, editorial, letter / comment,
//                 retraction or concern notice, book review, meeting abstract or front matter (cited as if it were a paper)
//   scores      - Quality, Impact, Recency and Diversity, 0-100, each with the facts it is built from
//   comparison  - the same scores averaged over the earlier manuscripts screened in this system (only real PJPS
//                 submissions, shown once there are at least 10 of them)
const db = require('../db');
const { normalizeJournal } = require('../text');

const PARATEXT = [
  ['erratum', 'Erratum / correction notice', /^(?:erratum|corrigendum|correction(?: to)?|errata|addendum)\b|^(?:author )?correction:|\bcorrection to:/i, ['erratum']],
  ['retraction-notice', 'Retraction or concern notice', /^(?:retraction(?: note| notice)?|retracted article|notice of retraction|expression of concern|withdrawal)\b(?!\s+(?:of|in)\s+(?:the|a)\s+\w+\s+(?:literature|science|research))/i, ['retraction']],
  ['editorial', 'Editorial', /^(?:editorial|guest editorial|editor'?s? (?:note|choice|introduction)|from the editors?|in this issue)\b/i, ['editorial']],
  ['letter', 'Letter, comment or reply', /^(?:letter(?: to the editor)?|comment(?:ary)? on|re:|reply(?: to)?|response to|in reply|author'?s? reply|authors'? response)\b/i, ['letter']],
  ['book-review', 'Book review', /^book reviews?\b/i, []],
  ['abstract', 'Meeting abstract', /^(?:abstracts?\b|meeting abstracts?|conference abstracts?|poster)\b|\babstracts? of the\b.*\b(?:congress|conference|meeting|symposium)\b/i, []],
  ['front-matter', 'Front matter / table of contents', /^(?:front matter|back matter|table of contents|contents|masthead|cover image|issue information|title page)\b/i, ['paratext']]
];
const PEER_REVIEW = /^(?:peer-review|component)$/i;

/** References whose matched record is a notice, editorial, letter ... rather than a research paper */
function paratexts(results) {
  const out = [];
  for (const r of results) {
    if (r.status === 'suspicious') continue;
    // the matched record, or the title as cited (an "Erratum: …" can be matched to the paper it corrects)
    const cited = String(r.parsed?.title || '').trim();
    const title = String(r.record?.title || cited).trim();
    const oaType = String(r.openalex?.workType || '').toLowerCase();
    const crType = String(r.record?.type || '');
    let hit = PARATEXT.find(([, , re, types]) => re.test(title) || types.includes(oaType));
    let byCited = false;
    if (!hit && cited) { hit = PARATEXT.find(([, , re]) => re.test(cited)); byCited = !!hit; }
    if (!hit && PEER_REVIEW.test(crType)) hit = ['peer-review', 'Peer-review report or supplementary component', null, []];
    if (!hit) continue;
    // a retraction notice of the cited paper is already reported as Retracted
    if (hit[0] === 'retraction-notice' && r.status === 'retracted') continue;
    out.push({ index: r.index, kind: hit[0], label: hit[1], title: (byCited ? cited : title).slice(0, 200), basis: byCited ? 'title as cited in the manuscript' : oaType && hit[3]?.includes(oaType) ? `record type “${oaType}” (OpenAlex)` : crType && PEER_REVIEW.test(crType) ? `record type “${crType}” (Crossref)` : r.record ? 'title of the matched record' : 'title as cited in the manuscript' });
  }
  return out;
}

const clamp = v => Math.max(0, Math.min(100, Math.round(v)));
/** 1 - Herfindahl index, scaled so that n different items = 1 and one item = 0 */
function spread(keys) {
  const k = keys.filter(Boolean);
  if (k.length < 2) return null;
  const n = new Map();
  for (const x of k) n.set(x, (n.get(x) || 0) + 1);
  const hhi = [...n.values()].reduce((a, c) => a + (c / k.length) ** 2, 0);
  return (1 - hhi) / (1 - 1 / k.length);
}

/**
 * Four 0-100 scores with their facts. results: Module 1 results; journals: cited-journal check (may be null);
 * indicators: bibliographyIndicators() output; para: paratexts().
 */
function scores(results, journals, indicators, para) {
  const n = results.length;
  if (!n) return null;
  const risky = new Set((indicators?.riskyJournals || []).flatMap(j => j.refs));
  const paraSet = new Set(para.map(p => p.index));
  // Quality: real, citable research papers from sound sources
  const real = results.filter(r => ['verified', 'miscited'].includes(r.status) || (r.status === 'unverified' && r.notIndexed));
  const bad = results.filter(r => ['suspicious', 'retracted'].includes(r.status) || risky.has(r.index) || paraSet.has(r.index));
  const good = real.filter(r => !bad.includes(r));
  // share of sound references, with a further penalty for each problem reference (a retracted or invented one weighs more
  // than an unverifiable regional paper)
  const quality = clamp(good.length / n * 100 - bad.length / n * 50);
  // Impact: quartile of the cited journals (Scopus / SJR, else JCR), else how often the paper has been cited for its age
  const quart = new Map();
  for (const j of journals?.journals || []) {
    const q = j.indexing?.scopus?.quartile || j.indexing?.wos?.jcrQuartile;
    const m = String(q || '').match(/Q([1-4])/i);
    if (m) for (const i of j.refs || []) quart.set(i, +m[1]);
  }
  const qPoints = { 1: 1, 2: 0.75, 3: 0.45, 4: 0.2 };
  const withQ = results.filter(r => quart.has(r.index));
  const cites = results.filter(r => !quart.has(r.index) && Number.isFinite(r.openalex?.citedBy) && r.age !== null && r.age !== undefined);
  const citePoints = r => Math.min(1, Math.log10(1 + r.openalex.citedBy / Math.max(1, r.age + 1)) / 1.7); // ~50 citations a year = 1, ~5 a year = 0.46
  const impactParts = [...withQ.map(r => qPoints[quart.get(r.index)]), ...cites.map(citePoints)];
  const impact = impactParts.length >= Math.min(3, n) ? clamp(impactParts.reduce((a, b) => a + b, 0) / impactParts.length * 100) : null;
  // Recency: last 5 years count fully, 6-10 years 0.6, 11-20 years 0.25, older 0
  const aged = results.filter(r => r.age !== null && r.age !== undefined);
  const recency = aged.length ? clamp(aged.reduce((a, r) => a + (r.age <= 5 ? 1 : r.age <= 10 ? 0.6 : r.age <= 20 ? 0.25 : 0), 0) / aged.length * 100) : null;
  // Diversity: spread over journals and over first authors (one journal or one research group dominating scores low)
  const journalKey = r => normalizeJournal(r.record?.journal || r.parsed?.journal || '');
  const authorKey = r => { const a = (r.record?.authors || [])[0] || (r.parsed?.authors || [])[0]; return a?.family ? `${String(a.family).toLowerCase()} ${String(a.given || '').slice(0, 1).toLowerCase()}` : ''; };
  const dj = spread(results.map(journalKey)), da = spread(results.map(authorKey));
  const parts = [dj, da].filter(x => x !== null);
  const diversity = parts.length ? clamp(parts.reduce((a, b) => a + b, 0) / parts.length * 100) : null;
  const distinctJournals = new Set(results.map(journalKey).filter(Boolean)).size;
  const topJournal = (() => { const m = new Map(); for (const r of results) { const k = r.record?.journal || r.parsed?.journal; if (k) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1])[0] || null; })();
  return {
    quality: { score: quality, facts: `${real.length} of ${n} references are real, citable papers; ${bad.length} retracted, suspicious, predatory-journal or non-paper references` },
    impact: { score: impact, facts: impact === null ? 'Too few references with a journal quartile or citation count' : `${withQ.length} with a journal quartile (Scopus / JCR), ${cites.length} by citations per year (OpenAlex)` },
    recency: { score: recency, facts: aged.length ? `${indicators?.age?.recentShare ?? '—'}% from the last ${indicators?.age?.rule?.years || 5} years, ${indicators?.age?.within10Share ?? '—'}% from the last 10` : 'No publication years found' },
    diversity: { score: diversity, facts: `${distinctJournals} different journals${topJournal && topJournal[1] > 1 ? `; most cited: ${topJournal[0]} (${topJournal[1]})` : ''}` }
  };
}

const KEYS = ['quality', 'impact', 'recency', 'diversity'];
const BASE = 'refquality_baseline';

/** Average of each score over earlier screened manuscripts: { n, quality, impact, recency, diversity } */
async function baseline() {
  try { return JSON.parse((await db.getMeta(BASE)) || 'null'); } catch (e) { return null; }
}

/** Adds this manuscript's scores to the running averages (one manuscript counted once per manuscript ID) */
async function record(sc, code) {
  if (!sc) return;
  const b = (await baseline()) || { n: 0, sums: {}, counts: {}, codes: [] };
  if (code && b.codes.includes(code)) return;
  b.n++;
  for (const k of KEYS) if (sc[k]?.score !== null && sc[k]?.score !== undefined) { b.sums[k] = (b.sums[k] || 0) + sc[k].score; b.counts[k] = (b.counts[k] || 0) + 1; }
  if (code) b.codes = [...b.codes, code].slice(-5000);
  await db.setMeta(BASE, JSON.stringify(b));
}

/** Comparison with the average of earlier PJPS submissions, or null below 10 manuscripts */
function compare(sc, b) {
  if (!sc || !b || b.n < 10) return { available: false, n: b?.n || 0 };
  const out = { available: true, n: b.n };
  for (const k of KEYS) {
    const avg = b.counts[k] ? Math.round(b.sums[k] / b.counts[k]) : null;
    out[k] = { average: avg, difference: avg !== null && sc[k]?.score !== null && sc[k]?.score !== undefined ? sc[k].score - avg : null };
  }
  return out;
}

/** Everything for the report: { paratexts, scores, comparison } (and the scores are added to the averages) */
async function referenceQuality(results, journals, indicators, { manuscriptCode = null, save = true } = {}) {
  const para = paratexts(results);
  const sc = scores(results, journals, indicators, para);
  const b = await baseline();
  const comparison = compare(sc, b);
  if (save && results.length >= 5) await record(sc, manuscriptCode).catch(() => {});
  return { paratexts: para, scores: sc, comparison };
}

module.exports = { referenceQuality, paratexts, scores, compare, spread, PARATEXT };
