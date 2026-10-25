// test/forensics.mjs - alteration, AI-image and chart-duplication checks on synthetic images.
// Run: node test/forensics.mjs
import assert from 'assert';
import * as E from '../public/js/images/engine.js';
import * as F from '../public/js/images/forensics.js';

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());

/** Photo-like image: soft blobs + camera noise that grows with brightness (shot noise) */
function photo(w, h, { noise = 1, blobs = 60 } = {}) {
  const f = new Float32Array(w * h);
  for (let b = 0; b < blobs; b++) {
    const cx = rnd() * w, cy = rnd() * h, r = 6 + rnd() * 16, a = 40 + rnd() * 150;
    for (let y = Math.max(0, Math.floor(cy - 3 * r)); y < Math.min(h, cy + 3 * r); y++)
      for (let x = Math.max(0, Math.floor(cx - 3 * r)); x < Math.min(w, cx + 3 * r); x++) f[y * w + x] += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
  }
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const base = 40 + f[i] * 0.6;
    const v = base + gauss() * noise * (1 + base / 80);
    d[i * 4] = v * 0.9; d[i * 4 + 1] = v; d[i * 4 + 2] = v * 0.8; d[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data: d };
}

function analyse(img, id = 'p') {
  const gray = E.toGray(img);
  const box = { x: 0, y: 0, w: img.width, h: img.height };
  const p = E.preparePanel(img, box, { id, label: id, imageId: id }, gray);
  p.forensic = F.analysePanel(img, gray, box, p.type, p.blank);
  return p;
}

// ---- a) alteration: a smooth, noise-free patch pasted into a noisy photo
const base = photo(320, 320, { noise: 4 });
const edited = { width: 320, height: 320, data: base.data.slice() };
for (let y = 100; y < 200; y++) for (let x = 120; x < 240; x++) { const i = (y * 320 + x) * 4; const v = 130; edited.data[i] = v * 0.9; edited.data[i + 1] = v; edited.data[i + 2] = v * 0.8; }
const pe = analyse(edited);
console.log('edited photo:', pe.type, pe.forensic.alterations.map(a => `${a.code}:${a.level}`).join(' ') || 'none');
assert.ok(pe.forensic.alterations.some(a => a.code === 'smooth' || a.code === 'noise'), 'smooth patch found');
const pc = analyse(base);
console.log('clean photo:', pc.forensic.alterations.map(a => a.code).join(' ') || 'none', '| AI hints:', pc.forensic.aiHints.map(h => h.code).join(' ') || 'none');
assert.strictEqual(pc.forensic.alterations.filter(a => a.code === 'noise' || a.code === 'smooth').length, 0, 'clean photo: no noise findings');

// ---- a) blot with two lanes joined at a step in the background
const blot = { width: 300, height: 120, data: new Uint8ClampedArray(300 * 120 * 4) };
for (let y = 0; y < 120; y++) for (let x = 0; x < 300; x++) {
  let v = x < 150 ? 215 : 170;
  const lane = Math.floor((x % 75) / 75 * 1);
  const band = Math.exp(-((y - 60) ** 2) / 60) * 110 * (x % 75 > 15 && x % 75 < 60 ? 1 : 0);
  v = v - band + gauss() * 2;
  const i = (y * 300 + x) * 4; blot.data[i] = blot.data[i + 1] = blot.data[i + 2] = v; blot.data[i + 3] = 255;
}
const pb = analyse(blot);
console.log('blot:', pb.type, pb.forensic.alterations.map(a => `${a.code}`).join(' ') || 'none');
assert.ok(pb.forensic.alterations.some(a => a.code === 'splice-edge'), 'lane splice found');

// ---- c) AI: provenance markers in the file
const png = new TextEncoder().encode('\x89PNG\r\n\x1a\n....tEXtparameters\0a lab photo of cells Steps: 30, Sampler: Euler a, CFG scale: 7, Seed: 123');
const prov = F.scanProvenance(png);
console.log('provenance:', prov.map(p => p.marker).join(' | '));
assert.ok(prov.length >= 1, 'generation parameters found');
assert.strictEqual(F.scanProvenance(new TextEncoder().encode('\xff\xd8\xff\xe1Exif\0\0Canon EOS 5D')).length, 0, 'camera file: no marker');
const fakeAi = analyse(photo(256, 256, { noise: 0 }), 'ai1');
console.log('noise-free image hints:', fakeAi.forensic.aiHints.map(h => h.code).join(' ') || 'none');
assert.ok(fakeAi.forensic.aiHints.some(h => h.code === 'noise-free'), 'noise-free image hint');
const f1 = F.forensicFindings([fakeAi], { ai1: prov });
assert.ok(f1.some(f => f.kind === 'ai' && f.level === 'high'), 'provenance gives a strong AI finding');
const f2 = F.forensicFindings([analyse(photo(256, 256, { noise: 3 }), 'real')], {});
assert.ok(!f2.some(f => f.kind === 'ai'), 'noisy real-like photo: no AI finding');

// ---- d) charts
function chart(values, { colors = [[40, 90, 200]], scale = 1, bg = 255, order = 1, w = 360, h = 260 } = {}) {
  const d = new Uint8ClampedArray(w * h * 4).fill(bg);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  const set = (x, y, c) => { const i = (y * w + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; };
  for (let y = 20; y < 230; y++) set(40, y, [0, 0, 0]);               // y axis
  for (let x = 40; x < 330; x++) set(x, 230, [0, 0, 0]);              // x axis
  const vs = order > 0 ? values : [...values].reverse();
  vs.forEach((v, k) => { const x0 = 60 + k * (260 / vs.length), bw = 260 / vs.length - 14; const hgt = Math.round(v * scale); const c = colors[k % colors.length]; for (let x = x0; x < x0 + bw; x++) for (let y = 230 - hgt; y < 230; y++) set(Math.round(x), y, c); });
  return { width: w, height: h, data: d };
}
const vals = [60, 110, 85, 150, 120, 175];
const cA = analyse(chart(vals), 'c1'), cB = analyse(chart(vals, { colors: [[210, 50, 50]], scale: 1.1 }), 'c2'), cC = analyse(chart([50, 140, 70, 160, 40, 100]), 'c3');
console.log('chart types:', cA.type, cB.type, cC.type, '| series:', cA.forensic.series.map(s => `${s.kind}[${s.n}]`).join(','));
assert.strictEqual(cA.forensic.series[0]?.n, 6, 'six bars read');
const cf = F.forensicFindings([cA, cB, cC], {});
console.log('chart findings:', cf.map(f => `${f.a.panel}~${f.b.panel} ${f.level}`).join('; '));
assert.ok(cf.some(f => f.kind === 'chart' && [f.a.panel, f.b.panel].sort().join() === 'c1,c2'), 're-coloured, re-scaled chart found');
assert.ok(!cf.some(f => f.kind === 'chart' && [f.a.panel, f.b.panel].includes('c3')), 'different data: no chart finding');
const cR = analyse(chart(vals, { order: -1, colors: [[30, 160, 60]] }), 'c4');
assert.ok(F.forensicFindings([cA, cR], {}).some(f => f.kind === 'chart'), 'reversed order found');

console.log('forensics test: all assertions passed');
