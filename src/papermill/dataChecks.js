// papermill/dataChecks.js - Module 4 phase 3: data signals that can be checked from the text alone or with NCBI.
//   1. Statistics that do not add up: p-values recalculated from the reported t, F, chi-square, r and z statistics, and
//      percentages recalculated from the counts they describe (the "statcheck" idea).
//   2. Primer / sequence checks: sequence sanity (length, GC, forward = reverse, same primer for two genes) and the
//      "Seek & Blastn" check - does the primer really match the gene it is claimed to amplify (NCBI BLAST).
//   3. Institutions far apart: affiliations in many countries with no clear collaboration.
// Everything here is a screening aid; each finding quotes the text so the editor can check it.
const { getText } = require('../http');

const ctx = (text, i, len) => text.slice(Math.max(0, i - 60), i + len + 60).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ numerics

function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log(2.5066282746310007 * s / x);
}

function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b) */
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

/** Upper regularised incomplete gamma Q(a, x) */
function gammq(a, x) {
  if (x <= 0) return 1;
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 3e-14) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

const erfc = x => {
  const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
};

const pT = (t, df) => betai(df / 2, 0.5, df / (df + t * t));
const pF = (f, d1, d2) => betai(d2 / 2, d1 / 2, d2 / (d2 + d1 * f));
const pChi = (x, df) => gammq(df / 2, x / 2);
const pZ = z => erfc(Math.abs(z) / Math.SQRT2);

// ------------------------------------------------------------------ statistics that do not add up

const NUM = '(-?[0-9]*\\.?[0-9]+)';
const decimals = s => (String(s).split('.')[1] || '').length;
const normalizeStats = text => String(text)
  .replace(/[−–—]/g, '-').replace(/χ\s*2|χ²|Χ²|X\s*2|x²|chi[- ]?squared?|chi[- ]?square/gi, 'χ2').replace(/\s+/g, ' ');

/** p-value interval implied by a rounded test statistic (so rounding of the statistic is not reported as an error) */
function pRange(fn, stat) {
  const d = decimals(stat), h = 0.5 * Math.pow(10, -d);
  const s = Math.abs(parseFloat(stat));
  const a = fn(s + h), b = fn(Math.max(0, s - h));
  return [Math.min(a, b), Math.max(a, b)];
}

function checkP(reportedOp, reportedStr, range) {
  const rp = parseFloat(reportedStr.startsWith('.') ? '0' + reportedStr : reportedStr);
  if (!(rp >= 0)) return { ok: false, gross: true, why: 'p-value below 0' };
  if (rp > 1) return { ok: false, gross: true, why: 'p-value above 1' };
  const [lo, hi] = range;
  const slack = 1e-9;
  let ok, gross = false;
  if (reportedOp === '=') {
    const h = 0.5 * Math.pow(10, -decimals(reportedStr));
    ok = hi >= rp - h - slack && lo <= rp + h + slack;
    // gross: the reported and the recalculated p fall on different sides of .05
    const mid = (lo + hi) / 2;
    gross = !ok && ((rp < 0.05) !== (mid < 0.05));
  } else if (reportedOp === '<') {
    ok = lo < rp + slack;
    gross = !ok && rp <= 0.05;
  } else {
    ok = hi > rp - slack;
    gross = !ok && rp >= 0.05;
  }
  return { ok, gross };
}

function statTests(text) {
  const t = normalizeStats(text);
  const findings = [];
  const tests = [
    ['t', new RegExp(`\\bt\\s*\\(\\s*([0-9]+(?:\\.[0-9]+)?)\\s*\\)\\s*=\\s*${NUM}\\s*[,;]?\\s*(?:\\(?\\s*)?p\\s*([=<>])\\s*(\\.?[0-9]*\\.?[0-9]+)`, 'g'), m => ({ df: +m[1], stat: m[2], op: m[3], p: m[4] }), (s, m) => pRange(x => pT(x, m.df), s)],
    ['F', new RegExp(`\\bF\\s*\\(\\s*([0-9]+)\\s*,\\s*([0-9]+(?:\\.[0-9]+)?)\\s*\\)\\s*=\\s*${NUM}\\s*[,;]?\\s*(?:\\(?\\s*)?p\\s*([=<>])\\s*(\\.?[0-9]*\\.?[0-9]+)`, 'g'), m => ({ df1: +m[1], df2: +m[2], stat: m[3], op: m[4], p: m[5] }), (s, m) => pRange(x => pF(x, m.df1, m.df2), s)],
    ['chi-square', new RegExp(`χ2\\s*\\(\\s*([0-9]+)(?:\\s*,\\s*N\\s*=\\s*[0-9]+)?\\s*\\)\\s*=\\s*${NUM}\\s*[,;]?\\s*(?:\\(?\\s*)?p\\s*([=<>])\\s*(\\.?[0-9]*\\.?[0-9]+)`, 'g'), m => ({ df: +m[1], stat: m[2], op: m[3], p: m[4] }), (s, m) => pRange(x => pChi(x, m.df), s)],
    ['r', new RegExp(`\\br\\s*\\(\\s*([0-9]+)\\s*\\)\\s*=\\s*${NUM}\\s*[,;]?\\s*(?:\\(?\\s*)?p\\s*([=<>])\\s*(\\.?[0-9]*\\.?[0-9]+)`, 'g'), m => ({ df: +m[1], stat: m[2], op: m[3], p: m[4] }),
      (s, m) => { const d = decimals(s), h = 0.5 * Math.pow(10, -d), r = Math.abs(parseFloat(s)); const f = x => { const q = Math.min(Math.abs(x), 0.999999); return pT(q * Math.sqrt(m.df / (1 - q * q)), m.df); }; const a = f(r - h), b = f(r + h); return [Math.min(a, b), Math.max(a, b)]; }],
    ['z', new RegExp(`\\bz\\s*=\\s*${NUM}\\s*[,;]?\\s*(?:\\(?\\s*)?p\\s*([=<>])\\s*(\\.?[0-9]*\\.?[0-9]+)`, 'g'), m => ({ stat: m[1], op: m[2], p: m[3] }), (s) => pRange(pZ, s)]
  ];
  for (const [name, re, get, range] of tests) {
    for (const m of t.matchAll(re)) {
      const g = get(m);
      if (!(parseFloat(g.p) >= 0) || Math.abs(parseFloat(g.stat)) > 1e6) continue;
      let rng;
      try { rng = range(g.stat, g); } catch (e) { continue; }
      if (!rng.every(Number.isFinite)) continue;
      const res = checkP(g.op, g.p, rng);
      if (!res.ok) {
        const calc = (rng[0] + rng[1]) / 2;
        findings.push({ kind: 'p-value', test: name, gross: !!res.gross, reported: m[0].trim(), recalculated: calc < 0.001 ? 'p < .001' : `p = ${calc.toFixed(3)}`, quote: ctx(t, m.index, m[0].length), why: res.why || '' });
      }
    }
  }
  return findings;
}

/** "12 of 30 (45%)" and "12/30 (45%)": the percentage must follow from the counts */
function percentChecks(text) {
  const t = normalizeStats(text);
  const out = [];
  const re = /\b(\d{1,6})\s*(?:of|\/|out of)\s*(\d{1,6})\s*\(\s*(\d{1,3}(?:\.\d+)?)\s*%\s*\)/gi;
  for (const m of t.matchAll(re)) {
    const a = +m[1], b = +m[2], p = parseFloat(m[3]);
    if (!b || a > b + 0) { out.push({ kind: 'percentage', gross: true, reported: m[0], recalculated: `${a} of ${b} is impossible (more than the total)`, quote: ctx(t, m.index, m[0].length) }); continue; }
    const d = decimals(m[3]);
    const calc = a / b * 100;
    const tol = 0.5 * Math.pow(10, -d) + 1e-9;
    if (Math.abs(calc - p) > tol) out.push({ kind: 'percentage', gross: Math.abs(calc - p) > 5, reported: m[0], recalculated: `${a}/${b} = ${calc.toFixed(d || 1)}%`, quote: ctx(t, m.index, m[0].length) });
  }
  return out;
}

/** Impossible reported values: p above 1, negative SD, percentages above 100 for proportions */
function impossibleValues(text) {
  const t = normalizeStats(text);
  const out = [];
  // "p = 50%" in a sample-size formula is the expected proportion (p, q = 1 - p), not a p-value
  const proportion = (m) => /^\s*%/.test(t.slice(m.index + m[0].length, m.index + m[0].length + 3))
    || /prevalence|proportion|sample size|population|expected|anticipated|q\s*=\s*1\s*-\s*p|z\s*=\s*1\.96|\bα\s*=|margin of error/i.test(t.slice(Math.max(0, m.index - 160), m.index + 60));
  // not a p-value either: scientific notation ("P = 9.27 e-02", "p = 2.90 × 10-5"), a subscript variable ("K p = 3.26"
  // of a PID controller) or a formula ("P = 2 x 1 - ...")
  const notPValue = (m) => {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 14), before = t.slice(Math.max(0, m.index - 3), m.index);
    return /^\s*(?:[eE]\s*[-−–+]?\s*\d|[×x*·]\s*10\b|[×x*·/+-]\s*[a-z(\d])/.test(after) || /\b[A-Za-z]\s$/.test(before);
  };
  for (const m of t.matchAll(/\bp\s*[=<>]\s*(\d*\.?\d+)(?![\d.])/gi)) if (parseFloat(m[1]) > 1 && !proportion(m) && !notPValue(m)) out.push({ kind: 'impossible', gross: true, reported: m[0], recalculated: 'a probability cannot exceed 1', quote: ctx(t, m.index, m[0].length) });
  for (const m of t.matchAll(/(?:±|\bSD\b\s*=?)\s*-\s*\d/g)) out.push({ kind: 'impossible', gross: true, reported: m[0], recalculated: 'a standard deviation cannot be negative', quote: ctx(t, m.index, m[0].length) });
  return out.slice(0, 5);
}

function statisticsCheck(text) {
  const tests = statTests(text);
  const pct = percentChecks(text);
  const bad = impossibleValues(text);
  const checked = {
    pTests: [...normalizeStats(text).matchAll(/\b(?:t|F|r)\s*\(\s*[0-9., ]+\)\s*=\s*-?[0-9]*\.?[0-9]+\s*[,;]?\s*(?:\(?\s*)?p\s*[=<>]|χ2\s*\(|\bz\s*=\s*-?[0-9.]+\s*[,;]?\s*p\s*[=<>]/g)].length,
    percentages: [...normalizeStats(text).matchAll(/\b\d{1,6}\s*(?:of|\/|out of)\s*\d{1,6}\s*\(\s*\d{1,3}(?:\.\d+)?\s*%\s*\)/gi)].length
  };
  return { findings: [...tests, ...pct, ...bad], checked };
}

// ------------------------------------------------------------------ primers and sequences

const COMP = { A: 'T', T: 'A', G: 'C', C: 'G', U: 'A', N: 'N' };
const revcomp = s => [...s].reverse().map(c => COMP[c] || 'N').join('');
const gcOf = s => (s.match(/[GC]/g) || []).length / s.length;

/** Primers written as  GENE F: 5'-ACGT...-3'  (also "Forward", "Reverse", "sense", table cells) */
function findPrimers(text) {
  const t = String(text).replace(/[‘’′´`]/g, "'").replace(/[−–—‑]/g, '-');
  const out = [];
  const seen = new Set();
  const re = /(?:([A-Za-z0-9α-ωΑ-Ω\-/.]{2,24})\s*[,:;(]?\s*)?\(?\b(forward|reverse|sense|antisense|fwd|rev|F|R)\b\)?\s*[:=]?\s*(?:primer\s*)?[:=]?\s*5\s*'?\s*-?\s*([ACGTUN](?:[ACGTUN\s]{13,60}?)[ACGTUN])\s*-?\s*3\s*'/gi;
  for (const m of t.matchAll(re)) {
    const seq = m[3].replace(/\s+/g, '').toUpperCase();
    if (seq.length < 12 || seq.length > 60 || seen.has(m.index)) continue;
    seen.add(m.index);
    const dir = /^(forward|sense|fwd|F)$/i.test(m[2]) ? 'forward' : 'reverse';
    out.push({ gene: (m[1] || '').replace(/[,:;(]+$/, '') || null, direction: dir, sequence: seq, quote: ctx(t, m.index, m[0].length), index: m.index });
  }
  // gene name is usually the row/line label: fall back to the nearest gene-like token before the primer
  for (const p of out) {
    if (p.gene && !/^(primer|primers|sequence|sequences|table|gene|name|forward|reverse)$/i.test(p.gene)) continue;
    const prev = out[out.indexOf(p) - 1];
    // a reverse primer written straight after its forward partner belongs to the same gene
    p.gene = prev && prev.gene && p.index - prev.index < 160 && prev.direction !== p.direction ? prev.gene : null;
  }
  for (const p of out) delete p.index;
  return out.slice(0, 40);
}

function primerSanity(primers) {
  const issues = [];
  for (const p of primers) {
    const s = p.sequence;
    if (/[^ACGTUN]/.test(s)) issues.push({ primer: p, message: 'Contains letters that are not nucleotides' });
    if (s.length < 15 || s.length > 35) issues.push({ primer: p, message: `Unusual primer length (${s.length} nt; PCR primers are normally 18-30 nt)` });
    const gc = gcOf(s);
    if (gc < 0.25 || gc > 0.75) issues.push({ primer: p, message: `Extreme GC content (${Math.round(gc * 100)}%)` });
    if (/(.)\1{6,}/.test(s)) issues.push({ primer: p, message: 'Long run of one nucleotide' });
  }
  const byGene = new Map();
  for (const p of primers) {
    const k = (p.gene || '?').toLowerCase();
    if (!byGene.has(k)) byGene.set(k, []);
    byGene.get(k).push(p);
  }
  for (const [gene, list] of byGene) {
    const f = list.find(p => p.direction === 'forward'), r = list.find(p => p.direction === 'reverse');
    if (f && r && f.sequence === r.sequence) issues.push({ primer: r, message: `Forward and reverse primer of ${gene === '?' ? 'a gene' : gene} are identical` });
    else if (f && r && f.sequence === revcomp(r.sequence) && f.sequence.length > 18) issues.push({ primer: r, message: 'The reverse primer is the exact reverse complement of the forward primer (they would anneal to each other, not amplify a product)' });
  }
  const bySeq = new Map();
  for (const p of primers) {
    if (!bySeq.has(p.sequence)) bySeq.set(p.sequence, new Set());
    bySeq.get(p.sequence).add((p.gene || '?').toLowerCase());
  }
  for (const [seq, genes] of bySeq) {
    const g = [...genes].filter(x => x !== '?');
    if (g.length > 1) issues.push({ primer: primers.find(p => p.sequence === seq), message: `The same primer sequence is given for different genes (${g.join(', ')})` });
  }
  return issues;
}

// ---- Seek & Blastn: does the primer match the gene it is said to amplify? (NCBI BLAST URL API, public)
const BLAST = 'https://blast.ncbi.nlm.nih.gov/blast/Blast.cgi';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const geneKey = g => String(g || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^beta/, 'b').replace(/^alpha/, 'a').replace(/^β/, 'b').replace(/^α/, 'a');

async function blastOne(seq) {
  const body = new URLSearchParams({ CMD: 'Put', PROGRAM: 'blastn', DATABASE: 'refseq_rna', QUERY: seq, WORD_SIZE: '7', EXPECT: '1000', HITLIST_SIZE: '8', FILTER: 'F', MEGABLAST: 'off', TOOL: 'pjps-reference-checker', EMAIL: process.env.CONTACT_EMAIL || 'poaconnectapp@gmail.com' });
  const put = await getText(BLAST, { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, ttl: 0, timeout: 25000, retries: 0 });
  const rid = (put.text || '').match(/RID = (\S+)/)?.[1];
  const rtoe = parseInt((put.text || '').match(/RTOE = (\d+)/)?.[1] || '15', 10);
  if (!rid) return { error: 'BLAST did not accept the query' };
  await sleep(Math.min(rtoe, 20) * 1000);
  for (let i = 0; i < 12; i++) {
    const st = await getText(`${BLAST}?CMD=Get&FORMAT_OBJECT=SearchInfo&RID=${rid}`, { ttl: 0, timeout: 20000, retries: 0 });
    const status = (st.text || '').match(/Status=(\w+)/)?.[1];
    if (status === 'READY') {
      if (/ThereAreHits=no/.test(st.text)) return { hits: [] };
      const res = await getText(`${BLAST}?CMD=Get&FORMAT_TYPE=Text&FORMAT_OBJECT=Alignment&ALIGNMENT_VIEW=Tabular&DESCRIPTIONS=8&NETWORK_PROXY=&RID=${rid}`, { ttl: 0, timeout: 30000, retries: 0 });
      const hits = (res.text || '').split('\n').filter(l => l && !l.startsWith('#') && /\t/.test(l)).slice(0, 8).map(l => l.split('\t'));
      // tabular output has no titles; ask for the description list as well
      const desc = await getText(`${BLAST}?CMD=Get&FORMAT_TYPE=Text&DESCRIPTIONS=8&ALIGNMENTS=0&RID=${rid}`, { ttl: 0, timeout: 30000, retries: 0 });
      const titles = (desc.text || '').split('\n').filter(l => /^(?:NM_|NR_|XM_|XR_)\d+/.test(l.trim())).slice(0, 8).map(l => l.trim());
      return { hits: titles.length ? titles : hits.map(h => h.join(' ')) };
    }
    if (status === 'FAILED' || status === 'UNKNOWN') return { error: `BLAST ${status}` };
    await sleep(8000);
  }
  return { error: 'BLAST did not finish in time' };
}

/** Full gene names for a symbol (NCBI Gene): BLAST titles say "glyceraldehyde-3-phosphate dehydrogenase", papers say GAPDH */
async function geneNames(symbol) {
  const s = String(symbol || '').replace(/[^A-Za-z0-9-]/g, '');
  if (s.length < 2) return [];
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  try {
    const find = await getText(`${base}/esearch.fcgi?db=gene&retmode=json&retmax=6&term=${encodeURIComponent(s + '[sym] AND (human[orgn] OR mouse[orgn] OR rat[orgn])')}`, { ttl: 30 * 86400, timeout: 15000, retries: 1 });
    const ids = JSON.parse(find.text || '{}').esearchresult?.idlist || [];
    if (!ids.length) return [];
    const sum = await getText(`${base}/esummary.fcgi?db=gene&retmode=json&id=${ids.join(',')}`, { ttl: 30 * 86400, timeout: 15000, retries: 1 });
    const res = JSON.parse(sum.text || '{}').result || {};
    return [...new Set(ids.map(i => String(res[i]?.description || '').toLowerCase()).filter(Boolean))];
  } catch (e) { return []; }
}

/** A BLAST description line names the gene when it contains the symbol or the (possibly truncated) full gene name */
function hitIsGene(hit, key, names) {
  const line = String(hit).toLowerCase();
  if (geneKey(line).includes(key)) return true;
  const title = line.replace(/^\S+\s+/, '').replace(/predicted:\s*/, '').replace(/^[a-z]+ [a-z]+ /, '').replace(/\s+\d+(?:\.\d+)?\s+[\d.e-]+\s+\d+%.*$/, '').replace(/\.\.\.$/, '').trim();
  const frag = title.slice(0, 22);
  return frag.length >= 8 && names.some(n => n.includes(frag) || frag.includes(n.slice(0, 22)));
}

/** Compare the claimed gene with the top BLAST hits. Returns [{ primer, ok, hits }] */
async function seekAndBlast(primers, { limit = 4, update = () => {} } = {}) {
  const todo = primers.filter(p => p.gene && !/[^ACGT]/.test(p.sequence) && p.sequence.length >= 15 && p.sequence.length <= 40).slice(0, limit);
  if (todo.length) update(`Checking ${todo.length} primer(s) with NCBI BLAST`);
  // all queries run side by side; the whole step is capped at 150 s so a slow NCBI never blocks the report
  const one = async p => {
    let r;
    try { r = await blastOne(p.sequence); } catch (e) { r = { error: e.message }; }
    if (r.error) return { primer: p, checked: false, error: r.error };
    const key = geneKey(p.gene);
    const names = await geneNames(p.gene);
    const matches = !key || r.hits.some(h => hitIsGene(h, key, names));
    return { primer: p, checked: true, matches, noHits: !r.hits.length, geneName: names[0] || null, hits: r.hits.slice(0, 5) };
  };
  return Promise.race([Promise.all(todo.map(one)), sleep(150000).then(() => todo.map(p => ({ primer: p, checked: false, error: 'BLAST timed out' })))]);
}

// ------------------------------------------------------------------ institutions far apart

const COUNTRIES = ['Pakistan', 'India', 'China', 'Saudi Arabia', 'Egypt', 'Iran', 'Iraq', 'Turkey', 'Türkiye', 'Malaysia', 'Indonesia', 'Bangladesh', 'Nigeria', 'South Africa', 'United States', 'USA', 'United Kingdom', 'UK', 'Germany', 'France', 'Italy', 'Spain', 'Canada', 'Australia', 'Japan', 'South Korea', 'Korea', 'Brazil', 'Mexico', 'Russia', 'Thailand', 'Vietnam', 'Jordan', 'Lebanon', 'Oman', 'Qatar', 'Kuwait', 'United Arab Emirates', 'UAE', 'Sri Lanka', 'Nepal', 'Afghanistan', 'Morocco', 'Algeria', 'Tunisia', 'Ethiopia', 'Kenya', 'Ghana', 'Poland', 'Portugal', 'Netherlands', 'Sweden', 'Norway', 'Denmark', 'Finland', 'Greece', 'Romania', 'Czech Republic', 'Hungary', 'Singapore', 'Taiwan', 'Hong Kong'];
const ALIAS = { USA: 'United States', UK: 'United Kingdom', UAE: 'United Arab Emirates', Türkiye: 'Turkey', Korea: 'South Korea' };

function affiliationSpread(affiliations = [], authorCount = 0) {
  const found = new Map();
  for (const a of affiliations) {
    for (const c of COUNTRIES) {
      if (new RegExp(`(?:^|[\\s,;(])${c.replace(/\./g, '\\.')}(?:$|[\\s,;).])`, 'i').test(a)) {
        const k = ALIAS[c] || c;
        if (!found.has(k)) found.set(k, []);
        found.get(k).push(a.slice(0, 140));
        break;
      }
    }
  }
  return { countries: [...found.keys()], byCountry: Object.fromEntries(found), far: found.size >= 3 || (found.size >= 2 && authorCount && authorCount <= 3 && !found.has('Pakistan')) };
}

// ------------------------------------------------------------------ microRNAs (miRBase)
// Paper-mill papers in molecular biology are dominated by microRNA / lncRNA studies; sleuths often find a microRNA that
// does not exist, or not in the species studied (a human microRNA "measured" in rats). Checked against miRBase.

const MIR_RE = /\b(?:(hsa|mmu|rno)-)?(?:miR|MiR|MIR|microRNA|miRNA)[\s-]?(\d{1,4}[a-l]?)(?:-\d)?(?:-[35]p)?(?![\w-])/g;
const LET_RE = /\b(?:(hsa|mmu|rno)-)?let-7([a-k])(?:-\d)?(?:-[35]p)?(?![\w-])/g;

/** Named microRNAs: [{ key: 'mir-21' | 'let-7a', name, prefix, quote }] (one per key) */
function mirnaMentions(text) {
  const out = new Map();
  const add = (key, name, prefix, i) => { if (!out.has(key)) out.set(key, { key, name, prefix: prefix || null, quote: text.slice(Math.max(0, i - 80), i + 80).replace(/\s+/g, ' ') }); };
  for (const m of text.matchAll(MIR_RE)) add(`mir-${m[2].toLowerCase()}`, m[0], m[1], m.index);
  for (const m of text.matchAll(LET_RE)) add(`let-7${m[2].toLowerCase()}`, m[0], m[1], m.index);
  return [...out.values()];
}

/** The species of the experiments when there is only one: 'rno' (rats), 'mmu' (mice) or 'hsa' (human material only); else null */
function studySpecies(text) {
  const n = re => (text.match(re) || []).length;
  const rat = n(/\brats?\b|sprague[- ]dawley|wistar/gi), mouse = n(/\bmice\b|\bmouse\b|\bmurine\b|c57bl|balb\/c|nude mice/gi);
  const human = n(/\bpatients?\b|\bhuman\b|\bvolunteers?\b|\bHeLa\b|\bHEK-?293|\bMCF-?7\b|\bA549\b|\bHepG2\b|\bSW480\b|\bHCT-?116\b/g);
  if (rat >= 3 && !mouse && human < 2) return 'rno';
  if (mouse >= 3 && !rat && human < 2) return 'mmu';
  if (human >= 3 && !rat && !mouse) return 'hsa';
  return null;
}

/**
 * Compare named microRNAs with miRBase. species: Map(key -> Set of species codes) from datasets.mirbaseSpecies.
 * Returns { unknown: [...], wrongSpecies: [...], species }
 */
function mirnaCheck(mentions, species, text) {
  const study = studySpecies(text);
  const unknown = [], wrongSpecies = [];
  for (const m of mentions) {
    const sp = species.get(m.key);
    if (!sp) { unknown.push(m); continue; }
    const target = m.prefix || study;
    if (target && target !== 'hsa' && !sp.has(target) && sp.has('hsa')) wrongSpecies.push({ ...m, target, annotatedIn: [...sp].slice(0, 6) });
  }
  return { unknown, wrongSpecies, species: study };
}

module.exports = { statisticsCheck, statTests, percentChecks, impossibleValues, findPrimers, primerSanity, seekAndBlast, affiliationSpread, pT, pF, pChi, pZ, revcomp, mirnaMentions, studySpecies, mirnaCheck };
