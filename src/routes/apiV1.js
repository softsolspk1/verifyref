// routes/apiV1.js - Research Integrity API (v1) for the PJPS submission software and external journals.
// Authentication: an API key created by the Super Admin (Administration → Integrity API), sent as
//   Authorization: Bearer pjps_…   or   X-API-Key: pjps_…
// The key acts as the account it was issued for; results are saved under that account like any screening.
// Webhooks: when a job finishes, a JSON summary is POSTed to the key's webhook URL, signed with
//   X-PJPS-Signature: sha256=<HMAC-SHA256 of the body, keyed with the SHA-256 hex digest of the API key>
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const cfg = require('../config');
const auth = require('../auth');
const { defineJob, createJob, getJob } = require('../jobs');
const { loadCheck } = require('../pipeline');
const { buildPdf } = require('../pdf');
const R = require('../integrity/reports');
const { integrityInput, peerInput, SCOPES } = require('./integrity');
const { runIntegrity, saveIntegrity } = require('../integrity');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (res, status, message) => res.status(status).json({ success: false, error: message });

// ------------------------------------------------------------------ authentication, rate limit

const hits = new Map();
async function apiAuth(req, res, next) {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  if (!/^pjps_[\w-]{20,}$/.test(raw)) return fail(res, 401, 'Missing or malformed API key.');
  const hash = auth.sha256(raw);
  const key = await db.one('SELECT * FROM api_keys WHERE key_hash = $1 AND NOT revoked', [hash]);
  if (!key) return fail(res, 401, 'Unknown or revoked API key.');
  const user = await db.one('SELECT * FROM users WHERE id = $1', [key.user_id]);
  if (!user || user.status !== 'active') return fail(res, 403, 'The account behind this API key is suspended.');
  const now = Date.now();
  const list = (hits.get(key.id) || []).filter(t => now - t < 60000);
  if (list.length >= 60) return fail(res, 429, 'Rate limit: 60 requests per minute.');
  list.push(now);
  hits.set(key.id, list);
  db.query('UPDATE api_keys SET last_used = now() WHERE id = $1', [key.id]).catch(() => {});
  req.user = user;
  req.apiKey = key;
  next();
}
const scope = s => (req, res, next) => ((req.apiKey.scopes || []).includes(s) ? next() : fail(res, 403, `This API key does not have the "${s}" scope.`));

// ------------------------------------------------------------------ webhooks

async function webhook(key, payload) {
  if (!key?.webhook_url) return;
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', key.key_hash).update(body).digest('hex');
  try {
    await fetch(key.webhook_url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PJPS-Signature': `sha256=${sig}`, 'User-Agent': `${cfg.APP_NAME} webhook` }, body, signal: AbortSignal.timeout(10000) });
  } catch (e) { console.error('Webhook failed:', e.message); }
}

const reportUrl = id => `${cfg.PUBLIC_URL || ''}/api/v1/reports/${id}`;

/** What an integration needs: level, score, why, what was found (no confidential evidence quotes) */
function summary(r) {
  if (!r) return null;
  return {
    checkId: r.id || null, kind: r.kind, manuscriptCode: r.meta?.manuscriptCode || null, title: r.meta?.title || null, createdAt: r.createdAt,
    risk: r.risk ? { level: r.risk.level, score: r.risk.score, strongSignals: r.risk.strongSignals, recommendation: r.risk.recommendation, explanation: r.risk.explanation } : null,
    dimensions: (r.risk?.dimensions || []).map(d => ({ key: d.key, label: d.label, checked: d.checked, signals: d.signals, points: d.points })),
    signals: (r.dimensions || []).flatMap(d => (d.signals || []).map(s => ({ dimension: d.key, code: s.code, title: s.title, severity: s.severity }))),
    reportUrl: r.id ? reportUrl(r.id) : null, pdfUrl: r.id ? `${reportUrl(r.id)}?format=pdf` : null
  };
}

defineJob('api-integrity', async (input, ctx) => {
  const result = await runIntegrity(input, ctx.update);
  await saveIntegrity(ctx.userId, result, input);
  const key = await db.one('SELECT * FROM api_keys WHERE id = $1', [input.apiKeyId]);
  await webhook(key, { event: 'screening.completed', externalId: input.externalId || null, ...summary(result) });
  return result;
});

// ------------------------------------------------------------------ endpoints

router.use('/v1', apiAuth);

router.get('/v1/ping', (req, res) => res.json({ success: true, service: cfg.APP_NAME, version: cfg.APP_VERSION, account: req.user.email, scopes: req.apiKey.scopes }));

/**
 * POST /api/v1/screenings  { manuscriptCode, title, authors: [..] | "a\nb", affiliations, abstract, suggestedReviewers,
 *   text  |  fileBase64 + filename, deep: bool, externalId }
 */
router.post('/v1/screenings', scope('screen'), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.fileBase64) {
    const buffer = Buffer.from(String(b.fileBase64), 'base64');
    if (buffer.length > cfg.MAX_UPLOAD_MB * 1048576) return fail(res, 413, `File too large (limit ${cfg.MAX_UPLOAD_MB} MB).`);
    req.file = { buffer, originalname: String(b.filename || 'manuscript.docx'), mimetype: '' };
  }
  for (const k of ['authors', 'affiliations']) if (Array.isArray(b[k])) b[k] = b[k].join('\n');
  const input = await integrityInput(req);
  if (!input) return fail(res, 400, 'Send the full manuscript as "text" or as "fileBase64" with "filename" (Word or PDF).');
  const job = await createJob(req.user.id, 'api-integrity', { ...input, apiKeyId: req.apiKey.id, externalId: String(b.externalId || '').slice(0, 120) || null });
  await auth.audit(req, 'api-screening', input.meta.manuscriptCode || null, { key: req.apiKey.prefix });
  res.status(202).json({ success: true, jobId: job.id, statusUrl: `/api/v1/jobs/${job.id}` });
}));

router.post('/v1/peer-review', scope('peer-review'), wrap(async (req, res) => {
  const input = await peerInput(req);
  if (!input) return fail(res, 400, 'Send "reviewers": [{ name, email, orcid, institution, report }] and the manuscript authors.');
  const job = await createJob(req.user.id, 'peer-review', input);
  res.status(202).json({ success: true, jobId: job.id, statusUrl: `/api/v1/jobs/${job.id}` });
}));

router.get('/v1/jobs/:id', scope('reports'), wrap(async (req, res) => {
  const j = await getJob(req.params.id, req.user.id);
  if (!j) return fail(res, 404, 'Job not found or expired.');
  res.json({ success: true, status: j.status, progress: j.progress, step: j.step, error: j.error || null, result: j.status === 'done' ? summary(j.result) : null });
}));

/** GET /api/v1/reports/:checkId  - JSON summary; ?format=pdf the confidential PDF; ?full=1 the complete result */
router.get('/v1/reports/:id', scope('reports'), wrap(async (req, res) => {
  const c = await loadCheck(req.user.id, req.params.id);
  if (!c?.result || !['integrity', 'peer-review'].includes(c.row.kind)) return fail(res, 404, 'Report not found for this API key.');
  if (req.query.format === 'pdf') {
    const pdf = await buildPdf(c.row.kind === 'integrity' ? R.integrityBlocks(c.result) : R.peerReviewBlocks(c.result));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${c.row.kind}-${String(c.row.manuscript_code || c.row.id).replace(/[^\w.-]+/g, '_')}.pdf"`);
    return res.send(pdf);
  }
  res.json({ success: true, report: req.query.full ? c.result : summary(c.result) });
}));

router.get('/v1/reports', scope('reports'), wrap(async (req, res) => {
  const params = [req.user.id];
  let where = "user_id = $1 AND kind IN ('integrity', 'peer-review')";
  if (req.query.manuscriptCode) { params.push(req.query.manuscriptCode); where += ` AND manuscript_code = $${params.length}`; }
  const rows = await db.all(`SELECT id, kind, manuscript_code, title, created_at, result->'risk'->>'level' AS level, result->'risk'->>'score' AS score FROM checks WHERE ${where} ORDER BY created_at DESC LIMIT 200`, params);
  res.json({ success: true, reports: rows.map(r => ({ ...r, score: r.score === null ? null : Number(r.score), reportUrl: reportUrl(r.id) })) });
}));

router.get('/v1/articles', scope('monitoring'), wrap(async (req, res) => {
  const doi = String(req.query.doi || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
  if (doi) {
    const a = await db.one('SELECT doi, title, journal, year, status, events, cited_retracted, last_checked FROM monitored_articles WHERE doi = $1', [doi]);
    return a ? res.json({ success: true, article: a }) : fail(res, 404, 'This DOI is not monitored.');
  }
  const rows = await db.all("SELECT doi, title, year, status, last_checked FROM monitored_articles WHERE status <> 'ok' ORDER BY last_checked DESC NULLS LAST LIMIT 500");
  res.json({ success: true, flagged: rows });
}));

router.get('/v1', (req, res) => res.json({ success: true, scopes: SCOPES, endpoints: ['GET /api/v1/ping', 'POST /api/v1/screenings', 'POST /api/v1/peer-review', 'GET /api/v1/jobs/:id', 'GET /api/v1/reports', 'GET /api/v1/reports/:checkId[?format=pdf|full=1]', 'GET /api/v1/articles[?doi=]'] }));

module.exports = router;
