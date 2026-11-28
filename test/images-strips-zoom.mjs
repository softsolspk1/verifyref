// images-strips-zoom.mjs - Module 5, report 279 (manuscript 16941, Fig. 9M / 9O):
// 1. a PDF figure stored as horizontal strips placed edge to edge is read as one figure (public/js/images/extract.js
//    tileGroups); separate figures, and pictures that only share an edge partly, stay apart.
// 2. one panel a close-up of part of another (another magnification: the fine grain and detail differ, so the crop check
//    misses it) is found (engine.js pairZoom); two unrelated panels of the same kind of picture are not.
// Offline: synthetic rectangles and pictures.
import assert from 'assert';
import { tileGroups } from '../public/js/images/extract.js';
import * as E from '../public/js/images/engine.js';

const ok = m => console.log(`  ok - ${m}`);

// ---------------------------------------------------------------- 1. strips
{
  // Fig. 9 of the manuscript: ten strips 477 x 55 pt stacked from y = 72 (points, y up as in PDF)
  const strips = Array.from({ length: 10 }, (_, i) => ({ x0: 78.1, x1: 555.2, y0: 720 - 55.4 * (i + 1), y1: 720 - 55.4 * i }));
  assert.deepStrictEqual(tileGroups(strips).map(g => g.length), [10]);
  ok('ten strips edge to edge are one figure');
  // in any order, with a second figure lower down the page (a gap of 20 pt) and an icon (null: rotated / not placed)
  const other = [{ x0: 78.1, x1: 555.2, y0: 100, y1: 150 }, { x0: 78.1, x1: 555.2, y0: 150, y1: 200 }];
  const g = tileGroups([strips[3], other[1], null, ...strips.slice(0, 3), other[0], ...strips.slice(4)]).map(x => x.length).sort((a, b) => a - b);
  assert.deepStrictEqual(g, [1, 2, 10]);
  ok('a figure separated by a gap stays a separate figure');
  // tiles side by side (same top and bottom, touching left / right)
  assert.deepStrictEqual(tileGroups([{ x0: 0, x1: 100, y0: 0, y1: 80 }, { x0: 100, x1: 220, y0: 0, y1: 80 }]).map(x => x.length), [2]);
  ok('tiles side by side are one figure');
  // touching but not sharing a whole edge: two figures of different widths one above the other
  assert.deepStrictEqual(tileGroups([{ x0: 78, x1: 555, y0: 300, y1: 400 }, { x0: 150, x1: 450, y0: 200, y1: 300 }]).map(x => x.length), [1, 1]);
  ok('pictures of different widths that touch are not joined');
}

// ---------------------------------------------------------------- 2. close-up of part of another panel
let seed = 5;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
// a "tissue" field, drawn once at 2400 px wide (1 field unit = 2400 px): soft stained blobs of many sizes (as in
// test/images-engine.mjs), so it has distinctive structure at every magnification
const FW = 2400, FH = 1800;
function field(n, fieldSeed) {
  seed = fieldSeed;
  const f = { w: FW, h: FH, data: new Float32Array(FW * FH * 3) };
  const ink = new Float32Array(FW * FH), pink = new Float32Array(FW * FH);
  for (let i = 0; i < n; i++) {
    const cx = rnd() * FW, cy = rnd() * FH, r = 5 + rnd() ** 2 * 45, a = 0.4 + rnd() * 0.8, dst = rnd() < 0.6 ? ink : pink;
    for (let y = Math.max(0, Math.floor(cy - 3 * r)); y < Math.min(FH, cy + 3 * r); y++) for (let x = Math.max(0, Math.floor(cx - 3 * r)); x < Math.min(FW, cx + 3 * r); x++) dst[y * FW + x] += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
  }
  for (let i = 0; i < FW * FH; i++) {
    const k = Math.min(1, ink[i]), p = Math.min(1, pink[i]);
    f.data[i * 3] = 235 - 40 * p - 150 * k; f.data[i * 3 + 1] = 238 - 130 * p - 190 * k; f.data[i * 3 + 2] = 232 - 60 * p - 90 * k;
  }
  return f;
}
// a w x h photograph of the area from (u0, v0) (field units), span field units wide, with its own camera noise
function shoot(f, u0, v0, span, w, h, noiseSeed) {
  seed = noiseSeed;
  const data = new Uint8ClampedArray(w * h * 4), k = span * FW / w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // the lens averages the field over the pixel's footprint (sampled 3 x 3)
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const fx = Math.min(FW - 1, Math.floor(u0 * FW + (x + (i + 0.5) / 3) * k)), fy = Math.min(FH - 1, Math.floor(v0 * FW + (y + (j + 0.5) / 3) * k)), o = (fy * FW + fx) * 3;
      r += f.data[o]; g += f.data[o + 1]; b += f.data[o + 2];
    }
    const n = (rnd() - 0.5) * 14, o = (y * w + x) * 4;
    data[o] = r / 9 + n; data[o + 1] = g / 9 + n; data[o + 2] = b / 9 + n; data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}
const panel = (img, id) => E.preparePanel(img, { x: 0, y: 0, w: img.width, h: img.height }, { id, label: id });
{
  const tissue = field(1500, 11), otherTissue = field(1500, 29);
  const wide = panel(shoot(tissue, 0, 0, 1, 420, 300, 1), 'M');
  // the lower right of M, 2.7 x closer: a separate photograph (its own noise), not a digital crop
  const close = panel(shoot(tissue, 0.5, 0.3, 1 / 2.7, 420, 300, 2), 'O');
  const unrelated = panel(shoot(otherTissue, 0, 0, 1, 420, 300, 3), 'N');
  const unrelatedClose = panel(shoot(otherTissue, 0.2, 0.2, 1 / 2.7, 420, 300, 4), 'K');
  const z = E.pairZoom(wide, close);
  assert.ok(z, 'the close-up is found');
  assert.strictEqual(z.wide.id, 'M');
  assert.ok(Math.abs(z.zoom - 2.7) < 0.3, `zoom about 2.7 (${z.zoom.toFixed(2)})`);
  // its place: the lower right of M (field u 0.5 - 0.87, v 0.3 - 0.56; M shows u 0 - 1, v 0 - 0.71), centre (0.685, 0.432)
  const cx = (z.region.x + z.region.w / 2) / wide.work.w, cy = (z.region.y + z.region.h / 2) / wide.work.h * (300 / 420);
  assert.ok(Math.abs(cx - 0.685) < 0.05 && Math.abs(cy - 0.432) < 0.05, `found where it was taken (${cx.toFixed(2)}, ${cy.toFixed(2)})`);
  ok(`a 2.7x close-up of part of another panel is found (picture ${z.c.toFixed(2)}, margin ${z.margin.toFixed(2)})`);
  // in the whole pipeline a close-up this clean (no extra detail) is already a crop; a second photograph through a
  // stronger objective (Fig. 9O) only passes the close-up check
  const f = E.findIssues([wide, close, unrelated]).filter(x => x.kind === 'partial' || x.kind === 'duplicate');
  assert.strictEqual(f.length, 1, 'one finding in the figure');
  assert.deepStrictEqual([f[0].a.panel, f[0].b.panel].sort(), ['M', 'O']);
  ok(`findIssues reports M and O only (${f[0].code || f[0].kind})`);
  for (const [a, b] of [[wide, unrelated], [wide, unrelatedClose], [unrelated, close]]) assert.strictEqual(E.pairZoom(a, b), null, `${a.id} / ${b.id} are different fields`);
  ok('different fields of the same kind of tissue are not reported');
}
console.log('images-strips-zoom: all passed');
