// scripts/storage-to-r2.js - moves bulky data out of the database onto Cloudflare R2 (npm run storage:to-r2):
//   1. cached web responses of 2 KB or more  -> cache/<hash>.json.gz on R2; the row keeps { "__r2": key }
//   2. Module 5 fingerprints and chart data  -> image index segments on R2 (src/imageRefs.js exportIndex)
//   3. with --vacuum: VACUUM FULL of the two tables, so the database file really shrinks (locks each table for seconds)
// Safe to run again: only what is still in the database is moved. --dry-run shows what would move.
require('../src/config');
const zlib = require('zlib');
const db = require('../src/db');
const R2 = require('../src/uploads');
const { cacheObjectKey, CACHE_R2_MIN } = require('../src/http');
const REFS = require('../src/imageRefs');

const DRY = process.argv.includes('--dry-run');
const sizes = () => db.all(`SELECT relname AS table, pg_size_pretty(pg_total_relation_size(oid)) AS size FROM pg_class
  WHERE relname IN ('cache', 'image_refs') ORDER BY relname`).then(r => Object.fromEntries(r.map(x => [x.table, x.size])));

(async () => {
  if (!R2.enabled()) throw new Error('Cloudflare R2 is not configured (R2_* variables).');
  await db.init();
  console.log('Before:', await sizes(), (await db.one('SELECT pg_size_pretty(pg_database_size(current_database())) AS db')).db);

  // 1. cache
  const big = await db.one("SELECT COUNT(*)::int AS n FROM cache WHERE NOT (value ? '__r2') AND pg_column_size(value) >= $1", [Math.floor(CACHE_R2_MIN / 2)]);
  console.log(`cache: ${big.n} rows to check`);
  let moved = 0, lastKey = '';
  for (;;) {
    const rows = await db.all("SELECT key, value::text AS json, expires_at FROM cache WHERE key > $1 AND NOT (value ? '__r2') AND expires_at > $2 ORDER BY key LIMIT 200", [lastKey, Date.now()]);
    if (!rows.length) break;
    lastKey = rows[rows.length - 1].key;
    await Promise.all(rows.filter(r => r.json.length >= CACHE_R2_MIN).map(async r => {
      if (DRY) { moved++; return; }
      const objectKey = cacheObjectKey(r.key);
      await R2.putObject(objectKey, zlib.gzipSync(r.json), 'application/gzip');
      // only replace the row when R2 returns the same content
      const back = zlib.gunzipSync(await R2.getObject(objectKey)).toString('utf8');
      if (back !== r.json) throw new Error(`R2 copy of cache entry ${r.key} differs`);
      await db.query('UPDATE cache SET value = $2 WHERE key = $1', [r.key, JSON.stringify({ __r2: objectKey })]);
      moved++;
    }));
    process.stdout.write(`\r  cache: ${moved} moved`);
  }
  console.log(`\ncache: ${moved} entries ${DRY ? 'would move' : 'moved'} to R2`);

  // 2. image index
  const waiting = (await db.one('SELECT COUNT(*)::int AS n FROM image_refs WHERE hashes IS NOT NULL')).n;
  console.log(`image index: ${waiting} panels still in the database`);
  if (!DRY && waiting) console.log('image index:', await REFS.exportIndex({ log: console.log }));

  // 3. reclaim the space
  if (!DRY && process.argv.includes('--vacuum')) {
    for (const t of ['cache', 'image_refs']) { console.log(`VACUUM FULL ${t} ...`); await db.query(`VACUUM FULL ${t}`); }
  }
  console.log('After:', await sizes(), (await db.one('SELECT pg_size_pretty(pg_database_size(current_database())) AS db')).db);
  await db.close();
})().catch(async e => { console.error(e); await db.close().catch(() => {}); process.exit(1); });
