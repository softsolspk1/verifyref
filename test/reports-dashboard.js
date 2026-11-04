// test/reports-dashboard.js - Super Admin Reports page (every user's reports) and Dashboard analytics. Run: node test/reports-dashboard.js
process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.PORT = '0';
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;
const assert = require('assert');

(async () => {
  const app = require('../server');
  const db = require('../src/db');
  const port = await app.start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const jar = {};
  const call = async (who, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get('set-cookie');
    if (c) jar[who] = c.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  assert.ok((await call('admin', 'POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123' })).data.success);
  assert.ok((await call('admin', 'POST', '/api/admin/users', { email: 'sa2@test.local', name: 'Second Admin', role: 'super_admin', password: 'second-pass-1' })).data.success);
  assert.ok((await call('admin', 'POST', '/api/admin/users', { email: 'ed@test.local', name: 'Erum Editor', role: 'editor', password: 'editor-pass-1' })).data.success);
  const id = async e => (await db.one('SELECT id FROM users WHERE email = $1', [e])).id;
  const [a1, a2, ed] = [await id('admin@test.local'), await id('sa2@test.local'), await id('ed@test.local')];
  const ins = (u, kind, extra = {}) => db.query(`INSERT INTO checks(user_id, kind, manuscript_code, title, ref_total, verified, suspicious, retracted, problems, result)
    VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, '{}'::jsonb)`, [u, kind, extra.code || null, extra.title || 'T', extra.refs || 0, extra.verified || 0, extra.suspicious || 0, extra.retracted || 0, JSON.stringify(extra.problems || [])]);
  await ins(a2, 'references', { code: 'PJPS-1', refs: 30, verified: 25, suspicious: 3, retracted: 2 });
  await ins(ed, 'papermill', { code: 'PJPS-2', problems: ['Paper-mill risk HIGH (score 72)'] });
  await ins(ed, 'images', { code: 'PJPS-2', problems: ['Image risk LOW'] });
  await ins(a1, 'citations', { title: 'Own' });

  // The first Super Admin sees reports by the other Super Admin and the editor
  let r = await call('admin', 'GET', '/api/reports');
  assert.strictEqual(r.data.items.length, 4, 'all reports');
  assert.ok(r.data.items.some(i => i.user_id === a2) && r.data.items.some(i => i.user_id === ed));
  assert.strictEqual((await call('admin', 'GET', `/api/reports?user=${ed}`)).data.items.length, 2, 'user filter');
  assert.strictEqual((await call('admin', 'GET', '/api/reports?q=PJPS-1')).data.items.length, 1, 'search');
  // and can open another Super Admin's report read-only
  const other = r.data.items.find(i => i.user_id === a2).id;
  r = await call('admin', 'GET', `/api/checks/${other}`);
  assert.ok(r.data.success && r.data.readOnly, 'open other admin report');

  // Dashboard: everything for the Super Admin
  r = await call('admin', 'GET', '/api/dashboard?days=30');
  assert.strictEqual(r.data.scope, 'all');
  assert.strictEqual(r.data.totals.reports, 4);
  assert.strictEqual(r.data.totals.articles, 3, 'distinct articles');
  assert.strictEqual(r.data.totals.retracted, 2);
  assert.strictEqual(r.data.risk.papermill.HIGH, 1);
  assert.strictEqual(r.data.risk.images.LOW, 1);
  assert.strictEqual(r.data.byUser.length, 3);

  // Novelty statistics of the Full Screening Reports: full result, R2 stub carrying the summary, not assessed, stub not yet backfilled
  const R = require('../src/reportStore');
  const nvFull = { kind: 'novelty', summary: { score: 82, band: 'high', level: 'ok', maxSimilarity: 0.21, closeWorks: 1, closeRecent: 1, outlook: 'moderate', fiveYearMedian: 18, confidence: 'high' },
    closest: [{ title: 'Closest work A', year: 2022, journal: 'J A', similarity: 0.21, url: 'https://doi.org/10.1/a' }] };
  const nvLow = { kind: 'novelty', summary: { score: 31, band: 'low', level: 'warn', maxSimilarity: 0.64, closeWorks: 6, closeRecent: 4, outlook: 'low', fiveYearMedian: 6, confidence: 'moderate' }, closest: [{ title: 'Closest work B', year: 2024, similarity: 0.64 }] };
  const stubbed = R.stub({ kind: 'manuscript', meta: {}, novelty: nvLow }, 'reports/x.json.gz');
  assert.deepStrictEqual(stubbed.novelty.summary, nvLow.summary, 'stub keeps the novelty summary');
  const insMs = (code, result) => db.query(`INSERT INTO checks(user_id, kind, manuscript_code, title, result) VALUES($1, 'manuscript', $2, $3, $4)`, [ed, code, `Manuscript ${code}`, JSON.stringify(result)]);
  await insMs('PJPS-10', { kind: 'manuscript', novelty: nvFull });
  await insMs('PJPS-11', stubbed);
  await insMs('PJPS-12', { kind: 'manuscript', novelty: { kind: 'novelty', error: 'OpenAlex and Europe PMC did not answer' } });
  await insMs('PJPS-13', { _r2: 'reports/missing.json.gz', kind: 'manuscript' });
  r = await call('admin', 'GET', '/api/dashboard?days=30');
  const nv = r.data.novelty;
  assert.strictEqual(nv.assessed, 2, 'novelty assessed');
  assert.strictEqual(nv.notAssessed, 1, 'novelty not assessed');
  assert.strictEqual(nv.pending, 1, 'stub without novelty, storage unreachable');
  assert.strictEqual(nv.averageScore, 56.5);
  assert.deepStrictEqual(nv.bands, { high: 1, moderate: 0, low: 1 });
  assert.strictEqual(nv.outlook.low, 1);
  assert.strictEqual(nv.histogram[8].n, 1, '80-89 bin');
  assert.strictEqual(nv.histogram[3].n, 1, '30-39 bin');
  assert.strictEqual(nv.closeRecent, 5);
  assert.strictEqual(nv.items.length, 3);
  assert.strictEqual(nv.items.find(i => i.manuscript_code === 'PJPS-10').closest.title, 'Closest work A');
  assert.strictEqual((await call('admin', 'GET', `/api/dashboard?days=30&user=${a1}`)).data.novelty.assessed, 0, 'user filter applies to novelty');

  // An editor: no Reports page and no Dashboard
  r = await call('ed', 'POST', '/api/auth/login', { email: 'ed@test.local', password: 'editor-pass-1' });
  assert.ok(r.data.success);
  if (r.data.user.mustChangePassword) await call('ed', 'POST', '/api/auth/password', { current: 'editor-pass-1', password: 'editor-pass-2x' });
  assert.strictEqual((await call('ed', 'GET', '/api/reports')).status, 403, 'reports is Super Admin only');
  assert.strictEqual((await call('ed', 'GET', '/api/dashboard?days=30')).status, 403, 'dashboard is Super Admin only');
  console.log('reports-dashboard: all checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
