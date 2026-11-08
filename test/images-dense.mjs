// images-dense.mjs - Module 5 dense cloned-area search: an area copied inside a textured panel and then brightened and
// re-noised (as by an edit and a re-save) is reported, and found by the dense search; an untouched textured panel is not
// reported. Offline, synthetic images.
import assert from 'assert';
import * as E from '../public/js/images/engine.js';

let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
// a cell-field-like texture: smooth blobs plus fine grain
function texture(w, h) {
  const g = new Float32Array(w * h);
  const blobs = Array.from({ length: 120 }, () => ({ x: rnd() * w, y: rnd() * h, r: 4 + rnd() * 9, v: 40 + rnd() * 120 }));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 70;
    for (const b of blobs) { const d = (x - b.x) ** 2 + (y - b.y) ** 2; if (d < b.r * b.r) v += b.v * (1 - d / (b.r * b.r)); }
    g[y * w + x] = Math.min(255, v + (rnd() - 0.5) * 30);
  }
  return g;
}
function toImg(g, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g[i]; data[i * 4 + 3] = 255; }
  return { width: w, height: h, data };
}
const panel = (g, w, h) => { const img = toImg(g, w, h); return E.preparePanel(img, { x: 0, y: 0, w, h }, { id: 'p', label: 'p', imageId: 'p', index: 1 }, E.toGray(img)); };

const w = 300, h = 240;
const clean = texture(w, h);
const edited = clean.slice();
// a 70 x 60 area copied 150 px to the right, brightened by 10 levels and re-noised (+-2)
for (let y = 40; y < 100; y++) for (let x = 20; x < 90; x++) edited[y * w + x + 150] = Math.min(255, clean[y * w + x] + 10 + (rnd() - 0.5) * 4);

const found = E.findIssues([panel(edited, w, h)]).filter(f => f.kind === 'clone');
assert.ok(found.length, 'the edited copy is reported');
const f = found[0];
const hit = r => r.x < 95 && r.x + r.w > 15 && r.y < 105 && r.y + r.h > 35;
const hitCopy = r => r.x < 245 && r.x + r.w > 165 && r.y < 105 && r.y + r.h > 35;
assert.ok((hit(f.a.box) && hitCopy(f.b.box)) || (hit(f.b.box) && hitCopy(f.a.box)), `located: ${JSON.stringify([f.a.box, f.b.box])}`);
console.log(`  ✓ brightened, re-noised copy reported and located (${f.code}): ${f.description}`);

const dense = E.denseClone(panel(edited, w, h).cloneGray);
assert.ok(dense.some(c => c.area >= 600 && Math.abs(Math.abs(c.dx) - 150) <= 2 && Math.abs(c.dy) <= 2), 'the dense search finds it at the right offset');
console.log('  ✓ the dense search finds the copy at its offset (150 px)');

const none = E.findIssues([panel(clean, w, h)]).filter(f => f.kind === 'clone');
assert.strictEqual(none.length, 0, `untouched texture not reported: ${none.map(x => x.description).join(' / ')}`);
console.log('  ✓ the untouched textured panel is not reported');
console.log('images dense test passed');
