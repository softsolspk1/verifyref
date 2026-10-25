// benchmark-papermill.js - measures how well the Module 4 TEXT signals separate papers retracted for paper-mill reasons
// from ordinary papers of the same journals and years.
//   positives: Retraction Watch records with reason "Paper Mill" whose full text is open access in Europe PMC
//   controls : open-access papers from the same journal and year that are not in Retraction Watch
// Only the offline text logic is tested (tortured phrases, SCIgen, AI leftovers, templates, vague methods, hidden text,
// misidentified cell lines) - the same function the live tool uses. Reference, author and image signals need network
// look-ups and are not part of this benchmark.
// Usage: node scripts/benchmark-papermill.js [pairs=100]
require('../src/config');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { textSignals, riskLevel } = require('../src/papermill');

const RESCORE = process.argv.includes('--rescore');
const N = parseInt(process.argv[2], 10) || 100;
const DIR = path.join(__dirname, '..', 'data', 'benchmark');
const XML = path.join(DIR, 'xml');
fs.mkdirSync(XML, { recursive: true });
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'PJPS-benchmark' }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch (e) { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return null;
}
const search = async q => {
  const t = await get(`${EPMC}/search?query=${encodeURIComponent(q)}&format=json&resultType=lite&pageSize=100`);
  try { return JSON.parse(t).resultList.result || []; } catch (e) { return []; }
};

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function xmlToText(xml) {
  const title = (xml.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/) || [])[1] || '';
  const abs = (xml.match(/<abstract[\s\S]*?<\/abstract>/) || [''])[0];
  let body = (xml.match(/<body>[\s\S]*<\/body>/) || [''])[0];
  body = body.replace(/<ref-list[\s\S]*?<\/ref-list>/g, '').replace(/<xref[^>]*>[\s\S]*?<\/xref>/g, '').replace(/<table-wrap[\s\S]*?<\/table-wrap>/g, '');
  const clean = x => x.replace(/<\/(p|title|sec|caption)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&([a-z]+);/g, (m, e) => ENT[e] ?? m).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title: clean(title), text: clean(abs) + '\n' + clean(body) };
}

async function fullText(pmcid) {
  const f = path.join(XML, `${pmcid}.xml`);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const x = await get(`${EPMC}/${pmcid}/fullTextXML`);
  if (x) fs.writeFileSync(f, x);
  await sleep(150);
  return x;
}

function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}
const pct = x => `${(x * 100).toFixed(1)}%`;

(async () => {
  let pos = [], ctl = [];
  if (RESCORE) {   // score exactly the papers of the previous run with the current code
    const prev = JSON.parse(fs.readFileSync(path.join(DIR, 'results.json'), 'utf8'));
    pos = prev.filter(r => r.group === 'mill'); ctl = prev.filter(r => r.group === 'control');
  }
  const mill = RESCORE ? [] : await db.all(`SELECT doi, journal, retraction_date FROM retractions WHERE reason ILIKE '%paper mill%' AND nature ILIKE '%retraction%' AND doi IS NOT NULL ORDER BY random() LIMIT ${N * 12}`);
  console.log(`candidate paper-mill retractions: ${mill.length}`);
  for (let i = 0; i < mill.length && pos.length < N; i += 20) {
    const batch = mill.slice(i, i + 20);
    const res = await search(`(${batch.map(b => `DOI:"${b.doi}"`).join(' OR ')}) AND OPEN_ACCESS:y AND HAS_FT:y`);
    for (const r of res) if (r.pmcid && r.doi && pos.length < N && !pos.some(p => p.pmcid === r.pmcid)) pos.push({ pmcid: r.pmcid, doi: r.doi.toLowerCase(), journal: r.journalTitle, year: r.pubYear, title: r.title });
    process.stdout.write(`\rpositives with open full text: ${pos.length}/${N}`);
    await sleep(200);
  }
  console.log();
  const retractedDois = new Set((await db.all('SELECT doi FROM retractions')).map(r => r.doi));
  for (const p of RESCORE ? [] : pos) {
    if (!p.journal || !p.year) continue;
    const res = await search(`JOURNAL:"${p.journal}" AND PUB_YEAR:${p.year} AND OPEN_ACCESS:y AND HAS_FT:y`);
    const pool = res.filter(r => r.pmcid && r.doi && !retractedDois.has(r.doi.toLowerCase()) && !ctl.some(c => c.pmcid === r.pmcid) && !pos.some(x => x.pmcid === r.pmcid));
    if (pool.length) { const r = pool[Math.floor(Math.random() * pool.length)]; ctl.push({ pmcid: r.pmcid, doi: r.doi.toLowerCase(), journal: r.journalTitle, year: r.pubYear, title: r.title }); }
    process.stdout.write(`\rmatched controls: ${ctl.length}/${pos.length}`);
    await sleep(200);
  }
  console.log();

  const rows = [];
  for (const [group, list] of [['mill', pos], ['control', ctl]]) {
    let k = 0;
    for (const p of list) {
      const xml = await fullText(p.pmcid);
      k++;
      if (!xml) continue;
      const { text } = xmlToText(xml);
      if (text.length < 3000) continue;   // abstract-only or very short records are not a fair test
      const sigs = await textSignals(text, text, []);
      const risk = riskLevel(sigs);
      rows.push({ group, pmcid: p.pmcid, doi: p.doi, journal: p.journal, year: p.year, title: p.title, words: text.split(/\s+/).length, level: risk.level, score: risk.score, signals: sigs.map(s => `${s.code}:${s.severity}`) });
      process.stdout.write(`\r${group}: ${k}/${list.length}   `);
    }
    console.log();
  }
  fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(rows, null, 1));

  const M = rows.filter(r => r.group === 'mill'), C = rows.filter(r => r.group === 'control');
  const at = (arr, levels) => arr.filter(r => levels.includes(r.level)).length;
  const codes = [...new Set(rows.flatMap(r => r.signals.map(s => s.split(':')[0])))].sort();
  const line = (name, arr, levels) => { const k = at(arr, levels), [lo, hi] = wilson(k, arr.length); return `| ${name} | ${k}/${arr.length} | ${pct(k / (arr.length || 1))} | ${pct(lo)} – ${pct(hi)} |`; };
  let md = `# Paper Mill Detection - text-signal benchmark\n\nGenerated ${new Date().toISOString().slice(0, 10)}. ${M.length} papers retracted for paper-mill reasons (Retraction Watch) against ${C.length} ordinary papers from the same journals and years (Europe PMC open access, not in Retraction Watch). Only the offline text signals were scored: the same \`textSignals\` function the live tool uses.\n\n`;
  md += `## Flag rates\n\n| Threshold | Papers flagged | Rate | 95% interval |\n|---|---|---|---|\n`;
  md += line('Retracted papers flagged MEDIUM or HIGH (recall)', M, ['MEDIUM', 'HIGH']) + '\n' + line('Retracted papers flagged HIGH', M, ['HIGH']) + '\n';
  md += line('Control papers flagged MEDIUM or HIGH (false-positive rate)', C, ['MEDIUM', 'HIGH']) + '\n' + line('Control papers flagged HIGH', C, ['HIGH']) + '\n';
  const tp = at(M, ['MEDIUM', 'HIGH']), fp = at(C, ['MEDIUM', 'HIGH']);
  md += `\nPrecision when the tool says MEDIUM or HIGH (with this 50/50 sample): ${pct(tp / ((tp + fp) || 1))}. In real submissions mill papers are much rarer than 50%, so real-world precision is lower: with 2% mill papers and the rates above, roughly ${pct((0.02 * tp / (M.length || 1)) / ((0.02 * tp / (M.length || 1)) + (0.98 * fp / (C.length || 1)) || 1))} of flagged papers would truly be mill papers.\n\n`;
  md += `## Which signals fire\n\n| Signal | Retracted | Control |\n|---|---|---|\n`;
  for (const c of codes) md += `| ${c} | ${M.filter(r => r.signals.some(s => s.startsWith(c + ':'))).length}/${M.length} | ${C.filter(r => r.signals.some(s => s.startsWith(c + ':'))).length}/${C.length} |\n`;
  md += `\n## Control papers flagged (false positives to inspect)\n\n`;
  for (const r of C.filter(r => r.level !== 'LOW')) md += `- ${r.level} (${r.score}) https://doi.org/${r.doi} - ${r.signals.join(', ')}\n`;
  md += `\n## Limits of this benchmark\n\n- The Problematic Paper Screener fingerprints were themselves built from papers like these, so the recall figure measures recognition of known cases and overstates performance on new mill output.\n- Controls come from the same journals and could contain undiscovered mill papers, which would inflate the false-positive rate slightly.\n- Many mill papers are retracted for image, authorship or peer-review reasons that leave no trace in the text; the text signals cannot catch those.\n- Only open-access papers could be tested.\n`;
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'benchmark-papermill.md'), md);
  console.log(md.split('## Which signals fire')[0]);
  process.exit(0);
})();
