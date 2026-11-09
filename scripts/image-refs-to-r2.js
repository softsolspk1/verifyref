#!/usr/bin/env node
// scripts/image-refs-to-r2.js - moves the Module 5 figure store's exported panel rows from the database to R2.
// Index segments written before 9 Nov 2026 hold the panels' fingerprints on R2 while their rows (paper, figure, panel
// label, type, thumbnail key, size) stayed in the image_refs table (617,000 rows, 158 MB of Neon). For every such segment
// this writes the rows' panel data next to it on R2 (read back before anything is deleted), records each paper's current
// panel ids (image_ref_docs.ref_min / ref_max) and deletes the rows. Rows still waiting for export are not touched.
//
//   node scripts/image-refs-to-r2.js                 dry run: what would move
//   node scripts/image-refs-to-r2.js --run           move (each segment's rows also saved to --backup first)
//   node scripts/image-refs-to-r2.js --run --vacuum  then VACUUM FULL image_refs (gives the space back to Neon)
//   --backup <dir>   folder for the rows saved before deletion (default C:/Users/softs/pjps-backup-image-refs)
require('../src/config');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const db = require('../src/db');
const R2 = require('../src/uploads');
const IR = require('../src/imageRefs');

const args = process.argv.slice(2);
const RUN = args.includes('--run');
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const BACKUP = opt('backup', 'C:/Users/softs/pjps-backup-image-refs');
const log = m => console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${m}`);

(async () => {
  await db.init();
  if (!R2.enabled()) throw new Error('Cloudflare R2 is not configured');
  const segs = await db.all('SELECT * FROM image_index_segments WHERE meta_key IS NULL ORDER BY min_id');
  const total = await db.one('SELECT count(*)::int AS n, count(*) FILTER (WHERE hashes IS NULL)::int AS exported FROM image_refs');
  log(`${segs.length} segment(s) without panel data on R2; image_refs: ${total.n.toLocaleString('en')} rows, ${total.exported.toLocaleString('en')} exported`);
  if (RUN) fs.mkdirSync(BACKUP, { recursive: true });
  let moved = 0;
  for (const s of segs) {
    const rows = await db.all(`SELECT ${IR.META_COLS} FROM image_refs WHERE id BETWEEN $1 AND $2 AND hashes IS NULL ORDER BY id`, [s.min_id, s.max_id]);
    log(`segment ${s.key}: ids ${s.min_id}-${s.max_id}, ${rows.length.toLocaleString('en')} exported row(s)`);
    if (!RUN) { moved += rows.length; continue; }
    const tag = path.basename(s.key).replace(/^seg-/, '').replace(/\.bin$/, '');
    fs.writeFileSync(path.join(BACKUP, `image_refs-${tag}.ndjson.gz`), zlib.gzipSync(rows.map(r => JSON.stringify(r)).join('\n')));
    const meta = await IR.writeMeta(tag, rows);
    await db.transaction(async client => {
      // every paper with rows here gets its current panel range from all its rows still in the database
      await IR.setDocRanges(client, [...new Set(rows.map(r => r.doc_id))]);
      await client.query('UPDATE image_index_segments SET meta_key = $2, meta_index = $3 WHERE id = $1', [s.id, meta.key, JSON.stringify(meta.index)]);
      for (let i = 0; i < rows.length; i += 20000) await client.query('DELETE FROM image_refs WHERE id = ANY($1::int[]) AND hashes IS NULL', [rows.slice(i, i + 20000).map(r => r.id)]);
    });
    moved += rows.length;
    log(`  moved: panel data in ${meta.index.length} chunk(s) on R2, rows deleted (backup ${BACKUP})`);
  }
  // papers whose rows are all still waiting for export: their range now, so later exports keep it
  if (RUN) await db.query(`UPDATE image_ref_docs d SET ref_min = r.lo, ref_max = r.hi FROM (SELECT doc_id, min(id) AS lo, max(id) AS hi FROM image_refs GROUP BY doc_id) r
    WHERE d.id = r.doc_id AND d.ref_min IS NULL`);
  const left = await db.one('SELECT count(*)::int AS n, count(*) FILTER (WHERE hashes IS NULL)::int AS exported FROM image_refs');
  log(`${RUN ? 'Moved' : 'Would move'} ${moved.toLocaleString('en')} row(s); image_refs now ${left.n.toLocaleString('en')} rows (${left.exported.toLocaleString('en')} exported rows in no segment)`);
  if (RUN && args.includes('--vacuum')) { log('VACUUM FULL image_refs ...'); await db.query('VACUUM FULL image_refs'); }
  const size = await db.one("SELECT pg_size_pretty(pg_total_relation_size('image_refs')) AS t, pg_size_pretty(pg_database_size(current_database())) AS d").catch(() => null);
  if (size) log(`image_refs ${size.t}; database ${size.d}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
