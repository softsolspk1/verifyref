// scripts/neon-slim.js - makes the Neon database smaller (7 Nov 2026): run once after deploying the code that reads the
// fingerprint index on R2. Every step is safe to run again.
//   1. the text repository's fingerprints (corpus_hashes) move to the index on R2 (bulk/corpus, src/corpus.js compactIndex)
//   2. the uploaded journal lists keep only the columns the checks read (src/datasets.js LIST_FIELDS; the files stay on R2)
//   3. expired cache rows are removed
//   4. VACUUM FULL returns the freed space of the large tables (each table is locked for a few seconds while it runs)
//   node scripts/neon-slim.js [--only corpus,lists,cache,vacuum]
const db = require('../src/db');

const only = (process.argv[process.argv.indexOf('--only') + 1] || '').split(',').filter(Boolean);
const step = s => process.argv.includes('--only') ? only.includes(s) : true;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const VACUUM = ['corpus_hashes', 'journal_list_entries', 'image_refs', 'cache', 'openalex_journals', 'crossref_journals', 'retractions'];

async function sizes() {
  const total = (await db.one('SELECT pg_database_size(current_database())::bigint AS b')).b;
  const rows = await db.all(`SELECT relname, pg_total_relation_size(relid)::bigint AS b FROM pg_stat_user_tables ORDER BY 2 DESC LIMIT 8`);
  return { total: Number(total), rows };
}
const mb = b => `${(Number(b) / 1048576).toFixed(0)} MB`;

(async () => {
  const before = await sizes();
  log(`Database: ${mb(before.total)}`);
  if (step('corpus')) {
    if (!require('../src/uploads').enabled()) throw new Error('Cloudflare R2 is not configured (R2_* in .env)');
    log('1. Fingerprint index to R2');
    log(await require('../src/corpus').compactIndex({ log: m => log('  ', m) }));
  }
  if (step('lists')) {
    log('2. Journal lists: only the columns read');
    await require('../src/datasets').slimJournalLists({ log: m => log('  ', m) });
  }
  if (step('cache')) {
    log('3. Expired cache rows');
    await require('../src/http').purgeCache({ budgetMs: 300000 });
  }
  if (step('vacuum')) {
    log('4. VACUUM FULL');
    for (const t of VACUUM) { const t0 = Date.now(); await db.query(`VACUUM (FULL, ANALYZE) ${t}`); log(`   ${t} (${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
  }
  const after = await sizes();
  log(`Database: ${mb(before.total)} -> ${mb(after.total)}`);
  for (const r of after.rows) log(`   ${r.relname.padEnd(24)} ${mb(r.b)}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
