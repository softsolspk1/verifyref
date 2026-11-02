#!/usr/bin/env node
// scripts/repository-remove-submissions.js - no-repository clean-up for unpublished manuscripts stored before the
// similarity report followed Turnitin's "no repository" setting (2 Nov 2026): deletes the full texts of screened
// manuscripts from the PJPS text repository (corpus_docs kind 'submission', their R2 files and fingerprint index), and
// removes the abstracts kept with the Module 4 fingerprints. The sampled hashes stay (they cannot be turned back into
// text; Module 4 uses them to recognise a manuscript submitted again). Published source texts are not touched.
//
//   node scripts/repository-remove-submissions.js            show what would be removed
//   node scripts/repository-remove-submissions.js --apply    remove it
const db = require('../src/db');
const U = require('../src/uploads');

(async () => {
  await db.init();
  const apply = process.argv.includes('--apply');
  const docs = await db.all("SELECT id, title, r2_key, words FROM corpus_docs WHERE kind = 'submission'");
  const fps = await db.all("SELECT id FROM fingerprints WHERE kind = 'text' AND data ? 'abstract'").catch(() => db.all("SELECT id, data FROM fingerprints WHERE kind = 'text'").then(r => r.filter(x => x.data?.abstract)));
  console.log(`Stored manuscript texts: ${docs.length} (${docs.reduce((a, d) => a + (d.words || 0), 0).toLocaleString()} words)`);
  for (const d of docs) console.log(`  #${d.id} ${String(d.title || '').slice(0, 90)}`);
  console.log(`Fingerprints with an abstract: ${fps.length}`);
  if (!apply) { console.log('\nNothing removed. Run again with --apply to remove them.'); process.exit(0); }
  for (const d of docs) {
    if (d.r2_key && U.enabled()) await U.deleteObject(d.r2_key).catch(e => console.error(`  R2 ${d.r2_key}: ${e.message}`));
    await db.query('DELETE FROM corpus_docs WHERE id = $1', [d.id]); // corpus_hashes rows go with it (ON DELETE CASCADE)
  }
  for (const f of fps) await db.query("UPDATE fingerprints SET data = data - 'abstract' WHERE id = $1", [f.id]);
  console.log(`Removed ${docs.length} manuscript text(s) and ${fps.length} abstract(s).`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
