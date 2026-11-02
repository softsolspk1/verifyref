// test/image-confidence.mjs - Module 5 confidence scores (ImageTwin bands), AI generator attribution and the TIFF
// reader (uncompressed, PackBits, LZW, Deflate; grey, RGB, 16-bit). Run: node test/image-confidence.mjs
import assert from 'assert';
import { createRequire } from 'module';
import { deflateSync } from 'zlib';
import { decodeTiff } from '../public/js/images/tiff.js';
const require = createRequire(import.meta.url);
const S = require('../src/imageScore.js');

// ---- confidence bands: strong findings High, "to check" Fair, a merge and its channels Low
const strongDup = S.findingConfidence({ kind: 'duplicate', level: 'high', verification: { picture: 0.98, noise: 0.9 }, score: 0.99, assessment: { falsePositiveRisk: 'LOW' } });
assert.ok(strongDup.confidence >= 90 && strongDup.band === 'high', `strong duplicate: ${strongDup.confidence}`);
const weakDup = S.findingConfidence({ kind: 'duplicate', level: 'medium', verification: { picture: 0.76, noise: 0.3 }, score: 0.9 });
assert.ok(weakDup.band === 'fair' && weakDup.confidence < 45, `weak duplicate: ${weakDup.confidence}`);
const channels = S.findingConfidence({ kind: 'duplicate', level: 'medium', description: 'The same image appears twice - shown in different colour channels: probably one microscopy field', score: 0.95 });
assert.strictEqual(channels.band, 'low', 'merge + single channels is Low (hidden by default)');
const clone = S.findingConfidence({ kind: 'clone', level: 'high', score: 30, assessment: { falsePositiveRisk: 'MEDIUM_HIGH' } });
assert.ok(clone.band === 'high' && clone.confidence < strongDup.confidence, 'clones count less than verified duplicates');
for (const f of [strongDup, weakDup, channels, clone]) assert.ok(f.confidence >= 0 && f.confidence <= 100);
const ref = S.matchConfidence({ distance: 1, correlation: 0.97, level: 'high' });
assert.ok(ref.band === 'high' && ref.confidence > 85, 'close reference match');
assert.strictEqual(S.matchConfidence({ distance: 6 }).band, 'fair', 'distant earlier-manuscript match is Fair');

// ---- AI generator attribution only from what the file says
assert.deepStrictEqual(S.aiAttribution({ kind: 'ai', code: 'provenance', details: ['Software / generator name of an AI image tool in the file (“Midjourney v6”)'] }).generators.map(g => g.name), ['Midjourney']);
assert.strictEqual(S.aiAttribution({ kind: 'ai', code: 'provenance', details: ['Content Credentials (C2PA) manifest present'] }).generators.length, 0);
assert.match(S.aiAttribution({ kind: 'ai', code: 'statistics', details: [] }).basis, /not identified/);
const r = { findings: [{ kind: 'ai', code: 'provenance', level: 'high', details: ['Stable-Diffusion style generation parameters (“Steps: 30, Sampler: Euler”)'] }], references: [{ distance: 0, correlation: 1, level: 'high' }], earlier: [] };
const counts = S.scoreResult(r);
assert.strictEqual(counts.high, 2);
assert.strictEqual(r.findings[0].attribution.generators[0].name, 'Stable Diffusion');
console.log('  ✓ confidence bands and AI attribution');

// ---- TIFF reader
function tiff({ w, h, spp = 1, bps = 8, comp = 1, strips, photo = spp >= 3 ? 2 : 1, rowsPerStrip = h }) {
  const tags = [[256, 3, [w]], [257, 3, [h]], [258, 3, Array(spp).fill(bps)], [259, 3, [comp]], [262, 3, [photo]], [273, 4, null], [277, 3, [spp]], [278, 3, [rowsPerStrip]], [279, 4, strips.map(s => s.length)]];
  const ifdSize = 2 + tags.length * 12 + 4;
  let extra = 8 + ifdSize;
  const dataStart = () => extra;
  const entries = tags.map(([tag, type, vals]) => ({ tag, type, vals }));
  // strip offsets after the IFD and any out-of-line values
  for (const e of entries) if (e.vals && e.vals.length * (e.type === 3 ? 2 : 4) > 4) { e.at = extra; extra += e.vals.length * (e.type === 3 ? 2 : 4); }
  const offsets = [];
  let p = dataStart();
  for (const s of strips) { offsets.push(p); p += s.length; }
  const offE = entries.find(e => e.tag === 273);
  offE.vals = offsets;
  if (offsets.length > 1) { offE.at = extra; extra += offsets.length * 4; p += offsets.length * 4; for (let i = 0; i < offsets.length; i++) offsets[i] += offsets.length * 4; }
  const buf = new Uint8Array(p);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach((e, i) => {
    const o = 10 + i * 12, sz = e.type === 3 ? 2 : 4;
    dv.setUint16(o, e.tag, true); dv.setUint16(o + 2, e.type, true); dv.setUint32(o + 4, e.vals.length, true);
    const put = (at, v) => (sz === 2 ? dv.setUint16(at, v, true) : dv.setUint32(at, v, true));
    if (e.at) { dv.setUint32(o + 8, e.at, true); e.vals.forEach((v, k) => put(e.at + k * sz, v)); } else e.vals.forEach((v, k) => put(o + 8 + k * sz, v));
  });
  strips.forEach((s, i) => buf.set(s, offsets[i]));
  return buf.buffer;
}
function lzwEncode(data) {
  const out = []; let acc = 0, nbits = 0, bits = 9;
  const emit = c => { acc = (acc << bits) | c; nbits += bits; while (nbits >= 8) { out.push((acc >> (nbits - 8)) & 255); nbits -= 8; } acc &= (1 << nbits) - 1; };
  let dict = new Map(), next = 258;
  emit(256);
  let w = String.fromCharCode(data[0]);
  for (let i = 1; i < data.length; i++) {
    const c = String.fromCharCode(data[i]), wc = w + c;
    if (dict.has(wc) || wc.length === 1) { w = wc; continue; }
    emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
    dict.set(wc, next++);
    if (next >= (1 << bits) && bits < 12) bits++;   // libtiff: wider codes once the next free code reaches 512
    w = c;
  }
  emit(w.length === 1 ? w.charCodeAt(0) : dict.get(w));
  emit(257);
  if (nbits) out.push((acc << (8 - nbits)) & 255);
  return new Uint8Array(out);
}
const grey = new Uint8Array(40 * 30).map((_, i) => (i * 7) % 256);
const rgb = new Uint8Array(40 * 30 * 3).map((_, i) => (i * 13) % 256);
const checkGrey = (img, label) => { assert.strictEqual(img.width, 40, label); assert.strictEqual(img.height, 30, label); for (let i = 0; i < grey.length; i++) assert.strictEqual(img.data[i * 4], grey[i], `${label} pixel ${i}`); };
checkGrey(await decodeTiff(tiff({ w: 40, h: 30, strips: [grey] })), 'uncompressed grey');
checkGrey(await decodeTiff(tiff({ w: 40, h: 30, comp: 5, strips: [lzwEncode(grey)] })), 'LZW grey');
checkGrey(await decodeTiff(tiff({ w: 40, h: 30, comp: 8, strips: [new Uint8Array(deflateSync(grey))] })), 'Deflate grey');
// PackBits: literal runs of up to 128 bytes
const pb = []; for (let i = 0; i < grey.length; i += 100) { const part = grey.subarray(i, i + 100); pb.push(part.length - 1, ...part); }
checkGrey(await decodeTiff(tiff({ w: 40, h: 30, comp: 32773, strips: [new Uint8Array(pb)] })), 'PackBits grey');
checkGrey(await decodeTiff(tiff({ w: 40, h: 30, rowsPerStrip: 10, strips: [grey.subarray(0, 400), grey.subarray(400, 800), grey.subarray(800)] })), 'three strips');
const c = await decodeTiff(tiff({ w: 40, h: 30, spp: 3, strips: [rgb] }));
for (let i = 0; i < 40 * 30; i++) for (let k = 0; k < 3; k++) assert.strictEqual(c.data[i * 4 + k], rgb[i * 3 + k], 'RGB');
const g16 = new Uint8Array(40 * 30 * 2); for (let i = 0; i < 40 * 30; i++) { const v = i * 50; g16[i * 2] = v & 255; g16[i * 2 + 1] = v >> 8; }
const d16 = await decodeTiff(tiff({ w: 40, h: 30, bps: 16, strips: [g16] }));
assert.ok(d16.data[0] === 0 && d16.data[(40 * 30 - 1) * 4] === 255, '16-bit scaled to the image range');
await assert.rejects(decodeTiff(new ArrayBuffer(16)), /Not a TIFF/);
console.log('  ✓ TIFF reader: uncompressed, LZW, Deflate, PackBits, strips, RGB, 16-bit');
console.log('image confidence test passed');
