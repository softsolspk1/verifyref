// benchmark-papermill-authors.js - Module 4's earlier-retraction author signals on the papers of benchmark-papermill.js
// (retracted for paper-mill reasons vs ordinary papers of the same journals and years) whose full text names the authors
// and their affiliations. Each paper's own retraction is left out. Ordinary papers are not in Retraction Watch, but some
// of their authors may truly have earlier retractions, so the false-alarm figures are an upper bound.
// Needs data/benchmark/results.json + xml/ (benchmark-papermill.js) and the database (Retraction Watch table).
// Usage: node scripts/benchmark-papermill-authors.js [--json out.json]
require('../src/config');
const fs = require('fs');
const path = require('path');
const { authorRetractions } = require('../src/papermill');
const db = require('../src/db');
const { MILL_REASON_RE } = require('../src/datasets');
const { splitName } = require('../src/text');

const DIR = path.join(__dirname, '..', 'data', 'benchmark');
const clean = x => String(x || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

function front(xml) {
  const f = (xml.match(/<front>[\s\S]*?<\/front>/) || [''])[0];
  const authors = [...f.matchAll(/<contrib[^>]*contrib-type="author"[\s\S]*?<\/contrib>/g)].map(m => ({
    family: clean((m[0].match(/<surname>([\s\S]*?)<\/surname>/) || [])[1]),
    given: clean((m[0].match(/<given-names[^>]*>([\s\S]*?)<\/given-names>/) || [])[1])
  })).filter(a => a.family);
  const affiliations = [...f.matchAll(/<aff[ >][\s\S]*?<\/aff>/g)].map(m => clean(m[0].replace(/<label>[\s\S]*?<\/label>/g, ''))).filter(Boolean);
  return { authors, affiliations };
}

(async () => {
  const bench = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
  const rows = [];
  let k = 0;
  for (const p of process.argv.includes("--people-only") ? [] : bench) {
    k++;
    const f = path.join(DIR, 'xml', `${p.pmcid}.xml`);
    if (!fs.existsSync(f)) continue;
    const { authors, affiliations } = front(fs.readFileSync(f, 'utf8'));
    if (!authors.length || !affiliations.length) continue;
    const own = String(p.doi || '').toLowerCase();
    const hits = (await authorRetractions(authors, affiliations)).filter(r => String(r.doi || '').toLowerCase() !== own);
    const high = hits.filter(r => r.mill && r.confidence === 'high');
    const medium = hits.filter(r => r.confidence !== 'low' && !high.includes(r));
    rows.push({ group: p.group, pmcid: p.pmcid, half: parseInt(p.pmcid.replace(/\D/g, ''), 10) % 2 ? 'B' : 'A', high: high.length, medium: medium.length, coauthor: hits.filter(r => r.coauthors?.length).length,
      evidence: [...high, ...medium].slice(0, 4).map(r => `${r.confidence} ${r.author} | ${r.coauthors?.length ? 'co-authors ' + r.coauthors.join(', ') + ' | ' : ''}${(r.institutionMatch || []).join(', ')} | ${String(r.title).slice(0, 60)}`) });
    process.stdout.write(`\r${k}/${bench.length}   `);
  }
  console.log();
  const n = (g, fn, half) => { const r = rows.filter(x => x.group === g && (!half || x.half === half)); return `${r.filter(fn).length}/${r.length}`; };
  for (const half of [null, 'A', 'B']) {
    console.log(`${half ? 'Half ' + half : 'All'}: HIGH author signal mill ${n('mill', r => r.high, half)} ordinary ${n('control', r => r.high, half)}; medium mill ${n('mill', r => r.medium, half)} ordinary ${n('control', r => r.medium, half)}`);
  }
  console.log('\nOrdinary papers with the HIGH author signal:');
  for (const r of rows.filter(x => x.group === 'control' && x.high)) console.log(`  ${r.pmcid}  ${r.evidence.join('  //  ')}`);
  // Real retractees (recall): first authors with two or more paper-mill retractions, 60 from Pakistan and 60 from China.
  // The "manuscript" gives the person's name and the institution of one retraction (left out); the others should still
  // reach the high signal.
  const people = [];
  for (const country of ['Pakistan', 'China']) {
    const rs = await db.all("SELECT doi, authors, institution, reason FROM retractions WHERE country ILIKE $1 AND nature ILIKE '%retraction%' AND institution <> '' ORDER BY doi", [`%${country}%`]);
    const byName = new Map();
    for (const r of rs) {
      if (!MILL_REASON_RE.test(r.reason || '')) continue;
      const first = String(r.authors || '').split(/\s*;\s*/)[0];
      const n = splitName(first);
      if (!n.family || n.given.replace(/[.\s]/g, '').length < 2) continue;
      const key = `${n.given} ${n.family}`.toLowerCase();
      if (!byName.has(key)) byName.set(key, { n, rows: [] });
      byName.get(key).rows.push(r);
    }
    people.push(...[...byName.values()].filter(p => p.rows.length >= 2).slice(0, 60).map(p => ({ ...p, country })));
  }
  const recall = { Pakistan: [0, 0], China: [0, 0] };
  const missed = [];
  for (const p of people) {
    const [mine, ...rest] = p.rows;
    const restDois = new Set(rest.map(r => String(r.doi).toLowerCase()));
    const hits = (await authorRetractions([p.n], [mine.institution])).filter(r => restDois.has(String(r.doi || '').toLowerCase()));
    const ok = hits.some(r => r.mill && r.confidence === 'high');
    recall[p.country][1]++;
    if (ok) recall[p.country][0]++;
    else missed.push(`${p.country} ${p.n.given} ${p.n.family} | ${mine.institution.slice(0, 70)} | ${hits.map(h => h.confidence).join(',') || 'not found'}`);
  }
  console.log(`\nReal retractees still HIGH (own institution): Pakistan ${recall.Pakistan.join('/')}; China ${recall.China.join('/')}`);
  for (const m of missed.slice(0, 15)) console.log(`  missed: ${m}`);
  const j = process.argv.indexOf('--json');
  if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(rows, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
