// checks/citation.js - Citation Check: in-text citations <-> reference list
const { extractNumericCitations, extractAuthorYearCitations } = require('../parse');
const { surnameKey, stripDiacritics } = require('../text');

const key = s => surnameKey(stripDiacritics(s || ''));

function editDistance(a, b) {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

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
      if (!byNum.has(n)) missing.push({ citation: `[${n}]`, context: c.context, para: c.para, reason: n > max ? `Reference ${n} does not exist (list has ${refs.length})` : `No reference numbered ${n}` });
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
  const blocks = cites.filter(c => c.nums.length >= BLOCK_SIZE).map(c => ({ citation: c.text, size: c.nums.length, context: c.context, message: `${c.nums.length} references cited together with no specific claim for each` }));

  return {
    system: 'numeric',
    blocks,
    etAlIssues: [],
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

const BLOCK_SIZE = 6; // a bracket citing six or more works at once is a "citation block"

/** "et al." used for one or two authors, or missing for three or more */
function etAlIssue(c, ref) {
  const n = (ref.authors || []).length;
  if (!n || ref.authors[0]?.corporate) return null;
  const label = `${c.authors.join(' and ')}${c.etAl ? ' et al.' : ''}, ${c.year}${c.suffix}`;
  if (c.etAl && n <= 2) return { citation: label, context: c.context, index: ref.index, message: `“et al.” used, but the work has ${n} author${n > 1 ? 's' : ''} — ${n === 2 ? 'name both' : 'name the author'}` };
  if (!c.etAl && n >= 3 && c.authors.length < n) return { citation: label, context: c.context, index: ref.index, message: `The work has ${n} authors — cite as “${c.authors[0]} et al.”` };
  if (!c.etAl && n === 2 && c.authors.length === 1) return { citation: label, context: c.context, index: ref.index, message: `The work has two authors — name both (“${c.authors[0]} and ${ref.authors[1].family}”)` };
  return null;
}

function checkAuthorYear(body, refs) {
  const cites = extractAuthorYearCitations(body);
  const etAlIssues = [];
  // a surname of several words is also cited by its last one ("Ricardo da Silva JM" as "da Silva"; a PDF's running head
  // run into the entry, "Bacillus Mouafi FE", as "Mouafi")
  const lastWord = r => { const f = r.authors?.[0]; const w = !f?.corporate && String(f?.family || '').trim().split(/\s+/); return w && w.length > 1 ? key(w[w.length - 1]) : null; };
  // an organisation cited by its acronym: "CLSI, 2011" for "Clinical Laboratory Standards Institute (2011)", "WHO" for "World
  // Health Organization", "NRC" for "National Research Council" (the capitalised words of the name, before the year)
  const acronym = r => {
    const name = r.authors?.[0]?.corporate ? r.authors[0].family : (String(r.raw || '').replace(/^\s*(?:\[?\d{1,3}[.)\]]\s*)?/, '').match(/^([^(.,:]{8,120}?)\s*\(\s*(?:1[6-9]|20)\d{2}/) || [])[1];
    const words = String(name || '').split(/[\s-]+/).filter(w => /^\p{Lu}/u.test(w));
    return words.length >= 2 && words.length <= 8 ? words.map(w => w[0]).join('').toLowerCase() : null;
  };
  const refKeys = refs.map(r => ({ ref: r, authors: refAuthorKeys(r), last: lastWord(r), acr: acronym(r), year: r.year, suffix: r.yearSuffix || '' }));
  const citedCount = new Map();
  const missing = [];
  const ambiguous = [];
  const yearMismatch = [];
  const spelling = [];
  let spell;

  for (const c of cites) {
    const first = key(c.authors[0]);
    const second = c.authors[1] ? key(c.authors[1]) : null;
    let sameAuthor = refKeys.filter(k => k.authors[0] === first || (k.ref.authors?.[0]?.corporate && key(k.ref.authors[0].family).startsWith(first)));
    if (!sameAuthor.some(k => k.year === c.year) && first.length >= 3) sameAuthor = sameAuthor.concat(refKeys.filter(k => k.last === first && k.year === c.year));
    // one part of a double-barrelled surname: "Loh et al., 2010" for "Manyi-Loh CE ... (2010)"
    if (!sameAuthor.some(k => k.year === c.year) && first.length >= 3) sameAuthor = sameAuthor.concat(refKeys.filter(k => k.year === c.year && !sameAuthor.includes(k) && String(k.ref.authors?.[0]?.family || '').split('-').length > 1 && String(k.ref.authors[0].family).split('-').some(p => key(p) === first)));
    // "von Elm et al., 2014" for the entry "Elm E, Altman DG ..." (the particle left out of the reference list), and back
    const bare = key(String(c.authors[0]).replace(/^(?:von|van|de|da|du|del|der|den|di|la|le|dos|das)\s+/i, ''));
    if (!sameAuthor.some(k => k.year === c.year) && bare.length >= 3) sameAuthor = sameAuthor.concat(refKeys.filter(k => k.year === c.year && !sameAuthor.includes(k) && (k.authors[0] === bare || key(String(k.ref.authors?.[0]?.family || '').replace(/^(?:von|van|de|da|du|del|der|den|di|la|le|dos|das)\s+/i, '')) === bare)));
    if (!sameAuthor.some(k => k.year === c.year) && /^\p{Lu}{2,8}$/u.test(c.authors[0]) && !second) sameAuthor = sameAuthor.concat(refKeys.filter(k => k.acr === c.authors[0].toLowerCase() && k.year === c.year));
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
      const ei = etAlIssue(c, cands[0].ref);
      if (ei) etAlIssues.push(ei);
    } else if (cands.length > 1) {
      // Same author and year without a/b suffixes
      ambiguous.push({ citation: label, context: c.context, candidates: cands.map(k => k.ref.index), message: 'Same author and year match several references — add a/b suffixes' });
      for (const k of cands) citedCount.set(k.ref.index, (citedCount.get(k.ref.index) || 0) + 1);
    } else {
      const near = sameAuthor.filter(k => k.year && Math.abs(k.year - c.year) <= 2);
      if (near.length) {
        yearMismatch.push({ citation: label, context: c.context, para: c.para, candidates: near.map(k => ({ index: k.ref.index, year: k.year })), message: `Cited as ${c.year} but the reference list has ${near.map(k => k.year + (k.suffix || '')).join(', ')}` });
        for (const k of near) citedCount.set(k.ref.index, (citedCount.get(k.ref.index) || 0) + 0.5);
      } else if (sameAuthor.length === 0 && first.length >= 4 && (spell = refKeys.filter(k => k.year === c.year && k.authors[0] && editDistance(k.authors[0], first) <= (first.length >= 7 ? 2 : 1))).length === 1) {
        // The author is in the list with the same year but the name is spelled differently
        const k = spell[0];
        spelling.push({ citation: label, context: c.context, para: c.para, index: k.ref.index, message: `Spelled “${c.authors[0]}” in the text but “${k.ref.authors[0].family}” in the reference list` });
        citedCount.set(k.ref.index, (citedCount.get(k.ref.index) || 0) + 1);
      } else {
        missing.push({ citation: label, context: c.context, para: c.para, reason: sameAuthor.length ? `Author is in the list but not with year ${c.year}` : 'No matching entry in the reference list', cite: c });
      }
    }
  }

  // the same work written two ways: cited "Abu, 2017", "ESCOP, 2003", "Deepika & Vidya, 2013", "Draper andHadley, 1990" for
  // the entries "Abu Arab W (2017)", "ESCOP Monographs (2003)", "Deepika Arya and Vidya Patni (2013)", "Draper HH and Hadley M
  // (1990)": one name-form note for the pair, not a missing reference and an uncited one
  const flat = x => stripDiacritics(String(x || '')).toLowerCase().replace(/[^a-z]/g, '');
  const paired = new Map();   // citation label -> the entry it was paired with (a work cited several times)
  for (let i = 0; i < missing.length; i++) {
    const c = missing[i].cite;
    if (!c || !c.year) continue;
    const cited = flat(c.authors[0]);
    if (cited.length < 3) continue;
    const pair = paired.has(missing[i].citation) ? [paired.get(missing[i].citation)] : refKeys.filter(k => k.year === c.year && !citedCount.get(k.ref.index) && (() => {
      const raw = String(k.ref.raw).split(/\(\s*(?:1[6-9]|20)\d{2}/)[0];
      const head = flat(raw), word = flat(raw.split(/[\s,]/)[0]);
      const fam = flat(k.ref.authors?.[0]?.family);
      // the cited name begins the entry (a whole first word, or at least 4 letters of it), or the entry's surname begins the cited one
      // or an organisation or book of two words or more named before the year ("British Pharmacopoeia, 2004" for
      // "Method 2.2.24, British Pharmacopoeia (2004)")
      const org = c.authors.length === 1 && /\s/.test(String(c.authors[0]).trim()) && cited.length >= 10 && head.includes(cited);
      return (head.startsWith(cited) && (cited === word || cited.length >= Math.min(4, head.length))) || (fam.length >= 4 && cited.startsWith(fam)) || org;
    })());
    if (pair.length !== 1) continue;
    const k = pair[0];
    paired.set(missing[i].citation, k);
    missing[i].paired = true;
    if (spelling.some(s => s.citation === missing[i].citation)) { citedCount.set(k.ref.index, (citedCount.get(k.ref.index) || 0) + 1); continue; }
    spelling.push({ citation: missing[i].citation, context: c.context, para: c.para, index: k.ref.index, message: `Cited as “${c.authors.join(c.authors.length === 2 ? ' & ' : ', ')}” but the reference list entry begins “${String(k.ref.raw).split(/\s*\(/)[0].slice(0, 60)}”: write the authors' surnames the same way in both` });
    citedCount.set(k.ref.index, (citedCount.get(k.ref.index) || 0) + 1);
  }
  for (let i = missing.length - 1; i >= 0; i--) if (missing[i].paired) missing.splice(i, 1);
  for (const m of missing) delete m.cite;

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
  // Parenthetical groups citing many works at once
  const groupSize = new Map();
  for (const c of cites) if (c.text.startsWith('(')) groupSize.set(c.index, { n: (groupSize.get(c.index)?.n || 0) + 1, c });
  const blocks = [...groupSize.values()].filter(g => g.n >= BLOCK_SIZE).map(g => ({ citation: g.c.text, size: g.n, context: g.c.context, message: `${g.n} works cited together with no specific claim for each` }));

  return {
    system: 'author-year',
    blocks,
    etAlIssues: dedupe(etAlIssues, e => e.citation),
    totalCitations: cites.length,
    citationGroups: cites.length,
    matched,
    missing: dedupe(missing, m => m.citation),
    uncited,
    ambiguous: dedupe(ambiguous, a => a.citation + a.candidates.join(',')),
    yearMismatch: dedupe(yearMismatch, m => m.citation),
    spelling: dedupe(spelling, m => m.citation),
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
    spelling: (res.spelling || []).length,
    orderIssues: res.orderIssues.length,
    numberingIssues: res.numberingIssues.length,
    etAlIssues: (res.etAlIssues || []).length,
    blocks: (res.blocks || []).length,
    citedReferences: res.matched.filter(m => m.citations > 0).length
  };
  return res;
}

module.exports = { checkCitations, detectSystem };
