// test/module-csv.js - CSV exports of Modules 2-5 (the specification asks Word, PDF and CSV for every module): the right
// rows and columns, quoting of commas and quotes, and the Excel BOM. Run: node test/module-csv.js
const assert = require('assert');
const P = require('../src/parse');
const { checkCompliance } = require('../src/checks/compliance');
const CSV = require('../src/moduleCsv');

const lines = csv => (csv.charCodeAt(0) === 0xFEFF ? csv.slice(1) : csv).split('\r\n');
const ok = m => console.log(`  ✓ ${m}`);

// Module 2: one row per deviation, compliant references once
const refs = ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2): 248-254.',
  'Livak KJ & Schmittgen TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): pp. 402-408.'].map((t, i) => P.parseReferenceEntry(t, i + 1));
const comp = checkCompliance(refs, { records: [null, null] });
const c2 = lines(CSV.compliance(comp, [{ number: 1, text: 'converted one' }]));
assert.ok(CSV.compliance(comp).charCodeAt(0) === 0xFEFF, 'Excel BOM');
assert.match(c2[0], /^#,Compliant,Reference as submitted,Rule,Deviation/);
assert.ok(c2.some(l => l.startsWith('1,yes,') && /converted one/.test(l)), 'compliant reference listed once, with its converted form');
assert.ok(c2.filter(l => l.startsWith('2,no,')).length >= 2, 'one row per deviation of the second reference');
assert.ok(c2.some(l => /“and”|"and"|&/.test(l)), 'the & deviation is there');
ok('Module 2: deviations per reference');

// Module 3
const cit = {
  consistency: { missing: [{ citation: 'Khan, 2019', reason: 'No reference by Khan, 2019', para: 3 }], uncited: [{ index: 4, raw: 'Ali B (2018). Title, with a comma. J. X., 1: 2.' }], yearMismatch: [{ citation: 'Shah, 2016', message: 'The list has 2014' }] },
  claims: { claims: [{ claim: 'The extract "reduced" oedema.', citations: [{ refIndex: 2, refStatusLabel: 'Verified', verdict: 'unsupported', verdictLabel: 'Unsupported', notes: ['figure not in the source'] }] }] },
  pattern: { flags: [{ severity: 'medium', message: 'Citation stacking', guidance: 'Check the journal' }] }
};
const c3 = lines(CSV.citations(cit));
assert.strictEqual(c3.length, 1 + 5);
assert.ok(c3.some(l => /^A\. Consistency,Missing from the reference list,"Khan, 2019","No reference by Khan, 2019",paragraph 3$/.test(l)), c3[1]);
assert.ok(c3.some(l => /"The extract ""reduced"" oedema\./.test(l)), 'quotes doubled inside a quoted cell');
assert.ok(c3.some(l => l.startsWith('C. Citation pattern')));
ok('Module 3: consistency, claims and pattern flags, CSV quoting');

// Module 4
const c4 = lines(CSV.papermill({ risk: { level: 'MEDIUM', score: 5 }, signals: [{ group: 'text', title: 'Tortured phrases', severity: 'high', weight: 3, evidence: [{ text: 'counterfeit consciousness', quote: 'a counterfeit consciousness model' }], guidance: 'Ask', code: 'tortured' }] }));
assert.ok(/^Risk,MEDIUM,,5,/.test(c4[1]) && /^text,Tortured phrases,Strong,3,/.test(c4[2]));
ok('Module 4: risk and signals with evidence');

// Module 5
const c5 = lines(CSV.images({ findings: [{ id: 1, kind: 'duplicate', category: 'duplication', level: 'high', confidence: 91, a: { panel: 'p1', label: 'Fig. 2C' }, b: { panel: 'p2', label: 'Fig. 4A' }, description: 'The same image appears twice' }], findingMarks: [{ id: 1, mark: 'ask' }],
  references: [{ panelLabel: 'Fig. 3B', title: 'Retracted paper', doi: '10.1/x', journal: 'J X', year: 2019, level: 'medium', confidence: 50, description: 'Matches a retracted figure' }] }));
assert.ok(c5.some(l => /^Finding,1,duplication,duplicate,Strong,91,Fig\. 2C vs Fig\. 4A,The same image appears twice,Ask the authors/.test(l)));
assert.ok(c5.some(l => /^Published \/ retracted figure,.*Retracted paper,10\.1\/x,"J X, 2019"$/.test(l)));
ok('Module 5: findings with editor marks, matches with published figures');
console.log('module CSV test passed');
