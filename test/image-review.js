// test/image-review.js - Module 5 review of findings (src/imageReview.js; the fixtures are strong findings, as only those
// of 80 % confidence and above are reported): a figure section repeating the in-text figures
// is not duplication, real re-use between different figures still is, and photo-only findings on generated figures are
// folded into the AI finding. node test/image-review.js
const assert = require('assert');
const { reviewFindings } = require('../src/imageReview');

const H = n => n.toString(16).padStart(16, '0');
const img = (page, panels, hashBase) => ({ id: `p${page}i1`, label: `Fig. ${page} — page ${page}`, panels, hashBase });
const build = defs => {
  const images = defs.map(d => ({ id: d.id, label: d.label, panels: d.panels }));
  const panels = defs.flatMap(d => Array.from({ length: d.panels }, (_, k) => ({ id: `${d.id}-p${k + 1}`, imageId: d.id, type: 'photo', hashes: [H(d.hashBase * 1000 + k)] })));
  return { images, panels };
};
const dup = (a, b, k = 1, extra = {}) => ({ kind: 'duplicate', category: 'duplication', level: 'high', score: 1, verification: { picture: 0.98, noise: 0.9 }, transform: { rotation: 0, flip: false, scale: 1 }, a: { panel: `${a}-p${k}`, label: a }, b: { panel: `${b}-p${k}`, label: b }, description: 'same image', ...extra });

(async () => {
  // 1. three figures in the text, repeated in the same order in a figure section; a real re-use between Fig. 4 and Fig. 6
  const defs = [img(4, 2, 1), img(6, 2, 2), img(8, 1, 3), { ...img(20, 2, 1) }, { ...img(21, 2, 2) }, { ...img(22, 1, 3) }];
  const { images, panels } = build(defs);
  panels.find(p => p.id === 'p6i1-p2').hashes = [H(999999)];
  panels.find(p => p.id === 'p21i1-p2').hashes = [H(999999)];
  const findings = [
    dup('p4i1', 'p20i1', 1), dup('p4i1', 'p20i1', 2), dup('p6i1', 'p21i1', 1), dup('p6i1', 'p21i1', 2), dup('p8i1', 'p22i1', 1),
    dup('p4i1', 'p6i1', 1), dup('p20i1', 'p21i1', 1), // real: Fig. 4 panel 1 re-used in Fig. 6, found again between the copies
    { kind: 'clone', category: 'manipulation', level: 'high', score: 150, a: { panel: 'p8i1-p1', box: { x: 10, y: 10 } }, b: { panel: 'p8i1-p1' }, description: 'clone' },
    { kind: 'clone', category: 'manipulation', level: 'high', score: 150, a: { panel: 'p22i1-p1', box: { x: 10, y: 10 } }, b: { panel: 'p22i1-p1' }, description: 'clone' }
  ];
  let r = await reviewFindings({ images, panels, findings });
  assert.deepStrictEqual(Object.keys(r.copies).sort(), ['p20i1', 'p21i1', 'p22i1'], 'figure section recognised');
  assert.strictEqual(r.findings.filter(f => f.kind === 'duplicate').length, 1, 'only the real re-use remains, once');
  assert.ok(r.findings.some(f => f.kind === 'duplicate' && f.a.panel === 'p4i1-p1' && f.b.panel === 'p6i1-p1'), 'real re-use kept on the originals');
  assert.strictEqual(r.findings.filter(f => f.kind === 'clone').length, 1, 'clone reported once, on the original');
  assert.ok(r.notes.some(n => /appear twice/.test(n)));

  // 2. the same image used as two different figures inside the text (Fig. 2 = Fig. 5, other figures between): duplication
  const d2 = [img(3, 1, 1), img(5, 1, 2), img(7, 1, 3), img(9, 1, 1), img(11, 1, 4)];
  const b2 = build(d2);
  r = await reviewFindings({ ...b2, findings: [dup('p3i1', 'p9i1', 1)] });
  assert.strictEqual(r.findings.length, 1, 'a figure re-used inside the text is still reported');
  assert.deepStrictEqual(r.copies, {});

  // 3. one figure repeated once at the end under another figure number (e.g. as a "new" figure): still reported
  const d3 = [img(3, 1, 1), img(5, 1, 2), img(12, 1, 1)];
  const b3 = build(d3);
  r = await reviewFindings({ ...b3, findings: [dup('p3i1', 'p12i1', 1)] });
  assert.strictEqual(r.findings.length, 1, 'a single repeat under another number is still reported');

  // 4. photo-only findings on a figure the AI detector reads as generated are folded into the AI finding; on others kept
  const d4 = [img(2, 1, 1), img(4, 1, 2)];
  const b4 = build(d4);
  const f4 = [
    { kind: 'ai', category: 'ai', level: 'high', score: 78, a: { panel: 'p2i1-p1' }, b: { panel: 'p2i1-p1' }, description: 'AI 78%' },
    { kind: 'alteration', category: 'manipulation', level: 'high', score: 3, a: { panel: 'p2i1-p1', box: { x: 1, y: 1 } }, b: { panel: 'p2i1-p1' }, description: 'noise' },
    { kind: 'alteration', category: 'manipulation', level: 'high', score: 3, a: { panel: 'p4i1-p1', box: { x: 1, y: 1 } }, b: { panel: 'p4i1-p1' }, description: 'noise' }
  ];
  r = await reviewFindings({ ...b4, findings: f4 });
  assert.deepStrictEqual(r.findings.map(f => `${f.kind}:${f.a.panel}`), ['ai:p2i1-p1', 'alteration:p4i1-p1']);

  // findings below 80 % confidence are not reported, whatever their kind
  const weak = [
    { kind: 'clone', level: 'medium', score: 10, a: { panel: 'p1i1-p1' }, b: { panel: 'p1i1-p1' }, description: 'weak clone' },
    { kind: 'clone', level: 'high', score: 150, a: { panel: 'p1i1-p1' }, b: { panel: 'p1i1-p1' }, description: 'strong clone' },
    { kind: 'alteration', level: 'medium', score: 2, a: { panel: 'p1i1-p1' }, b: { panel: 'p1i1-p1' }, description: 'one check' },
    { kind: 'alteration', level: 'high', score: 3, a: { panel: 'p1i1-p1' }, b: { panel: 'p1i1-p1' }, description: 'two checks' },
    { kind: 'partial', level: 'medium', score: 12, a: { panel: 'p1i1-p1' }, b: { panel: 'p1i1-p2' }, description: 'weak overlap' },
    { kind: 'duplicate', level: 'high', score: 0.99, verification: { picture: 0.98, noise: 0.9 }, a: { panel: 'p1i1-p1' }, b: { panel: 'p1i1-p2' }, description: 'strong copy' }
  ];
  r = await reviewFindings({ images: [], panels: [], findings: weak });
  assert.deepStrictEqual(r.findings.map(f => f.description), ['strong clone', 'two checks', 'strong copy']);

  console.log('image review test passed (figure section, real re-use kept, single repeat kept, generated figures)');
})().catch(e => { console.error(e); process.exit(1); });
