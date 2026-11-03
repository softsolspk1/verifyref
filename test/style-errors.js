// test/style-errors.js - Module 2 accuracy: correct PJPS references are compliant, and each planted single style error is
// reported under the right rule. A missing full stop after the title can only be told apart from the journal with the
// matched record (Module 1), so those cases carry the record's title.
const P = require('../src/parse');
const { checkEntry } = require('../src/checks/compliance');
const GOOD = [
  'Yoneto K, Li SK, Higuchi WI, Jiskoot W and Herron JN (1996). Fluorescence probe studies of the interactions of 1-alkyl- 2-pyrrolidones with stratum corneum lipid liposomes. J. Pharm. Sci., 85(5): 511-517.',
  'Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2): 248-254.',
  'Livak KJ and Schmittgen TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): 402-408.',
  'Ahmad N, Bibi S and Iqbal Z (2019). Evaluation of antibacterial activity of selected medicinal plants of Khyber Pakhtunkhwa. Pak. J. Pharm. Sci., 32(3): 1121-1127.',
  'Korsmeyer RW, Gurny R, Doelker E, Buri P and Peppas NA (1983). Mechanisms of solute release from porous hydrophilic polymers. Int. J. Pharm., 15(1): 25-35.',
  'Kilkenny C, Browne WJ, Cuthill IC, Emerson M and Altman DG (2010). Improving bioscience research reporting: the ARRIVE guidelines for reporting animal research. PLoS Biol., 8(6): e1000412.'
];
// [planted text, rule that must be reported]
const BAD = [
  ['Yoneto K et al. (1996). Fluorescence probe studies of the interactions of 1-alkyl- 2-pyrrolidones with stratum corneum lipid liposomes. J. Pharm. Sci., 85(5): 511-517.', 'authors', 'et al.'],
  ['Livak KJ & Schmittgen TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): 402-408.', 'authors', '&'],
  ['Livak K.J. and Schmittgen T.D. (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): 402-408.', 'authors', 'dotted initials'],
  ['Livak, KJ and Schmittgen, TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): 402-408.', 'authors', 'comma before initials'],
  ['Kenneth J. Livak and Thomas D. Schmittgen (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): 402-408.', 'authors', 'full names'],
  ['Bradford MM, 1976. A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2): 248-254.', 'year', 'year not in parentheses'],
  ['Bradford MM. A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal Biochem. 1976;72(1-2):248-54.', 'year', 'Vancouver order'],
  ['Bradford MM (1976). A Rapid and Sensitive Method for the Quantitation of Microgram Quantities of Protein Utilizing the Principle of Protein-Dye Binding. Anal. Biochem., 72(1-2): 248-254.', 'title', 'Title Case'],
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Analytical Biochemistry, 72(1-2): 248-254.', 'journal', 'full journal name'],
  ['Korsmeyer RW, Gurny R, Doelker E, Buri P and Peppas NA (1983). Mechanisms of solute release from porous hydrophilic polymers. International Journal of Pharmaceutics, 15(1): 25-35.', 'journal', 'full journal name'],
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2): pp. 248-254.', 'pages', 'pp.'],
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2): 248–254.', 'pages', 'en dash'],
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., Vol. 72, No. 1-2: 248-254.', 'volume', 'Vol./No.'],
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2), 248-254.', 'volume', 'comma instead of colon'],
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 248-254.', 'missing', 'no volume'],
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2).', 'missing', 'no pages'],
  ['Livak KJ, and Schmittgen TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): 402-408.', 'authors', 'comma before and'],
  ['Bradford MM (1976). "A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding." Anal. Biochem., 72(1-2): 248-254.', 'title', 'quotation marks'],
  ['M.M. Bradford (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2): 248-254.', 'authors', 'initials first'],
  ['Kilkenny C, Browne WJ, Cuthill IC, Emerson M, Altman DG (2010). Improving bioscience research reporting: the ARRIVE guidelines for reporting animal research. PLoS Biol., 8(6): e1000412.', 'authors', 'no "and" before last author'],
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem. 72(1-2): 248-254.', 'journal', 'no comma after journal']
];
// [text, record title]: the full stop after the title is missing (caught), or present (no false alarm)
const STOP = [
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding Anal. Biochem., 72(1-2): 248-254.', 'A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding', true],
  ['Korsmeyer RW, Gurny R, Doelker E, Buri P and Peppas NA (1983). Mechanisms of solute release from porous hydrophilic polymers, Int. J. Pharm., 15(1): 25-35.', 'Mechanisms of solute release from porous hydrophilic polymers', true],
  ['Ahmad N, Bibi S and Iqbal Z (2019). Evaluation of antibacterial activity of selected medicinal plants of Khyber Pakhtunkhwa Pak. J. Pharm. Sci., 32(3): 1121-1127.', 'Evaluation of antibacterial activity of selected medicinal plants of Khyber Pakhtunkhwa', true],
  ['Ahmad N, Bibi S and Iqbal Z (2019). Evaluation of antibacterial activity of selected medicinal plants of Khyber Pakhtunkhwa. Pak. J. Pharm. Sci., 32(3): 1121-1127.', 'Evaluation of antibacterial activity of selected medicinal plants of Khyber Pakhtunkhwa', false],
  ['Livak KJ and Schmittgen TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): 402-408.', 'Analysis of Relative Gene Expression Data Using Real-Time Quantitative PCR and the 2−ΔΔCT Method', false]
];
let ok = 0, n = 0;
for (const [t, recTitle, missing] of STOP) {
  n++;
  const c = checkEntry(P.parseReferenceEntry(t, 1), { title: recTitle, type: 'journal-article', volume: '1', pages: '1' });
  const hit = c.deviations.some(d => d.rule === 'title' && /full stop/.test(d.message));
  if (hit === missing) ok++; else console.log(missing ? 'MISSED  missing full stop after title' : 'FALSE ALARM full stop', t.slice(0, 60));
}
for (const t of GOOD) { n++; const c = checkEntry(P.parseReferenceEntry(t, 1), null); const bad = c.deviations.filter(d => d.severity !== 'info'); if (!bad.length) ok++; else console.log('FALSE ALARM', t.slice(0, 60), '|', bad.map(d => d.message).join('; ')); }
for (const [t, rule, what] of BAD) { n++; const c = checkEntry(P.parseReferenceEntry(t, 1), null); const hit = c.deviations.filter(d => d.severity !== 'info'); if (hit.some(d => d.rule === rule)) ok++; else console.log('MISSED', what.padEnd(28), '| got:', hit.map(d => `${d.rule}: ${d.message}`).join('; ') || 'compliant'); }
console.log(`style-errors test: ${ok}/${n}`);
if (ok !== n) process.exit(1);
