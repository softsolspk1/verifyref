// integrity/similarity.js - Plagiarism & text similarity, and cross-paper analysis:
//   - sentence-level overlap with every earlier submission screened here (only sentence hashes are stored, never text)
//   - text repeated inside the manuscript (copied paragraphs)
//   - paraphrasing-tool traces: tortured phrases and look-alike / invisible characters (Module 4 engine)
//   - published papers on the same subject (OpenAlex): the same authors' earlier papers with an overlapping abstract
//     (duplicate publication, self-plagiarism, salami slicing) and other authors' papers with a near-identical abstract
// Full-text comparison with the published literature needs a Crossref Similarity Check (iThenticate) account; that is
// reported as not checked. Only the title and abstract words are sent to OpenAlex, never the manuscript text.
const db = require('../db');
const cfg = require('../config');
const { getJson, isOnline } = require('../http');
const { titleSimilarity, splitName, nameMatch, invertedIndexToText, STOPWORDS } = require('../text');
const { torturedPhrases, screenerMatches, hiddenText, fnv } = require('../papermill');
const { dimension, finish, sentences } = require('./common');

const normSentence = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Hashes of the manuscript's sentences (at least 60 characters, so stock phrases do not count) */
function sentenceHashes(text) {
  const out = new Map();
  for (const s of sentences(text)) {
    const n = normSentence(s);
    if (n.length < 60) continue;
    const h = fnv(n);
    if (!out.has(h)) out.set(h, s);
  }
  return out;
}

function trigramSet(text) {
  const w = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(x => x.length > 2 && !STOPWORDS.has(x));
  const out = new Set();
  for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(' '));
  return out;
}
const overlap = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.min(a.size, b.size); };

async function archiveOverlap(hashes, { excludeCode, authors }) {
  const rows = await db.all('SELECT id, check_id, manuscript_code, title, authors, sentence_hashes, created_at FROM integrity_records ORDER BY created_at DESC LIMIT 4000');
  const mine = [...hashes.keys()];
  const out = [];
  for (const r of rows) {
    if (excludeCode && r.manuscript_code === excludeCode) continue;
    const theirs = new Set(r.sentence_hashes || []);
    const shared = mine.filter(h => theirs.has(h));
    if (shared.length < 3) continue;
    const sameAuthors = (r.authors || []).some(x => authors.some(a => nameMatch(splitName(x), a) === 'exact'));
    out.push({ checkId: r.check_id, manuscriptCode: r.manuscript_code, title: r.title, date: r.created_at, sentences: shared.length, share: Math.round(shared.length / mine.length * 100), sameAuthors, examples: shared.slice(0, 4).map(h => hashes.get(h)) });
  }
  return { compared: rows.length, matches: out.sort((a, b) => b.sentences - a.sentences).slice(0, 10) };
}

function internalRepeats(hashes, text) {
  const counts = new Map();
  for (const s of sentences(text)) {
    const n = normSentence(s);
    if (n.length < 80) continue;
    counts.set(n, { s, n: (counts.get(n)?.n || 0) + 1 });
  }
  return [...counts.values()].filter(x => x.n >= 2).map(x => ({ sentence: x.s, count: x.n }));
}

async function openalexWorks(query, filter = '') {
  const key = cfg.OPENALEX_API_KEY ? `&api_key=${cfg.OPENALEX_API_KEY}` : '';
  const r = await getJson(`https://api.openalex.org/works?search=${encodeURIComponent(query.slice(0, 200))}&per-page=15${filter ? `&filter=${filter}` : ''}&select=id,doi,title,publication_year,authorships,abstract_inverted_index,primary_location${key}`, { ttl: 7 * 86400, timeout: 15000, retries: 1 });
  return r.ok ? r.data?.results || [] : null;
}

/** Published papers similar to this one: same authors (duplicate / salami) or others (copied abstract) */
async function publishedOverlap(meta, abstract) {
  const title = meta.title || '';
  if (title.length < 20) return { checked: false, items: [] };
  const works = await openalexWorks(title);
  if (works === null) return { checked: false, error: 'OpenAlex not reachable', items: [] };
  const mineAbs = trigramSet(abstract);
  const authors = (meta.authors || []).filter(a => a.family);
  const items = [];
  for (const w of works) {
    const names = (w.authorships || []).map(a => a.author?.display_name || '').filter(Boolean);
    const shared = authors.filter(a => names.some(n => nameMatch(splitName(n), a))).map(a => a.name || `${a.given} ${a.family}`.trim());
    const ts = titleSimilarity(title, w.title || '');
    const absOverlap = overlap(mineAbs, trigramSet(invertedIndexToText(w.abstract_inverted_index)));
    if (ts < 0.45 && absOverlap < 0.25) continue;
    items.push({ title: w.title, year: w.publication_year, doi: w.doi, journal: w.primary_location?.source?.display_name || '', link: w.doi || w.id, sharedAuthors: shared, titleSimilarity: Math.round(ts * 100), abstractOverlap: Math.round(absOverlap * 100) });
  }
  return { checked: true, compared: works.length, items: items.sort((a, b) => b.abstractOverlap - a.abstractOverlap).slice(0, 8) };
}

async function analyzeSimilarity(text, { meta = {}, abstract = '', online = isOnline() } = {}) {
  const d = dimension('similarity', 'Text similarity & cross-paper overlap');
  const hashes = sentenceHashes(text);
  const authors = (meta.authors || []).filter(a => a.family);

  const archive = await archiveOverlap(hashes, { excludeCode: meta.manuscriptCode || null, authors }).catch(e => ({ compared: 0, matches: [], error: e.message }));
  const strong = archive.matches.filter(m => m.share >= 20 || m.sentences >= 15);
  const weak = archive.matches.filter(m => !strong.includes(m));
  const ev = m => ({ text: `${m.manuscriptCode || 'check #' + m.checkId}: “${m.title || ''}” — ${m.sentences} identical sentence(s) (${m.share}% of this manuscript)${m.sameAuthors ? ', same author(s)' : ', different authors'}`, quote: m.examples[0], checkId: m.checkId });
  if (strong.length) d.sig('archive', `Text shared with earlier submission(s) to this journal (${strong.length})`, 'high', 5, strong.map(ev), 'Same authors: duplicate or redundant submission. Different authors: copied text, or a shared template from a paper mill.');
  else if (weak.length) d.sig('archive-partial', `Some sentences identical to earlier submission(s) (${weak.length})`, 'medium', 2, weak.map(ev), 'A few shared sentences may be standard method descriptions; read them before asking the authors.');

  const repeats = internalRepeats(hashes, text);
  if (repeats.length >= 2) d.sig('internal', `${repeats.length} sentence(s) repeated within the manuscript`, 'low', 0.5, repeats.slice(0, 5).map(r => ({ text: `${r.count}×`, quote: r.sentence.slice(0, 220) })), 'Repeated passages usually mean careless assembly from other documents.');

  const tortured = torturedPhrases(text);
  const pps = await screenerMatches(text).catch(() => ({ tortured: [] }));
  const known = new Set(tortured.map(t => t.phrase.toLowerCase()));
  for (const t of pps.tortured || []) if (!known.has(t.phrase.toLowerCase())) tortured.push(t);
  if (tortured.length) d.sig('paraphrase', `${tortured.length} tortured phrase(s) — text run through a paraphrasing tool`, tortured.length >= 3 ? 'high' : 'medium', tortured.length >= 3 ? 4 : 2,
    tortured.slice(0, 10).map(t => ({ text: `“${t.phrase}” → ${t.correct}`, quote: t.examples?.[0] })), 'Paraphrasing tools replace technical terms with odd synonyms to hide copied text (Problematic Paper Screener).');
  const hid = hiddenText(text);
  if (hid.zero >= 5 || hid.mixed.length) d.sig('hidden', `Invisible or look-alike characters (${hid.zero} invisible, ${hid.mixed.length} mixed-alphabet words)`, hid.mixed.length >= 2 || hid.zero >= 20 ? 'high' : 'medium', hid.mixed.length >= 2 || hid.zero >= 20 ? 4 : 2,
    hid.mixed.map(w => ({ text: `“${w}” mixes Latin with Cyrillic/Greek letters` })), 'Used to defeat plagiarism-detection software.');

  let published = { checked: false, items: [] };
  if (online) {
    published = await publishedOverlap(meta, abstract || text.slice(0, 2500)).catch(e => ({ checked: false, error: e.message, items: [] }));
    const own = published.items.filter(p => p.sharedAuthors.length && (p.abstractOverlap >= 30 || p.titleSimilarity >= 85));
    const salami = published.items.filter(p => p.sharedAuthors.length && !own.includes(p) && (p.titleSimilarity >= 55 || p.abstractOverlap >= 15));
    const others = published.items.filter(p => !p.sharedAuthors.length && (p.abstractOverlap >= 35 || p.titleSimilarity >= 90));
    const pev = p => ({ text: `“${p.title}” (${p.journal || 'journal unknown'}${p.year ? ', ' + p.year : ''}) — title ${p.titleSimilarity}% similar, abstract ${p.abstractOverlap}% overlap${p.sharedAuthors.length ? `; shared author(s): ${p.sharedAuthors.join(', ')}` : ''}`, link: p.link });
    if (own.length) d.sig('duplicate-publication', `The authors already published a near-identical paper (${own.length})`, 'high', 5, own.map(pev), 'Possible duplicate publication or self-plagiarism. It may also be the authors\' own preprint or thesis — ask before concluding.');
    if (salami.length) d.sig('salami', `Closely related papers by the same authors (${salami.length}) — possible salami slicing`, 'medium', 2, salami.map(pev), 'One study split into several papers. Ask the authors to explain how this manuscript differs and to cite the related papers.');
    if (others.length) d.sig('published-other', `A published paper by other authors has a near-identical title or abstract (${others.length})`, 'high', 4, others.map(pev), 'Possible plagiarism of a published paper; compare the full texts.');
  }

  d.details = { sentences: hashes.size, archive, internalRepeats: repeats.slice(0, 10), paraphrase: tortured.slice(0, 20), hidden: hid, published, fullTextLiterature: 'Not checked — full-text comparison with published literature needs a Crossref Similarity Check (iThenticate) account.' };
  d.checked = hashes.size > 0;
  d._hashes = [...hashes.keys()].slice(0, 4000);
  return finish(d);
}

module.exports = { analyzeSimilarity, sentenceHashes, trigramSet, overlap, normSentence };
