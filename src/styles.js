// styles.js - citation style engine: 23 styles, bibliography entries as rich segments (italic/bold), in-text citations
// for numeric, author-date and note styles. A record is { authors:[{given,family,corporate}], title, journal,
// journalAbbrev, year, volume, issue, pages, doi, publisher, type, url, edition, place }.

const BOOK_TYPES = /^(book|monograph|edited-book|reference-book|book-chapter|chapter|book-section|report|thesis|dissertation)$/i;

// ------------------------------------------------------------------ segments

const I = text => ({ t: String(text), i: true });
const B = text => ({ t: String(text), b: true });
const BI = text => ({ t: String(text), b: true, i: true });

/** Flatten nested arrays, drop empties, tidy punctuation and spacing across segment borders */
function tidy(parts) {
  const flat = [];
  (function walk(p) { for (const x of p) { if (Array.isArray(x)) walk(x); else if (x !== null && x !== undefined && x !== false && x !== '') flat.push(typeof x === 'string' ? { t: x } : x); } })(parts);
  const out = [];
  for (const s of flat) {
    if (!s.t) continue;
    const prev = out[out.length - 1];
    if (prev && !!prev.i === !!s.i && !!prev.b === !!s.b && !!prev.sup === !!s.sup) prev.t += s.t;
    else out.push({ ...s });
  }
  // whitespace and duplicated punctuation, applied on the joined text with the segment borders preserved
  let text = out.map(s => s.t).join('');
  const fixed = text.replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/([(\[])\s+/g, '$1').replace(/\.\./g, '.').replace(/,,/g, ',').replace(/\?\./g, '?').replace(/!\./g, '!').trim();
  if (fixed === text) return out;
  // Re-split the fixed text along the original style runs (character-level alignment)
  return realign(out, fixed);
}

function realign(segs, fixed) {
  // Greedy alignment: walk original characters and fixed characters together
  const styleAt = [];
  for (const s of segs) for (const ch of s.t) styleAt.push({ ch, s });
  const result = [];
  let oi = 0;
  for (const ch of fixed) {
    while (oi < styleAt.length && styleAt[oi].ch !== ch) oi++;
    const s = (styleAt[Math.min(oi, styleAt.length - 1)] || { s: {} }).s;
    const prev = result[result.length - 1];
    if (prev && !!prev.i === !!s.i && !!prev.b === !!s.b && !!prev.sup === !!s.sup) prev.t += ch;
    else result.push({ t: ch, i: s.i, b: s.b, sup: s.sup });
    oi++;
  }
  return result;
}

const toText = segs => segs.map(s => s.t).join('');
/** Lightweight markup for the browser: <i>, <b> */
const toHtml = segs => segs.map(s => {
  let t = String(s.t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (s.i) t = `<i>${t}</i>`;
  if (s.b) t = `<b>${t}</b>`;
  return t;
}).join('');

// ------------------------------------------------------------------ names

function initialsOf(given, { dots = true, space = true, hyphen = true } = {}) {
  let g = String(given || '').trim();
  // Vancouver-style initials written together ("MA", "JR") are separate initials
  if (/^[A-Z]{2,4}$/.test(g)) g = g.split('').join(' ');
  const parts = g.replace(/\./g, ' ').split(/\s+/).filter(Boolean);
  const out = parts.map(p => (hyphen && p.includes('-') ? p.split('-').filter(Boolean).map(x => x[0].toUpperCase() + (dots ? '.' : '')).join('-') : p[0].toUpperCase() + (dots ? '.' : '')));
  return out.join(dots && space ? ' ' : '');
}

const NAME_FORMATS = {
  'F, I.': a => `${a.family}, ${initialsOf(a.given)}`,           // Smith, J. A.
  'F, I.n': a => `${a.family}, ${initialsOf(a.given, { space: false })}`, // Smith, J.A.
  'F I': a => `${a.family} ${initialsOf(a.given, { dots: false })}`,     // Smith JA
  'F I.': a => `${a.family} ${initialsOf(a.given, { space: false })}`,   // Smith J.A.
  'I. F': a => `${initialsOf(a.given)} ${a.family}`,             // J. A. Smith
  'F, G': a => `${a.family}, ${a.given}`,                        // Smith, John A.
  'G F': a => `${a.given} ${a.family}`                           // John A. Smith
};

function fmtName(a, f) {
  if (!a) return '';
  if (a.corporate || !a.given) return a.family || a.name || '';
  // Full-name formats with only initials known ("MA") show them as "M. A."
  if ((f === 'G F' || f === 'F, G') && /^[A-Z]{1,4}$/.test(a.given.trim())) a = { ...a, given: initialsOf(a.given) };
  return NAME_FORMATS[f](a).trim();
}

/**
 * Author list. o: { f, first (format of the first author), sep, last (separator before the final author),
 * two (separator when exactly two), max (list all up to max), keep (when over max, keep this many), etal }
 */
function names(authors, o) {
  const au = (authors || []).filter(a => a && (a.family || a.name));
  if (!au.length) return '';
  const f = (a, i) => fmtName(a, i === 0 && o.first ? o.first : o.f);
  if (o.max && au.length > o.max) {
    if (o.apa) return au.slice(0, 19).map(f).join(o.sep) + `${o.sep}. . . ` + f(au[au.length - 1], 1);
    return au.slice(0, o.keep).map(f).join(o.sep) + (o.etal || ' et al.');
  }
  if (au.length === 1) return f(au[0], 0);
  if (au.length === 2 && o.two !== undefined) return f(au[0], 0) + o.two + f(au[1], 1);
  return au.slice(0, -1).map(f).join(o.sep) + (o.last ?? o.sep) + f(au[au.length - 1], au.length - 1);
}

// ------------------------------------------------------------------ field helpers

const { pjpsJournal } = require('./abbrev');
const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const title = r => clean(r.title).replace(/[.]+$/, '').replace(/^(retracted|withdrawn)\s*:\s*/i, '');
const pg = (p, dash = '–') => clean(p).replace(/\s*[-–—]+\s*/g, dash);
const jn = (r, abbrev) => clean(abbrev && r.journalAbbrev ? r.journalAbbrev : r.journal || r.journalAbbrev || '');
const doiUrl = r => (r.doi ? `https://doi.org/${r.doi}` : '');
const isBook = r => BOOK_TYPES.test(r.type || '') || (!r.journal && !!r.publisher);
const yr = r => (r.year ? String(r.year) + (r.yearSuffix || '') : 'n.d.');
const endDot = s => (s && !/[.?!]$/.test(s) ? s + '.' : s);

// ------------------------------------------------------------------ styles

const S = {};

S.apa7 = {
  label: 'APA 7th edition', kind: 'author-date', cite: { and: ' & ', etalFrom: 3, yearSep: ', ' },
  article: r => [names(r.authors, { f: 'F, I.', sep: ', ', last: ', & ', two: ', & ', max: 20, apa: true }), ` (${yr(r)}). `, endDot(title(r)), ' ',
    r.journal ? [I(jn(r)), r.volume ? [', ', I(r.volume)] : '', r.issue ? `(${r.issue})` : '', r.pages ? `, ${pg(r.pages)}` : '', '. '] : '', doiUrl(r)],
  book: r => [names(r.authors, { f: 'F, I.', sep: ', ', last: ', & ', two: ', & ', max: 20, apa: true }), ` (${yr(r)}). `, I(title(r)), r.edition ? ` (${r.edition} ed.)` : '', '. ', r.publisher ? `${r.publisher}. ` : '', doiUrl(r)]
};

S.apa6 = {
  label: 'APA 6th edition', kind: 'author-date', cite: { and: ' & ', etalFrom: 3, yearSep: ', ' },
  article: r => [names(r.authors, { f: 'F, I.', sep: ', ', last: ', & ', two: ', & ', max: 7, keep: 6, etal: ', . . .' }), ` (${yr(r)}). `, endDot(title(r)), ' ',
    r.journal ? [I(`${jn(r)}${r.volume ? ', ' + r.volume : ''}`), r.issue ? `(${r.issue})` : '', r.pages ? `, ${pg(r.pages)}` : '', '. '] : '', r.doi ? `doi:${r.doi}` : ''],
  book: r => [names(r.authors, { f: 'F, I.', sep: ', ', last: ', & ', two: ', & ' }), ` (${yr(r)}). `, I(title(r)), '. ', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}.` : '']
};

S['chicago-ad'] = {
  label: 'Chicago 17/18 (author-date)', kind: 'author-date', cite: { and: ' and ', etalFrom: 4, yearSep: ' ' },
  article: r => [names(r.authors, { f: 'G F', first: 'F, G', sep: ', ', last: ', and ', two: ' and ', max: 10, keep: 7 }), '. ', yr(r), '. ', `“${title(r)}.” `,
    r.journal ? [I(jn(r)), r.volume ? ` ${r.volume}` : '', r.issue ? ` (${r.issue})` : '', r.pages ? `: ${pg(r.pages)}` : '', '. '] : '', r.doi ? `${doiUrl(r)}.` : ''],
  book: r => [names(r.authors, { f: 'G F', first: 'F, G', sep: ', ', last: ', and ', two: ' and ' }), '. ', yr(r), '. ', I(title(r)), '. ', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}.` : '']
};

S['chicago-nb'] = {
  label: 'Chicago 17/18 (notes & bibliography)', kind: 'note', cite: { and: ' and ', etalFrom: 4 },
  article: r => [names(r.authors, { f: 'G F', first: 'F, G', sep: ', ', last: ', and ', two: ' and ', max: 10, keep: 7 }), '. ', `“${title(r)}.” `,
    r.journal ? [I(jn(r)), r.volume ? ` ${r.volume}` : '', r.issue ? `, no. ${r.issue}` : '', ` (${yr(r)})`, r.pages ? `: ${pg(r.pages)}` : '', '. '] : `${yr(r)}. `, r.doi ? `${doiUrl(r)}.` : ''],
  book: r => [names(r.authors, { f: 'G F', first: 'F, G', sep: ', ', last: ', and ', two: ' and ' }), '. ', I(title(r)), '. ', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}, ` : '', `${yr(r)}.`],
  note: r => [names(r.authors, { f: 'G F', sep: ', ', last: ', and ', two: ' and ', max: 3, keep: 1 }), ', ', isBook(r) ? I(title(r)) : `“${title(r)},”`, ' ',
    !isBook(r) && r.journal ? [I(jn(r)), r.volume ? ` ${r.volume}` : '', r.issue ? `, no. ${r.issue}` : '', ` (${yr(r)})`, r.pages ? `: ${pg(r.pages)}` : ''] : `(${[r.place, r.publisher].filter(Boolean).join(': ')}${r.publisher ? ', ' : ''}${yr(r)})`, '.'],
  shortNote: r => [(r.authors?.[0]?.family || ''), r.authors?.length === 2 ? ` and ${r.authors[1].family}` : r.authors?.length > 2 ? ' et al.' : '', ', ', isBook(r) ? I(title(r).split(/[:.?]/)[0]) : `“${title(r).split(/[:.?]/)[0]}.”`]
};

S.harvard = {
  label: 'Harvard (Cite Them Right)', kind: 'author-date', cite: { and: ' and ', etalFrom: 4, yearSep: ', ' },
  article: r => [names(r.authors, { f: 'F, I.n', sep: ', ', last: ' and ', two: ' and ' }), ` (${yr(r)}) `, `‘${title(r)}’, `,
    r.journal ? [I(jn(r)), r.volume ? `, ${r.volume}` : '', r.issue ? `(${r.issue})` : '', r.pages ? `, pp. ${pg(r.pages)}` : '', '. '] : '', r.doi ? `Available at: ${doiUrl(r)}.` : ''],
  book: r => [names(r.authors, { f: 'F, I.n', sep: ', ', last: ' and ', two: ' and ' }), ` (${yr(r)}) `, I(title(r)), '. ', r.edition ? `${r.edition} edn. ` : '', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}.` : '']
};

S['elsevier-harvard'] = {
  label: 'Elsevier Harvard', kind: 'author-date', cite: { and: ' and ', etalFrom: 3, yearSep: ', ' },
  article: r => [names(r.authors, { f: 'F, I.n', sep: ', ', last: ', ', two: ', ' }), ', ', yr(r), '. ', title(r), '. ',
    r.journal ? [jn(r), r.volume ? ` ${r.volume}` : '', r.pages ? `, ${pg(r.pages)}` : '', '. '] : '', doiUrl(r)],
  book: r => [names(r.authors, { f: 'F, I.n', sep: ', ', last: ', ', two: ', ' }), ', ', yr(r), '. ', title(r), '. ', r.publisher ? `${r.publisher}${r.place ? ', ' + r.place : ''}.` : '']
};

S.mla9 = {
  label: 'MLA 9th edition', kind: 'author-date', cite: { and: ' and ', etalFrom: 3, yearSep: null },
  article: r => [names(r.authors, { f: 'G F', first: 'F, G', sep: ', ', two: ', and ', max: 2, keep: 1, etal: ', et al.' }), '. ', `“${title(r)}.” `,
    r.journal ? [I(jn(r)), r.volume ? `, vol. ${r.volume}` : '', r.issue ? `, no. ${r.issue}` : '', `, ${yr(r)}`, r.pages ? `, pp. ${pg(r.pages)}` : '', '. '] : '', r.doi ? `${doiUrl(r)}.` : ''],
  book: r => [names(r.authors, { f: 'G F', first: 'F, G', sep: ', ', two: ', and ', max: 2, keep: 1, etal: ', et al.' }), '. ', I(title(r)), '. ', r.publisher ? `${r.publisher}, ` : '', `${yr(r)}.`]
};

S.ieee = {
  label: 'IEEE', kind: 'numeric', cite: { open: '[', close: ']', each: true },
  article: r => [names(r.authors, { f: 'I. F', sep: ', ', last: ', and ', two: ' and ', max: 6, keep: 1 }), ', ', `“${title(r)},” `,
    r.journal ? [I(jn(r, true)), r.volume ? `, vol. ${r.volume}` : '', r.issue ? `, no. ${r.issue}` : '', r.pages ? `, pp. ${pg(r.pages)}` : '', `, ${yr(r)}`] : yr(r), r.doi ? `, doi: ${r.doi}` : '', '.'],
  book: r => [names(r.authors, { f: 'I. F', sep: ', ', last: ', and ', two: ' and ', max: 6, keep: 1 }), ', ', I(title(r)), '. ', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}, ` : '', `${yr(r)}.`]
};

S.vancouver = {
  label: 'Vancouver (ICMJE/NLM)', kind: 'numeric', cite: { open: '(', close: ')' },
  article: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 6, etal: ', et al' }), '. ', title(r), '. ',
    r.journal ? [jn(r, true), '. ', yr(r), r.volume ? `;${r.volume}` : '', r.issue ? `(${r.issue})` : '', r.pages ? `:${pg(r.pages, '-')}` : '', '. '] : `${yr(r)}. `, r.doi ? `doi:${r.doi}` : ''],
  book: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 6, etal: ', et al' }), '. ', title(r), '. ', r.edition ? `${r.edition} ed. ` : '', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}; ` : '', `${yr(r)}.`]
};

S.ama = {
  label: 'AMA 11th edition', kind: 'numeric', cite: { sup: true },
  article: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 3, etal: ', et al' }), '. ', title(r), '. ',
    r.journal ? [I(jn(r, true)), '. ', yr(r), r.volume ? `;${r.volume}` : '', r.issue ? `(${r.issue})` : '', r.pages ? `:${pg(r.pages, '-')}` : '', '. '] : `${yr(r)}. `, r.doi ? `doi:${r.doi}` : ''],
  book: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 3, etal: ', et al' }), '. ', I(title(r)), '. ', r.publisher ? `${r.publisher}; ` : '', `${yr(r)}.`]
};

S.acs = {
  label: 'ACS', kind: 'numeric', cite: { sup: true },
  article: r => [names(r.authors, { f: 'F, I.', sep: '; ', last: '; ', two: '; ' }), ' ', endDot(title(r)), ' ',
    r.journal ? [I(jn(r, true)), ' ', B(yr(r)), r.volume ? [', ', I(r.volume)] : '', r.issue ? ` (${r.issue})` : '', r.pages ? `, ${pg(r.pages)}` : '', '. '] : '', r.doi ? `${doiUrl(r)}.` : ''],
  book: r => [names(r.authors, { f: 'F, I.', sep: '; ', last: '; ', two: '; ' }), ' ', I(title(r)), '; ', r.publisher ? `${r.publisher}: ` : '', r.place ? `${r.place}, ` : '', `${yr(r)}.`]
};

S['cse-cs'] = {
  label: 'CSE 9 (citation-sequence)', kind: 'numeric', cite: { sup: true },
  article: r => [names(r.authors, { f: 'F I', sep: ', ', max: 10, keep: 10, etal: ', et al' }), '. ', title(r), '. ',
    r.journal ? [jn(r, true), '. ', yr(r), r.volume ? `;${r.volume}` : '', r.issue ? `(${r.issue})` : '', r.pages ? `:${pg(r.pages, '-')}` : '', '. '] : `${yr(r)}. `, r.doi ? `https://doi.org/${r.doi}` : ''],
  book: r => [names(r.authors, { f: 'F I', sep: ', ', max: 10, keep: 10, etal: ', et al' }), '. ', title(r), '. ', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}; ` : '', `${yr(r)}.`]
};

S['cse-ny'] = {
  label: 'CSE 9 (name-year)', kind: 'author-date', cite: { and: ' and ', etalFrom: 3, yearSep: ' ' },
  article: r => [names(r.authors, { f: 'F I', sep: ', ', max: 10, keep: 10, etal: ', et al' }), '. ', yr(r), '. ', title(r), '. ',
    r.journal ? [jn(r, true), '. ', r.volume || '', r.issue ? `(${r.issue})` : '', r.pages ? `:${pg(r.pages, '-')}` : '', '. '] : '', r.doi ? `https://doi.org/${r.doi}` : ''],
  book: r => [names(r.authors, { f: 'F I', sep: ', ', max: 10, keep: 10, etal: ', et al' }), '. ', yr(r), '. ', title(r), '. ', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}.` : '']
};

S.nature = {
  label: 'Nature', kind: 'numeric', cite: { sup: true },
  article: r => [names(r.authors, { f: 'F, I.', sep: ', ', last: ' & ', two: ' & ', max: 5, keep: 1 }), ' ', endDot(title(r)), ' ',
    r.journal ? [I(jn(r, true)), r.volume ? [' ', B(r.volume)] : '', r.pages ? `, ${pg(r.pages)}` : ''] : '', ` (${yr(r)}).`],
  book: r => [names(r.authors, { f: 'F, I.', sep: ', ', last: ' & ', two: ' & ', max: 5, keep: 1 }), ' ', I(title(r)), ` (${[r.publisher, yr(r)].filter(Boolean).join(', ')}).`]
};

S.science = {
  label: 'Science', kind: 'numeric', cite: { open: '(', close: ')', italicNum: true },
  article: r => [names(r.authors, { f: 'I. F', sep: ', ', last: ', ', two: ', ', max: 10, keep: 1 }), ', ', title(r), '. ',
    r.journal ? [I(jn(r, true)), r.volume ? [' ', B(r.volume)] : '', r.pages ? `, ${pg(r.pages)}` : ''] : '', ` (${yr(r)}).`],
  book: r => [names(r.authors, { f: 'I. F', sep: ', ', last: ', ', two: ', ' }), ', ', I(title(r)), ` (${[r.publisher, yr(r)].filter(Boolean).join(', ')}).`]
};

S.cell = {
  label: 'Cell', kind: 'author-date', cite: { and: ' and ', etalFrom: 3, yearSep: ', ' },
  article: r => [names(r.authors, { f: 'F, I.n', sep: ', ', last: ', and ', two: ', and ', max: 10, keep: 10, etal: ', et al.' }), ` (${yr(r)}). `, title(r), '. ',
    r.journal ? [I(jn(r, true)), r.volume ? [' ', I(r.volume)] : '', r.pages ? `, ${pg(r.pages)}` : '', '. '] : '', r.doi ? `${doiUrl(r)}.` : ''],
  book: r => [names(r.authors, { f: 'F, I.n', sep: ', ', last: ', and ', two: ', and ' }), ` (${yr(r)}). `, I(title(r)), ` (${r.publisher || ''}).`]
};

S.lancet = {
  label: 'The Lancet', kind: 'numeric', cite: { sup: true },
  article: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 3, etal: ', et al' }), '. ', title(r), '. ',
    r.journal ? [I(jn(r, true)), ' ', yr(r), r.volume ? `; ${r.volume}` : '', r.pages ? `: ${pg(r.pages, '–')}` : '', '.'] : `${yr(r)}.`],
  book: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 3, etal: ', et al' }), '. ', title(r), '. ', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}, ` : '', `${yr(r)}.`]
};

S.bmj = {
  label: 'BMJ', kind: 'numeric', cite: { sup: true },
  article: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 3, etal: ', et al' }), '. ', title(r), '. ',
    r.journal ? [I(jn(r, true)), ' ', yr(r), r.volume ? `;${r.volume}` : '', r.pages ? `:${pg(r.pages, '-')}` : '', '. '] : `${yr(r)}. `, r.doi ? `doi:${r.doi}` : ''],
  book: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 3, etal: ', et al' }), '. ', I(title(r)), '. ', r.publisher ? `${r.publisher}, ` : '', `${yr(r)}.`]
};

S.plos = {
  label: 'PLOS', kind: 'numeric', cite: { open: '[', close: ']' },
  article: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 6, etal: ', et al' }), '. ', title(r), '. ',
    r.journal ? [jn(r, true), '. ', yr(r), r.volume ? `;${r.volume}` : '', r.issue ? `(${r.issue})` : '', r.pages ? `:${pg(r.pages, '-')}` : '', '. '] : `${yr(r)}. `, r.doi ? `doi:${r.doi}` : ''],
  book: r => [names(r.authors, { f: 'F I', sep: ', ', max: 6, keep: 6, etal: ', et al' }), '. ', title(r), '. ', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}; ` : '', `${yr(r)}.`]
};

S.springer = {
  label: 'Springer (basic author-date)', kind: 'author-date', cite: { and: ' and ', etalFrom: 3, yearSep: ' ' },
  article: r => [names(r.authors, { f: 'F I', sep: ', ', last: ', ', two: ', ' }), ` (${yr(r)}) `, title(r), '. ',
    r.journal ? [jn(r, true), r.volume ? ` ${r.volume}` : '', r.pages ? `:${pg(r.pages, '–')}` : '', '. '] : '', doiUrl(r)],
  book: r => [names(r.authors, { f: 'F I', sep: ', ', last: ', ', two: ', ' }), ` (${yr(r)}) `, title(r), '. ', r.publisher ? `${r.publisher}${r.place ? ', ' + r.place : ''}` : '']
};

S.oscola = {
  label: 'OSCOLA', kind: 'note', cite: { and: ' and ', etalFrom: 4 },
  article: r => [names(r.authors, { f: 'F, I.n', sep: ', ', last: ' and ', two: ' and ', max: 3, keep: 1, etal: ' and others' }).replace(/\./g, ''), ', ', `‘${title(r)}’ `,
    `(${yr(r)}) `, r.volume ? `${r.volume} ` : '', r.journal ? jn(r, true) : '', r.pages ? ` ${String(r.pages).split(/[-–]/)[0]}` : ''],
  book: r => [names(r.authors, { f: 'F, I.n', sep: ', ', last: ' and ', two: ' and ' }).replace(/\./g, ''), ', ', I(title(r)), ` (${[r.publisher, yr(r)].filter(Boolean).join(' ')})`],
  note: r => [names(r.authors, { f: 'G F', sep: ', ', last: ' and ', two: ' and ', max: 3, keep: 1, etal: ' and others' }), ', ', isBook(r) ? [I(title(r)), ` (${[r.publisher, yr(r)].filter(Boolean).join(' ')})`] : [`‘${title(r)}’ (${yr(r)}) `, r.volume ? `${r.volume} ` : '', jn(r, true), r.pages ? ` ${String(r.pages).split(/[-–]/)[0]}` : ''], '.'],
  shortNote: r => [(r.authors?.[0]?.family || ''), r.authors?.length > 1 ? ' and others' : '', ' (n ', '#', ')']
};

S.apsa = {
  label: 'APSA', kind: 'author-date', cite: { and: ' and ', etalFrom: 4, yearSep: ' ' },
  article: r => [names(r.authors, { f: 'G F', first: 'F, G', sep: ', ', last: ', and ', two: ' and ' }), '. ', yr(r), '. ', `“${title(r)}.” `,
    r.journal ? [I(jn(r)), r.volume ? ` ${r.volume}` : '', r.issue ? ` (${r.issue})` : '', r.pages ? `: ${pg(r.pages)}` : '', '. '] : '', r.doi ? `doi:${r.doi}.` : ''],
  book: r => [names(r.authors, { f: 'G F', first: 'F, G', sep: ', ', last: ', and ', two: ' and ' }), '. ', yr(r), '. ', I(title(r)), '. ', r.place ? `${r.place}: ` : '', r.publisher ? `${r.publisher}.` : '']
};

/** PJPS house style: Surname A, Surname B and Surname C (Year). Title. Journal, Vol(Issue): pages. */
S.pjps = {
  label: 'PJPS house style', kind: 'author-date', cite: { and: ' and ', etalFrom: 3, yearSep: ', ' },
  // Official PJPS instructions for authors: all authors are listed; journal abbreviated in italics, volume in bold; no DOI required
  article: r => [names(r.authors, { f: 'F I', sep: ', ', last: ' and ', two: ' and ' }), ` (${yr(r)}). `, title(r), '. ',
    r.journal ? [I(pjpsJournal(jn(r, true))), ', ', r.volume ? B(r.volume) : '', r.issue ? `(${r.issue})` : '', r.pages ? `: ${pg(r.pages, '-')}` : '', '.'] : ''],
  book: r => [names(r.authors, { f: 'F I', sep: ', ', last: ' and ', two: ' and ' }), ` (${yr(r)}). `, title(r), '. ', r.publisher ? `${r.publisher}${r.place ? ', ' + r.place : ''}.` : ''],
  // In: Gilman AG, Goodman LS (eds.), Pharmacol. Basis Ther., 7th ed., MacMillan Publishing Co., New York, pp. 446-472.
  chapter: r => [names(r.authors, { f: 'F I', sep: ', ', last: ' and ', two: ' and ' }), ` (${yr(r)}). `, title(r), '. ',
    r.bookTitle ? ['In: ', r.editors ? `${r.editors} (eds.), ` : '', r.bookTitle, r.edition ? `, ${r.edition}${/ed\.?$/i.test(r.edition) ? '' : ' ed.'}` : '', r.publisher ? `, ${r.publisher}` : '', r.place ? `, ${r.place}` : '', r.pages ? `, pp. ${pg(r.pages, '-')}` : '', '.'] : ''],
  // World Health Organization (2020). Title. Available at: URL (Accessed 15 June 2020).
  web: r => [names(r.authors, { f: 'F I', sep: ', ', last: ' and ', two: ' and ' }), ` (${yr(r)}). `, title(r), '. ', r.url ? `Available at: ${r.url}` : '', r.accessed ? ` (Accessed ${r.accessed}).` : '']
};

const STYLE_LIST = Object.entries(S).map(([key, s]) => ({ key, label: s.label, kind: s.kind }));
const ALIASES = { apa: 'apa7', chicago: 'chicago-ad', mla: 'mla9', cse: 'cse-cs', elsevier: 'elsevier-harvard' };
const getStyle = key => S[ALIASES[key] || key] || S.pjps;
const styleKey = key => (S[ALIASES[key] || key] ? ALIASES[key] || key : 'pjps');

// ------------------------------------------------------------------ bibliography entries

/** Formatted bibliography entry as segments */
function entry(record, style) {
  const st = getStyle(style);
  const r = { ...record, authors: (record.authors || []).filter(Boolean) };
  const kind = /^(book-chapter|chapter|book-section)$/i.test(r.type || '') && st.chapter ? 'chapter' : /^(web|webpage|website|online)$/i.test(r.type || '') && st.web ? 'web' : isBook(r) && st.book ? 'book' : 'article';
  return tidy([(kind === 'article' ? st.article : st[kind])(r)]);
}

function formatText(record, style) { return toText(entry(record, style)); }

/** First-author family name for sorting and in-text citations */
const firstFamily = r => (r.authors?.[0]?.family || r.authors?.[0]?.name || title(r).split(' ')[0] || '').trim();

/**
 * Order references for the bibliography and assign letters (2020a/2020b) for author-date styles.
 * items: [{ record, firstCited }] — returns the same objects ordered, with .yearSuffix set where needed.
 */
function orderBibliography(allItems, style) {
  const st = getStyle(style);
  // Entries that could not be parsed (web pages, guidelines, odd formats) keep their text and go last, flagged for the editor
  const items = allItems.filter(it => it.record);
  const unparsed = allItems.filter(it => !it.record);
  if (unparsed.length) return [...orderBibliography(items, style), ...unparsed];
  if (st.kind === 'numeric') return [...items].sort((a, b) => (a.firstCited ?? 1e9) - (b.firstCited ?? 1e9));
  const key = it => `${firstFamily(it.record).toLowerCase()}|${(it.record.authors || []).length > 2 ? 'zz' : (it.record.authors || []).map(a => a.family).join(' ').toLowerCase()}`;
  const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b)) || String(a.record.year || '').localeCompare(String(b.record.year || '')) || title(a.record).localeCompare(title(b.record)));
  const groups = new Map();
  for (const it of sorted) {
    const k = `${key(it)}|${it.record.year || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const g of groups.values()) if (g.length > 1) g.forEach((it, i) => { it.record = { ...it.record, yearSuffix: String.fromCharCode(97 + i) }; });
  return sorted;
}

// ------------------------------------------------------------------ in-text citations

/** Compress [1,2,3,5] -> "1–3, 5" */
function compressNumbers(nums) {
  const n = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < n.length; i++) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
    out.push(j - i >= 2 ? `${n[i]}–${n[j]}` : j > i ? `${n[i]}, ${n[j]}` : `${n[i]}`);
    i = j;
  }
  return out.join(', ');
}

/** Author part of an author-date citation */
function authorLabel(r, cite) {
  const au = (r.authors || []).filter(a => a.family || a.name);
  const fam = a => a.family || a.name;
  if (!au.length) return title(r).split(/\s+/).slice(0, 3).join(' ');
  if (au.length === 1) return fam(au[0]);
  if (au.length === 2 && (cite.etalFrom || 3) > 2) return `${fam(au[0])}${cite.and}${fam(au[1])}`;
  if (au.length < (cite.etalFrom || 3)) return au.slice(0, -1).map(fam).join(', ') + `,${cite.and}` + fam(au[au.length - 1]);
  return `${fam(au[0])} et al.`;
}

/**
 * In-text citation for a group of cited works.
 * numeric: nums = bibliography numbers; author-date: records. Returns segments.
 */
function inText(style, { nums = [], records = [] }) {
  const st = getStyle(style);
  const c = st.cite || {};
  if (st.kind === 'numeric') {
    if (c.sup) return [{ t: compressNumbers(nums).replace(/, /g, ','), sup: true }];
    if (c.each) return [{ t: [...new Set(nums)].sort((a, b) => a - b).map(n => `[${n}]`).join(', ') }];
    if (c.italicNum) return [{ t: '(' }, { t: compressNumbers(nums), i: true }, { t: ')' }];
    return [{ t: `${c.open || '['}${compressNumbers(nums)}${c.close || ']'}` }];
  }
  // author-date (note styles fall back to author-date when no notes are produced)
  const parts = records.map(r => (c.yearSep === null ? authorLabel(r, c) : `${authorLabel(r, c)}${c.yearSep ?? ', '}${yr(r)}`));
  return [{ t: `(${parts.join('; ')})` }];
}

module.exports = { STYLES: S, STYLE_LIST, getStyle, styleKey, entry, formatText, toText, toHtml, orderBibliography, inText, compressNumbers, firstFamily, authorLabel, isBook, tidy };
