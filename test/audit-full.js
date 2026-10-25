// test/audit-full.js - Full Screening Report end-to-end on the demonstration manuscript + saved reports/versions/exports + Super Admin functions.
const fs = require('fs'); const path = require('path'); const mammoth = require('mammoth'); const JSZip = require('jszip');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname; const R = {};
(async () => {
  const api = await boot();
  const text = (await mammoth.extractRawText({ path: path.join(__dirname, '..', 'public', 'demo', 'PJPS-2026-0412_Demo-Manuscript.docx') })).value;
  const t0 = Date.now();
  const s = await api.json('POST', '/api/checks', { kind: 'manuscript', text, meta: { manuscriptCode: 'AUDIT-FULL', title: 'Demo manuscript' }, style: 'pjps', save: true });
  const j = await api.job(s.data.jobId, 1200);
  R.secs = ((Date.now() - t0) / 1000).toFixed(0); R.status = j.status; R.error = j.error;
  console.log('full screening', j.status, R.secs + 's', j.error || '');
  const r = j.result; if (!r) process.exit(1);
  R.screening = r.screening; console.log(JSON.stringify(r.screening, null, 1));
  R.refs = r.references.summary; console.log('refs', JSON.stringify({ v: r.references.summary.verified, m: r.references.summary.miscited, s: r.references.summary.suspicious, u: r.references.summary.unverified, r: r.references.summary.retracted, total: r.references.summary.total }));
  R.citations = r.citations?.summary; console.log('citations', JSON.stringify(R.citations));
  R.compliance = r.compliance?.summary; console.log('compliance', JSON.stringify({ score: R.compliance?.score, nc: R.compliance?.nonCompliant, inText: R.compliance?.inTextIssues, sys: R.compliance?.citationSystem }));
  R.papermill = { level: r.papermill?.risk?.level, signals: (r.papermill?.signals || []).map(x => x.code) }; console.log('papermill', JSON.stringify(R.papermill));
  const id = r.id; R.exports = {};
  for (const [k, p] of [['editor', `/api/checks/${id}/screening?version=editor`], ['author', `/api/checks/${id}/screening?version=author`], ['summary', `/api/checks/${id}/summary?format=docx`], ['letter', `/api/checks/${id}/letter?format=docx`], ['csv', `/api/checks/${id}/export?format=csv`], ['bibtex', `/api/checks/${id}/export?format=bibtex`], ['ris', `/api/checks/${id}/export?format=ris`], ['refdocx', `/api/checks/${id}/export?format=docx`], ['corrected', `/api/checks/${id}/export?format=corrected`]]) {
    const x = await api.raw(p); R.exports[k] = { status: x.status, bytes: x.buffer.length };
    if (k === 'editor' || k === 'author') { const z = await JSZip.loadAsync(x.buffer); const xml = await z.file('word/document.xml').async('string'); const t = xml.replace(/<[^>]+>/g, ' '); R.exports[k].mentionsPaperMill = /paper mill/i.test(t); R.exports[k].mentionsImage = /image integrity/i.test(t); R.exports[k].confidential = /confidential/i.test(t); }
  }
  console.log('exports', JSON.stringify(R.exports));
  // version history for the same manuscript code
  const s2 = await api.json('POST', '/api/checks', { kind: 'references', referencesText: r.references.results.slice(0, 5).map(x => x.raw).join('\n'), meta: { manuscriptCode: 'AUDIT-FULL' }, save: true });
  await api.job(s2.data.jobId, 600);
  const list = await api.json('GET', '/api/checks?code=AUDIT-FULL'); R.history = list.data.checks.map(c => ({ id: c.id, kind: c.kind, version: c.version }));
  console.log('history by manuscript code', JSON.stringify(R.history));
  const cmp = await api.json('GET', `/api/checks/${list.data.checks[0].id}/compare/${list.data.checks[1].id}`); R.compare = { status: cmp.status, keys: Object.keys(cmp.data.comparison || {}) };
  // pdf export anywhere?
  for (const f of ['pdf']) { const x = await api.raw(`/api/checks/${id}/export?format=${f}`); R.exports['pdf'] = x.status; }
  // admin functions
  const adm = {};
  adm.stats = (await api.json('GET', '/api/admin/stats')).status; adm.audit = (await api.json('GET', '/api/admin/audit')).data.entries?.length; adm.datasets = (await api.json('GET', '/api/admin/datasets')).status;
  adm.ageRule = (await api.json('PUT', '/api/settings/age-rule', { years: 10, minShare: 20 })).data.rule;
  adm.tortured = (await api.json('PUT', '/api/settings/tortured', { list: [{ phrase: 'zorbitrex clearance', correct: 'drug clearance' }] })).data.list?.length;
  const e = await api.json('POST', '/api/admin/users', { email: 'ed2@test.local', name: 'Ed Two', role: 'editor', password: 'edpass-12345', allowWeb: true });
  adm.createEditor = e.status; adm.editorPerms = e.data.user?.permissions;
  const dup = await api.json('POST', '/api/admin/users', { email: 'ed2@test.local', name: 'Ed Two', role: 'editor' }); adm.dupEmail = dup.status;
  R.admin = adm; console.log('admin', JSON.stringify(adm));
  fs.writeFileSync(path.join(OUT, 'audit-full.json'), JSON.stringify(R, null, 1)); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
