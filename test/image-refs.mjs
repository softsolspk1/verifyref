// test/image-refs.mjs - Module 5 image reference databases, offline parts: PDF figure extraction (Flate with PNG
// predictors, JPEG, strips stored bottom-up), fingerprints, and the matcher (whole / rotated / mirrored / cropped copies,
// unrelated images not matched). No network or database writes.
import assert from 'assert';
import zlib from 'zlib';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js');
const F = require('../src/figureFiles.js');
const REFS = require('../src/imageRefs.js');
const E = await import('../public/js/images/engine.js');

// a textured test picture (smooth blobs + fine detail), deterministic
function picture(w, h, seed) {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const blobs = Array.from({ length: 14 }, () => [rnd() * w, rnd() * h, 10 + rnd() * 40, rnd() * 255, rnd() * 255, rnd() * 255]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 235, g = 225, b = 230;
    for (const [bx, by, br, cr, cg, cb] of blobs) { const q = Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * br * br)); r = r * (1 - q) + cr * q; g = g * (1 - q) + cg * q; b = b * (1 - q) + cb * q; }
    const n = (rnd() - 0.5) * 18, o = (y * w + x) * 4;
    d[o] = r + n; d[o + 1] = g + n; d[o + 2] = b + n; d[o + 3] = 255;
  }
  return { width: w, height: h, data: d };
}
const rgb = im => { const out = Buffer.alloc(im.width * im.height * 3); for (let i = 0; i < im.width * im.height; i++) { out[i * 3] = im.data[i * 4]; out[i * 3 + 1] = im.data[i * 4 + 1]; out[i * 3 + 2] = im.data[i * 4 + 2]; } return out; };
const rows = (im, y0, y1) => ({ width: im.width, height: y1 - y0, data: im.data.slice(y0 * im.width * 4, y1 * im.width * 4) });

// ---- PDF with three image XObjects: Flate + PNG Up predictor, JPEG, and a figure stored as 3 strips bottom-up
const A = picture(240, 180, 1), B = picture(200, 200, 2), C = picture(600, 180, 3);
const pngUp = im => { const raw = rgb(im), row = im.width * 3, out = Buffer.alloc((row + 1) * im.height); for (let y = 0; y < im.height; y++) { out[y * (row + 1)] = 2; for (let x = 0; x < row; x++) out[y * (row + 1) + 1 + x] = (raw[y * row + x] - (y ? raw[(y - 1) * row + x] : 0)) & 255; } return zlib.deflateSync(out); };
const objs = [];
const add = (dict, data) => objs.push({ dict, data });
add(`/Type /XObject /Subtype /Image /Width ${A.width} /Height ${A.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /Columns ${A.width} >>`, pngUp(A));
add(`/Type /XObject /Subtype /Image /Width ${B.width} /Height ${B.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`, jpeg.encode({ ...B, data: Buffer.from(B.data) }, 95).data);
for (const [y0, y1] of [[120, 180], [60, 120], [0, 60]]) { const s = rows(C, y0, y1); add(`/Type /XObject /Subtype /Image /Width ${s.width} /Height ${s.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${zlib.deflateSync(rgb(s)).length}`, zlib.deflateSync(rgb(s))); }
const parts = [Buffer.from('%PDF-1.7\n')];
objs.forEach((o, i) => parts.push(Buffer.from(`${i + 1} 0 obj\n<< ${o.dict} >>\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n')));
parts.push(Buffer.from('trailer\n<< >>\n%%EOF\n'));
const { images, skipped } = F.pdfImages(Buffer.concat(parts));
assert.deepStrictEqual(skipped, [], 'PDF images skipped');
assert.strictEqual(images.length, 3, `expected 3 figures (strips stitched), got ${images.length}`);
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.data.length; i += 4) s += Math.abs(a.data[i] - b.data[i]); return s / (a.data.length / 4); };
assert(diff(images[0], A) < 1, 'Flate + PNG predictor image decoded wrongly');
assert(diff(images[1], B) < 6, 'JPEG image decoded wrongly');
assert.strictEqual(images[2].height, 180, 'strips not stitched');
assert(diff(images[2], C) < 1, 'strips stitched in the wrong order');

// ---- fingerprints and matcher
const refs = await REFS.fingerprintFigures([{ ...A, label: 'Ref A' }, { ...B, label: 'Ref B' }]);
assert.strictEqual(refs.length, 2, 'reference panels');
assert(refs.every(r => r.hashes.length === 6), '6 hashes per reference panel');
const idx = { n: refs.length, ids: Int32Array.from(refs.map((_, i) => i + 1)), h: new Uint32Array(refs.length * 12) };
refs.forEach((r, i) => r.hashes.forEach((x, j) => { idx.h[i * 12 + j * 2] = parseInt(x.slice(0, 8), 16) >>> 0; idx.h[i * 12 + j * 2 + 1] = parseInt(x.slice(8), 16) >>> 0; }));
const rot90 = im => { const { width: w, height: h, data } = im, out = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (x * h + (h - 1 - y)) * 4); return { width: h, height: w, data: out }; };
const mirror = im => { const { width: w, height: h, data } = im, out = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (y * w + w - 1 - x) * 4); return { width: w, height: h, data: out }; };
const query = (id, im) => { const g = E.toGray(im), box = { x: 0, y: 0, w: im.width, h: im.height }; return { id, hashes: E.hashPanel(im, box, g).hashes, windows: E.windowHashes(g, box) }; };
const cropA = E.resizeRGBA(A, 180, 135, { x: 0, y: 0, w: 180, h: 135 });   // top-left 75%
const cases = [['same', A, 1, 'whole'], ['rotated + mirrored', mirror(rot90(B)), 2, 'whole'], ['cropped', cropA, 1, 'crop'], ['unrelated', picture(220, 190, 99), null, null]];
const found = REFS.candidates(idx, cases.map(([id, im]) => query(id, im)));
for (const [id, , ref, how] of cases) {
  const m = found.filter(c => c.panel === id).sort((a, b) => a.distance - b.distance)[0];
  if (ref === null) assert(!m, `${id}: unrelated image matched`);
  else { assert(m && m.ref === ref, `${id}: not matched to reference ${ref}`); assert.strictEqual(m.how, how, `${id}: matched as ${m.how}`); }
}
console.log('image reference databases test passed (PDF extraction, strip stitching, rotated / mirrored / cropped matching)');
process.exit(0);
