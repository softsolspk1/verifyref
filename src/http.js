// http.js - polite HTTP client: timeouts, retry on 429/5xx, per-host concurrency, SQLite cache
const db = require('./db');
const { CONTACT_EMAIL } = require('./config');

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
  'archive.org': 2
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

async function cacheGet(key) {
  const m = memGet(key);
  if (m) return m;
  try {
    const row = await db.one('SELECT value, expires_at FROM cache WHERE key = $1', [key]);
    if (row && Number(row.expires_at) > Date.now()) {
      memSet(key, row.value, Number(row.expires_at));
      return row.value;
    }
  } catch (e) { /* cache is best-effort */ }
  return null;
}
function cacheSet(key, value, expires) {
  memSet(key, value, expires);
  db.query('INSERT INTO cache(key, value, expires_at) VALUES($1, $2, $3) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at',
    [key, JSON.stringify(value), expires]).catch(() => {});
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

  const host = new URL(url).hostname;
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
      if (json && res.ok) {
        try { result.data = JSON.parse(text); } catch (e) { result.ok = false; result.error = 'Invalid JSON'; }
      } else {
        result.text = text;
      }
    } catch (err) {
      result = { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : err.message };
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

// Purge expired cache rows occasionally
setInterval(() => {
  db.query('DELETE FROM cache WHERE expires_at < $1', [Date.now()]).catch(() => {});
}, 6 * 3600 * 1000).unref();

module.exports = { request, getJson, getText, USER_AGENT, sleep };
