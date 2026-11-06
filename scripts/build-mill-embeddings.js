// scripts/build-mill-embeddings.js - the meaning index of Module 4's look-alike signal: every paper retracted for
// paper-mill reasons that has an abstract (data/papermill/mill-abstracts.json.gz, scripts/load-mill-abstracts.js) as a
// sentence embedding (tools/embed.js, all-MiniLM-L6-v2) of its title + the start of its abstract, so a manuscript built on
// the same template with other genes, drugs or diseases is found by meaning, not only by shared words.
// Writes data/papermill/mill-embeddings.bin (int8, 384 values per paper, unit vectors scaled by 127) and
// mill-embeddings.json ({ model, dim, dois }). Push to R2 with scripts/sync-datasets-r2.js (or Admin > Data).
// Usage: node scripts/build-mill-embeddings.js        (about 20 minutes on a desktop processor)
require('../src/config');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cfg = require('../src/config');
const db = require('../src/db');
const D = require('../src/datasets');
const E = require('../src/tools/embed');

const DIR = path.join(cfg.DATA_DIR, 'papermill');
const textOf = (title, abs) => `${title}. ${abs}`.replace(/\s+/g, ' ').slice(0, 600);

(async () => {
  const abs = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, 'mill-abstracts.json.gz'))).toString('utf8'));
  const rows = await db.all(`SELECT doi, title FROM retractions WHERE nature ILIKE '%retraction%' AND title IS NOT NULL AND title <> '' AND reason ~* $1`, [D.MILL_REASON]);
  const seen = new Set();
  const items = [];
  for (const r of rows) {
    const doi = String(r.doi || '').toLowerCase().trim();
    if (!doi || seen.has(doi) || String(abs[doi] || '').length < 100) continue;
    seen.add(doi);
    items.push({ doi, text: textOf(r.title, abs[doi]) });
  }
  console.log(`${items.length} mill papers with an abstract`);
  const dim = 384;
  const out = new Int8Array(items.length * dim);
  const t0 = Date.now();
  for (let i = 0; i < items.length; i += 256) {
    const part = items.slice(i, i + 256);
    const vecs = await E.embed(part.map(x => x.text), { batch: 16 });
    if (!vecs) throw new Error('the language model could not be loaded');
    vecs.forEach((v, k) => { for (let d = 0; d < dim; d++) out[(i + k) * dim + d] = Math.max(-127, Math.min(127, Math.round(v[d] * 127))); });
    process.stdout.write(`\r${Math.min(i + 256, items.length)}/${items.length}  ${Math.round((Date.now() - t0) / 1000)} s   `);
  }
  console.log();
  fs.writeFileSync(path.join(DIR, 'mill-embeddings.bin'), Buffer.from(out.buffer));
  fs.writeFileSync(path.join(DIR, 'mill-embeddings.json'), JSON.stringify({ model: E.MODEL, dim, scale: 127, built: new Date().toISOString(), dois: items.map(x => x.doi) }));
  console.log(`written ${items.length} x ${dim} to ${DIR}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
