// externalSimilarity.js - full-text comparison of a manuscript by the external similarity service (Copyleaks API), for
// the Similarity Report: web pages and publications the in-house passage search does not reach, the service's database
// of submitted documents, and paraphrase ("related meaning") detection. Its name is not shown to users; reports call it
// "the external full-text similarity service".
//
// Flow (survives a stopped and resumed job): the text is submitted once under a scan id (ext_scans, found again by a
// hash of the text for 3 hours); the service calls back /api/hooks/sim/<scanId>/<status> when the scan is done; the
// matched results are then exported, each one pushed to /api/hooks/sim/<scanId>/result/<id>. The callback URLs carry an
// HMAC of the scan id (keyed with the API key) and are refused without it.
// Privacy: never indexed in the service's database (indexing off, "my submissions" not compared) and the scan expires
// after EXPIRATION_HOURS. Needs a public address for the callbacks (PUBLIC_URL, or the Vercel production URL): the
// desktop app and a local server without one skip this comparison.
const crypto = require('crypto');
const cfg = require('./config');
const db = require('./db');

const API = 'https://api.copyleaks.com';
const ID = 'https://id.copyleaks.com';
const MAX_RESULTS = 25;              // matched sources exported with their positions
const EXPIRATION_HOURS = 2;          // the service deletes the scan after this
const WAIT_SCAN_MS = 6 * 60000;      // the report waits this long for the scan, then goes on without it
const WAIT_EXPORT_MS = 3 * 60000;
const POLL_MS = 4000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

/** The address the service calls back: PUBLIC_URL, else the Vercel production domain */
function baseUrl() {
  if (cfg.PUBLIC_URL) return cfg.PUBLIC_URL;
  const v = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return v ? `https://${v.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '';
}
const enabled = () => !!(cfg.COPYLEAKS_EMAIL && cfg.COPYLEAKS_API_KEY && baseUrl() && !cfg.DESKTOP);

const sign = scanId => crypto.createHmac('sha256', `${cfg.COPYLEAKS_API_KEY}|callbacks`).update(String(scanId)).digest('hex').slice(0, 32);
function verify(scanId, t) {
  const a = Buffer.from(sign(scanId)), b = Buffer.from(String(t || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hook = (scanId, tail) => `${baseUrl()}/api/hooks/sim/${encodeURIComponent(scanId)}/${tail}?t=${sign(scanId)}`;

// ------------------------------------------------------------------ API calls

let memToken = null;
async function token(fresh = false) {
  const soon = Date.now() + 3600e3;
  if (!fresh && memToken && memToken.expires > soon) return memToken.token;
  if (!fresh) {
    const row = await db.one("SELECT token, expires FROM ext_tokens WHERE id = 'sim'").catch(() => null);
    if (row && new Date(row.expires).getTime() > soon) { memToken = { token: row.token, expires: new Date(row.expires).getTime() }; return memToken.token; }
  }
  // the login is limited to 12 per 15 minutes: the token (valid 48 h) is shared through the database
  const r = await call(`${ID}/v3/account/login/api`, { method: 'POST', body: { email: cfg.COPYLEAKS_EMAIL, key: cfg.COPYLEAKS_API_KEY }, auth: false });
  if (!r.ok || !r.data?.access_token) throw new Error(`the similarity service refused the login (HTTP ${r.status})`);
  memToken = { token: r.data.access_token, expires: new Date(r.data['.expires']).getTime() || Date.now() + 47 * 3600e3 };
  await db.query("INSERT INTO ext_tokens(id, token, expires) VALUES('sim', $1, $2) ON CONFLICT (id) DO UPDATE SET token = $1, expires = $2",
    [memToken.token, new Date(memToken.expires).toISOString()]).catch(() => null);
  return memToken.token;
}

async function call(url, { method = 'GET', body = null, auth = true, timeout = 60000, retried = false } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth) headers.Authorization = `Bearer ${await token()}`;
  let res, text = '';
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
    text = await res.text();
  } catch (e) { return { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'timeout' : e.message }; }
  if (res.status === 401 && auth && !retried) { await token(true); return call(url, { method, body, auth, timeout, retried: true }); }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: res.ok, status: res.status, data, text: res.ok ? '' : text.slice(0, 300) };
}

// ------------------------------------------------------------------ callbacks (routes/hooks.js)

/** Store a callback: what = completed | error | creditsChecked | indexed | export-done | result (with id) */
async function receive(scanId, what, id, body) {
  const w = String(what || '').toLowerCase();
  if (w === 'completed') await db.query("UPDATE ext_scans SET status = 'completed', completed = $2, updated_at = now() WHERE scan_id = $1 AND status = 'submitted'", [scanId, JSON.stringify(slimCompleted(body))]);
  else if (w === 'error') await db.query("UPDATE ext_scans SET status = 'error', error = $2, updated_at = now() WHERE scan_id = $1", [scanId, String(body?.error?.message || body?.message || 'scan failed').slice(0, 300)]);
  else if (w === 'result' && id) await db.query("UPDATE ext_scans SET results = results || jsonb_build_object($2::text, $3::jsonb), updated_at = now() WHERE scan_id = $1", [scanId, String(id), JSON.stringify(slimResult(body))]);
  else if (w === 'export-done') await db.query("UPDATE ext_scans SET status = 'exported', updated_at = now() WHERE scan_id = $1 AND status IN ('completed', 'exporting')", [scanId]);
  // creditsChecked / indexed: nothing to do
}

/** What the report needs of the completed callback: the matched sources, the totals and the AI-text alert */
function slimCompleted(b) {
  const item = (x, kind) => ({ id: x.id, kind, title: x.title || null, url: x.url || null, matchedWords: x.matchedWords || 0, identicalWords: x.identicalWords || 0, similarWords: x.similarWords || 0, paraphrasedWords: x.paraphrasedWords || 0,
    introduction: String(x.introduction || '').slice(0, 300), metadata: { author: x.metadata?.author || null, organization: x.metadata?.organization || null, publishDate: x.metadata?.publishDate || null, filename: x.metadata?.filename || null } });
  const r = b?.results || {};
  const alerts = (b?.notifications?.alerts || []).map(a => ({ code: a.code, title: a.title, additionalData: String(a.additionalData || '').slice(0, 20000) }));
  return {
    totalWords: b?.scannedDocument?.totalWords || 0, credits: b?.scannedDocument?.credits ?? null, score: b?.results?.score || b?.score || null,
    items: [...(r.internet || []).map(x => item(x, 'internet')), ...(r.database || []).map(x => item(x, 'database')), ...(r.repositories || []).map(x => item(x, 'repository'))],
    alerts
  };
}

/** What the report needs of an exported result: the positions of the matches on both sides and the matched text */
function slimResult(b) {
  const cmp = b?.text?.comparison || {};
  const side = o => ({ chars: { starts: o?.chars?.starts || [], lengths: o?.chars?.lengths || [] } });
  const pick = k => (cmp[k] ? { source: side(cmp[k].source), suspected: side(cmp[k].suspected) } : null);
  return { statistics: b?.statistics || null, value: String(b?.text?.value || '').slice(0, 400000), comparison: { identical: pick('identical'), minorChanges: pick('minorChanges'), relatedMeaning: pick('relatedMeaning') } };
}

// ------------------------------------------------------------------ the scan

async function waitFor(scanId, done, ms, tick) {
  const end = Date.now() + ms;
  for (let i = 0; ; i++) {
    const row = await db.one('SELECT * FROM ext_scans WHERE scan_id = $1', [scanId]);
    if (!row || done(row)) return row;
    if (Date.now() > end) return row;
    if (i % 8 === 0) tick();
    await sleep(POLL_MS);
  }
}

/**
 * Compare a text with the service: -> { scanId, completed, results: { id: exported result }, items (the sources
 * exported, largest first) } or { error, pending? }. Never throws.
 */
async function scanText(text, { update = () => {} } = {}) {
  try {
    if (!enabled()) return null;
    const hash = sha(text);
    await db.query("DELETE FROM ext_scans WHERE created_at < now() - interval '1 day'").catch(() => null);
    let row = await db.one("SELECT * FROM ext_scans WHERE text_hash = $1 AND created_at > now() - interval '3 hours' AND status <> 'error' ORDER BY created_at DESC LIMIT 1", [hash]);
    if (!row) {
      const scanId = `pjps${crypto.randomBytes(12).toString('hex')}`;
      await db.query('INSERT INTO ext_scans(scan_id, text_hash) VALUES($1, $2)', [scanId, hash]);
      const r = await call(`${API}/v3/scans/submit/file/${scanId}`, {
        method: 'PUT',
        body: {
          base64: Buffer.from(text, 'utf8').toString('base64'),
          filename: 'manuscript.txt',
          properties: {
            action: 0,
            sandbox: cfg.COPYLEAKS_SANDBOX,
            expiration: EXPIRATION_HOURS,
            webhooks: { status: hook(scanId, '{STATUS}') },
            scanning: { internet: true, copyleaksDb: { includeMySubmissions: false, includeOthersSubmissions: true } },
            indexing: { copyleaksDb: false },
            aiGeneratedText: { detect: true }
          }
        }
      });
      if (!r.ok) {
        await db.query("UPDATE ext_scans SET status = 'error', error = $2 WHERE scan_id = $1", [scanId, `submission refused (HTTP ${r.status}) ${r.text || ''}`.trim().slice(0, 300)]);
        return { error: `the external comparison could not be started (HTTP ${r.status})` };
      }
      row = { scan_id: scanId, status: 'submitted' };
    }
    const scanId = row.scan_id;
    update('Full-text comparison: waiting for the external similarity service');
    row = await waitFor(scanId, x => x.status !== 'submitted', WAIT_SCAN_MS, () => update('Full-text comparison: still waiting for the external similarity service'));
    if (!row || row.status === 'submitted') return { scanId, error: 'the external comparison did not finish in time', pending: true };
    if (row.status === 'error') return { scanId, error: row.error || 'the external comparison failed' };
    const completed = row.completed || {};
    const items = [...(completed.items || [])].sort((a, b) => b.matchedWords - a.matchedWords).slice(0, MAX_RESULTS);
    if (items.length && row.status === 'completed') {
      const exportId = `x${crypto.randomBytes(6).toString('hex')}`;
      const r = await call(`${API}/v3/downloads/${scanId}/export/${exportId}`, {
        method: 'POST',
        body: { results: items.map(x => ({ id: x.id, verb: 'POST', endpoint: hook(scanId, `result/${encodeURIComponent(x.id)}`) })), completionWebhook: hook(scanId, 'export-done'), maxRetries: 3 }
      });
      if (r.ok || r.status === 409) await db.query("UPDATE ext_scans SET status = 'exporting' WHERE scan_id = $1 AND status = 'completed'", [scanId]);
      else return { scanId, completed, items, results: {}, error: `the matched sources could not be read (HTTP ${r.status})` };
    }
    if (items.length) {
      update(`Full-text comparison: reading ${items.length} matched source(s)`);
      row = await waitFor(scanId, x => x.status === 'exported' || items.every(i => x.results?.[i.id]), WAIT_EXPORT_MS, () => {});
    }
    return { scanId, completed, items, results: row?.results || {} };
  } catch (e) {
    return { error: `the external comparison failed: ${e.message}` };
  }
}

// ------------------------------------------------------------------ figures (Module 5)

/** The image checks need only the login (they answer in the same request, no callback): web and desktop */
const imagesEnabled = () => !!(cfg.COPYLEAKS_EMAIL && cfg.COPYLEAKS_API_KEY);

async function callForm(url, form, { timeout = 90000, retried = false } = {}) {
  let res, text = '';
  try {
    res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${await token()}`, Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(timeout) });
    text = await res.text();
  } catch (e) { return { ok: false, status: 0, error: e.message }; }
  if (res.status === 401 && !retried) { await token(true); return callForm(url, form, { timeout, retried: true }); }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * One figure (JPEG, base64): the AI-generated image detector (figures of 400 px or more on each side) and the reverse
 * image search on the web. -> { ai: { percent, isAi } | { skipped }, web: { full, partial, matches: [{ imageUrl, full,
 * pages }] }, errors: [] }
 */
async function checkFigure({ base64, filename = 'figure.jpg', width = 0, height = 0 }) {
  const out = { ai: null, web: null, errors: [] };
  const scanId = kind => `pjps${kind}${crypto.randomBytes(10).toString('hex')}`;
  if (width >= 400 && height >= 400) {
    const r = await call(`${API}/v1/ai-image-detector/${scanId('a')}/check`, { method: 'POST', timeout: 90000,
      body: { base64, filename, model: 'ai-image-1-ultra', maskType: 'none', sandbox: cfg.COPYLEAKS_SANDBOX } });
    if (r.ok && r.data) {
      const ai = Number(r.data.summary?.ai) || 0;
      out.ai = { percent: Math.round(ai <= 1 ? ai * 100 : ai), isAi: !!r.data.isAiDetected };
    } else out.errors.push(`AI image check: HTTP ${r.status}`);
  } else out.ai = { skipped: 'smaller than 400 px on a side' };
  const form = new FormData();
  form.append('image', new Blob([Buffer.from(base64, 'base64')], { type: 'image/jpeg' }), filename);
  form.append('filename', filename);
  form.append('sandbox', String(cfg.COPYLEAKS_SANDBOX));
  const r = await callForm(`${API}/v1/image-plagiarism-detector/${scanId('w')}/check`, form);
  if (r.ok && r.data) {
    const m = r.data.matches || {};
    out.web = { full: m.score?.fullMatches || 0, partial: m.score?.partialMatches || 0,
      matches: (m.internet || []).slice(0, 10).map(x => ({ imageUrl: x.url || null, full: x.matchType === 0, pages: (x.webPages || []).map(p => p.url).filter(Boolean).slice(0, 3) })) };
  } else out.errors.push(`Reverse image search: HTTP ${r.status}`);
  return out;
}

/** The AI-text estimate from the scan's alert (0-100 % likely AI-written), or null */
function aiEstimate(completed) {
  for (const a of completed?.alerts || []) {
    if (!/ai/i.test(a.code || '')) continue;
    try {
      const d = JSON.parse(a.additionalData || '{}');
      const ai = d?.summary?.ai;
      if (Number.isFinite(ai)) return Math.round(ai * 100);
    } catch (e) { /* not JSON */ }
  }
  return null;
}

module.exports = { enabled, imagesEnabled, checkFigure, scanText, receive, verify, sign, aiEstimate, slimCompleted, slimResult, baseUrl };
