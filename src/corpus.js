// corpus.js - the PJPS text repository, the in-house counterpart of Turnitin's own database. Full texts are kept in
// Cloudflare R2 (corpus/<kind>/<id>.txt.gz); the database holds only a catalogue (corpus_docs) and a fingerprint index
// (corpus_hashes: sampled hashes of 5-word sequences -> document), so the documents sharing text with a manuscript are
// found in one indexed query and only those texts are read from R2.
// It grows with every screening: each manuscript is stored as a PJPS submission, and every source text the similarity
// check downloads (open-access papers, abstracts, web pages) is kept, so the next check finds it without searching again.
// It can also be filled in bulk with open-access papers (scripts/corpus-load.js). Without R2 (the desktop), texts are kept
// in the local database instead.
const zlib = require('zlib');
const db = require('./db');
const cfg = require('./config');
const U = require('./uploads');

const K = 5;          // words per fingerprinted sequence (the similarity check compares in 5-word sequences too)
const SAMPLE = 4;     // keep sequences whose hash is divisible by 4 (about one in four: a copied passage of 25 words leaves ~5)
const MAX_HASHES = 4000;

const norm = w => {
  const x = String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return x.length > 4 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x;
};
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Sampled fingerprints of a text: hashes of 5-word sequences (normalised like the similarity check) */
function fingerprints(text) {
  const w = String(text || '').split(/\s+/).map(norm).filter(Boolean);
  const out = new Set();
  for (let k = 0; k + K <= w.length; k++) {
    const h = fnv(w.slice(k, k + K).join(' '));
    if (h % SAMPLE === 0) out.add(h);
  }
  return [...out].slice(0, MAX_HASHES);
}

const r2 = () => U.enabled() && !cfg.DESKTOP;
const keyOf = (kind, id) => `corpus/${kind}/${id}.txt.gz`;

/**
 * Add a document (idempotent on sourceKey). kind: 'submission' | 'publication' | 'internet'.
 * meta: { manuscriptCode, checkId, journal, year, doi, url, via, scope }. Returns the document id, or null.
 */
async function addDoc({ kind, sourceKey, title, meta = {}, text }) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!sourceKey || body.split(' ').length < 60) return null;
  const known = await db.one('SELECT id, words FROM corpus_docs WHERE source_key = $1', [sourceKey]).catch(() => null);
  // a longer text (full text after an abstract) replaces the shorter one
  if (known && known.words >= body.split(' ').length) return known.id;
  const words = body.split(' ').length;
  const row = known
    ? await db.one('UPDATE corpus_docs SET title = $1, meta = $2, words = $3, updated_at = now() WHERE id = $4 RETURNING id', [String(title || '').slice(0, 500), JSON.stringify(meta), words, known.id])
    : await db.one('INSERT INTO corpus_docs(kind, source_key, title, meta, words) VALUES($1, $2, $3, $4, $5) RETURNING id', [kind, sourceKey, String(title || '').slice(0, 500), JSON.stringify(meta), words]);
  const gz = zlib.gzipSync(body);
  if (r2()) {
    await U.putObject(keyOf(kind, row.id), gz, 'application/gzip');
    await db.query('UPDATE corpus_docs SET r2_key = $1, text = NULL WHERE id = $2', [keyOf(kind, row.id), row.id]);
  } else {
    await db.query('UPDATE corpus_docs SET text = $1 WHERE id = $2', [gz.toString('base64'), row.id]);
  }
  const hashes = fingerprints(body);
  await db.query('DELETE FROM corpus_hashes WHERE doc_id = $1', [row.id]);
  for (let i = 0; i < hashes.length; i += 1000) {
    const part = hashes.slice(i, i + 1000);
    await db.query('INSERT INTO corpus_hashes(h, doc_id) SELECT unnest($1::bigint[]), $2', [part, row.id]);
  }
  return row.id;
}

/** Full text of a repository document (from R2, or the local database) */
async function docText(doc) {
  try {
    if (doc.r2_key) return zlib.gunzipSync(await U.getObject(doc.r2_key)).toString('utf8');
    const row = doc.text !== undefined ? doc : await db.one('SELECT text FROM corpus_docs WHERE id = $1', [doc.id]);
    return row?.text ? zlib.gunzipSync(Buffer.from(row.text, 'base64')).toString('utf8') : '';
  } catch (e) {
    return '';
  }
}

/**
 * Repository documents sharing text with a manuscript: [{ id, kind, title, meta, shared, text }], most shared first.
 * excludeCode: the manuscript's own number (its earlier versions are not counted against it).
 */
async function candidates(text, opts = {}) {
  const hashes = fingerprints(text);
  if (!hashes.length) return [];
  const local = await candidatesByHashes(hashes, opts);
  // the desktop also asks the web platform, which holds the PJPS-wide repository
  if (cfg.DESKTOP) {
    const remote = await require('./desktop').remoteCorpus(hashes, opts).catch(() => []);
    const have = new Set(local.map(d => d.sourceKey));
    return [...local, ...remote.filter(d => !have.has(d.sourceKey))].sort((a, b) => b.shared - a.shared).slice(0, opts.limit || 12);
  }
  return local;
}

/** Repository documents sharing at least minShared of these fingerprints (used directly by the desktop sync API) */
async function candidatesByHashes(hashes, { excludeCode = null, excludeTitle = null, limit = 12, minShared = 2 } = {}) {
  const rows = await db.all(`SELECT d.id, d.kind, d.source_key, d.title, d.meta, d.r2_key, x.shared FROM (
      SELECT doc_id, COUNT(*)::int AS shared FROM corpus_hashes WHERE h = ANY($1::bigint[]) GROUP BY doc_id HAVING COUNT(*) >= $2 ORDER BY COUNT(*) DESC LIMIT $3
    ) x JOIN corpus_docs d ON d.id = x.doc_id ORDER BY x.shared DESC`, [hashes, minShared, limit * 2]).catch(() => []);
  const out = [];
  for (const r of rows) {
    const meta = typeof r.meta === 'string' ? JSON.parse(r.meta || '{}') : r.meta || {};
    if (excludeCode && meta.manuscriptCode && meta.manuscriptCode === excludeCode) continue;
    if (excludeTitle && r.kind === 'submission' && r.title && require('./text').titleSimilarity(excludeTitle, r.title) >= 0.95 && meta.manuscriptCode === excludeCode) continue;
    const t = await docText(r);
    if (t) out.push({ id: r.id, kind: r.kind, sourceKey: r.source_key, title: r.title, meta, shared: r.shared, text: t });
    if (out.length >= limit) break;
  }
  return out;
}

/** Repository size by kind (Admin > Data) */
async function stats() {
  const rows = await db.all('SELECT kind, COUNT(*)::int AS docs, COALESCE(SUM(words), 0)::bigint AS words FROM corpus_docs GROUP BY kind').catch(() => []);
  return Object.fromEntries(rows.map(r => [r.kind, { docs: r.docs, words: Number(r.words) }]));
}

module.exports = { addDoc, docText, candidates, candidatesByHashes, fingerprints, stats, keyOf };
