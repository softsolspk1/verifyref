// images-report-e2e.mjs - Module 5 end to end on real data: a figure of a paper retracted for image problems (taken from
// the PJPS reference database) is put into a test "manuscript" twice (once mirrored) next to an unrelated figure. The
// browser analysis (same steps as public/js/images/worker.js), the server's database search (saveImageCheck, not saved)
// and the Word / PDF report must find the internal duplicate AND the retracted source, and nothing for the unrelated figure.
// Needs the database and R2 (.env). Writes the reports to OUT (default: the system temp folder).
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';
import * as E from '../public/js/images/engine.js';
import * as F from '../public/js/images/forensics.js';
import { laneFindings } from '../public/js/images/lanes.js';

const require = createRequire(import.meta.url);
require('../src/config');
const db = require('../src/db');
const REFS = require('../src/imageRefs');
const IMG = require('../src/images');
const W = require('../src/docx');
const jpeg = require('jpeg-js');
const OUT = process.env.OUT || os.tmpdir();
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('  ✓', m); };

const mirror = img => {
  const out = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) for (let k = 0; k < 4; k++) out[(y * img.width + x) * 4 + k] = img.data[(y * img.width + img.width - 1 - x) * 4 + k];
  return { width: img.width, height: img.height, data: out };
};
const crop = (img, b) => {
  const out = new Uint8ClampedArray(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) for (let k = 0; k < 4; k++) out[(y * b.w + x) * 4 + k] = img.data[((y + b.y) * img.width + x + b.x) * 4 + k];
  return { width: b.w, height: b.h, data: out };
};
const dataUrl = img => `data:image/jpeg;base64,${Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: Buffer.from(img.data) }, 80).data).toString('base64')}`;

async function refImage(source) {
  const rows = await db.all(`SELECT r.id, r.thumb_key, r.w, r.h, d.title FROM image_refs r JOIN image_ref_docs d ON d.id = r.doc_id
    WHERE r.source = $1 AND r.thumb_key IS NOT NULL AND r.type IN ('blot', 'photo', 'histology', 'fluorescence', 'grayscale') AND r.w >= 120 AND r.h >= 120 ORDER BY r.id LIMIT 40`, [source]);
  for (const r of rows) {
    const buf = await REFS.refThumb(r.thumb_key).catch(() => null);
    if (!buf) continue;
    const d = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    if (d.width >= 100 && d.height >= 100) return { ...r, img: { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data) } };
  }
  return null;
}

(async () => {
  await db.init();
  const retracted = await refImage('retracted');
  const other = await refImage('rsiid') || await refImage('pmc');
  ok(retracted && other, `reference figures loaded (retracted-paper figure #${retracted?.id}, unrelated figure #${other?.id})`);

  // the "manuscript": Fig. 1 = the retracted paper's figure, Fig. 2 = the same figure mirrored, Fig. 3 = unrelated
  const images = [{ id: 'i1', label: 'Figure 1', img: retracted.img }, { id: 'i2', label: 'Figure 2', img: mirror(retracted.img) }, { id: 'i3', label: 'Figure 3', img: other.img }];
  const panels = [];
  for (const im of images) {
    const gray = E.toGray(im.img);
    E.splitPanels(im.img).forEach((b, i, all) => {
      if (b.w < 48 || b.h < 48) return;
      const p = E.preparePanel(im.img, b, { id: `${im.id}-p${i + 1}`, label: all.length > 1 ? `${im.label}, panel ${i + 1}` : im.label, imageId: im.id, index: i + 1 }, gray);
      p.forensic = F.analysePanel(im.img, gray, b, p.type, p.blank);
      p.windows = p.blank ? [] : E.windowHashes(gray, b);
      panels.push(p);
    });
  }
  const core = E.findIssues(panels);
  const lanes = laneFindings(panels).filter(l => !core.some(c => c.a.panel === l.a.panel && c.b.panel === l.b.panel && c.kind === l.kind));
  const findings = [...core, ...lanes, ...F.forensicFindings(panels, {}, [...core, ...lanes])].map((f, i) => ({ ...f, id: `f${i + 1}`, category: F.categoryOf(f.kind) }));
  const imgOf = id => images.find(im => im.id === panels.find(p => p.id === id)?.imageId).img;
  const payload = {
    meta: { title: 'Module 5 end-to-end test', manuscriptCode: 'E2E-TEST', filename: 'e2e-test.docx' },
    panels: panels.map(p => ({ id: p.id, label: p.label, imageId: p.imageId, box: p.box, type: p.type, blank: p.blank, hashes: p.hashes.map(E.hashHex), windows: p.windows, thumb: dataUrl(crop(imgOf(p.id), p.box)), w: p.box.w, h: p.box.h })),
    findings: findings.map(f => ({ ...f, a: { ...f.a, label: panels.find(p => p.id === f.a.panel)?.label }, b: { ...f.b, label: panels.find(p => p.id === f.b.panel)?.label },
      thumbA: dataUrl(crop(imgOf(f.a.panel), f.a.box)), thumbAW: f.a.box.w, thumbAH: f.a.box.h, thumbB: dataUrl(crop(imgOf(f.b.panel), f.b.box)), thumbBW: f.b.box.w, thumbBH: f.b.box.h })),
    charts: F.seriesFingerprints(panels), images: images.map(im => ({ id: im.id, label: im.label, width: im.img.width, height: im.img.height })), summary: { images: images.length }
  };

  const { result } = await IMG.saveImageCheck(null, payload, { save: false });
  const dup = result.findings.find(f => f.kind === 'duplicate' && f.a.label.startsWith('Figure 1') && f.b.label.startsWith('Figure 2'));
  ok(dup, `internal duplicate found: ${dup?.description}`);
  ok(dup.level === 'high', 'the mirrored copy is a strong finding');
  ok(!result.findings.some(f => [f.a.label, f.b.label].some(l => l.startsWith('Figure 3')) && f.kind !== 'ai' && f.category === 'duplication'), 'the unrelated figure is not reported as a duplicate');
  const src = (result.references || []).find(m => m.refId === retracted.id || m.sourceName?.match(/retract/i));
  ok(src, `retracted source found in the reference database: ${src?.sourceName} — ${src?.title?.slice(0, 80)} (${src?.level})`);
  ok(result.summary.level === 'HIGH', `image risk ${result.summary.level}`);

  const withThumbs = await IMG.withExportThumbs({ ...result, createdAt: new Date().toISOString() }, null);
  ok(withThumbs.references.some(m => m.refThumb), 'reference figure thumbnails loaded for the report');
  const blocks = W.imagesBlocks(withThumbs);
  ok(blocks.some(b => b.table?.headers?.includes('Measured agreement')), 'report has the findings overview table');
  ok(blocks.filter(b => b.images).length >= 2, 'report shows the image pairs (findings and database matches)');
  const docx = await W.buildDocx(blocks), pdf = await require('../src/pdf').buildPdf(blocks);
  fs.writeFileSync(path.join(OUT, 'module5-e2e-report.docx'), docx);
  fs.writeFileSync(path.join(OUT, 'module5-e2e-report.pdf'), pdf);
  ok(docx.length > 20000 && pdf.length > 20000, `Word (${Math.round(docx.length / 1024)} KB) and PDF (${Math.round(pdf.length / 1024)} KB) reports written to ${OUT}`);
  console.log('Module 5 end-to-end test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
