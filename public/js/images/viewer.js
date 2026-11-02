// images/viewer.js - forensic viewer for the editor (Module 5.4). Filters: contrast boost, error level analysis, noise
// map, edges, false colour, invert, solarize, background; brightness and contrast sliders. With a second image (B,
// auto-aligned to A using the detected rotation / mirroring / scale): side by side (optionally with the matched
// keypoints joined by lines), overlay with an opacity slider, swipe slider, difference image, heatmap and flicker. Zoom,
// magnifier, and "Save view" (PNG) for the editorial file. Filters are aids for looking closer, never proof.
import { modal, esc, $ } from '../core.js';
import { toGray, resizeGray, orb, matchFeatures, ransac } from './engine.js';

async function loadSource(src) {
  if (src instanceof HTMLCanvasElement) return src;
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

function crop(src, box) {
  const b = box ? { x: Math.max(0, box.x), y: Math.max(0, box.y), w: Math.min(box.w, src.width - Math.max(0, box.x)), h: Math.min(box.h, src.height - Math.max(0, box.y)) } : { x: 0, y: 0, w: src.width, h: src.height };
  const c = document.createElement('canvas');
  c.width = Math.max(1, b.w); c.height = Math.max(1, b.h);
  c.getContext('2d').drawImage(src, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return c;
}

/** B drawn on A's canvas size, rotated by `rot` (radians) and optionally mirrored before or after the rotation */
function drawAligned(w, h, cb, rot, flip, flipFirst) {
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(w / 2, h / 2);
  if (flip && !flipFirst) ctx.scale(-1, 1);
  ctx.rotate(rot);
  if (flip && flipFirst) ctx.scale(-1, 1);
  const swap = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1;
  const dw = swap ? h : w, dh = swap ? w : h;
  ctx.drawImage(cb, -dw / 2, -dh / 2, dw, dh);
  return out;
}

const thumbGray = (c, n = 48) => {
  const t = document.createElement('canvas');
  t.width = t.height = n;
  const x = t.getContext('2d', { willReadFrequently: true });
  x.drawImage(c, 0, 0, n, n);
  const d = x.getImageData(0, 0, n, n).data, g = new Float32Array(n * n);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return g;
};

/**
 * B rotated / mirrored back to A's orientation and scaled to A's size. The detectors do not all report the rotation
 * with the same sign or mirror order, so every reading of the transform is tried and the one closest to A is kept.
 */
function alignTo(baseA, cb, transform) {
  const rot = transform?.rotation || 0, flip = !!transform?.flip;
  const options = [];
  for (const r of rot ? [rot, -rot] : [0]) for (const ff of flip ? [true, false] : [false]) options.push([r, ff]);
  if (options.length === 1) return drawAligned(baseA.width, baseA.height, cb, rot, flip, false);
  const ga = thumbGray(baseA);
  let best = null;
  for (const [r, ff] of options) {
    const c = drawAligned(baseA.width, baseA.height, cb, r, flip, ff), gb = thumbGray(c);
    let s = 0;
    for (let i = 0; i < ga.length; i++) s += Math.abs(ga[i] - gb[i]);
    if (!best || s < best.s) best = { s, c };
  }
  return best.c;
}

function equalize(d) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])]++;
  const cdf = new Float32Array(256);
  let acc = 0;
  const total = d.length / 4;
  for (let i = 0; i < 256; i++) { acc += hist[i]; cdf[i] = acc / total; }
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const k = y > 0 ? (cdf[Math.round(y)] * 255) / y : 1;
    d[i] = Math.min(255, d[i] * k); d[i + 1] = Math.min(255, d[i + 1] * k); d[i + 2] = Math.min(255, d[i + 2] * k);
  }
}

async function errorLevel(c, gain) {
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
  const img = await createImageBitmap(blob);
  const t = document.createElement('canvas');
  t.width = c.width; t.height = c.height;
  t.getContext('2d').drawImage(img, 0, 0);
  const a = c.getContext('2d').getImageData(0, 0, c.width, c.height), b = t.getContext('2d').getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < a.data.length; i += 4) for (let k = 0; k < 3; k++) a.data[i + k] = Math.min(255, Math.abs(a.data[i + k] - b.data[i + k]) * gain);
  return a;
}

function convolve(id, kernel, gain) {
  const { width: w, height: h, data } = id;
  const out = new ImageData(w, h);
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let s = 0;
    if (kernel === 'sobel') {
      const gx = -g[(y - 1) * w + x - 1] - 2 * g[y * w + x - 1] - g[(y + 1) * w + x - 1] + g[(y - 1) * w + x + 1] + 2 * g[y * w + x + 1] + g[(y + 1) * w + x + 1];
      const gy = -g[(y - 1) * w + x - 1] - 2 * g[(y - 1) * w + x] - g[(y - 1) * w + x + 1] + g[(y + 1) * w + x - 1] + 2 * g[(y + 1) * w + x] + g[(y + 1) * w + x + 1];
      s = Math.hypot(gx, gy) / 4;
    } else {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += g[(y + dy) * w + x + dx];
      s = g[y * w + x] - m / 9;   // noise: pixel minus local mean
    }
    const v = Math.min(255, Math.abs(s) * gain);
    const o = (y * w + x) * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = v;
  }
  return out;
}

/** False colour: grey levels mapped to a rainbow, so faint differences in a background (erased or pasted areas) show up */
function falseColour(d, gain) {
  const k = gain / 10;
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.min(1, Math.max(0, ((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255 - 0.5) * k + 0.5));
    const h = (1 - y) * 240 / 60, x = 1 - Math.abs((h % 2) - 1);
    const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : [0, x, 1];
    d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
  }
}

async function render(base, mode, gain) {
  const c = document.createElement('canvas');
  c.width = base.width; c.height = base.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(base, 0, 0);
  if (mode === 'original') return c;
  let id = ctx.getImageData(0, 0, c.width, c.height);
  if (mode === 'contrast') equalize(id.data);
  else if (mode === 'ela') id = await errorLevel(c, gain * 4);
  else if (mode === 'noise') id = convolve(id, 'noise', gain * 2);
  else if (mode === 'edges') id = convolve(id, 'sobel', gain / 2);
  else if (mode === 'false') falseColour(id.data, gain);
  else if (mode === 'invert') for (let i = 0; i < id.data.length; i += 4) { id.data[i] = 255 - id.data[i]; id.data[i + 1] = 255 - id.data[i + 1]; id.data[i + 2] = 255 - id.data[i + 2]; }
  else if (mode === 'solarize') solarize(id.data, gain);
  else if (mode === 'background') background(id.data, gain);
  ctx.putImageData(id, 0, 0);
  return c;
}

/** Solarisation: grey levels folded several times (more folds with more strength), so smooth gradients turn into
 * contour bands and a pasted patch or a cleaned background breaks the bands */
function solarize(d, gain) {
  const folds = Math.max(2, Math.round(gain / 4));
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) {
    const t = (d[i + k] / 255) * folds;
    d[i + k] = (Math.floor(t) % 2 ? 1 - (t % 1) : t % 1) * 255;
  }
}

/** Background visualisation: the brightest (or darkest) background levels stretched over the whole grey range, so
 * erased bands, rectangles of a different background and splice edges show up on blots and gels */
function background(d, gain) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
  let acc = 0, med = 128;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= d.length / 8) { med = v; break; } }
  const light = med > 127;                       // most blots: light background, dark bands
  const span = Math.max(4, 64 - gain * 2);       // stronger = narrower window around the background level
  let lo = light ? 255 - span : 0, hi = light ? 255 : span;
  for (let v = 255, a = 0; v >= 0 && light; v--) { a += hist[v]; if (a >= d.length / 4 * 0.6) { lo = Math.max(0, v - span / 2); hi = Math.min(255, lo + span); break; } }
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, (d[i + k] - lo) / (hi - lo) * 255));
}

/** Brightness (-100..100) and contrast (-100..100) on a copy */
function adjust(c, bright, contrast) {
  if (!bright && !contrast) return c;
  const o = document.createElement('canvas');
  o.width = c.width; o.height = c.height;
  const ctx = o.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(c, 0, 0);
  const id = ctx.getImageData(0, 0, o.width, o.height), d = id.data;
  const f = (259 * (contrast * 2.55 + 255)) / (255 * (259 - contrast * 2.55)), b = bright * 2.55;
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) d[i + k] = f * (d[i + k] - 128) + 128 + b;
  ctx.putImageData(id, 0, 0);
  return o;
}

/** Heatmap: A in grey with the agreement of A and B coloured over it - red where the two are (nearly) the same
 * picture, nothing where they differ (8 px blocks) */
function heatmap(a, b) {
  const w = a.width, h = a.height, B = 8;
  const da = a.getContext('2d').getImageData(0, 0, w, h).data, db = b.getContext('2d').getImageData(0, 0, w, h).data;
  const o = document.createElement('canvas');
  o.width = w; o.height = h;
  const ctx = o.getContext('2d');
  ctx.filter = 'grayscale(1) opacity(0.65)';
  ctx.drawImage(a, 0, 0);
  ctx.filter = 'none';
  let same = 0, blocks = 0;
  for (let y = 0; y < h; y += B) for (let x = 0; x < w; x += B) {
    let s = 0, n = 0;
    for (let yy = y; yy < Math.min(h, y + B); yy++) for (let xx = x; xx < Math.min(w, x + B); xx++) {
      const i = (yy * w + xx) * 4;
      s += Math.abs(da[i] + da[i + 1] + da[i + 2] - db[i] - db[i + 1] - db[i + 2]) / 3; n++;
    }
    const diff = s / n;
    blocks++;
    if (diff < 14) {
      same++;
      ctx.fillStyle = `rgba(230, 20, 60, ${0.55 * (1 - diff / 14) + 0.1})`;
      ctx.fillRect(x, y, B, B);
    }
  }
  return { canvas: o, same: same / Math.max(1, blocks) };
}

/** Matched keypoints of A and B (ORB + RANSAC, B already aligned): [{ ax, ay, bx, by }] in canvas pixels */
function matchedKeypoints(a, b) {
  const gray = c => {
    const g = toGray(c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height));
    const k = Math.min(1, 360 / Math.max(g.w, g.h));
    return { k, img: k < 1 ? resizeGray(g, Math.round(g.w * k), Math.round(g.h * k)) : g };
  };
  const A = gray(a), Bg = gray(b);
  const fa = orb(A.img, { max: 400 }), fb = orb(Bg.img, { max: 400 });
  const m = matchFeatures(fa, fb, { maxDist: 70, ratio: 0.9 });
  const fit = ransac(m, fa, fb, { tol: 5 });
  const use = fit && fit.inliers.length >= 4 ? fit.inliers : [];
  return use.slice(0, 120).map(x => ({ ax: fa.pts[x.i].x / A.k, ay: fa.pts[x.i].y / A.k, bx: fb.pts[x.j].x / Bg.k, by: fb.pts[x.j].y / Bg.k }));
}

/** |A - B| per pixel, amplified: identical areas turn black, differences light up */
function difference(a, b, gain) {
  const c = document.createElement('canvas');
  c.width = a.width; c.height = a.height;
  const ctx = c.getContext('2d');
  const da = a.getContext('2d').getImageData(0, 0, a.width, a.height), db = b.getContext('2d').getImageData(0, 0, a.width, a.height);
  const out = ctx.createImageData(a.width, a.height);
  let same = 0;
  for (let i = 0; i < da.data.length; i += 4) {
    let s = 0;
    for (let k = 0; k < 3; k++) { const d = Math.abs(da.data[i + k] - db.data[i + k]); s += d; out.data[i + k] = Math.min(255, d * gain / 3); }
    if (s / 3 < 12) same++;
    out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return { canvas: c, same: same / (da.data.length / 4) };
}

/** Outline boxes ({ x, y, w, h } in the canvas's pixels) on a copy */
function outlined(c, boxes, colour) {
  if (!boxes?.length) return c;
  const o = document.createElement('canvas');
  o.width = c.width; o.height = c.height;
  const ctx = o.getContext('2d');
  ctx.drawImage(c, 0, 0);
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(2, c.width / 200);
  ctx.setLineDash([8, 4]);
  for (const b of boxes) ctx.strokeRect(b.x, b.y, b.w, b.h);
  return o;
}

const MODES = [['original', 'Original'], ['contrast', 'Contrast boost'], ['ela', 'Error level'], ['noise', 'Noise map'], ['edges', 'Edges'], ['false', 'False colour'], ['invert', 'Invert'], ['solarize', 'Solarize'], ['background', 'Background']];
const HELP = {
  original: 'The image as extracted from the manuscript.',
  contrast: 'Histogram equalisation: reveals faint edges, erased bands and pasted backgrounds in dark or washed-out areas.',
  ela: 'Error level analysis: the image is re-saved as JPEG and the difference shown. Areas pasted in from another image often stand out with a different level. PDF compression can hide this.',
  noise: 'Noise map: the fine grain of the image. A pasted or cleaned area often has smoother or different grain than its surroundings.',
  edges: 'Edge view: sharp straight boundaries around a band or cell can show where something was inserted.',
  false: 'False colour: small differences in grey level become different colours, so an evenly “cleaned” background or a pasted rectangle stands out.',
  invert: 'Negative image: helps to see faint bands on blots and gels.',
  solarize: 'Solarisation: grey levels are folded into contour bands. Smooth backgrounds become rings and stripes; a pasted patch or an erased area interrupts them.',
  background: 'Background visualisation: only the background grey levels are stretched over the full range, so erased bands, pasted rectangles and splice lines on blots and gels become visible.'
};
const VIEWS = [['single', 'A / B'], ['side', 'Side by side'], ['overlay', 'Overlay'], ['swipe', 'Swipe'], ['diff', 'Difference'], ['heat', 'Heatmap'], ['flicker', 'Flicker']];
const VIEW_HELP = {
  single: 'One image at a time; “Show B” switches.',
  side: 'Both images next to each other, B turned and mirrored like A, with the same filter.',
  overlay: 'B laid over A; move the slider to fade between them. Re-used content stays still while the rest changes.',
  swipe: 'A on the left of the line, B on the right; drag the slider across the image.',
  diff: 'Absolute difference of A and B: matching content turns black, changes light up.',
  heat: 'Heatmap of agreement: A in grey, red where A and B show the same picture. A re-used area is a solid red block.',
  flicker: 'A and B alternate quickly; re-used areas stay still, differences jump.'
};

/**
 * Open the viewer. a: { src (canvas | URL | data URL), box?, label, marks?: [box] }, b (optional): second image,
 * transform: { rotation (rad), flip, scale } maps A -> B.
 */
export async function openViewer({ a, b = null, transform = null, title = 'Forensic viewer' }) {
  const srcA = await loadSource(a.src);
  const baseA = a.box ? crop(srcA, a.box) : srcA;
  let baseB = null;
  if (b) {
    try { const srcB = await loadSource(b.src); baseB = alignTo(baseA, b.box ? crop(srcB, b.box) : srcB, transform); } catch (e) { baseB = null; }
  }
  const markA = a.marks?.map(m => ({ x: m.x - (a.box?.x || 0), y: m.y - (a.box?.y || 0), w: m.w, h: m.h }));
  let mode = 'original', gain = 10, view = baseB ? 'side' : 'single', showB = false, mix = 50, zoom = 0, timer = null, bright = 0, contrast = 0, keypoints = false, kp = null;
  modal(`
    <div class="card-head"><h2>${esc(title)}</h2><button class="btn btn-sm btn-ghost" data-close>✕</button></div>
    ${baseB ? `<div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:6px"><span class="muted">Compare:</span>${VIEWS.map(([k, l]) => `<button class="filter ${k === view ? 'active' : ''}" data-view="${k}">${l}</button>`).join('')}
      <label class="muted" id="mix-wrap" hidden style="margin-left:8px"><span id="mix-label">A ↔ B</span> <input type="range" id="mix" min="0" max="100" value="50" style="vertical-align:middle;width:160px"></label>
      <button class="btn btn-sm btn-ghost" id="swap" hidden>Show B</button>
      <label class="muted" style="margin-left:8px"><input type="checkbox" id="kp"> Matched keypoints</label></div>` : ''}
    <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:8px"><span class="muted">Filter:</span>
      ${MODES.map(([k, l]) => `<button class="filter ${k === 'original' ? 'active' : ''}" data-mode="${k}">${l}</button>`).join('')}
      <label class="muted" style="margin-left:8px">Strength <input type="range" id="gain" min="2" max="30" value="10" style="vertical-align:middle"></label>
      <label class="muted">Brightness <input type="range" id="bright" min="-100" max="100" value="0" style="vertical-align:middle;width:90px"></label>
      <label class="muted">Contrast <input type="range" id="contr" min="-100" max="100" value="0" style="vertical-align:middle;width:90px"></label>
      <span class="spacer"></span>
      <button class="btn btn-sm btn-ghost" id="zout" title="Zoom out">−</button><span class="muted" id="zl">fit</span><button class="btn btn-sm btn-ghost" id="zin" title="Zoom in">+</button>
      <button class="btn btn-sm" id="save">Save view</button>
    </div>
    <div class="muted" id="help" style="margin-bottom:8px">${esc(baseB ? VIEW_HELP[view] : HELP.original)}</div>
    <div class="viewer-stage"><canvas id="vc"></canvas><div class="viewer-label" id="vlabel"></div></div>
    <p class="muted" style="margin-top:8px">Move the mouse over the image to magnify. ${baseB ? 'B is turned / mirrored to match A as detected. ' : ''}Filters are aids for looking closer, not proof.</p>`, {
    onMount(m) {
      const vc = $('#vc', m);
      const fit = c => Math.min(1, 880 / c.width, 560 / c.height) || 1;
      const draw = async () => {
        const fa = outlined(adjust(await render(baseA, mode, gain), bright, contrast), markA, '#ff1f5a');
        let out = fa, label = a.label || 'A';
        if (baseB) {
          const fb = adjust(await render(baseB, mode, gain), bright, contrast);
          if (view === 'single') { out = showB ? fb : fa; label = showB ? `${b.label || 'B'} (aligned to A)` : label; }
          else if (view === 'flicker') { out = showB ? fb : fa; label = showB ? `B — ${b.label || ''}` : `A — ${a.label || ''}`; }
          else if (view === 'side') {
            const gap = Math.max(6, Math.round(fa.width / 60));
            out = document.createElement('canvas');
            out.width = fa.width * 2 + gap; out.height = fa.height;
            const ctx = out.getContext('2d');
            ctx.fillStyle = '#111'; ctx.fillRect(0, 0, out.width, out.height);
            ctx.drawImage(fa, 0, 0); ctx.drawImage(fb, fa.width + gap, 0);
            label = `A: ${a.label || ''}   |   B: ${b.label || ''}`;
            if (keypoints) {
              kp = kp || matchedKeypoints(baseA, baseB);
              ctx.lineWidth = Math.max(1, fa.width / 400);
              kp.forEach((p, i) => {
                ctx.strokeStyle = `hsl(${(i * 47) % 360} 90% 55%)`;
                ctx.beginPath(); ctx.moveTo(p.ax, p.ay); ctx.lineTo(p.bx + fa.width + gap, p.by); ctx.stroke();
                ctx.fillStyle = ctx.strokeStyle;
                ctx.fillRect(p.ax - 2, p.ay - 2, 4, 4); ctx.fillRect(p.bx + fa.width + gap - 2, p.by - 2, 4, 4);
              });
              label += ` · ${kp.length} matched keypoints`;
            }
          } else if (view === 'overlay') {
            out = document.createElement('canvas');
            out.width = fa.width; out.height = fa.height;
            const ctx = out.getContext('2d');
            ctx.drawImage(fa, 0, 0); ctx.globalAlpha = mix / 100; ctx.drawImage(fb, 0, 0);
            label = `A ${100 - mix}% · B ${mix}%`;
          } else if (view === 'swipe') {
            out = document.createElement('canvas');
            out.width = fa.width; out.height = fa.height;
            const ctx = out.getContext('2d'), x = Math.round(fa.width * mix / 100);
            ctx.drawImage(fa, 0, 0);
            ctx.drawImage(fb, x, 0, fa.width - x, fa.height, x, 0, fa.width - x, fa.height);
            ctx.fillStyle = '#ffd400'; ctx.fillRect(Math.max(0, x - 1), 0, 2, fa.height);
            label = 'A ← | → B';
          } else if (view === 'diff') {
            const d = difference(fa, fb, gain);
            out = d.canvas;
            label = `Difference A − B · ${Math.round(d.same * 100)}% of pixels nearly identical`;
          } else if (view === 'heat') {
            const hm = heatmap(fa, fb);
            out = hm.canvas;
            label = `Heatmap · ${Math.round(hm.same * 100)}% of the area agrees`;
          }
        }
        const scale = zoom ? zoom : Math.max(fit(out), Math.min(3, 360 / Math.max(out.width, out.height)));
        vc.width = out.width; vc.height = out.height;
        vc.style.width = `${Math.round(out.width * scale)}px`;
        vc.style.height = `${Math.round(out.height * scale)}px`;
        vc.style.maxWidth = zoom ? 'none' : '100%';
        vc.getContext('2d').drawImage(out, 0, 0);
        $('#vlabel', m).textContent = label;
        $('#zl', m).textContent = zoom ? `${Math.round(zoom * 100)}%` : 'fit';
      };
      const stopFlicker = () => { if (timer) { clearInterval(timer); timer = null; } };
      m.querySelectorAll('[data-mode]').forEach(btn => btn.onclick = () => { mode = btn.dataset.mode; m.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x === btn)); $('#help', m).textContent = HELP[mode]; draw(); });
      m.querySelectorAll('[data-view]').forEach(btn => btn.onclick = () => {
        view = btn.dataset.view; showB = false; stopFlicker();
        m.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('active', x === btn));
        $('#mix-wrap', m).hidden = !(view === 'overlay' || view === 'swipe');
        $('#mix-label', m).textContent = view === 'swipe' ? 'Line position' : 'Opacity of B';
        $('#swap', m).hidden = view !== 'single';
        $('#help', m).textContent = VIEW_HELP[view];
        if (view === 'flicker') timer = setInterval(() => { showB = !showB; draw(); }, 650);
        draw();
      });
      $('#gain', m).oninput = e => { gain = +e.target.value; draw(); };
      $('#bright', m).oninput = e => { bright = +e.target.value; draw(); };
      $('#contr', m).oninput = e => { contrast = +e.target.value; draw(); };
      if (baseB) $('#kp', m).onchange = e => {
        keypoints = e.target.checked;
        if (keypoints && view !== 'side') m.querySelector('[data-view=side]').click(); else draw();
      };
      if (baseB) {
        $('#mix', m).oninput = e => { mix = +e.target.value; draw(); };
        $('#swap', m).onclick = () => { showB = !showB; $('#swap', m).textContent = showB ? 'Show A' : 'Show B'; draw(); };
      }
      const steps = [0.25, 0.5, 1, 2, 3, 4, 6, 8];
      const cur = () => zoom || parseFloat(vc.style.width) / vc.width || 1;
      $('#zin', m).onclick = () => { zoom = steps.find(s => s > cur() + 0.01) || 8; draw(); };
      $('#zout', m).onclick = () => { const z = [...steps].reverse().find(s => s < cur() - 0.01); zoom = z && z >= 0.25 ? z : 0; draw(); };
      $('#save', m).onclick = () => { const l = document.createElement('a'); l.download = `${title.replace(/[^\w\- ]+/g, '').slice(0, 60) || 'figure'} - ${mode}${baseB ? ' - ' + view : ''}.png`; l.href = vc.toDataURL('image/png'); l.click(); };
      // magnifier
      const lens = document.createElement('canvas');
      lens.width = lens.height = 160;
      lens.className = 'viewer-lens';
      lens.hidden = true;
      $('.viewer-stage', m).appendChild(lens);
      vc.onmousemove = e => {
        const r = vc.getBoundingClientRect(), st = $('.viewer-stage', m);
        const x = (e.clientX - r.left) / r.width * vc.width, y = (e.clientY - r.top) / r.height * vc.height;
        const lc = lens.getContext('2d');
        lc.imageSmoothingEnabled = false;
        lc.clearRect(0, 0, 160, 160);
        lc.drawImage(vc, x - 20, y - 20, 40, 40, 0, 0, 160, 160);
        lens.hidden = false;
        const sr = st.getBoundingClientRect();
        lens.style.left = `${e.clientX - sr.left + st.scrollLeft + 16}px`;
        lens.style.top = `${e.clientY - sr.top + st.scrollTop + 16}px`;
      };
      vc.onmouseleave = () => { lens.hidden = true; };
      const obs = new MutationObserver(() => { if (!document.body.contains(m)) { stopFlicker(); obs.disconnect(); } });
      obs.observe(document.body, { childList: true });
      draw();
    }
  });
}
