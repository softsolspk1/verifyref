// checks/plagiarism.js - text overlap of a manuscript with the published literature (Full Screening Report).
//   1. distinctive sentences are taken from all parts of the manuscript body (not the reference list)
//   2. a 10-word phrase of each is searched as an exact phrase in Europe PMC (full texts of the open-access papers and
//      all PubMed abstracts) and, for phrases Europe PMC does not know, in CORE (open-access repositories)
//   3. the texts of the papers found are downloaded and compared with the whole manuscript in 8-word sequences:
//      similarity = share of the manuscript's 8-word sequences that also occur in the source, with the matching passages
// Phrases that occur in many papers (standard wording) are not used to pick sources. A source with the manuscript's own
// title (its preprint or published version) is reported separately and not counted.
const { getJson, getText } = require('../http');
const S = require('../sources');
const { titleSimilarity } = require('../text');

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const SAMPLES = 24;          // sentences searched
const MAX_SOURCES = 8;       // sources downloaded and compared
const N = 8;                 // words per compared sequence
const COMMON_PHRASE = 25;    // a phrase found in more papers than this is standard wording

const STOP = new Set(('a an the and or of in on at to for from by with without as is are was were be been being this that these those it its their there '
  + 'which who whom whose than then into onto over under between among within during after before about above below also such may might can could '
  + 'should would will shall not no nor but if so very more most less least all any each both either neither other others some same than too '
  + 'we our us they them he she his her i you your one two three using used use based study studies present results result showed shown show').split(' '));
// wording every paper uses; sentences built from it say nothing about where a text came from
const BOILERPLATE = /\b(all authors|conflicts? of interest|informed consent|ethic(s|al) (committee|approval)|statistical(ly)? analys|mean ?± ?s\.?d|were purchased from|analytical grade|data are (expressed|presented)|this work was supported|corresponding author|the authors (declare|thank|acknowledge)|creative commons|copyright)\b/i;

const norm = w => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const wordsOf = text => String(text || '').split(/\s+/).map(w => ({ raw: w, n: norm(w) })).filter(w => w.n);

/** Sentences worth searching: 12-60 words, mostly prose, not boilerplate, ranked by how many specific words they carry */
function candidateSentences(body) {
  const text = String(body || '').replace(/\s+/g, ' ');
  const sents = text.split(/(?<=[.!?])\s+(?=[A-Z(])/).map(s => s.trim());
  const out = [];
  sents.forEach((s, i) => {
    const w = wordsOf(s);
    if (w.length < 12 || w.length > 60) return;
    const digits = w.filter(x => /\d/.test(x.n)).length;
    if (digits / w.length > 0.2 || BOILERPLATE.test(s) || /\[\d+|\(\w+ et al\.?,? \d{4}/.test(s) && w.length < 18) return;
    const content = w.filter(x => !STOP.has(x.n) && x.n.length >= 5).length;
    out.push({ i, s, score: content / Math.sqrt(w.length) });
  });
  return out;
}

/** The 10-word stretch of a sentence with the most specific words (searched as an exact phrase) */
function phraseOf(sentence) {
  const w = wordsOf(sentence).map(x => x.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  let best = 0, at = 0;
  for (let k = 0; k + 10 <= w.length; k++) {
    const sc = w.slice(k, k + 10).filter(x => !STOP.has(norm(x)) && norm(x).length >= 5).length;
    if (sc > best) { best = sc; at = k; }
  }
  return w.slice(at, at + 10).join(' ').replace(/"/g, '');
}

/** Spread the samples over the whole text: the best sentence of each of SAMPLES equal parts */
function pickSamples(body) {
  const c = candidateSentences(body);
  if (!c.length) return [];
  const parts = Math.min(SAMPLES, c.length);
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

/** Text of a source: Europe PMC full text (open access) or the abstract */
async function sourceText(c) {
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

/** 8-word sequences of the manuscript that occur in the source, merged into passages */
function overlap(mineWords, theirs) {
  const set = new Set();
  const tw = wordsOf(theirs).map(x => x.n);
  for (let k = 0; k + N <= tw.length; k++) set.add(tw.slice(k, k + N).join(' '));
  const hit = new Uint8Array(mineWords.length);
  let matched = 0;
  for (let k = 0; k + N <= mineWords.length; k++) {
    if (set.has(mineWords.slice(k, k + N).map(x => x.n).join(' '))) { matched++; for (let j = k; j < k + N; j++) hit[j] = 1; }
  }
  const passages = [];
  for (let k = 0; k < hit.length;) {
    if (!hit[k]) { k++; continue; }
    let e = k;
    while (e < hit.length && hit[e]) e++;
    passages.push({ words: e - k, text: mineWords.slice(k, e).map(x => x.raw).join(' ') });
    k = e;
  }
  return { matched, hit, passages: passages.sort((a, b) => b.words - a.words) };
}

/**
 * input: { body, meta }  ->  { kind: 'plagiarism', summary: { similarity, level, sources }, sources: [...], selfMatches, checked, method }
 */
async function checkPlagiarism({ body, meta = {} }, update = () => {}) {
  const mine = wordsOf(body);
  const total = Math.max(0, mine.length - N + 1);
  if (total < 200) return { kind: 'plagiarism', error: 'The manuscript text is too short or not available for a text-overlap check.' };
  const samples = pickSamples(body);
  update(`Searching ${samples.length} passages in Europe PMC and CORE`);
  const found = new Map(); // key -> candidate
  let queries = 0, epmcErrors = 0;
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
    if (!r.ok) { epmcErrors++; return; }
    const n = r.data?.hitCount || 0;
    if (!n) { noHit.push(phrase); return; }
    if (n > COMMON_PHRASE) return;
    for (const x of r.data.resultList?.result || []) {
      add(x.pmcid || x.pmid || x.doi || x.id, { title: x.title, journal: x.journalInfo?.journal?.title || x.journalTitle || null, year: x.pubYear || null, doi: x.doi || null,
        pmcid: x.pmcid || null, pmid: x.pmid || null, abstract: stripXml(x.abstractText || ''), via: 'Europe PMC', url: x.pmcid ? `https://europepmc.org/article/PMC/${x.pmcid}` : x.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/` : x.doi ? `https://doi.org/${x.doi}` : null }, phrase);
    }
  });
  // CORE (repositories, theses, non-PubMed journals) for phrases Europe PMC does not have
  await pool(noHit.slice(0, 8), 2, async phrase => {
    queries++;
    const r = await S.coreQuery(`"${phrase}"`, 4).catch(() => ({ error: true }));
    for (const x of r.records || []) add(x.doi || x.coreId || x.url || x.title, { title: x.title, journal: x.journal || null, year: x.year || null, doi: x.doi || null, abstract: x.abstract || '', fullText: x.fullText || '', via: 'CORE', url: x.url || (x.doi ? `https://doi.org/${x.doi}` : null) }, phrase);
  });

  // the manuscript's own published version or preprint is not plagiarism
  const selfMatches = [];
  const ranked = [...found.values()].filter(c => {
    const self = meta.title && c.title && titleSimilarity(meta.title, c.title) >= 0.9;
    if (self) selfMatches.push({ title: c.title, journal: c.journal, year: c.year, doi: c.doi, url: c.url });
    return !self;
  }).sort((a, b) => b.phrases.length - a.phrases.length).slice(0, MAX_SOURCES);

  update(`Comparing the manuscript with ${ranked.length} source(s)`);
  const union = new Uint8Array(mine.length);
  const sources = (await pool(ranked, 3, async c => {
    const t = c.fullText && c.fullText.length > 2000 ? { text: c.fullText, scope: 'full text' } : await sourceText(c);
    if (!t.text) return null;
    const o = overlap(mine, t.text);
    // a shared instrument or software name is not overlap worth reporting
    if (o.passages.reduce((a, p) => a + p.words, 0) < 15) return null;
    o.hit.forEach((h, k) => { if (h) union[k] = 1; });
    return { title: c.title, journal: c.journal, year: c.year, doi: c.doi, url: c.url, via: c.via, compared: t.scope,
      similarity: Math.round(o.matched / total * 1000) / 10, matchedWords: o.passages.reduce((a, p) => a + p.words, 0),
      passages: o.passages.slice(0, 4).map(p => ({ words: p.words, text: p.text.slice(0, 600) })) };
  })).filter(Boolean).sort((a, b) => b.similarity - a.similarity);

  const coveredWords = union.reduce((a, b) => a + b, 0);
  const similarity = Math.round(coveredWords / mine.length * 1000) / 10;
  const largest = sources[0]?.similarity || 0;
  const level = similarity >= 25 || largest >= 15 ? 'bad' : similarity >= 10 || largest >= 5 ? 'warn' : 'ok';
  return {
    kind: 'plagiarism',
    summary: { similarity, largestSource: largest, sources: sources.length, level, words: mine.length },
    sources,
    selfMatches,
    checked: { passages: samples.length, queries, candidates: found.size, searchErrors: epmcErrors, databases: ['Europe PMC (open-access full texts and PubMed abstracts)', 'CORE (open-access repositories)'] },
    method: `${samples.length} distinctive passages from all parts of the manuscript were searched as exact phrases; the ${sources.length ? 'sources found were' : 'search found no source that was'} compared with the whole text in ${N}-word sequences. Similarity is the share of the manuscript's words inside sequences that also occur in a source. Open-access full texts are compared in full, other papers by their abstract, so closed-access overlap can be missed.`
  };
}

module.exports = { checkPlagiarism, pickSamples, phraseOf, overlap };
