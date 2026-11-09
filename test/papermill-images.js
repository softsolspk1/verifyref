// papermill-images.js - Module 4 reads the Module 5 report: figures matching retracted papers or earlier PJPS submissions
// are a signal of their own; a strong image finding stays the one high signal (matches not counted twice). Offline.
process.env.PGLITE_DIR = 'memory://';
const assert = require('assert');
const { imagesSignal, riskLevel } = require('../src/papermill');
const { imagesInput } = require('../src/integrity');

assert.strictEqual(imagesSignal(null), null);
assert.strictEqual(imagesSignal({ findings: {} }), null, 'a clean image report gives no signal');
const s1 = imagesSignal(imagesInput({ byLevel: { high: 0, medium: 1 }, referencesRetracted: 1, references: 1 }));
assert.deepStrictEqual([s1.severity, s1.weight], ['medium', 3], 'a figure matching a retracted paper is a medium signal on its own');
assert.ok(/retracted papers/.test(s1.title) && s1.evidence.length === 1);
const s2 = imagesSignal(imagesInput({ byLevel: { high: 0 }, earlier: 1, earlierCharts: 1 }));
assert.ok(/earlier PJPS submissions/.test(s2.title) && /2 figure/.test(s2.evidence[0].text), 'earlier submissions: figures and charts counted');
const s3 = imagesSignal(imagesInput({ byLevel: { high: 2 }, byCategory: { duplication: 2 }, referencesRetracted: 1, references: 3 }));
assert.deepStrictEqual([s3.severity, s3.weight], ['high', 5], 'strong findings: one high signal');
assert.strictEqual(s3.evidence.length, 2, 'the retracted and the other published matches are listed as evidence');
assert.strictEqual(riskLevel([s3]).level, 'MEDIUM', 'one high signal alone is MEDIUM (unchanged scoring)');
assert.deepStrictEqual([imagesSignal(imagesInput({ byLevel: { medium: 2 } })).weight], [2], 'other findings to check: weight 2 (unchanged)');
console.log('papermill images test passed');
process.exit(0);
