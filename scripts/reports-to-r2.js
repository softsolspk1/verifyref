// scripts/reports-to-r2.js - moves the full results of reports saved before reports were kept on Cloudflare R2 into R2
// (reports/<id>.json.gz) and leaves the small stub in the database (src/reportStore.js). Safe to run again: reports
// already on R2 are skipped. Run against the database in .env: node scripts/reports-to-r2.js [--dry-run]
require('../src/config');
const db = require('../src/db');
const U = require('../src/uploads');
const RS = require('../src/reportStore');

(async () => {
  if (!U.enabled()) throw new Error('Cloudflare R2 is not configured (R2_* variables).');
  const dry = process.argv.includes('--dry-run');
  const rows = await db.all("SELECT id FROM checks WHERE result IS NOT NULL AND NOT (result ? '_r2') ORDER BY id");
  console.log(`${rows.length} report(s) still in the database${dry ? ' (dry run)' : ''}`);
  let moved = 0, bytes = 0;
  for (const { id } of rows) {
    const row = await db.one('SELECT result FROM checks WHERE id = $1', [id]);
    const size = JSON.stringify(row.result).length;
    if (!dry) await RS.offload(id, row.result);
    moved++; bytes += size;
    if (moved % 50 === 0) console.log(`  ${moved} moved`);
  }
  console.log(`Done: ${moved} report(s), ${(bytes / 1048576).toFixed(1)} MB ${dry ? 'would be' : ''} moved to R2.`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
