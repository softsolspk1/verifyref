// rw-staged-load.js - Retraction Watch is loaded into a staging table in batches that carry over from run to run and
// swapped in at the end; the live list is used until then. Offline: the in-memory database, the source file stubbed.
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
const assert = require('assert');
const db = require('../src/db');
const store = require('../src/datasetStore');
const D = require('../src/datasets');
const ok = m => console.log(`  ok - ${m}`);

const header = 'Record ID,Title,Subject,Institution,Journal,Publisher,Country,Author,URLS,ArticleType,RetractionDate,RetractionDOI,RetractionPubMedID,OriginalPaperDate,OriginalPaperDOI,OriginalPaperPubMedID,RetractionNature,Reason,Paywalled,Notes';
const csv = n => [header, ...Array.from({ length: n }, (_, i) => `${i},Paper ${i},,Uni ${i},Journal ${i % 7},,Pakistan,Author ${i},,,1/2/2024 0:00,10.1/r${i},,,10.9999/p${i},,Retraction,+Paper Mill;,No,`)].join('\n');
let file = csv(25);
store.sourceText = async () => file;

(async () => {
  await db.init();
  await db.query("INSERT INTO retractions(doi, nature, title) VALUES('10.1/old', 'Retraction', 'Old list')");
  await db.setMeta('rw_loaded_at', '2026-10-29T09:28:25.761Z');

  // no time left in this run: the staging table is started, the live list untouched
  let r = await D.loadRetractionWatch({ deadline: Date.now(), batch: 10, log: () => {} });
  assert.deepStrictEqual([r.partial, r.done, r.total], [true, 0, 25]);
  assert.strictEqual((await db.one('SELECT count(*)::int n FROM retractions')).n, 1, 'live list still in use');
  assert.ok(JSON.parse(await db.getMeta('rw_stage')).total === 25);
  ok('a run with no time left saves its place and keeps the live list');

  // a stopped run left 10 rows in the stage: the next run continues from there (not from zero)
  await db.query("INSERT INTO retractions_stage(doi) SELECT 'x' || g FROM generate_series(1, 10) g");
  await db.setMeta('rw_stage', JSON.stringify({ ...JSON.parse(await db.getMeta('rw_stage')), done: 10 }));
  r = await D.loadRetractionWatch({ batch: 10, log: () => {} });
  assert.strictEqual(r, 25);
  const n = (await db.one('SELECT count(*)::int n FROM retractions')).n;
  assert.strictEqual(n, 10 + 15, 'rows 11-25 added to the 10 already staged');
  ok('the next run continues from the saved place and swaps the new table in');
  assert.strictEqual(await db.getMeta('rw_stage'), '', 'stage cleared');
  assert.ok(Date.parse(await db.getMeta('rw_loaded_at')) > Date.parse('2026-11-01'), 'loaded date updated');
  assert.ok(await db.one("SELECT 1 FROM pg_indexes WHERE tablename = 'retractions' AND indexname = 'idx_retractions_journal'"), 'journal index under its usual name');
  assert.ok(await db.one("SELECT 1 FROM pg_constraint WHERE conname = 'retractions_pkey'"), 'primary key under its usual name');
  assert.ok(!(await db.one("SELECT 1 FROM information_schema.tables WHERE table_name = 'retractions_stage'")), 'no staging table left');
  ok('indexes and key keep their names; the loaded date is today');

  // a fresh load (no stage) of a changed file, then lookups work
  file = csv(30);
  await db.query("UPDATE meta SET value = 'changed' WHERE key = 'raw_retractionwatch.csv_at'").catch(() => {});
  r = await D.loadRetractionWatch({ log: () => {} });
  assert.strictEqual(r, 30);
  assert.strictEqual((await D.retractionFor('10.9999/p29'))?.title, 'Paper 29');
  ok('a full load in one run, lookups find the new rows');

  // the daily cron (60 s, not forced) does not start or continue it
  await db.setMeta('rw_stage', JSON.stringify({ src: 'x', done: 3, total: 30 }));
  const out = await D.ensureDatasets({ budgetMs: 60000, log: () => {} });
  assert.ok(out.deferred?.includes('Retraction Watch'), JSON.stringify(out));
  ok('the daily cron leaves a load in progress to the Admin refresh');

  console.log('Retraction Watch staged load test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
