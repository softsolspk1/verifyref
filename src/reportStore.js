// reportStore.js - saved reports on Cloudflare R2. The full result of every saved check is kept in R2
// (reports/<id>.json.gz); the database row keeps a small stub - kind, meta, summary, risk level and the R2 key - so lists,
// dashboards and SQL that read the level keep working, and the full report is read from R2 when it is opened, exported
// or rescreened. Without R2 (the desktop, a local install) the full result stays in the database as before.
const zlib = require('zlib');
const db = require('./db');
const cfg = require('./config');
const U = require('./uploads');

const STUB_KEYS = ['kind', 'module', 'version', 'meta', 'summary', 'risk', 'createdAt', 'recommendation', 'recommendationLabel', 'lines'];
const onR2 = () => U.enabled() && !cfg.DESKTOP;
const keyOf = id => `reports/${id}.json.gz`;

// recently read reports, so a report opened and then exported is fetched from R2 once
const cache = new Map();
const CACHE_MAX = 30;
const remember = (key, value) => { cache.delete(key); cache.set(key, value); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); };

/** The small part kept in the database: enough for lists, dashboards and SQL on the risk level */
function stub(result, key) {
  const out = { _r2: key };
  for (const k of STUB_KEYS) if (result[k] !== undefined) out[k] = result[k];
  if (out.summary && typeof out.summary === 'object') out.summary = JSON.parse(JSON.stringify(out.summary));
  // the daily retraction monitor reads only these (reference number, DOI, text) and never fetches the full report
  const refs = result.references?.results;
  if (Array.isArray(refs)) out.refDois = refs.map(r => ({ index: r.index, doi: (r.record?.doi || r.parsed?.doi || '').toLowerCase(), raw: String(r.raw || '').slice(0, 300), retracted: r.status === 'retracted' })).filter(r => r.doi);
  return out;
}

/**
 * Move a saved check's result to R2 (call after every write of checks.result). result: the full result object.
 * Returns the R2 key, or null when the result stays in the database.
 */
async function offload(checkId, result) {
  if (!checkId || !result || !onR2()) return null;
  const full = { ...result };
  delete full.id; delete full.issueId;
  const key = keyOf(checkId);
  await U.putObject(key, zlib.gzipSync(JSON.stringify(full)), 'application/gzip');
  remember(key, full);
  await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(stub(full, key)), checkId]);
  return key;
}

/** The full result of a row's result column: read from R2 when the database holds a stub */
async function load(result) {
  if (!result || typeof result !== 'object' || !result._r2) return result || null;
  const key = result._r2;
  if (cache.has(key)) return JSON.parse(JSON.stringify(cache.get(key)));
  try {
    const full = JSON.parse(zlib.gunzipSync(await U.getObject(key)).toString('utf8'));
    remember(key, full);
    return JSON.parse(JSON.stringify(full));
  } catch (e) {
    // R2 unreachable: the stub still carries the summary, marked so the caller can say the full report is unavailable
    return { ...result, _unavailable: `The full report could not be read from storage (${e.message}).` };
  }
}

/** Fill the result column of rows (in place) from R2 */
async function loadRows(rows) {
  for (const r of rows || []) if (r?.result?._r2) r.result = await load(r.result);
  return rows;
}

const isStub = result => !!(result && typeof result === 'object' && result._r2);

module.exports = { offload, load, loadRows, isStub, stub, keyOf };
