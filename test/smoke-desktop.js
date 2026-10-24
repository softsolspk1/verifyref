// test/smoke-desktop.js - desktop edition against a running web platform: online sign-in, sync, offline sign-in,
// offline check with pending references, queued tool run, then reconnection.
// Run: REMOTE_URL=http://localhost:3105 DESK_EMAIL=… DESK_PASSWORD=… node test/smoke-desktop.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pjps-desk-'));
process.env.APP_MODE = 'desktop';
process.env.PGLITE_DIR = path.join(dir, 'db');
delete process.env.DATABASE_URL;
const { REMOTE_URL, DESK_EMAIL, DESK_PASSWORD } = process.env;

(async () => {
  const app = require('../server');
  const port = await app.start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const wait = async id => { for (;;) { await new Promise(r => setTimeout(r, 1000)); const j = (await call('GET', `/api/jobs/${id}`)).data; if (j.status === 'done' || j.status === 'error') return j; } };

  // First sign-in must be online
  assert.strictEqual((await call('POST', '/api/desktop/settings', { remoteUrl: REMOTE_URL })).status, 200);
  let r = await call('POST', '/api/auth/login', { email: DESK_EMAIL, password: DESK_PASSWORD });
  assert.ok(r.data.success && r.data.online, 'online desktop sign-in: ' + r.data.message);
  console.log('✓ online sign-in through the web platform');

  r = await call('POST', '/api/desktop/sync', { datasets: true });
  let j = await wait(r.data.jobId);
  assert.strictEqual(j.status, 'done', 'sync: ' + j.error);
  console.log('✓ synchronised:', JSON.stringify(j.result));

  // Online check of one real reference -> cached
  const refs = 'Hewlings SJ and Kalman DS (2017). Curcumin: A review of its effects on human health. Foods, 6(10): 92.';
  r = await call('POST', '/api/checks', { kind: 'references', referencesText: refs });
  j = await wait(r.data.jobId);
  const online = j.result.references.results[0];
  assert.ok(online.record && ['verified', 'miscited'].includes(online.status), 'online status ' + online.status);
  console.log(`✓ online reference check: ${online.statusLabel} (record found in ${online.matchedIn.join(', ')})`);

  // ---- go offline
  process.env.SIMULATE_OFFLINE = '1';
  await call('POST', '/api/auth/logout', {});
  cookie = '';
  r = await call('POST', '/api/auth/login', { email: DESK_EMAIL, password: DESK_PASSWORD });
  assert.ok(r.data.success && r.data.online === false, 'offline sign-in: ' + r.data.message);
  console.log('✓ offline sign-in:', r.data.message);
  assert.strictEqual((await call('POST', '/api/auth/login', { email: DESK_EMAIL, password: 'wrong-password' })).status, 401);
  console.log('✓ wrong password rejected offline');

  // Offline: cached reference verifies, unknown one becomes "pending" (not "suspicious") and is queued
  const unknown = 'Zafar QR and Imran T (2024). Unseen offline reference about hepatoprotective peptides. Pak J Pharm Sci, 37(1): 1-9.';
  r = await call('POST', '/api/checks', { kind: 'references', referencesText: `${refs}\n${unknown}` });
  j = await wait(r.data.jobId);
  const st = j.result.references.results.map(x => x.status);
  assert.ok(st[0] === online.status && st[1] === 'pending', 'offline statuses ' + st);
  assert.strictEqual(j.result.queuedForOnline, 1);
  console.log('✓ offline check: cached reference verified, unknown one pending and queued');

  // Offline: Citation Check and Reference Style still work
  r = await call('POST', '/api/checks', { kind: 'citations', text: `Curcumin helps (Hewlings and Kalman, 2017). Uncited claim (Missing, 2020). ${'Body text. '.repeat(30)}\nReferences\n${refs}` });
  j = await wait(r.data.jobId);
  assert.ok(j.result.citations.summary, 'citation check offline');
  console.log('✓ offline Citation Check:', JSON.stringify(j.result.citations.summary));

  // Offline: online-only tools are queued
  r = await call('POST', '/api/evidence', { claim: 'Curcumin reduces markers of inflammation in adults with arthritis.' });
  assert.ok(r.data.queued, 'evidence queued');
  const q = (await call('GET', '/api/desktop/queue')).data.items;
  assert.strictEqual(q.filter(i => i.status === 'waiting').length, 2);
  console.log('✓ Find Evidence queued offline; queue has', q.length, 'items');

  // ---- back online: the queue runs
  delete process.env.SIMULATE_OFFLINE;
  r = await call('POST', '/api/desktop/queue/run', {});
  assert.ok(r.data.success, 'queue run: ' + r.data.message);
  const after = (await call('GET', '/api/desktop/queue')).data.items;
  console.log('✓ queue processed:', after.map(i => `${i.label} → ${i.status}${i.error ? ' (' + i.error + ')' : ''}`).join('; '));
  const notes = (await call('GET', '/api/notifications')).data.notifications;
  console.log('✓ notifications:', notes.map(n => n.title).join(' | '));

  // Sync pushes the reports made on this computer to the web platform
  r = await call('POST', '/api/desktop/sync', { datasets: false });
  j = await wait(r.data.jobId);
  assert.strictEqual(j.status, 'done', 'second sync: ' + j.error);
  console.log('✓ second sync:', JSON.stringify(j.result));
  console.log('desktop smoke test: all assertions passed');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
