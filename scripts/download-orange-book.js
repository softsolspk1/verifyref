// scripts/download-orange-book.js - download FDA Orange Book zip from FDA and import into database
require('../src/config');
const db = require('../src/db');
const { loadFdaOrangeBook, fdaDrugLookup } = require('../src/datasets');

(async () => {
  try {
    console.log('--- FDA Orange Book Dataset Importer ---');
    await db.init();
    console.log('Database connected.');
    const startTime = Date.now();
    const count = await loadFdaOrangeBook({ log: msg => console.log(`[FDA] ${msg}`) });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Success! ${count.toLocaleString()} approved drug product records loaded in ${elapsed}s.`);

    // Quick verification lookup
    const sample = await fdaDrugLookup('Budesonide', { limit: 3 });
    console.log(`Sample search for "Budesonide": ${sample.length} results found:`);
    sample.forEach(s => console.log(`  - [${s.appl_type} ${s.appl_no}] ${s.trade_name} (${s.ingredient}) ${s.strength} [${s.dosage_form_route}] - ${s.applicant}`));

    process.exit(0);
  } catch (err) {
    console.error('Download/Import failed:', err);
    process.exit(1);
  }
})();
