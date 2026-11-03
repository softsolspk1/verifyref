// test/claim-match.js - Module 3.B: the direction of an effect is read next to the terms a claim and its source share
// (SciFact-style reversals), without breaking supported claims. Run: node test/claim-match.js
const assert = require('assert');
const M = require('../src/tools/match');

const judge = (claim, source) => M.verdictOf(M.bestPassages(claim, M.passagesOf(source), 1)[0], { fullText: true });
const TRANSFORMER = 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Recurrent neural networks, long short-term memory and gated recurrent neural networks in particular, have been firmly established as state of the art approaches in sequence modeling.';
const cases = [
  // reversed effect: the claim says one direction about the shared terms, the source the other
  ['A T helper 2 cell environment impedes disease development in lupus.', 'Activation of basophils promotes T helper 2 cell differentiation and enhances disease development in lupus-prone mice.', 'unsupported'],
  ['Curcumin increases the expression of TNF-alpha in macrophages.', 'In macrophages exposed to curcumin, the expression of TNF-alpha was strongly reduced compared with controls.', 'unsupported'],
  // same direction: still supported
  ['Curcumin reduces the expression of TNF-alpha in macrophages.', 'In macrophages exposed to curcumin, the expression of TNF-alpha was strongly reduced compared with controls.', 'full'],
  ['Metformin lowers fasting blood glucose in diabetic rats.', 'Oral metformin lowered fasting blood glucose in streptozotocin-induced diabetic rats after four weeks.', 'full'],
  // a negative finding reported correctly is support, as before
  ['The extract showed no activity against Escherichia coli.', 'No activity was observed against Escherichia coli at any concentration tested.', 'full'],
  // opposite wording about the same subject
  ['Ca2+ cycling is a UCP1-dependent thermogenic mechanism in beige fat.', 'Here we report a robust UCP1-independent thermogenic mechanism in beige fat that involves enhanced Ca2+ cycling.', 'unsupported'],
  ['TG2-specific IgA plasma cells are scarce in the duodenal mucosa in active celiac disease.', 'TG2-specific IgA plasma cells are markedly expanded within the duodenal mucosa in active celiac disease.', 'unsupported'],
  ['Ca2+ cycling is a UCP1-independent thermogenic mechanism in beige fat.', 'Here we report a robust UCP1-independent thermogenic mechanism in beige fat that involves enhanced Ca2+ cycling.', 'full'],
  // proportions written in words must agree
  ['One in two surgical randomised controlled trials are discontinued early.', 'One in five surgical randomised controlled trials are discontinued early, one in three completed trials remain unpublished.', 'partial'],
  ['One in five surgical randomised controlled trials are discontinued early.', 'One in five surgical randomised controlled trials are discontinued early, one in three completed trials remain unpublished.', 'full'],
  // the source does without what the claim says is relied on (Vaswani et al. 2017); a claim that restates the source, or
  // that itself does without it, is not contradicted
  ['The Transformer relies on recurrent neural networks as its core building block.', TRANSFORMER, 'unsupported'],
  ['The Transformer architecture is built on convolutional layers.', TRANSFORMER, 'unsupported'],
  ['The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.', TRANSFORMER, 'full'],
  ['The Transformer is based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.', TRANSFORMER, 'full']
];
for (const [claim, source, want] of cases) assert.strictEqual(judge(claim, source).verdict, want, `${claim} → expected ${want}`);
console.log(`claim-match test passed (${cases.length} cases)`);
