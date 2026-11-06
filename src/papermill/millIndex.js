// papermill/millIndex.js - Module 4: resemblance to papers already retracted for paper-mill reasons (the approach of
// Clear Skies' Papermill Alarm in the STM Integrity Hub). Two TF-IDF indexes over the Retraction Watch paper-mill
// retractions, built once a day per process:
//   titles     - every retraction's title (words)                                       -> titleLookalikes()
//   abstracts  - title + OpenAlex abstract (words and two-word phrases), where the file
//                DATA_DIR/papermill/mill-abstracts.json.gz exists (scripts/load-mill-abstracts.js) -> abstractLookalikes()
// The abstract index has ~2.5 million weighted terms, so it is kept in typed arrays (term hashes sorted, ~30 MB) rather
// than in Maps (~600 MB). Scores are the same cosine as in the benchmark (docs/benchmark-papermill-notes.md).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../db');
const D = require('../datasets');
const cfg = require('../config');

const DAY = 24 * 3600e3;
const ABSTRACTS = 'papermill/mill-abstracts.json.gz';
const normTitle = t => String(t || '').toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const tokens = t => require('../checks/novelty').tokens(t);
const terms = t => { const w = tokens(t); return [...w, ...w.slice(1).map((x, i) => `${w[i]}_${x}`)]; };
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };

let rowsCache = null;
async function millRows() {
  if (rowsCache && Date.now() - rowsCache.at < DAY) return rowsCache.rows;
  const rows = await db.all(`SELECT doi, title, journal, retraction_date, reason FROM retractions WHERE nature ILIKE '%retraction%' AND title IS NOT NULL AND title <> '' AND reason ~* $1`, [D.MILL_REASON]);
  for (const r of rows) r.doi = String(r.doi || '').toLowerCase().trim();
  rowsCache = { at: Date.now(), rows };
  return rows;
}

const evidenceOf = (r, similarity) => ({ score: similarity, similarity: Math.round(similarity * 100) / 100, title: r.title, journal: r.journal, date: r.retraction_date, doi: r.doi || null,
  reason: String(r.reason || '').split(';').filter(x => D.MILL_REASON_RE.test(x)).slice(0, 2).join('; ') });
const notSelf = (r, own, doi) => normTitle(r.title) !== own && !(doi && r.doi === String(doi).toLowerCase());

// ------------------------------------------------------------------ titles (small: Maps)

let titleIx = null;
async function titleIndex() {
  if (titleIx && Date.now() - titleIx.at < DAY) return titleIx;
  const rows = await millRows();
  const docs = rows.map(r => tokens(r.title));
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const n = docs.length;
  const vec = d => {
    const tf = new Map();
    for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
    const v = new Map();
    let norm = 0;
    for (const [w, c] of tf) { const x = (1 + Math.log(c)) * Math.log(1 + (n + 1) / ((df.get(w) || 0) + 1)); v.set(w, x); norm += x * x; }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  };
  const posting = new Map();
  const vecs = docs.map((d, i) => { const v = vec(d); for (const w of v.keys()) { if (!posting.has(w)) posting.set(w, []); posting.get(w).push(i); } return v; });
  titleIx = { at: Date.now(), rows, vecs, vec, posting };
  return titleIx;
}

/** Mill-retraction titles the manuscript title resembles (cosine >= 0.5), the paper itself left out */
async function titleLookalikes(title, { doi = null } = {}) {
  const ix = await titleIndex();
  const q = ix.vec(tokens(String(title || '').replace(/<[^>]+>/g, ' ')));
  if (q.size < 3 || !ix.rows.length) return [];
  const own = normTitle(title);
  const scores = new Map();
  for (const [w, x] of q) for (const i of ix.posting.get(w) || []) scores.set(i, (scores.get(i) || 0) + x * ix.vecs[i].get(w));
  return [...scores].filter(([i, sc]) => sc >= 0.5 && notSelf(ix.rows[i], own, doi)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([i, sc]) => evidenceOf(ix.rows[i], sc));
}

// ------------------------------------------------------------------ title + abstract (large: typed arrays)

let absIx = null, absLoading = null;

/** Abstracts file -> { rows, hashes (sorted unique term hashes), start, docs, weights } in compressed-sparse-column form */
async function buildAbstractIndex() {
  const file = process.env.MILL_ABSTRACTS_FILE || path.join(cfg.DATA_DIR, ABSTRACTS);
  if (!process.env.MILL_ABSTRACTS_FILE) await require('../datasetStore').ensureLocal('papermill/').catch(() => {});
  let abs;
  try { abs = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch { return null; }
  const rows = (await millRows()).filter(r => r.doi && abs[r.doi]);
  if (!rows.length) return null;
  // per paper: term hashes with their counts
  const per = rows.map(r => {
    const tf = new Map();
    for (const t of terms(`${r.title} ${abs[r.doi]}`)) { const h = fnv(t); tf.set(h, (tf.get(h) || 0) + 1); }
    return tf;
  });
  const df = new Map();
  for (const tf of per) for (const h of tf.keys()) df.set(h, (df.get(h) || 0) + 1);
  const N = per.length;
  const idf = h => Math.log(1 + (N + 1) / ((df.get(h) || 0) + 1));
  // triples (hash, paper, weight) sorted by hash
  let total = 0;
  for (const tf of per) total += tf.size;
  const H = new Uint32Array(total), P = new Int32Array(total), W = new Float32Array(total);
  let k = 0;
  per.forEach((tf, i) => {
    let norm = 0;
    const ws = [];
    for (const [h, c] of tf) { const x = (1 + Math.log(c)) * idf(h); ws.push([h, x]); norm += x * x; }
    norm = Math.sqrt(norm) || 1;
    for (const [h, x] of ws) { H[k] = h; P[k] = i; W[k] = x / norm; k++; }
  });
  const order = new Uint32Array(total).map((_, i) => i).sort((a, b) => H[a] - H[b]);
  const hashes = [], start = [];
  const docs = new Int32Array(total), weights = new Float32Array(total);
  for (let j = 0; j < total; j++) {
    const o = order[j];
    if (!hashes.length || hashes[hashes.length - 1] !== H[o]) { hashes.push(H[o]); start.push(j); }
    docs[j] = P[o]; weights[j] = W[o];
  }
  start.push(total);
  // a term's document frequency is the length of its run, so the df Map is not kept
  return { at: Date.now(), rows, N, hashes: Uint32Array.from(hashes), start: Uint32Array.from(start), docs, weights };
}

async function abstractIndex() {
  if (absIx && Date.now() - absIx.at < DAY) return absIx;
  if (!absLoading) absLoading = buildAbstractIndex().then(ix => { absIx = ix || { at: Date.now(), empty: true }; absLoading = null; return absIx; }, e => { absLoading = null; throw e; });
  return absLoading;
}

function find(hashes, h) {
  let lo = 0, hi = hashes.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (hashes[m] === h) return m; if (hashes[m] < h) lo = m + 1; else hi = m - 1; }
  return -1;
}

/**
 * Mill retractions whose title + abstract the manuscript's title + abstract resembles (cosine >= 0.14).
 * Benchmark (150 mill / 126 ordinary papers, halves by PMC number): >= 0.14 42/150 vs 7/126, >= 0.17 16 vs 3, >= 0.2 8 vs 0.
 * Returns null when the abstracts file is not available (the title index still answers).
 */
async function abstractLookalikes(title, abstract, { doi = null } = {}) {
  const ix = await abstractIndex();
  if (!ix || ix.empty) return null;
  const words = terms(`${title || ''} ${abstract || ''}`);
  if (words.length < 30) return null;   // too little text to compare reliably
  const tf = new Map();
  for (const t of words) { const h = fnv(t); tf.set(h, (tf.get(h) || 0) + 1); }
  const q = [];
  let norm = 0;
  for (const [h, c] of tf) {
    const j = find(ix.hashes, h);
    const x = (1 + Math.log(c)) * Math.log(1 + (ix.N + 1) / ((j < 0 ? 0 : ix.start[j + 1] - ix.start[j]) + 1));
    q.push([j, x]); norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  const scores = new Float64Array(ix.N);
  for (const [j, x] of q) {
    if (j < 0) continue;
    for (let k = ix.start[j]; k < ix.start[j + 1]; k++) scores[ix.docs[k]] += (x / norm) * ix.weights[k];
  }
  const own = normTitle(title);
  const hits = [];
  for (let i = 0; i < ix.N; i++) if (scores[i] >= 0.14 && notSelf(ix.rows[i], own, doi)) hits.push([i, scores[i]]);
  return hits.sort((a, b) => b[1] - a[1]).slice(0, 8).map(([i, sc]) => evidenceOf(ix.rows[i], sc));
}

// ------------------------------------------------------------------ meaning (sentence embeddings)

// every mill retraction with an abstract as a unit vector (int8 x 127) of its title + abstract start, built by
// scripts/build-mill-embeddings.js: a manuscript made from the same template with other genes, drugs or diseases is
// close in meaning even when it shares few words
const MEANING = 'papermill/mill-embeddings';
const meaningText = (title, abs) => `${title || ''}. ${abs || ''}`.replace(/\s+/g, ' ').slice(0, 600);
let meanIx = null, meanLoading = null;
async function meaningIndex() {
  if (meanIx && Date.now() - meanIx.at < DAY) return meanIx.empty ? null : meanIx;
  if (!meanLoading) meanLoading = (async () => {
    await require('../datasetStore').ensureLocal('papermill/').catch(() => {});
    const base = path.join(cfg.DATA_DIR, MEANING);
    let info, buf;
    try { info = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8')); buf = fs.readFileSync(`${base}.bin`); } catch { return { at: Date.now(), empty: true }; }
    const byDoi = new Map((await millRows()).map(r => [r.doi, r]));
    return { at: Date.now(), dim: info.dim, scale: info.scale, vecs: new Int8Array(buf.buffer, buf.byteOffset, buf.length), rows: info.dois.map(d => byDoi.get(d) || { doi: d, title: '' }) };
  })().then(ix => { meanIx = ix; meanLoading = null; return ix; }, e => { meanLoading = null; throw e; });
  const ix = await meanLoading;
  return ix.empty ? null : ix;
}

/** Mill retractions closest in meaning to the manuscript's title + abstract: [{ score (cosine), title, journal, ... }] or null */
async function meaningLookalikes(title, abstract, { doi = null, limit = 8, min = 0.6 } = {}) {
  if (String(abstract || '').split(/\s+/).length < 30) return null;
  const ix = await meaningIndex();
  if (!ix) return null;
  const v = (await require('../tools/embed').embed([meaningText(title, abstract)]).catch(() => null))?.[0];
  if (!v) return null;
  const { dim, scale, vecs, rows } = ix;
  const own = normTitle(title);
  const hits = [];
  for (let i = 0; i < rows.length; i++) {
    let s = 0;
    for (let d = 0, o = i * dim; d < dim; d++) s += v[d] * vecs[o + d];
    s /= scale;
    if (s >= min && notSelf(rows[i], own, doi)) hits.push([i, s]);
  }
  return hits.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([i, sc]) => evidenceOf(rows[i], sc));
}

/** The abstract of a manuscript: the given one, else the text after an "Abstract" heading, else the opening words */
function abstractOf(meta = {}, text = '') {
  if (String(meta.abstract || '').trim().length > 150) return String(meta.abstract);
  const t = String(text || '');
  const m = t.match(/\babstract\b[\s:.\-–—]*([\s\S]{150,3000}?)(?:\n\s*(?:key ?words?|introduction|background|1\.?\s+introduction)\b|$)/i);
  const body = m ? m[1] : t.slice(0, 2500);
  return body.split(/\s+/).slice(0, 350).join(' ');
}

module.exports = { titleLookalikes, abstractLookalikes, meaningLookalikes, meaningIndex, abstractOf, abstractIndex, titleIndex, ABSTRACTS };
