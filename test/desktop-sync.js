// test/desktop-sync.js - the desktop application against a web platform, both on in-memory databases:
// desktop sign-in, synchronisation of every dataset table, and Module 5 searching the platform's image reference
// databases (with thumbnails). Run: node test/desktop-sync.js
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const HASH = 'f0f0a5a5c3c3e1e1';
const PANEL_HASHES = [HASH, '0f0f5a5a3c3c1e1e', '1111222233334444', '5555666677778888', '9999aaaabbbbcccc', 'ddddeeeeffff0000', '0123456789abcdef', 'fedcba9876543210'];

// ------------------------------------------------------------------ child process: the web platform
if (process.argv[2] === 'platform') {
  process.env.PGLITE_DIR = 'memory://';
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-pass-123';
  delete process.env.APP_MODE;
  delete process.env.DATABASE_URL;
  for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) process.env[k] = '';
  // Module 5.7: only the platform holds the ImageTwin key; api.imagetwin.ai is stubbed with its documented responses
  process.env.IMAGETWIN_API_KEY = 'it-test-key';
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.imagetwin.ai/')) return realFetch(url, init);
    const body = String(url).endsWith('/v1/scan') ? { scanId: 'scan-from-desktop-1', message: 'ok' }
      : { scanId: 'scan-from-desktop-1', alterationCount: 0, localDuplicateCount: 1, externDuplicateCount: 2, aiImageCount: 0, minScore: 0.33, highestScore: 0.7, pdfReport: 'https://x/r.pdf', resultUrl: 'https://x/r' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  (async () => {
    const server = require('../server');
    const db = require('../src/db');
    const port = await server.start({ port: 0 });
    const now = new Date().toISOString();
    await db.query("INSERT INTO nlm_journals(nlm_id, title, title_norm, iso_abbr, issn, pubmed) VALUES('9426534', 'Pakistan journal of pharmaceutical sciences', 'pakistan journal of pharmaceutical sciences', 'Pak J Pharm Sci', '1011-601X', true)");
    await db.query("INSERT INTO email_domains(domain, kind) VALUES('mailinator.com', 'disposable'), ('gmail.com', 'freemail')");
    await db.query("INSERT INTO retractions(doi, title, journal, nature) VALUES('10.1000/retracted.1', 'A retracted paper', 'J Test', 'Retraction')");
    await db.query("INSERT INTO pps_fingerprints(kind, terms, papers) VALUES('tortured', '[\"bosom peril\"]', 12)");
    for (const [k, n] of [['nlm', 1], ['maildom', 2], ['rw', 1], ['pps', 1]]) { await db.setMeta(`${k}_loaded_at`, now); await db.setMeta(`${k}_count`, String(n)); }
    const doc = await db.one("INSERT INTO image_ref_docs(source, source_key, title, journal, year, status, figures, panels) VALUES('pjps', '8001', 'A published PJPS paper', 'Pak. J. Pharm. Sci.', 2025, 'done', 1, 1) RETURNING id");
    await db.query("INSERT INTO image_refs(doc_id, source, figure, panel, type, hashes, w, h) VALUES($1, 'pjps', 'Fig. 2', 'B', 'photo', $2, 200, 150)", [doc.id, [HASH, ...Array(5).fill('0000000000000000')].join(',')]);
    await db.setMeta('imgref_version', String(Date.now()));
    process.stdout.write(`PORT=${port}\n`);
  })().catch(e => { console.error(e); process.exit(1); });
  return;
}

// ------------------------------------------------------------------ this process: the desktop application
(async () => {
  const child = spawn(process.execPath, [__filename, 'platform'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const remotePort = await new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', d => { buf += d; const m = buf.match(/PORT=(\d+)/); if (m) resolve(m[1]); });
    child.on('exit', c => reject(new Error(`platform exited (${c})`)));
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pjps-desk-'));
  Object.assign(process.env, { APP_MODE: 'desktop', PGLITE_DIR: 'memory://', DATA_DIR: dataDir, REMOTE_URL: `http://127.0.0.1:${remotePort}`, ENV_FILE: path.join(dataDir, 'none.env') });
  delete process.env.DATABASE_URL;
  try {
    const server = require('../server');
    const db = require('../src/db');
    const port = await server.start({ port: 0 });
    const base = `http://127.0.0.1:${port}`;
    let cookie = '';
    const call = async (method, p, body) => {
      const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const c = r.headers.get('set-cookie');
      if (c) cookie = c.split(';')[0];
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };

    let r = await call('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123' });
    assert.ok(r.data.success && r.data.online, 'desktop sign-in through the web platform');
    // the sign-in starts a background sync; wait for it, then run one explicitly through the job queue
    r = await call('POST', '/api/desktop/sync', { datasets: true });
    assert.ok(r.data.jobId, 'sync job');
    let job;
    for (let i = 0; i < 360; i++) { // up to 90 s: a busy machine slows the in-memory databases down
      job = (await call('GET', `/api/jobs/${r.data.jobId}`)).data;
      if (job.status === 'done' || job.status === 'error') break;
      await new Promise(res => setTimeout(res, 250));
    }
    assert.strictEqual(job.status, 'done', `sync finished: ${job.error || ''}`);
    const count = async t => (await db.one(`SELECT COUNT(*)::int AS n FROM ${t}`)).n;
    assert.strictEqual(await count('nlm_journals'), 1, 'NLM Catalog copied');
    assert.strictEqual(await count('email_domains'), 2, 'e-mail domains copied');
    assert.strictEqual(await count('retractions'), 1, 'Retraction Watch copied');
    assert.strictEqual(await count('pps_fingerprints'), 1, 'PPS fingerprints copied');
    assert.strictEqual((await db.one("SELECT pubmed FROM nlm_journals WHERE nlm_id = '9426534'")).pubmed, true, 'boolean column kept');
    assert.strictEqual(await db.getMeta('nlm_count'), '1');
    console.log('  ✓ desktop sign-in and dataset sync (Retraction Watch, PPS, NLM Catalog, e-mail domains)');

    // Module 5: the panel matches a published PJPS figure held only on the platform
    const panel = { id: 'p1', label: 'Figure 1 panel A', type: 'photo', hashes: PANEL_HASHES, windows: [], w: 200, h: 150 };
    r = await call('POST', '/api/images', { result: { meta: { title: 'Desktop image check' }, summary: { images: 1 }, panels: [panel], findings: [] } });
    assert.ok(r.data.success, `image check saved: ${r.data.message || ''}`);
    const result = r.data.result || (await call('GET', `/api/checks/${r.data.id}`)).data.check?.result;
    assert.ok(result, 'image result');
    assert.strictEqual(result.referencesError, null, `platform databases searched: ${result.referencesError}`);
    assert.strictEqual(result.references.length, 1, 'published PJPS figure found from the desktop');
    assert.strictEqual(result.references[0].source, 'pjps');
    assert.strictEqual(result.referencesSearched.refs, 1);
    r = await call('GET', '/api/images/databases');
    assert.ok(r.data.onPlatform && r.data.bySource.pjps.papers === 1, 'database counts come from the platform');
    console.log('  ✓ Module 5 on the desktop searches the platform image databases');

    // Module 5.7: ImageTwin from the desktop goes through the platform (the desktop has no key)
    delete process.env.IMAGETWIN_API_KEY;
    r = await call('GET', '/api/images/vendor');
    assert.ok(r.data.connected && r.data.viaPlatform, 'ImageTwin connected through the platform');
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('%PDF-1.4 test manuscript')], { type: 'application/pdf' }), 'PJPS-2026-0001.pdf');
    fd.append('confirm', 'true');
    fd.append('manuscriptCode', 'PJPS-2026-0001');
    let v = await (await fetch(`${base}/api/images/vendor/scan`, { method: 'POST', headers: { Cookie: cookie }, body: fd })).json();
    assert.ok(v.success && v.scan.status === 'running' && /via web platform/.test(v.scan.vendor), `desktop scan started through the platform: ${v.message || ''}`);
    v = (await call('GET', `/api/images/vendor/scans/${v.scan.id}`)).data;
    assert.ok(v.scan.status === 'finished' && v.scan.result.externalDuplicates === 2 && v.scan.level === 'HIGH', 'desktop receives the ImageTwin result');
    const unconfirmed = new FormData();
    unconfirmed.append('file', new Blob([Buffer.from('x')]), 'a.pdf');
    assert.strictEqual((await fetch(`${base}/api/images/vendor/scan`, { method: 'POST', headers: { Cookie: cookie }, body: unconfirmed })).status, 400, 'nothing is sent without the editor confirming');
    console.log('  ✓ ImageTwin from the desktop through the platform (key stays on the platform; confirmation required)');

    // Offline: the check still runs and says what was not searched
    process.env.SIMULATE_OFFLINE = '1';
    require('../src/http').probe && await require('../src/http').probe().catch(() => {});
    r = await call('POST', '/api/images', { result: { meta: { title: 'Offline image check' }, summary: { images: 1 }, panels: [panel], findings: [] } });
    const off = r.data.result || (await call('GET', `/api/checks/${r.data.id}`)).data.check?.result;
    assert.ok(off && /could not be searched/.test(off.referencesError || ''), 'offline note in the report');
    console.log('  ✓ offline image check runs and reports the platform databases as not searched');
    console.log('desktop sync test: all assertions passed');
    await db.close();
  } finally {
    child.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
