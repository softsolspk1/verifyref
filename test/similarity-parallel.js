// similarity-parallel.js - Full Screening speed without changing the result: the external full-text comparison the
// editor asked for starts with the in-house search (it used to start after it) and is submitted once; the PJPS text
// repository and the papers on the same subject are compared side by side. Offline: every search and the external
// service are stubbed, no R2, no paid service.
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'OPENALEX_API_KEY', 'SERPAPI_KEY', 'BRAVE_API_KEY', 'GOOGLE_CSE_KEY', 'COPYLEAKS_API_KEY', 'COPYLEAKS_EMAIL']) process.env[k] = '';
const assert = require('assert');
const http = require('../src/http');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = [];
let firstLit = null, topicAsked = null;
http.getJson = async url => {
  if (/europepmc/.test(url) && /resultType=lite&pageSize=20/.test(url)) { topicAsked = Date.now(); await sleep(300); return { ok: true, status: 200, data: { resultList: { result: [] } } }; }
  if (/europepmc/.test(url)) { firstLit = firstLit || Date.now(); await sleep(20); return { ok: true, status: 200, data: { hitCount: 0, resultList: { result: [] } } }; }
  if (/wikipedia/.test(url)) return { ok: true, status: 200, data: { query: { search: [], searchinfo: { totalhits: 0 } } } };
  return { ok: false, status: 404 };
};
http.getText = async () => ({ ok: false, status: 404 });
const EXT = require('../src/externalSimilarity');
let scans = 0, scanStarted = null;
EXT.enabled = () => true;
EXT.scanText = async () => { scans++; scanStarted = Date.now(); log.push('scan'); await sleep(1500); return { scanId: 'x', completed: {}, items: [], results: {} }; };
const { checkPlagiarism } = require('../src/checks/plagiarism');
const db = require('../src/db');
const ok = m => console.log(`  ok - ${m}`);

const body = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'Similarity-Report-Flow-and-Fixes-2026-11-08.txt'), 'utf8');

(async () => {
  await db.init();
  const t0 = Date.now();
  const r = await checkPlagiarism({ body, external: true });
  assert.ok(!r.error, r.error);
  assert.strictEqual(scans, 1, 'the external comparison is submitted once');
  assert.ok(scanStarted && firstLit && scanStarted <= firstLit, 'the external comparison starts before the phrase searches');
  assert.ok(r.external?.used, 'its result is in the report');
  ok('the requested external comparison starts with the in-house search and is used once');
  assert.ok(topicAsked && topicAsked - t0 < 1000, 'papers on the same subject are looked up at the start');
  ok('papers on the same subject are looked up alongside the PJPS text repository');

  // not asked for: decided on the in-house index afterwards, as before (here under the threshold: not run)
  scans = 0;
  const r2 = await checkPlagiarism({ body, external: false });
  assert.strictEqual(scans, 0);
  assert.ok(r2.external?.skipped);
  ok('not asked for: decided on the in-house Similarity Index, not started early');
  console.log('similarity parallel test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
