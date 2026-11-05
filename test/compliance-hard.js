// test/compliance-hard.js - Module 2 PJPS style compliance on harder entries (no network): correctly formatted references
// that are easy to misjudge (hyphenated and particle surnames, species, genes and acronyms in titles, article numbers,
// supplements, one-word journals, a/b years, single authors) and subtle deviations (no "and", initials with full stops,
// unabbreviated journal, year in Vancouver place, title case, dashes). node test/compliance-hard.js
const assert = require('assert');
const { parseReferenceEntry } = require('../src/parse');
const { checkEntry } = require('../src/checks/compliance');

const CASES = [
  // ---- compliant: nothing may fire
  ['Abdul-Rahman A, Al-Qahtani MS and Khan A (2020). Antioxidant activity of Moringa oleifera leaves. Pak. J. Pharm. Sci., 33(2): 611-617.', []],
  ['van der Berg JP and de Vries M (2018). Pharmacokinetics of metformin in elderly patients. Br. J. Clin. Pharmacol., 84(5): 1012-1020.', []],
  ['Khan A (2019). Effect of Nigella sativa on HbA1c in type 2 diabetes in Pakistan. Pak. J. Pharm. Sci., 32(4): 1601-1606.', []],
  ['Ali S, Raza H and Noor F (2021). Expression of TNF-α and IL-6 in COVID-19 patients treated with dexamethasone. Molecules, 26(3): 712.', []],
  ['Shah SA and Iqbal Z (2022). Biofilm inhibition of Staphylococcus aureus by silver nanoparticles. PLoS One, 17(4): e0266512.', []],
  ['Malik R and Butt G (2019a). Formulation of ibuprofen floating tablets. Pak. J. Pharm. Sci., 32(1 Suppl): 341-347.', []],
  ['Malik R and Butt G (2019b). Stability of amoxicillin suspensions in tropical conditions. Pak. J. Pharm. Sci., 32(3 Special): 1301-1306.', []],
  ['Zhang Y, Li X and Wang J (2020). Role of the NF-κB pathway in hepatic fibrosis. Cell, 181(2): 271-285.', []],
  ['Raza H (2017). DNA damage induced by cisplatin in HepG2 cells. Toxicol. In Vitro, 44: 120-126.', []],
  ['Iqbal Z, Khan MA and Shah SA (2016). An HPLC-UV method for the simultaneous determination of paracetamol and caffeine. J. Chromatogr. B, 1012: 45-52.', []],
  // ---- one deviation each: the named rule must fire
  ['Khan A, Ali B, Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', ['authors']],
  ['Khan A.B., Ali B. and Shah C. (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', ['authors']],
  ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Journal of Ethnopharmacology, 32(1): 1-5.', ['journal']],
  ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci. 32(1): 1-5.', ['journal']],
  ['Khan A, Ali B and Shah C (2019). Antibacterial Activity of Medicinal Plants from Northern Pakistan. Pak. J. Pharm. Sci., 32(1): 1-5.', ['title']],
  ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1), 1-5.', ['volume']],
  ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1—5.', ['pages']],
  ['Khan A, Ali B and Shah C (2019) Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', ['year']],
  ['Khan Ahmed, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', ['authors']],
  ['Khan A, Ali B and Shah C (2019). "Antibacterial activity of medicinal plants." Pak. J. Pharm. Sci., 32(1): 1-5.', ['title']],
  ['Khan A, Ali B and Shah C, 2019. Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', ['year']]
];

let pass = 0;
const fails = [];
CASES.forEach(([raw, want], i) => {
  const ref = { ...parseReferenceEntry(raw), raw, index: i };
  const got = [...new Set(checkEntry(ref, null, null).deviations.filter(d => d.severity !== 'info').map(d => d.rule))];
  const ok = want.length ? want.every(r => got.includes(r)) && got.every(r => want.includes(r)) : got.length === 0;
  if (ok) pass++; else fails.push(`#${i + 1} want=[${want}] got=[${got}] ${raw.slice(0, 80)}`);
});
console.log(`Module 2 compliance (hard): ${pass}/${CASES.length}`);
fails.forEach(f => console.log('FAIL', f));
assert.strictEqual(pass, CASES.length);
