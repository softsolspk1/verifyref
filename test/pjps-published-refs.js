// test/pjps-published-refs.js - Module 1 on the way references are written in published PJPS articles (16 Nov 2026, 113
// references of articles 2023-2026): an online journal's article number or page count is the same article, a journal
// written as its acronym is the right journal, a registry record holding only the main title does not make the cited subtitle
// "invented", spaced initials and a title run into the journal are read. Real errors are still reported. No internet needed.
const assert = require('assert');
const P = require('../src/parse');
const R = require('../src/checks/reference');

const codes = (raw, rec) => {
  const ref = P.parseReferenceEntry(raw, 1);
  const rec2 = { title: ref.title, authors: ref.authors, year: ref.year, journal: ref.journal, volume: ref.volume, issue: ref.issue, pages: ref.pages, ...rec };
  return R.compare(ref, rec2, R.scoreCandidate(ref, rec2)).filter(i => i.severity !== 'info').map(i => i.code);
};

// article number <-> page count
assert.deepStrictEqual(codes('Mamikutty N, Thent ZC and Suhaimi FH (2014). The establishment of metabolic syndrome model by induction of fructose drinking water in male Wistar rats. BioMed Res. Int., 2014: 263897.',
  { pages: '1-8', doi: '10.1155/2014/263897' }), [], 'article number cited, page count registered');
assert.deepStrictEqual(codes('Akagi S, Fujiwara T and Takayanagi T (2019). The effectiveness of rebamipide mouthwash therapy for radiotherapy-induced oral mucositis. J. Pharm. Health Care Sci., 5(1): 1-7.',
  { pages: '16' }), [], 'page count cited, article number registered');
assert.deepStrictEqual(codes('Mosmann T (1983). Rapid colorimetric assay for cellular growth and survival: application to proliferation and cytotoxicity assays. J. Immunol. Methods, 65(1-2): 65-73.',
  { pages: '55-63' }), ['pages'], 'a wrong first page is still reported');

// journal acronym
assert.deepStrictEqual(codes('Oktavia SN and Ifora I (2022). Anti-inflammatory, analgesic and antipyretic potential of Azadirachta indica: A review. JDDT, 12(3-S): 245-254.',
  { journal: 'Journal of Drug Delivery and Therapeutics' }), ['journal-acronym'], 'JDDT is the right journal, written as an acronym');
assert.deepStrictEqual(codes('Pettit RK, Weber CA and Horton ML (2005). Microplate Alamar blue assay for Staphylococcus epidermidis biofilm susceptibility testing. J. Ethnopharmacol., 49(7): 2612-2617.',
  { journal: 'Antimicrobial Agents and Chemotherapy' }), ['journal'], 'a different journal is still the wrong journal');

// registry holding only the main title
assert.ok(!codes('Desjeux P (1996). Leishmaniasis, public health aspects and control. Clin. Dermatol., 14(5): 417-423.', { title: 'Leishmaniasis' }).includes('title-extra'), 'subtitle not taken as invented words');

// spaced initials, title run into the journal
assert.deepStrictEqual(P.parseReferenceEntry('Guarino M P, Cocca S and Cicala M (2013). Ursodeoxycholic acid therapy in gallbladder disease. World J. Gastroenterol., 19: 5029-5034.', 1).authors.map(a => `${a.family} ${a.given}`), ['Guarino MP', 'Cocca S', 'Cicala M']);
assert.deepStrictEqual(P.parseReferenceEntry('Lammert F, Ko C W and Van Erpecum K J (2016). Gallstones. Nat. Rev. Dis. Primers, 2: 16024.', 1).authors.map(a => `${a.family} ${a.given}`), ['Lammert F', 'Ko CW', 'Van Erpecum KJ']);
const run = P.parseReferenceEntry('Castaman G and Morfini M (2020). Non-compartment and compartmental pharmacokinetics, efficacy and safety of Kedrion FIX concentrate.Eur.J.Pharm.Sci.,153: 105485.', 1);
assert.strictEqual(run.title, 'Non-compartment and compartmental pharmacokinetics, efficacy and safety of Kedrion FIX concentrate');
assert.strictEqual(run.volume, '153');

console.log('pjps-published-refs: all checks passed');
