// benchmark-papermill-lookalike.js - measures Module 4's look-alike signal (src/papermill/millIndex.js) on the benchmark papers
// of benchmark-papermill.js (150 retracted for paper-mill reasons, 126 ordinary papers of the same journals and years):
// each paper's title + abstract (and title alone) against the Retraction Watch paper-mill retractions, the paper's own record
// left out. Also prints the risk levels when the signal is added to each paper's text-signal score.
// Needs data/benchmark/results.json + xml/ and data/papermill/mill-abstracts.json.gz (scripts/load-mill-abstracts.js).
// Usage: node scripts/benchmark-papermill-lookalike.js
require('../src/config');
const fs = require('fs');
const path = require('path');
const MI = require('../src/papermill/millIndex');

const DIR = path.join(__dirname, '..', 'data', 'benchmark');
const clean = x => String(x || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const weightOf = (abs, title) => {
  const top = abs?.[0]?.score || 0;
  const a = top >= 0.2 ? 4 : top >= 0.17 ? 3 : top >= 0.14 ? 2 : 0;
  const t = title.length ? (title[0].score >= 0.6 || title.length >= 3 ? 2 : 1) : 0;
  return Math.max(a, t);
};
const level = (p, add) => {
  const highs = p.signals.filter(s => s.endsWith(':high')).length;
  const score = p.score + add;
  return highs >= 2 || score >= 8 ? 'HIGH' : highs === 1 || score >= 4 ? 'MEDIUM' : 'LOW';
};

(async () => {
  const bench = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
  const rows = [];
  for (const b of bench) {
    const f = path.join(DIR, 'xml', `${b.pmcid}.xml`);
    if (!fs.existsSync(f)) continue;
    const front = (fs.readFileSync(f, 'utf8').match(/<front>[\s\S]*?<\/front>/) || [''])[0];
    const title = clean((front.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/) || [])[1]);
    const abs = clean((front.match(/<abstract[\s\S]*?<\/abstract>/) || [''])[0]);
    const a = await MI.abstractLookalikes(title, abs, { doi: b.doi });
    if (a === null && !rows.length) console.log('No abstracts file: run scripts/load-mill-abstracts.js first (title index only).');
    const t = await MI.titleLookalikes(title, { doi: b.doi });
    rows.push({ b, half: parseInt(b.pmcid.replace(/\D/g, ''), 10) % 2 ? 'B' : 'A', top: a?.[0]?.score || 0, w: weightOf(a, t) });
  }
  const count = (g, h, fn) => { const r = rows.filter(x => x.b.group === g && (!h || x.half === h)); return `${r.filter(fn).length}/${r.length}`; };
  console.log('Title + abstract, closest mill retraction        half A mill / ordinary | half B mill / ordinary | all');
  for (const th of [0.14, 0.17, 0.2]) console.log(`  >= ${th.toFixed(2)}`.padEnd(48), count('mill', 'A', x => x.top >= th), count('control', 'A', x => x.top >= th), '|', count('mill', 'B', x => x.top >= th), count('control', 'B', x => x.top >= th), '|', count('mill', null, x => x.top >= th), count('control', null, x => x.top >= th));
  console.log('Risk level with the signal added to the text-signal score:');
  for (const [name, add] of [['text signals only', () => 0], ['text signals + look-alike', x => x.w]]) {
    console.log(`  ${name}`.padEnd(48), 'MEDIUM+', count('mill', null, x => level(x.b, add(x)) !== 'LOW'), 'mill,', count('control', null, x => level(x.b, add(x)) !== 'LOW'), 'ordinary');
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
