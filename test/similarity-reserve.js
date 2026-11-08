// similarity-reserve.js - the Similarity Report on the last run a search may have: the literature search (Europe PMC)
// stops early enough for Wikipedia (and OpenAlex, the web) to be searched as well, including the passages the literature
// search did not reach. Offline: every search is stubbed, no R2, no paid service.
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'OPENALEX_API_KEY', 'SERPAPI_KEY', 'BRAVE_API_KEY', 'GOOGLE_CSE_KEY', 'COPYLEAKS_API_KEY', 'COPYLEAKS_EMAIL']) process.env[k] = '';
const assert = require('assert');
const http = require('../src/http');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wikiAsked = 0, litAsked = 0;
// Europe PMC is slow and finds nothing; Wikipedia finds nothing either but is counted
http.getJson = async url => {
  if (/europepmc/.test(url)) { litAsked++; await sleep(500); return { ok: true, status: 200, data: { hitCount: 0, resultList: { result: [] } } }; }
  if (/wikipedia/.test(url)) { wikiAsked++; return { ok: true, status: 200, data: { query: { search: [], searchinfo: { totalhits: 0 } } } }; }
  return { ok: false, status: 404 };
};
http.getText = async () => ({ ok: false, status: 404 });
const { checkPlagiarism } = require('../src/checks/plagiarism');
const db = require('../src/db');

// real prose (a project document): passages with ordinary sentence structure
const body = require('fs').readFileSync(require('path').join(__dirname, '..', 'docs', 'Similarity-Report-Flow-and-Fixes-2026-11-08.txt'), 'utf8');

(async () => {
  await db.init();
  // the last run, with 1.5 s left for the literature search after the 60 s kept for the other indexes
  const r = await checkPlagiarism({ body, deadline: Date.now() + 61500, canResume: false });
  const c = r.checked;
  assert.ok(c.timeLimited, 'the literature search was stopped by the time limit');
  assert.ok(c.passagesSearched < c.passages, `not every passage reached in the literature (${c.passagesSearched} of ${c.passages})`);
  assert.ok(c.wikiSearches > 0 && wikiAsked > 0, `Wikipedia still searched (${c.wikiSearches})`);
  console.log(`  ok - last run: literature ${c.passagesSearched} of ${c.passages} passages, then Wikipedia ${c.wikiSearches} passages in the time kept`);

  // a run that hands over to the next keeps the whole time for the literature search, as before
  litAsked = 0; wikiAsked = 0;
  const h = await checkPlagiarism({ body, deadline: Date.now() + 1500, canResume: true });
  assert.ok(h.unfinished, 'hands over to the next run');
  assert.strictEqual(wikiAsked, 0, 'no Wikipedia search before the literature search is complete');
  console.log('  ok - a run with a next run to hand over to keeps its whole time for the literature search');
  console.log('similarity reserve test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
