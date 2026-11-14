#!/usr/bin/env node
// build-research-lexicon.js - PJPS Scribe (Module 6) vocabulary learned from published research: every PJPS article and a
// sample of the PubMed Central open-access papers in the PJPS subject areas (medicine, pharmacy, pharmacology, chemistry).
// A word the general English dictionaries lack but that several independent published papers use is a real term
// (adenomyosis, myometrial, sonographer, Kaplan, Bonferroni), not a misspelling.
//   [--packs 60]   PMC text packs sampled evenly across the repository (~1,000 papers each)
//   [--min-df 4]   published papers a word must appear in
//   [--no-pjps]    leave out the PJPS articles
//   [--counts F]   where the word counts are saved (default D:/pjps-tmp/research-lexicon-counts.json.gz)
//   [--no-fda]     leave out the drug names of the FDA Orange Book dataset (ingredients and brand names)
//   --from-counts  rebuild the lists from the saved counts without reading the papers again (seconds, to tune the rules)
// Writes src/language/dict/research.txt (terms) and src/language/dict/research-common.txt (words most research articles
// use: not "overused" when a paragraph repeats them).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const U = require('../src/uploads');
const B = require('../src/corpusBulk');
const S = require('../src/language/spell');

const argv = process.argv.slice(2);
const opt = (name, d) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : d);
const PACKS = parseInt(opt('packs', '60'), 10), MIN_DF = parseInt(opt('min-df', '4'), 10);
const OUT = path.join(__dirname, '..', 'src', 'language', 'dict');
const COUNTS = opt('counts', 'D:/pjps-tmp/research-lexicon-counts.json.gz');

const df = new Map();       // lower-case word -> papers using it
const lowerDf = new Map();  // lower-case word -> papers using it in lower case
let docs = 0;

function addDoc(text) {
  // the reference list is names and abbreviated journal titles: not vocabulary
  const cut = text.search(/\n\s*(?:references|bibliography|literature cited)\s*\n/i);
  const body = cut > 2000 ? text.slice(0, cut) : text;
  const seen = new Set(), seenLower = new Set();
  for (const m of body.matchAll(/[A-Za-z][A-Za-z']*[A-Za-z]/g)) {
    for (const part of m[0].replace(/'s$/, '').split('-')) {
      if (part.length < 3 || part.length > 40 || /^[A-Z]{2,}s?$/.test(part) || /[a-z][A-Z]/.test(part)) continue;
      const k = part.toLowerCase();
      seen.add(k);
      if (part === k) seenLower.add(k);
    }
  }
  for (const k of seen) df.set(k, (df.get(k) || 0) + 1);
  for (const k of seenLower) lowerDf.set(k, (lowerDf.get(k) || 0) + 1);
  docs++;
}

/** An R2 object, tried again after a dropped connection (a long run meets a few) */
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

// the slips a typist makes: a letter dropped, added or swapped with its neighbour, or a key next to the intended one
// ("occured", "teh", "recieved", "signficant"); "fundal" / "fungal" (d and g are not neighbours) is two different words
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const NEAR = {};
ROWS.forEach((r, y) => [...r].forEach((ch, x) => { NEAR[ch] = new Set(); ROWS.forEach((r2, y2) => [...r2].forEach((c2, x2) => { if (c2 !== ch && Math.abs(y - y2) <= 1 && Math.abs(x - x2 + (y - y2) * 0.5) <= 1) NEAR[ch].add(c2); })); }));
function slips(w) {
  const out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b) out.add(a + b.slice(1));
    if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2));
    for (const c of ALPHA) out.add(a + c + b);
    if (b) for (const c of NEAR[b[0]] || []) out.add(a + c + b.slice(1));
  }
  out.delete(w);
  return out;
}

// garbled PDF / XML text ("hcmxw", "rplatz"): no vowel, or a start no English, Latin, Greek or transcribed name has
const START = /^(?:[aeiouy]|[bcdfghjklmnpqrstvwxz][aeiouy]|bh|bl|br|ch|chl|chr|cl|cn|cr|ct|dh|dj|dr|dv|dw|dz|fj|fl|fr|gh|gl|gn|gr|gw|hr|hv|jh|kh|kl|kn|kr|ks|kv|kw|ll|mb|mn|nd|ng|nk|nt|ny|ph|phl|phr|pl|pn|pr|ps|pt|qu|rh|sc|sch|scr|sh|shr|sk|sl|sm|sn|sp|sph|spl|spr|sq|st|str|sv|sw|sz|th|thr|tr|ts|tsh|tw|tz|vl|vr|wh|wr|xh|zh|zl|zw)/;
const GLUE = ['of', 'the', 'and', 'in', 'to', 'for', 'with', 'on', 'by', 'at', 'from', 'was', 'were', 'is', 'are', 'an', 'as', 'or', 'that', 'this', 'which', 'be', 'not', 'than'];
const garbled = w => !/[aeiouy]/.test(w) || !START.test(w) || /[bcdfghjklmnpqrstvwxz]{5}/.test(w.replace(/(?:sch|chth|phth|ngst|tsch)/g, 'a'));

(async () => {
  const t0 = Date.now();
  if (argv.includes('--from-counts')) {
    const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(COUNTS)).toString('utf8'));
    docs = c.docs;
    for (const [k, n] of c.df) df.set(k, n);
    for (const [k, n] of c.lowerDf) lowerDf.set(k, n);
  } else await read(t0);
  build(t0, argv.includes('--no-fda') ? [] : await drugNames());
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

async function read(t0) {
  if (!argv.includes('--no-pjps')) {
    const db = require('../src/db');
    await db.init();
    const rows = await db.all("SELECT r2_key FROM corpus_docs WHERE source_key LIKE 'pjps:%' AND r2_key IS NOT NULL");
    await pool(rows, 12, async r => {
      const gz = await fetchObject(r.r2_key).catch(() => null);
      if (gz) addDoc(zlib.gunzipSync(gz).toString('utf8'));
    });
    console.log(`PJPS articles: ${rows.length} read, ${df.size} distinct words (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
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
    console.log(`PMC pack ${p}: ${++done}/${packs.length}, ${docs} papers, ${df.size} distinct words (${Math.round((Date.now() - t0) / 1000)} s)`);
  });
  // words in fewer than 2 papers are left out of the saved counts (typos, garbled PDF text)
  fs.writeFileSync(COUNTS, zlib.gzipSync(JSON.stringify({ docs, df: [...df].filter(([, n]) => n >= 2), lowerDf: [...lowerDf].filter(([, n]) => n >= 2) })));
}

/** Ingredient and brand names of the FDA Orange Book dataset (approved drug products): [word] */
async function drugNames() {
  const db = require('../src/db');
  await db.init();
  const rows = await db.all('SELECT DISTINCT ingredient, trade_name FROM fda_orange_book');
  const out = new Set();
  for (const r of rows) {
    for (const w of String(r.ingredient || '').toLowerCase().match(/[a-z]{4,}/g) || []) out.add(w);
    for (const w of String(r.trade_name || '').toLowerCase().match(/[a-z]{4,}/g) || []) out.add(w[0].toUpperCase() + w.slice(1));
  }
  return [...out];
}

function build(t0, drugs = []) {

  // terms: in several papers, not in the general dictionaries, and not a one-letter slip of a far more common word
  // the plain English dictionaries (spell.js also loads the vocabulary this script writes)
  const nspell = require('nspell'), D = f => fs.readFileSync(path.join(OUT, f));
  const us = nspell(D('en-US.aff'), D('en-US.dic')), gb = nspell(D('en-GB.aff'), D('en-GB.dic'));
  const known = w => us.correct(w) || gb.correct(w);
  const terms = [];
  for (const [k, n] of df) {
    if (n < MIN_DF || known(k) || garbled(k) || k.length < 4) continue;
    // two words run together in a PDF ("oftreatment"): accepting them would hide the same slip in a manuscript
    if (GLUE.some(g => k.startsWith(g) && k.length - g.length >= 3 && known(k.slice(g.length)))) continue;
    // a typo is rare in published text; a real term one letter from a common word ("fundal" / "fungal", "ileal" / "ideal")
    // is used by many papers
    if (S.TYPOS[k]) continue;
    if (n < 500) {
      let typo = false;
      for (const e of slips(k)) { const m = df.get(e) || 0; if (m >= n * (n < 20 ? 100 : 150) && (known(e) || m >= MIN_DF)) { typo = true; break; } }
      if (typo) continue;
    }
    // used in lower case in at least a quarter of its papers: a common term; otherwise a name (Kaplan, Bonferroni, Wistar)
    const lower = (lowerDf.get(k) || 0) >= n * 0.25;
    terms.push(lower ? k : k[0].toUpperCase() + k.slice(1));
  }
  // approved drug ingredients and brand names (a brand used in lower case in papers is already a term)
  const have = new Set(terms.map(t => t.toLowerCase()));
  let added = 0;
  for (const w of drugs) if (!have.has(w.toLowerCase()) && !known(w.toLowerCase()) && !garbled(w.toLowerCase())) { terms.push(w); have.add(w.toLowerCase()); added++; }
  console.log(`FDA Orange Book: ${drugs.length} drug name words, ${added} new`);
  terms.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const common = [...df].filter(([k, n]) => n >= docs * 0.2 && k.length > 3).map(([k]) => k).sort();
  const head = `# PJPS Scribe research vocabulary, built ${new Date().toISOString().slice(0, 10)} by scripts/build-research-lexicon.js from ${docs} published papers (PJPS articles and PubMed Central open access) and the FDA Orange Book drug names. One word per line.\n`;
  fs.writeFileSync(path.join(OUT, 'research.txt'), head + terms.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'research-common.txt'), head.replace('vocabulary', 'words used by at least 20 % of research articles') + common.join('\n') + '\n');
  console.log(`done: ${docs} papers, ${terms.length} terms, ${common.length} common research words (${Math.round((Date.now() - t0) / 1000)} s)`);
}
