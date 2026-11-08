// dataset-refresh-resume.js - Admin > Data "Refresh datasets" over several job runs: a list this refresh already loaded
// is not loaded again in its later runs, and a list that does not fit in the run's time is handed over (deferred), not
// started and cut off. Offline: the in-memory database, no list is downloaded.
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
const assert = require('assert');
const db = require('../src/db');
const D = require('../src/datasets');

const KEYS = ['rw', 'pps', 'beall', 'fda_ob', 'nlm', 'doaj', 'ltwa', 'crj', 'maildom', 'cello', 'pubj', 'jabref', 'pmcj', 'wosw', 'flag', 'doajw', 'mirbase', 'oaj'];
const ok = m => console.log(`  ok - ${m}`);

(async () => {
  await db.init();
  const since = new Date(Date.now() - 60000).toISOString();
  const old = new Date(Date.now() - 3600000).toISOString(); // loaded before the job: a forced refresh loads it again
  const now = new Date().toISOString();                     // loaded by this job's earlier run
  for (const k of KEYS) await db.setMeta(`${k}_loaded_at`, now);
  await db.setMeta('rw_authors', '2');

  // every list loaded by this job: its next run loads nothing (it used to load all 18 again)
  let out = await D.ensureDatasets({ force: true, since, budgetMs: 225000, log: () => {} });
  assert.deepStrictEqual(out, {}, `nothing loaded again: ${JSON.stringify(out)}`);
  ok('lists this refresh already loaded are not loaded again in its next run');

  // Retraction Watch and the NLM Catalog still to do and no time left in this run: both handed over, none started
  await db.setMeta('rw_loaded_at', old);
  await db.setMeta('nlm_loaded_at', old);
  out = await D.ensureDatasets({ force: true, since, budgetMs: 0, log: () => {} });
  assert.deepStrictEqual(out.deferred?.sort(), ['NLM Catalog', 'Retraction Watch'], JSON.stringify(out));
  assert.strictEqual(await db.getMeta('rw_tried_at'), null, 'a handed-over list is not marked as tried');
  ok('lists that do not fit in the run are handed over to the next run');

  // a refresh without a job start (the desktop app, an old job) still reloads everything when forced: not changed
  for (const k of KEYS) await db.setMeta(`${k}_loaded_at`, now);
  out = await D.ensureDatasets({ force: true, budgetMs: 0, log: () => {} });
  assert.strictEqual(out.deferred?.length, KEYS.length - 1, 'all but the OpenAlex list (kept 30 days) are due');
  ok('a forced refresh without a job start still covers every list');

  console.log('dataset refresh resume test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
