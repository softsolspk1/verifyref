// test/citation-forms.js - Module 3 (in-text citations <-> reference list) with the author-year forms that used to be
// missed: surname particles (van der Berg), multi-word surnames (De Silva), organisations as authors (World Health
// Organization), and a letter alone after a lettered year (2020a, b). Run: node test/citation-forms.js
const assert = require('assert');
const P = require('../src/parse');
const { checkCitations } = require('../src/checks/citation');

const cases = [
  ['(van der Berg and Smith, 2018)', [['van der Berg+Smith', '2018']]],
  ['as shown by van der Berg et al. (2018).', [['van der Berg', '2018']]],
  ['(De Silva et al., 2019)', [['De Silva', '2019']]],
  ['(World Health Organization, 2021)', [['World Health Organization', '2021']]],
  ['(Khan et al., 2020a, b)', [['Khan', '2020a'], ['Khan', '2020b']]],
  ['(see Smith and Jones, 2019; Lee, 2018a, 2019)', [['Smith+Jones', '2019'], ['Lee', '2018a'], ['Lee', '2019']]],
  // must not change
  ['(Khan, 2020, p 12)', [['Khan', '2020']]],
  ['Recently Smith et al. (2020) found', [['Smith', '2020']]],
  ['In 2020 (Table 2, 2020)', []]
];
for (const [text, want] of cases) {
  const got = P.extractAuthorYearCitations(text).map(c => [c.authors.join('+'), `${c.year}${c.suffix}`]);
  assert.deepStrictEqual(got, want, text);
}
console.log(`  ✓ ${cases.length} citation forms extracted`);

const refs = [
  'Khan A, Ali B and Shah C (2020a). Effects of curcumin on liver. Pak. J. Pharm. Sci., 33(2): 101-108.',
  'Khan A, Ali B and Shah C (2020b). Curcumin and kidney injury. Pak. J. Pharm. Sci., 33(4): 201-208.',
  'van der Berg J and Smith K (2018). Nanoparticles for delivery. Int. J. Pharm., 540(1): 1-10.',
  'Al-Hassan M (2019). Herbal medicine in the Gulf. J. Ethnopharmacol., 230: 50-60.',
  'World Health Organization (2021). Global report on antimicrobial resistance. WHO, Geneva.',
  'Zhang Y and Li X (2016). Never cited paper. Drug Deliv., 23(1): 1-9.'
].map((l, i) => P.parseReferenceEntry(l, i + 1));
const body = `Curcumin protects the liver and the kidney (Khan et al., 2020a, b). Nanoparticles improve delivery (van der Berg and Smith, 2018; Al-Hassan, 2019).
The World Health Organization reported resistance (World Health Organization, 2021). A missing work is cited here (Ahmed et al., 2015).
${'Further sentences of the manuscript body without any citation, so that the text is long enough to be checked. '.repeat(3)}`;
const r = checkCitations(body, refs);
assert.deepStrictEqual(r.uncited.map(u => u.index), [6], 'only the reference that is never cited is uncited');
assert.strictEqual(r.missing.length, 1, 'the citation without a reference is missing');
console.log('  ✓ particles, organisations and 2020a, b matched to the reference list');
console.log('citation forms test passed');
