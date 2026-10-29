// test/smoke-web.js - boots the web edition on an in-memory database and exercises auth, Super Admin user management
// and permissions. Run: node test/smoke-web.js
process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.PORT = '0';
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;
const assert = require('assert');

(async () => {
  const app = require('../server');
  const port = await app.start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const jar = {};
  const call = async (who, method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(jar[who] ? { Cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get('set-cookie');
    if (c) jar[who] = c.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  // Self-registration is gone
  assert.strictEqual((await call('x', 'POST', '/api/auth/register', { email: 'a@b.c' })).status, 404);
  // Super Admin signs in
  let r = await call('admin', 'POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123' });
  assert.ok(r.data.success, 'admin login'); assert.strictEqual(r.data.user.role, 'super_admin');
  // Creates a researcher with web access only and a desktop-only editor
  r = await call('admin', 'POST', '/api/admin/users', { email: 'res@test.local', name: 'Rana Researcher', role: 'researcher', allowWeb: true, allowDesktop: false });
  assert.ok(r.data.success && r.data.password, 'create researcher'); const resPw = r.data.password; const resId = r.data.user.id;
  r = await call('admin', 'POST', '/api/admin/users', { email: 'ed@test.local', name: 'Erum Editor', role: 'editor', allowWeb: false, allowDesktop: true, password: 'editor-pass-1' });
  assert.ok(r.data.success, 'create editor');
  // Every account type gets the desktop application unless the Super Admin unticks it
  r = await call('admin', 'POST', '/api/admin/users', { email: 'rev@test.local', name: 'Rafia Reviewer', role: 'reviewer' });
  assert.ok(r.data.success && r.data.user.allowDesktop !== false, 'desktop access by default');
  assert.strictEqual((await require('../src/db').one("SELECT allow_desktop FROM users WHERE email = 'rev@test.local'")).allow_desktop, true, 'desktop access stored');
  // Duplicate e-mail rejected
  assert.strictEqual((await call('admin', 'POST', '/api/admin/users', { email: 'res@test.local', name: 'Dup User' })).status, 409);
  // Researcher signs in on the web, must change password, has no editor tools
  r = await call('res', 'POST', '/api/auth/login', { email: 'res@test.local', password: resPw });
  assert.ok(r.data.success && r.data.user.mustChangePassword, 'researcher login');
  assert.ok(!r.data.user.permissions.includes('papermill') && !r.data.user.permissions.includes('images') && r.data.user.permissions.includes('restyle') && r.data.user.permissions.includes('citations'), 'reviewer permissions: Modules 1-3 only');
  assert.strictEqual((await call('res', 'POST', '/api/reviewers', { title: 'A sufficiently long manuscript title' })).status, 403, 'switched-off tool refused');
  assert.strictEqual((await call('res', 'POST', '/api/images', { result: { findings: [] } })).status, 403, 'reviewer blocked from Module 5');
  assert.strictEqual((await call('res', 'GET', '/api/admin/users')).status, 403, 'researcher blocked from admin');
  r = await call('res', 'POST', '/api/auth/password', { current: resPw, next: 'new-pass-456' });
  assert.ok(r.data.success, 'password change');
  // Desktop-only editor cannot use the web
  r = await call('ed', 'POST', '/api/auth/login', { email: 'ed@test.local', password: 'editor-pass-1' });
  assert.strictEqual(r.status, 403, 'desktop-only user blocked on web');
  // ...but can sign in through the desktop device endpoint
  r = await call('dev', 'POST', '/api/desktop/login', { email: 'ed@test.local', password: 'editor-pass-1', device: { name: 'PC-1' } });
  assert.ok(r.data.success && r.data.token, 'desktop device login'); const token = r.data.token;
  let m = await fetch(base + '/api/sync/manifest', { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(m.status, 200, 'manifest with device token');
  // Researcher (no desktop access) cannot link a desktop
  assert.strictEqual((await call('dev2', 'POST', '/api/desktop/login', { email: 'res@test.local', password: 'new-pass-456' })).status, 403);
  // Restrict the researcher's modules, then suspend: session ends
  r = await call('admin', 'PATCH', `/api/admin/users/${resId}`, { permissions: ['references', 'journal-check'] });
  assert.ok(r.data.success);
  r = await call('res', 'GET', '/api/auth/me');
  assert.deepStrictEqual(r.data.user.permissions.sort(), ['references'], 'switched-off modules are not granted');
  await call('admin', 'PATCH', `/api/admin/users/${resId}`, { status: 'suspended' });
  r = await call('res', 'GET', '/api/auth/me');
  assert.strictEqual(r.data.user, null, 'suspended user signed out');
  // Super Admin cannot remove the last Super Admin
  r = await call('admin', 'GET', '/api/auth/me');
  assert.strictEqual((await call('admin', 'PATCH', `/api/admin/users/${r.data.user.id}`, { role: 'editor' })).status, 400);
  // Revoking the editor's desktop access invalidates the device
  const users = (await call('admin', 'GET', '/api/admin/users')).data.users;
  const ed = users.find(u => u.email === 'ed@test.local');
  await call('admin', 'PATCH', `/api/admin/users/${ed.id}`, { allowDesktop: false });
  m = await fetch(base + '/api/sync/manifest', { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(m.status, 401, 'revoked device refused');
  // Audit log recorded the actions
  r = await call('admin', 'GET', '/api/admin/audit');
  assert.ok(r.data.entries.some(e => e.action === 'user-created') && r.data.entries.some(e => e.action === 'user-suspended'));
  // App metadata for the UI
  r = await call('admin', 'GET', '/api/app');
  assert.ok(r.data.styles.length >= 20 && r.data.modules.some(m => m.key === 'papermill') && r.data.modules.some(m => m.key === 'images'));

  // ---- PJPS modules (offline-safe parts)
  const wait = async id => { for (let i = 0; i < 240; i++) { await new Promise(res => setTimeout(res, 500)); const j = (await call('admin', 'GET', `/api/jobs/${id}`)).data; if (j.status === 'done' || j.status === 'error') return j; } throw new Error('job timeout'); };
  // Module 2: compliance on a pasted list without online lookup
  const fd = new FormData();
  fd.append('text', 'Khan, A., Ali, B. & Shah, C. (2019). Antibacterial Activity Of Medicinal Plants. Pakistan Journal of Pharmaceutical Sciences, Vol. 32, No. 1, pp. 1–5.\nAli B and Khan A (2018). Effect of curcumin on wound healing in rats. Pak. J. Pharm. Sci., 31(2): 455-460.');
  fd.append('style', 'pjps'); fd.append('lookup', 'false'); fd.append('save', 'true');
  let resp = await fetch(base + '/api/restyle', { method: 'POST', body: fd, headers: { Cookie: jar.admin } });
  let j = await wait((await resp.json()).jobId);
  assert.strictEqual(j.status, 'done', 'restyle: ' + j.error);
  assert.ok(j.result.compliance && j.result.compliance.summary.total === 2 && j.result.compliance.summary.nonCompliant >= 1, 'Module 2 compliance');
  assert.ok(j.result.compliance.entries[0].deviations.some(d => d.rule === 'journal'), 'journal abbreviation rule');
  console.log('  ✓ Module 2 compliance:', j.result.compliance.summary.score + '% compliant');

  // Module 4: paper mill text signals (no references -> no network)
  const ms = `Antitumour effect of a plant extract\nAhmad Khan, Sara Ali\nahmad@gmail.com\n\nAbstract\nWe studied counterfeit consciousness and bosom peril. As an AI language model I cannot.\n\nMaterials and methods\nWistar rats were used. HEp-2 cells were grown. Network pharmacology, molecular docking, hub genes and KEGG enrichment were used via the PI3K/AKT signaling pathway.\n\nResults\nThe extract inhibited proliferation, migration and invasion. ` + 'Lorem text about results. '.repeat(20);
  r = await call('admin', 'POST', '/api/papermill', { text: ms, manuscriptCode: 'PJPS-TEST-1', authors: 'Ahmad Khan\nSara Ali' });
  assert.ok(r.data.success, 'papermill start: ' + r.data.message);
  j = await wait(r.data.jobId);
  assert.strictEqual(j.status, 'done', 'papermill: ' + j.error);
  const codes = j.result.signals.map(x => x.code);
  assert.ok(['tortured', 'ai-leftover', 'template', 'cell-lines', 'methods'].every(c => codes.includes(c)), 'paper mill signals: ' + codes.join(','));
  assert.ok(['MEDIUM', 'HIGH'].includes(j.result.risk.level), 'paper mill risk level');
  const pmId = j.result.id;
  console.log('  ✓ Module 4:', j.result.risk.level, codes.join(', '));
  // Second submission with the same text under another ID -> duplicate submission signal
  r = await call('admin', 'POST', '/api/papermill', { text: ms, manuscriptCode: 'PJPS-TEST-2' });
  j = await wait(r.data.jobId);
  assert.ok(j.result.signals.some(x => x.code === 'duplicate'), 'duplicate submission detected');
  console.log('  ✓ Module 4: duplicate submission found');
  // Decision record + confidential export
  r = await call('admin', 'PUT', `/api/checks/${pmId}/decision`, { decision: 'investigate', notes: 'Asked for raw data' });
  assert.ok(r.data.success && r.data.decision.label === 'Needs investigation');
  resp = await fetch(base + `/api/checks/${pmId}/confidential`, { headers: { Cookie: jar.admin } });
  assert.strictEqual(resp.status, 200, 'papermill Word export');
  assert.ok((await resp.arrayBuffer()).byteLength > 3000);

  // Module 5: save a browser analysis, then a second manuscript sharing a figure is matched
  const panel = (id, h) => ({ id, label: id, imageId: 'img1', type: 'photo', box: { x: 0, y: 0, w: 120, h: 90 }, hashes: Array(8).fill(h), thumb: 'data:image/jpeg;base64,/9j/4AAQ' });
  const tiny = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  r = await call('admin', 'POST', '/api/images', { result: { meta: { manuscriptCode: 'PJPS-IMG-1', title: 'First' }, summary: { images: 1 }, panels: [panel('p1', '0f0f0f0f12345678'), panel('p2', 'ffff0000aaaa5555')], findings: [{ id: 'f1', kind: 'duplicate', level: 'high', description: 'test', a: { panel: 'p1', label: 'Fig. 1A' }, b: { panel: 'p2', label: 'Fig. 2B' }, thumbA: tiny, thumbAW: 1, thumbAH: 1, thumbB: tiny, thumbBW: 1, thumbBH: 1 }] } });
  assert.ok(r.data.success && r.data.result.summary.level === 'HIGH', 'Module 5 saved');
  assert.deepStrictEqual(r.data.result.panels[0].box, { x: 0, y: 0, w: 120, h: 90 }, 'panel position kept (forensic viewer crops to it)');
  assert.ok(Array.isArray(r.data.result.references) && r.data.result.referencesSearched, 'compared with the image reference databases');
  const imgId = r.data.id;
  r = await call('admin', 'POST', '/api/images', { result: { meta: { manuscriptCode: 'PJPS-IMG-2' }, summary: { images: 1 }, panels: [panel('q1', '0f0f0f0f12345679')], findings: [] } });
  assert.ok(r.data.earlier.length === 1 && r.data.earlier[0].manuscriptCode === 'PJPS-IMG-1', 'figure re-used from an earlier manuscript');
  resp = await fetch(base + `/api/checks/${imgId}/confidential`, { headers: { Cookie: jar.admin } });
  assert.strictEqual(resp.status, 200, 'image report Word export with images');
  console.log('  ✓ Module 5: saved, earlier-manuscript match, confidential export');

  // Module 5 (b)-(d): alteration, AI-image and chart findings; chart data compared with earlier manuscripts
  const bars = (code, label, v) => ({ label, kind: 'bars', v, spread: 0.7 });
  const mk = (code, charts, findings) => ({ result: { meta: { manuscriptCode: code }, summary: { images: 1 }, panels: [panel(code + 'p', 'aaaa5555aaaa5555')], charts, provenance: 1, findings } });
  const aiFinding = { id: 'f1', kind: 'ai', category: 'ai', level: 'high', description: 'marker', details: ['IPTC digital source type: AI-generated'], a: { panel: 'x', label: 'Fig. 4' }, b: { panel: 'x', label: 'Fig. 4' } };
  const altFinding = { id: 'f2', kind: 'alteration', category: 'manipulation', level: 'medium', description: 'smooth patch', details: [], a: { panel: 'x', label: 'Fig. 5', box: { x: 1, y: 1, w: 5, h: 5 } }, b: { panel: 'x', label: 'Fig. 5', box: { x: 1, y: 1, w: 5, h: 5 } } };
  r = await call('admin', 'POST', '/api/images', mk('PJPS-CH-1', [bars(0, 'Fig. 3 left', [62, 118, 87, 154, 121, 176])], [aiFinding, altFinding]));
  assert.ok(r.data.result.summary.byCategory.ai === 1 && r.data.result.summary.byCategory.manipulation === 1 && r.data.result.coverage.chart.done, 'categories counted');
  r = await call('admin', 'POST', '/api/images', mk('PJPS-CH-2', [bars(0, 'Fig. 2 right', [70, 133, 97, 172, 136, 197])], []));
  assert.ok(r.data.result.earlierCharts.length === 1 && r.data.result.earlierCharts[0].manuscriptCode === 'PJPS-CH-1', 'same chart data in an earlier manuscript');
  assert.ok(r.data.result.summary.level === 'HIGH', 'chart reuse raises the image risk');
  console.log('  ✓ Module 5: alteration / AI / chart findings and chart reuse across manuscripts');

  // Module 1 settings
  r = await call('admin', 'PUT', '/api/settings/age-rule', { years: 5, minShare: 40 });
  assert.ok(r.data.success && r.data.rule.minShare === 40);
  console.log('web smoke test: all assertions passed');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
