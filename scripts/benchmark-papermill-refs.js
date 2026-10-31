// benchmark-papermill-refs.js - measures the Module 4 REFERENCE signals on the same papers as benchmark-papermill.js
// (150 papers retracted for paper-mill reasons vs 126 ordinary papers; reference lists read from the cached JATS files):
//   - references to journals with many paper-mill retractions (the thresholds used by src/papermill/index.js)
//   - references to papers that were themselves retracted for paper-mill reasons (exact DOI)
//   - title similarity to paper-mill-retracted titles (tested and NOT used: it barely separates the groups)
// Needs data/benchmark/results.json + xml/ (from benchmark-papermill.js) and data/public-images/retractionwatch.csv.
//   - with --lists (needs the database): references to citejacked journals (Problematic Paper Screener), to journals
//     discontinued by Scopus published after coverage ended, and to journals with a known hijacked clone (by name)
// Usage: node scripts/benchmark-papermill-refs.js [--titles] [--lists]
const fs = require('fs');
const path = require('path');
const { csvToObjects } = require('../src/datasets');
const { normalizeJournal, titleSimilarity } = require('../src/text');

const ROOT = path.join(__dirname, '..', 'data');
const MILL = /paper mill|fake peer review|peer review manipul|randomly generated|computer-aided content/i;
const STOP = new Set(['of', 'and', 'the', 'in', 'for', 'on', '&']);

const rw = csvToObjects(fs.readFileSync(path.join(ROOT, 'public-images', 'retractionwatch.csv'), 'utf8')).filter(r => /retraction/i.test(r.RetractionNature));
const perJournal = new Map(), millDoi = new Set(), millTitles = [];
for (const r of rw) {
  if (!MILL.test(r.Reason)) continue;
  const k = normalizeJournal(r.Journal);
  perJournal.set(k, (perJournal.get(k) || 0) + 1);
  const d = (r.OriginalPaperDOI || '').toLowerCase();
  if (d) millDoi.add(d);
  millTitles.push({ title: r.Title, doi: d });
}
const journals = [...perJournal].map(([k, n]) => ({ k, n, words: k.split(' ').filter(w => !STOP.has(w)) }));
function millCount(name) {
  const k = normalizeJournal(name);
  if (perJournal.has(k)) return perJournal.get(k);
  const w = k.split(' ').filter(x => !STOP.has(x));
  if (w.length < 2) return 0;
  const j = journals.find(j => j.words.length === w.length && w.every((x, i) => j.words[i].startsWith(x)));
  return j ? j.n : 0;
}

const papers = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmark', 'results.json'), 'utf8'));
const LISTS = process.argv.includes('--lists');
const D = LISTS ? (require('../src/config'), require('../src/datasets')) : null;
const listCache = new Map();
async function listsFor(name) {
  const k = normalizeJournal(name);
  if (!k) return {};
  if (!listCache.has(k)) {
    const [pred, hits] = await Promise.all([D.predatoryMatches({ journal: name }).catch(() => []), D.listLookupAll([], name).catch(() => ({}))]);
    const sd = hits.scopus_discontinued && !/policy/i.test(hits.scopus_discontinued.data?.['Indexation Change'] || '') ? (parseInt(hits.scopus_discontinued.data?.Year, 10) || 0) : null;
    listCache.set(k, { citejacked: pred.some(D.isCitejacked), clone: pred.some(x => x.kind === 'hijacked' && !D.isCitejacked(x)), predatory: pred.some(x => x.kind !== 'hijacked'), scopusDropped: sd });
  }
  return listCache.get(k);
}

(async () => {
const rows = [];
for (const p of papers) {
  const f = path.join(ROOT, 'benchmark', 'xml', `${p.pmcid}.xml`);
  if (!fs.existsSync(f)) continue;
  const xml = fs.readFileSync(f, 'utf8');
  const refs = [...((xml.match(/<ref-list[\s\S]*<\/ref-list>/) || [''])[0]).matchAll(/<ref[ >][\s\S]*?<\/ref>/g)].map(m => m[0]);
  const sources = refs.map(r => ((r.match(/<source>([\s\S]*?)<\/source>/) || [])[1] || '').replace(/<[^>]+>/g, ''));
  const dois = refs.map(r => ((r.match(/pub-id-type="doi">([^<]+)</) || [])[1] || '').toLowerCase().trim());
  const inMill = sources.filter(s => s && millCount(s) >= 20).length;
  const row = { group: p.group, refs: refs.length, inMill, share: refs.length ? inMill / refs.length : 0, millCited: dois.filter(d => d && d !== p.doi.toLowerCase() && millDoi.has(d)).length };
  if (LISTS) {
    const years = refs.map(r => parseInt((r.match(/<year[^>]*>(\d{4})/) || [])[1], 10) || 0);
    Object.assign(row, { citejacked: 0, clone: 0, predatory: 0, scopusDropped: 0 });
    for (let i = 0; i < sources.length; i++) {
      if (!sources[i]) continue;
      const l = await listsFor(sources[i]);
      if (l.citejacked) row.citejacked++;
      if (l.clone) row.clone++;
      if (l.predatory) row.predatory++;
      if (l.scopusDropped !== null && l.scopusDropped !== undefined && years[i] >= l.scopusDropped) row.scopusDropped++;
    }
  }
  if (process.argv.includes('--titles')) {
    const t = p.title.replace(/<[^>]+>/g, '');
    row.titleSim = Math.max(0, ...millTitles.filter(m => m.doi !== p.doi.toLowerCase()).map(m => titleSimilarity(t, m.title)));
  }
  rows.push(row);
}

const line = (label, test) => {
  const m = rows.filter(r => r.group === 'mill'), c = rows.filter(r => r.group === 'control');
  console.log(`| ${label} | ${m.filter(test).length}/${m.length} | ${c.filter(test).length}/${c.length} |`);
};
console.log(`Journals with >= 20 paper-mill retractions: ${journals.filter(j => j.n >= 20).length}\n`);
console.log('| Signal | Mill-retracted | Control |\n|---|---|---|');
line('Mill journals: >= 3 refs and >= 15% (low)', r => r.inMill >= 3 && r.share >= 0.15);
line('Mill journals: >= 5 refs and >= 20% (medium)', r => r.inMill >= 5 && r.share >= 0.2);
line('Cites a paper retracted for paper-mill reasons', r => r.millCited >= 1);
line('Cites 2+ papers retracted for paper-mill reasons', r => r.millCited >= 2);
if (process.argv.includes('--titles')) for (const t of [0.5, 0.6, 0.7]) line(`Title similarity to a mill-retracted title >= ${t}`, r => r.titleSim >= t);
if (LISTS) {
  line('Cites a citejacked journal (Problematic Paper Screener)', r => r.citejacked >= 1);
  line('Cites 2+ references to citejacked journals', r => r.citejacked >= 2);
  line('Cites a journal discontinued by Scopus, after coverage ended', r => r.scopusDropped >= 1);
  line('3+ such references (Scopus discontinued)', r => r.scopusDropped >= 3);
  line('Cites a journal with a known hijacked clone (name match)', r => r.clone >= 1);
  line("Cites a journal on Beall's list", r => r.predatory >= 1);
}
process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
