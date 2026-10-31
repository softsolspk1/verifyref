// benchmark-images.mjs - measures the Module 5 image engine (public/js/images) on BioFors (Sabir et al., ICCV 2021, CC0):
// 47,805 real figure panels from 1,031 papers with expert (Bik) ground truth.
//   edd  : external duplication - pairs of images in the same paper that show the same content (308 papers, 1,043 pairs)
//   idd  : internal duplication - cloned regions inside one image (102 images)
//   cstd : cut / sharp transition - spliced or joined regions (181 images)
//   neg  : false alarms - unrelated panels from different papers pooled together
// Each BioFors image is already a single panel, so the panel-splitting step of the live tool is not exercised.
// Data: data/benchmark/biofors/{biofors_images,ann}. Usage: node scripts/benchmark-images.mjs [--task edd|idd|cstd|neg|all] [--docs N] [--neg N]
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as E from '../public/js/images/engine.js';
import * as F from '../public/js/images/forensics.js';

const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BF = path.join(ROOT, 'data', 'benchmark', 'biofors');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const TASK = arg('task', 'all'), DOCS = parseInt(arg('docs', '0'), 10), NEG = parseInt(arg('neg', '300'), 10);
const ann = n => JSON.parse(fs.readFileSync(path.join(BF, 'ann', n + '.json'), 'utf8'));
const edd = ann('edd_gt'), idd = ann('idd_gt'), cstd = ann('cstd_gt'), cls = ann('classification');

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const limit = o => (DOCS ? shuffle(Object.keys(o)).slice(0, DOCS) : Object.keys(o));

const cache = new Map();
function panel(doc, name, forensic = false) {
  const key = `${doc}/${name}/${forensic}`;
  if (cache.has(key)) return cache.get(key);
  let p = null;
  try {
    const png = PNG.sync.read(fs.readFileSync(path.join(BF, 'biofors_images', String(doc), name)));
    const img = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
    if (img.width >= 48 && img.height >= 48) {   // same minimum as the live worker
      const gray = E.toGray(img), box = { x: 0, y: 0, w: img.width, h: img.height };
      p = E.preparePanel(img, box, { id: name, label: name, imageId: name, index: 1 }, gray);
      if (forensic) p.forensic = F.analysePanel(img, gray, box, p.type, p.blank);
    }
  } catch (e) { p = null; }
  if (cache.size > 3000) cache.clear();
  cache.set(key, p);
  return p;
}
const pairKey = (a, b) => [a, b].sort().join(' ');
const inter = (a, b) => { const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; };
const gtBox = b => ({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] });
const hitsGt = (box, gts) => gts.some(g => { const G = gtBox(g); return inter(box, G) / Math.max(1, Math.min(box.w * box.h, G.w * G.h)) >= 0.25; });
const report = {};
const DUMP = process.argv.includes('--dump'), dump = [];

// ---------------------------------------------------------------- external duplication
if (TASK === 'all' || TASK === 'edd') {
  let gt = 0, testable = 0, found = 0, foundHigh = 0, extra = 0, extraHigh = 0, pairsTested = 0, t0 = Date.now(), docsDone = 0;
  const byKind = { duplicate: 0, partial: 0 };
  const extraExamples = [];
  for (const doc of limit(edd)) {
    const names = Object.keys(cls[doc] || {});
    const panels = names.map(n => panel(doc, n)).filter(Boolean);
    const ids = new Set(panels.map(p => p.id));
    const truth = new Set(Object.keys(edd[doc]).map(k => pairKey(...k.split(' '))));
    gt += truth.size;
    const live = [...truth].filter(k => k.split(' ').every(n => ids.has(n)));
    testable += live.length;
    pairsTested += panels.length * (panels.length - 1) / 2;
    const fnd = E.findIssues(panels).filter(f => f.kind === 'duplicate' || f.kind === 'partial');
    const got = new Map();
    for (const f of fnd) { const k = pairKey(f.a.panel, f.b.panel); if (!got.has(k) || f.level === 'high') got.set(k, f); }
    for (const [k, f] of got) {
      if (truth.has(k)) { found++; if (f.level === 'high') foundHigh++; byKind[f.kind]++; }
      else { extra++; if (f.level === 'high') { extraHigh++; if (extraExamples.length < 40) extraExamples.push(`${doc}: ${f.kind}/${f.level} ${f.a.panel} ~ ${f.b.panel} - ${f.description}`); } }
    }
    if (++docsDone % 20 === 0) process.stdout.write(`\redd: ${docsDone} papers, ${((Date.now() - t0) / 1000).toFixed(0)} s   `);
  }
  console.log();
  report.edd = { papers: docsDone, groundTruthPairs: gt, testablePairs: testable, found, foundHigh, extraReports: extra, extraHigh, pairsTested, byKind, extraExamples };
}

// ---------------------------------------------------------------- internal duplication and cut / sharp transition
function perImage(gtMap, task) {
  const pos = [], docs = limit(gtMap);
  for (const d of docs) for (const [n, boxes] of Object.entries(gtMap[d])) pos.push({ doc: d, name: n, boxes });
  const posSet = new Set(pos.map(p => `${p.doc}/${p.name}`));
  const allGt = new Set([...Object.entries(idd), ...Object.entries(cstd)].flatMap(([d, m]) => Object.keys(m).map(n => `${d}/${n}`)));
  const pool = [];
  for (const d of docs) for (const [n, c] of Object.entries(cls[d] || {})) {
    const k = `${d}/${n}`;
    if (posSet.has(k) || allGt.has(k)) continue;                  // never use any annotated image as a negative
    if (task === 'cstd' && c !== 'Blot/Gel') continue;
    pool.push({ doc: d, name: n });
  }
  return { pos, neg: shuffle(pool).slice(0, NEG) };
}
function runImages(gtMap, task, kind) {
  const { pos, neg } = perImage(gtMap, task);
  const score = (items, truthy) => {
    let tested = 0, flagged = 0, high = 0, located = 0;
    for (const it of items) {
      const p = panel(it.doc, it.name, true);
      if (!p) continue;
      tested++;
      const core = kind === 'clone' ? E.findIssues([p]) : [];
      const fnd = kind === 'clone' ? core.filter(f => f.kind === 'clone') : F.forensicFindings([p], {}, []).filter(f => f.kind === 'alteration');
      if (DUMP) dump.push({ task, truth: truthy, doc: it.doc, name: it.name, type: p.type, findings: fnd.map(f => ({ level: f.level, score: f.score, description: f.description, located: truthy ? (hitsGt(f.a.box, it.boxes) || hitsGt(f.b.box, it.boxes)) : false })) });
      if (fnd.length) {
        flagged++;
        if (fnd.some(f => f.level === 'high')) high++;
        if (truthy && fnd.some(f => hitsGt(f.a.box, it.boxes) || hitsGt(f.b.box, it.boxes))) located++;
      }
    }
    return { tested, flagged, high, located };
  };
  const t0 = Date.now();
  const P = score(pos, true), N = score(neg, false);
  console.log(`${task}: ${P.tested}+${N.tested} images in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  report[task] = { positives: P, negatives: N };
}
if (TASK === 'all' || TASK === 'idd') runImages(idd, 'idd', 'clone');
if (TASK === 'all' || TASK === 'cstd') runImages(cstd, 'cstd', 'alteration');

// ---------------------------------------------------------------- false alarms between unrelated papers
if (TASK === 'all' || TASK === 'neg') {
  const byCat = {};
  const docs = shuffle(Object.keys(cls));
  for (const d of docs) for (const [n, c] of Object.entries(cls[d])) (byCat[c] ||= []).push({ d, n });
  const out = {};
  for (const c of ['Blot/Gel', 'Microscopy']) {
    // one image per paper, so any match between two images is a match between different papers
    const seen = new Set(), pick = [];
    for (const x of shuffle(byCat[c])) { if (seen.has(x.d)) continue; seen.add(x.d); pick.push(x); if (pick.length >= 160) break; }
    const panels = pick.map(x => panel(x.d, x.n)).filter(Boolean);
    const fnd = E.findIssues(panels).filter(f => f.kind === 'duplicate' || f.kind === 'partial');
    out[c] = { panels: panels.length, pairs: panels.length * (panels.length - 1) / 2, reports: fnd.length, high: fnd.filter(f => f.level === 'high').length, examples: fnd.slice(0, 8).map(f => `${f.kind}/${f.level}: ${f.a.panel} ~ ${f.b.panel} - ${f.description}`) };
  }
  report.neg = out;
}

fs.writeFileSync(path.join(ROOT, 'data', 'benchmark', 'images-results.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
if (DUMP) fs.writeFileSync(path.join(ROOT, 'data', 'benchmark', 'images-dump.json'), JSON.stringify(dump));
