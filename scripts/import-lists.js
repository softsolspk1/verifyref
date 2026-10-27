// import-lists.js - load journal index lists from data/lists into the database.
// Usage: node scripts/import-lists.js
// File names (without extension) map to list types, e.g. data/lists/jcr.csv, hjrs.csv, wos_sjr.csv, sjr.csv
require('../src/config'); // loads .env
const fs = require('fs');
const path = require('path');
const D = require('../src/datasets');

const DIR = path.join(__dirname, '..', 'data', 'lists');
// Downloaded file names -> list type
const ALIASES = { 'sjr-scopus': 'sjr', 'sjr-wos-filtered': 'wos_sjr' };

(async () => {
  for (const f of fs.readdirSync(DIR).filter(x => /\.csv$/i.test(x))) {
    const base = path.basename(f, path.extname(f)).toLowerCase();
    const type = ALIASES[base] || base;
    if (!D.LIST_TYPES[type]) { console.log(`skip ${f}: no list type "${type}"`); continue; }
    try {
      const n = await D.importJournalList(type, f, fs.readFileSync(path.join(DIR, f), 'utf8'));
      console.log(`${type}: ${n} journals imported from ${f}`);
    } catch (e) { console.log(`${type}: FAILED ${e.message}`); }
  }
  process.exit(0);
})();
