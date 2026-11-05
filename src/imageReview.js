// imageReview.js - Module 5: review of the browser's image findings before they are saved, so a report does not show
// what is not a problem:
//  1. A figure placed twice in the document - in the text and again in a figure section after it - is one figure, not
//     a duplicated image. The copies are recognised as whole figures repeated pixel for pixel (or panel for panel), as an
//     ordered block after the in-text figures; original-vs-copy findings are dropped and each finding is reported once, on
//     the original. Two different figures sharing an image are still reported.
//  2. Cloned-area and noise-level findings mean something on photographs, gels and microscopy, not on drawn
//     illustrations (graphical abstracts, schematics: repeated boxes and arrows, flat colour fills); there they are dropped.
const sharp = require('sharp');

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

/**
 * findings, images, panels as sent by the browser (after sanitising). Returns { findings, notes, copies } - findings
 * without the figure-placement repeats and the photo-only findings on illustrations.
 */
async function reviewFindings({ images = [], panels = [], findings = [] }) {
  const { copies } = figureCopies(images, panels, findings);
  const notes = [];
  const label = id => images.find(im => im.id === id)?.label || id;
  let out = findings;
  if (copies.size) {
    const canon = id => copies.get(id) || id;
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
    notes.push(`${copies.size} figure(s) appear twice in the document - in the text and again in the figure section (${[...copies.entries()].map(([c, o]) => `${label(c).replace(/^Fig\.? ?\d+\s*—\s*/, '')} repeats ${label(o)}`).join('; ')}). They were analysed once; this is not image duplication.`);
  }
  // photo-only findings on drawn illustrations, and on a figure the AI-image detector reads as generated (at least half
  // of it): a synthetic picture has no camera noise, so its noise and repeated-texture findings are side effects of how
  // it was made, and the AI finding already reports the concern
  const panelById = new Map(panels.map(p => [p.id, p]));
  const synthetic = new Set(out.filter(f => f.kind === 'ai' && (Number(f.score) || 0) >= 50).map(f => imageOf(f.a?.panel)));
  const verdict = new Map();
  const drawn = async id => { if (!verdict.has(id)) verdict.set(id, await isIllustration(panelById.get(id)?.thumb)); return verdict.get(id); };
  const kept = [];
  let onDrawn = 0, onSynthetic = 0;
  for (const f of out) {
    if (PHOTO_ONLY.has(f.kind) && synthetic.has(imageOf(f.a?.panel))) { onSynthetic++; continue; }
    if (PHOTO_ONLY.has(f.kind) && (await drawn(f.a?.panel))) { onDrawn++; continue; }
    kept.push(f);
  }
  if (onDrawn) notes.push(`${onDrawn} cloned-area / noise finding(s) on drawn illustrations (graphical abstract, schematic) were not reported: repeated shapes and flat colour fills are normal in drawings.`);
  if (onSynthetic) notes.push(`${onSynthetic} cloned-area / noise finding(s) on figures the AI-image detector reads as generated are not reported separately: a generated picture has no camera noise, and the AI finding covers it.`);
  return { findings: kept, notes, copies: Object.fromEntries(copies) };
}

module.exports = { reviewFindings, figureCopies, isIllustration, SINGLE };
