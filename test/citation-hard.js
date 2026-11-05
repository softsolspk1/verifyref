// test/citation-hard.js - Module 3.A in-text citations on harder forms (no network): several works joined by "and" or a
// comma instead of a semicolon, possessives, diacritics in the text but not in the list, three named authors, "e.g.",
// page locators, "&", two years for one author; numbered ranges with dashes and lists. node test/citation-hard.js
const assert = require('assert');
const P = require('../src/parse');
const { checkCitations } = require('../src/checks/citation');

const fails = [];
const expect = (name, got, want) => { try { assert.deepStrictEqual(got, want); } catch { fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } };

// ---- extraction
const cases = [
  ['(Khan et al. 2019)', [['Khan', '2019']]],
  ['(Khan & Ali, 2019)', [['Khan+Ali', '2019']]],
  ['Khan and Ali (2019) reported', [['Khan+Ali', '2019']]],
  ["Khan et al.'s (2019) study", [['Khan', '2019']]],
  ['(e.g., Khan, 2019; Ali, 2020)', [['Khan', '2019'], ['Ali', '2020']]],
  ['(Khan, 2019: 45)', [['Khan', '2019']]],
  ['(Khan 2019, 2020)', [['Khan', '2019'], ['Khan', '2020']]],
  ["(O'Brien et al., 2017)", [["O'Brien", '2017']]],
  ['(Ahmad et al., 2019 and Butt et al., 2020)', [['Ahmad', '2019'], ['Butt', '2020']]],
  ['(Ahmad et al., 2019, Butt et al., 2020)', [['Ahmad', '2019'], ['Butt', '2020']]],
  ['(Müller et al., 2015)', [['Müller', '2015']]],
  // not citations
  ['the samples (n = 2019) were', []],
  ['In May 2019 (Fig. 2) the trial', []]
];
for (const [text, want] of cases) expect(text, P.extractAuthorYearCitations(text).map(c => [c.authors.join('+'), `${c.year}${c.suffix}`]), want);

// ---- matching against a list
const refs = [
  'Ahmad S, Raza H and Noor F (2019). Hepatoprotective activity of silymarin. Pak. J. Pharm. Sci., 32(2): 501-507.',
  'Butt G, Malik R and Iqbal Z (2020). Floating tablets of ibuprofen. Pak. J. Pharm. Sci., 33(1): 111-117.',
  'Khan A and Ali B (2019). Curcumin in wound healing. Pak. J. Pharm. Sci., 32(4): 1601-1606.',
  'Muller T, Weber K and Fischer L (2015). Metformin pharmacokinetics. Br. J. Clin. Pharmacol., 80(2): 201-210.',
  "O'Brien P, Lee J and Park S (2017). Statins and myopathy. Lancet, 389: 1123-1130.",
  'Shah SA, Iqbal Z and Khan MA (2018). HPLC of paracetamol. J. Chromatogr. B, 1012: 45-52.'
].map((l, i) => P.parseReferenceEntry(l, i + 1));
const body = `Silymarin protects the liver (Ahmad et al., 2019 and Butt et al., 2020). Curcumin heals wounds (Khan & Ali, 2019).
Metformin kinetics differ in the elderly (Müller et al., 2015). Statins cause myopathy, as O'Brien et al.'s (2017) cohort showed.
Paracetamol was assayed by HPLC (Shah, Iqbal and Khan, 2018). ${'Further sentences of the manuscript body without any citation, so that the text is long enough. '.repeat(3)}`;
const r = checkCitations(body, refs);
expect('author-year uncited', r.uncited.map(u => u.index), []);
expect('author-year missing', r.missing.map(m => m.citation), []);

// ---- numbered
const nrefs = Array.from({ length: 8 }, (_, i) => P.parseReferenceEntry(`${i + 1}. Author${String.fromCharCode(65 + i)} A. Title number ${i + 1} of a paper. J Test. 2020;${i + 1}:1-5.`, i + 1));
const nbody = `First claims [1-3]. Another claim [4,6]. A range with a dash [5–7]. ${'Text without citations to make the body long enough for checking. '.repeat(4)}`;
const n = checkCitations(nbody, nrefs);
expect('numbered uncited', n.uncited.map(u => u.index), [8]);
expect('numbered missing', (n.missing || []).length, 0);

console.log(`Module 3.A citations (hard): ${cases.length + 4 - fails.length}/${cases.length + 4}`);
fails.forEach(f => console.log('FAIL', f));
assert.strictEqual(fails.length, 0);
