// load-mill-abstracts.js - abstracts of the papers Retraction Watch lists as retracted for paper-mill reasons, from OpenAlex,
// for Module 4's look-alike signal (the manuscript's title + abstract against known mill products, as Clear Skies'
// Papermill Alarm). Writes DATA_DIR/papermill/mill-abstracts.json.gz ({ doi: abstract }) and uploads it to R2, where
// the web servers copy it from on first use. Only DOIs not yet in the file are fetched, so a re-run after the daily
// Retraction Watch refresh adds the new retractions.
// Usage: node scripts/load-mill-abstracts.js [--from file.json] [--no-upload]
require('../src/config');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cfg = require('../src/config');
const db = require('../src/db');
const D = require('../src/datasets');
const STORE = require('../src/datasetStore');

const REL = 'papermill/mill-abstracts.json.gz';
const FILE = path.join(cfg.DATA_DIR, REL);
const args = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const unInvert = inv => { if (!inv) return ''; const w = []; for (const [t, ps] of Object.entries(inv)) for (const p of ps) w[p] = t; return w.filter(Boolean).join(' '); };
const save = have => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, zlib.gzipSync(JSON.stringify(have))); };

(async () => {
  await db.init();
  let have = {};
  try { have = JSON.parse(zlib.gunzipSync(fs.readFileSync(FILE)).toString('utf8')); } catch { /* first run */ }
  if (args.includes('--from')) Object.assign(have, JSON.parse(fs.readFileSync(args[args.indexOf('--from') + 1], 'utf8')));
  const rows = await db.all(`SELECT doi FROM retractions WHERE nature ILIKE '%retraction%' AND doi IS NOT NULL AND doi <> '' AND reason ~* $1`, [D.MILL_REASON]);
  const dois = [...new Set(rows.map(r => r.doi.toLowerCase().trim()).filter(d => /^10\.\d{4,9}\/\S+$/.test(d) && !/[|,]/.test(d)))];
  const todo = dois.filter(d => !(d in have));
  console.log(`${dois.length} paper-mill retractions with a DOI; ${todo.length} to fetch from OpenAlex`);
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    const url = `https://api.openalex.org/works?filter=doi:${batch.map(encodeURIComponent).join('|')}&per-page=50&select=doi,abstract_inverted_index${cfg.CONTACT_EMAIL ? `&mailto=${encodeURIComponent(cfg.CONTACT_EMAIL)}` : ''}`;
    let data = null;
    for (let t = 0; t < 4 && !data; t++) {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(60000) }); if (r.ok) data = await r.json(); else await sleep(2000 * (t + 1)); } catch { await sleep(2000 * (t + 1)); }
    }
    if (!data) continue;   // left for the next run
    for (const d of batch) have[d] = have[d] || '';
    for (const w of data.results || []) { const d = String(w.doi || '').replace(/^https?:\/\/doi\.org\//, '').toLowerCase(); if (d) have[d] = unInvert(w.abstract_inverted_index).slice(0, 4000); }
    if (i % 2000 === 0) { save(have); console.log(`${i + batch.length}/${todo.length}`); }
    await sleep(120);
  }
  save(have);
  const n = Object.values(have).filter(Boolean).length;
  console.log(`${FILE}: ${n} abstracts (${Object.keys(have).length} DOIs looked up)`);
  if (!args.includes('--no-upload') && STORE.enabled()) console.log('R2:', await STORE.putFile(`files/${REL}`, FILE, { source: 'OpenAlex abstracts of Retraction Watch paper-mill retractions' }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
