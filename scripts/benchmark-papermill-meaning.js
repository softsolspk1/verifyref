// scripts/benchmark-papermill-meaning.js - Module 4's look-alike signal by MEANING: each benchmark paper's title + abstract
// (150 paper-mill retractions vs 126 ordinary papers of the same journals and years, benchmark-papermill.js) as a sentence
// embedding, compared with the embeddings of every paper-mill retraction (build-mill-embeddings.js), the paper's own record
// left out. Prints, per half (odd / even PMC number), how many papers of each group have a closest mill paper above each
// cosine, and how many have several. Usage: node scripts/benchmark-papermill-meaning.js [--json out.json]
require('../src/config');
const fs = require('fs');
const path = require('path');
const MI = require('../src/papermill/millIndex');
const { normalizeJournal } = require('../src/text');

const DIR = path.join(__dirname, '..', 'data', 'benchmark');
const clean = x => String(x || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

(async () => {
  const ix = await MI.meaningIndex();
  if (!ix) throw new Error('no meaning index: run scripts/build-mill-embeddings.js');
  const bench = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
  const rows = [];
  for (const b of bench) {
    const f = path.join(DIR, 'xml', `${b.pmcid}.xml`);
    if (!fs.existsSync(f)) continue;
    const front = (fs.readFileSync(f, 'utf8').match(/<front>[\s\S]*?<\/front>/) || [''])[0];
    const title = clean((front.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/) || [])[1]);
    const abs = clean((front.match(/<abstract[\s\S]*?<\/abstract>/) || [''])[0]);
    const hits = (await MI.meaningLookalikes(title, abs, { doi: b.doi, limit: 30, min: 0.5 })) || [];
    // mill papers of another journal: closeness that is not only the shared subject of one journal
    const other = hits.filter(h => normalizeJournal(h.journal || '') !== normalizeJournal(b.journal || ''));
    rows.push({ group: b.group, half: parseInt(b.pmcid.replace(/\D/g, ''), 10) % 2 ? 'B' : 'A', pmcid: b.pmcid, title, top: hits[0]?.score || 0, scores: hits.map(h => h.score), topOther: other[0]?.score || 0, scoresOther: other.map(h => h.score), closest: hits[0] ? `${hits[0].title} (${hits[0].journal})` : null });
    process.stdout.write(`\r${rows.length}/${bench.length}  `);
  }
  console.log();
  const share = (g, h, fn) => { const r = rows.filter(x => x.group === g && (!h || x.half === h)); return `${r.filter(fn).length}/${r.length}`; };
  const show = (label, fn) => console.log(`${label.padEnd(40)} A: ${share('mill', 'A', fn).padEnd(7)} ${share('control', 'A', fn).padEnd(7)} | B: ${share('mill', 'B', fn).padEnd(7)} ${share('control', 'B', fn).padEnd(7)} | all ${share('mill', null, fn)} vs ${share('control', null, fn)}`);
  console.log('closest mill paper by meaning'.padEnd(40), 'mill / ordinary per half');
  for (const t of [0.6, 0.65, 0.7, 0.75, 0.8, 0.85]) show(`cosine >= ${t}`, r => r.top >= t);
  for (const [t, k] of [[0.6, 3], [0.65, 3], [0.7, 2], [0.7, 3]]) show(`${k}+ mill papers at cosine >= ${t}`, r => r.scores.filter(s => s >= t).length >= k);
  console.log('mill papers of OTHER journals only');
  for (const t of [0.6, 0.65, 0.7, 0.75, 0.8]) show(`cosine >= ${t}`, r => r.topOther >= t);
  for (const [t, k] of [[0.6, 3], [0.65, 3], [0.7, 2]]) show(`${k}+ at cosine >= ${t}`, r => r.scoresOther.filter(s => s >= t).length >= k);
  const j = process.argv.indexOf('--json');
  if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(rows, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
