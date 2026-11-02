// test/ref-quality.js - Module 1 reference quality (RefGuard style): paratexts, the four scores and the comparison.
// Run: node test/ref-quality.js
const assert = require('assert');
const Q = require('../src/checks/refQuality');

const ref = (index, o = {}) => ({ index, status: 'verified', age: 3, parsed: {}, record: { title: 'Antibacterial activity of plant extracts', journal: `Journal ${index}`, authors: [{ family: `Author${index}`, given: 'A' }], type: 'journal-article' }, openalex: { workType: 'article', citedBy: 40 }, ...o });

// ---- paratexts: by title and by OpenAlex type; a retracted paper's own notice is not repeated
const para = Q.paratexts([
  ref(1, { record: { title: 'Erratum: Effect of curcumin on wound healing', type: 'journal-article' } }),
  ref(2, { record: { title: 'Correction to: Antioxidant capacity of Nigella sativa', type: 'journal-article' } }),
  ref(3, { record: { title: 'Antimicrobial resistance: a call to action', type: 'journal-article' }, openalex: { workType: 'editorial' } }),
  ref(4, { record: { title: 'Letter to the editor: dosing of metformin', type: 'journal-article' } }),
  ref(5, { record: { title: 'Expression of concern: Hepatoprotective effect of silymarin', type: 'journal-article' } }),
  ref(6, { record: { title: 'Abstracts of the 12th International Congress of Pharmacology', type: 'journal-article' } }),
  ref(7),                                                                                                   // a normal paper
  ref(8, { record: { title: 'Correctional health care and pharmacy services', type: 'journal-article' } }), // "Correctional", not a correction
  ref(9, { record: { title: 'Review of the literature on herbal hepatotoxicity', type: 'journal-article' } }), // a review, not a book review
  ref(10, { status: 'retracted', record: { title: 'Retraction notice to: Ileal-lymphoid-nodular hyperplasia', type: 'journal-article' } })
]);
assert.deepStrictEqual(para.map(p => [p.index, p.kind]), [[1, 'erratum'], [2, 'erratum'], [3, 'editorial'], [4, 'letter'], [5, 'retraction-notice'], [6, 'abstract']], JSON.stringify(para));
assert.match(para.find(p => p.index === 3).basis, /OpenAlex/);
// cited as an erratum but matched to the paper it corrects
const cited = Q.paratexts([ref(1, { status: 'miscited', parsed: { title: 'Erratum: Hallmarks of cancer: the next generation' }, record: { title: 'Hallmarks of Cancer: The Next Generation', type: 'journal-article' } })]);
assert.ok(cited.length === 1 && cited[0].kind === 'erratum' && /as cited/.test(cited[0].basis), JSON.stringify(cited));
console.log('  ✓ paratexts: errata, editorial (by type), letter, concern notice, abstract; no false hits on similar words');

// ---- scores
const good = Array.from({ length: 10 }, (_, i) => ref(i + 1));
const journals = { journals: good.map(r => ({ refs: [r.index], indexing: { scopus: { quartile: 'Q1' } } })) };
const ind = { age: { recentShare: 100, within10Share: 100, rule: { years: 5 } }, riskyJournals: [] };
const s1 = Q.scores(good, journals, ind, []);
assert.ok(s1.quality.score === 100 && s1.impact.score === 100 && s1.recency.score === 100 && s1.diversity.score === 100, JSON.stringify(s1));
// one journal and one author for everything, old, retracted and suspicious references
const poor = Array.from({ length: 10 }, (_, i) => ref(i + 1, { age: 25, status: i < 2 ? 'retracted' : i < 4 ? 'suspicious' : 'verified', record: { title: 'Same group again', journal: 'Journal X', authors: [{ family: 'Khan', given: 'A' }] }, openalex: { citedBy: 0 } }));
const s2 = Q.scores(poor, null, { ...ind, age: { recentShare: 0, within10Share: 0, rule: { years: 5 } } }, []);
assert.ok(s2.quality.score <= 40 && s2.recency.score === 0 && s2.diversity.score === 0 && s2.impact.score <= 10, JSON.stringify(s2));
for (const k of ['quality', 'impact', 'recency', 'diversity']) assert.ok(s2[k].facts.length > 5, `${k} explains itself`);
console.log('  ✓ scores: 100 for a sound, recent, diverse list; low for an old, concentrated list with problem references');

// ---- comparison only from 10 earlier manuscripts
assert.strictEqual(Q.compare(s1, { n: 4, sums: {}, counts: {} }).available, false);
const cmp = Q.compare(s2, { n: 12, sums: { quality: 840, impact: 600, recency: 720, diversity: 960 }, counts: { quality: 12, impact: 12, recency: 12, diversity: 12 } });
assert.ok(cmp.available && cmp.recency.average === 60 && cmp.recency.difference === -60);
console.log('  ✓ comparison with the PJPS average from 10 manuscripts on');
console.log('ref-quality test passed');
