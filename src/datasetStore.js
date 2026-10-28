// datasetStore.js - every dataset kept on Cloudflare R2 under "datasets/":
//   files/<path>   mirror of the DATA_DIR folder (journal lists, ImageTwin / Proofig knowledge base, public image data,
//                  ICLAC register, Problematic Paper Screener exports, benchmark files) - scripts/sync-datasets-r2.js
//   raw/<name>     the last good download of every refreshable dataset (Retraction Watch, DOAJ, NLM Catalog ...):
//                  written after each refresh, read back when the source site is down
//   lists/<type>   journal index lists uploaded on Admin > Data
// The dataset_files table is the catalogue (size, SHA-256, date). On Vercel the code has no data folder, so the files a
// module needs are copied from R2 into DATA_DIR (/tmp) on first use - ensureLocal().
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');
const R2 = require('./uploads');

const PREFIX = 'datasets/';
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const enabled = () => R2.enabled();

const TYPES = { csv: 'text/csv', json: 'application/json', md: 'text/markdown', txt: 'text/plain', zip: 'application/zip', pdf: 'application/pdf', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', html: 'text/html', jpg: 'image/jpeg', png: 'image/png' };
const typeOf = name => TYPES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

/** Store a dataset file on R2 (skipped when the same content is already there). Returns { stored, size } */
async function put(name, data, { source = null, contentType = null } = {}) {
  if (!enabled()) return { stored: false, reason: 'R2 not configured' };
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const sum = sha256(buf);
  const prev = await db.one('SELECT sha256 FROM dataset_files WHERE name = $1', [name]);
  if (prev?.sha256 === sum) return { stored: false, unchanged: true, size: buf.length };
  await R2.putObject(PREFIX + name, buf, contentType || typeOf(name));
  await db.query(`INSERT INTO dataset_files(name, size, sha256, content_type, source, updated_at) VALUES($1, $2, $3, $4, $5, now())
    ON CONFLICT(name) DO UPDATE SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256, content_type = EXCLUDED.content_type, source = COALESCE(EXCLUDED.source, dataset_files.source), updated_at = now()`,
  [name, buf.length, sum, contentType || typeOf(name), source]);
  return { stored: true, size: buf.length };
}

/** Read a dataset file from R2: Buffer, or null when it is not stored / R2 is not configured */
async function get(name) {
  if (!enabled()) return null;
  const res = await fetch(R2.presign('GET', PREFIX + name)).catch(() => null);
  if (!res || !res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function remove(name) {
  await R2.deleteObject(PREFIX + name);
  await db.query('DELETE FROM dataset_files WHERE name = $1', [name]);
}

async function list() {
  return db.all('SELECT name, size, sha256, content_type, source, updated_at FROM dataset_files ORDER BY name');
}

/**
 * Text of a downloadable dataset with an R2 safety copy: download() -> { ok, text } as from http.getText.
 * A good download is saved to raw/<name>; a failed one falls back to the saved copy (and says so in the log).
 */
async function sourceText(name, download, { log = console.log } = {}) {
  const r = await download().catch(e => ({ ok: false, error: e.message }));
  if (r.ok && r.text) {
    await put(`raw/${name}`, r.text, { source: 'download' }).catch(e => log(`R2 copy of ${name} failed: ${e.message}`));
    return r.text;
  }
  const saved = await get(`raw/${name}`).catch(() => null);
  if (saved) { log(`${name}: source unavailable (${r.status || r.error}), using the copy saved on R2`); return saved.toString('utf8'); }
  throw new Error(`${name} download failed (${r.status || r.error})`);
}

/** Same for binary downloads (download() -> { ok, buffer }) */
async function sourceBuffer(name, download, { log = console.log } = {}) {
  const r = await download().catch(e => ({ ok: false, error: e.message }));
  if (r.ok && r.buffer) {
    await put(`raw/${name}`, r.buffer, { source: 'download' }).catch(e => log(`R2 copy of ${name} failed: ${e.message}`));
    return r.buffer;
  }
  const saved = await get(`raw/${name}`).catch(() => null);
  if (saved) { log(`${name}: source unavailable (${r.status || r.error}), using the copy saved on R2`); return saved; }
  throw new Error(`${name} download failed (${r.status || r.error})`);
}

// ------------------------------------------------------------------ data folder mirror

const localPath = rel => path.join(cfg.DATA_DIR, ...rel.split('/'));
const walk = (dir, base = '') => {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
    else if (!e.name.startsWith('.')) out.push(rel);
  }
  return out;
};

const hashFile = file => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});

/** Store a local file on R2, streamed (no copy in memory); skipped when the same content is already there */
async function putFile(name, file, { source = null } = {}) {
  if (!enabled()) return { stored: false, reason: 'R2 not configured' };
  const size = fs.statSync(file).size;
  if (size < 20e6) return put(name, fs.readFileSync(file), { source });
  const sum = await hashFile(file);
  const prev = await db.one('SELECT sha256 FROM dataset_files WHERE name = $1', [name]);
  if (prev?.sha256 === sum) return { stored: false, unchanged: true, size };
  await R2.putFileStream(PREFIX + name, file, size, typeOf(name));
  await db.query(`INSERT INTO dataset_files(name, size, sha256, content_type, source, updated_at) VALUES($1, $2, $3, $4, $5, now())
    ON CONFLICT(name) DO UPDATE SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256, content_type = EXCLUDED.content_type, source = COALESCE(EXCLUDED.source, dataset_files.source), updated_at = now()`,
  [name, size, sum, typeOf(name), source]);
  return { stored: true, size };
}

/**
 * Folders that are the unpacked copy of an archive stored next to them (e.g. benchmark/biofors/biofors_images = the
 * 47,805 panels inside biofors.tar): the archive is stored, the tens of thousands of loose files are not.
 */
function unpackedCopies(files) {
  const archives = new Set(files.filter(f => /\.(tar|zip|7z|tgz|tar\.gz)$/i.test(f)).map(f => f.replace(/\.(tar\.gz|tgz|tar|zip|7z)$/i, '')));
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const base = dir.replace(/_(images|files|data|extracted)$/i, '');
      if (archives.has(dir) || archives.has(base)) dirs.add(dir);
    }
  }
  return [...dirs];
}

/** Upload every file of DATA_DIR that is new or changed. onFile(rel, result) reports progress. */
async function pushDataDir({ onFile = () => {}, only = null } = {}) {
  if (!enabled()) throw new Error('Cloudflare R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).');
  const all = walk(cfg.DATA_DIR);
  const skip = unpackedCopies(all);
  const files = all.filter(rel => (!only || rel.startsWith(only)) && !skip.some(d => rel.startsWith(`${d}/`)) && !/\.(part|log)$/i.test(rel));
  if (skip.length) onFile(`(skipped unpacked copies of stored archives: ${skip.join(', ')})`, {});
  const out = { files: files.length, stored: 0, unchanged: 0, bytes: 0, errors: [] };
  for (const rel of files) {
    try {
      const r = await putFile(`files/${rel}`, localPath(rel), { source: 'data folder' });
      if (r.stored) { out.stored++; out.bytes += r.size; } else out.unchanged++;
      onFile(rel, r);
    } catch (e) { out.errors.push(`${rel}: ${e.message}`); onFile(rel, { error: e.message }); }
  }
  return out;
}

/** Download the data folder from R2 (files under `prefix`, at most maxBytes each) where the local copy is missing or differs */
async function pullDataDir({ prefix = '', maxBytes = Infinity, onFile = () => {} } = {}) {
  const rows = await db.all("SELECT name, size, sha256 FROM dataset_files WHERE name LIKE 'files/%' ORDER BY name");
  let fetched = 0;
  for (const r of rows) {
    const rel = r.name.slice(6);
    if (!rel.startsWith(prefix) || Number(r.size) > maxBytes) continue;
    const file = localPath(rel);
    try { if (fs.statSync(file).size === Number(r.size)) continue; } catch { /* missing */ }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (Number(r.size) > 20e6) {
      // large archives: streamed to disk
      const res = await fetch(R2.presign('GET', PREFIX + r.name, { expires: 3600 })).catch(() => null);
      if (!res || !res.ok) continue;
      const { Readable } = require('stream');
      await require('stream/promises').pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${file}.part`));
      fs.renameSync(`${file}.part`, file);
    } else {
      const buf = await get(r.name);
      if (!buf) continue;
      fs.writeFileSync(file, buf);
    }
    fetched++;
    onFile(rel, Number(r.size));
  }
  return fetched;
}

const ensured = new Map();
/**
 * Make sure DATA_DIR holds the files below these prefixes (copied from R2 when missing). Runs once per prefix and
 * instance; large archives (> 50 MB) are never copied for a request.
 */
function ensureLocal(prefixes) {
  return Promise.all([].concat(prefixes).map(prefix => {
    if (!ensured.has(prefix)) {
      const p = enabled() ? pullDataDir({ prefix, maxBytes: 50e6 }).catch(e => { ensured.delete(prefix); console.warn(`R2 dataset copy (${prefix}) failed: ${e.message}`); return 0; }) : Promise.resolve(0);
      ensured.set(prefix, p);
    }
    return ensured.get(prefix);
  }));
}

async function status() {
  const s = await db.one('SELECT COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes, MAX(updated_at) AS updated FROM dataset_files');
  const groups = await db.all("SELECT split_part(name, '/', 1) AS area, COUNT(*)::int AS files, COALESCE(SUM(size), 0)::bigint AS bytes, MAX(updated_at) AS updated FROM dataset_files GROUP BY 1 ORDER BY 1");
  return { enabled: enabled(), bucket: cfg.R2.bucket || null, files: s.files, bytes: Number(s.bytes), updated: s.updated, groups: groups.map(g => ({ ...g, bytes: Number(g.bytes) })) };
}

module.exports = { put, putFile, get, remove, list, status, sourceText, sourceBuffer, pushDataDir, pullDataDir, ensureLocal, enabled, PREFIX };
