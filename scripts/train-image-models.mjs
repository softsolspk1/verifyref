// train-image-models.mjs - trains the two Module 5 models that replace hand-set limits (public/js/images/models.js):
//   CLONE_MODEL  : which proposals of the cloned-area searches (keypoints, blocks, dense) are real copies
//   SPLICE_MODEL : which straight edges in a blot or gel are joins of lanes cut from different pictures
// Data: BioFors (Sabir et al., ICCV 2021, CC0) - expert (Bik) annotations of cloned areas (idd) and joins (cstd), and
// clean figures; plus synthetic examples made from clean training figures (an area copied elsewhere, a strip of lanes cut
// out, two blots joined; half of them recompressed as JPEG), used for training only.
// Measured by 5-fold cross-validation BY PAPER: every annotated image is scored by a model that never saw its paper, and
// compared with the hand-set rules on exactly the same images. The final models are trained on all the papers.
// Run with models.js reset to null (the baseline must be the hand-set rules):
//   node scripts/train-image-models.mjs extract [--neg 1500] [--syn 600]   (slow, resumable: data/benchmark/imgtrain.jsonl)
//   node scripts/train-image-models.mjs train                               (writes models.js + data/benchmark/imgtrain-report.json)
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as E from '../public/js/images/engine.js';
import * as F from '../public/js/images/forensics.js';
import { train, predict, compact } from '../public/js/images/gbdt.js';
import * as M from '../public/js/images/models.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BF = path.join(ROOT, 'data', 'benchmark', 'biofors');
const OUT = process.env.IMGTRAIN_OUT || path.join(ROOT, 'data', 'benchmark', 'imgtrain.jsonl');
const REPORT = path.join(ROOT, 'data', 'benchmark', 'imgtrain-report.json');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const MODE = process.argv[2] || 'extract';
const ann = n => JSON.parse(fs.readFileSync(path.join(BF, 'ann', n + '.json'), 'utf8'));
const idd = ann('idd_gt'), cstd = ann('cstd_gt'), cls = ann('classification');
const FOLDS = 5;
const fold = doc => { let h = 2166136261; for (const c of String(doc)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h % FOLDS; };
let seed = 13;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const inter = (a, b) => { const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; };
const gtBox = b => ({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] });
const hitsGt = (box, gts) => gts.some(g => { const G = gtBox(g); return inter(box, G) / Math.max(1, Math.min(box.w * box.h, G.w * G.h)) >= 0.25; });

if (MODE === 'extract') {
  if (M.CLONE_MODEL || M.SPLICE_MODEL) { console.error('Reset public/js/images/models.js to null first: the baseline must be the hand-set rules.'); process.exit(1); }
  const NEG = parseInt(arg('neg', '1500'), 10), SYN = parseInt(arg('syn', '600'), 10);
  const done = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) { try { done.add(JSON.parse(l).key); } catch (e) { /* torn last line */ } }
  const load = (doc, name) => {
    try {
      const png = PNG.sync.read(fs.readFileSync(path.join(BF, 'biofors_images', String(doc), name)));
      return { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
    } catch (e) { return null; }
  };
  const recompress = img => {
    const q = ri(70, 95);
    const d = jpeg.decode(jpeg.encode({ width: img.width, height: img.height, data: Buffer.from(img.data) }, q).data, { useTArray: true });
    return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data) };
  };
  const annotated = new Set([...Object.entries(idd), ...Object.entries(cstd)].flatMap(([d, m]) => Object.keys(m).map(n => `${d}/${n}`)));
  const pool = { all: [], blot: [] };
  for (const [d, m] of Object.entries(cls)) for (const [n, c] of Object.entries(m)) { if (annotated.has(`${d}/${n}`)) continue; pool.all.push({ doc: d, name: n }); if (c === 'Blot/Gel') pool.blot.push({ doc: d, name: n }); }
  const items = [];
  for (const [d, m] of Object.entries(idd)) for (const [n, b] of Object.entries(m)) items.push({ set: 'idd', doc: d, name: n, boxes: b });
  for (const [d, m] of Object.entries(cstd)) for (const [n, b] of Object.entries(m)) items.push({ set: 'cstd', doc: d, name: n, boxes: b });
  for (const x of shuffle(pool.all).slice(0, NEG)) items.push({ set: 'negC', ...x, boxes: [] });
  for (const x of shuffle(pool.blot).slice(0, NEG)) items.push({ set: 'negS', ...x, boxes: [] });
  for (const [i, x] of shuffle(pool.all).slice(0, SYN).entries()) items.push({ set: 'synC', ...x, syn: i, boxes: null });
  const blots = shuffle(pool.blot);
  for (let i = 0; i < SYN; i++) items.push({ set: 'synS', ...blots[i], other: blots[(i + SYN) % blots.length], syn: i, boxes: null });

  // synthetic examples (seeded by their index, so a resumed run makes the same ones)
  const synClone = (img, i) => {
    seed = 1000 + i;
    const { width: W, height: H } = img;
    const w = Math.max(16, Math.round(W * (0.1 + rnd() * 0.2))), h = Math.max(16, Math.round(H * (0.1 + rnd() * 0.2)));
    if (w * 2 + 4 > W && h * 2 + 4 > H) return null;
    let sx, sy, dx, dy, tries = 0;
    do { sx = ri(0, W - w); sy = ri(0, H - h); dx = ri(0, W - w); dy = ri(0, H - h); } while (++tries < 50 && (Math.abs(sx - dx) < w + 2 && Math.abs(sy - dy) < h + 2));
    if (tries >= 50) return null;
    const data = new Uint8ClampedArray(img.data), gain = rnd() < 0.3 ? 0.9 + rnd() * 0.2 : 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) data[((dy + y) * W + dx + x) * 4 + c] = img.data[((sy + y) * W + sx + x) * 4 + c] * gain;
    let out = { width: W, height: H, data };
    if (rnd() < 0.5) out = recompress(out);
    return { img: out, boxes: [[sx, sy, sx + w, sy + h], [dx, dy, dx + w, dy + h]] };
  };
  const synSplice = (img, other, i) => {
    seed = 5000 + i;
    const { width: W, height: H } = img;
    let out, boxes;
    if (rnd() < 0.6 || !other) {
      // a strip of lanes cut out and the two sides pushed together
      const c = ri(Math.round(W * 0.25), Math.round(W * 0.75)), m = ri(6, Math.max(8, Math.round(W * 0.15)));
      if (c + m >= W - 10) return null;
      const NW = W - m, data = new Uint8ClampedArray(NW * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < NW; x++) { const sxp = x < c ? x : x + m; for (let k = 0; k < 4; k++) data[(y * NW + x) * 4 + k] = img.data[(y * W + sxp) * 4 + k]; }
      out = { width: NW, height: H, data }; boxes = [[c - 4, 0, c + 4, H]];
    } else {
      // the left of one blot joined to the right of another, at the same height
      const B = E.resizeRGBA(other, Math.max(20, Math.round(other.width * H / other.height)), H);
      const c = ri(Math.round(W * 0.3), Math.round(W * 0.7)), take = Math.min(B.width, W - c), NW = c + take;
      const data = new Uint8ClampedArray(NW * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < NW; x++) for (let k = 0; k < 4; k++) data[(y * NW + x) * 4 + k] = x < c ? img.data[(y * W + x) * 4 + k] : B.data[(y * B.width + (B.width - take) + x - c) * 4 + k];
      out = { width: NW, height: H, data }; boxes = [[c - 4, 0, c + 4, H]];
    }
    if (rnd() < 0.5) out = recompress(out);
    return { img: out, boxes };
  };

  const LIMIT = parseInt(arg('limit', '0'), 10);
  if (LIMIT) { const by = {}; for (const it of items.splice(0)) if ((by[it.set] = (by[it.set] || 0) + 1) <= LIMIT) items.push(it); }
  const fd = fs.openSync(OUT, 'a');
  let n = 0;
  const t0 = Date.now();
  for (const it of items) {
    const key = `${it.set}:${it.doc}/${it.name}${it.syn !== undefined ? '#' + it.syn : ''}`;
    if (done.has(key)) continue;
    let img = load(it.doc, it.name), boxes = it.boxes;
    if (!img || img.width < 48 || img.height < 48) { fs.writeSync(fd, JSON.stringify({ key, skip: true }) + '\n'); continue; }
    if (it.set === 'synC') { const s = synClone(img, it.syn); if (!s) { fs.writeSync(fd, JSON.stringify({ key, skip: true }) + '\n'); continue; } ({ img, boxes } = s); }
    if (it.set === 'synS') { const s = synSplice(img, load(it.other.doc, it.other.name), it.syn); if (!s || s.img.width < 48) { fs.writeSync(fd, JSON.stringify({ key, skip: true }) + '\n'); continue; } ({ img, boxes } = s); }
    const gray = E.toGray(img), box = { x: 0, y: 0, w: img.width, h: img.height };
    const p = E.preparePanel(img, box, { id: it.name, label: it.name, imageId: it.name, index: 1 }, gray);
    const rec = { key, set: it.set, doc: it.doc, fold: fold(it.doc), type: p.type, blank: p.blank };
    const toImg = r => ({ x: Math.round(p.box.x + r.x / p.scale), y: Math.round(p.box.y + r.y / p.scale), w: Math.round(r.w / p.scale), h: Math.round(r.h / p.scale) });
    if (['idd', 'negC', 'synC'].includes(it.set)) {
      const base = E.findIssues([p]).filter(f => f.kind === 'clone');
      rec.base = { flagged: base.length > 0, high: base.some(f => f.level === 'high'), located: base.some(f => hitsGt(f.a.box, boxes) || hitsGt(f.b.box, boxes)) };
      rec.cands = p.blank || p.type === 'chart' ? [] : E.cloneCandidates(p).map(c => { const a = toImg(c.regionA), b = toImg(c.regionB); return { x: c.x, a, b, hit: hitsGt(a, boxes) || hitsGt(b, boxes) }; });
    } else {
      const fz = F.analysePanel(img, gray, box, p.type, p.blank);
      const alts = fz.alterations;
      rec.base = { flagged: alts.length > 0, high: alts.some(a => a.level === 'high'), located: alts.some(a => hitsGt(a.box, boxes)) };
      const other = alts.filter(a => a.code !== 'splice-edge');
      rec.other = { flagged: other.length > 0, located: other.some(a => hitsGt(a.box, boxes)) };
      rec.blotType = p.type === 'blot' || p.type === 'grayscale';
      rec.cands = p.blank ? [] : F.spliceCandidates(gray, box).map(c => ({ x: c.x, box: c.box, hit: hitsGt(c.box, boxes) }));
    }
    fs.writeSync(fd, JSON.stringify(rec) + '\n');
    if (++n % 25 === 0) console.log(`${n} images, ${((Date.now() - t0) / 60000).toFixed(1)} min (${it.set})`);
  }
  fs.closeSync(fd);
  console.log('extract done:', n, 'new images');
}

if (MODE === 'train') {
  const recs = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(r => r && !r.skip);
  const report = { date: new Date().toISOString().slice(0, 10), folds: FOLDS };
  const models = {};
  for (const [name, pos, neg, syn, usesOther] of [['clone', 'idd', 'negC', 'synC', false], ['splice', 'cstd', 'negS', 'synS', true]]) {
    const R = recs.filter(r => [pos, neg, syn].includes(r.set));
    const featNames = Object.keys(R.find(r => r.cands?.length).cands[0].x);
    const rows = r => r.cands.map(c => ({ v: featNames.map(f => (Number.isFinite(c.x[f]) ? c.x[f] : 0)), y: c.hit && r.set !== neg ? 1 : 0, c }));
    // IMG_TREES / IMG_DEPTH / IMG_RATE / IMG_MINLEAF / IMG_NOSYN: settings for experiments; the defaults are the chosen ones
    const env = (k, d) => (process.env[k] !== undefined ? +process.env[k] : d);
    // chosen 16 Nov 2026 (cross-validated): clones without the synthetic copies (they made the model accept recompressed
    // look-alikes of real textures), joins with shallow trees and the synthetic joins
    const D0 = name === 'clone' ? { trees: 250, depth: 3, nosyn: 1 } : { trees: 300, depth: 2, nosyn: 0 };
    const opts = { trees: env('IMG_TREES', D0.trees), depth: env('IMG_DEPTH', D0.depth), rate: env('IMG_RATE', 0.06), minLeaf: env('IMG_MINLEAF', 10) };
    const useSyn = !env('IMG_NOSYN', D0.nosyn);
    const fit = list => {
      const X = [], y = [];
      for (const r of list) { if (r.set === syn && !useSyn) continue; for (const q of (r.blank ? [] : rows(r))) { X.push(q.v); y.push(q.y); } }
      const npos = y.filter(Boolean).length;
      // a closer match (picture, noise, identical pixels, more agreeing points or blocks) never lowers the probability;
      // for joins a stronger, straighter, sharper edge never does
      const MONO = name === 'clone' ? ['lp', 'hp', 'blp', 'bhp', 'bhpFlat', 'bexact', 'inliers', 'blocks'] : ['gr', 'coh', 'agree', 'stepR'];
      const monotone = env('IMG_NOMONO', 0) ? [] : MONO.map(f => featNames.indexOf(f)).filter(i => i >= 0);
      return train(X, y, { ...opts, monotone, weightPos: Math.min(20, Math.max(1, (y.length - npos) / Math.max(1, npos) / 3)), features: featNames });
    };
    // out-of-fold probabilities for every real image (synthetic examples are only ever training data)
    const oof = new Map();
    for (let k = 0; k < FOLDS; k++) {
      const m = fit(R.filter(r => r.fold !== k));
      for (const r of R.filter(r => r.fold === k && r.set !== syn)) oof.set(r.key, rows(r).map(q => ({ p: predict(m, q.v), hit: q.y === 1, c: q.c })));
    }
    // image-level decision as the live tool makes it: the best proposal above the limit
    const evalAt = t => {
      let P = 0, Pf = 0, Pl = 0, N = 0, Nf = 0;
      for (const r of R) {
        if (r.set === syn) continue;
        const sc = oof.get(r.key) || [];
        const above = name === 'splice' && !r.blotType ? [] : sc.filter(s => s.p >= t);
        const top = name === 'splice' ? above.sort((a, b) => b.p - a.p).slice(0, 1) : above;
        const flagged = top.length > 0 || (usesOther && r.other.flagged);
        const located = top.some(s => s.hit) || (usesOther && r.other.located);
        if (r.set === pos) { P++; if (flagged) Pf++; if (located) Pl++; } else { N++; if (flagged) Nf++; }
      }
      return { t, P, Pf, Pl, N, Nf };
    };
    const baseline = (() => {
      let P = 0, Pf = 0, Pl = 0, Ph = 0, N = 0, Nf = 0, Nh = 0;
      for (const r of R) { if (r.set === syn) continue; if (r.set === pos) { P++; if (r.base.flagged) Pf++; if (r.base.located) Pl++; if (r.base.high) Ph++; } else { N++; if (r.base.flagged) Nf++; if (r.base.high) Nh++; } }
      return { P, Pf, Pl, Ph, N, Nf, Nh };
    })();
    // limits: "check" level at no more false reports on clean figures than the hand-set rules; "high" at 1% of clean figures
    const grid = []; for (let t = 0.05; t < 0.99; t += 0.01) grid.push(evalAt(t));
    const allowed = baseline.Nf / baseline.N;
    const med = grid.filter(g => g.Nf / g.N <= allowed).sort((a, b) => b.Pl - a.Pl || a.Nf - b.Nf)[0];
    const high = grid.filter(g => g.Nf / g.N <= 0.01).sort((a, b) => b.Pl - a.Pl)[0] || grid[grid.length - 1];
    // and a stricter operating point for comparison: half the clean-figure reports of the rules
    const strict = grid.filter(g => g.Nf / g.N <= allowed / 2).sort((a, b) => b.Pl - a.Pl)[0];
    const final = fit(R);
    models[name] = { ...compact(final), medium: Math.round(med.t * 100) / 100, high: Math.round(Math.max(high.t, med.t) * 100) / 100, trainedOn: { real: R.filter(r => r.set !== syn).length, synthetic: useSyn ? R.filter(r => r.set === syn).length : 0, date: report.date } };
    report[name] = { baseline, model: med, modelHigh: high, modelStrict: strict, features: featNames };
    console.log(name, 'rules :', `located ${baseline.Pl}/${baseline.P}, flagged ${baseline.Pf}/${baseline.P}, clean flagged ${baseline.Nf}/${baseline.N}`);
    console.log(name, 'model :', `located ${med.Pl}/${med.P}, flagged ${med.Pf}/${med.P}, clean flagged ${med.Nf}/${med.N} (limit ${med.t.toFixed(2)})`);
    if (strict) console.log(name, 'strict:', `located ${strict.Pl}/${strict.P}, clean flagged ${strict.Nf}/${strict.N} (limit ${strict.t.toFixed(2)})`);
    console.log(name, 'high  :', `located ${high.Pl}/${high.P}, clean flagged ${high.Nf}/${high.N} (limit ${high.t.toFixed(2)})`);
  }
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  if (!process.argv.includes('--dry')) {
    const js = `// images/models.js - trained models of Module 5, written by scripts/train-image-models.mjs (do not edit by hand).
// Gradient-boosted trees (images/gbdt.js) trained on BioFors expert annotations and synthetic edits, ${report.date}.
// medium / high: probability limits for a finding to check / a strong finding. Cross-validated results: data/benchmark/imgtrain-report.json
// CLONE_MODEL is not used (16 Nov 2026): cross-validated it found as many BioFors clones as the hand-set rules (39 of 78)
// with 120 instead of 132 clean figures flagged, but it scored an untouched texture above a perfect pasted copy in the
// synthetic tests (test/images-dense.mjs) - 78 annotated clones are too few to learn copies from look-alikes. Rules stay.
export const CLONE_MODEL = null;
export const SPLICE_MODEL = ${JSON.stringify(models.splice)};
`;
    fs.writeFileSync(path.join(ROOT, 'public', 'js', 'images', 'models.js'), js);
    console.log('models.js written', (js.length / 1024).toFixed(0), 'KB');
  }
}
