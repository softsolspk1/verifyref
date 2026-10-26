// scripts/benchmark-public-images.mjs - measures the Module 5 engine on forgeries generated from the pristine, openly
// licensed images of the RSIID source set (BBBC / other CC repositories), the same way RSIID and BINDER were built:
//   near-duplicate  (BINDER-style): rotation, mirror, rescale, contrast change, JPEG recompression, crop
//   copy-move       (RSIID-style):  a patch copied to another place inside the same image
//   negative:       two different images (must NOT match)
// Run: node scripts/benchmark-public-images.mjs [images=60]     (needs data/public-images/rsiid/artificial_forgery_src_data.zip)
// Output: data/public-images/benchmark_results.json (shown in Module 5 > Public reference data)
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import * as E from '../public/js/images/engine.js';
const require = createRequire(import.meta.url);
const JSZip = require('jszip'), { PNG } = require('pngjs'), jpeg = require('jpeg-js');
const cfg = require('../src/config');

const DIR = path.join(cfg.DATA_DIR, 'public-images');
const N = Number(process.argv[2]) || 60;
const SIZE = 256;
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const zip = await JSZip.loadAsync(fs.readFileSync(path.join(DIR, 'rsiid', 'artificial_forgery_src_data.zip')));
const names = Object.keys(zip.files).filter(n => /srcDataset\/\d+\.(png|jpe?g)$/i.test(n)).sort();
const decode = async n => { const b = await zip.files[n].async('nodebuffer'); const d = /png$/i.test(n) ? PNG.sync.read(b) : jpeg.decode(b, { useTArray: true }); return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data) }; };

/** Pristine test images: decoded, scaled to 256 px, textured enough to be a real figure panel */
const imgs = [];
const pool = names.slice().sort(() => rnd() - 0.5);
for (const n of pool) {
  if (imgs.length >= N) break;
  try {
    const raw = await decode(n);
    if (raw.width < 200 || raw.height < 200 || raw.width * raw.height > 12e6) continue;
    const s = SIZE / Math.min(raw.width, raw.height);
    const img = { width: Math.round(raw.width * s), height: Math.round(raw.height * s) };
    img.data = E.resizeRGBA(raw, img.width, img.height).data ?? E.resizeRGBA(raw, img.width, img.height);
    const g = E.toGray(img).g; let m = 0, v = 0;
    for (const x of g) m += x; m /= g.length; for (const x of g) v += (x - m) ** 2;
    if (Math.sqrt(v / g.length) < 12) continue; // blank / near-uniform
    imgs.push({ name: n.split('/').pop(), img });
  } catch { /* unreadable (TIFF etc.) */ }
}
console.log(`${imgs.length} pristine images`);

const crop = (img, x0, y0, w, h) => { const o = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) o.data[(y * w + x) * 4 + k] = img.data[((y0 + y) * img.width + x0 + x) * 4 + k]; return o; };
const map = (img, ow, oh, f) => { const o = { width: ow, height: oh, data: new Uint8ClampedArray(ow * oh * 4) }; for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) { const [sx, sy] = f(x, y); const xi = Math.min(img.width - 1, Math.max(0, Math.floor(sx))), yi = Math.min(img.height - 1, Math.max(0, Math.floor(sy))); for (let k = 0; k < 4; k++) o.data[(y * ow + x) * 4 + k] = img.data[(yi * img.width + xi) * 4 + k]; } return o; };
const tone = (img, a, b) => { const o = { ...img, data: new Uint8ClampedArray(img.data) }; for (let i = 0; i < o.data.length; i += 4) for (let k = 0; k < 3; k++) o.data[i + k] = a * o.data[i + k] + b; return o; };
const recompress = (img, q) => { const j = jpeg.decode(jpeg.encode({ width: img.width, height: img.height, data: Buffer.from(img.data) }, q).data, { useTArray: true }); return { width: j.width, height: j.height, data: new Uint8ClampedArray(j.data) }; };
const TRANSFORMS = {
  'rotation 90°': i => map(i, i.height, i.width, (x, y) => [y, i.height - 1 - x]),
  'rotation 180°': i => map(i, i.width, i.height, (x, y) => [i.width - 1 - x, i.height - 1 - y]),
  'mirror': i => map(i, i.width, i.height, (x, y) => [i.width - 1 - x, y]),
  'rescale 60%': i => map(i, Math.round(i.width * 0.6), Math.round(i.height * 0.6), (x, y) => [x / 0.6, y / 0.6]),
  'contrast / brightness': i => tone(i, 1.35, -30),
  'JPEG recompression q40': i => recompress(i, 40),
  'crop 55% (partial)': i => crop(i, Math.round(i.width * 0.2), Math.round(i.height * 0.2), Math.round(i.width * 0.55), Math.round(i.height * 0.55))
};
const panelOf = (img, id) => E.preparePanel(img, { x: 0, y: 0, w: img.width, h: img.height }, { id, label: id });
const cross = (fs, a, b) => fs.some(f => f.kind !== 'clone' && ((f.a.panel === a && f.b.panel === b) || (f.a.panel === b && f.b.panel === a)));

const results = { near_duplicate: {}, copy_move: { tested: 0, found: 0 }, negative: { tested: 0, falseAlarms: 0 } };
const t0 = Date.now();
for (const [name, fn] of Object.entries(TRANSFORMS)) {
  let found = 0, tested = 0;
  for (const { img } of imgs.slice(0, 25)) {
    const A = panelOf(img, 'a'), B = panelOf(fn(img), 'b');
    tested++; if (cross(E.findIssues([A, B]), 'a', 'b')) found++;
  }
  results.near_duplicate[name] = { tested, found, rate: Math.round((found / tested) * 100) };
  console.log(`${name.padEnd(26)} ${found}/${tested}`);
}
for (const { img } of imgs.slice(0, 25)) { // copy-move: 22 % square pasted 40 % away
  const s = Math.round(Math.min(img.width, img.height) * 0.22), o = { ...img, data: new Uint8ClampedArray(img.data) };
  // source patch = the most textured of a few candidate spots (an empty background patch is not a meaningful forgery)
  const gI = E.toGray(img).g, sdev = (x0, y0) => { let m = 0, v = 0; for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) m += gI[(y0 + y) * img.width + x0 + x]; m /= s * s; for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) v += (gI[(y0 + y) * img.width + x0 + x] - m) ** 2; return v; };
  let sx = 0, sy = 0, best = -1;
  for (const [fx, fy] of [[0.05, 0.05], [0.05, 0.3], [0.3, 0.05], [0.3, 0.3], [0.05, 0.6], [0.6, 0.05]]) { const x0 = Math.round(img.width * fx), y0 = Math.round(img.height * fy), v = sdev(x0, y0); if (v > best) { best = v; sx = x0; sy = y0; } }
  const dx = Math.round(img.width * 0.62), dy = Math.round(img.height * 0.62);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) for (let k = 0; k < 4; k++) o.data[((dy + y) * img.width + dx + x) * 4 + k] = img.data[((sy + y) * img.width + sx + x) * 4 + k];
  results.copy_move.tested++;
  if (E.findIssues([panelOf(o, 'c')]).some(f => f.kind === 'clone')) results.copy_move.found++;
}
for (let i = 0; i + 1 < imgs.length; i += 2) { // different images must not match
  const A = panelOf(imgs[i].img, 'a'), B = panelOf(imgs[i + 1].img, 'b');
  results.negative.tested++; if (cross(E.findIssues([A, B]), 'a', 'b')) results.negative.falseAlarms++;
}
results.copy_move.rate = Math.round((results.copy_move.found / results.copy_move.tested) * 100);
results.negative.rate = Math.round(((results.negative.tested - results.negative.falseAlarms) / results.negative.tested) * 100);
console.log(`copy-move ${results.copy_move.found}/${results.copy_move.tested}; negatives with false alarm ${results.negative.falseAlarms}/${results.negative.tested}; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
fs.writeFileSync(path.join(DIR, 'benchmark_results.json'), JSON.stringify({ runAt: new Date().toISOString(), images: imgs.length, source: 'RSIID source set (BBBC and other CC repositories), forgeries generated locally', ...results }, null, 1));
