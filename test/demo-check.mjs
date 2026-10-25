// test/demo-check.mjs - runs the Module 5 engine over the demonstration figures (public/demo/figures) and checks that
// every planted problem is found. Run: node test/demo-check.mjs   (build the files first: npm run demo)
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';
import * as E from '../public/js/images/engine.js';
import * as F from '../public/js/images/forensics.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demo', 'figures');

/** Decoder for the unfiltered 8-bit RGB PNGs written by demo/build-demo.js */
function decode(buf) {
  let p = 8, w = 0, h = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = y * (w * 3 + 1) + 1 + x * 3, d = (y * w + x) * 4;
    out[d] = raw[s]; out[d + 1] = raw[s + 1]; out[d + 2] = raw[s + 2]; out[d + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
const panels = [], prov = {};
for (const f of files) {
  const bytes = fs.readFileSync(path.join(dir, f));
  const img = decode(bytes), id = f.slice(0, 7), label = f.replace(/_.*/, '').replace('Figure', 'Fig. ');
  const found = F.scanProvenance(new Uint8Array(bytes));
  if (found.length) prov[id] = found;
  const gray = E.toGray(img);
  E.splitPanels(img).forEach((b, i, all) => {
    if (b.w < 48 || b.h < 48) return;
    const p = E.preparePanel(img, b, { id: `${id}-p${i + 1}`, label: all.length > 1 ? `${label}, panel ${i + 1}` : label, imageId: id, index: i + 1 }, gray);
    p.forensic = F.analysePanel(img, gray, b, p.type, p.blank);
    panels.push(p);
  });
}
console.log('panels:', panels.map(p => `${p.label}[${p.type}]`).join(' | '));
const core = E.findIssues(panels);
const findings = [...core, ...F.forensicFindings(panels, prov, core)];
for (const f of findings) console.log(` ${f.level.padEnd(6)} ${F.categoryOf(f.kind).padEnd(12)} ${f.kind.padEnd(10)} ${f.a.panel}${f.a.panel !== f.b.panel ? ' ~ ' + f.b.panel : ''}: ${f.description}`);

const has = (cat, pred = () => true) => findings.some(f => F.categoryOf(f.kind) === cat && pred(f));
assert.ok(has('duplication', f => f.kind === 'duplicate' && f.a.panel.startsWith('Figure1') && f.b.panel.startsWith('Figure1')), 'Fig. 1: re-used (rotated) panel');
assert.ok(has('manipulation', f => f.kind === 'clone' && f.a.panel.startsWith('Figure1')), 'Fig. 1: cloned area');
assert.ok(has('manipulation', f => f.kind === 'alteration' && f.a.panel.startsWith('Figure2')), 'Fig. 2: joined blot lanes');
assert.ok(has('chart', f => f.a.panel.startsWith('Figure3') && f.b.panel.startsWith('Figure3')), 'Fig. 3: the same data plotted twice');
assert.ok(has('ai', f => f.a.panel.startsWith('Figure4') && f.level === 'high'), 'Fig. 4: AI-generation markers');
assert.ok(has('manipulation', f => f.kind === 'alteration' && f.a.panel.startsWith('Figure5')), 'Fig. 5: smoothed-over (edited) area');
console.log('demo check: every planted problem was found');
