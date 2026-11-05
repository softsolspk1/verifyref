// checks/plagiarism.js - similarity (originality) report of a manuscript, laid out like Turnitin's: one Similarity Index,
// broken down into Internet sources and Publications, a numbered list of primary sources whose percentages add up to the
// index, and the manuscript text highlighted in each source's colour, every match shown next to the source's own wording.
//
//   1. Filters as in Turnitin's defaults: the bibliography and quotations are compared and no small match is excluded
//      (matches of FLOOR words or more are kept); the editor excludes the bibliography, quotes, small matches (by word
//      count) and small sources (by word count or percentage). Replaced and hidden characters are read through and
//      flagged. In-text citation markers ([12], (Smith et al., 2020)) are ignored on both sides, so a copied
//      sentence whose citation was changed or removed is still one match.
//   2. Source discovery, as Turnitin compares every sentence: the PJPS repository of published texts; the open-access
//      full texts of papers on the same subject; then every stretch of WINDOW words not matched yet - aligned on the
//      sentences, so a copied sentence always fills a searched stretch - is searched as an exact phrase in Europe PMC
//      (open-access full texts and all PubMed abstracts) and, for what it does not know, in OpenAlex's index of
//      publisher full texts (open and paywalled) and, with a web search key, on the web.
//   3. Matching: the texts found are compared with the whole manuscript in overlapping K-word sequences (Unicode
//      normalised, lower case, punctuation and plural "s" ignored); runs separated by at most GAP different words are
//      joined, so lightly reworded sentences still count as one match. Sentences reworded further (other word order and
//      endings, synonyms, paraphrasing tools) are matched sentence by sentence: the same rare words, or the same meaning by
//      sentence embeddings on this server (rewordedSentences); such matches are marked "paraphrased".
//   4. Attribution (public/js/shared/similarity.js, shared with the report view): every matched word is credited to one
//      source only, the source with the most matched text first (Turnitin's "primary sources"), so the source
//      percentages add up to the Similarity Index. The view can exclude sources and raise the minimum match length.
// Privacy - no repository: the manuscript is never stored or indexed. Earlier unpublished PJPS submissions are compared
// only when the editor turns it on for this report ("Submitted works", opt-in): their text is read from the confidential
// report of their own Full Screening, picked by the sampled hashes Module 4 keeps of every screened manuscript. Only 8-word passages are sent to the search services, and their
// answers are cached under a hash of the query with the public records found, never the passage itself (http.js).
// Coverage: open-access literature, PubMed abstracts, publisher full texts indexed by OpenAlex (passage search only when
// paywalled) and the open web with a search key. Turnitin's own archive of student papers is not available.
const path = require('path');
const { pathToFileURL } = require('url');
const { getJson, getText } = require('../http');
const { titleSimilarity, cleanDoi } = require('../text');
const cfg = require('../config');
const corpus = require('../corpus');
const WEB = require('../webSearch');
const EXT = require('../externalSimilarity');

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const WEB_PHRASES = Math.max(0, parseInt(cfg.WEB_PHRASES || 60, 10) || 0); // passages no literature index has, searched on the web per report
const MAX_SOURCES = 25;      // sources found by several passages, read in full where open
const WINDOW = 8;            // words per searched passage
const OPENALEX_PHRASES = Math.max(0, parseInt(cfg.OPENALEX_PHRASES || 150, 10) || 0); // OpenAlex full-text searches per report ($0.001 each beyond the free allowance)
const K = 5;                 // words per compared sequence
const GAP = 2;               // different words allowed inside one match
const COMMON = 25;           // a passage found in more papers than this is stock wording: credited to the first paper only
const MAX_TEXT = 200000;     // characters of the manuscript shown highlighted in the report
const MAX_PASSAGES = 12;     // matches kept per source with the source's own wording

let SIM = null; // public/js/shared/similarity.js (ES module, loaded once)
const shared = async () => SIM || (SIM = await import(pathToFileURL(path.join(__dirname, '../../public/js/shared/similarity.js')).href));
const MIN_MATCH = 8;         // = SIM.MIN_MATCH: the shortest match of reports before version 5
const FLOOR = K;             // = SIM.FLOOR: the shortest match kept; the editor's small-match filter raises it (Turnitin: off by default)

const STOP = new Set(('a an the and or of in on at to for from by with without as is are was were be been being this that these those it its their there '
  + 'which who whom whose than then into onto over under between among within during after before about above below also such may might can could '
  + 'should would will shall not no nor but if so very more most less least all any each both either neither other others some same than too '
  + 'we our us they them he she his her i you your one two three using used use based study studies present results result showed shown show').split(' '));
// abbreviations that end in a full stop without ending the sentence
const ABBREV = /^(?:al|e\.g|i\.e|fig|figs|vs|approx|ca|no|nos|vol|eq|ref|refs|dr|prof|st|sp|spp|var|cf|resp|etc|viz|min|max|conc|temp|wt|vol)\.$/i;

/**
 * Character spans of in-text citation markers (shared/similarity.js, also used for the match groups): their words are not
 * compared, so a copied sentence with another citation still matches.
 */
const citeSpans = text => SIM.citeSpans(text);
const inSpans = (spans, at) => {
  let lo = 0, hi = spans.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (spans[mid][1] <= at) lo = mid + 1; else if (spans[mid][0] > at) hi = mid - 1; else return true; }
  return false;
};

/**
 * The manuscript as words with character offsets (shared tokenizer); the bibliography is cut off, quoted words and
 * citation markers are marked. seq: positions of the compared words (not citations); keys: their K-word sequences.
 */
function prepare(body, bibliography = '') {
  let text = String(body || '');
  // the reference list is compared too, as a section of its own ("References"), as Turnitin does; the editor's "exclude
  // bibliography" filter leaves that section out. A list still inside the text (under its heading) is that section.
  const bib = text.search(/\n\s*(?:\d{1,2}\.?\s*)?(references|bibliography|literature cited|works cited|reference list)\s*:?\s*\n/i);
  const list = String(bibliography || '').trim();
  if (!(bib > text.length * 0.3) && list) text = `${text.replace(/\s+$/, '')}\n\nReferences\n${list}\n`;
  const bibliographyFound = bib > text.length * 0.3 || !!list;
  // quotations of five words or more ("…", “…”) are excluded from matching, as Turnitin's "exclude quotes"
  const quoted = [];
  for (const m of text.matchAll(/[“"]([^“”"\n]{20,1500})[”"]/g)) if (m[1].trim().split(/\s+/).length >= 5) quoted.push([m.index, m.index + m[0].length]);
  const cites = citeSpans(text);
  const words = SIM.tokenize(text).map(w => ({ ...w, quoted: inSpans(quoted, w.start), cite: inSpans(cites, w.start) }));
  const seq = [];
  words.forEach((w, i) => { if (!w.cite) seq.push(i); });
  const keys = [];
  for (let j = 0; j + K <= seq.length; j++) keys.push(seq.slice(j, j + K).map(i => words[i].n).join(' '));
  return { text, words, seq, keys, bibliographyFound, quotedWords: words.filter(w => w.quoted).length, citeWords: words.filter(w => w.cite).length };
}

/** A source text as compared words (citation markers left out): [{ raw, n }] */
function comparable(text) {
  const t = String(text || '');
  const cites = citeSpans(t);
  return SIM.tokenize(t).filter(w => !inSpans(cites, w.start));
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

// the source's reference list, tables and figure captions are kept: Turnitin compares them too, and a manuscript's
// bibliography matches mostly the reference lists of papers that cite the same works
const stripXml = x => String(x || '').replace(/<xref\b[^>]*ref-type="bibr"[^>]*>[\s\S]*?<\/xref>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\[[\s,;–-]*\]/g, ' ').replace(/\s+/g, ' ');
const stripHtml = x => String(x || '').replace(/<(script|style|noscript|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');

// what is kept in the cache of a passage search (http.js "private"): the papers found, nothing of the query
const keepEpmc = d => ({ hitCount: d?.hitCount || 0, resultList: { result: (d?.resultList?.result || []).map(x => ({ title: x.title, journalTitle: x.journalTitle, pubYear: x.pubYear, doi: x.doi, pmcid: x.pmcid, pmid: x.pmid })) } });
const keepOpenAlex = d => ({ results: (d?.results || []).map(x => ({ id: x.id, title: x.title, doi: x.doi, publication_year: x.publication_year, primary_location: { source: { display_name: x.primary_location?.source?.display_name || null } }, open_access: { oa_url: x.open_access?.oa_url || null }, ids: { pmcid: x.ids?.pmcid || null } })) });

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
      // words broken at the end of a PDF line ("pharma- ceutical") are joined again
      const t = (pages || []).map(p => p.text).join(' ').replace(/(\p{Ll})-\s+(\p{Ll})/gu, '$1$2').replace(/\s+/g, ' ');
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

/** Join matched runs separated by at most GAP words, then drop runs shorter than FLOOR words */
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
    if (e - k < FLOOR) for (let j = k; j < e; j++) hit[j] = 0;
    else passages.push({ from: k, to: e, words: e - k, text: words.slice(k, e).map(x => x.raw).join(' ') });
    k = e;
  }
  return passages;
}

/** A citation marker between two matched words belongs to the match (it was not compared) */
function bridgeCites(hit, mine) {
  for (let k = 0; k < mine.length;) {
    if (!mine[k].cite) { k++; continue; }
    let e = k;
    while (e < mine.length && mine[e].cite) e++;
    if (k > 0 && hit[k - 1] && e < mine.length && hit[e]) for (let j = k; j < e; j++) hit[j] = 1;
    k = e;
  }
}

/**
 * Words of the manuscript inside K-word sequences that also occur in the source (quoted words too: the report leaves them
 * out unless the editor includes quotations), and for every match the source's own wording (Turnitin's side-by-side view)
 */
function overlap(prep, theirs) {
  const mine = prep.words, seq = prep.seq;
  const tw = comparable(theirs);
  const pos = new Map();
  for (let k = 0; k + K <= tw.length; k++) { const key = tw.slice(k, k + K).map(x => x.n).join(' '); if (!pos.has(key)) pos.set(key, k); }
  const hit = new Uint8Array(mine.length);
  for (let j = 0; j < prep.keys.length; j++) if (pos.has(prep.keys[j])) for (let t = j; t < j + K; t++) hit[seq[t]] = 1;
  bridgeCites(hit, mine);
  const passages = finishRuns(hit, mine).sort((a, b) => b.words - a.words);
  // where each match sits in the source: its first matching sequence, and the source text of the same length from there
  const jOf = new Map(seq.map((i, j) => [i, j]));
  for (const p of passages.slice(0, MAX_PASSAGES)) {
    for (let i = p.from; i + K <= p.to; i++) {
      const j = jOf.get(i);
      if (j === undefined || j >= prep.keys.length) continue;
      const at = pos.get(prep.keys[j]);
      if (at === undefined) continue;
      const lead = seq.slice(jOf.get(p.from) ?? j, j).length; // compared words of the match before this sequence
      const from = Math.max(0, at - lead);
      p.source = tw.slice(from, Math.min(tw.length, from + p.words + 3)).map(x => x.raw).join(' ');
      break;
    }
  }
  return { hit, passages };
}

// ------------------------------------------------------------------ reworded sentences (Turnitin's "minor changes")

// word endings removed before sentences are compared, so "increased" / "increase" / "increasingly" agree
const SUFFIX = /(?:ational|izations?|isations?|ations?|ements?|ments?|ities|ity|ness|ingly|ings?|edly|ed|ly|ies|es|ive|ous|al|er)$/;
const stem = n => { if (n.length <= 4) return n; const s = n.replace(SUFFIX, ''); return s.length >= 3 ? s : n; };
const contentWord = n => n.length >= 3 && !STOP.has(n) && !/^\d+$/.test(n);
const PARA = { min: 6, shared: 4, length: 0.6, accept: 0.6, agree: 0.7, meaning: 0.3, cosine: 0.8 }; // see scripts/benchmark-similarity.js

/** Sentences of a word list, as [from, to) word positions; long ones are cut in pieces of about 40 words */
function sentencesOf(words) {
  const out = [];
  let a = 0;
  const close = b => { for (let n = Math.ceil((b - a) / 45), k = 0; k < n; k++) out.push([a + Math.floor(k * (b - a) / n), a + Math.floor((k + 1) * (b - a) / n)]); a = b; };
  for (let k = 0; k + 1 < words.length; k++) {
    const w = words[k].raw;
    if (/[.!?]["”’)\]]?$/.test(w) && !ABBREV.test(w) && /^[\p{Lu}\d(“"]/u.test(words[k + 1].raw)) close(k + 1);
  }
  if (a < words.length) close(words.length);
  return out.filter(([p, q]) => q > p);
}

/**
 * Sentences of the manuscript that a source states in other words - the same specific words in another order, other
 * endings, synonyms or a paraphrasing tool's substitutions (Turnitin highlights them as matches with minor changes).
 * A manuscript sentence is matched to the source sentence (or two adjacent ones: tools split and join sentences) whose
 * specific words it shares most, weighted by how rare each word is in the two texts. With sentence embeddings (tools/embed.js,
 * on this server) the pair must also mean the same: shared weight >= PARA.accept and cosine >= PARA.agree, or shared weight
 * >= PARA.meaning and cosine >= PARA.cosine; without them, shared weight >= PARA.accept. Thresholds fitted on SpinBot output
 * against papers on the same subject (scripts/benchmark-similarity.js).
 * Sentences already mostly matched word for word are skipped. -> [{ from, to, source }] in manuscript word positions
 */
async function rewordedSentences(prep, tw, hit, { meaning = true, trace = null } = {}) {
  const mine = prep.words;
  const unitsOf = (words, skipCite) => sentencesOf(words).map(([p, q]) => {
    const ws = words.slice(p, q).filter(w => !(skipCite && w.cite)).map(w => w.n).filter(contentWord).map(stem);
    return { p, q, set: new Set(ws) };
  });
  const M = unitsOf(mine, true).filter(u => u.set.size >= PARA.min && !mine.slice(u.p, u.q).some(w => w.quoted) && (() => { let h = 0; for (let k = u.p; k < u.q; k++) h += hit[k]; return h < (u.q - u.p) * 0.6; })());
  if (!M.length) return [];
  const S1 = unitsOf(tw, false).filter(u => u.set.size >= 3);
  // a source sentence, and each pair of adjacent ones
  const S = [...S1, ...S1.slice(1).map((u, i) => ({ p: S1[i].p, q: u.q, set: new Set([...S1[i].set, ...u.set]), pair: true }))];
  const df = new Map();
  for (const u of [...M, ...S1]) for (const t of u.set) df.set(t, (df.get(t) || 0) + 1);
  const n = M.length + S1.length;
  const idf = t => Math.log(1 + n / (df.get(t) || 1));
  const weight = set => { let s = 0; for (const t of set) s += idf(t); return s; };
  const inv = new Map();
  S.forEach((u, i) => { u.w = weight(u.set); for (const t of u.set) { if (!inv.has(t)) inv.set(t, []); inv.get(t).push(i); } });
  const cands = [];
  for (const u of M) {
    const wm = weight(u.set);
    const acc = new Map();
    for (const t of u.set) for (const i of inv.get(t) || []) { const a = acc.get(i) || { n: 0, w: 0 }; a.n++; a.w += idf(t); acc.set(i, a); }
    let best = null;
    for (const [i, a] of acc) {
      const s = S[i];
      // a restatement keeps about the length of its source: a short sentence is not matched into a long one, or back
      if (a.n < PARA.shared || Math.min(u.set.size, s.set.size) < Math.max(u.set.size, s.set.size) * PARA.length) continue;
      // weighted overlap on the smaller side, kept honest by the larger side (a pair of sentences must not absorb anything)
      const score = Math.min(a.w / Math.min(wm, s.w), 2 * a.w / (wm + s.w) + (s.pair ? 0 : 0.1));
      if (!best || score > best.score) best = { i, score };
    }
    if (best && best.score >= PARA.meaning) cands.push({ u, s: S[best.i], score: best.score });
  }
  let sure = cands.filter(c => c.score >= PARA.accept);
  if (meaning && cands.length) {
    const E = require('../tools/embed');
    const text = (words, p, q) => words.slice(p, q).map(w => w.raw).join(' ');
    const vecs = await E.embed(cands.flatMap(c => [text(mine, c.u.p, c.u.q), text(tw, c.s.p, c.s.q)])).catch(() => null);
    if (vecs) {
      cands.forEach((c, k) => { c.cosine = E.dot(vecs[2 * k], vecs[2 * k + 1]); });
      sure = cands.filter(c => (c.score >= PARA.accept && c.cosine >= PARA.agree) || c.cosine >= PARA.cosine);
    }
  }
  if (trace) for (const c of cands) trace.push({ from: c.u.p, to: c.u.q, score: c.score, cosine: c.cosine ?? null });
  return sure.map(c => ({ from: c.u.p, to: c.u.q, source: tw.slice(c.s.p, c.s.q).map(w => w.raw).join(' ') }));
}

/**
 * overlap() and the reworded sentences: the manuscript's words a source contains word for word or in other words.
 * Passages made mostly of reworded sentences are marked paraphrased, with the source's sentence as its wording.
 */
async function match(prep, theirs, opts = {}) {
  const o = overlap(prep, theirs);
  const tw = comparable(theirs);
  const rew = await rewordedSentences(prep, tw, o.hit, opts);
  if (!rew.length) return o;
  const hit = o.hit.slice();
  const para = new Uint8Array(hit.length);
  for (const r of rew) for (let k = r.from; k < r.to; k++) if (!prep.words[k].cite || (k > r.from && k < r.to - 1)) { if (!hit[k]) para[k] = 1; hit[k] = 1; }
  bridgeCites(hit, prep.words);
  const passages = finishRuns(hit, prep.words).sort((a, b) => b.words - a.words).map(p => {
    let pw = 0;
    for (let k = p.from; k < p.to; k++) pw += para[k];
    const exact = o.passages.find(q => q.from <= p.from && q.to >= p.to);
    if (pw * 2 < p.words) return exact ? { ...p, source: exact.source } : { ...p, source: o.passages.find(q => q.from >= p.from && q.to <= p.to)?.source };
    return { ...p, paraphrased: true, source: rew.filter(r => r.to > p.from && r.from < p.to).map(r => r.source).join(' … ').slice(0, 600) };
  });
  return { hit, passages };
}

/**
 * Earlier PJPS submissions sharing text with the manuscript (opt-in "Submitted works"): the screened manuscripts whose
 * sampled 6-word hashes (Module 4 fingerprints) share at least minShared with this one, most shared first, with their
 * text from the confidential similarity report of their Full Screening. Other versions of the same manuscript (same
 * manuscript ID) and the report being run again are left out.
 * -> [{ checkId, manuscriptCode, title, date, shared, text }]
 */
async function earlierSubmissions(body, { excludeCode = null, excludeCheckIds = [], limit = 10, minShared = 3 } = {}) {
  const db = require('../db');
  const store = require('../reportStore');
  const mine = new Set(require('../papermill').shingles(body));
  if (!mine.size) return [];
  const skip = new Set(excludeCheckIds.filter(Boolean).map(Number));
  const rows = await db.all("SELECT check_id, manuscript_code, title, data, created_at FROM fingerprints WHERE kind = 'text' AND check_id IS NOT NULL ORDER BY created_at DESC LIMIT 5000");
  const best = new Map();
  for (const r of rows) {
    if (skip.has(Number(r.check_id)) || (excludeCode && r.manuscript_code && r.manuscript_code === excludeCode)) continue;
    let n = 0;
    for (const h of r.data?.shingles || []) if (mine.has(h)) n++;
    if (n >= minShared && n > (best.get(r.check_id)?.shared || 0)) best.set(r.check_id, { checkId: r.check_id, manuscriptCode: r.manuscript_code || null, title: r.title || null, date: r.created_at, shared: n });
  }
  const out = [];
  for (const c of [...best.values()].sort((a, b) => b.shared - a.shared).slice(0, limit)) {
    const row = await db.one('SELECT result FROM checks WHERE id = $1', [c.checkId]).catch(() => null);
    const res = row ? await store.load(row.result) : null;
    const text = (res?.plagiarism?.document || []).map(d => d.t).join('');
    if (text.split(/\s+/).length >= 200) out.push({ ...c, text });
  }
  return out;
}

/**
 * The matches of the external full-text similarity service as report sources: its positions (characters of the text
 * submitted, which is prep.text) become word ranges of the report, so its sources are credited, highlighted and
 * filtered like the others. Which side of its comparison is the submitted text is checked on the identical matches
 * (the words must agree); when neither side fits, the identical matches are found again by their wording.
 * -> [{ key, type, title, url, via, compared, hit, passages }]
 */
function externalSources(ext, prep) {
  const words = prep.words, text = prep.text;
  const ends = words.map(w => w.end);
  const firstWordEndingAfter = c => { let lo = 0, hi = words.length; while (lo < hi) { const m = (lo + hi) >> 1; if (ends[m] <= c) lo = m + 1; else hi = m; } return lo; };
  const toWords = (s, len) => { const a = firstWordEndingAfter(s); let b = a; while (b < words.length && words[b].start < s + len) b++; return [a, b]; };
  const normWords = t => SIM.tokenize(t).map(x => x.n);
  const segs = (res, k, side) => { const c = res.comparison?.[k]?.[side]?.chars; return c ? c.starts.map((s, i) => [s, c.lengths[i] || 0]) : []; };
  // n-gram index of the manuscript for the fallback
  const KEY = 5, at = new Map();
  for (let i = 0; i + KEY <= words.length; i++) { const key = words.slice(i, i + KEY).map(w => w.n).join(' '); if (!at.has(key)) at.set(key, i); }
  const out = [];
  for (const item of ext.items || []) {
    const res = ext.results?.[item.id];
    if (!res) continue;
    // which side is the manuscript: the identical matches must read the same on both sides
    const agree = (mine, theirs) => {
      const pairs = segs(res, 'identical', mine).map((s, i) => [s, segs(res, 'identical', theirs)[i]]).filter(p => p[1]).slice(0, 12);
      if (!pairs.length) return 0;
      return pairs.filter(([[a, al], [b, bl]]) => { const x = normWords(text.slice(a, a + al)), y = normWords(String(res.value).slice(b, b + bl)); return x.length && x.join(' ') === y.join(' '); }).length / pairs.length;
    };
    const sides = [['source', 'suspected'], ['suspected', 'source']].map(([m, t]) => ({ m, t, score: agree(m, t) })).sort((a, b) => b.score - a.score);
    const hit = new Uint8Array(words.length);
    const passages = [];
    const addRange = (a, b, src, kind) => { if (b <= a) return; for (let k = a; k < b; k++) hit[k] = 1; passages.push({ from: a, to: b, words: b - a, text: words.slice(a, b).map(w => w.raw).join(' ').slice(0, 600), source: String(src || '').replace(/\s+/g, ' ').trim().slice(0, 600), ...(kind === 'relatedMeaning' ? { paraphrased: true } : {}) }); };
    if (sides[0].score >= 0.6) {
      const { m, t } = sides[0];
      for (const kind of ['identical', 'minorChanges', 'relatedMeaning']) {
        const mine = segs(res, kind, m), theirs = segs(res, kind, t);
        mine.forEach(([s, len], i) => { if (s + len > text.length + 5) return; const [a, b] = toWords(s, len); const th = theirs[i]; addRange(a, b, th ? String(res.value).slice(th[0], th[0] + th[1]) : '', kind); });
      }
    } else {
      // positions do not fit the text: find the identical passages by their wording
      for (const [s, len] of segs(res, 'identical', 'suspected').concat(segs(res, 'identical', 'source'))) {
        const w = normWords(String(res.value).slice(s, s + len));
        if (w.length < KEY) continue;
        const i = at.get(w.slice(0, KEY).join(' '));
        if (i === undefined) continue;
        let e = i;
        while (e < words.length && e - i < w.length && words[e].n === w[e - i]) e++;
        if (e - i >= KEY) addRange(i, e, String(res.value).slice(s, s + len), 'identical');
      }
    }
    if (!passages.length) continue;
    // neighbouring pieces of one match form one passage (as the in-house matching joins runs)
    passages.sort((a, b) => a.from - b.from);
    const joined = [];
    for (const p of passages) {
      const last = joined[joined.length - 1];
      if (last && p.from <= last.to + GAP) { last.to = Math.max(last.to, p.to); last.words = last.to - last.from; last.text = words.slice(last.from, last.to).map(w => w.raw).join(' ').slice(0, 600); last.source = `${last.source} … ${p.source}`.slice(0, 600); last.paraphrased = last.paraphrased || p.paraphrased; }
      else joined.push({ ...p });
    }
    const host = (() => { try { return item.url ? new URL(item.url).hostname.replace(/^www\./, '') : null; } catch (e) { return null; } })();
    const db = item.kind !== 'internet';
    out.push({ key: `ext:${item.url || item.id}`, type: db ? 'submission' : 'internet', title: item.title || host || (db ? 'Submitted document (external database)' : 'Web page'),
      journal: db ? 'External database of submitted documents' : host, year: item.metadata?.publishDate ? String(item.metadata.publishDate).slice(0, 4) : null, doi: null, url: item.url || null,
      via: db ? 'Full-text similarity service (database of submitted documents)' : 'Full-text similarity service (web and publications)', compared: 'full text, paraphrase included (external service)',
      hit, passages: joined.sort((a, b) => b.words - a.words) });
  }
  return out;
}

/** Stable repository key of a source found by the search */
const sourceKeyOf = c => (c.pmcid ? `pmc:${c.pmcid}` : c.pmid ? `pmid:${c.pmid}` : c.doi ? `doi:${String(c.doi).toLowerCase()}` : c.url ? `url:${c.url}` : `title:${String(c.title || '').toLowerCase().slice(0, 200)}`);

// ------------------------------------------------------------------ passages searched and papers on the same subject

/**
 * The stretches of WINDOW compared words searched as exact phrases, aligned on the sentences: one at the start of every
 * sentence, then every WINDOW words, and one ending with the sentence - so a copied sentence (or its longer part) always
 * fills a searched stretch. Quoted text, stretches already matched by a compared full text, and stretches without
 * content (function words or figures only) are left out.
 */
function searchWindows(prep, covered) {
  const { words: mine, seq } = prep;
  const starts = [0];
  for (let j = 0; j + 1 < seq.length; j++) {
    const w = mine[seq[j]].raw;
    if (/[.!?]["”’)\]]?$/.test(w) && !ABBREV.test(w) && /^[\p{Lu}\d(“"]/u.test(mine[seq[j + 1]].raw)) starts.push(j + 1);
  }
  starts.push(seq.length);
  const out = [];
  const seen = new Set();
  const add = j => {
    if (j < 0 || j + WINDOW > seq.length || seen.has(j)) return;
    seen.add(j);
    const w = windowAt(prep, j, covered);
    if (w) out.push(w);
  };
  for (let s = 0; s + 1 < starts.length; s++) {
    const a = starts[s], b = starts[s + 1];
    if (b - a < WINDOW) { add(a); continue; }
    for (let j = a; j + WINDOW <= b; j += WINDOW) add(j);
    if ((b - a) % WINDOW >= WINDOW / 2) add(b - WINDOW);
  }
  return { windows: out, seen };
}

/** The WINDOW compared words from seq position j, as a search phrase, or null when quoted, covered or without content */
function windowAt(prep, j, covered) {
  const idx = prep.seq.slice(j, j + WINDOW);
  if (idx.length < WINDOW) return null;
  const w = idx.map(i => prep.words[i]);
  if (w.some(x => x.quoted)) return null;
  if (covered && idx.filter(i => covered[i]).length >= WINDOW / 2) return null;
  const content = w.filter(x => !STOP.has(x.n) && x.n.length >= 4 && !/^\d/.test(x.n)).length;
  if (content < 3 || w.filter(x => /\d/.test(x.n)).length > 3) return null;
  const phrase = w.map(x => x.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean).join(' ').replace(/"/g, '');
  return phrase.split(' ').length < WINDOW - 1 ? null : { j, from: idx[0], to: idx[WINDOW - 1] + 1, phrase };
}

/** n items spread evenly over a list */
const spread = (list, n) => (list.length <= n ? list.slice() : Array.from({ length: n }, (_, i) => list[Math.floor(i * list.length / n)]));

/** Open-access papers on the manuscript's subject (Europe PMC, by the words of its title), compared in full */
async function topicNeighbours(text, meta = {}, n = 20) {
  const title = meta.title || String(text).split('\n').find(l => l.trim().split(/\s+/).length >= 6) || '';
  const words = [...new Set(SIM.tokenize(title).map(x => x.raw.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '')).filter(w => w.length >= 5 && !STOP.has(SIM.norm(w))))];
  for (const k of [6, 4, 3]) {
    if (words.length < 2) break;
    const q = `(${words.slice(0, k).map(w => `"${w}"`).join(' AND ')}) AND OPEN_ACCESS:y AND HAS_FT:y`;
    // the title of an unpublished manuscript: cached under a hash only
    const r = await getJson(`${EPMC}/search?format=json&resultType=lite&pageSize=${n}&query=${encodeURIComponent(q)}`, { ttl: 7 * 86400, timeout: 25000, retries: 1, private: keepEpmc });
    const res = (r.ok && r.data?.resultList?.result) || [];
    if (res.length >= 5 || k === 3) return res.filter(x => x.pmcid).map(x => ({ type: 'publication', title: x.title, journal: x.journalTitle || null, year: x.pubYear || null, doi: x.doi || null, pmcid: x.pmcid, pmid: x.pmid || null, via: 'Europe PMC (same subject)', url: `https://europepmc.org/article/PMC/${x.pmcid}` }));
  }
  return [];
}

const epmcRecord = x => ({ type: 'publication', title: x.title, journal: x.journalTitle || null, year: x.pubYear || null, doi: x.doi || null, pmcid: x.pmcid || null, pmid: x.pmid || null, via: 'Europe PMC',
  url: x.pmcid ? `https://europepmc.org/article/PMC/${x.pmcid}` : x.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/` : x.doi ? `https://doi.org/${x.doi}` : null });

// ------------------------------------------------------------------ main

/**
 * input: { body, meta }  ->  { kind: 'plagiarism', version: 4, summary: { similarity, internet, publications, ... },
 *   sources: [{ key, no, type, percent, ranges, passages: [{ from, to, words, text, source }], ... }], alsoMatched,
 *   document: [{ t, s }], settings: { excluded, minWords }, filters, selfMatches, checked, privacy, method }
 */
async function checkPlagiarism({ body, bibliography = '', meta = {}, submissions = null }, update = () => {}) {
  await shared();
  const prep = prepare(body, bibliography);
  const mine = prep.words;
  if (mine.length < 200) return { kind: 'plagiarism', error: 'The manuscript text is too short or not available for a similarity check.' };
  // the manuscript's own published version or preprint is not plagiarism (title or DOI of the manuscript)
  const selfMatches = [];
  const isSelf = c => {
    const self = (meta.title && c.title && titleSimilarity(meta.title, c.title) >= 0.9) || (meta.doi && c.doi && String(meta.doi).toLowerCase() === String(c.doi).toLowerCase());
    if (self && !selfMatches.some(s => s.title === c.title)) selfMatches.push({ title: c.title, journal: c.journal || null, year: c.year || null, doi: c.doi || null, url: c.url || null });
    return self;
  };
  // the external full-text comparison runs alongside the in-house search (it waits for the service's callbacks)
  const extRun = EXT.enabled() ? EXT.scanText(prep.text, { update }) : null;
  const covered = new Uint8Array(mine.length); // words already matched by a compared full text: not searched again
  const markCovered = hit => hit.forEach((h, k) => { if (h) covered[k] = 1; });
  const stats = { queries: 0, searchErrors: 0, webSearches: 0, openalexSearches: 0, windows: 0, windowsFound: 0, neighbours: 0, common: 0 };

  // 1. the PJPS text repository: published papers and web pages kept by earlier checks (never unpublished submissions)
  update('Comparing with the PJPS text repository');
  const repo = (await corpus.candidates(prep.text, { excludeCode: meta.manuscriptCode || null }).catch(() => [])).filter(d => d.kind !== 'submission' && !isSelf({ title: d.title, doi: d.meta?.doi }));
  const repoKeys = new Set(repo.map(d => d.sourceKey));
  const fromRepo = (await pool(repo, 2, async d => {
    // open-access full texts kept before reference lists were compared (no meta.withRefs) are read again with them
    if (/^pmc:/.test(d.sourceKey) && !d.meta?.withRefs) {
      const t = await sourceText({ pmcid: d.sourceKey.slice(4) }).catch(() => null);
      if (t?.text && t.scope === 'full text') {
        d.text = t.text;
        d.meta = { ...(d.meta || {}), withRefs: true };
        await corpus.addDoc({ kind: d.kind, sourceKey: d.sourceKey, title: d.title, meta: d.meta, text: t.text }).catch(() => null);
      }
    }
    const o = await match(prep, d.text);
    if (!o.passages.length) return null;
    const m = d.meta || {};
    markCovered(o.hit);
    return { key: d.sourceKey, type: d.kind, title: d.title, journal: m.journal || null, year: m.year || null, doi: m.doi || null, url: m.url || null,
      via: `${m.via || 'Repository'} (PJPS repository)`, compared: `${m.scope || 'text'} (PJPS repository)`, hit: o.hit, passages: o.passages };
  })).filter(Boolean);

  // 1b. earlier PJPS submissions, only when the editor turned it on (submissions = [] when on and none share text)
  const fromSubs = (await pool(submissions || [], 2, async d => {
    const o = await match(prep, d.text);
    if (!o.passages.length) return null;
    markCovered(o.hit);
    return { key: `check:${d.checkId}`, type: 'submission', title: `${d.manuscriptCode ? `${d.manuscriptCode} - ` : ''}${d.title || 'Earlier PJPS submission'}`, journal: 'Earlier PJPS submission',
      year: d.date ? new Date(d.date).getFullYear() : null, checkId: d.checkId, via: 'Earlier PJPS submissions (opt-in)', compared: 'full text (confidential PJPS report)', hit: o.hit, passages: o.passages };
  })).filter(Boolean);

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
    await corpus.addDoc({ kind: c.type, sourceKey: key, title: c.title, meta: { journal: c.journal, year: c.year, doi: c.doi, url: c.url, via: c.via, scope: t.scope, withRefs: true }, text: t.text }).catch(() => null);
    const o = await match(prep, t.text);
    if (!o.passages.length) return null;
    markCovered(o.hit);
    const out = { key, type: c.type, title: c.title, journal: c.journal, year: c.year, doi: c.doi, url: c.url, via: c.via, compared: t.scope, hit: o.hit, passages: o.passages };
    compared.push(out);
    return out;
  };
  update(`Comparing with ${neighbours.length} paper(s) on the same subject`);
  await pool(neighbours, 4, async c => { stats.neighbours++; await compare(c); });

  // 3. every stretch not matched yet is searched as an exact phrase - as Turnitin compares every sentence. Europe PMC
  // (open-access full texts and all PubMed abstracts) first; what it does not know goes to OpenAlex's full-text index
  // (publisher full texts, open and paywalled, up to OPENALEX_PHRASES searches) and, with a search key, to the web
  const { windows, seen } = searchWindows(prep, covered);
  stats.windows = windows.length;
  const found = new Map(); // source key -> { rec, windows: Set of seq positions }
  const hitWindow = (w, rec) => {
    if (isSelf(rec)) return;
    const key = sourceKeyOf(rec);
    const c = found.get(key) || { rec, windows: new Set() };
    c.windows.add(w.j);
    found.set(key, c);
  };
  const epmcPhrase = async w => {
    stats.queries++;
    const r = await getJson(`${EPMC}/search?format=json&resultType=lite&pageSize=5&query=${encodeURIComponent(`"${w.phrase}"`)}`, { ttl: 30 * 86400, timeout: 25000, retries: 2, private: keepEpmc });
    if (!r.ok) { stats.searchErrors++; return null; }
    const res = (r.data?.resultList?.result || []).filter(x => !isSelf({ title: x.title, doi: x.doi }));
    if (!res.length) return [];
    w.found = true;
    // stock wording found in many papers: one paper is enough to show it, the others would only add noise
    const common = (r.data?.hitCount || 0) > COMMON;
    if (common) stats.common++;
    for (const x of common ? res.slice(0, 1) : res) hitWindow(w, epmcRecord(x));
    return res;
  };
  update(`Searching ${windows.length} passages of the manuscript in Europe PMC`);
  const unknown = [];
  let done = 0;
  await pool(windows, 6, async w => {
    const res = await epmcPhrase(w);
    if (++done % 50 === 0) update(`Searching passages in Europe PMC (${done}/${windows.length})`);
    if (!res || !res.length) unknown.push(w);
  });
  // a match seldom stops at the edge of a searched stretch: the stretches straddling each edge of a found one are searched
  // too, so a copied passage is credited in full, not only the words that fell inside one window
  const edges = [];
  for (const w of windows.filter(x => x.found)) {
    for (const j of [w.j - WINDOW / 2, w.j + WINDOW / 2]) {
      if (j < 0 || j + WINDOW > prep.seq.length || seen.has(j)) continue;
      seen.add(j);
      const x = windowAt(prep, j, null);
      if (x) edges.push(x);
    }
  }
  if (edges.length) update(`Following ${edges.length} matches to their full length`);
  await pool(edges, 6, epmcPhrase);
  windows.push(...edges);

  // OpenAlex full text (paid per search beyond its free daily allowance): spread over the passages Europe PMC lacked
  const oaList = spread(unknown, OPENALEX_PHRASES);
  if (oaList.length) update(`Searching ${oaList.length} passages in OpenAlex full texts (publishers)`);
  let oaSpent = false; // OpenAlex's daily budget used up (HTTP 429): the remaining searches would all fail
  await pool(oaList, 4, async w => {
    if (oaSpent) return;
    stats.openalexSearches++;
    const r = await getJson(`https://api.openalex.org/works?filter=fulltext.search:${encodeURIComponent(`"${w.phrase}"`)}&per-page=5&select=id,title,doi,publication_year,primary_location,open_access,ids${cfg.OPENALEX_API_KEY ? `&api_key=${cfg.OPENALEX_API_KEY}` : ''}`, { ttl: 30 * 86400, timeout: 25000, retries: 1, private: keepOpenAlex });
    if (!r.ok) { stats.searchErrors++; if (r.status === 429) { oaSpent = true; stats.openalexBudget = true; } return; }
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
  const windowByJ = new Map(windows.map(w => [w.j, w]));
  const phraseSources = [];
  for (const c of bySize) {
    const key = sourceKeyOf(c.rec);
    if (fullTried.has(key) || repoKeys.has(key) || compared.some(x => x.key === key)) continue;
    const hit = new Uint8Array(mine.length);
    for (const j of c.windows) { const w = windowByJ.get(j); for (let k = w.from; k < w.to; k++) hit[k] = 1; }
    const passages = finishRuns(hit, mine);
    if (!passages.length) continue;
    phraseSources.push({ key, type: c.rec.type, title: c.rec.title, journal: c.rec.journal, year: c.rec.year, doi: c.rec.doi, url: c.rec.url, via: c.rec.via, compared: 'matching passages (full text not open)', hit, passages: passages.sort((a, b) => b.words - a.words) });
  }

  // 4b. the external full-text comparison: its sources join the others; one the in-house search found too keeps one
  // entry, with the matches of both
  const ext = extRun ? await extRun : null;
  const extSources = ext && !ext.error ? externalSources(ext, prep) : [];
  const own = [...fromSubs, ...fromRepo, ...compared, ...phraseSources];
  const sameAs = (a, b) => (a.url && b.url && String(a.url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') === String(b.url).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''));
  for (const x of extSources) {
    const twin = own.find(o => sameAs(o, x));
    if (!twin) { own.push(x); continue; }
    x.hit.forEach((h, k) => { if (h) twin.hit[k] = 1; });
    twin.passages = finishRuns(twin.hit.slice(), mine).sort((a, b) => b.words - a.words).map(p => twin.passages.find(q => q.from <= p.from && q.to >= p.to) || x.passages.find(q => q.from <= p.from && q.to >= p.to) || p);
  }

  // 5. primary sources (shared with the report view: public/js/shared/similarity.js)
  const all = own.map(src => ({
    key: src.key, type: src.type, title: String(src.title || '').replace(/<[^>]+>/g, ''), journal: src.journal || null, year: src.year || null, doi: src.doi || null, url: src.url || null, checkId: src.checkId || null,
    via: src.via, compared: src.compared, matchedWords: src.passages.reduce((a, p) => a + p.words, 0),
    ranges: src.passages.map(p => [p.from, p.to]).sort((a, b) => a[0] - b[0]),
    passages: src.passages.slice(0, MAX_PASSAGES).map(p => ({ from: p.from, to: p.to, words: p.words, text: p.text.slice(0, 600), ...(p.source ? { source: p.source.slice(0, 600) } : {}), ...(p.paraphrased ? { paraphrased: true } : {}) }))
  }));
  // word ranges inside quotation marks: left out of the matches unless the editor includes quotations
  const quoted = [];
  mine.forEach((w, k) => { if (!w.quoted) return; const last = quoted[quoted.length - 1]; if (last && last[1] === k) last[1] = k + 1; else quoted.push([k, k + 1]); });
  const view = SIM.recompute(all, prep.text, { tokens: mine, total: mine.length, maxText: MAX_TEXT, quoted, includeQuotes: true, minWords: FLOOR });
  const s = view.summary;

  const subsOn = Array.isArray(submissions);
  const extUsed = !!(ext && !ext.error);
  const databases = [...(extUsed ? [`External full-text similarity service: the whole text compared with web pages and publications, paraphrase included (${extSources.length} source(s) matched)`] : ext?.error ? [`External full-text similarity service: not used for this report (${ext.error})`] : []),
    ...(subsOn ? [`Earlier PJPS submissions (opt-in): ${submissions.length} sharing text with this manuscript compared in full`] : []), 'PJPS text repository (published papers and web pages kept by earlier checks)', 'Europe PMC (open-access full texts and all PubMed abstracts)', 'Open-access full texts of papers on the same subject',
    ...(stats.openalexSearches ? [`OpenAlex index of publisher full texts (${stats.openalexSearches} passage searches${stats.openalexBudget ? '; stopped: the daily OpenAlex search budget is used up - add funds at openalex.org/pricing' : ''})`] : []), ...(WEB.enabled() ? [`The web (${WEB.provider()}, ${stats.webSearches} passage searches)`] : ['The web: not searched (no web search key: SerpApi, Brave Search or Google Programmable Search)'])];
  return {
    kind: 'plagiarism',
    version: 5, // 4: bibliography compared as a section, quotations included by default; 5: matches from 5 words kept, small matches not excluded by default, flags (Turnitin's defaults)
    floor: FLOOR,
    summary: s,
    repository: subsOn ? `not stored: this manuscript was not added to any repository; earlier PJPS submissions were compared at the editor's request (${submissions.length} sharing text)` : 'not stored: this manuscript was not added to any repository, and earlier unpublished PJPS submissions were not compared (no-repository setting, as in Turnitin)',
    submissions: { compared: subsOn || extSources.some(x => x.type === 'submission'), candidates: subsOn ? submissions.length : 0, matched: fromSubs.length + extSources.filter(x => x.type === 'submission').length },
    external: ext ? { used: extUsed, sources: extSources.length, paraphrased: extSources.some(x => x.passages.some(p => p.paraphrased)), aiText: extUsed ? EXT.aiEstimate(ext.completed) : null, ...(ext.error ? { error: ext.error } : {}) } : null,
    privacy: {
      stored: false,
      statement: `The manuscript was not stored, indexed or added to any repository.${subsOn ? ' At the editor\'s request it was compared with earlier PJPS submissions, read from their own confidential reports inside PJPS.' : ''} Its text is kept only inside this confidential report, which a later report reads only when an editor turns on the comparison with earlier PJPS submissions. ${extUsed || ext?.pending ? `The full text, reference list included, was compared by an external full-text similarity service under a no-storage setting: it was not added to that service's database and the scan expires there after ${2} hours. Apart from that, only` : 'Only'} separate 8-word passages were sent to the literature and web search services, which return the papers that contain them; their answers are cached under an irreversible hash of the query, without the passage. The uploaded file is deleted once it has been read.`
    },
    sources: view.sources,
    alsoMatched: view.alsoMatched,
    document: view.document,
    sections: view.sections,
    groups: view.groups,
    quoted,
    // Turnitin's defaults: bibliography and quotations included, the editor excludes them in Filters
    settings: { excluded: [], minWords: FLOOR, excludeSections: [], minPercent: 0, minSourceWords: 0, includeQuotes: true },
    // Turnitin's flags: replaced characters and hidden characters (read through by the comparison)
    flags: SIM.textFlags(prep.text),
    filters: { bibliography: prep.bibliographyFound ? 'included (the reference list is compared; exclude it in Filters)' : 'no reference list found', quotes: `included (${prep.quotedWords} quoted words)`, smallMatches: "not excluded (Turnitin's default; the shortest match counted is 5 words)", citations: `ignored inside matches (${prep.citeWords} words of in-text citations)` },
    selfMatches,
    checked: { passages: stats.windows, passagesFound: stats.windowsFound, commonPhrases: stats.common, queries: stats.queries, openalexSearches: stats.openalexSearches, webSearches: stats.webSearches, neighbours: stats.neighbours, candidates: found.size, sourcesCompared: compared.length, repositoryMatches: fromRepo.length, repository: await corpus.stats().catch(() => ({})), submissionsCompared: subsOn ? submissions.length : 0, searchErrors: stats.searchErrors, databases },
    coverage: `${extUsed ? 'The whole text with an external full-text similarity service (web pages, publications, paraphrase detection); ' : ''}Open-access literature and all PubMed abstracts (Europe PMC), publisher full texts indexed by OpenAlex (${OPENALEX_PHRASES} passage searches at most per report), ${WEB.enabled() ? `the open web (${WEB.provider()})` : 'not the open web (add a web search key: SerpApi, Brave Search or Google Programmable Search)'}. ${subsOn ? 'Earlier PJPS submissions were compared (opt-in).' : 'Earlier unpublished PJPS submissions were not compared (opt-in, off).'} Turnitin's own archive of student papers is not available.`,
    method: `Like Turnitin's similarity report: the whole manuscript was compared with the open full texts of papers on the same subject, then every remaining ${WINDOW}-word stretch, aligned on the sentences (${stats.windows} passages), was searched as an exact phrase; open sources were compared with the whole text in ${K}-word sequences (case, punctuation, plural forms and in-text citation markers ignored; up to ${GAP} different words inside one match; sentences restated in other words matched by their specific words and meaning, marked paraphrased), paywalled ones by the passages found in them. The bibliography and quotations are compared (the editor can exclude either), and matches of ${FLOOR} words or more are counted (the editor can exclude small matches). Every matched word is credited to one primary source, so the source percentages add up to the Similarity Index.`
  };
}

/**
 * The report with the editor's filters, recomputed for display or export (shared with the view): sources excluded, a
 * higher minimum match length (Turnitin), sections left out of the comparison (iThenticate's "exclude abstract /
 * methods") and sources under a percentage left out (Turnitin's "exclude sources under x %")
 */
async function applySettings(pl, { excluded = [], minWords = null, excludeSections = [], minPercent = 0, minSourceWords = 0, includeQuotes = false } = {}) {
  await shared();
  if (!pl || pl.error || (pl.version || 0) < 3) return pl;
  const text = (pl.document || []).map(d => d.t).join('');
  const all = [...(pl.sources || []), ...(pl.alsoMatched || [])].map(x => ({ ...x, excluded: undefined, small: undefined }));
  const floor = pl.floor || MIN_MATCH; // the shortest match the report kept
  const min = Math.max(floor, Math.min(200, parseInt(minWords, 10) || floor));
  const minSrc = Math.max(0, Math.min(500, parseInt(minSourceWords, 10) || 0));
  const keys = new Set(all.map(x => x.key));
  const ex = [...new Set([].concat(excluded || []))].filter(k => keys.has(k));
  const tokens = SIM.tokenize(text);
  const secKeys = new Set(SIM.sectionsOf(text, tokens, pl.summary.words).map(s => s.key));
  const exSec = [...new Set([].concat(excludeSections || []))].filter(k => secKeys.has(k) && k !== 'body');
  const minPct = Math.max(0, Math.min(10, Number(minPercent) || 0));
  const inclQ = !!includeQuotes && !!pl.quoted?.length;
  const view = SIM.recompute(all, text, { tokens, total: pl.summary.words, excluded: ex, minWords: min, excludeSections: exSec, minPercent: minPct, minSourceWords: minSrc, quoted: pl.quoted || [], includeQuotes: inclQ });
  const qWords = (pl.quoted || []).reduce((a, [p, q]) => a + q - p, 0);
  const { sources: _s, smallSources: _p, sections: _c, ...filters } = pl.filters || {};
  return { ...pl, summary: view.summary, sources: view.sources, alsoMatched: view.alsoMatched, document: view.document, sections: view.sections, groups: view.groups,
    settings: { excluded: ex, minWords: min, excludeSections: exSec, minPercent: minPct, minSourceWords: minSrc, includeQuotes: inclQ },
    filters: { ...filters, smallMatches: min > floor ? `excluded (fewer than ${min} words)` : pl.floor ? "not excluded (Turnitin's default; the shortest match counted is 5 words)" : `excluded (fewer than ${min} words)`,
      ...(secKeys.has('references') ? { bibliography: exSec.includes('references') ? 'excluded by the editor' : 'included (the reference list is compared)' } : {}), ...(pl.quoted ? { quotes: `${inclQ ? 'included' : 'excluded'} (${qWords} quoted words)` } : {}),
      ...(ex.length ? { sources: `${ex.length} source(s) excluded by the editor` } : {}),
      ...(minPct || minSrc ? { smallSources: `sources under ${[minPct ? `${minPct}%` : '', minSrc ? `${minSrc} words` : ''].filter(Boolean).join(' or ')} excluded` } : {}),
      ...(exSec.length ? { sections: `excluded from the comparison: ${view.sections.filter(x => x.excluded).map(x => x.label).join(', ')}` } : {}) } };
}

/** The primary sources (then the sources whose words all went to larger ones) as CSV, for the editorial file */
function toCsv(pl) {
  const F = require('../format');
  const row = x => [x.no ?? '', x.no ? x.percent : 0, x.words ?? 0, x.matchedWords ?? '', String(x.title || '').replace(/<[^>]+>/g, ''), x.type === 'internet' ? 'Internet source' : x.type === 'submission' ? 'Submitted work' : 'Publication',
    x.journal || '', x.year || '', x.doi || '', x.url || '', x.via || '', x.compared || '', x.no ? '' : x.excluded ? 'excluded by the editor' : x.small ? 'under the small-source filter' : 'all words credited to larger sources'];
  return F.toCsv(['No.', 'Similarity %', 'Words credited', 'Words matched', 'Source', 'Type', 'Journal / site', 'Year', 'DOI', 'Link', 'Found via', 'Compared', 'Not counted because'],
    [...(pl.sources || []), ...(pl.alsoMatched || [])].map(row));
}

module.exports = { checkPlagiarism, earlierSubmissions, externalSources, applySettings, toCsv, prepare, overlap, match, rewordedSentences, PARA, finishRuns, citeSpans, searchWindows, shared };
