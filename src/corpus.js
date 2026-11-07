// corpus.js - the PJPS text repository, the in-house counterpart of Turnitin's own database. Full texts are kept in
// Cloudflare R2 (corpus/<kind>/<id>.txt.gz); the database holds only a catalogue (corpus_docs). The fingerprint index
// (sampled hashes of 5-word sequences -> document) is on R2 too (bulk/corpus, the layout of src/corpusBulk.js): new
// documents' fingerprints wait in corpus_hashes and the daily cron moves them into the R2 index (compactIndex), so the
// database stays small. A lookup reads both, and only the texts of the documents found are read from R2.
// It holds published texts only: every source text the similarity check downloads (open-access papers, abstracts, web
// pages) is kept, so the next check finds it without searching again. Manuscripts are never stored (no repository, as
// Turnitin's setting for unpublished work).
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
  const pending = await db.all(`SELECT doc_id, COUNT(*)::int AS shared FROM corpus_hashes WHERE h = ANY($1::bigint[])
    GROUP BY doc_id HAVING COUNT(*) >= $2 ORDER BY COUNT(*) DESC LIMIT $3`, [hashes, minShared, limit * 2]).catch(() => []);
  const shared = new Map(await indexMatches(hashes, minShared));
  // a document re-indexed since the last move to R2 (a full text after its abstract) counts by its rows in the database
  const both = [...shared.keys()];
  if (both.length) for (const r of await db.all('SELECT DISTINCT doc_id FROM corpus_hashes WHERE doc_id = ANY($1::int[])', [both]).catch(() => [])) shared.delete(r.doc_id);
  for (const p of pending) shared.set(p.doc_id, p.shared);
  const top = [...shared].sort((a, b) => b[1] - a[1]).slice(0, limit * 2);
  const docs = top.length ? await db.all('SELECT id, kind, source_key, title, meta, r2_key FROM corpus_docs WHERE id = ANY($1::int[])', [top.map(t => t[0])]).catch(() => []) : [];
  const byId = new Map(docs.map(d => [d.id, d]));
  const rows = top.filter(([id]) => byId.has(id)).map(([id, n]) => ({ ...byId.get(id), shared: n }));
  const kept = [];
  for (const r of rows) {
    const meta = typeof r.meta === 'string' ? JSON.parse(r.meta || '{}') : r.meta || {};
    if (excludeCode && meta.manuscriptCode && meta.manuscriptCode === excludeCode) continue;
    if (excludeTitle && r.kind === 'submission' && r.title && require('./text').titleSimilarity(excludeTitle, r.title) >= 0.95 && meta.manuscriptCode === excludeCode) continue;
    kept.push({ r, meta });
  }
  // the texts (on R2) are read 6 at a time, not one after another; the order (most shared fingerprints first) is kept
  const texts = new Array(kept.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, kept.length) }, async () => { while (next < kept.length) { const i = next++; texts[i] = await docText(kept[i].r).catch(() => null); } }));
  const out = [];
  kept.forEach(({ r, meta }, i) => { if (texts[i] && out.length < limit) out.push({ id: r.id, kind: r.kind, sourceKey: r.source_key, title: r.title, meta, shared: r.shared, text: texts[i] }); });
  // the bulk repository on R2 (PubMed Central open-access full texts, src/corpusBulk.js); a paper kept in both counts once
  const bulk = await require('./corpusBulk').candidatesByHashes(hashes, { limit, skipKeys: new Set(out.map(d => d.sourceKey)) }).catch(() => []);
  return bulk.length ? [...out, ...bulk].sort((a, b) => b.shared - a.shared).slice(0, limit) : out;
}

// ------------------------------------------------------------------ the fingerprint index on R2 (bulk/corpus)

const INDEX = 'corpus';

/** [[doc id, shared fingerprints]] from the R2 index (web platform only) */
async function indexMatches(hashes, minShared) {
  if (!r2()) return [];
  const B = require('./corpusBulk');
  const m = await B.getManifest(INDEX).catch(() => null);
  if (!m?.version || !m.entries) return [];
  const counts = await B.countShared(INDEX, m, hashes.map(h => Number(h) >>> 0), Date.now() + 20000).catch(() => new Map());
  return [...counts].filter(([, n]) => n >= minShared);
}

/**
 * Move the fingerprints waiting in corpus_hashes into the R2 index (daily cron; scripts/corpus-compact.js for the first,
 * large move). Builds a new index version from the current one plus the waiting rows, publishes its manifest, then
 * removes the rows moved. Documents changed in the last 10 minutes wait for the next run (their rows may still be
 * being written). Keeps the previous version for readers that still hold its manifest.
 */
async function compactIndex({ log = () => {} } = {}) {
  if (!r2()) return { skipped: 'no R2' };
  const B = require('./corpusBulk');
  const { cut } = await db.one("SELECT now() - interval '10 minutes' AS cut");
  const ready = (await db.all(`SELECT id FROM corpus_docs d WHERE updated_at < $1
    AND EXISTS (SELECT 1 FROM corpus_hashes h WHERE h.doc_id = d.id)`, [cut])).map(r => r.id);
  if (!ready.length) return { moved: 0 };
  const moving = new Set(ready);
  const live = new Set((await db.all('SELECT id FROM corpus_docs')).map(r => r.id));
  const old = await B.getManifest(INDEX, { fresh: true });
  const byFile = Array.from({ length: B.FILES }, () => []);
  // the current index, without the documents re-indexed now and those removed from the repository
  if (old?.version) {
    await pool(Array.from({ length: B.FILES }, (_, f) => f), 32, async f => {
      const b = await U.getObject(B.idxKey(INDEX, old.version, f));
      if (!b) throw new Error(`index file ${f} of version ${old.version} is missing`);
      const u = new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
      for (let i = B.SHARDS + 1; i + 1 < u.length; i += 2) if (live.has(u[i + 1]) && !moving.has(u[i + 1])) byFile[f].push(u[i], u[i + 1]);
    });
  }
  log(`Index version ${old?.version || 'none'} read; adding ${ready.length.toLocaleString('en')} documents`);
  for (let i = 0; i < ready.length; i += 200) {
    const rows = await db.all('SELECT h, doc_id FROM corpus_hashes WHERE doc_id = ANY($1::int[])', [ready.slice(i, i + 200)]);
    for (const r of rows) { const h = Number(r.h) >>> 0; byFile[B.fileOf(h)].push(h, r.doc_id); }
  }
  const version = Date.now();
  let entries = 0, bytes = 0;
  const docs = new Set();
  await pool(Array.from({ length: B.FILES }, (_, f) => f), 8, async f => {
    const pairs = byFile[f];
    for (let i = 1; i < pairs.length; i += 2) docs.add(pairs[i]);
    const out = B.buildIndexFile(pairs);
    byFile[f] = null;
    entries += pairs.length / 2;
    bytes += out.length;
    for (let attempt = 0; ; attempt++) {
      try { await U.putObject(B.idxKey(INDEX, version, f), out, 'application/octet-stream'); break; }
      catch (e) { if (attempt >= 3) throw e; await new Promise(r => setTimeout(r, 3000)); }
    }
  });
  const manifest = { version, prev: old?.version || null, docs: docs.size, entries, bytes, builtAt: new Date().toISOString(), source: 'PJPS text repository (corpus_docs)' };
  await U.putObject(`${B.prefix(INDEX)}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 1)), 'application/json');
  await B.getManifest(INDEX, { fresh: true });   // this instance reads the new version at once
  log(`Published index version ${version}: ${docs.size.toLocaleString('en')} documents, ${entries.toLocaleString('en')} entries`);
  // a document re-indexed while this ran keeps its new rows (the next run moves them)
  for (let i = 0; i < ready.length; i += 200) {
    await db.query(`DELETE FROM corpus_hashes WHERE doc_id = ANY($1::int[]) AND doc_id IN (SELECT id FROM corpus_docs WHERE updated_at < $2)`, [ready.slice(i, i + 200), cut]);
  }
  // the version before the previous one is no longer read by anyone
  if (old?.prev) await pool(Array.from({ length: B.FILES }, (_, f) => f), 16, f => U.deleteObject(B.idxKey(INDEX, old.prev, f)));
  return { moved: ready.length, docs: docs.size, entries, version };
}

async function pool(items, n, fn) {
  let next = 0, failed = null;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length && !failed) { const i = next++; try { await fn(items[i]); } catch (e) { failed = e; } }
  }));
  if (failed) throw failed;
}

/** Repository size by kind (Admin > Data) */
async function stats() {
  const rows = await db.all('SELECT kind, COUNT(*)::int AS docs, COALESCE(SUM(words), 0)::bigint AS words FROM corpus_docs GROUP BY kind').catch(() => []);
  const out = Object.fromEntries(rows.map(r => [r.kind, { docs: r.docs, words: Number(r.words) }]));
  const bulk = await require('./corpusBulk').stats().catch(() => null);
  if (bulk?.docs) out.bulkPmc = { docs: bulk.docs, builtAt: bulk.builtAt };
  return out;
}

module.exports = { addDoc, docText, candidates, candidatesByHashes, compactIndex, fingerprints, stats, keyOf };
