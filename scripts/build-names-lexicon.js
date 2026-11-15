#!/usr/bin/env node
// build-names-lexicon.js - PJPS Scribe (Module 6) author names learned from published research: the authors of every PJPS
// article and the surnames in the reference lists and citations of the PJPS articles and of a sample of PubMed Central
// open-access papers (Liu J, Gao X, Mlinac ME; Xia and Fang, 2007; Leasure et al., 2021). A surname written as a name
// (capital first letter) is then not a spelling mistake in a manuscript.
//   [--packs 30]   PMC text packs sampled evenly across the repository (~1,000 papers each)
//   [--min-df 3]   papers a surname must be cited in (the PJPS authors themselves are always kept)
//   [--counts F]   where the counts are saved (default D:/pjps-tmp/names-counts.json.gz)
//   --from-counts  rebuild the list from the saved counts without reading the papers again
// A rare "name" one letter from an English word (a misspelling caught by the patterns) is left out; a surname cited in
// many papers (Liu, Gao, Lee) is kept. Writes src/language/dict/names.txt
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const U = require('../src/uploads');
const B = require('../src/corpusBulk');

const argv = process.argv.slice(2);
const opt = (name, d) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : d);
const PACKS = parseInt(opt('packs', '30'), 10);
const MIN_DF = parseInt(opt('min-df', '3'), 10);
const COUNTS = opt('counts', 'D:/pjps-tmp/names-counts.json.gz');
const OUT = path.join(__dirname, '..', 'src', 'language', 'dict', 'names.txt');

const df = new Map();   // surname -> papers citing it
const pjpsAuthors = new Set();
let docs = 0;

const NAME = "[A-Z][a-z'’]+(?:-[A-Z][a-z'’]+)?";
// reference lists: "Liu J, Sun C, Wang Y" / "Liu, J., Sun, C." ; citations: "(Xia and Fang, 2007)", "Leasure et al., 2021"
const RE = [
  new RegExp(`(?:^|[,;]\\s*|\\n\\s*(?:\\d+\\.?\\s*)?)(${NAME})\\s+[A-Z]{1,3}(?=[,.;(]|\\s+(?:and|&)\\b|\\s*\\()`, 'gm'),
  new RegExp(`(?:^|[,;&]\\s*|\\n\\s*(?:\\d+\\.?\\s*)?)(${NAME}),\\s+(?:[A-Z]\\.\\s?){1,3}`, 'gm'),
  new RegExp(`(${NAME})(?=\\s+et\\s+al\\b|\\s+(?:and|&)\\s+${NAME},?\\s+(?:19|20)\\d\\d|,\\s+(?:19|20)\\d\\d[a-z]?\\))`, 'g'),
  new RegExp(`(?:and|&)\\s+(${NAME}),?\\s+(?:19|20)\\d\\d`, 'g')
];
const STOP = new Set('The This That These Those There Their They Then Than When Where Which While What With Within Without From Into Onto Upon After Before Between Among Table Figure Fig Results Methods Discussion Introduction Conclusion Abstract Background Objective Objectives Data Group Groups Control Patients Study Studies Journal Vol Volume Issue Pages Department University Hospital College Institute School Center Centre Faculty Pakistan China India Science Sciences Pharm Pharmacy Medical Medicine Res Int Rev Clin Biol Chem Med Sci Dis Health Care Available Accessed Online Press Ltd Inc Co Supplementary In On At By For Of And Or To As Is Are Was Were Be All Each Both Some Other Total Mean However Therefore Also Thus Here Our We It An'.split(' '));

function addDoc(text) {
  docs++;
  const seen = new Set();
  for (const re of RE) {
    for (const m of text.matchAll(re)) {
      const n = m[1].replace(/’/g, "'");
      if (n.length < 2 || STOP.has(n)) continue;
      for (const part of n.split('-')) if (part.length >= 2 && !STOP.has(part)) seen.add(part);
    }
  }
  for (const n of seen) df.set(n, (df.get(n) || 0) + 1);
}

async function fetchObject(key, tries = 4) {
  for (let k = 1; ; k++) {
    try { return await U.getObject(key); } catch (e) {
      if (k >= tries) throw e;
      await new Promise(r => setTimeout(r, 2000 * k));
    }
  }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

(async () => {
  const t0 = Date.now();
  if (argv.includes('--from-counts')) {
    const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(COUNTS)).toString('utf8'));
    docs = c.docs;
    for (const [n, k] of c.df) df.set(n, k);
    for (const n of c.pjpsAuthors) pjpsAuthors.add(n);
    write(t0);
    process.exit(0);
  }
  const db = require('../src/db');
  await db.init();
  // the authors of the PJPS articles: "M. Saeed Arayne; Najma Sultana; Agha Zeeshan Mirza"
  for (const r of await db.all('SELECT authors FROM pjps_articles WHERE authors IS NOT NULL')) {
    for (const w of String(r.authors).match(/[A-Z][a-z'’]+(?:-[A-Z][a-z'’]+)?/g) || []) for (const p of w.split('-')) if (p.length >= 3 && !STOP.has(p)) pjpsAuthors.add(p.replace(/’/g, "'"));
  }
  console.log(`PJPS authors: ${pjpsAuthors.size} names`);
  const rows = await db.all("SELECT r2_key FROM corpus_docs WHERE source_key LIKE 'pjps:%' AND r2_key IS NOT NULL");
  await pool(rows, 12, async r => {
    const gz = await fetchObject(r.r2_key).catch(() => null);
    if (gz) addDoc(zlib.gunzipSync(gz).toString('utf8'));
  });
  console.log(`PJPS articles: ${rows.length} read, ${df.size} surnames (${Math.round((Date.now() - t0) / 1000)} s)`);
  const m = await B.getManifest('pmc', { fresh: true });
  const step = m.packs / PACKS;
  const packs = Array.from({ length: PACKS }, (_, k) => Math.floor(k * step + step / 2)).filter(p => (m.packSizes[p] || 0) > 100);
  let done = 0;
  await pool(packs, 6, async p => {
    let bin, cat;
    try { [bin, cat] = await Promise.all([fetchObject(`bulk/pmc/text/p${p}.bin`), fetchObject(`bulk/pmc/cat/p${p}.json`)]); } catch (e) { console.log(`PMC pack ${p}: skipped (${e.message})`); return; }
    for (const d of JSON.parse(cat.toString('utf8'))) {
      try { addDoc(zlib.gunzipSync(bin.subarray(d.off, d.off + d.len)).toString('utf8')); } catch { /* damaged member */ }
    }
    console.log(`PMC pack ${p}: ${++done}/${packs.length}, ${docs} papers, ${df.size} surnames (${Math.round((Date.now() - t0) / 1000)} s)`);
  });
  fs.writeFileSync(COUNTS, zlib.gzipSync(JSON.stringify({ docs, df: [...df].filter(([, n]) => n >= 2), pjpsAuthors: [...pjpsAuthors] })));
  write(t0);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
function edits1(w) {
  const out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b) out.add(a + b.slice(1));
    if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2));
    for (const c of ALPHA) { if (b) out.add(a + c + b.slice(1)); out.add(a + c + b); }
  }
  out.delete(w);
  return out;
}

function write(t0) {
  const sp = require('../src/language/spell').load('en-US');
  const names = new Set();
  let slips = 0;
  for (const n of new Set([...pjpsAuthors, ...[...df].filter(([, c]) => c >= MIN_DF).map(([n]) => n)])) {
    if (!/^[A-Z][a-z']+$/.test(n)) continue;
    const lower = n.toLowerCase();
    if (sp.correct(lower) || sp.correct(n)) continue; // a dictionary word or name already: nothing to add
    const c = df.get(n) || 0;
    if (c < 25 && [...edits1(lower)].some(e => e.length >= 4 && sp.correct(e))) { slips++; continue; }
    names.add(n);
  }
  const list = [...names].sort();
  console.log(`${slips} rare names one letter from an English word left out`);
  fs.writeFileSync(OUT, `# PJPS Scribe author names: PJPS authors and surnames cited in ${docs} published papers (scripts/build-names-lexicon.js)\n${list.join('\n')}\n`);
  console.log(`${list.length} names written to ${OUT} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
