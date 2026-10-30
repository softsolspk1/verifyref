// scripts/datasets-r2.js - dataset tables on Cloudflare R2 (src/datasetStore.js snapshotTable / restoreTable).
//   node scripts/datasets-r2.js snapshot   save every dataset table of the database in .env to R2 (datasets/tables/…)
//   node scripts/datasets-r2.js rebuild    fill every dataset table of the database in .env from R2, without contacting
//                                          any source website (a new database or server)
// The daily refresh saves a new snapshot after each dataset it reloads, so snapshot is only needed once to start.
require('../src/config');
const db = require('../src/db');
const store = require('../src/datasetStore');
const D = require('../src/datasets');

(async () => {
  const mode = process.argv[2];
  if (!['snapshot', 'rebuild'].includes(mode)) throw new Error('Usage: node scripts/datasets-r2.js snapshot|rebuild');
  if (!store.enabled()) throw new Error('Cloudflare R2 is not configured (R2_* variables).');
  await db.init();
  if (mode === 'rebuild') {
    await D.rebuildFromR2();
  } else {
    for (const [key, [table, extra]] of Object.entries(D.DATASET_TABLES)) {
      const r = await store.snapshotTable(table, [`${key}_loaded_at`, `${key}_count`, ...extra]).catch(e => ({ error: e.message }));
      console.log(`${table}: ${r.error ? `failed - ${r.error}` : `${r.rows} rows, ${(r.size / 1048576).toFixed(1)} MB${r.unchanged ? ' (unchanged)' : ''}`}`);
    }
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
