// server.js - PJPS Data Integrity System by Softsols Pakistan. One Express app serves the web platform (PostgreSQL,
// Vercel or a VPS) and the Windows desktop edition (embedded database on 127.0.0.1, see desktop/main.js).
const express = require('express');
const path = require('path');

const cfg = require('./src/config');
const db = require('./src/db');
const auth = require('./src/auth');
const { defineJob, createJob, purgeJobs } = require('./src/jobs');
const D = require('./src/datasets');
const { MODULES, ROLES } = require('./src/modules');
const { STYLE_LIST } = require('./src/styles');
const { TEMPLATE_LIST, ARTICLE_TYPE_LIST } = require('./src/tools/msformat');
const { isOnline, probe } = require('./src/http');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100mb' }));

// Schema + first Super Admin, once per instance (on Vercel there is no start-up hook)
let ready = null;
app.use((req, res, next) => {
  if (!ready) ready = db.init().then(() => auth.seedAdmin()).catch(err => { ready = null; throw err; });
  ready.then(() => next(), next);
});

app.use(auth.sessionMiddleware);
// Locally Express serves public/; on Vercel the CDN does (express.static is ignored there)
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ------------------------------------------------------------------ public

app.get('/api/app', wrap(async (req, res) => {
  res.json({
    name: cfg.APP_NAME, vendor: cfg.APP_VENDOR, version: cfg.APP_VERSION, desktop: cfg.DESKTOP, online: isOnline(),
    homeJournal: cfg.HOME_JOURNAL, user: auth.publicUser(req.user) || null,
    remoteUrl: cfg.DESKTOP ? await require('./src/desktop').remoteUrl() : null,
    modules: MODULES, roles: ROLES, styles: STYLE_LIST, templates: TEMPLATE_LIST, articleTypes: ARTICLE_TYPE_LIST,
    uploads: { largeFiles: require('./src/uploads').enabled(), maxMb: cfg.MAX_UPLOAD_MB }
  });
}));

// No self-registration: accounts are created by the Super Admin
app.post('/api/auth/login', auth.throttle, wrap(auth.login));
app.post('/api/auth/logout', wrap(auth.logout));
app.get('/api/auth/me', (req, res) => res.json({ user: auth.publicUser(req.user) || null }));
app.post('/api/auth/password', auth.requireUser, wrap(auth.changePassword));

// ------------------------------------------------------------------ feature routers

app.use('/api', require('./src/routes/core'));
app.use('/api', require('./src/routes/tools'));
app.use('/api', require('./src/routes/activity'));
app.use('/api', require('./src/routes/admin'));
app.use('/api', require('./src/routes/screening'));
app.use('/api', require('./src/routes/integrity'));
app.use('/api', require('./src/routes/apiV1'));

if (cfg.DESKTOP) {
  // ---------------------------------------------------------------- desktop edition (local only)
  const desk = require('./src/desktop');
  const { processQueue } = require('./src/queue');

  app.get('/api/desktop/settings', wrap(async (req, res) => res.json({ success: true, remoteUrl: await desk.remoteUrl(), online: await probe() })));
  app.post('/api/desktop/settings', wrap(async (req, res) => {
    const url = String(req.body?.remoteUrl || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+/i.test(url)) return res.status(400).json({ success: false, message: 'Enter the web platform address, e.g. https://refcheck.pjps.pk' });
    await db.setMeta('remote_url', url);
    res.json({ success: true, remoteUrl: url });
  }));
  app.get('/api/desktop/status', auth.requireUser, wrap(async (req, res) => res.json({ success: true, ...(await desk.status(req.user.id)) })));
  app.post('/api/desktop/sync', auth.requireUser, wrap(async (req, res) => {
    const job = await createJob(req.user.id, 'sync', { datasets: req.body?.datasets !== false });
    res.json({ success: true, jobId: job.id });
  }));
  defineJob('sync', (input, { userId, update }) => desk.syncAll(userId, input, update));
  app.get('/api/desktop/queue', auth.requireUser, wrap(async (req, res) => {
    res.json({ success: true, items: await db.all('SELECT id, kind, check_id, label, status, error, created_at, done_at FROM offline_queue WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [req.user.id]) });
  }));
  app.post('/api/desktop/queue/run', auth.requireUser, wrap(async (req, res) => {
    if (!(await probe())) return res.status(503).json({ success: false, message: 'Still offline — the queue runs automatically when the connection returns.' });
    res.json({ success: true, ...(await processQueue()) });
  }));
  app.delete('/api/desktop/queue/:id', auth.requireUser, wrap(async (req, res) => {
    await db.query('DELETE FROM offline_queue WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  }));
} else {
  // ---------------------------------------------------------------- web platform: endpoints for desktop devices
  app.use('/api', require('./src/routes/sync'));

  // Vercel Cron (vercel.json): dataset refresh (weekly freshness rule), alerts, retraction monitoring, job clean-up
  app.get('/api/cron/daily', wrap(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ success: false, message: 'Unauthorized.' });
    await purgeJobs();
    // time-boxed: the stalest datasets first, the rest on the following days (all of them at once exceeded the function time limit)
    const datasets = await D.ensureDatasets({ budgetMs: 60000 });
    const alerts = await require('./src/alerts').runAlerts();
    const monitoring = await require('./src/integrity/monitoring').runMonitor({ limit: 150 }).catch(e => ({ error: e.message }));
    // Module 5: newly published PJPS papers into the image reference database (time-boxed; the rest follows tomorrow)
    const pjpsFigures = await require('./src/imageRefs').indexPjps({ limit: 40, budgetMs: 120000 }).catch(e => ({ error: e.message }));
    res.json({ success: true, datasets, alerts, monitoring, pjpsFigures });
  }));
}

// ------------------------------------------------------------------ errors & startup

app.use('/api', (req, res) => res.status(404).json({ success: false, message: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, message: `The file is too large (limit ${cfg.MAX_UPLOAD_MB} MB).` });
  res.status(err.status || 500).json({ success: false, message: err.message || 'Unexpected server error.' });
});

/**
 * Start listening. Web: PORT (next free port if taken). Desktop: 127.0.0.1 only, any free port.
 * Resolves with the port in use.
 */
async function start({ port = cfg.PORT, host = cfg.DESKTOP ? '127.0.0.1' : undefined } = {}) {
  await db.init();
  await auth.seedAdmin();
  const actual = await new Promise((resolve, reject) => {
    const listen = p => {
      const server = app.listen(p, host, () => resolve(server.address().port));
      server.on('error', err => {
        if (err.code === 'EADDRINUSE' && p) { console.log(`Port ${p} in use, trying ${p + 1}…`); listen(p + 1); } else reject(err);
      });
    };
    listen(port);
  });
  console.log(`${cfg.APP_NAME} ${cfg.DESKTOP ? '(desktop)' : ''} running at http://${host || 'localhost'}:${actual}`);
  if (cfg.DESKTOP) {
    require('./src/queue').startQueueWatcher();
    require('./src/desktop').startSyncTimer();
    probe().catch(() => {});
  } else {
    // Keep Retraction Watch / Beall's list fresh (weekly) without blocking startup; alerts once a day
    D.ensureDatasets().catch(e => console.error('Dataset refresh failed:', e.message));
    const alerts = require('./src/alerts');
    const monitor = () => require('./src/integrity/monitoring').runMonitor({ limit: 150 }).catch(e => console.error('Article monitoring failed:', e.message));
    const pjpsFigures = () => require('./src/imageRefs').indexPjps({ limit: 60 }).then(r => console.log(`PJPS figure database: ${r.articles} new article(s), ${r.panels} panel(s)`)).catch(e => console.error('PJPS figure indexing failed:', e.message));
    setInterval(() => { purgeJobs(); D.ensureDatasets().catch(() => {}); alerts.runAlerts().catch(e => console.error('Alerts failed:', e.message)); monitor(); pjpsFigures(); }, 24 * 3600 * 1000).unref();
    setTimeout(() => alerts.runAlerts().catch(() => {}), 60000).unref();
  }
  return actual;
}

if (require.main === module && !process.env.VERCEL) start().catch(e => { console.error('Startup failed:', e); process.exit(1); });

module.exports = app;
module.exports.start = start;
