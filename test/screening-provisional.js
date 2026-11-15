// screening-provisional.js - the Full Screening is shown in two steps: while the similarity report runs, the browser
// gets a provisional copy (Modules 1-5, the sections still running marked pending, the recommendation marked
// provisional), refreshed when novelty / author identity finish and sent once per version; the final report is made and
// saved as before (no pending section, no provisional mark, nothing of the copy in it). Offline: the similarity report,
// novelty and author identity are stubbed (slow, fixed results), no paid service.
process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;
process.env.R2_BUCKET = '';
const assert = require('assert');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PL = require('../src/checks/plagiarism');
const NV = require('../src/checks/novelty');
const AU = require('../src/checks/authorIdentity');
const SIM = { kind: 'plagiarism', version: 5, summary: { similarity: 12, internet: 3, publications: 9, submissions: 0, sources: 2, largestSource: 7, level: 'ok' }, sources: [], publishedOnPjps: [] };
// author identity finishes once the test has seen a provisional copy, and the similarity report once it has seen the copy
// refreshed with author identity (each at most 2 minutes): on a slow or busy computer Modules 1-4 can take longer than a
// fixed wait, and the screening then rightly goes straight to a later step
let releaseSimilarity = () => {};
PL.checkPlagiarism = async () => { await new Promise(r => { releaseSimilarity = r; setTimeout(r, 120000); }); return JSON.parse(JSON.stringify(SIM)); };
NV.checkNovelty = async () => ({ kind: 'novelty', summary: { score: 64, band: 'moderate', level: 'ok', closeRecent: 1, outlook: 'average', fiveYearMedian: 10 } });
let releaseAuthors = () => {};
AU.checkAuthorIdentity = async () => { await new Promise(r => { releaseAuthors = r; setTimeout(r, 120000); }); return { kind: 'authors', summary: { authors: 1, verified: 1, flags: 0, level: 'ok', fromManuscript: 0, idsInManuscript: 0 }, authors: [], flags: [] }; };
const { start } = require('../server');
const ok = m => console.log(`  ok - ${m}`);

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
  assert.ok((await api('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'admin-pass-123' } })).success, 'login');

  // a manuscript without a reference list (no reference lookups online), long enough for the similarity report
  const para = 'Quercetin is a flavonoid found in onions, apples and tea that has antioxidant and anti-inflammatory activity in many cell and animal models of disease. ';
  const text = `Provisional test manuscript\n\nIntroduction\n${para.repeat(30)}\n\nMethods\n${para.repeat(10)}`;
  const { jobId } = await api('/api/checks', { method: 'POST', body: { kind: 'manuscript', text, meta: { title: 'Provisional test', authors: ['A Khan'] }, imagesHandled: true, imagesNote: 'Not checked — test.' } });

  const previews = [];
  let seen = '', final = null;
  for (let i = 0; i < 400 && !final; i++) {
    const j = await api(`/api/jobs/${jobId}?preview=${encodeURIComponent(seen)}`);
    if (j.preview) {
      assert.notStrictEqual(j.preview.at, seen, 'a preview is sent once per version');
      seen = j.preview.at;
      previews.push(j.preview.result);
      if (previews.length === 1) setTimeout(() => releaseAuthors(), 1000);
      if (j.preview.result.authorIdentity && !j.preview.result.authorIdentity.pending) setTimeout(() => releaseSimilarity(), 1000);
    }
    if (j.status === 'done') final = j.result;
    else if (j.status === 'error') throw new Error(j.error);
    else await sleep(300);
  }
  assert.ok(final, 'the screening finished');

  assert.ok(previews.length >= 1, 'a provisional report was published before the final one');
  const p = previews[0];
  assert.ok(p.plagiarism.pending && p.preview.pending.includes('Similarity report'), 'the similarity report is pending');
  assert.ok(p.screening.provisional && /^Provisional: /.test(p.screening.recommendationLabel), 'the recommendation is provisional');
  assert.strictEqual(p.screening.lines.plagiarism, 'Still running — fills in automatically');
  assert.ok(!p.id, 'the provisional report is not saved');
  assert.ok(p.papermill && p.screening.lines.papermill, 'Modules 1-5 are in it');
  ok('Modules 1-5 are published as a provisional report while the similarity report runs');
  const last = previews[previews.length - 1];
  assert.ok(previews.length >= 2 && !last.authorIdentity.pending && last.plagiarism.pending, 'refreshed when author identity finished');
  ok('the provisional report is refreshed when a section finishes, and sent once per version');

  assert.ok(final.id, 'the final report is saved');
  assert.deepStrictEqual(final.plagiarism.summary, SIM.summary, 'the similarity report is in the final report');
  assert.strictEqual(final.novelty.summary.score, 64);
  assert.strictEqual(final.authorIdentity.summary.verified, 1);
  assert.ok(!final.preview && !final.screening.provisional && !/Provisional/.test(final.screening.recommendationLabel), 'nothing provisional in the final report');
  assert.ok(!JSON.stringify(final).includes('"pending":true'), 'no pending section in the final report');
  assert.strictEqual((final.papermill.signals || []).filter(s => s.code === 'published-pjps').length, 0, 'the copy did not change the paper-mill signals');
  const saved = await api(`/api/checks/${final.id}`);
  assert.ok(saved.success && !saved.result.preview && saved.result.plagiarism.summary.similarity === 12, 'the saved report is the final one');
  ok('the final report is made and saved as before, with nothing of the provisional copy');

  // the Preliminary Review Sheet is filled by the Full Screening and saved for the editor
  const rs = final.reviewSheet;
  assert.ok(rs && !rs.error && rs.id && ['peer-review', 'resubmit', 'reject'].includes(rs.outcome), `review sheet filled (${rs?.error || rs?.outcome})`);
  assert.strictEqual(rs.items.find(i => i.key === 'results').value, 'no', 'the test manuscript has no Results heading');
  assert.ok(final.screening.lines.reviewSheet, 'review sheet line on the front page');
  const sheet = await api(`/api/review-sheet/${rs.id}`);
  assert.ok(sheet.success && sheet.sheet.outcome === rs.outcome, 'the sheet opens on its own page');
  ok('the Preliminary Review Sheet is filled with the Full Screening');

  // the job ended: no preview is left
  assert.ok(!(await api(`/api/jobs/${jobId}?preview=`)).preview, 'no preview after the end');
  console.log('screening provisional test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
