// checks/plagiarism.js - similarity (originality) report of a manuscript, laid out like Turnitin's: one Similarity Index,
// broken down into Internet sources, Publications and Submitted works (earlier PJPS submissions), a numbered list of
// primary sources whose percentages add up to the index, and the manuscript text highlighted in each source's colour.
//
//   1. Filters as in Turnitin: the bibliography is excluded, quoted text is excluded, matches shorter than MIN_MATCH words
//      are excluded.
//   2. Source discovery: up to SAMPLES distinctive passages from all parts of the text are searched as exact phrases in
//      Europe PMC (open-access full texts and all PubMed abstracts); phrases it does not know are searched in CORE
//      (open-access repositories, theses) and, with a SerpApi key, on the web (Google). Earlier PJPS submissions are
//      compared through their stored text fingerprints (Module 4).
//   3. Matching: the texts found are compared with the whole manuscript in overlapping K-word sequences (lower case,
//      punctuation and plural "s" ignored); runs separated by at most GAP different words are joined, so lightly
//      reworded sentences still count as one match.
//   4. Attribution: every matched word is credited to one source only, the source with the most matched text first
//      (Turnitin's "primary sources"), so the source percentages add up to the Similarity Index.
// Coverage: open-access literature, PubMed abstracts, open repositories, the open web and PJPS submissions. Paywalled full
// texts and other institutions' student papers (Turnitin's own archive) are not available to an in-house check.
const db = require('../db');
const { getJson, getText } = require('../http');
const S = require('../sources');
const { titleSimilarity } = require('../text');
const corpus = require('../corpus');

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const SAMPLES = 80;          // passages searched
const WEB_PHRASES = 10;      // of those not found in the literature, searched on the web (SerpApi, paid per search)
const MAX_SOURCES = 15;      // literature / web sources downloaded and compared
const K = 5;                 // words per compared sequence
const GAP = 2;               // different words allowed inside one match
const MIN_MATCH = 8;         // exclude matches shorter than this (words)
const COMMON_PHRASE = 25;    // a phrase found in more papers than this is standard wording, not used to pick sources
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

// ------------------------------------------------------------------ main

/**
 * input: { body, meta }  ->  { kind: 'plagiarism', summary: { similarity, internet, publications, submissions, ... },
 *   sources: [{ no, type, percent, ... }], document: [{ t, s }], filters, selfMatches, checked, method }
 */
async function checkPlagiarism({ body, meta = {} }, update = () => {}) {
  const prep = prepare(body);
  const mine = prep.words;
  if (mine.length < 200) return { kind: 'plagiarism', error: 'The manuscript text is too short or not available for a similarity check.' };
  const samples = pickSamples(prep.text);
  // 1. the PJPS text repository (R2): earlier submissions and every source text kept by earlier checks, compared in full
  update('Comparing with the PJPS text repository');
  const repo = await corpus.candidates(prep.text, { excludeCode: meta.manuscriptCode || null }).catch(() => []);
  const repoKeys = new Set(repo.map(d => d.sourceKey));
  update(`Searching ${samples.length} passages in Europe PMC, CORE${S.scholarEnabled() ? ' and on the web' : ''}`);
  const found = new Map(); // key -> candidate
  let queries = 0, searchErrors = 0, webSearches = 0;
  const add = (key, rec, phrase) => {
    if (!key) return;
    const c = found.get(key) || { ...rec, phrases: [] };
    if (!c.phrases.includes(phrase)) c.phrases.push(phrase);
    found.set(key, c);
  };
  const noHit = [];
  await pool(samples, 4, async s => {
    const phrase = phraseOf(s);
    if (phrase.split(' ').length < 8) return;
    queries++;
    const r = await getJson(`${EPMC}/search?format=json&resultType=core&pageSize=6&query=${encodeURIComponent(`"${phrase}"`)}`, { ttl: 7 * 86400, timeout: 25000, retries: 1 });
    if (!r.ok) { searchErrors++; return; }
    const n = r.data?.hitCount || 0;
    if (!n) { noHit.push(phrase); return; }
    if (n > COMMON_PHRASE) return;
    for (const x of r.data.resultList?.result || []) {
      add(x.pmcid || x.pmid || x.doi || x.id, { type: 'publication', title: x.title, journal: x.journalInfo?.journal?.title || x.journalTitle || null, year: x.pubYear || null, doi: x.doi || null,
        pmcid: x.pmcid || null, pmid: x.pmid || null, abstract: stripXml(x.abstractText || ''), via: 'Europe PMC', url: x.pmcid ? `https://europepmc.org/article/PMC/${x.pmcid}` : x.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/` : x.doi ? `https://doi.org/${x.doi}` : null }, phrase);
    }
  });
  // CORE (repositories, theses, non-PubMed journals) for phrases Europe PMC does not have
  const stillNoHit = [];
  await pool(noHit.slice(0, 20), 2, async phrase => {
    queries++;
    const r = await S.coreQuery(`"${phrase}"`, 4).catch(() => ({ error: true }));
    if (r.error) searchErrors++;
    if (!(r.records || []).length) stillNoHit.push(phrase);
    for (const x of r.records || []) add(x.doi || x.coreId || x.url || x.title, { type: x.journal ? 'publication' : 'internet', title: x.title, journal: x.journal || null, year: x.year || null, doi: x.doi || null, abstract: x.abstract || '', fullText: x.fullText || '', via: 'CORE', url: x.url || (x.doi ? `https://doi.org/${x.doi}` : null) }, phrase);
  });
  // the open web (Google through SerpApi) for phrases no literature database has
  if (S.scholarEnabled()) {
    await pool(stillNoHit.slice(0, WEB_PHRASES), 2, async phrase => {
      queries++; webSearches++;
      const r = await S.serpSearch('google', `"${phrase}"`, 5).catch(e => ({ ok: false, error: e.message }));
      if (r.skipped) return;
      if (!r.ok) { searchErrors++; return; }
      for (const o of (r.data?.organic_results || []).slice(0, 3)) {
        if (!o.link || /\.pdf($|\?)/i.test(o.link)) continue;
        let host = '';
        try { host = new URL(o.link).hostname.replace(/^www\./, ''); } catch (e) { continue; }
        add(o.link, { type: 'internet', title: o.title || host, journal: host, year: null, doi: null, webUrl: o.link, via: 'Web (Google)', url: o.link }, phrase);
      }
    });
  }

  // the manuscript's own published version or preprint is not plagiarism
  const selfMatches = [];
  const ranked = [...found.values()].filter(c => {
    const self = meta.title && c.title && titleSimilarity(meta.title, c.title) >= 0.9;
    if (self) selfMatches.push({ title: c.title, journal: c.journal, year: c.year, doi: c.doi, url: c.url });
    return !self;
  }).filter(c => !repoKeys.has(sourceKeyOf(c))).sort((a, b) => b.phrases.length - a.phrases.length).slice(0, MAX_SOURCES);

  update(`Comparing the manuscript with ${ranked.length} source(s) and earlier PJPS submissions`);
  const compared = (await pool(ranked, 3, async c => {
    const t = await sourceText(c);
    if (!t.text) return null;
    const o = overlap(mine, t.text);
    if (!o.passages.length) return null;
    // every source text read is kept in the repository, so later checks compare with it directly
    await corpus.addDoc({ kind: c.type, sourceKey: sourceKeyOf(c), title: c.title, meta: { journal: c.journal, year: c.year, doi: c.doi, url: c.url, via: c.via, scope: t.scope }, text: t.text }).catch(() => null);
    return { type: c.type, title: c.title, journal: c.journal, year: c.year, doi: c.doi, url: c.url, via: c.via, compared: t.scope, hit: o.hit, passages: o.passages };
  })).filter(Boolean);
  const fromRepo = repo.map(d => {
    const o = overlap(mine, d.text);
    if (!o.passages.length) return null;
    const m = d.meta || {};
    return { type: d.kind, title: d.kind === 'submission' ? `${m.manuscriptCode || 'Earlier PJPS submission'}${d.title ? `: ${d.title}` : ''}` : d.title, journal: m.journal || null, year: m.year || null, doi: m.doi || null, url: m.url || null,
      checkId: m.checkId || null, via: d.kind === 'submission' ? 'PJPS submissions' : `${m.via || 'Repository'} (PJPS repository)`, compared: d.kind === 'submission' ? 'full text (PJPS repository)' : `${m.scope || 'text'} (PJPS repository)`, hit: o.hit, passages: o.passages };
  }).filter(Boolean);
  // submissions already in the repository with their full text are not counted again from their fingerprints
  const repoChecks = new Set(fromRepo.filter(x => x.checkId).map(x => String(x.checkId)));
  const subs = await submissionMatches(mine, meta.manuscriptCode);
  const all = [...fromRepo, ...compared, ...subs.sources.filter(x => !repoChecks.has(String(x.checkId)))];

  // primary sources: each matched word is credited to one source, the one with the most matched text first
  const owner = new Int16Array(mine.length).fill(-1);
  all.sort((a, b) => b.passages.reduce((x, p) => x + p.words, 0) - a.passages.reduce((x, p) => x + p.words, 0));
  all.forEach((src, si) => { src.hit.forEach((h, k) => { if (h && owner[k] < 0) owner[k] = si; }); });
  const credited = all.map((_, si) => owner.reduce((a, o) => a + (o === si ? 1 : 0), 0));
  const total = mine.length;
  const pct = n => Math.round(n / total * 1000) / 10;
  const kept = all.map((src, si) => ({ src, si, words: credited[si] })).filter(x => x.words >= MIN_MATCH);
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
  const covered = sources.reduce((a, x) => a + x.words, 0);
  const similarity = pct(covered);
  const largest = sources.reduce((m, x) => Math.max(m, x.percent), 0);
  const level = similarity >= 25 || largest >= 15 ? 'bad' : similarity >= 10 || largest >= 5 ? 'warn' : 'ok';
  const databases = ['PJPS text repository (earlier submissions and kept source texts, Cloudflare R2)', 'Europe PMC (open-access full texts and all PubMed abstracts)', 'CORE (open-access repositories and theses)', ...(S.scholarEnabled() ? ['The web (Google, through SerpApi)'] : []), `Earlier PJPS submissions (${subs.compared})`];
  return {
    kind: 'plagiarism',
    version: 2,
    summary: { similarity, internet: byType('internet'), publications: byType('publication'), submissions: byType('submission'), largestSource: largest, sources: sources.length, level, words: total },
    sources,
    document,
    filters: { bibliography: prep.bibliographyExcluded ? 'excluded' : 'not found in the text (body only was compared)', quotes: `excluded (${prep.quotedWords} quoted words)`, smallMatches: `excluded (fewer than ${MIN_MATCH} words)` },
    selfMatches,
    checked: { passages: samples.length, queries, webSearches, candidates: found.size, sourcesCompared: compared.length, repositoryMatches: fromRepo.length, repository: await corpus.stats().catch(() => ({})), submissionsCompared: subs.compared, searchErrors, databases },
    coverage: 'Open-access literature, PubMed abstracts, open repositories and theses, the open web (with a SerpApi key) and earlier PJPS submissions. Paywalled full texts and other institutions\' student papers are not available to an in-house check, so overlap with them can be missed.',
    method: `Like Turnitin's similarity report: ${samples.length} distinctive passages from all parts of the manuscript were searched as exact phrases to find sources; each source was compared with the whole text in ${K}-word sequences (case, punctuation and plural forms ignored; up to ${GAP} different words inside one match). The bibliography and quotations are excluded, and so are matches shorter than ${MIN_MATCH} words. Every matched word is credited to one primary source, so the source percentages add up to the Similarity Index.`
  };
}

module.exports = { checkPlagiarism, pickSamples, phraseOf, overlap, prepare, finishRuns, submissionMatches };
