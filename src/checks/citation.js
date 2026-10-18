// checks/citation.js - Citation Check: in-text citations <-> reference list
const { extractNumericCitations, extractAuthorYearCitations } = require('../parse');
const { surnameKey, stripDiacritics } = require('../text');

const key = s => surnameKey(stripDiacritics(s || ''));

function refAuthorKeys(ref) {
  return (ref.authors || []).map(a => key(a.family)).filter(Boolean);
}

/**
 * Decide the citation system: numeric if the reference list is numbered or bracket numbers dominate.
 */
function detectSystem(body, refs) {
  const numbered = refs.filter(r => /^\s*(?:\[\d+\]|\d+[.)])/.test(r.raw)).length;
  const brackets = (body.match(/\[\d{1,3}(?:[-–,]\s*\d{1,3})*\]/g) || []).length;
  const authorYear = (body.match(/\([^()]*?(?:1[6-9]|20)\d{2}[a-z]?\)/g) || []).length;
  if (numbered >= refs.length * 0.6 && brackets + 2 >= authorYear * 0.5) return 'numeric';
  if (brackets > authorYear * 1.5 && brackets >= 3) return 'numeric';
  return 'author-year';
}

function refNumber(ref, fallback) {
  const m = ref.raw.match(/^\s*(?:\[(\d+)\]|(\d+)[.)])/);
  return m ? parseInt(m[1] || m[2], 10) : fallback;
}

function checkNumeric(body, refs) {
  const numbers = refs.map((r, i) => refNumber(r, i + 1));
  const byNum = new Map(numbers.map((n, i) => [n, refs[i]]));
  const max = Math.max(...numbers, refs.length);
  const cites = extractNumericCitations(body, max);

  const citedCount = new Map();
  const missing = [];
  const firstAppearance = [];
  for (const c of cites) {
    for (const n of c.nums) {
      if (!byNum.has(n)) missing.push({ citation: `[${n}]`, context: c.context, reason: n > max ? `Reference ${n} does not exist (list has ${refs.length})` : `No reference numbered ${n}` });
      else {
        if (!citedCount.has(n)) firstAppearance.push(n);
        citedCount.set(n, (citedCount.get(n) || 0) + 1);
      }
    }
  }

  // Vancouver: references must be numbered in order of first citation
  const orderIssues = [];
  let expected = 1;
  for (const n of firstAppearance) {
    if (n > expected) orderIssues.push({ number: n, expected, message: `Reference ${n} is cited before reference ${expected}` });
    expected = Math.max(expected, n + 1);
  }
  const numberingGaps = [];
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) numberingGaps.push(`Number ${sorted[i]} is used twice in the reference list`);
    else if (sorted[i] !== sorted[i - 1] + 1) numberingGaps.push(`Reference list jumps from ${sorted[i - 1]} to ${sorted[i]}`);
  }

  const matched = refs.map((r, i) => ({ index: r.index, number: numbers[i], citations: citedCount.get(numbers[i]) || 0 }));
  const uncited = matched.filter(m => m.citations === 0).map(m => ({ index: m.index, number: m.number, raw: refs.find(r => r.index === m.index).raw }));

  return {
    system: 'numeric',
    totalCitations: cites.reduce((a, c) => a + c.nums.length, 0),
    citationGroups: cites.length,
    matched,
    missing: dedupe(missing, m => m.citation),
    uncited,
    ambiguous: [],
    orderIssues: orderIssues.slice(0, 50),
    numberingIssues: numberingGaps.slice(0, 30)
  };
}

function checkAuthorYear(body, refs) {
  const cites = extractAuthorYearCitations(body);
  const refKeys = refs.map(r => ({ ref: r, authors: refAuthorKeys(r), year: r.year, suffix: r.yearSuffix || '' }));
  const citedCount = new Map();
  const missing = [];
  const ambiguous = [];
  const yearMismatch = [];

  for (const c of cites) {
    const first = key(c.authors[0]);
    const second = c.authors[1] ? key(c.authors[1]) : null;
    const sameAuthor = refKeys.filter(k => k.authors[0] === first || (k.ref.authors?.[0]?.corporate && key(k.ref.authors[0].family).startsWith(first)));
    let cands = sameAuthor.filter(k => k.year === c.year);
    if (second) {
      const narrowed = cands.filter(k => k.authors[1] === second);
      if (narrowed.length) cands = narrowed;
    } else if (!c.etAl && cands.length > 1) {
      const solo = cands.filter(k => k.authors.length === 1);
      if (solo.length) cands = solo;
    } else if (c.etAl && cands.length > 1) {
      const multi = cands.filter(k => k.authors.length >= 3);
      if (multi.length) cands = multi;
    }
    if (c.suffix) {
      const withSuffix = cands.filter(k => k.suffix === c.suffix);
      if (withSuffix.length) cands = withSuffix;
      else if (cands.length > 1) cands = [];
    }
    const label = `${c.authors.join(c.authors.length === 2 ? ' & ' : ', ')}${c.etAl ? ' et al.' : ''}, ${c.year}${c.suffix}`;
    if (cands.length === 1) {
      citedCount.set(cands[0].ref.index, (citedCount.get(cands[0].ref.index) || 0) + 1);
    } else if (cands.length > 1) {
      // Same author and year without a/b suffixes
      ambiguous.push({ citation: label, context: c.context, candidates: cands.map(k => k.ref.index), message: 'Same author and year match several references — add a/b suffixes' });
      for (const k of cands) citedCount.set(k.ref.index, (citedCount.get(k.ref.index) || 0) + 1);
    } else {
      const near = sameAuthor.filter(k => k.year && Math.abs(k.year - c.year) <= 2);
      if (near.length) {
        yearMismatch.push({ citation: label, context: c.context, candidates: near.map(k => ({ index: k.ref.index, year: k.year })), message: `Cited as ${c.year} but the reference list has ${near.map(k => k.year + (k.suffix || '')).join(', ')}` });
        for (const k of near) citedCount.set(k.ref.index, (citedCount.get(k.ref.index) || 0) + 0.5);
      } else {
        missing.push({ citation: label, context: c.context, reason: sameAuthor.length ? `Author is in the list but not with year ${c.year}` : 'No matching entry in the reference list' });
      }
    }
  }

  // Same author+year in the list without suffixes
  const groups = new Map();
  for (const k of refKeys) {
    if (!k.authors[0] || !k.year) continue;
    const g = `${k.authors[0]}|${k.year}|${k.authors.length >= 3 ? 'etal' : k.authors.slice(1).join('+')}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(k);
  }
  for (const list of groups.values()) {
    if (list.length > 1 && list.some(k => !k.suffix)) {
      ambiguous.push({ citation: `${list[0].ref.authors[0].family} ${list[0].year}`, candidates: list.map(k => k.ref.index), message: 'Reference list has several entries with the same author and year but no a/b suffix' });
    }
  }

  // Alphabetical order of the list (author-year systems)
  const orderIssues = [];
  for (let i = 1; i < refKeys.length; i++) {
    const a = refKeys[i - 1].authors[0], b = refKeys[i].authors[0];
    if (a && b && a.localeCompare(b) > 0 && a[0] !== b[0]) {
      orderIssues.push({ index: refKeys[i].ref.index, message: `“${refKeys[i].ref.authors[0].family}” is listed after “${refKeys[i - 1].ref.authors[0].family}” (not alphabetical)` });
    }
  }

  const matched = refs.map(r => ({ index: r.index, citations: Math.ceil(citedCount.get(r.index) || 0) }));
  const uncited = matched.filter(m => m.citations === 0).map(m => ({ index: m.index, raw: refs.find(r => r.index === m.index).raw }));

  return {
    system: 'author-year',
    totalCitations: cites.length,
    citationGroups: cites.length,
    matched,
    missing: dedupe(missing, m => m.citation),
    uncited,
    ambiguous: dedupe(ambiguous, a => a.citation + a.candidates.join(',')),
    yearMismatch: dedupe(yearMismatch, m => m.citation),
    orderIssues: orderIssues.length > refs.length * 0.3 ? [] : orderIssues.slice(0, 30),
    numberingIssues: []
  };
}

function dedupe(arr, keyFn) {
  const seen = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (seen.has(k)) seen.get(k).count++;
    else seen.set(k, { ...x, count: 1 });
  }
  return [...seen.values()];
}

/**
 * body: manuscript text without the reference list; refs: parsed reference entries
 */
function checkCitations(body, refs, { system } = {}) {
  if (!body || body.trim().length < 200) {
    return { error: 'The manuscript text (body) is needed to check in-text citations. Upload the full manuscript, not only the reference list.' };
  }
  const sys = system || detectSystem(body, refs);
  const res = sys === 'numeric' ? checkNumeric(body, refs) : checkAuthorYear(body, refs);
  res.summary = {
    system: res.system,
    references: refs.length,
    citations: res.totalCitations,
    missing: res.missing.length,
    uncited: res.uncited.length,
    ambiguous: res.ambiguous.length,
    yearMismatch: (res.yearMismatch || []).length,
    orderIssues: res.orderIssues.length,
    numberingIssues: res.numberingIssues.length,
    citedReferences: res.matched.filter(m => m.citations > 0).length
  };
  return res;
}

module.exports = { checkCitations, detectSystem };
