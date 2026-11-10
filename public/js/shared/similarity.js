// shared/similarity.js - how the similarity report counts words and credits them to primary sources. Used by the server
// (src/checks/plagiarism.js, which builds the report, and the Word / PDF export) and by the report view in the browser
// (excluding a source or raising the minimum match length, as in Turnitin's viewer), so the Similarity Index on screen,
// after any change, and in the exported report are always computed the same way.

export const MIN_MATCH = 8; // reports before version 5: matches shorter than this many words were not kept
export const FLOOR = 5;     // version 5: the shortest match kept (one compared sequence); Turnitin excludes no small match by default

// Cyrillic letters, and Greek capitals and omicron, drawn like Latin ones: put into Latin words to defeat similarity
// software (Turnitin's "replaced characters" flag). Inside a word with Latin letters they are read as the Latin letter.
const LOOKALIKE = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w', 'ѵ': 'v',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'Ү': 'Y',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'ο': 'o' };
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKE).join('')}]`, 'u');
const LOOKALIKE_ALL = new RegExp(LOOKALIKE_RE.source, 'gu');
const unmask = w => (LOOKALIKE_RE.test(w) && /\p{Script=Latin}/u.test(w) ? w.replace(LOOKALIKE_ALL, c => LOOKALIKE[c]) : w);

/**
 * A word as compared: Unicode-normalised (ligatures, full-width forms), look-alike letters in a Latin word read as Latin,
 * lower case, letters and digits (invisible characters dropped), plural "s" off
 */
export function norm(w) {
  const x = unmask(String(w).normalize('NFKC')).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return x.length > 4 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x;
}

/** The words of a text as the report counts them: [{ raw, n, start, end }] (a "word" holds at least one letter or digit) */
export function tokenize(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\S+/g)) {
    const n = norm(m[0]);
    if (n) out.push({ raw: m[0], n, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Character spans of in-text citation markers: numbered ([12], [3-5, 9], (12)) and author-year ((Smith et al., 2020;
 * Khan and Ali, 2019a)), sorted
 */
export function citeSpans(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(/\[\s*\d{1,3}(?:\s*[-–,;]\s*\d{1,3})*\s*\]|\(\s*\d{1,3}(?:\s*[-–,;]\s*\d{1,3})*\s*\)/g)) out.push([m.index, m.index + m[0].length]);
  for (const m of t.matchAll(/\(([^()]{3,250})\)/g)) {
    if (/\p{Lu}[\p{L}'’-]+(?:\s+et\s+al\.?|\s+(?:and|&)\s+\p{Lu}[\p{L}'’-]+)?,?\s+(?:19|20)\d{2}[a-z]?\b/u.test(m[1])) out.push([m.index, m.index + m[0].length]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Turnitin's flags - text changed so that similarity software misses it: replaced characters (Latin words with Cyrillic
 * or Greek look-alike letters; the Greek letters of science, TNF-α or ΔΔCt, are not flagged) and hidden characters
 * (zero-width characters inside the text). The comparison reads through both (norm).
 * -> [{ key, label, about, count, examples: [{ word, at }] }], only the flags raised
 */
export function textFlags(text) {
  const t = String(text || '');
  const out = [];
  const replaced = [];
  for (const m of t.matchAll(/[\p{L}\u200B-\u200D\u2060\uFEFF]{2,}/gu)) {
    const w = m[0].replace(INVISIBLE, '');
    if (!/\p{Script=Latin}/u.test(w)) continue;
    const latin = (w.match(/\p{Script=Latin}/gu) || []).length;
    const greek = /[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧο]/u.test(w) && latin >= 3 && !/[α-ξπ-ωά-ώ]/u.test(w);
    if (/\p{Script=Cyrillic}/u.test(w) || greek) replaced.push({ word: w, at: m.index });
  }
  if (replaced.length) out.push({ key: 'replaced', label: 'Replaced characters', count: replaced.length, examples: replaced.slice(0, 20),
    about: 'Words with letters of another alphabet that look like Latin ones (Cyrillic or Greek), a way to hide copied text from similarity software. They were read as the Latin letters and compared.' });
  const hidden = [...t.matchAll(INVISIBLE)];
  if (hidden.length >= 3) out.push({ key: 'hidden', label: 'Hidden characters', count: hidden.length,
    examples: hidden.slice(0, 20).map(m => ({ word: t.slice(Math.max(0, m.index - 24), m.index + 24).replace(INVISIBLE, '·').replace(/\s+/g, ' ').trim(), at: m.index })),
    about: 'Invisible (zero-width) characters inside the text. They split words for similarity software; they were ignored when the text was compared.' });
  return out;
}

/** Number of words in ranges [[from, to), ...] */
const sizeOf = ranges => ranges.reduce((a, [p, q]) => a + q - p, 0);

// Turnitin's match groups: every match sorted by whether its sentence cites a source and whether it is in quotation marks
export const GROUPS = [
  ['uncited', 'Not Cited or Quoted', 'Matches with neither an in-text citation nor quotation marks'],
  ['missingQuotes', 'Missing Quotations', 'Matches still identical or nearly identical to the source, cited but not in quotation marks'],
  ['missingCitation', 'Missing Citation', 'Matches in quotation marks without an in-text citation'],
  ['cited', 'Cited and Quoted', 'Matches with an in-text citation, in quotation marks or restated in other words']
];
const ABBREV = /^(?:al|e\.g|i\.e|fig|figs|vs|approx|ca|no|nos|vol|eq|ref|refs|dr|prof|st|sp|spp|var|cf|resp|etc|viz|min|max|conc|temp|wt)\.$/i;

/**
 * The matches (runs of words credited to one source) in Turnitin's match groups. A match is cited when a citation marker
 * stands in its sentence (or right after it), quoted when most of its words are inside quotation marks; a cited match that
 * is not quoted is "Missing Quotations" when it is word for word, "Cited and Quoted" when it was restated (paraphrased).
 * owner: source index per word (attribute); quotedMask: 1 for quoted words; paraMask: 1 for words of paraphrased passages
 * -> [{ key, label, about, words, percent, matches: [{ no, from, to, words }] }]
 */
function matchGroups(text, words, owner, number, quotedMask, paraMask, base) {
  const n = owner.length;
  const spans = citeSpans(text);
  const cite = new Uint8Array(n);
  let s = 0;
  for (let k = 0; k < n && k < words.length; k++) {
    while (s < spans.length && spans[s][1] <= words[k].start) s++;
    if (s < spans.length && spans[s][0] <= words[k].start) cite[k] = 1;
  }
  // sentence number of every word; a citation marker right after a full stop belongs to the sentence before it
  const sent = new Int32Array(n);
  for (let k = 1, id = 0; k < n && k < words.length; k++) {
    const w = words[k - 1].raw;
    if (/[.!?]["”’)\]]?$/.test(w) && !ABBREV.test(w) && /^[\p{Lu}\d“"]/u.test(words[k].raw) && !cite[k]) id++;
    sent[k] = id;
  }
  const citedSentence = new Set();
  for (let k = 0; k < n; k++) if (cite[k]) citedSentence.add(sent[k]);
  const out = Object.fromEntries(GROUPS.map(([key, label, about]) => [key, { key, label, about, words: 0, percent: 0, matches: [] }]));
  for (let k = 0; k < n;) {
    if (owner[k] < 0 || !number.get(owner[k])) { k++; continue; }
    let e = k;
    while (e < n && owner[e] === owner[k]) e++;
    let q = 0, para = 0, cited = false;
    for (let j = k; j < e; j++) { q += quotedMask[j]; para += paraMask[j]; if (citedSentence.has(sent[j])) cited = true; }
    const quoted = q * 2 > e - k;
    const key = quoted ? (cited ? 'cited' : 'missingCitation') : !cited ? 'uncited' : para * 2 > e - k ? 'cited' : 'missingQuotes';
    out[key].matches.push({ no: number.get(owner[k]), from: k, to: e, words: e - k });
    out[key].words += e - k;
    k = e;
  }
  for (const g of Object.values(out)) g.percent = pct(g.words, base);
  return GROUPS.map(([key]) => out[key]);
}

// section headings of a research paper, as iThenticate's "exclude abstract / methods" filters read them; the order of
// SECTIONS is the order of the report's section table
const SECTIONS = [
  ['front', 'Title and front matter'],
  ['abstract', 'Abstract and keywords', /^(?:abstract|summary|graphical abstract|key ?words?|keywords and phrases)$/],
  ['introduction', 'Introduction', /^(?:introduction|background)$/],
  ['methods', 'Materials and methods', /^(?:materials?|methods?|methodology|materials? and methods?|methods? and materials?|(?:patients|subjects|participants) and methods|experimental(?: section| procedures?| work| design)?|study design)$/],
  ['results', 'Results', /^(?:results?|findings|results? and discussions?)$/],
  ['discussion', 'Discussion', /^discussions?$/],
  ['conclusion', 'Conclusion', /^(?:conclusions?|concluding remarks|summary and conclusions?)$/],
  ['back', 'Declarations (acknowledgements, funding, conflicts)', /^(?:acknowledge?ments?|funding(?: sources?| information)?|conflicts? of interests?|competing interests?|declarations?|author(?:s'?)? contributions?|ethic(?:s|al)(?: approval| statement| considerations)?.*|data availability(?: statement)?|abbreviations)$/],
  // Turnitin's "exclude bibliography" leaves this section out
  ['references', 'Bibliography (reference list)', /^(?:references?(?: cited)?|bibliography|literature cited|works cited|reference list|cited literature)$/]
];
const SECTION_LABEL = Object.fromEntries(SECTIONS.map(([k, l]) => [k, l]));

/**
 * The sections of the text, in word positions of tokenize(text): [{ key, label, ranges: [[from, to), ...], words }].
 * A heading is a short line of its own ("2. MATERIALS AND METHODS", "Results:"), or "Abstract:" / "Keywords:" at the
 * start of a line followed by its text. The text before the first heading is the front matter. Without at least two
 * headings the whole text is one section, "body".
 */
export function sectionsOf(text, tokens = null, total = null) {
  const words = tokens || tokenize(text);
  const n = Math.min(total ?? words.length, words.length);
  const heads = [];
  let at = 0;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim().replace(/^(?:\d{1,2}(?:\.\d{1,2})*\.?|[IVX]{1,4}\.)\s+/, '');
    const inline = t.match(/^(abstract|summary|key ?words?)\s*[:.–—-]\s*\S/i);
    const name = (inline ? inline[1] : t.length <= 60 ? t.replace(/\s*[:.]\s*$/, '') : '').toLowerCase().replace(/\s+/g, ' ');
    const sec = name && SECTIONS.find(s => s[2] && s[2].test(name));
    if (sec) heads.push({ key: sec[0], at, label: sec[0] === 'results' && /discussion/.test(name) ? 'Results and discussion' : sec[1] });
    at += line.length + 1;
  }
  // the reference list is a section of its own even when the text has no other headings
  const bibOnly = heads.length === 1 && heads[0].key === 'references';
  if ((heads.length < 2 && !bibOnly) || !n) return [{ key: 'body', label: 'Whole text', ranges: n ? [[0, n]] : [], words: n }];
  // the first word at or after a character offset
  const wordAt = off => { let lo = 0, hi = n; while (lo < hi) { const mid = (lo + hi) >> 1; if (words[mid].start < off) lo = mid + 1; else hi = mid; } return lo; };
  const cuts = [bibOnly ? { key: 'body', label: 'Main text', from: 0 } : { key: 'front', label: SECTION_LABEL.front, from: 0 }, ...heads.map(h => ({ key: h.key, label: h.label, from: wordAt(h.at) }))];
  const byKey = new Map();
  cuts.forEach((c, i) => {
    const to = i + 1 < cuts.length ? cuts[i + 1].from : n;
    if (to <= c.from) return;
    const s = byKey.get(c.key) || { key: c.key, label: c.label, ranges: [], words: 0 };
    const last = s.ranges[s.ranges.length - 1];
    if (last && last[1] === c.from) last[1] = to; else s.ranges.push([c.from, to]);
    s.words += to - c.from;
    byKey.set(c.key, s);
  });
  const order = ['body', ...SECTIONS.map(s => s[0])];
  return [...byKey.values()].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** Ranges with the blocked words cut out: [[from, to), ...] */
function unblocked(ranges, blocked) {
  if (!blocked) return ranges;
  const out = [];
  for (const [p, q] of ranges) {
    let k = p;
    while (k < q) {
      while (k < q && blocked[k]) k++;
      let e = k;
      while (e < q && !blocked[e]) e++;
      if (e > k) out.push([k, e]);
      k = e;
    }
  }
  return out;
}

/**
 * Primary sources: every matched word is credited to one source only, the source with the most matched text first, so
 * the source percentages add up to the Similarity Index. A source left with fewer than minWords words of its own hands
 * them to a larger source that also contains them; words no larger source has stay with it, so no matched text is lost.
 * sources: [{ key, ranges: [[from, to), ...] }] - everything the source matches, in word positions of tokenize(text)
 * -> { owner: Int32Array (source index per word, -1 = not matched), credited: words credited per source }
 */
export function attribute(sources, total, { excluded = [], minWords = MIN_MATCH, blocked = null } = {}) {
  const ex = new Set(excluded);
  const active = sources.map((s, i) => {
    // words of excluded sections are cut out first; what is left of a match must still be minWords long
    const ranges = ex.has(s.key) ? [] : unblocked((s.ranges || []).map(([p, q]) => [p, Math.min(q, total)]).filter(([p, q]) => q > p), blocked).filter(([p, q]) => q - p >= minWords);
    return { i, ranges, size: sizeOf(ranges) };
  });
  const order = active.filter(a => a.size > 0).sort((a, b) => b.size - a.size || a.i - b.i);
  const owner = new Int32Array(total).fill(-1);
  for (const a of order) for (const [p, q] of a.ranges) for (let k = p; k < q; k++) if (owner[k] < 0) owner[k] = a.i;
  const count = () => { const c = new Array(sources.length).fill(0); for (const o of owner) if (o >= 0) c[o]++; return c; };
  const credited = count();
  const covers = (a, k) => a.ranges.some(([p, q]) => k >= p && k < q);
  for (let k = 0; k < total; k++) {
    const o = owner[k];
    if (o < 0 || credited[o] >= minWords) continue;
    const better = order.find(a => a.i !== o && credited[a.i] >= minWords && covers(a, k));
    if (better) owner[k] = better.i;
  }
  return { owner, credited: count() };
}

const pct = (n, total) => (total ? Math.round(n / total * 1000) / 10 : 0);

/** Similarity level: ok below 10 % (largest source below 5 %), bad from 25 % (or one source of 15 %), warn between */
export const levelOf = (similarity, largest) => (similarity >= 25 || largest >= 15 ? 'bad' : similarity >= 10 || largest >= 5 ? 'warn' : 'ok');

/**
 * The report's numbers and highlighted text for a choice of filters.
 * all: every matched source ([...report.sources, ...report.alsoMatched]); text: the compared manuscript text;
 * tokens: tokenize(text) (passed in when already made); total: words compared (the report's summary.words, always the
 * whole compared text, whatever the filters); excludeSections: section keys of sectionsOf() left out of the comparison
 * (iThenticate's "exclude abstract / methods": their words count neither as matched nor in the total); minPercent:
 * sources whose share stays under this percentage are left out (Turnitin's "exclude sources under x %"); quoted: word
 * ranges inside quotation marks, left out of the matches unless includeQuotes (Turnitin's "exclude quotes"; they stay in
 * the total, as in Turnitin).
 * -> { sources (credited, numbered by share), alsoMatched (matched, but every word credited to a larger source, excluded
 *      by the editor, or under minPercent), sections: [{ key, label, words, matched, similarity, excluded }],
 *      summary: { similarity, internet, publications, submissions, largestSource, sources, level, words, compared },
 *      groups: Turnitin's match groups (matchGroups),
 *      document: [{ t, s, x? }] (text in runs of one source number, 0 = not matched; x = in an excluded section) }
 */
export function recompute(all, text, { tokens = null, total = null, excluded = [], minWords = MIN_MATCH, maxText = Infinity, excludeSections = [], minPercent = 0, minSourceWords = 0, quoted = [], includeQuotes = false } = {}) {
  const words = tokens || tokenize(text);
  const n = total ?? words.length;
  const secs = sectionsOf(text, words, n);
  const skip = new Set(excludeSections);
  const blocked = new Uint8Array(n);
  for (const sec of secs) if (skip.has(sec.key)) for (const [p, q] of sec.ranges) blocked.fill(1, p, q);
  const base = Math.max(1, n - blocked.reduce((a, b) => a + b, 0)); // the words still compared
  // quotations: not matched, but still compared words
  let unmatched = blocked;
  if (!includeQuotes && quoted.length) {
    unmatched = blocked.slice();
    for (const [p, q] of quoted) unmatched.fill(1, Math.max(0, p), Math.min(n, q));
  }
  const ex = new Set(excluded);
  let { owner, credited } = attribute(all, n, { excluded: [...ex], minWords, blocked: unmatched });
  // sources under minPercent are dropped once; their words go to a larger source that also has them, or stay unmatched
  // (and sources credited with fewer than minSourceWords words: Turnitin's "exclude sources by word count")
  const small = new Set(minPercent > 0 || minSourceWords > 0 ? all.filter((s, i) => credited[i] > 0 && (pct(credited[i], base) < minPercent || credited[i] < minSourceWords)).map(s => s.key) : []);
  if (small.size) ({ owner, credited } = attribute(all, n, { excluded: [...ex, ...small], minWords, blocked: unmatched }));
  const ranked = all.map((s, i) => ({ s, i, words: credited[i] })).filter(x => x.words > 0).sort((a, b) => b.words - a.words || a.i - b.i);
  const number = new Map(ranked.map((x, j) => [x.i, j + 1]));
  // matches per source: the separate highlighted runs credited to it
  const runs = new Array(all.length).fill(0);
  for (let k = 0; k < n; k++) if (owner[k] >= 0 && (k === 0 || owner[k - 1] !== owner[k])) runs[owner[k]]++;
  const sources = ranked.map((x, j) => ({ ...x.s, no: j + 1, percent: pct(x.words, base), similarity: pct(x.words, base), words: x.words, matches: runs[x.i] }));
  const alsoMatched = all.filter((_, i) => !number.has(i)).map(s => ({ ...s, no: null, percent: 0, similarity: 0, words: 0, excluded: ex.has(s.key), ...(small.has(s.key) ? { small: true } : {}) }));
  // each database counted on its own, overlaps included (Turnitin's "Internet sources / Publications / Submitted works":
  // a passage found both on a web page and in a paper counts in both, so the three may add up to more than the index)
  const byType = type => {
    const seen = new Uint8Array(n);
    let c = 0;
    for (const s of all) {
      if (s.type !== type || ex.has(s.key) || small.has(s.key)) continue;
      const ranges = unblocked((s.ranges || []).map(([p, q]) => [p, Math.min(q, n)]).filter(([p, q]) => q > p), unmatched).filter(([p, q]) => q - p >= minWords);
      for (const [p, q] of ranges) for (let k = p; k < q; k++) if (!seen[k]) { seen[k] = 1; c++; }
    }
    return pct(c, base);
  };
  const similarity = pct(sources.reduce((a, x) => a + x.words, 0), base);
  const largestSource = sources.reduce((m, x) => Math.max(m, x.percent), 0);
  // similarity of each section (an excluded section shows what it would add)
  const sections = secs.map(sec => {
    let matched = 0;
    if (!skip.has(sec.key)) for (const [p, q] of sec.ranges) for (let k = p; k < q; k++) if (owner[k] >= 0) matched++;
    return { key: sec.key, label: sec.label, words: sec.words, matched, similarity: skip.has(sec.key) ? null : pct(matched, sec.words), excluded: skip.has(sec.key) };
  });
  // Turnitin's match groups (quotation marks and in-text citations of every match)
  const quotedMask = new Uint8Array(n);
  for (const [p, q] of quoted) quotedMask.fill(1, Math.max(0, p), Math.min(n, q));
  const paraMask = new Uint8Array(n);
  for (const x of all) for (const p of x.passages || []) if (p.paraphrased) paraMask.fill(1, Math.max(0, p.from), Math.min(n, p.to));
  const groups = matchGroups(text, words, owner, number, quotedMask, paraMask, base);
  // the text in runs of one source (or none), for the highlighted view
  const document = [];
  const s = text.length;
  const noAt = k => (k >= n ? 0 : owner[k] >= 0 ? number.get(owner[k]) || 0 : blocked[k] ? -1 : 0);
  const push = (t, no) => document.push(no < 0 ? { t, s: 0, x: 1 } : { t, s: no });
  if (words.length && words[0].start > 0) document.push({ t: text.slice(0, Math.min(words[0].start, maxText)), s: 0 });
  for (let k = 0; k < words.length && words[k].start < maxText;) {
    const no = noAt(k);
    let e = k;
    while (e < words.length && noAt(e) === no) e++;
    const end = e < words.length ? words[e].start : s;
    push(text.slice(words[k].start, Math.min(end, maxText)), no);
    k = e;
  }
  if (!words.length && text) document.push({ t: text.slice(0, maxText), s: 0 });
  return {
    sources, alsoMatched, document, sections, groups,
    summary: { similarity, internet: byType('internet'), publications: byType('publication'), submissions: byType('submission'), largestSource, sources: sources.length, level: levelOf(similarity, largestSource), words: n, compared: base === 1 && n === 0 ? 0 : base }
  };
}
