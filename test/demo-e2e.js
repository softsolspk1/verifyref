// test/demo-e2e.js - runs the demonstration manuscript through the Full Screening Report on a local server (needs internet
// for the reference databases). Prints what each module finds. Run: node test/demo-e2e.js
process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
delete process.env.DATABASE_URL;
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
(async () => {
  const app = require('../server');
  const port = await app.start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
    return r.json().catch(() => ({}));
  };
  await call('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123' });
  const text = (await mammoth.extractRawText({ path: path.join(__dirname, '..', 'public', 'demo', 'PJPS-2026-0412_Demo-Manuscript.docx') })).value;
  const start = await call('POST', '/api/checks', { kind: 'manuscript', text, manuscriptCode: 'PJPS-2026-0412', style: 'pjps', save: true });
  if (!start.jobId) { console.error('start failed', start); process.exit(1); }
  let job;
  for (let i = 0; i < 400; i++) { await new Promise(r => setTimeout(r, 1500)); job = await call('GET', `/api/jobs/${start.jobId}`); if (job.status === 'done' || job.status === 'error') break; }
  if (job.status !== 'done') { console.error('job', job.status, job.error); process.exit(1); }
  const r = job.result;
  console.log('Recommendation:', r.screening?.recommendationLabel);
  console.log(JSON.stringify(r.screening?.lines, null, 1));
  console.log('References:', JSON.stringify(r.references?.summary));
  for (const x of r.references?.results || []) console.log(`  [${x.index}] ${x.status.padEnd(10)} ${x.raw.slice(0, 60)} | ${x.reason || ''}`.slice(0, 190));
  console.log('Citations: missing', (r.citations?.missing || []).map(m => m.citation), 'uncited', (r.citations?.uncited || []).length);
  console.log('Paper mill:', r.papermill?.risk?.level, (r.papermill?.signals || []).map(s => s.code).join(', '));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
