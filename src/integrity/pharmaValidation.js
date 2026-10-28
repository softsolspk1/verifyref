// integrity/pharmaValidation.js - Pharmaceutical research validation:
//   doses       - mg/kg doses read from the text; doses above the OECD limit-test dose, administration volumes above
//                 the usual maximum, a dose in the abstract that the methods do not contain
//   identifiers - CAS numbers with a wrong check digit; molecular formula vs stated molecular weight (computed offline);
//                 named compound vs PubChem formula / weight, CAS number vs PubChem (online)
//   methods     - group sizes that do not add up ("30 rats in 5 groups of 8"), species named in the abstract but not
//                 in the methods, percentages above 100 for inhibition / yield / recovery / purity
//   regulatory  - FDA NDA / ANDA numbers against the Orange Book (via src/pharma.js)
const pharma = require('../pharma');
const { isOnline } = require('../http');
const { dimension, finish, sections, ctx } = require('./common');

const ATOMIC = { H: 1.008, He: 4.0026, Li: 6.94, B: 10.81, C: 12.011, N: 14.007, O: 15.999, F: 18.998, Na: 22.99, Mg: 24.305, Al: 26.982, Si: 28.085, P: 30.974, S: 32.06, Cl: 35.45, K: 39.098, Ca: 40.078,
  Mn: 54.938, Fe: 55.845, Co: 58.933, Ni: 58.693, Cu: 63.546, Zn: 65.38, Se: 78.971, Br: 79.904, Ag: 107.87, Sn: 118.71, I: 126.9, Ba: 137.33, Pt: 195.08, Au: 196.97, Hg: 200.59, Pb: 207.2, Bi: 208.98 };

/** Molecular weight of a formula such as C17H19NO3, Ca(OH)2 or CuSO4·5H2O; null if an element is unknown */
function formulaWeight(formula) {
  const f = String(formula).replace(/[₀-₉]/g, c => String(c.charCodeAt(0) - 0x2080));
  const parts = f.split(/[·.•]/);
  let total = 0;
  for (const part of parts) {
    const mult = +(part.match(/^(\d+)/)?.[1] || 1);
    const stack = [0];
    const re = /([A-Z][a-z]?)(\d*)|(\()|(\))(\d*)/g;
    let m, body = part.replace(/^\d+/, '');
    while ((m = re.exec(body))) {
      if (m[1]) { if (!ATOMIC[m[1]]) return null; stack[stack.length - 1] += ATOMIC[m[1]] * (+m[2] || 1); }
      else if (m[3]) stack.push(0);
      else if (m[4]) { const v = stack.pop() * (+m[5] || 1); stack[stack.length - 1] += v; }
    }
    total += stack[0] * mult;
  }
  return total ? +total.toFixed(2) : null;
}

const casValid = cas => {
  const [a, b, c] = cas.split('-');
  const digits = (a + b).split('').map(Number);
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i + 1), 0);
  return sum % 10 === +c;
};

const NUM_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, 'twenty-four': 24, thirty: 30, 'thirty-six': 36, forty: 40, 'forty-two': 42, 'forty-eight': 48, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
const num = s => NUM_WORDS[String(s).toLowerCase()] ?? +s;
const SPECIES = { rat: /\brats?\b/i, mouse: /\b(?:mice|mouse)\b/i, rabbit: /\brabbits?\b/i, 'guinea pig': /\bguinea pigs?\b/i, dog: /\bdogs?\b/i, zebrafish: /\bzebrafish\b/i, human: /\b(?:patients|participants|volunteers)\b/i };
const UNIT_TO_MG = { g: 1000, mg: 1, µg: 0.001, μg: 0.001, ug: 0.001, mcg: 0.001, ng: 0.000001 };

function doses(text) {
  const out = [];
  for (const m of String(text).matchAll(/(\d+(?:[.,]\d+)?)\s*(g|mg|µg|μg|ug|mcg|ng)\s*\/\s*kg\b/gi)) {
    const value = parseFloat(m[1].replace(',', '.'));
    const unit = m[2].toLowerCase().replace('μ', 'µ');
    out.push({ raw: m[0].replace(/\s+/g, ' '), mgPerKg: +(value * (UNIT_TO_MG[unit] ?? 1)).toPrecision(6), at: m.index, quote: ctx(text, m.index, m[0].length, 60) });
  }
  return out;
}

function groupArithmetic(text) {
  const out = [];
  const N = `(\\d+|${Object.keys(NUM_WORDS).join('|')})`;
  const re = new RegExp(`\\b${N}\\s+(?:\\w+\\s+){0,3}?(rats|mice|animals|rabbits|patients|participants|subjects)\\b[^.]{0,120}?\\b(?:divided|randomi[sz]ed|allocated|assigned|distributed|grouped)\\b[^.]{0,40}?\\binto\\s+${N}\\s+(?:equal\\s+)?groups?\\b[^.]{0,60}?(?:\\(?\\s*n\\s*=\\s*(\\d+)|\\bof\\s+${N}\\b(?!\\s*(?:mg|g|ml|µg|%|days?|weeks?))|${N}\\s+(?:in each|per group|each))`, 'gi');
  for (const m of String(text).matchAll(re)) {
    const total = num(m[1]), groups = num(m[3]), per = num(m[4] || m[5] || m[6]);
    if (!total || !groups || !per || Number.isNaN(total + groups + per)) continue;
    out.push({ total, groups, per, consistent: total === groups * per, quote: ctx(text, m.index, m[0].length, 20) });
  }
  return out;
}

function percentOver100(text) {
  const out = [];
  for (const m of String(text).matchAll(/\b(inhibition|yield|recovery|purity|viability|entrapment efficiency|encapsulation efficiency|drug release|release)\b[^.%]{0,60}?(\d{3}(?:\.\d+)?)\s*%/gi)) {
    const v = parseFloat(m[2]);
    const limit = /viability|release/i.test(m[1]) ? 130 : 100.5; // viability vs control may slightly exceed 100%
    if (v > limit) out.push({ what: m[1], value: v, quote: ctx(text, m.index, m[0].length, 40) });
  }
  return out;
}

async function analyzePharma(text, { online = isOnline() } = {}) {
  const d = dimension('pharma', 'Pharmaceutical research validation');
  const sec = sections(text);
  const methods = sec.methods || '';
  const abstract = sec.abstract || sec.front?.slice(-3000) || '';

  // ---- doses
  const all = doses(text);
  const high = all.filter(x => x.mgPerKg > 5000);
  if (high.length) d.sig('dose-limit', `Dose(s) above 5,000 mg/kg — beyond the OECD limit test (${high.length})`, 'medium', 2, high.slice(0, 6).map(x => ({ text: x.raw, quote: x.quote })), 'OECD Test Guidelines 423/425 stop at 2,000 (or exceptionally 5,000) mg/kg. Higher doses are rarely justified; check for a unit error (µg vs mg) or a typing error.');
  const veryHighMg = all.filter(x => x.mgPerKg > 2000 && x.mgPerKg <= 5000 && !/toxic|LD50|acute|limit test|OECD/i.test(text.slice(Math.max(0, x.at - 300), x.at + 300)));
  if (veryHighMg.length) d.sig('dose-high', `Dose(s) above 2,000 mg/kg outside a toxicity test (${veryHighMg.length})`, 'low', 1, veryHighMg.slice(0, 6).map(x => ({ text: x.raw, quote: x.quote })), 'Ask the authors to justify the dose and its source.');
  if (abstract && methods && all.length) {
    const inMethods = new Set(doses(methods).map(x => x.mgPerKg));
    const absOnly = doses(abstract).filter(x => !inMethods.has(x.mgPerKg));
    if (absOnly.length && inMethods.size) d.sig('dose-mismatch', `Dose(s) in the abstract that do not appear in the methods (${absOnly.length})`, 'medium', 2, absOnly.map(x => ({ text: `Abstract: ${x.raw}; methods: ${[...inMethods].slice(0, 6).map(v => v + ' mg/kg').join(', ')}`, quote: x.quote })), 'The abstract must report the doses actually used.');
  }
  for (const m of String(text).matchAll(/(\d+(?:\.\d+)?)\s*m[lL]\s*\/\s*kg\b/g)) {
    const v = parseFloat(m[1]);
    if (v > 20) { d.sig('volume', `Administration volume ${m[0]} above the usual maximum (≈ 10-20 mL/kg)`, 'low', 0.5, [{ text: m[0], quote: ctx(text, m.index, m[0].length, 60) }], 'Larger volumes are possible for some routes; check for a unit error.'); break; }
  }

  // ---- identifiers: CAS numbers, formula and molecular weight
  const casAll = [...new Set(String(text).match(/\b\d{2,7}-\d{2}-\d\b/g) || [])].filter(c => /CAS|Registry/i.test(text.slice(Math.max(0, text.indexOf(c) - 40), text.indexOf(c))) || /\bCAS\b/i.test(text));
  const casBad = casAll.filter(c => !casValid(c));
  if (casBad.length) d.sig('cas', `${casBad.length} CAS number(s) with a wrong check digit`, 'medium', 2, casBad.map(c => ({ text: c, quote: ctx(text, text.indexOf(c), c.length, 60) })), 'A CAS Registry Number carries a check digit; a wrong one means a typing error or an invented identifier.');
  const formulaClaims = [];
  for (const m of String(text).matchAll(/\b((?:C\d{0,3})(?:H\d{0,3})?(?:[A-Z][a-z]?\d{0,3}|\(|\)\d*){0,12})\b[^.]{0,80}?\b(?:molecular (?:weight|mass)|M\.?W\.?|molar mass)\s*(?:of|:|=|was|is)?\s*(\d{2,4}(?:\.\d{1,3})?)/g)) {
    const calc = formulaWeight(m[1]);
    if (!calc || m[1].length < 4) continue;
    const stated = parseFloat(m[2]);
    formulaClaims.push({ formula: m[1], stated, calculated: calc, consistent: Math.abs(stated - calc) <= Math.max(1, calc * 0.005), quote: ctx(text, m.index, m[0].length, 30) });
  }
  const fBad = formulaClaims.filter(f => !f.consistent);
  if (fBad.length) d.sig('formula-mw', `Molecular weight does not match the stated formula (${fBad.length})`, 'medium', 2, fBad.map(f => ({ text: `${f.formula}: stated ${f.stated}, calculated ${f.calculated} g/mol`, quote: f.quote })));

  // ---- methods consistency
  const groups = groupArithmetic(text);
  const gBad = groups.filter(g => !g.consistent);
  if (gBad.length) d.sig('group-size', `Group sizes do not add up (${gBad.length})`, 'medium', 2, gBad.map(g => ({ text: `${g.total} in total but ${g.groups} groups × ${g.per} = ${g.groups * g.per}`, quote: g.quote })), 'The number of animals or participants must match the groups; otherwise ask which number is right and whether data were excluded.');
  if (abstract && methods) {
    const absSp = Object.entries(SPECIES).filter(([, re]) => re.test(abstract)).map(([k]) => k);
    const metSp = Object.entries(SPECIES).filter(([, re]) => re.test(methods)).map(([k]) => k);
    const missing = metSp.length ? absSp.filter(s => !metSp.includes(s) && s !== 'human') : [];
    if (missing.length) d.sig('species', `Species named in the abstract but not in the methods: ${missing.join(', ')}`, 'medium', 2, [{ text: `Abstract: ${absSp.join(', ')}; methods: ${metSp.join(', ')}` }], 'A templated or recycled abstract often names a different species from the experiments.');
  }
  const pct = percentOver100(text);
  if (pct.length) d.sig('percent', `Percentages above 100% for ${[...new Set(pct.map(p => p.what.toLowerCase()))].join(', ')}`, 'low', 1, pct.slice(0, 6).map(p => ({ text: `${p.what}: ${p.value}%`, quote: p.quote })));

  // ---- regulatory numbers and online identity checks
  const ents = pharma.extractPharmaEntities(text);
  const appl = [];
  for (const a of ents.applNos.slice(0, 6)) {
    const rows = await pharma.fdaDrugLookup(a.replace(/\D/g, ''), { limit: 3 }).catch(() => []);
    appl.push({ id: a, found: rows.length > 0, product: rows[0] ? `${rows[0].trade_name} (${rows[0].ingredient})` : null });
  }
  const applBad = appl.filter(a => !a.found);
  if (applBad.length) d.sig('fda', `FDA application number(s) not in the Orange Book (${applBad.length})`, 'low', 1, applBad.map(a => ({ text: a.id })), 'Biologics, discontinued or foreign products are not in the Orange Book; check the number with the authors.');
  const pubchem = [];
  if (online) {
    for (const c of casAll.filter(casValid).slice(0, 4)) {
      const p = await pharma.pubchemCompound(c).catch(() => null);
      const near = String(text.slice(Math.max(0, text.indexOf(c) - 120), text.indexOf(c))).toLowerCase();
      pubchem.push({ query: c, found: !!p, cid: p?.cid, formula: p?.molecularFormula, iupac: p?.iupacName, nearText: near.slice(-60) });
    }
    for (const f of formulaClaims.slice(0, 3)) {
      const nameM = text.slice(Math.max(0, text.indexOf(f.formula) - 80), text.indexOf(f.formula)).match(/([A-Z][a-z]{4,}(?:\s[a-z]{4,})?)\s*\(?$/);
      if (!nameM) continue;
      const p = await pharma.pubchemCompound(nameM[1]).catch(() => null);
      if (p) pubchem.push({ query: nameM[1], found: true, cid: p.cid, formula: p.molecularFormula, statedFormula: f.formula, formulaMatches: p.molecularFormula === f.formula });
    }
    const mism = pubchem.filter(p => p.statedFormula && p.formulaMatches === false);
    if (mism.length) d.sig('pubchem-formula', `Formula does not match PubChem for ${mism.map(p => p.query).join(', ')}`, 'medium', 2, mism.map(p => ({ text: `${p.query}: manuscript ${p.statedFormula}, PubChem ${p.formula}`, link: `https://pubchem.ncbi.nlm.nih.gov/compound/${p.cid}` })));
    const casMissing = pubchem.filter(p => /^\d+-\d+-\d$/.test(p.query) && !p.found);
    if (casMissing.length) d.sig('cas-unknown', `CAS number(s) not known to PubChem (${casMissing.length})`, 'low', 1, casMissing.map(p => ({ text: p.query })));
  }

  d.details = { doses: all.slice(0, 40).map(({ at, ...x }) => x), groups, formulaClaims, cas: casAll.map(c => ({ cas: c, valid: casValid(c) })), percentOver100: pct, fdaApplications: appl, pubchem, entities: ents, online };
  d.checked = all.length + groups.length + formulaClaims.length + casAll.length + ents.applNos.length > 0 || /\b(drug|dose|extract|formulation|tablet|compound)\b/i.test(text);
  return finish(d);
}

module.exports = { analyzePharma, formulaWeight, casValid, doses, groupArithmetic };
