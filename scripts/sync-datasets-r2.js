#!/usr/bin/env node
// sync-datasets-r2.js - keep every dataset on Cloudflare R2.
//   node scripts/sync-datasets-r2.js            upload new / changed files of the data folder (npm run datasets:push)
//   node scripts/sync-datasets-r2.js --pull     download the data folder from R2 (new computer / server) (npm run datasets:pull)
//   node scripts/sync-datasets-r2.js --list     what is stored
//   --only <prefix>                             limit to part of the folder, e.g. --only new/
const STORE = require('../src/datasetStore');
const cfg = require('../src/config');
const db = require('../src/db');

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const mb = n => `${(n / 1e6).toFixed(1)} MB`;

(async () => {
  if (!STORE.enabled()) throw new Error('Cloudflare R2 is not configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET in .env');
  if (args.includes('--list')) {
    for (const f of await STORE.list()) console.log(`${f.name.padEnd(70)} ${mb(Number(f.size)).padStart(10)}  ${new Date(f.updated_at).toISOString().slice(0, 16)}  ${f.source || ''}`);
    const s = await STORE.status();
    console.log(`\n${s.files} files, ${mb(s.bytes)} in bucket ${s.bucket}`);
  } else if (args.includes('--pull')) {
    console.log(`Downloading datasets from R2 into ${cfg.DATA_DIR}`);
    const n = await STORE.pullDataDir({ prefix: only || '', onFile: (rel, size) => console.log(`  ${rel} (${mb(size)})`) });
    console.log(`${n} file(s) downloaded`);
  } else {
    console.log(`Uploading ${cfg.DATA_DIR}${only ? `/${only}` : ''} to R2 bucket ${cfg.R2.bucket}`);
    const out = await STORE.pushDataDir({ only, onFile: (rel, r) => console.log(`  ${r.error ? 'FAILED ' : r.stored ? 'stored ' : 'same   '} ${rel}${r.size ? ` (${mb(r.size)})` : ''}${r.error ? ` - ${r.error}` : ''}`) });
    console.log(`\n${out.files} files: ${out.stored} stored (${mb(out.bytes)}), ${out.unchanged} unchanged, ${out.errors.length} failed`);
    if (out.errors.length) process.exitCode = 1;
  }
  await db.close();
})().catch(async e => { console.error(e.message); await db.close().catch(() => {}); process.exit(1); });
