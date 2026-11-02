// checks/plagiarism.js - similarity (originality) report of a manuscript, laid out like Turnitin's: one Similarity Index,
// broken down into Internet sources, Publications and Submitted works (earlier PJPS submissions), a numbered list of
// primary sources whose percentages add up to the index, and the manuscript text highlighted in each source's colour.
//
//   1. Filters as in Turnitin: the bibliography is excluded, quoted text is excluded, matches shorter than MIN_MATCH words
//      are excluded.
//   2. Source discovery, as Turnitin compares every sentence: the PJPS repository of published texts; the open-access
//      full texts of papers on the same subject; then every stretch of WINDOW words not matched yet is searched as an
//      exact phrase in Europe PMC (open-access full texts and all PubMed abstracts) and, for what it does not know, in
//      OpenAlex's index of publisher full texts (open and paywalled) and, with a SerpApi key, on the web.
//   No repository: the manuscript is never stored, and earlier unpublished PJPS submissions are not compared (Turnitin's
//   "no repository" setting), so a manuscript checked before publication never matches itself later.
//   3. Matching: the texts found are compared with the whole manuscript in overlapping K-word sequences (lower case,
//      punctuation and plural "s" ignored); runs separated by at most GAP different words are joined, so lightly
//      reworded sentences still count as one match.
//   4. Attribution: every matched word is credited to one source only, the source with the most matched text first
//      (Turnitin's "primary sources"), so the source percentages add up to the Similarity Index.
// Coverage: open-access literature, PubMed abstracts, publisher full texts indexed by OpenAlex (passage search only when
// paywalled) and the open web with a SerpApi key. Turnitin's own archive of student papers is not available.
const db = require('../db');
const { getJson, getText } = require('../http');
const { titleSimilarity, cleanDoi } = require('../text');
const cfg = require('../config');
const corpus = require('../corpus');
const WEB = require('../webSearch');

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const SAMPLES = 80;          // passages searched
const WEB_PHRASES = Math.max(0, parseInt(cfg.WEB_PHRASES || 60, 10) || 0); // passages no literature index has, searched on the web per report
const MAX_SOURCES = 25;      // sources found by several passages, read in full where open
const WINDOW = 8;            // words per searched passage (every stretch of the text not matched yet)
const OPENALEX_PHRASES = Math.max(0, parseInt(cfg.OPENALEX_PHRASES || 150, 10) || 0); // OpenAlex full-text searches per report ($0.001 each beyond the free allowance)
const K = 5;                 // words per compared sequence
const GAP = 2;               // different words allowed inside one match
const MIN_MATCH = 8;         // exclude matches shorter than this (words)
const MAX_TEXT = 120000;     // characters of the manuscript shown highlighted in the report

const STOP = new Set(('a an the and or of in on at to for from by with without as is are was were be been being this that these those it its their there '
  + 'which who whom whose than then into onto over under between among within during after before about above below also such may might can could '
  + 'should would will shall not no nor but if so very more most less least all any each both either neither other others some same than too '
  + 'we our us they them he she his her i you your one two three using used use based study studies present results result showed shown show').split(' '));
// wording every paper uses; sentences built from it say nothing about where a text came from
const BOILERPLATE = /\b(all authors|conflicts? of interest|informed consent|ethic(s|al) (committee|approval)|statistical(ly)? analys|mean ?± ?s\.?d|were purchased from|analytical grade|data are (expressed|presented)|this work was supported|corresponding author|the authors (declare|thank|acknowledge)|creative commons|copyright)\b/i;

const norm = w => {
  const x = String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return x.length > 4 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x;
};

/** The manuscript as words with character offsets; the bibliography is cut off and quoted words are marked */
function prepare(body) {
  let text = String(body || '');
  const bib = text.search(/\n\s*(references|bibliography|literature cited|works cited)\s*:?\s*\n/i);
  const bibliographyExcluded = bib > text.length * 0.3;
  if (bibliographyExcluded) text = text.slice(0, bib);
  // quotations of five words or more ("…", “…”) are excluded from matching, as Turnitin's "exclude quotes"
  const quoted = [];
  for (const m of text.matchAll(/[“"]([^“”"\n]{20,1500})[”"]/g)) if (m[1].trim().split(/\s+/).length >= 5) quoted.push([m.index, m.index + m[0].length]);
  const words = [];
  for (const m of text.matchAll(/\S+/g)) {
    const n = norm(m[0]);
    if (!n) continue;
    words.push({ raw: m[0], n, start: m.index, end: m.index + m[0].length, quoted: quoted.some(([a, b]) => m.index >= a && m.index < b) });
  }
  return { text, words, bibliographyExcluded, quotedWords: words.filter(w => w.quoted).length };
}

const wordsOf = text => [...String(text || '').matchAll(/\S+/g)].map(m => ({ raw: m[0], n: norm(m[0]) })).filter(w => w.n);

/** Sentences worth searching: 12-60 words, mostly prose, not boilerplate or quoted, ranked by how many specific words they carry */
function candidateSentences(text) {
  const sents = String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z(])/).map(s => s.trim());
  const out = [];
  sents.forEach((s, i) => {
    const w = wordsOf(s);
    if (w.length < 12 || w.length > 60 || /^[“"]/.test(s)) return;
    const digits = w.filter(x => /\d/.test(x.n)).length;
    if (digits / w.length > 0.2 || BOILERPLATE.test(s) || (/\[\d+|\(\w+ et al\.?,? \d{4}/.test(s) && w.length < 18)) return;
    const content = w.filter(x => !STOP.has(x.n) && x.n.length >= 5).length;
    out.push({ i, s, score: content / Math.sqrt(w.length) });
  });
  return out;
}

/** The 10-word stretch of a sentence with the most specific words (searched as an exact phrase) */
function phraseOf(sentence) {
  const w = String(sentence).split(/\s+/).map(x => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  let best = -1, at = 0;
  for (let k = 0; k + 10 <= w.length; k++) {
    const sc = w.slice(k, k + 10).filter(x => !STOP.has(norm(x)) && norm(x).length >= 5).length;
    if (sc > best) { best = sc; at = k; }
  }
  return w.slice(at, at + 10).join(' ').replace(/"/g, '');
}

/** Spread the samples over the whole text: the best sentence of each of SAMPLES equal parts */
function pickSamples(text, n = SAMPLES) {
  const c = candidateSentences(text);
  if (!c.length) return [];
  const parts = Math.min(n, c.length);
  const out = [];
  for (let p = 0; p < parts; p++) {
    const part = c.slice(Math.floor(p * c.length / parts), Math.floor((p + 1) * c.length / parts));
    const best = part.sort((a, b) => b.score - a.score)[0];
    if (best) out.push(best.s);
  }
  return out;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

const stripXml = x => String(x || '').replace(/<ref-list[\s\S]*?<\/ref-list>/g, ' ').replace(/<(table-wrap|fig)\b[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');
const stripHtml = x => String(x || '').replace(/<(script|style|noscript|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');

/** Text of a literature source: Europe PMC full text (open access) or the abstract */
async function sourceText(c) {
  if (c.fullText && c.fullText.length > 2000) return { text: c.fullText, scope: 'full text' };
  if (c.webUrl) {
    const r = await getText(c.webUrl, { ttl: 7 * 86400, timeout: 20000, retries: 0 });
    const html = r.ok && /html|text\/plain/i.test(r.headers?.['content-type'] || 'text/html') ? String(r.text || '') : '';
    const t = stripHtml(html);
    return { text: t.length > 300 ? t : '', scope: 'web page' };
  }
  if (c.pmcid) {
    const r = await getText(`${EPMC}/${c.pmcid}/fullTextXML`, { ttl: 30 * 86400, timeout: 30000, retries: 1 });
    const t = r.ok ? stripXml(String(r.text || '')) : '';
    if (t.length > 2000) return { text: t, scope: 'full text' };
  }
  if (c.oaPdf && /^https?:/.test(c.oaPdf)) {
    const pdf = await require('../http').getBuffer(c.oaPdf, { timeout: 30000 }).catch(() => null);
    if (pdf?.ok && pdf.buffer.slice(0, 5).toString() === '%PDF-' && pdf.buffer.length < 30 * 1024 * 1024) {
      const pages = await require('../tools/fulltext').filePages(pdf.buffer, 'source.pdf').catch(() => null);
      const t = (pages || []).map(p => p.text).join(' ').replace(/\s+/g, ' ');
      if (t.length > 2000) return { text: t, scope: 'full text (open-access PDF)' };
    }
  }
  if (c.abstract) return { text: c.abstract, scope: 'abstract' };
  const q = c.pmid ? `EXT_ID:${c.pmid} AND SRC:MED` : c.doi ? `DOI:"${c.doi}"` : null;
  if (!q) return { text: '', scope: null };
  const r = await getJson(`${EPMC}/search?format=json&resultType=core&pageSize=1&query=${encodeURIComponent(q)}`, { ttl: 30 * 86400, timeout: 20000, retries: 1 });
  const x = r.ok ? r.data?.resultList?.result?.[0] : null;
  return { text: stripXml(x?.abstractText || ''), scope: 'abstract' };
}

/** Join matched runs separated by at most GAP words, then drop runs shorter than MIN_MATCH (Turnitin's small-match filter) */
function finishRuns(hit, words) {
  for (let k = 0; k < hit.length;) {
    if (!hit[k]) { k++; continue; }
    let e = k;
    while (e < hit.length && hit[e]) e++;
    let g = e;
    while (g < hit.length && !hit[g] && g - e < GAP + 1) g++;
    if (g < hit.length && hit[g] && g - e <= GAP) for (let j = e; j < g; j++) hit[j] = 1;
    else k = e;
  }
  const passages = [];
  for (let k = 0; k < hit.length;) {
    if (!hit[k]) { k++; continue; }
    let e = k;
    while (e < hit.length && hit[e]) e++;
    if (e - k < MIN_MATCH) for (let j = k; j < e; j++) hit[j] = 0;
    else passages.push({ from: k, to: e, words: e - k, text: words.slice(k, e).map(x => x.raw).join(' ') });
    k = e;
  }
  return passages;
}

/** Words of the manuscript inside K-word sequences that also occur in the source (quoted words never match) */
function overlap(mine, theirs) {
  const set = new Set();
  const tw = wordsOf(theirs).map(x => x.n);
  for (let k = 0; k + K <= tw.length; k++) set.add(tw.slice(k, k + K).join(' '));
  const hit = new Uint8Array(mine.length);
  for (let k = 0; k + K <= mine.length; k++) {
    if (mine[k + K - 1].quoted || mine[k].quoted) continue;
    if (set.has(mine.slice(k, k + K).map(x => x.n).join(' '))) for (let j = k; j < k + K; j++) hit[j] = 1;
  }
  const passages = finishRuns(hit, mine);
  return { hit, passages: passages.sort((a, b) => b.words - a.words) };
}

/** Stable repository key of a source found by the search */
const sourceKeyOf = c => (c.pmcid ? `pmc:${c.pmcid}` : c.pmid ? `pmid:${c.pmid}` : c.doi ? `doi:${String(c.doi).toLowerCase()}` : c.url ? `url:${c.url}` : `title:${String(c.title || '').toLowerCase().slice(0, 200)}`);

// ------------------------------------------------------------------ earlier PJPS submissions (Module 4 fingerprints)

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * Earlier submissions keep only sampled hashes of 6-word sequences (papermill/index.js shingles(): about 1 in 8). A copied
 * passage hits several sampled sequences; the words between hits close together are filled in, so the matched area is a
 * close estimate rather than an exact word-by-word match.
 */
async function submissionMatches(mine, excludeCode) {
  const rows = await db.all("SELECT check_id, manuscript_code, title, data, created_at FROM fingerprints WHERE kind = 'text' ORDER BY created_at DESC LIMIT 3000").catch(() => []);
  if (!rows.length) return { compared: 0, sources: [] };
  // the manuscript's words split as the fingerprints were made (letters and digits, words longer than one character)
  const sub = [];
  mine.forEach((w, i) => { for (const part of w.raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) if (part.length > 1) sub.push({ t: part, i }); });
  const windows = [];
  for (let k = 0; k + 6 <= sub.length; k++) {
    const h = fnv(sub.slice(k, k + 6).map(x => x.t).join(' '));
    if (h % 8 === 0) windows.push({ h, from: sub[k].i, to: sub[k + 5].i });
  }
  const out = [];
  for (const r of rows) {
    if (excludeCode && r.manuscript_code && r.manuscript_code === excludeCode) continue;
    const theirs = new Set(r.data?.shingles || []);
    if (!theirs.size) continue;
    const hit = new Uint8Array(mine.length);
    let hits = 0;
    for (const w of windows) if (theirs.has(w.h)) { hits++; for (let j = w.from; j <= w.to; j++) if (!mine[j].quoted) hit[j] = 1; }
    if (hits < 2) continue;
    // fill the stretches between sampled hits that lie close together: in copied text a sampled sequence falls on average
    // every 8 words, with gaps of up to about 24 (an exact 6-word hash match by chance is very rare)
    for (let k = 0, last = -1; k < hit.length; k++) {
      if (!hit[k]) continue;
      if (last >= 0 && k - last > 1 && k - last <= 24) for (let j = last + 1; j < k; j++) hit[j] = 1;
      last = k;
    }
    const passages = finishRuns(hit, mine);
    if (!passages.length) continue;
    out.push({ type: 'submission', via: 'PJPS submissions', title: `${r.manuscript_code || 'Earlier PJPS submission'}${r.title ? `: ${r.title}` : ''}`, checkId: r.check_id, year: r.created_at ? new Date(r.created_at).getFullYear() : null,
      compared: 'text fingerprints', hit, passages });
  }
  return { compared: rows.length, sources: out };
}

// ------------------------------------------------------------------ passages searched and papers on the same subject

/**
 * Every stretch of WINDOW words of the manuscript, back to back, except quoted text, stretches already matched by a
 * compared full text, and stretches without content (function words or figures only)
 */
function searchWindows(mine, covered) {
  const out = [];
  for (let k = 0; k + WINDOW <= mine.length; k += WINDOW) {
    let c = 0; for (let j = k; j < k + WINDOW; j++) c += covered[j];
    if (c >= WINDOW / 2) continue;
    const w = windowAt(mine, k);
    if (w) out.push(w);
  }
  return out;
}

/** The stretch of WINDOW words starting at word k, as a search phrase, or null when it is quoted or has no content */
function windowAt(mine, k) {
  const w = mine.slice(k, k + WINDOW);
  if (w.length < WINDOW || w.some(x => x.quoted)) return null;
  const content = w.filter(x => !STOP.has(x.n) && x.n.length >= 4 && !/^\d/.test(x.n)).length;
  if (content < 3 || w.filter(x => /\d/.test(x.n)).length > 3) return null;
  const phrase = w.map(x => x.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean).join(' ').replace(/"/g, '');
  return phrase.split(' ').length < WINDOW - 1 ? null : { from: k, to: k + WINDOW, phrase };
}

/** n items spread evenly over a list */
const spread = (list, n) => (list.length <= n ? list.slice() : Array.from({ length: n }, (_, i) => list[Math.floor(i * list.length / n)]));

/** Open-access papers on the manuscript's subject (Europe PMC, by the words of its title), compared in full */
async function topicNeighbours(text, meta = {}, n = 20) {
  const title = meta.title || String(text).split('\n').find(l => l.trim().split(/\s+/).length >= 6) || '';
  const words = [...new Set(wordsOf(title).map(x => x.raw.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '')).filter(w => w.length >= 5 && !STOP.has(norm(w))))];
  for (const k of [6, 4, 3]) {
    if (words.length < 2) break;
    const q = `(${words.slice(0, k).map(w => `"${w}"`).join(' AND ')}) AND OPEN_ACCESS:y AND HAS_FT:y`;
    const r = await getJson(`${EPMC}/search?format=json&resultType=lite&pageSize=${n}&query=${encodeURIComponent(q)}`, { ttl: 7 * 86400, timeout: 25000, retries: 1 });
    const res = (r.ok && r.data?.resultList?.result) || [];
    if (res.length >= 5 || k === 3) return res.filter(x => x.pmcid).map(x => ({ type: 'publication', title: x.title, journal: x.journalTitle || null, year: x.pubYear || null, doi: x.doi || null, pmcid: x.pmcid, pmid: x.pmid || null, via: 'Europe PMC (same subject)', url: `https://europepmc.org/article/PMC/${x.pmcid}` }));
  }
  return [];
}

// ------------------------------------------------------------------ main

/**
 * input: { body, meta }  ->  { kind: 'plagiarism', summary: { similarity, internet, publications, submissions, ... },
 *   sources: [{ no, type, percent, ... }], document: [{ t, s }], filters, selfMatches, checked, method }
 */
async function checkPlagiarism({ body, meta = {} }, update = () => {}) {
  const prep = prepare(body);
  const mine = prep.words;
  if (mine.length < 200) return { kind: 'plagiarism', error: 'The manuscript text is too short or not available for a similarity check.' };
  // the manuscript's own published version or preprint is not plagiarism (title or DOI of the manuscript)
  const selfMatches = [];
  const isSelf = c => {
    const self = (meta.title && c.title && titleSimilarity(meta.title, c.title) >= 0.9) || (meta.doi && c.doi && String(meta.doi).toLowerCase() === String(c.doi).toLowerCase());
    if (self && !selfMatches.some(s => s.title === c.title)) selfMatches.push({ title: c.title, journal: c.journal || null, year: c.year || null, doi: c.doi || null, url: c.url || null });
    return self;
  };
  const covered = new Uint8Array(mine.length); // words already matched by a compared full text: not searched again
  const markCovered = hit => hit.forEach((h, k) => { if (h) covered[k] = 1; });
  const stats = { queries: 0, searchErrors: 0, webSearches: 0, openalexSearches: 0, windows: 0, windowsFound: 0, neighbours: 0 };

  // 1. the PJPS text repository: published papers and web pages kept by earlier checks (never unpublished submissions)
  update('Comparing with the PJPS text repository');
  const repo = (await corpus.candidates(prep.text, { excludeCode: meta.manuscriptCode || null }).catch(() => [])).filter(d => d.kind !== 'submission' && !isSelf({ title: d.title, doi: d.meta?.doi }));
  const repoKeys = new Set(repo.map(d => d.sourceKey));
  const fromRepo = repo.map(d => {
    const o = overlap(mine, d.text);
    if (!o.passages.length) return null;
    const m = d.meta || {};
    markCovered(o.hit);
    return { key: d.sourceKey, type: d.kind, title: d.title, journal: m.journal || null, year: m.year || null, doi: m.doi || null, url: m.url || null,
      via: `${m.via || 'Repository'} (PJPS repository)`, compared: `${m.scope || 'text'} (PJPS repository)`, hit: o.hit, passages: o.passages };
  }).filter(Boolean);

  // 2. papers on the same subject: their open-access full texts compared with the whole manuscript
  update('Finding papers on the same subject');
  const neighbours = await topicNeighbours(prep.text, meta).catch(() => []);
  const compared = [];
  const compare = async c => {
    const key = sourceKeyOf(c);
    if (repoKeys.has(key) || compared.some(x => x.key === key) || isSelf(c)) return null;
    const t = await sourceText(c);
    if (!t.text) return null;
    // every published source text read is kept in the repository, so later checks compare with it directly
    await corpus.addDoc({ kind: c.type, sourceKey: key, title: c.title, meta: { journal: c.journal, year: c.year, doi: c.doi, url: c.url, via: c.via, scope: t.scope }, text: t.text }).catch(() => null);
    const o = overlap(mine, t.text);
    if (!o.passages.length) return null;
    markCovered(o.hit);
    const out = { key, type: c.type, title: c.title, journal: c.journal, year: c.year, doi: c.doi, url: c.url, via: c.via, compared: t.scope, hit: o.hit, passages: o.passages };
    compared.push(out);
    return out;
  };
  update(`Comparing with ${neighbours.length} paper(s) on the same subject`);
  await pool(neighbours, 4, async c => { stats.neighbours++; await compare(c); });

  // 3. every stretch of WINDOW words not matched yet is searched as an exact phrase - as Turnitin compares every
  // sentence. Europe PMC (open-access full texts and all PubMed abstracts) first; what it does not know goes to
  // OpenAlex's full-text index (publisher full texts, open and paywalled, up to OPENALEX_PHRASES searches) and,
  // with a SerpApi key, to the web
  const windows = searchWindows(mine, covered);
  stats.windows = windows.length;
  const found = new Map(); // source key -> { rec, windows: Set }
  const hitWindow = (w, rec) => {
    if (isSelf(rec)) return;
    const key = sourceKeyOf(rec);
    const c = found.get(key) || { rec, windows: new Set() };
    c.windows.add(w.from);
    found.set(key, c);
  };
  update(`Searching ${windows.length} passages of the manuscript in Europe PMC`);
  const unknown = [];
  let done = 0;
  await pool(windows, 6, async w => {
    stats.queries++;
    const r = await getJson(`${EPMC}/search?format=json&resultType=lite&pageSize=5&query=${encodeURIComponent(`"${w.phrase}"`)}`, { ttl: 30 * 86400, timeout: 25000, retries: 2 });
    if (++done % 50 === 0) update(`Searching passages in Europe PMC (${done}/${windows.length})`);
    if (!r.ok) { stats.searchErrors++; unknown.push(w); return; }
    const res = (r.data?.resultList?.result || []).filter(x => !isSelf({ title: x.title, doi: x.doi }));
    if (!res.length) { unknown.push(w); return; }
    w.found = true;
    for (const x of res) hitWindow(w, { type: 'publication', title: x.title, journal: x.journalTitle || null, year: x.pubYear || null, doi: x.doi || null, pmcid: x.pmcid || null, pmid: x.pmid || null, via: 'Europe PMC',
      url: x.pmcid ? `https://europepmc.org/article/PMC/${x.pmcid}` : x.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/` : x.doi ? `https://doi.org/${x.doi}` : null });
  });
  // a match seldom stops at the edge of a searched stretch: the stretches straddling each edge of a found one are searched
  // too, so a copied sentence is credited in full, not only the words that fell inside one window
  const edges = [];
  const seen = new Set(windows.map(w => w.from));
  for (const w of windows.filter(x => x.found)) {
    for (const from of [w.from - WINDOW / 2, w.to - WINDOW / 2]) {
      if (from < 0 || from + WINDOW > mine.length || seen.has(from)) continue;
      seen.add(from);
      const x = windowAt(mine, from);
      if (x) edges.push(x);
    }
  }
  if (edges.length) update(`Following ${edges.length} matches to their full length`);
  await pool(edges, 6, async w => {
    stats.queries++;
    const r = await getJson(`${EPMC}/search?format=json&resultType=lite&pageSize=5&query=${encodeURIComponent(`"${w.phrase}"`)}`, { ttl: 30 * 86400, timeout: 25000, retries: 2 });
    if (!r.ok) { stats.searchErrors++; return; }
    const res = (r.data?.resultList?.result || []).filter(x => !isSelf({ title: x.title, doi: x.doi }));
    if (!res.length) return;
    w.found = true;
    for (const x of res) hitWindow(w, { type: 'publication', title: x.title, journal: x.journalTitle || null, year: x.pubYear || null, doi: x.doi || null, pmcid: x.pmcid || null, pmid: x.pmid || null, via: 'Europe PMC',
      url: x.pmcid ? `https://europepmc.org/article/PMC/${x.pmcid}` : x.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/` : x.doi ? `https://doi.org/${x.doi}` : null });
  });
  windows.push(...edges);

  // OpenAlex full text (paid per search beyond its free daily allowance): spread over the passages Europe PMC lacked
  const oaList = spread(unknown, OPENALEX_PHRASES);
  if (oaList.length) update(`Searching ${oaList.length} passages in OpenAlex full texts (publishers)`);
  await pool(oaList, 4, async w => {
    stats.openalexSearches++;
    const r = await getJson(`https://api.openalex.org/works?filter=fulltext.search:${encodeURIComponent(`"${w.phrase}"`)}&per-page=5&select=id,title,doi,publication_year,primary_location,open_access,ids${cfg.OPENALEX_API_KEY ? `&api_key=${cfg.OPENALEX_API_KEY}` : ''}`, { ttl: 30 * 86400, timeout: 25000, retries: 1 });
    if (!r.ok) { stats.searchErrors++; return; }
    const res = (r.data?.results || []).filter(x => !isSelf({ title: x.title, doi: cleanDoi(x.doi) }));
    if (!res.length) return;
    w.found = true;
    for (const x of res) hitWindow(w, { type: 'publication', title: x.title, journal: x.primary_location?.source?.display_name || null, year: x.publication_year || null, doi: cleanDoi(x.doi) || null,
      pmcid: x.ids?.pmcid ? String(x.ids.pmcid).replace(/^.*\//, '') : null, oaPdf: x.open_access?.oa_url || null, via: 'OpenAlex (publisher full texts)', url: x.doi || x.id });
  });
  // the open web (SerpApi, Brave Search or Google Programmable Search) for passages no literature index has
  if (WEB.enabled()) {
    const web = spread(unknown.filter(w => !w.found), WEB_PHRASES);
    if (web.length) update(`Searching ${web.length} passages on the web (${WEB.provider()})`);
    await pool(web, 2, async w => {
      stats.webSearches++;
      const r = await WEB.phraseSearch(w.phrase, 5);
      if (!r.ok) { if (r.error !== 'skipped') stats.searchErrors++; return; }
      for (const o of r.results.slice(0, 3)) {
        if (!o.url) continue;
        let host = '';
        try { host = new URL(o.url).hostname.replace(/^www\./, ''); } catch (e) { continue; }
        if (isSelf({ title: o.title })) continue;
        w.found = true;
        hitWindow(w, { type: 'internet', title: o.title || host, journal: host, year: null, doi: null, webUrl: /\.pdf($|\?)/i.test(o.url) ? null : o.url, via: `Web (${WEB.provider()})`, url: o.url });
      }
    });
  }
  stats.windowsFound = windows.filter(w => w.found).length;

  // 4. the sources behind several passages are read in full where they are open (exact extent of the match); for the
  // others - paywalled papers, or one passage only - the passages found in them are the match
  const bySize = [...found.values()].sort((a, b) => b.windows.size - a.windows.size);
  update(`Comparing the manuscript with ${Math.min(bySize.length, MAX_SOURCES)} source(s) found`);
  const fullTried = new Set();
  await pool(bySize.filter(c => c.windows.size >= 2).slice(0, MAX_SOURCES), 3, async c => {
    const got = await compare({ ...c.rec, webUrl: c.rec.webUrl || null });
    if (got) fullTried.add(sourceKeyOf(c.rec));
  });
  const windowByFrom = new Map(windows.map(w => [w.from, w]));
  const phraseSources = [];
  for (const c of bySize) {
    const key = sourceKeyOf(c.rec);
    if (fullTried.has(key) || repoKeys.has(key) || compared.some(x => x.key === key)) continue;
    const hit = new Uint8Array(mine.length);
    for (const from of c.windows) { const w = windowByFrom.get(from); for (let j = w.from; j < w.to; j++) hit[j] = 1; }
    const passages = finishRuns(hit, mine);
    if (!passages.length) continue;
    phraseSources.push({ key, type: c.rec.type, title: c.rec.title, journal: c.rec.journal, year: c.rec.year, doi: c.rec.doi, url: c.rec.url, via: c.rec.via, compared: 'matching passages (full text not open)', hit, passages: passages.sort((a, b) => b.words - a.words) });
  }
  const all = [...fromRepo, ...compared, ...phraseSources];


  // primary sources: each matched word is credited to one source, the one with the most matched text first
  const owner = new Int16Array(mine.length).fill(-1);
  all.sort((a, b) => b.passages.reduce((x, p) => x + p.words, 0) - a.passages.reduce((x, p) => x + p.words, 0));
  all.forEach((src, si) => { src.hit.forEach((h, k) => { if (h && owner[k] < 0) owner[k] = si; }); });
  const count = () => all.map((_, si) => owner.reduce((a, o) => a + (o === si ? 1 : 0), 0));
  // a source left with only a few words of its own (the rest of its match credited to larger sources) hands them to a
  // larger source that also contains them; words no larger source has stay with it, so no matched text is lost
  let credited = count();
  owner.forEach((o, k) => {
    if (o < 0 || credited[o] >= MIN_MATCH) return;
    const better = all.findIndex((src, si) => si !== o && credited[si] >= MIN_MATCH && src.hit[k]);
    if (better >= 0) owner[k] = better;
  });
  credited = count();
  const total = mine.length;
  const pct = n => Math.round(n / total * 1000) / 10;
  const kept = all.map((src, si) => ({ src, si, words: credited[si] })).filter(x => x.words > 0);
  const number = new Map(kept.map((x, i) => [x.si, i + 1]));
  const sources = kept.map((x, i) => ({
    no: i + 1, type: x.src.type, percent: pct(x.words), words: x.words, matchedWords: x.src.passages.reduce((a, p) => a + p.words, 0),
    title: x.src.title, journal: x.src.journal || null, year: x.src.year || null, doi: x.src.doi || null, url: x.src.url || null, checkId: x.src.checkId || null, via: x.src.via, compared: x.src.compared,
    // backwards compatible fields used by older views
    similarity: pct(x.words),
    passages: x.src.passages.slice(0, 4).map(p => ({ words: p.words, text: p.text.slice(0, 600) }))
  }));

  // the manuscript text in runs of one source (or none), for the highlighted view
  const document = [];
  for (let k = 0; k < mine.length && mine[k].start < MAX_TEXT;) {
    const no = owner[k] >= 0 ? number.get(owner[k]) || 0 : 0;
    let e = k;
    while (e < mine.length && (owner[e] >= 0 ? number.get(owner[e]) || 0 : 0) === no) e++;
    const end = e < mine.length ? mine[e].start : prep.text.length;
    document.push({ t: prep.text.slice(mine[k].start, Math.min(end, MAX_TEXT)), s: no });
    k = e;
  }
  if (mine[0]?.start > 0) document.unshift({ t: prep.text.slice(0, mine[0].start), s: 0 });

  const byType = type => pct(sources.filter(x => x.type === type).reduce((a, x) => a + x.words, 0));
  const creditedWords = sources.reduce((a, x) => a + x.words, 0);
  const similarity = pct(creditedWords);
  const largest = sources.reduce((m, x) => Math.max(m, x.percent), 0);
  const level = similarity >= 25 || largest >= 15 ? 'bad' : similarity >= 10 || largest >= 5 ? 'warn' : 'ok';

  const databases = ['PJPS text repository (published papers and web pages kept by earlier checks)', 'Europe PMC (open-access full texts and all PubMed abstracts)', 'Open-access full texts of papers on the same subject',
    ...(stats.openalexSearches ? [`OpenAlex index of publisher full texts (${stats.openalexSearches} passage searches)`] : []), ...(WEB.enabled() ? [`The web (${WEB.provider()}, ${stats.webSearches} passage searches)`] : ['The web: not searched (no web search key: SerpApi, Brave Search or Google Programmable Search)'])];
  return {
    kind: 'plagiarism',
    version: 2,
    summary: { similarity, internet: byType('internet'), publications: byType('publication'), submissions: 0, largestSource: largest, sources: sources.length, level, words: total },
    repository: 'not stored: this manuscript was not added to any repository, and earlier unpublished PJPS submissions were not compared (no-repository setting, as in Turnitin)',
    sources,
    document,
    filters: { bibliography: prep.bibliographyExcluded ? 'excluded' : 'not found in the text (body only was compared)', quotes: `excluded (${prep.quotedWords} quoted words)`, smallMatches: `excluded (fewer than ${MIN_MATCH} words)` },
    selfMatches,
    checked: { passages: stats.windows, passagesFound: stats.windowsFound, queries: stats.queries, openalexSearches: stats.openalexSearches, webSearches: stats.webSearches, neighbours: stats.neighbours, candidates: found.size, sourcesCompared: compared.length, repositoryMatches: fromRepo.length, repository: await corpus.stats().catch(() => ({})), submissionsCompared: 0, searchErrors: stats.searchErrors, databases },
    coverage: `Open-access literature and all PubMed abstracts (Europe PMC), publisher full texts indexed by OpenAlex (${OPENALEX_PHRASES} passage searches at most per report), ${WEB.enabled() ? `the open web (${WEB.provider()})` : 'not the open web (add a web search key: SerpApi, Brave Search or Google Programmable Search)'}. Turnitin's own archive of student papers and earlier unpublished PJPS submissions are not compared.`,
    method: `Like Turnitin's similarity report: the whole manuscript was compared with the open full texts of papers on the same subject, then every remaining ${WINDOW}-word stretch (${stats.windows} passages) was searched as an exact phrase; open sources were compared with the whole text in ${K}-word sequences (case, punctuation and plural forms ignored; up to ${GAP} different words inside one match), paywalled ones by the passages found in them. The bibliography and quotations are excluded, and so are matches shorter than ${MIN_MATCH} words. Every matched word is credited to one primary source, so the source percentages add up to the Similarity Index.`
  };
}

module.exports = { checkPlagiarism, pickSamples, phraseOf, overlap, prepare, finishRuns, submissionMatches };
