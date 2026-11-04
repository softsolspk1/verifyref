// routes/activity.js - My Activity (saved results of every tool), alerts (follows), notifications, community
// conference entries and personal alert settings.
const express = require('express');
const db = require('../db');
const cfg = require('../config');
const auth = require('../auth');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const user = auth.requireUser;

const FOLLOW_KINDS = { author: 'Author', topic: 'Topic', conference: 'Conference', citations: 'Citations of my work (ORCID)' };
const LIMITS = { author: 25, topic: 10, conference: 25, citations: 1 };

/** Validate and store a follow (shared with the desktop sync endpoint) */
async function createFollow(u, b) {
  const kind = String(b.kind || '');
  if (!FOLLOW_KINDS[kind]) return { success: false, message: 'Unknown alert type.' };
  let key = String(b.key || '').trim();
  if (kind === 'citations') {
    key = key || u.orcid || '';
    if (!/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(key)) return { success: false, message: 'Enter your ORCID iD (0000-0000-0000-0000) to receive citation alerts.' };
  }
  if (kind === 'topic' && key.length < 3) return { success: false, message: 'Enter a topic of at least three characters.' };
  if ((kind === 'author' && !/^A\d+$/.test(key)) || (kind === 'conference' && !/^S\d+$/.test(key))) return { success: false, message: 'Choose the author or conference from the search results.' };
  const n = (await db.one('SELECT COUNT(*)::int AS n FROM follows WHERE user_id = $1 AND kind = $2', [u.id, kind])).n;
  if (n >= LIMITS[kind]) return { success: false, message: `You can follow up to ${LIMITS[kind]} ${FOLLOW_KINDS[kind].toLowerCase()} alert(s).` };
  const row = await db.one(`INSERT INTO follows(user_id, kind, key, label) VALUES($1, $2, $3, $4)
    ON CONFLICT (user_id, kind, key) DO UPDATE SET label = EXCLUDED.label RETURNING *`, [u.id, kind, key, String(b.label || key).slice(0, 200)]);
  return { success: true, follow: row };
}

// ------------------------------------------------------------------ My Activity

router.get('/activity', user, wrap(async (req, res) => {
  const params = [req.user.id];
  let where = 'user_id = $1';
  if (req.query.kind) { params.push(String(req.query.kind).split(',')); where += ` AND kind = ANY($${params.length}::text[])`; }
  if (req.query.q) { params.push(`%${req.query.q}%`); where += ` AND (title ILIKE $${params.length} OR manuscript_code ILIKE $${params.length})`; }
  where += ' AND embedded_in IS NULL';   // shown inside their Full Screening Report
  const rows = await db.all(`SELECT id, kind, manuscript_code, version, title, ref_total, verified, suspicious, unverified, miscited, retracted, problems, created_at, origin, synced_at, pending_online,
    (result IS NOT NULL) AS has_result FROM checks WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params);
  res.json({ success: true, items: rows });
}));

// ------------------------------------------------------------------ Reports (Super Admin: every report by every user)

router.get('/reports', user, auth.requireSuperAdmin, wrap(async (req, res) => {
  const params = [];
  let where = 'c.embedded_in IS NULL';
  const days = parseInt(req.query.days || '0', 10);
  if (days > 0) { params.push(String(Math.min(days, 3650))); where += ` AND c.created_at > now() - ($${params.length} || ' days')::interval`; }
  if (req.query.user) { params.push(parseInt(req.query.user, 10) || 0); where += ` AND c.user_id = $${params.length}`; }
  if (req.query.kind) { params.push(String(req.query.kind).split(',')); where += ` AND c.kind = ANY($${params.length}::text[])`; }
  if (req.query.q) { params.push(`%${req.query.q}%`); where += ` AND (c.title ILIKE $${params.length} OR c.manuscript_code ILIKE $${params.length} OR u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`; }
  const rows = await db.all(`SELECT c.id, c.user_id, c.kind, c.manuscript_code, c.version, c.title, c.ref_total, c.verified, c.suspicious, c.unverified, c.miscited, c.retracted, c.problems,
    c.created_at, c.origin, (c.result IS NOT NULL) AS has_result, u.name AS user_name, u.email AS user_email, u.role AS user_role
    FROM checks c JOIN users u ON u.id = c.user_id WHERE ${where} ORDER BY c.created_at DESC LIMIT 2000`, params);
  const users = await db.all('SELECT id, name, email, role FROM users ORDER BY name');
  res.json({ success: true, items: rows, users });
}));

// ------------------------------------------------------------------ Dashboard analytics (Super Admin only: every user's reports)

const RISK_RE = /\b(?:risk|Image risk) (LOW|MODERATE|MEDIUM|HIGH|CRITICAL)\b/i;

router.get('/dashboard', user, auth.requireSuperAdmin, wrap(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days || '90', 10) || 90, 1), 3650);
  const all = auth.isSuper(req.user);
  const params = [String(days)];
  let where = "c.embedded_in IS NULL AND c.created_at > now() - ($1 || ' days')::interval";
  if (!all) { params.push(req.user.id); where += ` AND c.user_id = $${params.length}`; } else if (req.query.user) { params.push(parseInt(req.query.user, 10) || 0); where += ` AND c.user_id = $${params.length}`; }
  const [totals, byKind, byDay, byUser, riskRows, topFlagged] = await Promise.all([
    db.one(`SELECT COUNT(*)::int AS reports, COUNT(DISTINCT COALESCE(NULLIF(c.manuscript_code, ''), NULLIF(c.title, ''), c.id::text))::int AS articles,
      COUNT(DISTINCT c.user_id)::int AS users, COALESCE(SUM(c.ref_total), 0)::int AS refs, COALESCE(SUM(c.verified), 0)::int AS verified,
      COALESCE(SUM(c.suspicious), 0)::int AS suspicious, COALESCE(SUM(c.unverified), 0)::int AS unverified, COALESCE(SUM(c.miscited), 0)::int AS miscited,
      COALESCE(SUM(c.retracted), 0)::int AS retracted, COALESCE(SUM(c.missing_citations), 0)::int AS missing_citations,
      COALESCE(SUM(c.uncited_references), 0)::int AS uncited_references, COALESCE(SUM(c.journal_flags), 0)::int AS journal_flags,
      COUNT(*) FILTER (WHERE c.suspicious > 0 OR c.retracted > 0)::int AS flagged
      FROM checks c WHERE ${where}`, params),
    db.all(`SELECT c.kind, COUNT(*)::int AS runs, COALESCE(SUM(c.ref_total), 0)::int AS refs, COALESCE(SUM(c.suspicious), 0)::int AS suspicious, COALESCE(SUM(c.retracted), 0)::int AS retracted
      FROM checks c WHERE ${where} GROUP BY c.kind ORDER BY runs DESC`, params),
    db.all(`SELECT to_char(date_trunc('day', c.created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS runs
      FROM checks c WHERE ${where} GROUP BY 1 ORDER BY 1`, params),
    all ? db.all(`SELECT u.id, u.name, u.email, u.role, COUNT(c.id)::int AS runs, COALESCE(SUM(c.ref_total), 0)::int AS refs,
      COALESCE(SUM(c.suspicious), 0)::int AS suspicious, COALESCE(SUM(c.retracted), 0)::int AS retracted, MAX(c.created_at) AS last_run
      FROM checks c JOIN users u ON u.id = c.user_id WHERE ${where} GROUP BY u.id ORDER BY runs DESC LIMIT 50`, params) : [],
    db.all(`SELECT c.kind, c.problems FROM checks c WHERE ${where} AND c.kind IN ('papermill', 'images', 'integrity', 'peer-review', 'manuscript') LIMIT 5000`, params),
    db.all(`SELECT c.id, c.kind, c.manuscript_code, c.title, c.suspicious, c.retracted, c.miscited, c.ref_total, c.created_at, u.name AS user_name
      FROM checks c JOIN users u ON u.id = c.user_id WHERE ${where} AND (c.suspicious > 0 OR c.retracted > 0 OR c.miscited > 0)
      ORDER BY (c.retracted * 3 + c.suspicious * 2 + c.miscited) DESC, c.created_at DESC LIMIT 10`, params)
  ]);
  // Risk levels are written into the first findings line of paper-mill and image reports
  const risk = {};
  for (const r of riskRows) {
    const m = (r.problems || []).map(p => String(p).match(RISK_RE)).find(Boolean);
    if (!m) continue;
    const group = r.kind === 'images' ? 'images' : r.kind === 'peer-review' ? 'peer-review' : r.kind === 'manuscript' ? 'manuscript' : 'papermill';
    const level = m[1].toUpperCase() === 'MEDIUM' ? 'MODERATE' : m[1].toUpperCase();
    risk[group] = risk[group] || { LOW: 0, MODERATE: 0, HIGH: 0, CRITICAL: 0 };
    risk[group][level]++;
  }
  const novelty = await noveltyStats(where, params);
  res.json({ success: true, days, scope: all ? 'all' : 'mine', totals, byKind, byDay, byUser, risk, topFlagged, novelty,
    users: all ? await db.all('SELECT id, name FROM users ORDER BY name') : [] });
}));

/**
 * Novelty statistics of the Full Screening Reports in the period. The novelty summary sits in the result column (or in
 * its R2 stub); reports moved to R2 before the stub carried it are read from R2 once and their stub is filled in.
 */
async function noveltyStats(where, params) {
  const R = require('../reportStore');
  const rows = await db.all(`SELECT c.id, c.manuscript_code, c.title, c.created_at, u.name AS user_name, c.result->'novelty' AS nv, c.result->>'_r2' AS r2
    FROM checks c JOIN users u ON u.id = c.user_id WHERE ${where} AND c.kind = 'manuscript' AND c.result IS NOT NULL
    ORDER BY c.created_at DESC LIMIT 5000`, params);
  let backfill = 40;
  for (const r of rows) {
    if (r.nv || !r.r2 || backfill <= 0) continue;
    backfill--;
    const full = await R.load({ _r2: r.r2 });
    if (!full || full._unavailable) continue;
    r.nv = R.noveltyStub(full.novelty) || { absent: true };
    await db.query(`UPDATE checks SET result = jsonb_set(result, '{novelty}', $1::jsonb) WHERE id = $2`, [JSON.stringify(r.nv), r.id]).catch(() => {});
  }
  const withNv = rows.filter(r => r.nv && !r.nv.absent);
  const done = withNv.filter(r => r.nv.summary);
  const scores = done.map(r => r.nv.summary.score).filter(Number.isFinite).sort((a, b) => a - b);
  const count = (key, values) => Object.fromEntries(values.map(v => [v, done.filter(r => r.nv.summary[key] === v).length]));
  const histogram = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, n: scores.filter(x => (i === 9 ? x >= 90 : x >= i * 10 && x < i * 10 + 10)).length }));
  const avg = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null);
  return {
    screened: rows.filter(r => r.nv || !r.r2).length,
    assessed: done.length,
    notAssessed: withNv.filter(r => r.nv.error).length,
    pending: rows.filter(r => !r.nv && r.r2).length,
    averageScore: avg(scores),
    medianScore: scores.length ? scores[Math.floor((scores.length - 1) / 2)] : null,
    averageSimilarity: avg(done.map(r => r.nv.summary.maxSimilarity).filter(Number.isFinite).map(x => x * 100)),
    closeRecent: done.reduce((a, r) => a + (r.nv.summary.closeRecent || 0), 0),
    bands: count('band', ['high', 'moderate', 'low']),
    outlook: count('outlook', ['high', 'moderate', 'low', 'insufficient data']),
    confidence: count('confidence', ['high', 'moderate', 'low']),
    histogram,
    items: withNv.slice(0, 100).map(r => ({
      id: r.id, manuscript_code: r.manuscript_code, title: r.title, created_at: r.created_at, user_name: r.user_name,
      error: r.nv.error || null, ...(r.nv.summary || {}), closest: r.nv.closest?.[0] || null
    }))
  };
}

// ------------------------------------------------------------------ notifications

router.get('/notifications', user, wrap(async (req, res) => {
  const rows = await db.all('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  const unread = (await db.one('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT read', [req.user.id])).n;
  res.json({ success: true, notifications: rows, unread });
}));

router.post('/notifications/read', user, wrap(async (req, res) => {
  if (req.body?.id) await db.query('UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2', [req.body.id, req.user.id]);
  else await db.query('UPDATE notifications SET read = true WHERE user_id = $1', [req.user.id]);
  res.json({ success: true });
}));

router.delete('/notifications/:id', user, wrap(async (req, res) => {
  await db.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

// ------------------------------------------------------------------ follows (alerts)
// On the desktop, follows live on the web platform (where alerts are computed) and are managed through the sync API.

async function viaRemote(req, res, path, opts = {}) {
  const desk = require('../desktop');
  const token = await db.getMeta(`device_token:${req.user.id}`);
  try {
    res.json(await desk.remote(path, { ...opts, token }));
  } catch (e) {
    res.status(e.network ? 503 : e.status || 400).json({ success: false, message: e.network ? 'Managing alerts needs an internet connection (alerts run on the web platform).' : e.message });
  }
}

router.get('/follows', auth.requireModule('alerts'), wrap(async (req, res) => {
  if (cfg.DESKTOP) return viaRemote(req, res, '/api/sync/follows');
  res.json({ success: true, follows: await db.all('SELECT id, kind, key, label, last_checked, created_at FROM follows WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]), kinds: FOLLOW_KINDS, limits: LIMITS });
}));

router.post('/follows', auth.requireModule('alerts', 'authors', 'conferences'), wrap(async (req, res) => {
  if (cfg.DESKTOP) return viaRemote(req, res, '/api/sync/follows', { method: 'POST', body: req.body });
  const r = await createFollow(req.user, req.body || {});
  res.status(r.success ? 200 : 400).json(r);
}));

router.delete('/follows/:id', auth.requireModule('alerts', 'authors', 'conferences'), wrap(async (req, res) => {
  if (cfg.DESKTOP) return viaRemote(req, res, `/api/sync/follows/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
  await db.query('DELETE FROM follows WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

router.post('/preferences', user, wrap(async (req, res) => {
  const b = req.body || {};
  if ('emailAlerts' in b) await db.query('UPDATE users SET email_alerts = $1 WHERE id = $2', [!!b.emailAlerts, req.user.id]);
  if ('orcid' in b) {
    const o = String(b.orcid || '').trim();
    if (o && !/^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/.test(o)) return res.status(400).json({ success: false, message: 'ORCID iD format: 0000-0000-0000-0000.' });
    await db.query('UPDATE users SET orcid = $1 WHERE id = $2', [o || null, req.user.id]);
  }
  res.json({ success: true });
}));

// ------------------------------------------------------------------ community conferences

router.post('/community-conferences', auth.requireModule('conferences'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || String(b.name).trim().length < 5) return res.status(400).json({ success: false, message: 'Enter the conference name.' });
  if (b.url && !/^https?:\/\/\S+$/i.test(b.url)) return res.status(400).json({ success: false, message: 'The website must start with http:// or https://' });
  const row = await db.one(`INSERT INTO community_conferences(user_id, name, acronym, country, url, topics, indexed_in, note) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [req.user.id, String(b.name).trim().slice(0, 300), (b.acronym || '').slice(0, 40) || null, (b.country || '').slice(0, 80) || null, b.url || null, (b.topics || '').slice(0, 500) || null, (b.indexedIn || '').slice(0, 200) || null, (b.note || '').slice(0, 1000) || null]);
  res.json({ success: true, conference: row });
}));

router.delete('/community-conferences/:id', auth.requireModule('conferences'), wrap(async (req, res) => {
  const where = auth.isSuper(req.user) ? 'id = $1' : 'id = $1 AND user_id = $2';
  await db.query(`DELETE FROM community_conferences WHERE ${where}`, auth.isSuper(req.user) ? [req.params.id] : [req.params.id, req.user.id]);
  res.json({ success: true });
}));

module.exports = router;
module.exports.createFollow = createFollow;
module.exports.FOLLOW_KINDS = FOLLOW_KINDS;
