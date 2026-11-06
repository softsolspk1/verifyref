// benchmark-papermill-combined.js - Module 4 as the live tool scores a manuscript: the text signals, the look-alike signal
// and the reference signals ADDED UP into one risk level (src/papermill/index.js weights and thresholds), on the papers of
// benchmark-papermill.js (150 retracted for paper-mill reasons vs 126 ordinary papers of the same journals and years).
// The separate benchmarks measure each family alone; a manuscript with several weak signals is only seen here.
// Not measurable on this set (no data): author signals (ORCID, e-mails, earlier retractions), images, submission history.
// Needs data/benchmark/results.json + xml/ (benchmark-papermill.js), data/public-images/retractionwatch.csv, the mill
// abstracts file (scripts/load-mill-abstracts.js) and the database (journal lists).
// Usage: node scripts/benchmark-papermill-combined.js [--json out.json]
require('../src/config');
const fs = require('fs');
const path = require('path');
const { csvToObjects } = require('../src/datasets');
const D = require('../src/datasets');
const MI = require('../src/papermill/millIndex');
const { normalizeJournal } = require('../src/text');

const ROOT = path.join(__dirname, '..', 'data');
const DIR = path.join(ROOT, 'benchmark');
const MILL = /paper mill|fake peer review|peer review manipul|randomly generated|computer-aided content/i;
const STOP = new Set(['of', 'and', 'the', 'in', 'for', 'on', '&']);
const clean = x => String(x || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// journals with paper-mill retractions, and the DOIs of the retracted papers (Retraction Watch)
const rw = csvToObjects(fs.readFileSync(path.join(ROOT, 'public-images', 'retractionwatch.csv'), 'utf8')).filter(r => /retraction/i.test(r.RetractionNature));
const perJournal = new Map(), millDoi = new Set();
for (const r of rw) {
  if (!MILL.test(r.Reason)) continue;
  const k = normalizeJournal(r.Journal);
  perJournal.set(k, (perJournal.get(k) || 0) + 1);
  if (r.OriginalPaperDOI) millDoi.add(r.OriginalPaperDOI.toLowerCase());
}
const jlist = [...perJournal].map(([k, n]) => ({ k, n, words: k.split(' ').filter(w => !STOP.has(w)) }));
function millCount(name) {
  const k = normalizeJournal(name);
  if (perJournal.has(k)) return perJournal.get(k);
  const w = k.split(' ').filter(x => !STOP.has(x));
  if (w.length < 2) return 0;
  const j = jlist.find(j => j.words.length === w.length && w.every((x, i) => j.words[i].startsWith(x)));
  return j ? j.n : 0;
}
const listCache = new Map();
async function listsFor(name) {
  const k = normalizeJournal(name);
  if (!k) return {};
  if (!listCache.has(k)) {
    const [pred, hits] = await Promise.all([D.predatoryMatches({ journal: name }).catch(() => []), D.listLookupAll([], name).catch(() => ({}))]);
    const m = pred.filter(x => x.source !== 'stoppredatoryjournals.com');
    const sd = hits.scopus_discontinued && !/policy/i.test(hits.scopus_discontinued.data?.['Indexation Change'] || '') ? (parseInt(hits.scopus_discontinued.data?.Year, 10) || 0) : null;
    listCache.set(k, { predatory: m.some(x => x.kind !== 'hijacked'), citejacked: !m.some(x => x.kind !== 'hijacked') && m.some(D.isCitejacked), scopusDropped: sd });
  }
  return listCache.get(k);
}

/** The reference and look-alike signals of one paper, with the live tool's weights: [{ code, severity, weight }] */
async function extraSignals(p, xml) {
  const out = [];
  const add = (code, severity, weight) => out.push({ code, severity, weight });
  const refs = [...((xml.match(/<ref-list[\s\S]*<\/ref-list>/) || [''])[0]).matchAll(/<ref[ >][\s\S]*?<\/ref>/g)].map(m => m[0]);
  const sources = refs.map(r => clean((r.match(/<source>([\s\S]*?)<\/source>/) || [])[1] || ''));
  const dois = refs.map(r => ((r.match(/pub-id-type="doi">([^<]+)</) || [])[1] || '').toLowerCase().trim()).filter(d => d && d !== p.doi.toLowerCase());
  const years = refs.map(r => parseInt((r.match(/<year[^>]*>(\d{4})/) || [])[1], 10) || 0);
  // cited papers retracted for paper-mill reasons: one = medium (2); two or more = high, 4 each (max 8)
  const millCited = dois.filter(d => millDoi.has(d)).length;
  if (millCited) add('mill-retraction', millCited >= 2 ? 'high' : 'medium', millCited >= 2 ? Math.min(8, 4 * millCited) : 2);
  // journals with many paper-mill retractions
  const inMill = sources.filter(s => s && millCount(s) >= 20).length, share = refs.length ? inMill / refs.length : 0;
  if (inMill >= 3 && share >= 0.15) add('mill-journals', inMill >= 5 && share >= 0.2 ? 'medium' : 'low', inMill >= 5 && share >= 0.2 ? 2 : 1);
  // predatory / citejacked / Scopus-discontinued journals (counted per reference, as the live tool does per journal)
  let predatory = 0, citejacked = 0, dropped = 0;
  for (let i = 0; i < sources.length; i++) {
    if (!sources[i]) continue;
    const l = await listsFor(sources[i]);
    if (l.predatory) predatory++;
    else if (l.citejacked) citejacked++;
    if (l.scopusDropped !== null && l.scopusDropped !== undefined && years[i] >= l.scopusDropped) dropped++;
  }
  if (predatory) add('predatory', predatory >= 3 ? 'medium' : 'low', predatory >= 3 ? 3 : 1);
  if (citejacked) add('citejacked', citejacked >= 2 ? 'medium' : 'low', citejacked >= 2 ? 2 : 1);
  if (dropped) add('scopus-discontinued', 'low', dropped >= 3 ? 1 : 0);
  // cited papers flagged in published integrity audits (not retracted)
  const flagged = (await D.flaggedFor(dois).catch(() => new Map())).size;
  if (flagged) add('flagged-refs', flagged >= 3 ? 'medium' : 'low', flagged >= 3 ? 2 : 1);
  // look-alike of known mill papers (title + abstract, title alone)
  const front = (xml.match(/<front>[\s\S]*?<\/front>/) || [''])[0];
  const title = clean((front.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/) || [])[1]);
  const abs = clean((front.match(/<abstract[\s\S]*?<\/abstract>/) || [''])[0]);
  const a = await MI.abstractLookalikes(title, abs, { doi: p.doi }).catch(() => null);
  const t = await MI.titleLookalikes(title, { doi: p.doi }).catch(() => []);
  const top = a?.[0]?.score || 0;
  const [aSev, aW] = top >= 0.2 ? ['medium', 4] : top >= 0.17 ? ['medium', 3] : top >= 0.14 ? ['low', 2] : [null, 0];
  const [tSev, tW] = t.length ? (t[0].score >= 0.6 || t.length >= 3 ? ['medium', 2] : ['low', 1]) : [null, 0];
  if (aW || tW) add('mill-lookalike', aW >= tW ? aSev : tSev, Math.max(aW, tW));
  return out;
}

const level = sigs => {
  const score = sigs.reduce((a, s) => a + s.weight, 0), highs = sigs.filter(s => s.severity === 'high').length;
  return { level: score >= 8 || highs >= 2 ? 'HIGH' : score >= 4 || highs === 1 ? 'MEDIUM' : 'LOW', score };
};

(async () => {
  const bench = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
  const rows = [];
  let k = 0;
  for (const p of bench) {
    const f = path.join(DIR, 'xml', `${p.pmcid}.xml`);
    k++;
    if (!fs.existsSync(f)) continue;
    const text = p.signals.map(s => { const [code, severity] = s.split(':'); return { code, severity, weight: 0 }; });
    // the text signals' weights: the score of benchmark-papermill.js is their sum, kept as one entry
    const sigs = [...text, { code: 'text-score', severity: null, weight: p.score }, ...await extraSignals(p, fs.readFileSync(f, 'utf8'))];
    rows.push({ group: p.group, pmcid: p.pmcid, half: parseInt(p.pmcid.replace(/\D/g, ''), 10) % 2 ? 'B' : 'A', title: p.title, codes: sigs.filter(s => s.weight || s.severity === 'high').map(s => `${s.code}:${s.severity}:${s.weight}`), ...level(sigs), textLevel: p.level });
    process.stdout.write(`\r${k}/${bench.length}   `);
  }
  console.log();
  const n = (g, fn) => { const r = rows.filter(x => x.group === g); return `${r.filter(fn).length}/${r.length} (${(100 * r.filter(fn).length / r.length).toFixed(1)}%)`; };
  console.log('| Scoring | Mill papers MEDIUM+ | Ordinary papers MEDIUM+ | Mill HIGH | Ordinary HIGH |\n|---|---|---|---|---|');
  console.log(`| Text signals only | ${n('mill', r => r.textLevel !== 'LOW')} | ${n('control', r => r.textLevel !== 'LOW')} | ${n('mill', r => r.textLevel === 'HIGH')} | ${n('control', r => r.textLevel === 'HIGH')} |`);
  console.log(`| All measurable signals added up (live tool) | ${n('mill', r => r.level !== 'LOW')} | ${n('control', r => r.level !== 'LOW')} | ${n('mill', r => r.level === 'HIGH')} | ${n('control', r => r.level === 'HIGH')} |`);
  const fired = new Map();
  for (const r of rows) for (const c of new Set(r.codes.map(x => x.split(':')[0]))) { const e = fired.get(c) || { mill: 0, control: 0 }; e[r.group]++; fired.set(c, e); }
  console.log('\nSignals with weight that fired (papers):');
  for (const [c, e] of [...fired].sort((a, b) => b[1].mill - a[1].mill)) console.log(`  ${c.padEnd(22)} mill ${e.mill}  ordinary ${e.control}`);
  console.log('\nOrdinary papers flagged MEDIUM+ (false alarms):');
  for (const r of rows.filter(x => x.group === 'control' && x.level !== 'LOW')) console.log(`  ${r.level} ${r.score}  ${String(r.title).slice(0, 90)}  [${r.codes.join(', ')}]`);
  const j = process.argv.indexOf('--json');
  if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(rows, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
