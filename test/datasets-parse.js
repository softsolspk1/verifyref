// test/datasets-parse.js - offline checks of the reference-database helpers that need no database or network:
// cell-line name extraction for the Cellosaurus check (Module 4) and the free-mail test before the lists are loaded.
const assert = require('assert');
const { cellLineCandidates } = require('../src/papermill');
const { FREE_MAIL, DISPOSABLE_MAIL } = require('../src/papermill/lists');

const names = cellLineCandidates('MCF-7 cells and HepG2 cells were cultured. The A549 cell line, CD4 cells, Th17 cells and HeLa cells. In 2019 cells were counted. Cell lines used: XYZ-123 cells.');
const got = names.map(c => c.name);
for (const n of ['MCF-7', 'HepG2', 'A549', 'XYZ-123']) assert(got.includes(n), `${n} not extracted`);
for (const n of ['CD4', 'Th17', 'In 2019', '2019']) assert(!got.includes(n), `${n} wrongly extracted as a cell line`);
assert(names.find(c => c.name === 'A549').calledLine, '"A549 cell line" not marked as called a cell line');
assert(!names.find(c => c.name === 'MCF-7').calledLine, '"MCF-7 cells" wrongly marked as called a cell line');
assert(cellLineCandidates('HeLa cells and SMMC-7721 cells', new Set(['smmc-7721'])).every(c => c.name !== 'SMMC-7721'), 'already-reported line not skipped');

// Before the downloaded domain lists are in memory, the built-in pattern still works and nothing is called disposable
assert(FREE_MAIL.test('author@gmail.com'), 'gmail not free-mail');
assert(!FREE_MAIL.test('author@uok.edu.pk'), 'university address treated as free-mail');
assert(!DISPOSABLE_MAIL.test('author@gmail.com'), 'gmail treated as disposable');

console.log('datasets parse test passed (cell-line extraction, free-mail fallback)');
setTimeout(() => process.exit(0), 50);
