// integrity/dataIntegrity.js - Research data integrity: numbers that look fabricated or copied.
//   - p-values recalculated from t / F / chi-square / r / z, percentages from their counts, impossible values (Module 4 engine)
//   - GRIM test: a mean of whole-number data (scores, ages, counts) must be reachable with the stated n
//   - the same "mean ± SD" pair reported for different groups (duplicated observations)
//   - one SD repeated across many different means (SDs copied rather than calculated)
//   - identical rows of numbers in tables
//   - terminal-digit analysis: last digits of measured values should be roughly uniform
//   - primer sanity and misidentified cell lines (Module 4 engine)
// Honest typing and rounding errors exist in many papers: the pattern matters, not one value.
const DC = require('../papermill/dataChecks');
const { cellLines } = require('../papermill');
const { dimension, finish, ctx } = require('./common');

const norm = t => String(t || '').replace(/[−–—]/g, '-').replace(/\+\/-|\+-/g, '±');
const decimals = s => (String(s).split('.')[1] || '').length;

/** "12.45 ± 1.30" pairs with their position */
function meanSdPairs(text) {
  const t = norm(text);
  const out = [];
  for (const m of t.matchAll(/(?<![\d.])(\d{1,5}(?:\.\d{1,4})?)\s*±\s*(\d{1,5}(?:\.\d{1,4})?)(?!\d|\.\d)/g)) out.push({ mean: m[1], sd: m[2], at: m.index, raw: m[0], quote: ctx(t, m.index, m[0].length, 60) });
  return out;
}

/** GRIM (Brown & Heathers 2016): is mean x n within rounding of a whole number? */
function grimConsistent(meanStr, n) {
  const d = decimals(meanStr);
  const mean = parseFloat(meanStr);
  const step = 0.5 * Math.pow(10, -d);
  for (const total of [Math.floor(mean * n), Math.ceil(mean * n)]) if (Math.abs(total / n - mean) <= step + 1e-9) return true;
  return false;
}

const INTEGER_DATA = /\b(scores?|scales?|likert|questionnaire|items?|ages?|years old|aged|number of|counts?|episodes|days of)\b/i;

function grimTests(text) {
  const t = norm(text);
  const out = [];
  for (const p of meanSdPairs(t)) {
    // the sentence holding the value (decimal points are not followed by a space, sentence ends are)
    const from = Math.max(t.lastIndexOf('. ', p.at), t.lastIndexOf('\n', p.at)) + 1;
    const ends = [t.indexOf('. ', p.at + p.raw.length), t.indexOf('\n', p.at)].filter(i => i > 0);
    const around = t.slice(from, ends.length ? Math.min(...ends) : t.length);
    if (!INTEGER_DATA.test(around)) continue;
    const nm = around.match(/\bn\s*=\s*(\d{1,4})\b/i);
    if (!nm) continue;
    const n = +nm[1], d = decimals(p.mean);
    if (!d || n < 2 || n >= Math.pow(10, d)) continue; // GRIM cannot tell when n is as large as 10^decimals
    out.push({ mean: p.mean, n, consistent: grimConsistent(p.mean, n), quote: p.quote });
  }
  return out;
}

function repeatedPairs(pairs) {
  const seen = new Map();
  for (const p of pairs) {
    if (decimals(p.mean) < 1 || parseFloat(p.mean) === 0) continue;
    const k = `${p.mean}±${p.sd}`;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(p);
  }
  return [...seen.entries()].filter(([, v]) => v.length >= 2).map(([k, v]) => ({ pair: k, count: v.length, quotes: v.slice(0, 3).map(x => x.quote) }));
}

function repeatedSds(pairs) {
  const bySd = new Map();
  for (const p of pairs) {
    if (decimals(p.sd) < 2) continue;
    if (!bySd.has(p.sd)) bySd.set(p.sd, new Set());
    bySd.get(p.sd).add(p.mean);
  }
  return [...bySd.entries()].filter(([, means]) => means.size >= 4).map(([sd, means]) => ({ sd, means: [...means].slice(0, 8), count: means.size }));
}

/** Lines (table rows) carrying the same sequence of at least four numbers */
function duplicateRows(text) {
  const rows = new Map();
  for (const line of String(text).split(/\n/)) {
    const nums = line.match(/-?\d+(?:\.\d+)?/g) || [];
    if (nums.length < 4 || !nums.some(n => n.includes('.'))) continue;
    const k = nums.join(' ');
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(line.trim().slice(0, 160));
  }
  return [...rows.values()].filter(v => v.length >= 2).map(v => ({ count: v.length, row: v[0] }));
}

/** Chi-square test of the last digit of measured values (3+ significant digits, not years, not p-values) */
function terminalDigits(text) {
  const t = norm(text);
  const digits = [];
  for (const m of t.matchAll(/(?<![\w.])(\d+\.\d{2,4})(?!\d|\.\d)/g)) {
    const v = m[1];
    if (v.replace('.', '').replace(/^0+/, '').length < 3) continue;
    const before = t.slice(Math.max(0, m.index - 6), m.index);
    if (/p\s*[=<>]\s*$/i.test(before)) continue;
    digits.push(+v[v.length - 1]);
  }
  if (digits.length < 100) return { n: digits.length, tested: false };
  const counts = Array(10).fill(0);
  for (const x of digits) counts[x]++;
  const e = digits.length / 10;
  const chi = counts.reduce((a, c) => a + (c - e) ** 2 / e, 0);
  return { n: digits.length, tested: true, counts, chi: +chi.toFixed(1), p: DC.pChi(chi, 9) };
}

function analyzeDataIntegrity(text) {
  const d = dimension('data', 'Research data integrity');
  const t = norm(text);
  const stats = DC.statisticsCheck(t);
  const gross = stats.findings.filter(f => f.gross);
  if (stats.findings.length) {
    const sev = gross.length >= 3 || stats.findings.some(f => f.kind === 'impossible') ? 'medium' : 'low';
    d.sig('statistics', `Reported statistics that do not add up (${stats.findings.length}; ${gross.length} change the conclusion)`, sev, sev === 'medium' ? 3 : gross.length ? 1.5 : 0.5,
      stats.findings.slice(0, 10).map(f => ({ text: `${f.reported} — recalculated: ${f.recalculated}${f.gross ? ' (changes the conclusion)' : ''}`, quote: f.quote })),
      'p-values recalculated from the test statistic and degrees of freedom; percentages from their counts.');
  }
  const grim = grimTests(t);
  const grimBad = grim.filter(g => !g.consistent);
  if (grimBad.length) d.sig('grim', `${grimBad.length} mean(s) impossible for whole-number data with the stated n (GRIM test)`, grimBad.length >= 2 ? 'medium' : 'low', grimBad.length >= 2 ? 2.5 : 1,
    grimBad.slice(0, 8).map(g => ({ text: `Mean ${g.mean} with n = ${g.n}: no whole-number total gives this mean`, quote: g.quote })),
    'The GRIM test applies only to data made of whole numbers (questionnaire scores, ages in years, counts). Check that n refers to this mean before asking the authors.');

  const pairs = meanSdPairs(t);
  const rep = repeatedPairs(pairs);
  if (rep.length) d.sig('duplicate-values', `${rep.length} identical mean ± SD value(s) reported more than once`, rep.length >= 3 ? 'medium' : 'low', rep.length >= 3 ? 3 : 1,
    rep.slice(0, 8).map(r => ({ text: `${r.pair} appears ${r.count}×`, quote: r.quotes[0] })), 'Different groups or experiments rarely give exactly the same mean and SD. It can be a copy-paste error, or duplicated observations.');
  const sds = repeatedSds(pairs);
  if (sds.length) d.sig('repeated-sd', `The same standard deviation reported for many different means (${sds.length})`, 'low', 1.5,
    sds.map(s => ({ text: `SD ${s.sd} used with ${s.count} different means: ${s.means.join(', ')}` })), 'Independently measured groups almost never share an SD to two or more decimals.');
  const rows = duplicateRows(text);
  if (rows.length) d.sig('duplicate-rows', `${rows.length} table row(s) with an identical sequence of numbers`, rows.length >= 2 ? 'medium' : 'low', rows.length >= 2 ? 2.5 : 1,
    rows.slice(0, 6).map(r => ({ text: `${r.count}× — ${r.row}` })), 'Repeated rows may be duplicated observations or a table assembled by copying.');
  const td = terminalDigits(t);
  if (td.tested && td.p < 0.001) d.sig('terminal-digits', `Last digits of reported values are not uniformly distributed (χ² = ${td.chi}, p < 0.001, ${td.n} values)`, 'low', 1.5,
    [{ text: `Counts of last digits 0-9: ${td.counts.join(', ')}` }], 'Measured values usually end in every digit about equally often; invented numbers often favour some digits. Rounding conventions can also cause this.');

  const primers = DC.findPrimers(text);
  const primerIssues = DC.primerSanity(primers);
  if (primerIssues.length) d.sig('primers', `Primer / sequence problems (${primerIssues.length})`, 'low', 1, primerIssues.slice(0, 6).map(i => ({ text: `${i.primer.gene || 'primer'} ${i.primer.direction}: ${i.message}`, quote: i.primer.quote })));
  const cells = cellLines(text);
  if (cells.length) d.sig('cell-lines', `${cells.length} misidentified or contaminated cell line(s)`, 'medium', Math.min(4, 2 * cells.length), cells.map(c => ({ text: c.nonVerifiable ? `${c.name}: ${c.actual}` : `${c.name} is actually ${c.actual} (ICLAC register)`, quote: c.example })));

  d.details = { statistics: { checked: stats.checked, findings: stats.findings.slice(0, 30) }, grim: { tested: grim.length, inconsistent: grimBad.length, items: grim.slice(0, 30) }, meanSdPairs: pairs.length, repeatedPairs: rep, repeatedSds: sds, duplicateRows: rows, terminalDigits: td, primers: primers.length, cellLines: cells };
  d.checked = pairs.length + stats.checked.pTests + stats.checked.percentages > 0 || td.n > 0;
  return finish(d);
}

module.exports = { analyzeDataIntegrity, grimConsistent, grimTests, meanSdPairs, terminalDigits };
