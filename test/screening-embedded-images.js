// screening-embedded-images.js - an image report made by the Full Screening Report is shown only inside that report:
// not in Saved reports / My Activity / the "attach a Module 5 report" list, still loadable by id, deleted with it.
process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
delete process.env.APP_MODE;
process.env.R2_BUCKET = '';
const assert = require('assert');
const { start } = require('../server');

(async () => {
  const port = await start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const api = async (path, { method = 'GET', body } = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    return r.json();
  };
  const job = async id => { for (let i = 0; i < 240; i++) { const j = await api(`/api/jobs/${id}`); if (j.job?.status === 'done' || j.job?.status === 'error' || j.status === 'done' || j.status === 'error') return j.job || j; await new Promise(r => setTimeout(r, 500)); } throw new Error('job timeout'); };
  assert.ok((await api('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'admin-pass-123' } })).success, 'login');

  // a Module 5 analysis as the browser sends it (no figures matter here)
  const img = await api('/api/images', { method: 'POST', body: { result: { meta: { title: 'Embedded test' }, panels: [], findings: [], charts: [], images: [], summary: { images: 0 } } } });
  assert.ok(img.success && img.id, 'image report saved');
  const text = 'Embedded test manuscript\n\nIntroduction\nQuercetin is studied (Boots et al., 2008).\n\nReferences\nBoots AW, Haenen GR and Bast A (2008). Health effects of quercetin: from antioxidant to nutraceutical. Eur. J. Pharmacol., 585(2-3): 325-337.';
  const { jobId } = await api('/api/checks', { method: 'POST', body: { kind: 'manuscript', text, meta: { title: 'Embedded test', authors: ['A Khan'] }, imagesCheckId: img.id, imagesEmbedded: true } });
  const done = await job(jobId);
  assert.strictEqual(done.status, 'done', `screening: ${done.error}`);
  const screeningId = done.result.id;
  assert.strictEqual(done.result.images?.checkId, img.id, 'image report attached to the screening');

  const listed = (await api('/api/checks')).checks.map(c => c.id);
  assert.ok(listed.includes(screeningId) && !listed.includes(img.id), 'image report not listed separately in Saved reports');
  assert.ok(!(await api('/api/checks?kind=images')).checks.length, 'not offered as an earlier Module 5 report');
  assert.ok(!(await api('/api/activity')).items.some(i => i.id === img.id), 'not in My Activity');
  assert.ok((await api(`/api/checks/${img.id}`)).success, 'still opens inside the screening (by id)');

  await api(`/api/checks/${screeningId}`, { method: 'DELETE' });
  assert.ok(!(await api(`/api/checks/${img.id}`)).success, 'deleted together with the screening');

  // a browser tab still running the screening form from before an update (no imagesHandled) is asked to reload
  const stale = await fetch(base + '/api/checks', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie, 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ kind: 'manuscript', text }) });
  assert.strictEqual(stale.status, 409, 'out-of-date page refused');
  assert.ok(/reload/i.test((await stale.json()).message), 'asked to reload');
  // the current form always says why the figures were not analysed
  const note = 'Not checked — the manuscript text was pasted, so there were no figures to analyse.';
  const r2 = await job((await api('/api/checks', { method: 'POST', body: { kind: 'manuscript', text, meta: { title: 'Note test', authors: ['A Khan'] }, imagesHandled: true, imagesNote: note } })).jobId);
  assert.strictEqual(r2.status, 'done', `screening: ${r2.error}`);
  assert.strictEqual(r2.result.screening.lines.images, note, 'front page gives the reason');
  console.log('screening embedded images test passed');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
