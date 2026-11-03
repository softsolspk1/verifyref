// test/image-similarity.mjs - Module 5 match rule: two images (or areas) are reported as the same only when they are at
// least 80 % similar pixel by pixel AND share their fine noise. Images of the same kind - western blots with the same
// band layout, micrographs of the same stain - look alike but are different photographs and must not be reported.
// Also the earlier-manuscript comparison: a close fingerprint is not enough, the pictures must be 80 % similar.
// Run: node test/image-similarity.mjs
import assert from 'assert';
import { createRequire } from 'module';
import * as E from '../public/js/images/engine.js';
const require = createRequire(import.meta.url);
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const img = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = Math.max(0, Math.min(255, f(x, y))); const j = (y * w + x) * 4; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; } return { width: w, height: h, data: d }; };
// western blot: 6 lanes with bands at the same heights; the film grain differs per photograph
const blot = s => { seed = s; const n = new Float32Array(240 * 120).map(() => (rnd() - 0.5) * 30); const amp = [1, 0.8, 0.9, 0.7, 1, 0.85].map(a => a * (0.85 + rnd() * 0.3));
  return img(240, 120, (x, y) => { const lane = Math.floor(x / 40), lx = x % 40; let v = 225; if (lx > 6 && lx < 34) for (const by of [30, 62, 90]) v -= 150 * amp[lane] * Math.exp(-((y - by) ** 2) / 18); return v + n[y * 240 + x]; }); };
const tex = (s, W = 180) => { seed = s; const f = new Float32Array(W * W); for (let b = 0; b < 60; b++) { const cx = rnd() * W, cy = rnd() * W, r = 4 + rnd() * 14, a = 30 + rnd() * 60; for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) f[y * W + x] += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r)); } return img(W, W, (x, y) => 15 + f[y * W + x] + rnd() * 12); };
const scaled = (a, s) => img(Math.round(a.width * s), Math.round(a.height * s), (x, y) => a.data[(Math.min(a.height - 1, Math.floor(y / s)) * a.width + Math.min(a.width - 1, Math.floor(x / s))) * 4]);
const mirror = a => img(a.width, a.height, (x, y) => a.data[(y * a.width + (a.width - 1 - x)) * 4]);
const rot90 = a => img(a.height, a.width, (x, y) => a.data[((a.height - 1 - x) * a.width + y) * 4]);
const blend = (a, b, k) => ({ width: a.width, height: a.height, data: a.data.map((v, i) => (i % 4 === 3 ? 255 : v * k + b.data[i] * (1 - k))) });
const panel = (im, id) => E.preparePanel(im, { x: 0, y: 0, w: im.width, h: im.height }, { id, label: id });
const pair = (a, b) => E.findIssues([panel(a, 'A'), panel(b, 'B')]).filter(f => f.kind !== 'clone' && f.kind !== 'alteration');
const ok = m => console.log(`  ✓ ${m}`);

assert.strictEqual(E.MIN_SIMILARITY, 0.8, 'the rule is 80 %');

// ---- not reported: images of the same kind, partly similar images
for (let i = 0; i < 3; i++) assert.strictEqual(pair(blot(11 + i), blot(40 + i)).length, 0, `two different blots with the same band layout (${i + 1})`);
for (let i = 0; i < 3; i++) assert.strictEqual(pair(tex(3 + i), tex(60 + i)).length, 0, `two different micrographs (${i + 1})`);
assert.strictEqual(pair(tex(21), blend(tex(21), tex(91), 0.55)).length, 0, 'an image half blended with another (below 80 %)');
ok('same kind of image (blots with one band layout, micrographs) and partly similar images: not reported');

// ---- reported, with the similarity: copies in any orientation and size
const t = tex(9);
for (const [name, b] of [['copy', t], ['mirrored', mirror(t)], ['rotated 90°', rot90(t)], ['resized ×0.7', scaled(t, 0.7)], ['resized ×1.4', scaled(t, 1.4)], ['mirrored and resized', scaled(mirror(t), 0.75)]]) {
  const f = pair(t, b);
  assert.ok(f.length === 1 && f[0].kind === 'duplicate', `${name}: reported (${f.map(x => x.description).join('; ')})`);
  assert.ok(f[0].verification.picture >= 0.8 && f[0].verification.noise >= E.MIN_NOISE, `${name}: at least 80 % similar with the same noise`);
}
const sameBlot = blot(5);
assert.ok(pair(sameBlot, mirror(sameBlot)).some(f => f.kind === 'duplicate'), 'the same blot mirrored is reported');
ok('copies (mirrored, rotated, resized) reported with picture >= 80 % and the same noise');

// ---- the noise check itself: wide margin between copies and look-alikes
const A = panel(blot(1), 'A'), B = panel(blot(2), 'B'), C = panel(mirror(blot(1)), 'C');
const diff = E.nativeCheck(A, B, E.wholeMap(A, B, 0), { x: 0, y: 0, w: A.work.w, h: A.work.h });
const same = E.nativeCheck(A, C, E.wholeMap(A, C, 4), { x: 0, y: 0, w: A.work.w, h: A.work.h });
assert.ok(diff.picture >= 0.9 && diff.noise < 0.15, `look-alike blots: picture ${diff.picture.toFixed(2)} but noise ${diff.noise.toFixed(2)}`);
assert.ok(same.noise >= 0.6, `mirrored copy: noise ${same.noise.toFixed(2)}`);
ok(`noise: copy ${same.noise.toFixed(2)}, look-alike ${diff.noise.toFixed(2)} (picture ${diff.picture.toFixed(2)})`);

// ---- earlier PJPS manuscripts: a close fingerprint must also be 80 % similar pixel by pixel
const db = require('../src/db');
await db.init();
const jpeg = require('jpeg-js');
const thumbOf = im => `data:image/jpeg;base64,${jpeg.encode({ width: im.width, height: im.height, data: Buffer.from(im.data) }, 90).data.toString('base64')}`;
const IMG = require('../src/images');
const mine = tex(31), copy = mine, other = tex(77);
const fp = (im, label) => ({ h: E.hashPanel(im, { x: 0, y: 0, w: im.width, h: im.height }).hashes[0], label, thumb: thumbOf(im) });
const myPanel = { id: 'p1', label: 'Fig. 1A', hashes: E.hashPanel(mine, { x: 0, y: 0, w: mine.width, h: mine.height }).hashes, thumb: thumbOf(mine) };
// earlier manuscript 1: the same picture; earlier manuscript 2: a different picture stored under the same fingerprint
await db.query("INSERT INTO fingerprints(manuscript_code, kind, title, data) VALUES('PJPS-OLD-1', 'image', 'Same figure', $1)", [JSON.stringify({ hashes: [fp(copy, 'Fig. 2')] })]);
await db.query("INSERT INTO fingerprints(manuscript_code, kind, title, data) VALUES('PJPS-OLD-2', 'image', 'Look-alike', $1)", [JSON.stringify({ hashes: [{ ...fp(other, 'Fig. 3'), h: myPanel.hashes[0] }] })]);
const earlier = await IMG.compareWithEarlier([myPanel]);
assert.deepStrictEqual(earlier.map(e => e.manuscriptCode), ['PJPS-OLD-1'], 'only the same picture is an earlier-manuscript match');
assert.ok(earlier[0].similarity >= 80, `similarity reported: ${earlier[0].similarity} %`);
ok(`earlier manuscripts: same picture kept (${earlier[0].similarity} % similar), same fingerprint with a different picture rejected`);
console.log('image similarity test passed');
process.exit(0);
