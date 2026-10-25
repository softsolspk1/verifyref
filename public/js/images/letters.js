// images/letters.js - reads the panel letter (A, B, C ...) from the corner of a figure panel, so a finding can say
// "Fig. 2C vs Fig. 4A". No OCR library: the single bold letter is cut out of the corner and compared with letters
// drawn by the browser's own fonts (Arial / Helvetica, bold and regular). Runs in the analysis worker; where
// OffscreenCanvas is not available (older browsers, Node tests) it returns null and the panel keeps its number.

const SIZE = 16;
let templates = null;

function normalise(mask, w, h) {
  // crop to the ink, fit into SIZE x SIZE keeping the aspect ratio, centred
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const k = (SIZE - 2) / Math.max(bw, bh);
  const out = new Float32Array(SIZE * SIZE);
  const ow = Math.max(1, Math.round(bw * k)), oh = Math.max(1, Math.round(bh * k));
  const ox = Math.floor((SIZE - ow) / 2), oy = Math.floor((SIZE - oh) / 2);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    // area coverage of the source cell
    const sx0 = x0 + x / k, sx1 = x0 + (x + 1) / k, sy0 = y0 + y / k, sy1 = y0 + (y + 1) / k;
    let on = 0, n = 0;
    for (let yy = Math.floor(sy0); yy < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); yy++) for (let xx = Math.floor(sx0); xx < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); xx++) { if (xx <= x1 && yy <= y1) { n++; if (mask[yy * w + xx]) on++; } }
    out[(oy + y) * SIZE + ox + x] = n ? on / n : 0;
  }
  return { v: out, aspect: bw / bh };
}

function ncc(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= a.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

function buildTemplates() {
  if (templates) return templates;
  if (typeof OffscreenCanvas === 'undefined') return (templates = []);
  const out = [];
  const fonts = ['bold 80px Arial, Helvetica, sans-serif', '80px Arial, Helvetica, sans-serif', 'bold 80px "Segoe UI", Verdana, sans-serif', 'bold 80px "Times New Roman", serif'];
  const c = new OffscreenCanvas(120, 120);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (const font of fonts) {
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 120, 120);
      ctx.fillStyle = '#000'; ctx.font = font; ctx.textBaseline = 'alphabetic';
      ctx.fillText(ch, 20, 95);
      const d = ctx.getImageData(0, 0, 120, 120).data;
      const mask = new Uint8Array(120 * 120);
      for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4] < 128 ? 1 : 0;
      const n = normalise(mask, 120, 120);
      if (n) out.push({ ch, v: n.v, aspect: n.aspect });
    }
  }
  return (templates = out);
}

/** Connected components (4-neighbour) of a binary mask: [{ x0, y0, x1, y1, area }] */
function components(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack.push(p - w); }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack.push(p + w); }
    }
    out.push({ x0, y0, x1, y1, area });
  }
  return out;
}

/**
 * gray: { w, h, g } of the whole figure; box: the panel. Looks in the top-left corner (and just outside it) for one
 * letter. Returns the upper-case letter or null.
 */
export function readPanelLetter(gray, box) {
  const T = buildTemplates();
  if (!T.length) return null;
  // search window: the top-left corner of the panel, a little beyond it, at most 30% of the panel
  const wx0 = Math.max(0, Math.floor(box.x - Math.min(40, box.w * 0.12))), wy0 = Math.max(0, Math.floor(box.y - Math.min(40, box.h * 0.12)));
  const ww = Math.min(gray.w - wx0, Math.round(Math.min(box.w * 0.34, 140) + (box.x - wx0))), wh = Math.min(gray.h - wy0, Math.round(Math.min(box.h * 0.34, 140) + (box.y - wy0)));
  if (ww < 12 || wh < 12) return null;
  const win = new Float32Array(ww * wh);
  for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) win[y * ww + x] = gray.g[(wy0 + y) * gray.w + wx0 + x];
  let best = null;
  for (const polarity of [0, 1]) {                                             // dark letter on light, light letter on dark
    const mask = new Uint8Array(ww * wh);
    const sorted = Float32Array.from(win).sort();
    const lo = sorted[Math.floor(sorted.length * 0.06)], hi = sorted[Math.floor(sorted.length * 0.94)];
    if (hi - lo < 90) continue;
    const thr = (lo + hi) / 2;
    for (let i = 0; i < mask.length; i++) mask[i] = polarity ? (win[i] > thr ? 1 : 0) : (win[i] < thr ? 1 : 0);
    const comps = components(mask, ww, wh).filter(c => {
      const h = c.y1 - c.y0 + 1, w = c.x1 - c.x0 + 1;
      return h >= 9 && h <= Math.min(70, box.h * 0.3) && w >= 4 && w <= h * 1.6 && c.area >= 18 && c.area <= h * w * 0.85;
    });
    for (const c of comps) {
      const dist = Math.hypot(c.x0 - (box.x - wx0), c.y0 - (box.y - wy0));
      const sub = new Uint8Array((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
      const sw = c.x1 - c.x0 + 1;
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) sub[(y - c.y0) * sw + x - c.x0] = mask[y * ww + x];
      const n = normalise(sub, sw, c.y1 - c.y0 + 1);
      if (!n) continue;
      let top = null, second = null;
      for (const t of T) {
        const s = ncc(n.v, t.v) - Math.min(0.15, Math.abs(Math.log(n.aspect / t.aspect)) * 0.25);
        if (!top || s > top.s) { if (top && top.ch.toUpperCase() !== t.ch.toUpperCase()) second = top; top = { ch: t.ch, s }; }
        else if (t.ch.toUpperCase() !== top.ch.toUpperCase() && (!second || s > second.s)) second = { ch: t.ch, s };
      }
      if (top && top.s >= 0.78 && (!second || top.s - second.s >= 0.04)) {
        const cand = { letter: top.ch.toUpperCase(), score: top.s, dist };
        if (!best || cand.dist - cand.score * 30 < best.dist - best.score * 30) best = cand;
      }
    }
  }
  return best ? best.letter : null;
}
