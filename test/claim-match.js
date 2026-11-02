// test/claim-match.js - Module 3.B: the direction of an effect is read next to the terms a claim and its source share
// (SciFact-style reversals), without breaking supported claims. Run: node test/claim-match.js
const assert = require('assert');
const M = require('../src/tools/match');

const judge = (claim, source) => M.verdictOf(M.bestPassages(claim, M.passagesOf(source), 1)[0], { fullText: true });
const cases = [
  // reversed effect: the claim says one direction about the shared terms, the source the other
  ['A T helper 2 cell environment impedes disease development in lupus.', 'Activation of basophils promotes T helper 2 cell differentiation and enhances disease development in lupus-prone mice.', 'unsupported'],
  ['Curcumin increases the expression of TNF-alpha in macrophages.', 'In macrophages exposed to curcumin, the expression of TNF-alpha was strongly reduced compared with controls.', 'unsupported'],
  // same direction: still supported
  ['Curcumin reduces the expression of TNF-alpha in macrophages.', 'In macrophages exposed to curcumin, the expression of TNF-alpha was strongly reduced compared with controls.', 'full'],
  ['Metformin lowers fasting blood glucose in diabetic rats.', 'Oral metformin lowered fasting blood glucose in streptozotocin-induced diabetic rats after four weeks.', 'full'],
  // a negative finding reported correctly is support, as before
  ['The extract showed no activity against Escherichia coli.', 'No activity was observed against Escherichia coli at any concentration tested.', 'full']
];
for (const [claim, source, want] of cases) assert.strictEqual(judge(claim, source).verdict, want, `${claim} → expected ${want}`);
console.log(`claim-match test passed (${cases.length} cases)`);
