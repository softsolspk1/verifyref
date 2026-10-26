// test/pjps-style.js - the PJPS reference examples from the official Instructions for Authors
// (https://pjps.pk/instructions/instructions-for-authors) must be read, re-formatted and judged compliant exactly as printed.
const assert = require('assert');
const P = require('../src/parse');
const ST = require('../src/styles');
const { checkEntry } = require('../src/checks/compliance');

const OFFICIAL = {
  journal: 'Yoneto K, Li SK, Higuchi WI, Jiskoot W and Herron JN (1996). Fluorescence probe studies of the interactions of 1-alkyl- 2-pyrrolidones with stratum corneum lipid liposomes. J. Pharm. Sci., 85(5): 511-517.',
  chapter: 'Rall TW and Schleifer LS (1985). Drugs effective in the therapy of the epilepsies. In: Gilman AG, Goodman LS, Rall TW, Murad F (eds.), Pharmacol. Basis Ther., 7th ed., MacMillan Publishing Co., New York, pp. 446-472.',
  web: 'World Health Organization (2020). Coronavirus disease (COVID-19) pandemic. Available at: https://www.who.int/emergencies/diseases/novel-coronavirus-2019 (Accessed 15 June 2020).'
};

for (const [kind, text] of Object.entries(OFFICIAL)) {
  const ref = P.parseReferenceEntry(text, 1);
  assert.strictEqual(ST.formatText(ref, 'pjps'), text, `${kind}: re-formatted text differs from the official example`);
  const c = checkEntry(ref, null);
  const bad = c.deviations.filter(d => d.severity !== 'info');
  assert.deepStrictEqual(bad.map(d => d.message), [], `${kind}: official example judged non-compliant`);
}
// all authors are kept (no "et al." in the list), journal italic, volume bold
const eight = 'Ali A, Khan B, Shah C, Noor D, Raza E, Malik F, Zubair G and Qureshi H (2020). Antibacterial activity of plant extracts. Pak. J. Pharm. Sci., 33(2): 100-110.';
assert.strictEqual(ST.formatText(P.parseReferenceEntry(eight, 1), 'pjps'), eight, '8 authors must all be listed');
const segs = ST.entry(P.parseReferenceEntry(OFFICIAL.journal, 1), 'pjps');
assert(segs.some(s => s.i && /J\. Pharm\. Sci\./.test(s.t)), 'journal not italic');
assert(segs.some(s => s.b && s.t.trim() === '85'), 'volume not bold');
// deviations that must be reported
assert(checkEntry(P.parseReferenceEntry('Khan A et al. (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', 1), null).deviations.some(d => /all authors/i.test(d.message)), 'et al. in the list not flagged');
assert(checkEntry(P.parseReferenceEntry('World Health Organization (2020). Coronavirus disease (COVID-19) pandemic. Available at: https://www.who.int/emergencies/diseases/novel-coronavirus-2019', 1), null).deviations.some(d => d.rule === 'web'), 'missing access date not flagged');
console.log('pjps style test passed (3 official examples, all authors, italic/bold)');
