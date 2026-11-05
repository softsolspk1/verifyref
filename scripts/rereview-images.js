#!/usr/bin/env node
// scripts/rereview-images.js - review saved Module 5 image reports again with the current rules (src/imageReview.js:
// a figure placed in the text and again in the figure section is one figure; photo-only findings on drawings and on
// generated figures are not reported) and bring the Full Screening Reports that embed them up to date (image section,
// paper-mill image signal and risk, recommendation). Prints what changes; writes only with --write.
//
//   node scripts/rereview-images.js 85 [more ids] [--write]
require('../src/config');
const db = require('../src/db');
const RS = require('../src/reportStore');
const I = require('../src/images');
const P = require('../src/pipeline');
const { problemsOf } = require('../src/editor/reports');

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ids = args.filter(a => /^\d+$/.test(a)).map(Number);

async function save(id, result, columns = {}) {
  const sets = Object.keys(columns).map((k, i) => `${k} = $${i + 2}`);
  if (sets.length) await db.query(`UPDATE checks SET ${sets.join(', ')} WHERE id = $1`, [id, ...Object.values(columns)]);
  if (!(await RS.offload(id, result))) await db.query('UPDATE checks SET result = $1 WHERE id = $2', [JSON.stringify(result), id]);
}

(async () => {
  if (!ids.length) { console.log('usage: node scripts/rereview-images.js <image check id> [...] [--write]'); process.exit(1); }
  for (const id of ids) {
    const row = await db.one('SELECT id, kind, embedded_in, result FROM checks WHERE id = $1', [id]);
    if (!row || row.kind !== 'images') { console.log(`#${id}: not an image report`); continue; }
    const before = await RS.load(row.result);
    const after = await I.rereviewImageReport(before);
    console.log(`#${id} image report: ${before.summary.level} with ${before.findings.length} finding(s) -> ${after.summary.level} with ${after.findings.length}`);
    for (const n of after.reviewNotes) console.log(`   ${n}`);
    if (WRITE) await save(id, after, { problems: JSON.stringify(I.imageProblems(after)), suspicious: after.summary.byLevel.high, unverified: after.summary.byLevel.medium });
    // Full Screening Reports that embed this image report
    const screens = await db.all("SELECT id, result FROM checks WHERE kind = 'manuscript' AND (id = $1 OR result::text LIKE $2)", [row.embedded_in || 0, `%"checkId":${id}%`]);
    for (const s of screens) {
      const full = await RS.load(s.result);
      if (full.images?.checkId !== id) continue;
      const upd = P.refreshScreeningImages(full, after, id);
      console.log(`   #${s.id} screening: images "${full.screening?.lines?.images}" -> "${upd.screening.lines.images}"; paper mill ${full.papermill?.risk?.level} ${full.papermill?.risk?.score} -> ${upd.papermill?.risk?.level} ${upd.papermill?.risk?.score}; "${full.screening?.recommendationLabel}" -> "${upd.screening.recommendationLabel}"`);
      if (WRITE) await save(s.id, upd, { problems: JSON.stringify(problemsOf(upd)) });
    }
  }
  console.log(WRITE ? 'Written.' : 'Dry run - nothing written (add --write).');
  setTimeout(() => process.exit(0), 300);
})().catch(e => { console.error(e); process.exit(1); });
