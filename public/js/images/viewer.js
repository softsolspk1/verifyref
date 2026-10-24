// images/viewer.js - forensic viewer for the editor: contrast boost, error level analysis, noise map, edges, invert,
// magnifier, and a flicker comparison of two matched regions (aligned using the detected rotation / mirroring).
import { modal, esc, $ } from '../core.js';

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

function convolve(id, kernel, gain, abs = true, offset = 0) {
  const { width: w, height: h, data } = id;
  const out = new ImageData(w, h);
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let s = 0;
    if (kernel === 'sobel') {
      const gx = -g[(y - 1) * w + x - 1] - 2 * g[y * w + x - 1] - g[(y + 1) * w + x - 1] + g[(y - 1) * w + x + 1] + 2 * g[y * w + x + 1] + g[(y + 1) * w + x + 1];
      const gy = -g[(y - 1) * w + x - 1] - 2 * g[(y - 1) * w + x] - g[(y - 1) * w + x + 1] + g[(y + 1) * w + x - 1] + 2 * g[(y + 1) * w + x] + g[(y + 1) * w + x + 1];
      s = Math.hypot(gx, gy) / 4;
    } else {
      // noise: pixel minus local mean
      let m = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) m += g[(y + dy) * w + x + dx];
      s = g[y * w + x] - m / 9;
    }
    const v = Math.min(255, Math.max(0, (abs ? Math.abs(s) : s) * gain + offset));
    const o = (y * w + x) * 4;
    out.data[o] = out.data[o + 1] = out.data[o + 2] = v; out.data[o + 3] = 255;
  }
  return out;
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
  else if (mode === 'noise') id = convolve(id, 'noise', gain * 2, true);
  else if (mode === 'edges') id = convolve(id, 'sobel', gain / 2);
  else if (mode === 'invert') for (let i = 0; i < id.data.length; i += 4) { id.data[i] = 255 - id.data[i]; id.data[i + 1] = 255 - id.data[i + 1]; id.data[i + 2] = 255 - id.data[i + 2]; }
  ctx.putImageData(id, 0, 0);
  return c;
}

const MODES = [['original', 'Original'], ['contrast', 'Contrast boost'], ['ela', 'Error level'], ['noise', 'Noise map'], ['edges', 'Edges'], ['invert', 'Invert']];
const HELP = {
  original: 'The image as extracted from the manuscript.',
  contrast: 'Histogram equalisation: reveals faint edges, erased bands and pasted backgrounds in dark or washed-out areas.',
  ela: 'Error level analysis: the image is re-saved as JPEG and the difference shown. Areas pasted in from another image often stand out with a different level. PDF compression can hide this.',
  noise: 'Noise map: the fine grain of the image. A pasted or cleaned area often has smoother or different grain than its surroundings.',
  edges: 'Edge view: sharp straight boundaries around a band or cell can show where something was inserted.',
  invert: 'Negative image: helps to see faint bands on blots and gels.'
};

/**
 * Open the viewer. a: { src (canvas | data URL), box?, label }, b (optional): second region for flicker comparison,
 * transform: { rotation (rad), flip } maps a -> b.
 */
export async function openViewer({ a, b = null, transform = null, title = 'Forensic viewer' }) {
  const srcA = await loadSource(a.src);
  const baseA = a.box ? crop(srcA, a.box) : srcA;
  let baseB = null;
  if (b) {
    const srcB = await loadSource(b.src);
    const cb = b.box ? crop(srcB, b.box) : srcB;
    // Align B to A: undo mirroring and rotation, scale to A's size
    baseB = document.createElement('canvas');
    baseB.width = baseA.width; baseB.height = baseA.height;
    const ctx = baseB.getContext('2d');
    ctx.translate(baseB.width / 2, baseB.height / 2);
    const rot = transform?.rotation || 0;
    ctx.rotate(-rot);
    if (transform?.flip) ctx.scale(-1, 1);
    const swap = Math.abs(Math.round(rot / (Math.PI / 2))) % 2 === 1;
    const dw = swap ? baseB.height : baseB.width, dh = swap ? baseB.width : baseB.height;
    ctx.drawImage(cb, -dw / 2, -dh / 2, dw, dh);
  }
  let mode = 'original', gain = 10, showB = false, timer = null;
  modal(`
    <div class="card-head"><h2>${esc(title)}</h2><button class="btn btn-sm btn-ghost" data-close>✕</button></div>
    <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">
      ${MODES.map(([k, l]) => `<button class="filter ${k === 'original' ? 'active' : ''}" data-mode="${k}">${l}</button>`).join('')}
      <label class="muted" style="margin-left:8px">Strength <input type="range" id="gain" min="2" max="30" value="10" style="vertical-align:middle"></label>
      ${baseB ? '<button class="btn btn-sm" id="flicker">Flicker A ↔ B</button><button class="btn btn-sm btn-ghost" id="swap">Show B</button>' : ''}
    </div>
    <div class="muted" id="help" style="margin-bottom:8px">${esc(HELP.original)}</div>
    <div class="viewer-stage"><canvas id="vc"></canvas><div class="viewer-label" id="vlabel">${esc(a.label || 'A')}</div></div>
    <p class="muted" style="margin-top:8px">Move the mouse over the image to magnify. Filters are aids for looking closer, not proof.</p>`, {
    onMount(m, close) {
      const vc = $('#vc', m);
      const draw = async () => {
        const src = showB && baseB ? baseB : baseA;
        const out = await render(src, mode, gain);
        const k = Math.min(1, 860 / out.width, 560 / out.height) || 1;
        const scale = Math.max(k, Math.min(3, 360 / Math.max(out.width, out.height)));
        vc.width = out.width; vc.height = out.height;
        vc.style.width = `${Math.round(out.width * scale)}px`;
        vc.style.height = `${Math.round(out.height * scale)}px`;
        vc.getContext('2d').drawImage(out, 0, 0);
        $('#vlabel', m).textContent = showB && baseB ? `${b.label || 'B'} (aligned to A)` : a.label || 'A';
      };
      m.querySelectorAll('[data-mode]').forEach(btn => btn.onclick = () => { mode = btn.dataset.mode; m.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x === btn)); $('#help', m).textContent = HELP[mode]; draw(); });
      $('#gain', m).oninput = e => { gain = +e.target.value; draw(); };
      if (baseB) {
        $('#swap', m).onclick = () => { showB = !showB; $('#swap', m).textContent = showB ? 'Show A' : 'Show B'; draw(); };
        $('#flicker', m).onclick = () => {
          if (timer) { clearInterval(timer); timer = null; $('#flicker', m).textContent = 'Flicker A ↔ B'; return; }
          $('#flicker', m).textContent = 'Stop flicker';
          timer = setInterval(() => { showB = !showB; draw(); }, 700);
        };
      }
      // magnifier
      const lens = document.createElement('canvas');
      lens.width = lens.height = 160;
      lens.className = 'viewer-lens';
      lens.hidden = true;
      $('.viewer-stage', m).appendChild(lens);
      vc.onmousemove = e => {
        const r = vc.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width * vc.width, y = (e.clientY - r.top) / r.height * vc.height;
        const lc = lens.getContext('2d');
        lc.imageSmoothingEnabled = false;
        lc.clearRect(0, 0, 160, 160);
        lc.drawImage(vc, x - 20, y - 20, 40, 40, 0, 0, 160, 160);
        lens.hidden = false;
        lens.style.left = `${e.clientX - r.left + 16}px`;
        lens.style.top = `${e.clientY - r.top + 16}px`;
      };
      vc.onmouseleave = () => { lens.hidden = true; };
      const obs = new MutationObserver(() => { if (!document.body.contains(m)) { clearInterval(timer); obs.disconnect(); } });
      obs.observe(document.body, { childList: true });
      draw();
      void close;
    }
  });
}
