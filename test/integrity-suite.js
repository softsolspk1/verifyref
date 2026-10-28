// test/integrity-suite.js - Integrity Suite end to end on an in-memory database, without external lookups:
// Integrity Screening (all dimensions + risk score), cross-submission checks, reports, Peer-Review Integrity,
// case management with audit trail, published-article monitoring list, API keys and the Research Integrity API.
// Run: node test/integrity-suite.js
process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;
const assert = require('assert');

const MS = (code, authorLine, email, reviewer) => `Hepatoprotective effect of Berberis lyceum root extract against paracetamol-induced liver injury in rats
${authorLine}
Corresponding author: ${email}
Suggested reviewer: Dr R. Reviewer, ${reviewer}
Abstract
This study delves into the pivotal role of Berberis lyceum in rats. Additionally, it showcases meticulous findings. Doses of 200 mg/kg and 900 mg/kg were tested in albino rats and mice.
Introduction
Furthermore, liver disease plays a crucial role in the realm of public health. Moreover, it is important to note the intricate interplay of oxidative stress. Notably, a comprehensive understanding is paramount for robust therapy. Furthermore, this underscores the need for groundbreaking research. Moreover, the multifaceted landscape of hepatotoxicity is noteworthy. Additionally, these valuable insights pave the way for novel treatments. Furthermore, the herbal medicine sector holds immense promise. Moreover, natural products shed light on new mechanisms.
Materials and Methods
Thirty rats were divided into five groups of 8 animals each. Rats received 200 mg/kg and 400 mg/kg orally, and 8000 mg/kg in a toxicity study. Silymarin C25H22O10 with molecular weight of 520.4 was the standard (CAS 65666-07-2) and CAS 50-99-8 was the solvent. Patients participated in a randomized controlled trial at the teaching hospital. The questionnaire score with n = 12 was 3.48 ± 1.20 in group A. The cell line HEp-2 cells were used.
Results
Group A 12.45 ± 1.33, group B 12.45 ± 1.33, group C 15.20 ± 1.33, group D 17.80 ± 1.33, group E 9.10 ± 1.33. The inhibition reached 112.5% at the highest dose. The difference was significant, t(28) = 2.10, p < 0.001. As an AI language model, I cannot provide the exact values.
Discussion
The results confirm the hepatoprotective effect of the extract, consistent with previous reports on liver malignant growth and bosom peril models, and on the counter-acting of oxidative stress and the decrease of malondialdehyde concentrations in hepatic tissue samples.
References
1. Khan MA, Ali S (2020). Liver protection by herbal extracts. Pak J Pharm Sci 33: 1-9. doi:10.1000/pjps.2020.001
2. Smith J (2019). Oxidative stress. J Hepatol 12: 4-8. doi:10.1000/jh.2019.77
`;

(async () => {
  const app = require('../server');
  const port = await app.start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const jar = {};
  const call = async (who, method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get('set-cookie');
    if (c) jar[who] = c.split(';')[0];
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  const wait = async (who, id, prefix = '/api/jobs/', headers) => {
    for (let i = 0; i < 300; i++) {
      await new Promise(res => setTimeout(res, 400));
      const j = (await call(who, 'GET', prefix + id, null, headers)).data;
      if (j.status === 'done' || j.status === 'error') return j;
    }
    throw new Error('job timeout');
  };

  let r = await call('admin', 'POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123' });
  assert.ok(r.data.success, 'admin login');
  assert.ok(['integrity', 'peer-review', 'monitoring', 'cases'].every(k => r.data.user.permissions.includes(k)), 'Integrity Suite modules granted to Super Admin');
  r = await call('admin', 'GET', '/api/app');
  assert.ok(r.data.name === 'PJPS Data Integration System', 'portal renamed');

  // ---- Integrity Screening: first submission
  r = await call('admin', 'POST', '/api/integrity', { text: MS('A', 'Ahmad Khan, Sara Ali', 'shared.mill@gmail.com', 'ring.reviewer@gmail.com'), manuscriptCode: 'PJPS-INT-1', authors: 'Ahmad Khan\nSara Ali', suggestedReviewers: 'Dr R. Reviewer, ring.reviewer@gmail.com', external: false });
  assert.ok(r.data.success, 'integrity start: ' + r.data.message);
  let j = await wait('admin', r.data.jobId);
  assert.strictEqual(j.status, 'done', 'integrity job: ' + j.error);
  const res1 = j.result;
  const codes = key => (res1.dimensions.find(d => d.key === key)?.signals || []).map(s => s.code);
  assert.ok(codes('ai').includes('leftover') && codes('ai').includes('patterns'), 'AI writing: ' + codes('ai'));
  assert.ok(['statistics', 'grim', 'duplicate-values', 'repeated-sd'].every(c => codes('data').includes(c)), 'data integrity: ' + codes('data'));
  assert.ok(['dose-limit', 'dose-mismatch', 'cas', 'group-size', 'percent'].every(c => codes('pharma').includes(c)), 'pharma: ' + codes('pharma'));
  assert.ok(['no-approval', 'no-consent', 'no-registration', 'declarations'].every(c => codes('ethics').includes(c)), 'ethics: ' + codes('ethics'));
  assert.ok(codes('similarity').includes('paraphrase'), 'paraphrase: ' + codes('similarity'));
  assert.ok(res1.dimensions.some(d => d.key === 'papermill'), 'Module 4 signals included');
  assert.ok(['HIGH', 'CRITICAL'].includes(res1.risk.level) && res1.risk.score > 40 && res1.risk.explanation.length > 3, 'risk score with explanation: ' + res1.risk.level + ' ' + res1.risk.score);
  console.log(`  ✓ Integrity Screening: ${res1.risk.level} ${res1.risk.score}/100, ${res1.risk.contributions.length} signals in ${res1.dimensions.length} dimensions`);

  // ---- second submission by another team sharing the e-mail, reviewer and text: cross-submission signals
  r = await call('admin', 'POST', '/api/integrity', { text: MS('B', 'Bilal Ahmed, Zara Hussain', 'shared.mill@gmail.com', 'ring.reviewer@gmail.com'), manuscriptCode: 'PJPS-INT-2', authors: 'Bilal Ahmed\nZara Hussain', suggestedReviewers: 'ring.reviewer@gmail.com', external: false });
  j = await wait('admin', r.data.jobId);
  assert.strictEqual(j.status, 'done', j.error);
  const res2 = j.result;
  const net = res2.dimensions.find(d => d.key === 'network').signals.map(s => s.code);
  const sim = res2.dimensions.find(d => d.key === 'similarity').signals.map(s => s.code);
  assert.ok(net.includes('shared-email') && net.includes('reviewer-ring'), 'network: ' + net);
  assert.ok(sim.includes('archive'), 'archive similarity: ' + sim);
  console.log('  ✓ Cross-submission: shared e-mail, reviewer ring, identical text with an earlier submission');

  // ---- reports
  let resp = await fetch(`${base}/api/checks/${res1.id}/integrity-report`, { headers: { Cookie: jar.admin } });
  assert.strictEqual(resp.status, 200, 'integrity Word report');
  resp = await fetch(`${base}/api/checks/${res1.id}/integrity-report?format=pdf`, { headers: { Cookie: jar.admin } });
  assert.ok(resp.status === 200 && (await resp.arrayBuffer()).byteLength > 3000, 'integrity PDF report');

  // ---- Peer-Review Integrity
  r = await call('admin', 'POST', '/api/peer-review', { manuscriptCode: 'PJPS-INT-1', title: 'Hepatoprotective effect', authors: 'Ahmad Khan\nSara Ali', authorEmails: 'ahmad@uok.edu.pk', external: false,
    reviewers: [{ name: 'Rashid Khan', email: 'rashid@uok.edu.pk', orcid: '0000-0002-1825-0098', report: 'The paper is well written. The authors should improve the English. More references should be added. Please cite the following papers: (Rashid et al., 2020), (Rashid, 2021), doi 10.1000/a.1 and 10.1000/b.2. Minor revision.', invitedAt: '2026-10-01T08:00:00Z', returnedAt: '2026-10-01T10:00:00Z' },
      { name: 'Amina Siddiqui', email: 'ring.reviewer@gmail.com' }] });
  assert.ok(r.data.success, 'peer review start: ' + r.data.message);
  j = await wait('admin', r.data.jobId);
  assert.strictEqual(j.status, 'done', j.error);
  const peer = j.result.dimensions[0].signals.map(s => s.code);
  assert.ok(['same-domain', 'orcid-invalid', 'coercive-citation', 'fast', 'same-surname', 'free-mail', 'ring'].every(c => peer.includes(c)), 'peer review: ' + peer);
  const peerId = j.result.id;
  console.log(`  ✓ Peer-Review Integrity: ${peer.length} findings, ${j.result.risk.level}`);

  // ---- Case management
  r = await call('admin', 'POST', '/api/cases', { checkIds: [res1.id], note: 'Opened from screening' });
  assert.ok(r.data.success && ['urgent', 'high'].includes(r.data.case.priority), 'case created with risk-based priority');
  const caseId = r.data.case.id;
  r = await call('admin', 'GET', `/api/cases/${caseId}/draft-query`);
  assert.ok(r.data.body.includes('1.'), 'draft author query from findings');
  r = await call('admin', 'POST', `/api/cases/${caseId}/events`, { kind: 'query', subject: r.data.subject, body: r.data.body, to: 'author@uok.edu.pk' });
  assert.ok(r.data.case.status === 'awaiting_author' && r.data.case.queries.length === 1, 'query sent → awaiting author');
  r = await call('admin', 'POST', `/api/cases/${caseId}/events`, { kind: 'response', queryId: r.data.case.queries[0].id, body: 'We used AI for language editing.' });
  assert.ok(r.data.case.queries[0].responses.length === 1, 'response logged');
  r = await call('admin', 'PATCH', `/api/cases/${caseId}`, { linkChecks: [peerId], status: 'committee' });
  assert.ok(r.data.case.reports.length === 2 && r.data.case.status === 'committee', 'linked and status changed');
  assert.strictEqual((await call('admin', 'PATCH', `/api/cases/${caseId}`, { status: 'closed' })).status, 400, 'closing needs an outcome');
  r = await call('admin', 'PATCH', `/api/cases/${caseId}`, { status: 'closed', outcome: 'rejected', note: 'Committee decision' });
  assert.ok(r.data.case.status === 'closed' && r.data.case.outcome === 'rejected');
  resp = await fetch(`${base}/api/cases/${caseId}/report?format=pdf`, { headers: { Cookie: jar.admin } });
  assert.ok(resp.status === 200 && (await resp.arrayBuffer()).byteLength > 3000, 'case PDF report with audit trail');
  r = await call('admin', 'GET', '/api/cases/dashboard');
  assert.ok(r.data.success && r.data.closed.length === 1 && r.data.unhandled.some(u => u.id === res2.id), 'dashboard: closed case, unhandled high-risk screening');
  console.log('  ✓ Cases: query → response → committee → closed, report with audit trail, dashboard');

  // ---- Editors only: a reviewer account cannot use the suite
  r = await call('admin', 'POST', '/api/admin/users', { email: 'rev@test.local', name: 'Rev User', role: 'researcher', password: 'reviewer-pass-1' });
  await call('rev', 'POST', '/api/auth/login', { email: 'rev@test.local', password: 'reviewer-pass-1' });
  assert.strictEqual((await call('rev', 'POST', '/api/integrity', { text: 'x'.repeat(400) })).status, 403, 'reviewer blocked from Integrity Screening');
  assert.strictEqual((await call('rev', 'GET', '/api/cases/dashboard')).status, 403, 'reviewer blocked from cases');
  assert.strictEqual((await call('rev', 'GET', `/api/checks/${res1.id}`)).status, 404, 'reviewer cannot open others\' reports');

  // ---- Monitoring list (no network in this test: listing and validation only)
  r = await call('admin', 'GET', '/api/monitoring');
  assert.ok(r.data.success && Array.isArray(r.data.items));
  assert.strictEqual((await call('admin', 'POST', '/api/monitoring/import', { issn: 'bad' })).status, 400, 'ISSN validated');

  // ---- Research Integrity API
  r = await call('admin', 'POST', '/api/admin/api-keys', { name: 'PJPS submission system', scopes: ['screen', 'reports'] });
  assert.ok(r.data.success && r.data.key.startsWith('pjps_'), 'API key issued');
  const H = { Authorization: `Bearer ${r.data.key}` };
  const keyId = r.data.id;
  assert.strictEqual((await call('api', 'GET', '/api/v1/ping', null, { Authorization: 'Bearer pjps_wrongwrongwrongwrongwrong' })).status, 401, 'bad key refused');
  r = await call('api', 'GET', '/api/v1/ping', null, H);
  assert.ok(r.data.success && r.data.account === 'admin@test.local');
  r = await call('api', 'POST', '/api/v1/screenings', { text: MS('C', 'Omar Farooq', 'omar@uop.edu.pk', 'x@uop.edu.pk'), manuscriptCode: 'PJPS-API-1', authors: ['Omar Farooq'], external: false, externalId: 'sub-991' }, H);
  assert.strictEqual(r.status, 202, 'API screening accepted: ' + JSON.stringify(r.data));
  j = await wait('api', r.data.jobId, '/api/v1/jobs/', H);
  assert.ok(j.status === 'done' && j.result.risk.level && j.result.reportUrl, 'API result summary');
  resp = await fetch(`${base}/api/v1/reports/${j.result.checkId}?format=pdf`, { headers: H });
  assert.strictEqual(resp.status, 200, 'API PDF');
  assert.strictEqual((await call('api', 'GET', '/api/v1/articles', null, H)).status, 403, 'scope enforced');
  await call('admin', 'DELETE', `/api/admin/api-keys/${keyId}`);
  assert.strictEqual((await call('api', 'GET', '/api/v1/ping', null, H)).status, 401, 'revoked key refused');
  console.log('  ✓ Research Integrity API: key, screening job, summary, PDF, scopes, revocation');

  console.log('integrity suite test: all assertions passed');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
