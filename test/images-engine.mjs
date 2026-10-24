// test/images-engine.mjs - Module 5 engine on a synthetic multi-panel figure with planted problems.
// Run: node test/images-engine.mjs
import assert from 'assert';
import * as E from '../public/js/images/engine.js';

let seed = 42;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

/** "Microscopy-like" texture: random soft blobs on a dark background */
function texture(w, h, blobs = 70) {
  const d = new Uint8ClampedArray(w * h * 4);
  const f = new Float32Array(w * h);
  for (let b = 0; b < blobs; b++) {
    const cx = rnd() * w, cy = rnd() * h, r = 4 + rnd() * 14, a = 80 + rnd() * 170;
    for (let y = Math.max(0, Math.floor(cy - 3 * r)); y < Math.min(h, cy + 3 * r); y++)
      for (let x = Math.max(0, Math.floor(cx - 3 * r)); x < Math.min(w, cx + 3 * r); x++) f[y * w + x] += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
  }
  for (let i = 0; i < w * h; i++) { const v = Math.min(255, 15 + f[i] + rnd() * 12); d[i * 4] = v * 0.3; d[i * 4 + 1] = v; d[i * 4 + 2] = v * 0.45; d[i * 4 + 3] = 255; }
  return { width: w, height: h, data: d };
}

function blank(w, h) { const d = new Uint8ClampedArray(w * h * 4).fill(255); return { width: w, height: h, data: d }; }
function paste(dst, src, ox, oy, map = (x, y) => [x, y], sw = src.width, sh = src.height) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const [sx, sy] = map(x, y);
    if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
    const s = (Math.floor(sy) * src.width + Math.floor(sx)) * 4, t = ((oy + y) * dst.width + ox + x) * 4;
    for (let k = 0; k < 4; k++) dst.data[t + k] = src.data[s + k];
  }
}

const A = texture(200, 200), D = texture(200, 200, 60);
const E2 = texture(200, 200, 55);
// clone: copy a 50x50 region of E2 to another place
paste(E2, { width: 200, height: 200, data: E2.data.slice() }, 130, 130, (x, y) => [x + 10, y + 10], 50, 50);
const fig = blank(5 * 220 + 20, 240);
paste(fig, A, 20, 20);                                               // panel 1: original
paste(fig, A, 240, 20, (x, y) => [y, 199 - x]);                      // panel 2: rotated 90°
paste(fig, A, 460, 20, (x, y) => [40 + x * 0.6, 40 + y * 0.6]);      // panel 3: crop of the centre, enlarged
paste(fig, D, 680, 20);                                              // panel 4: unrelated
paste(fig, E2, 900, 20);                                             // panel 5: cloned area inside
// panel 6 is a mirrored copy in a second figure
const fig2 = blank(240, 240);
paste(fig2, A, 20, 20, (x, y) => [199 - x, y]);

const t0 = Date.now();
const boxes = E.splitPanels(fig);
console.log('panels found:', boxes.length, boxes.map(b => `${b.x},${b.y} ${b.w}x${b.h}`).join(' | '));
assert.strictEqual(boxes.length, 5, 'five panels split');
const boxes2 = E.splitPanels(fig2);
const panels = [
  ...boxes.map((b, i) => E.preparePanel(fig, b, { id: `f1p${i + 1}`, label: `Fig. 1 panel ${i + 1}` })),
  ...boxes2.map((b, i) => E.preparePanel(fig2, b, { id: `f2p${i + 1}`, label: `Fig. 2 panel ${i + 1}` }))
];
console.log('types:', panels.map(p => `${p.id}:${p.type}`).join(' '));
const findings = E.findIssues(panels);
console.log(`${findings.length} findings in ${Date.now() - t0} ms`);
for (const f of findings) console.log(` ${f.level.padEnd(6)} ${f.kind.padEnd(9)} ${f.a.panel} ~ ${f.b.panel}: ${f.description}`);
const has = (kind, a, b) => findings.some(f => f.kind === kind && ((f.a.panel === a && f.b.panel === b) || (f.a.panel === b && f.b.panel === a)));
assert.ok(has('duplicate', 'f1p1', 'f1p2'), 'rotated duplicate found');
assert.ok(has('duplicate', 'f1p1', 'f2p1') || has('partial', 'f1p1', 'f2p1'), 'mirrored duplicate found');
assert.ok(has('partial', 'f1p1', 'f1p3') || has('partial', 'f1p2', 'f1p3'), 'enlarged crop found');
assert.ok(findings.some(f => f.kind === 'clone' && f.a.panel === 'f1p5'), 'clone inside panel 5 found');
assert.ok(!findings.some(f => (f.a.panel === 'f1p4' || f.b.panel === 'f1p4') && f.kind !== 'clone'), 'unrelated panel not matched');
console.log('images engine test: all assertions passed');

// False alarms: unrelated panels of the same kind must not match each other
const unrelated = Array.from({ length: 12 }, (_, i) => { const t = texture(180, 180, 50 + i * 3); return E.preparePanel(t, { x: 0, y: 0, w: 180, h: 180 }, { id: `u${i}`, label: `U${i}` }); });
const t1 = Date.now();
const fa = E.findIssues(unrelated).filter(f => f.kind !== 'clone');
console.log(`unrelated panels: ${fa.length} cross-panel findings (${Date.now() - t1} ms)`);
assert.strictEqual(fa.length, 0, 'no false alarms between unrelated panels');
console.log('images engine false-alarm test passed');
