// corpusBulk.js - the bulk part of the PJPS text repository: open-access full texts loaded in bulk (PubMed Central,
// scripts/corpus-load-pmc.js), millions of documents, kept entirely on Cloudflare R2 so the database stays small.
// The documents that share text with a manuscript are found the same way as in corpus.js (sampled 5-word hashes), but
// from a static index on R2 read with byte-range requests: a lookup downloads only a few KB per hash.
//
// Layout on R2 (prefix bulk/<name>/):
//   manifest.json            { version, docs, entries, packs, builtAt } - the index version readers use
//   idx/v<version>/f<ff>.bin 256 index files. A hash h (kept when h % 16 == 0) has k = h >>> 4; file = k >>> 20,
//                            shard = (k >>> 8) & 0xfff. Each file: 4097 little-endian uint32 offsets (in entries) of
//                            its 4096 shards, then the entries (uint32 hash, uint32 document id) sorted by hash.
//   text/p<pack>.bin         1,000 documents per pack (id = pack * 1000 + n), each a gzip member, concatenated
//   cat/p<pack>.json         [{ id, key, title, journal, year, doi, license, off, len }] - where each text is in the pack
// Documents are published texts only (open access, licence kept); manuscripts are never stored here.
const zlib = require('zlib');
const cfg = require('./config');
const U = require('./uploads');

const SAMPLE = 16;                 // a bulk hash is one of corpus.js's hashes (h % 4 == 0) with h % 16 == 0
const FILES = 256, SHARDS = 4096;
const HEADER = (SHARDS + 1) * 4;
const PACK = 1000;
const NAME = 'pmc';
const prefix = (name = NAME) => `bulk/${name}`;

const fileOf = h => (h >>> 4) >>> 20;
const shardOf = h => ((h >>> 4) >>> 8) & 0xfff;
const packOf = id => Math.floor(id / PACK);

const enabled = () => U.enabled() && !cfg.DESKTOP;

// ------------------------------------------------------------------ reading (the web platform)

const manifests = new Map();    // name -> { m, at }
const headers = new Map();      // `${name}/${version}/${file}` -> Uint32Array of shard offsets
const wholes = new Map();       // name -> { version, files: Promise<Uint32Array[]> } (a small index read in full)
const cats = new Map();         // pack -> catalogue (most recently used kept)
// an index up to this size (the fingerprint index of corpus.js, bulk/corpus) is read whole once and kept in memory:
// a manuscript's ~4,000 hashes would otherwise be ~4,000 range requests
const WHOLE_MAX = 96 * 1024 * 1024;

const idxKey = (name, version, f) => `${prefix(name)}/idx/v${version}/f${f.toString(16).padStart(2, '0')}.bin`;

async function getManifest(name = NAME, { fresh = false } = {}) {
  // kept 10 minutes (also "no bulk repository yet", so a missing manifest is not asked for on every check)
  const c = manifests.get(name);
  if (!fresh && c && Date.now() - c.at < 10 * 60000) return c.m;
  let m = null;
  try { m = JSON.parse((await U.getObject(`${prefix(name)}/manifest.json`)).toString('utf8')); } catch (e) { m = null; }
  manifests.set(name, { m, at: Date.now() });
  return m;
}

async function header(name, version, f) {
  const k = `${name}/${version}/${f}`;
  if (headers.has(k)) return headers.get(k);
  const b = await U.getObjectRange(idxKey(name, version, f), 0, HEADER - 1);
  const off = b && b.length === HEADER ? new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + HEADER)) : null;
  headers.set(k, off);
  return off;
}

/** The 256 files of a small index, read once per version: Uint32Array each (shard offsets, then the entries) */
function wholeIndex(name, version) {
  const w = wholes.get(name);
  if (w && w.version === version) return w.files;
  const files = pool(Array.from({ length: FILES }, (_, f) => f), 32, async f => {
    const b = await U.getObject(idxKey(name, version, f));
    return b && b.length >= HEADER ? new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4))) : null;
  });
  wholes.set(name, { version, files });
  files.catch(() => wholes.delete(name));
  return files;
}

/** Index entries per document id for these hashes: Map(id -> number of the hashes it shares) */
async function countShared(name, m, want, until = Infinity) {
  const wanted = new Set(want);
  const counts = new Map();
  const tally = v => { for (let i = 0; i + 1 < v.length; i += 2) if (wanted.has(v[i])) counts.set(v[i + 1], (counts.get(v[i + 1]) || 0) + 1); };
  // shards to read, one range request each (or a slice of the index kept in memory)
  const byShard = new Map();
  for (const h of wanted) { const k = `${fileOf(h)}:${shardOf(h)}`; if (!byShard.has(k)) byShard.set(k, { f: fileOf(h), s: shardOf(h) }); }
  const shards = [...byShard.values()];
  if (m.bytes && m.bytes <= WHOLE_MAX) {
    const files = await wholeIndex(name, m.version);
    for (const { f, s } of shards) {
      const u = files[f];
      if (u) tally(u.subarray(SHARDS + 1 + u[s] * 2, SHARDS + 1 + u[s + 1] * 2));
    }
    return counts;
  }
  await pool([...new Set(shards.map(x => x.f))], 16, f => header(name, m.version, f));
  await pool(shards, 24, async ({ f, s }) => {
    if (Date.now() > until) return;
    const off = headers.get(`${name}/${m.version}/${f}`);
    if (!off || off[s + 1] <= off[s]) return;
    const b = await U.getObjectRange(idxKey(name, m.version, f), HEADER + off[s] * 8, HEADER + off[s + 1] * 8 - 1);
    if (b) tally(new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
  });
  return counts;
}

async function catalogue(pack) {
  if (cats.has(pack)) return cats.get(pack);
  const raw = await U.getObject(`${prefix()}/cat/p${pack}.json`).catch(() => null);
  const list = raw ? JSON.parse(raw.toString('utf8')) : [];
  const byId = new Map(list.map(d => [d.id, d]));
  if (cats.size > 200) cats.delete(cats.keys().next().value);
  cats.set(pack, byId);
  return byId;
}

/** Text of one bulk document */
async function docText(d) {
  const b = await U.getObjectRange(`${prefix()}/text/p${packOf(d.id)}.bin`, d.off, d.off + d.len - 1);
  return b ? zlib.gunzipSync(b).toString('utf8') : '';
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]).catch(() => null); } }));
  return out;
}

/**
 * Bulk documents sharing at least minShared sampled hashes with these (corpus.js) fingerprints:
 * [{ id, kind, sourceKey, title, meta, shared, text }], most shared first. shared is scaled to corpus.js's sampling
 * (one hash in four), so the two lists can be merged. Stops looking after budgetMs.
 */
async function candidatesByHashes(hashes, { limit = 12, minShared = 2, budgetMs = 20000, skipKeys = new Set() } = {}) {
  if (!enabled()) return [];
  const m = await getManifest();
  if (!m?.version || !m.entries) return [];
  const until = Date.now() + budgetMs;
  const want = [...new Set(hashes.map(h => h >>> 0).filter(h => h % SAMPLE === 0))];
  if (want.length < minShared) return [];
  const counts = await countShared(NAME, m, want, until);
  const top = [...counts].filter(([, n]) => n >= minShared).sort((a, b) => b[1] - a[1]).slice(0, limit * 2);
  const found = await pool(top, 6, async ([id, n]) => {
    if (Date.now() > until + 5000) return null;
    const d = (await catalogue(packOf(id))).get(id);
    if (!d || skipKeys.has(d.key)) return null;
    const text = await docText(d);
    if (!text) return null;
    return { id: `bulk:${id}`, kind: 'publication', sourceKey: d.key, title: d.title, shared: n * (SAMPLE / 4), text,
      meta: { journal: d.journal || null, year: d.year || null, doi: d.doi || null, url: d.url || null, license: d.license || null, via: 'PubMed Central (bulk)', scope: 'full text', withRefs: true } };
  });
  return found.filter(Boolean).slice(0, limit);
}

/** Size of the bulk repository (Admin > Data, similarity report) */
async function stats() {
  const m = enabled() ? await getManifest() : null;
  return m ? { docs: m.docs, entries: m.entries, builtAt: m.builtAt } : null;
}

// ------------------------------------------------------------------ writing (scripts/corpus-load-pmc.js)

const norm = w => {
  const x = String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return x.length > 4 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x;
};
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** Bulk hashes of a text: corpus.js's 5-word hashes kept one in sixteen, no cap */
function bulkHashes(text) {
  const w = String(text || '').split(/\s+/).map(norm).filter(Boolean);
  const out = new Set();
  for (let k = 0; k + 5 <= w.length; k++) { const h = fnv(w.slice(k, k + 5).join(' ')); if (h % SAMPLE === 0) out.add(h); }
  return [...out];
}

/** One index file from its (hash, id) pairs: header of shard offsets + sorted entries */
function buildIndexFile(pairs) {
  const n = pairs.length / 2;
  const keys = new BigUint64Array(n);
  for (let i = 0; i < n; i++) keys[i] = (BigInt(pairs[2 * i]) << 32n) | BigInt(pairs[2 * i + 1]);
  keys.sort();
  const out = Buffer.alloc(HEADER + n * 8);
  const off = new Uint32Array(SHARDS + 1);
  const ent = new Uint32Array(n * 2);
  let last = -1;
  for (let i = 0; i < n; i++) {
    const h = Number(keys[i] >> 32n);
    ent[2 * i] = h; ent[2 * i + 1] = Number(keys[i] & 0xffffffffn);
    const s = shardOf(h);
    while (last < s) off[++last] = i;
  }
  while (last < SHARDS) off[++last] = n;
  Buffer.from(off.buffer).copy(out, 0);
  Buffer.from(ent.buffer).copy(out, HEADER);
  return out;
}

module.exports = { candidatesByHashes, countShared, docText, stats, getManifest, idxKey, bulkHashes, buildIndexFile, fileOf, shardOf, packOf, prefix, PACK, FILES, SHARDS, HEADER, SAMPLE, enabled };
