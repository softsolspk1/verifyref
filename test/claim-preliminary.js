// claim-preliminary.js - Module 3B: a claim read against the abstract only is not reported to the author as unsupported;
// the author letter asks for the cited work's PDF instead. Offline.
process.env.PGLITE_DIR = 'memory://';
const assert = require('assert');
const { correctionLetter } = require('../src/editor/reports');

const cite = (refIndex, verdict, extra = {}) => ({ refIndex, refRaw: `Ref ${refIndex}. A study. J Test 2020;1:1-2.`, verdict, notes: [], ...extra });
const result = {
  meta: { title: 'Test' },
  references: { results: [] },
  claims: { claims: [
    { claim: 'Drug A lowers blood pressure in rats.', citations: [cite(1, 'not-confirmed', { preliminary: true }), cite(2, 'unsupported', { contradicts: true, preliminary: true })] },
    { claim: 'Drug A is safe in humans.', citations: [cite(1, 'partial', { preliminary: true }), cite(3, 'unsupported')] },
    { claim: 'Drug B binds receptor C.', citations: [cite(4, 'full'), cite(5, 'not-confirmed', { preliminary: true, refStatus: 'retracted' })] }
  ] }
};
assert.ok(!correctionLetter(result, 'en').sections.some(s => s.key === 'sourcePdf'), 'the PDF request is optional: off by default');
assert.strictEqual(correctionLetter(result, 'en').pdfRequest, 1, 'the letter says how many works could be asked for');
const L = correctionLetter(result, 'en', { askPdfs: true });
const sec = k => L.sections.find(s => s.key === k);
assert.deepStrictEqual(sec('unsupported').items.map(i => i.ref), [2, 3], 'only contradicted / full-text verdicts are told to the author as unsupported');
assert.deepStrictEqual(sec('sourcePdf').items.map(i => i.ref), [1], 'the abstract-only work is asked for as a PDF, once');
assert.ok(/lowers blood pressure/.test(sec('sourcePdf').items[0].note) && /safe in humans/.test(sec('sourcePdf').items[0].note), 'both statements citing it are named');
assert.ok(/upload the PDF/.test(L.text));
assert.ok(correctionLetter(result, 'ur', { askPdfs: true }).sections.some(s => s.key === 'sourcePdf'), 'Urdu letter too');
console.log('claim preliminary test passed');
