// load-research-records.js - fill the research-record datasets and the bibliographic databases (Admin > Data) from their
// free sources, without the Admin page open. Free public APIs only (Crossref, DataCite, PubMed, Europe PMC,
// ClinicalTrials.gov, openFDA, ChEMBL, NIH RePORTER); no paid key is used.
//   node scripts/load-research-records.js                 load every dataset not yet full; reload (refresh) the full ones
//   node scripts/load-research-records.js rsc cochrane    only these datasets
//   node scripts/load-research-records.js --status        counts only
require('../src/config');
const db = require('../src/db');
const RR = require('../src/researchRecords');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    const s = await RR.status();
    for (const d of Object.values(s.kinds)) console.log(`${d.label.padEnd(36)} ${String(d.count).padStart(6)}  ${d.loadedAt || 'not loaded'}${d.complete ? '  (complete)' : ''}`);
    return;
  }
  const kinds = args.filter(a => !a.startsWith('--'));
  for (const kind of kinds.length ? kinds : Object.keys(RR.KINDS)) {
    if (!RR.KINDS[kind]) { console.log(`${kind}: unknown dataset`); continue; }
    const st = (await RR.status()).kinds[kind];
    // a full dataset is read again from its source (newest records), a partial one continues where it stopped
    const restart = (st.count >= RR.SOURCE_MAX || st.complete) && !(await db.getMeta(`rrec_${kind}_since`));
    const t = Date.now();
    try {
      const out = await RR.loadKind(kind, { restart, log: s => process.stdout.write(`\r${s}                `) });
      console.log(`\n${out.label}: ${out.count} records (${out.added} fetched${restart ? ', refreshed' : ''}) in ${Math.round((Date.now() - t) / 1000)} s`);
    } catch (e) { console.log(`\n${RR.KINDS[kind].label}: failed - ${e.message} (run again to continue)`); }
  }
}

main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
