// imageReview.js - Module 5: review of the browser's image findings before they are saved, so a report does not show
// what is not a problem:
//  1. A figure placed twice in the document - in the text and again in a figure section after it - is one figure, not
//     a duplicated image. The copies are recognised as whole figures repeated pixel for pixel (or panel for panel), as an
//     ordered block after the in-text figures; original-vs-copy findings are dropped and each finding is reported once, on
//     the original. Two different figures sharing an image are still reported.
//  2. Cloned-area and noise-level findings mean something on photographs, gels and microscopy, not on drawn
//     illustrations (graphical abstracts, schematics: repeated boxes and arrows, flat colour fills); there they are dropped.
//  3. The same picture stored 2-4 times in the file (Word text boxes) is analysed once, like a figure-section repeat.
//  4. Bars of drawn bar charts cut out as panels are charts, not blots: no cloned-area, joined-lane or bar-vs-bar
//     duplicate findings on them, and none on a drawn chart whose "background step" is the edge of a solid shape.
const sharp = require('sharp');
const { findingConfidence } = require('./imageScore');

const pageOf = (id, order) => { const m = String(id).match(/^p(\d+)i(\d+)/); return m ? +m[1] + +m[2] / 100 : 1000 + order; };
const imageOf = panelId => String(panelId || '').split('-')[0];
const panelNo = panelId => (String(panelId || '').match(/-p(\d+)$/) || [])[1] || null;
const hamming = (a, b) => { let d = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { d += x & 1; x >>= 1; } } return d; };
const figNo = label => (String(label || '').match(/\bFig(?:ure)?\.?\s*(\d+)/i) || [])[1] || null;

/** Whole-figure copies: image -> earlier image it repeats (pixel-identical whole-figure finding, or every panel's hash) */
function figureCopies(images, panels, findings) {
  const order = new Map(images.map((im, i) => [im.id, pageOf(im.id, i)]));
  const byImage = new Map();
  for (const p of panels) { if (!byImage.has(p.imageId)) byImage.set(p.imageId, []); byImage.get(p.imageId).push(p); }
  const same = (a, b) => {
    const whole = findings.some(f => f.kind === 'duplicate' && [imageOf(f.a?.panel), imageOf(f.b?.panel)].sort().join() === [a, b].sort().join()
      && (f.score || 0) >= 0.98 && (!f.transform || (!f.transform.rotation && !f.transform.flip)) && (byImage.get(a) || []).length === 1);
    if (whole) return true;
    const pa = byImage.get(a) || [], pb = byImage.get(b) || [];
    return pa.length > 0 && pa.length === pb.length && pa.every((p, i) => p.hashes?.[0] && pb[i].hashes?.[0] && hamming(p.hashes[0], pb[i].hashes[0]) <= 4);
  };
  const copies = new Map();
  const ids = images.map(im => im.id).sort((x, y) => order.get(x) - order.get(y));
  for (let j = 0; j < ids.length; j++) for (let i = 0; i < j; i++) {
    if (copies.has(ids[i]) || copies.has(ids[j])) continue;
    if (same(ids[i], ids[j])) { copies.set(ids[j], ids[i]); break; }
  }
  if (!copies.size) return { copies, order };
  // a figure section: every copy comes after the last figure that is not a copy, in the same order as the originals;
  // two or more such copies, or a single copy carrying the same figure number as its original
  const originals = ids.filter(id => !copies.has(id));
  const lastOriginal = Math.max(...originals.map(id => order.get(id)));
  const list = [...copies.entries()].sort((x, y) => order.get(x[0]) - order.get(y[0]));
  const after = list.every(([c]) => order.get(c) > lastOriginal);
  const ordered = list.every(([, o], k) => !k || order.get(o) > order.get(list[k - 1][1]));
  const label = id => images.find(im => im.id === id)?.label;
  const sameNumber = list.length === 1 && figNo(label(list[0][0])) && figNo(label(list[0][0])) === figNo(label(list[0][1]));
  return { copies: after && ordered && (list.length >= 2 || sameNumber) ? copies : new Map(), order };
}

/**
 * The same picture stored more than once: Word keeps each text box twice (and older reports read every picture again
 * for each paragraph around it), so one figure arrived as 2-4 identical images - same size, same panels, same
 * fingerprints - and every copy was reported as a duplicate. image -> the first one it repeats. Three or more copies
 * are always a storage artefact; two copies are merged when they carry the same figure number (or none), while one
 * picture under two different figure numbers stays a finding.
 */
function storedCopies(images, panels) {
  const byImage = new Map();
  for (const p of panels) { if (!byImage.has(p.imageId)) byImage.set(p.imageId, []); byImage.get(p.imageId).push(p); }
  const sameBox = (a, b) => a && b && ['x', 'y', 'w', 'h'].every(k => Math.abs((a[k] || 0) - (b[k] || 0)) <= 2);
  const same = (A, B) => A.width === B.width && A.height === B.height && (A.width || 0) > 0 && (() => {
    const pa = byImage.get(A.id) || [], pb = byImage.get(B.id) || [];
    return pa.length > 0 && pa.length === pb.length && pa.every((p, i) => sameBox(p.box, pb[i].box) && p.hashes?.[0] && pb[i].hashes?.[0] && hamming(p.hashes[0], pb[i].hashes[0]) <= 2);
  })();
  const clusters = [];
  // Word only: in a PDF two identical pictures on different pages are a figure used twice, and stay a finding
  for (const im of images.filter(i => i.source === 'docx')) {
    const c = clusters.find(cl => same(cl[0], im));
    if (c) c.push(im); else clusters.push([im]);
  }
  const copies = new Map();
  for (const cl of clusters) {
    if (cl.length < 2) continue;
    const nums = new Set(cl.map(im => figNo(im.label)).filter(Boolean));
    if (cl.length === 2 && nums.size > 1) continue;
    for (const im of cl.slice(1)) copies.set(im.id, cl[0].id);
  }
  return copies;
}

/**
 * One bar of a drawn bar chart (Excel / GraphPad pasted as a picture) cut out as a panel, from its thumbnail: a tall
 * panel whose columns start at a straight top edge under white and stay one flat grey down to the bottom. Saved
 * reports typed such bars as blots and reported cloned areas and joined lanes on them. Calibrated on BioFors (6 Nov
 * 2026, 150 px JPEG thumbnails like the saved ones): 1 of 2,800 blots, micrographs, photographs and FACS plots; 52 of
 * the 56 bar panels of the report that showed the problem (the other 4 are a whole chart, see BIG_STEP).
 */
async function isDrawnBar(thumb) {
  if (!thumb || !/^data:image\//.test(thumb)) return false;
  try {
    const { data, info } = await sharp(Buffer.from(thumb.split(',')[1], 'base64')).resize(160, 160, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info, n = w * h;
    if (h < w * 1.1) return false;
    let white = 0, mid = 0, flat = 0;
    const bins = new Map();
    for (let i = 0; i < n; i++) if (data[i] >= 235) white++;
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const v = data[y * w + x];
      if (v >= 235 || v <= 25) continue;
      mid++;
      bins.set(v >> 3, (bins.get(v >> 3) || 0) + 1);
      if (Math.abs(v - data[y * w + x + 1]) <= 3 && Math.abs(v - data[(y + 1) * w + x]) <= 3) flat++;
    }
    if (white < n * 0.03 || !mid) return false;
    const [c1 = 0, c2 = 0] = [...bins.values()].sort((a, b) => b - a);
    let bars = 0;
    for (let x = 0; x < w; x++) {
      // top edge: the first run of 7 similar grey pixels (a thin grid line or error bar above it is skipped)
      let y0 = -1;
      for (let y = 0; y + 6 < h && y0 < 0; y++) {
        const v = data[y * w + x];
        if (v >= 235 || v <= 25) continue;
        let run = true;
        for (let k = 1; k <= 6 && run; k++) { const u = data[(y + k) * w + x]; if (u >= 235 || Math.abs(u - v) > 8) run = false; }
        if (run) y0 = y;
      }
      if (y0 < 2 || h - y0 < h * 0.25) continue;
      const vals = [];
      for (let y = y0 + 2; y < h - 1; y++) vals.push(data[y * w + x]);
      if (!vals.length) continue;
      vals.sort((a, b) => a - b);
      const med = vals[vals.length >> 1];
      if (med >= 235 || med <= 25) continue;
      if (vals.filter(v => Math.abs(v - med) <= 8).length >= vals.length * 0.9) bars++;
    }
    return bars >= w * 0.3 && flat >= mid * 0.6 && c1 + c2 >= mid * 0.55;
  } catch { return false; }
}

// A "background step" this large is the edge of a solid drawn shape against white, not a change of background level
// between joined blot lanes (joined lanes in BioFors: 12 grey levels and up; clean blots: 11 or less)
const BIG_STEP = 100;
const stepOf = f => f.kind === 'alteration' && /step in the background level/i.test(f.description || '') ? Number((String(f.description).match(/\((\d+) grey levels\)/) || [])[1]) || 0 : 0;

/** A drawn illustration (flat colour fills in several distinct colours), from the panel thumbnail */
async function isIllustration(thumb) {
  if (!thumb || !/^data:image\//.test(thumb)) return false;
  try {
    const { data, info } = await sharp(Buffer.from(thumb.split(',')[1], 'base64')).resize(160, 160, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    let flat = 0, total = 0;
    const colours = new Map();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 3;
      let dev = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const j = ((y + dy) * w + x + dx) * 3; dev += Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]); }
      total++;
      if (dev > 24) continue;
      flat++;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx - mn < 40 || mx < 60) continue; // white, grey, black: background of any figure
      const key = `${r >> 5},${g >> 5},${b >> 5}`;
      colours.set(key, (colours.get(key) || 0) + 1);
    }
    const distinct = [...colours.values()].filter(n => n >= total * 0.012).length;
    return flat / total >= 0.5 && distinct >= 3;
  } catch { return false; }
}

const SINGLE = new Set(['clone', 'alteration', 'ai', 'splice', 'manipulation']);
const PHOTO_ONLY = new Set(['clone', 'alteration']);
// PJPS: cloned areas inside one panel and possible alterations are reported only from 75 % confidence (src/imageScore.js)
const MIN_CONFIDENCE = { clone: 75, alteration: 75 };

/**
 * findings, images, panels as sent by the browser (after sanitising). Returns { findings, notes, copies } - findings
 * without the figure-placement repeats and the photo-only findings on illustrations.
 */
async function reviewFindings({ images = [], panels = [], findings = [] }) {
  const { copies } = figureCopies(images, panels, findings);
  const notes = [];
  const label = id => images.find(im => im.id === id)?.label || id;
  const stored = storedCopies(images, panels);
  for (const [c, o] of stored) if (!copies.has(c)) copies.set(c, o);
  const storedOnly = [...stored.keys()].filter(c => copies.get(c) === stored.get(c));
  let out = findings;
  if (copies.size) {
    const canon = id => { let x = id; for (let k = 0; k < 10 && copies.has(x); k++) x = copies.get(x); return x; };
    const seen = new Set();
    out = [];
    for (const f of findings) {
      const ia = imageOf(f.a?.panel), ib = imageOf(f.b?.panel);
      // the figure compared with its own copy in the figure section
      if (canon(ia) === canon(ib) && ia !== ib) continue;
      // the same finding again on the copy: keep the one on the original
      const key = [f.kind, canon(ia), panelNo(f.a?.panel), canon(ib), panelNo(f.b?.panel), Math.round((f.a?.box?.x || 0) / 8), Math.round((f.a?.box?.y || 0) / 8)].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    // a finding that only exists on the copy is shown on the copy (nothing is lost)
    if (storedOnly.length) {
      const groups = new Map();
      for (const c of storedOnly) { const o = canon(c); groups.set(o, (groups.get(o) || 0) + 1); }
      notes.push(`${storedOnly.length} picture(s) are stored more than once in the file (${[...groups.entries()].map(([o, n]) => `${label(o)}: ${n + 1} identical copies`).join('; ')}) - this is how Word keeps figures placed in text boxes. Each picture was analysed once; this is not image duplication.`);
    }
    const placed = [...copies.entries()].filter(([c]) => !storedOnly.includes(c));
    if (placed.length) notes.push(`${placed.length} figure(s) appear twice in the document - in the text and again in the figure section (${placed.map(([c, o]) => `${label(c).replace(/^Fig\.? ?\d+\s*—\s*/, '')} repeats ${label(o)}`).join('; ')}). They were analysed once; this is not image duplication.`);
  }
  // photo-only findings on drawn illustrations, and on a figure the AI-image detector reads as generated (at least half
  // of it): a synthetic picture has no camera noise, so its noise and repeated-texture findings are side effects of how
  // it was made, and the AI finding already reports the concern
  const panelById = new Map(panels.map(p => [p.id, p]));
  const synthetic = new Set(out.filter(f => f.kind === 'ai' && (Number(f.score) || 0) >= 50).map(f => imageOf(f.a?.panel)));
  const verdict = new Map();
  const drawn = async id => { if (!verdict.has(id)) verdict.set(id, await isIllustration(panelById.get(id)?.thumb)); return verdict.get(id); };
  // bars of drawn bar charts typed as blots (each bar cut out as a panel): no photo findings, and one plain bar matching
  // another plain bar is not a duplicated image
  const barVerdict = new Map();
  const bar = async id => { const p = panelById.get(id); if (!p || p.type === 'histology' || p.type === 'fluorescence') return false; if (!barVerdict.has(id)) barVerdict.set(id, await isDrawnBar(p.thumb)); return barVerdict.get(id); };
  // every blot / grey / photo panel is checked, not only those with findings: matches with published figures on these
  // panels are dropped from the report too (src/images.js)
  for (const p of panels) if (['blot', 'grayscale', 'photo'].includes(p.type) && !p.blank) await bar(p.id);
  const bigStep = new Set(out.filter(f => stepOf(f) >= BIG_STEP).map(f => f.a?.panel));
  const kept = [];
  let onDrawn = 0, onSynthetic = 0, onBars = 0, onShapes = 0;
  for (const f of out) {
    if (MIN_CONFIDENCE[f.kind] && findingConfidence(f).confidence < MIN_CONFIDENCE[f.kind]) continue;
    if (PHOTO_ONLY.has(f.kind) && synthetic.has(imageOf(f.a?.panel))) { onSynthetic++; continue; }
    if (PHOTO_ONLY.has(f.kind) && (await bar(f.a?.panel))) { onBars++; continue; }
    if ((f.kind === 'duplicate' || f.kind === 'partial') && (await bar(f.a?.panel)) && (await bar(f.b?.panel))) { onBars++; continue; }
    // a huge background step marks a drawn shape: that panel's step and histogram findings go together
    if (f.kind === 'alteration' && bigStep.has(f.a?.panel) && (stepOf(f) >= BIG_STEP || /histogram/i.test(f.description || ''))) { onShapes++; continue; }
    if (PHOTO_ONLY.has(f.kind) && (await drawn(f.a?.panel))) { onDrawn++; continue; }
    kept.push(f);
  }
  if (onBars) notes.push(`${onBars} finding(s) on bars of drawn bar charts were not reported: a flat drawn bar is not a blot, and plain bars of the same grey look alike.`);
  if (onShapes) notes.push(`${onShapes} "joined lanes" / histogram finding(s) on drawn charts were not reported: a step of ${BIG_STEP} or more grey levels is the edge of a solid drawn shape, not two blots joined.`);
  if (onDrawn) notes.push(`${onDrawn} cloned-area / noise finding(s) on drawn illustrations (graphical abstract, schematic) were not reported: repeated shapes and flat colour fills are normal in drawings.`);
  if (onSynthetic) notes.push(`${onSynthetic} cloned-area / noise finding(s) on figures the AI-image detector reads as generated are not reported separately: a generated picture has no camera noise, and the AI finding covers it.`);
  const bars = [...barVerdict.entries()].filter(([, v]) => v).map(([id]) => id);
  return { findings: kept, notes, copies: Object.fromEntries(copies), stored: storedOnly, bars };
}

module.exports = { reviewFindings, figureCopies, storedCopies, isIllustration, isDrawnBar, SINGLE };
