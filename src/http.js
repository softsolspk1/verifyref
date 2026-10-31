// http.js - polite HTTP client: timeouts, retry on 429/5xx, per-host concurrency, PostgreSQL cache, offline detection
const db = require('./db');
const cfg = require('./config');
const { CONTACT_EMAIL } = cfg;

const USER_AGENT = `PJPSReferenceChecker/2.0 (Softsols Pakistan; mailto:${CONTACT_EMAIL})`;

// Per-host concurrency limits (public APIs ask for politeness)
const HOST_LIMITS = {
  'api.crossref.org': 5,
  'api.openalex.org': 5,
  'eutils.ncbi.nlm.nih.gov': 2,
  'www.ebi.ac.uk': 4,
  'api.semanticscholar.org': 1,
  'export.arxiv.org': 1,
  'dblp.org': 2,
  'openlibrary.org': 2,
  'www.googleapis.com': 1,
  'api.ies.ed.gov': 2,
  'api.datacite.org': 3,
  'doi.org': 5,
  'doaj.org': 2,
  'pub.orcid.org': 3,
  'query.wikidata.org': 2,
  'portal.issn.org': 2,
  'archive.org': 2,
  'pubchem.ncbi.nlm.nih.gov': 4,
  'clinicaltrials.gov': 4,
  'serpapi.com': 2
};
const DEFAULT_LIMIT = 4;
const active = new Map();
const queues = new Map();

function acquire(host) {
  const limit = HOST_LIMITS[host] || DEFAULT_LIMIT;
  const n = active.get(host) || 0;
  if (n < limit) {
    active.set(host, n + 1);
    return Promise.resolve();
  }
  return new Promise(resolve => {
    if (!queues.has(host)) queues.set(host, []);
    queues.get(host).push(resolve);
  });
}

function release(host) {
  const q = queues.get(host);
  if (q && q.length) {
    q.shift()();
  } else {
    active.set(host, Math.max(0, (active.get(host) || 1) - 1));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Connectivity. The desktop edition works offline: once the network is unreachable, requests are answered from
// the cache (or fail immediately) instead of waiting for timeouts and retries; a probe re-checks every 30 s.
const NETWORK_ERRORS = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNRESET|fetch failed|network/i;
let online = true;
let lastProbe = 0;
const listeners = [];
function setOnline(v) {
  if (v === online) return;
  online = v;
  for (const fn of listeners) { try { fn(v); } catch (e) { /* ignore */ } }
}
const isOnline = () => online;
const onConnectivity = fn => listeners.push(fn);
/** Actively test connectivity (cheap request to a highly available host) */
// Testing aid: SIMULATE_OFFLINE=1 makes the desktop behave as if the network were down
const simulatedOffline = () => cfg.DESKTOP && process.env.SIMULATE_OFFLINE === '1';

async function probe() {
  lastProbe = Date.now();
  if (simulatedOffline()) { setOnline(false); return false; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    await fetch('https://api.crossref.org/', { method: 'HEAD', signal: controller.signal });
    setOnline(true);
  } catch (e) {
    setOnline(false);
  } finally { clearTimeout(timer); }
  return online;
}

// Hosts that rate-limited us: hostname -> time until which they are not called
const cooldown = new Map();

// Two-tier cache: in-process LRU in front of the PostgreSQL cache table
const MEM_MAX = 5000;
const mem = new Map();
function memGet(key) {
  const hit = mem.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { mem.delete(key); return null; }
  mem.delete(key); mem.set(key, hit); // refresh LRU position
  return hit.value;
}
function memSet(key, value, expires) {
  mem.set(key, { value, expires });
  if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
}

// With Cloudflare R2 a response of CACHE_R2_MIN bytes or more is kept on R2 (gzipped) and the row holds only
// { "__r2": "<object key>" }; smaller ones stay in the row, where they are read fastest. Without R2 (desktop) every
// response stays in the row.
const zlib = require('zlib');
const CACHE_R2_MIN = 2048;
const r2 = () => require('./uploads');
const cacheObjectKey = key => { const h = require('crypto').createHash('sha256').update(key).digest('hex'); return `cache/${h.slice(0, 2)}/${h}.json.gz`; };

async function cacheGet(key) {
  const m = memGet(key);
  if (m) return m;
  try {
    const row = await db.one('SELECT value, expires_at FROM cache WHERE key = $1', [key]);
    if (row && Number(row.expires_at) > Date.now()) {
      const value = row.value?.__r2 ? JSON.parse(zlib.gunzipSync(await r2().getObject(row.value.__r2)).toString('utf8')) : row.value;
      memSet(key, value, Number(row.expires_at));
      return value;
    }
  } catch (e) { /* cache is best-effort: a missing R2 object is a cache miss */ }
  return null;
}
function cacheSet(key, value, expires) {
  memSet(key, value, expires);
  const json = JSON.stringify(value);
  const save = v => db.query('INSERT INTO cache(key, value, expires_at) VALUES($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at', [key, v, expires]);
  if (json.length >= CACHE_R2_MIN && r2().enabled()) {
    const objectKey = cacheObjectKey(key);
    r2().putObject(objectKey, zlib.gzipSync(json), 'application/gzip').then(() => save(JSON.stringify({ __r2: objectKey }))).catch(() => save(json).catch(() => {}));
  } else save(json).catch(() => {});
}

/** Expired rows go, with their R2 objects */
async function purgeCache() {
  const now = Date.now();
  if (r2().enabled()) {
    const gone = await db.all("SELECT value->>'__r2' AS k FROM cache WHERE expires_at < $1 AND value ? '__r2' LIMIT 5000", [now]);
    for (const g of gone) await r2().deleteObject(g.k);
  }
  await db.query('DELETE FROM cache WHERE expires_at < $1', [now]);
}

/**
 * Fetch a URL. Returns { ok, status, data, text, error, url }.
 * options: { json=true, headers, method, timeout, ttl (seconds, 0 = no cache), retries, body, redirect }
 */
async function request(url, options = {}) {
  const {
    json = true,
    headers = {},
    method = 'GET',
    timeout = 15000,
    ttl = 7 * 24 * 3600,
    retries = 2,
    body,
    redirect = 'follow'
  } = options;

  const cacheKey = method === 'GET' && ttl > 0 ? `${json ? 'j' : 't'}:${url}` : null;
  if (cacheKey) {
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;
  }

  if (simulatedOffline()) { setOnline(false); return { ok: false, status: 0, error: 'offline', offline: true }; }
  if (cfg.DESKTOP && !online) {
    if (Date.now() - lastProbe < 30000 || !(await probe())) return { ok: false, status: 0, error: 'offline', offline: true };
  }

  const host = new URL(url).hostname;
  // A host that keeps answering "too many requests" is skipped for a while instead of retried for every lookup
  const cool = cooldown.get(host);
  if (cool && cool > Date.now()) return { ok: false, status: 429, error: 'rate-limited (cooling down)' };
  let attempt = 0;
  let result;
  while (true) {
    await acquire(host);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect,
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: json ? 'application/json' : '*/*',
          ...headers
        }
      });
      const text = method === 'HEAD' ? '' : await res.text();
      result = { ok: res.ok, status: res.status, url: res.url, headers: Object.fromEntries(res.headers) };
      if (!online) setOnline(true);
      if (json && res.ok) {
        try { result.data = JSON.parse(text); } catch (e) { result.ok = false; result.error = 'Invalid JSON'; }
      } else {
        result.text = text;
      }
    } catch (err) {
      const detail = `${err.message} ${err.cause?.code || ''} ${err.cause?.message || ''}`;
      result = { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
      if (cfg.DESKTOP && err.name !== 'AbortError' && NETWORK_ERRORS.test(detail) && !(await probe())) {
        return { ok: false, status: 0, error: 'offline', offline: true };
      }
    } finally {
      clearTimeout(timer);
      release(host);
    }

    const retryable = result.status === 429 || result.status >= 500 || result.status === 0;
    if (!retryable || attempt >= retries) break;
    attempt++;
    const retryAfter = parseInt(result.headers?.['retry-after'] || '0', 10);
    await sleep(Math.min(retryAfter > 0 ? retryAfter * 1000 : 800 * 2 ** attempt, 8000));
  }

  if (result.status === 429) {
    const after = parseInt(result.headers?.['retry-after'] || '0', 10);
    cooldown.set(host, Date.now() + Math.min(Math.max(after * 1000, 3 * 60000), 15 * 60000));
  } else if (result.ok) cooldown.delete(host);

  // Cache successes and definitive "not found" answers, never transient errors
  if (cacheKey && (result.ok || result.status === 404)) {
    const stored = { ...result };
    delete stored.headers;
    if (!json && stored.text && stored.text.length > 500000) stored.text = stored.text.slice(0, 500000);
    cacheSet(cacheKey, stored, Date.now() + ttl * 1000);
  }
  return result;
}

const getJson = (url, opts) => request(url, { ...opts, json: true });
const getText = (url, opts) => request(url, { ...opts, json: false });

async function getBuffer(url, options = {}) {
  const { headers = {}, timeout = 60000 } = options;
  const host = new URL(url).hostname;
  await acquire(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
        ...headers
      }
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const ab = await res.arrayBuffer();
    return { ok: true, status: res.status, buffer: Buffer.from(ab) };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
    release(host);
  }
}

// Purge expired cache rows occasionally
setInterval(() => { purgeCache().catch(() => {}); }, 6 * 3600 * 1000).unref();

module.exports = { request, getJson, getText, getBuffer, USER_AGENT, sleep, isOnline, onConnectivity, probe, cacheGet, cacheSet, purgeCache, cacheObjectKey, CACHE_R2_MIN };
