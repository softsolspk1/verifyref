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
