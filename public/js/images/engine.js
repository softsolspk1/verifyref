// images/engine.js - Module 5 image forensics, pure JavaScript (runs in a Web Worker and in Node for tests).
// Input images are { id, label, width, height, data: Uint8ClampedArray RGBA }.
//   1. Split multi-panel figures into panels (white / uniform gutters, recursive XY-cut)
//   2. Guess the figure type (Western blot / gel, microscopy, histology, chart, photo)
//   3. Whole-panel duplicates: perceptual hash (DCT) in 8 orientations (0/90/180/270°, mirrored) + correlation check
//   4. Partial duplicates (cropped, resized, rotated, flipped, partly overlapping): ORB keypoints + RANSAC similarity
//   5. Cloned areas inside one panel: ORB self-matching and DCT block matching (copy-move)
// Results are findings for the editor to check, never verdicts.

// ------------------------------------------------------------------ basic image operations

export function toGray(img) {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return { w, h, g };
}

/** Area-average resize of a grayscale image (crop box optional) */
export function resizeGray(src, nw, nh, box = { x: 0, y: 0, w: src.w, h: src.h }) {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  const out = new Float32Array(nw * nh);
  const sx = box.w / nw, sy = box.h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = box.y + y * sy, y1 = y0 + sy;
    for (let x = 0; x < nw; x++) {
      const x0 = box.x + x * sx, x1 = x0 + sx;
      let sum = 0, area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        if (yy < 0 || yy >= src.h) continue;
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          if (xx < 0 || xx >= src.w) continue;
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          const a = wx * wy;
          sum += src.g[yy * src.w + xx] * a;
          area += a;
        }
      }
      out[y * nw + x] = area ? sum / area : 0;
    }
  }
  return { w: nw, h: nh, g: out };
}

/** Same for RGBA (used for splitting and classification on a reduced copy) */
export function resizeRGBA(img, nw, nh, box = { x: 0, y: 0, w: img.width, h: img.height }) {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  const out = new Uint8ClampedArray(nw * nh * 4);
  const sx = box.w / nw, sy = box.h / nh;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      // sample a small grid inside the source cell (fast approximation of area averaging)
      let r = 0, g = 0, b = 0, n = 0;
      for (let k = 0; k < 2; k++) for (let l = 0; l < 2; l++) {
        const xx = Math.min(img.width - 1, Math.floor(box.x + (x + (l + 0.5) / 2) * sx));
        const yy = Math.min(img.height - 1, Math.floor(box.y + (y + (k + 0.5) / 2) * sy));
        const j = (yy * img.width + xx) * 4;
        r += img.data[j]; g += img.data[j + 1]; b += img.data[j + 2]; n++;
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: nw, height: nh, data: out };
}

function blur(src, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const { w, h, g } = src;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += g[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let i = -r; i <= r; i++) a += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r];
    out[y * w + x] = a;
  }
  return { w, h, g: out };
}

function flipH(src) {
  const { w, h, g } = src;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = g[y * w + (w - 1 - x)];
  return { w, h, g: out };
}

/** 8 orientations of a square grayscale array: k*90° rotation, optionally mirrored */
export function orient(src, k, mirror) {
  const { w, h, g } = src; // square
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sx = mirror ? w - 1 - x : x, sy = y;
    let tx = sx, ty = sy;
    for (let i = 0; i < k; i++) { const nx = w - 1 - ty; ty = tx; tx = nx; }
    out[ty * w + tx] = g[y * w + x];
  }
  return { w, h, g: out };
}

function stats(arr) {
  let s = 0, s2 = 0;
  for (const v of arr) { s += v; s2 += v * v; }
  const m = s / arr.length;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / arr.length - m * m)) };
}

// ------------------------------------------------------------------ panel splitting

function background(img) {
  // Dominant border colour (most figures: white; some: black)
  const { width: w, height: h, data } = img;
  const counts = new Map();
  const add = (x, y) => { const j = (y * w + x) * 4; const k = `${data[j] >> 4},${data[j + 1] >> 4},${data[j + 2] >> 4}`; counts.set(k, (counts.get(k) || 0) + 1); };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [r, g, b] = best[0].split(',').map(v => (parseInt(v, 10) << 4) + 8);
  // A mid-grey border is the picture itself (blots and photos reaching the edge), not a margin
  const lum = (r + g + b) / 3;
  if (lum > 30 && lum < 232) return { r: 255, g: 255, b: 255 };
  return { r, g, b };
}

function bgMask(img, bg) {
  const { width: w, height: h, data } = img;
  const m = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const white = data[j] > 232 && data[j + 1] > 232 && data[j + 2] > 232;
    const near = Math.abs(data[j] - bg.r) < 18 && Math.abs(data[j + 1] - bg.g) < 18 && Math.abs(data[j + 2] - bg.b) < 18;
    m[i] = white || near ? 1 : 0;
  }
  return m;
}

/** Spans along the cut axis covered by a long straight ink line across them (a chart axis, the edge of a photo): never cut inside */
function protectedSpans(mask, w, box, horizontal) {
  const along = horizontal ? box.h : box.w, across = horizontal ? box.w : box.h;
  const minRun = Math.max(60, Math.round(along * 0.2));
  const spans = [];
  for (let k = 0; k < across; k++) {
    let run = 0, start = 0;
    for (let i = 0; i <= along; i++) {
      const x = horizontal ? box.x + k : box.x + i, y = horizontal ? box.y + i : box.y + k;
      const ink = i < along && !mask[y * w + x];
      if (ink) { if (!run) start = i; run++; } else { if (run >= minRun) spans.push([start + 2, start + run - 2]); run = 0; }
    }
  }
  return spans;
}

function gutters(mask, w, box, horizontal) {
  // horizontal=true: find gutter rows inside box
  const len = horizontal ? box.h : box.w;
  const span = horizontal ? box.w : box.h;
  const prof = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let c = 0;
    for (let j = 0; j < span; j++) {
      const x = horizontal ? box.x + j : box.x + i, y = horizontal ? box.y + i : box.y + j;
      c += mask[y * w + x];
    }
    prof[i] = c / span;
  }
  const runs = [];
  let start = -1;
  const minRun = Math.max(2, Math.round(len * 0.008));
  const spans = protectedSpans(mask, w, box, horizontal);
  const covered = (a, b) => spans.some(([s0, s1]) => a >= s0 && b <= s1);
  for (let i = 0; i <= len; i++) {
    const g = i < len && prof[i] >= 0.985;
    if (g && start < 0) start = i;
    if (!g && start >= 0) { if (i - start >= minRun && !covered(start, i)) runs.push([start, i]); start = -1; }
  }
  // Cut positions between content blocks (ignore margins)
  const cuts = [];
  let last = 0;
  for (const [a, b] of runs) {
    if (a <= 0 || b >= len) continue;
    cuts.push([last, a]); last = b;
  }
  cuts.push([last, len]);
  return cuts.filter(([a, b]) => b - a > 0);
}

function contentFraction(mask, w, box) {
  let c = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) c += 1 - mask[y * w + x];
  return c / (box.w * box.h);
}

/** A chart: mostly background with a long horizontal and a long vertical line (axes) - its bars must not be cut apart */
function isChart(mask, w, box) {
  if (box.w < 90 || box.h < 70 || contentFraction(mask, w, box) > 0.45) return false;
  let hAxis = false, vAxis = false;
  for (let y = box.y; y < box.y + box.h && !hAxis; y++) { let c = 0; for (let x = box.x; x < box.x + box.w; x++) c += 1 - mask[y * w + x]; if (c >= box.w * 0.6) hAxis = true; }
  for (let x = box.x; x < box.x + box.w && !vAxis; x++) { let c = 0; for (let y = box.y; y < box.y + box.h; y++) c += 1 - mask[y * w + x]; if (c >= box.h * 0.6) vAxis = true; }
  return hAxis && vAxis;
}

function trim(mask, w, box) {
  let { x, y, w: bw, h: bh } = box;
  const rowEmpty = yy => { for (let xx = x; xx < x + bw; xx++) if (!mask[yy * w + xx]) return false; return true; };
  const colEmpty = xx => { for (let yy = y; yy < y + bh; yy++) if (!mask[yy * w + xx]) return false; return true; };
  while (bh > 1 && rowEmpty(y)) { y++; bh--; }
  while (bh > 1 && rowEmpty(y + bh - 1)) bh--;
  while (bw > 1 && colEmpty(x)) { x++; bw--; }
  while (bw > 1 && colEmpty(x + bw - 1)) bw--;
  return { x, y, w: bw, h: bh };
}

/**
 * Panels of a figure as boxes in original pixel coordinates.
 */
export function splitPanels(img, { maxDim = 900, minSize = 40 } = {}) {
  const s = Math.min(1, maxDim / Math.max(img.width, img.height));
  const small = s < 1 ? resizeRGBA(img, img.width * s, img.height * s) : img;
  const w = small.width, h = small.height;
  const mask = bgMask(small, background(small));
  const out = [];
  const min = Math.max(minSize * s, 24);
  (function cut(box, horizontal, depth) {
    box = trim(mask, w, box);
    if (box.w < min || box.h < min) return;
    if (depth > 0 && !isChart(mask, w, box)) {
      const parts = gutters(mask, w, box, horizontal);
      if (parts.length > 1) {
        for (const [a, b] of parts) cut(horizontal ? { x: box.x, y: box.y + a, w: box.w, h: b - a } : { x: box.x + a, y: box.y, w: b - a, h: box.h }, !horizontal, depth - 1);
        return;
      }
      const other = gutters(mask, w, box, !horizontal);
      if (other.length > 1) {
        for (const [a, b] of other) cut(!horizontal ? { x: box.x, y: box.y + a, w: box.w, h: b - a } : { x: box.x + a, y: box.y, w: b - a, h: box.h }, horizontal, depth - 1);
        return;
      }
    }
    const cf = contentFraction(mask, w, box);
    // text labels and empty areas are dropped; a large box with thin content is a chart (axes, bars, lines)
    if (cf < 0.12 && !(cf >= 0.012 && box.w >= 90 * s && box.h >= 70 * s)) return;
    out.push(box);
  })({ x: 0, y: 0, w, h }, true, 6);
  const panels = out.map(b => ({ x: Math.floor(b.x / s), y: Math.floor(b.y / s), w: Math.ceil(b.w / s), h: Math.ceil(b.h / s) }))
    .map(b => ({ x: b.x, y: b.y, w: Math.min(b.w, img.width - b.x), h: Math.min(b.h, img.height - b.y) }));
  // Sort in reading order: rows (by top) then left to right
  panels.sort((a, b) => (Math.abs(a.y - b.y) < Math.min(a.h, b.h) * 0.5 ? a.x - b.x : a.y - b.y));
  return panels.length ? panels : [{ x: 0, y: 0, w: img.width, h: img.height }];
}

// ------------------------------------------------------------------ figure type

export function classify(img, box) {
  const s = Math.min(1, 160 / Math.max(box.w, box.h));
  const sm = resizeRGBA(img, box.w * s, box.h * s, box);
  const n = sm.width * sm.height;
  let white = 0, dark = 0, chroma = 0, pink = 0;
  const colors = new Set();
  for (let i = 0; i < n; i++) {
    const r = sm.data[i * 4], g = sm.data[i * 4 + 1], b = sm.data[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mn > 235) white++;
    if (mx < 40) dark++;
    chroma += mx - mn;
    if (r > g + 20 && b > g + 10 && mn > 60) pink++;
    colors.add(`${r >> 5},${g >> 5},${b >> 5}`);
  }
  const wf = white / n, df = dark / n, ch = chroma / n, pf = pink / n;
  const aspect = Math.max(box.w / box.h, box.h / box.w);
  // Row-profile banding: blots/gels have horizontal dark bands on a light background
  const gray = toGray(sm);
  let rowVar = 0;
  const rows = [];
  for (let y = 0; y < gray.h; y++) { let a = 0; for (let x = 0; x < gray.w; x++) a += gray.g[y * gray.w + x]; rows.push(a / gray.w); }
  const rs = stats(rows); rowVar = rs.std;
  if (wf > 0.55 && colors.size < 70) return 'chart';
  if (ch < 14 && (aspect > 1.6 || rowVar > 18) && df < 0.5 && wf < 0.6) return 'blot';
  if (pf > 0.25) return 'histology';
  if (df > 0.35 && ch > 18) return 'fluorescence';
  if (ch < 14) return 'grayscale';
  return 'photo';
}

// ------------------------------------------------------------------ perceptual hash

const DCT32 = (() => {
  const N = 32, c = new Float32Array(8 * N);
  for (let u = 0; u < 8; u++) for (let x = 0; x < N; x++) c[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  return c;
})();

/** 64-bit DCT hash of a 32x32 array, as two uint32 */
function phash32(a) {
  const N = 32, tmp = new Float32Array(8 * N), co = new Float32Array(64);
  for (let u = 0; u < 8; u++) for (let y = 0; y < N; y++) { let s = 0; for (let x = 0; x < N; x++) s += a.g[y * N + x] * DCT32[u * N + x]; tmp[u * N + y] = s; }
  for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) { let s = 0; for (let y = 0; y < N; y++) s += tmp[u * N + y] * DCT32[v * N + y]; co[v * 8 + u] = s; }
  const vals = Array.from(co).slice(1);
  const med = [...vals].sort((p, q) => p - q)[31];
  let hi = 0, lo = 0;
  for (let i = 0; i < 64; i++) {
    const bit = i === 0 ? 0 : co[i] > med ? 1 : 0;
    if (i < 32) hi = (hi | (bit << i)) >>> 0; else lo = (lo | (bit << (i - 32))) >>> 0;
  }
  return [hi, lo];
}

const popcnt = v => { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
export const hamming64 = (a, b) => popcnt(a[0] ^ b[0]) + popcnt(a[1] ^ b[1]);
export const hashHex = h => h[0].toString(16).padStart(8, '0') + h[1].toString(16).padStart(8, '0');
export const hexHash = s => [parseInt(s.slice(0, 8), 16) >>> 0, parseInt(s.slice(8, 16), 16) >>> 0];

function normalized(a) {
  const { mean, std } = stats(a.g);
  const out = new Float32Array(a.g.length);
  for (let i = 0; i < out.length; i++) out[i] = (a.g[i] - mean) / (std || 1);
  return out;
}

function ncc(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

// ------------------------------------------------------------------ ORB features

const PATCH = 15;
const BRIEF = (() => {
  // Fixed pseudo-random sampling pattern (seeded) inside a 31x31 patch, Gaussian-distributed
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => { const u = Math.max(1e-9, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const p = new Int8Array(256 * 4);
  for (let i = 0; i < 256; i++) for (let k = 0; k < 4; k++) p[i * 4 + k] = Math.max(-PATCH, Math.min(PATCH, Math.round(gauss() * PATCH / 2.5)));
  return p;
})();

const FAST_CIRCLE = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];

function fastCorners(img, t, border) {
  const { w, h, g } = img;
  const out = [];
  for (let y = border; y < h - border; y++) {
    for (let x = border; x < w - border; x++) {
      const p = g[y * w + x];
      // quick rejection with 4 compass points
      const a = g[(y - 3) * w + x], b = g[y * w + x + 3], c = g[(y + 3) * w + x], d = g[y * w + x - 3];
      let brighter = (a > p + t) + (b > p + t) + (c > p + t) + (d > p + t);
      let darker = (a < p - t) + (b < p - t) + (c < p - t) + (d < p - t);
      if (brighter < 3 && darker < 3) continue;
      // full segment test: 9 contiguous
      let run = 0, best = 0, runD = 0, bestD = 0;
      for (let k = 0; k < 25; k++) {
        const [dx, dy] = FAST_CIRCLE[k % 16];
        const v = g[(y + dy) * w + x + dx];
        if (v > p + t) { run++; best = Math.max(best, run); } else run = 0;
        if (v < p - t) { runD++; bestD = Math.max(bestD, runD); } else runD = 0;
      }
      if (best >= 9 || bestD >= 9) out.push({ x, y });
    }
  }
  return out;
}

function harris(img, x, y) {
  const { w, g } = img;
  let a = 0, b = 0, c = 0;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const i = (y + dy) * w + x + dx;
    const ix = (g[i + 1] - g[i - 1]) / 2, iy = (g[i + w] - g[i - w]) / 2;
    a += ix * ix; b += iy * iy; c += ix * iy;
  }
  return a * b - c * c - 0.04 * (a + b) * (a + b);
}

function orientation(img, x, y) {
  const { w, g } = img;
  let m01 = 0, m10 = 0;
  for (let dy = -PATCH; dy <= PATCH; dy++) {
    const span = Math.floor(Math.sqrt(PATCH * PATCH - dy * dy));
    for (let dx = -span; dx <= span; dx++) { const v = g[(y + dy) * w + x + dx]; m10 += dx * v; m01 += dy * v; }
  }
  return Math.atan2(m01, m10);
}

/**
 * ORB keypoints + 256-bit rBRIEF descriptors on an image pyramid.
 * Returns { pts: [{x, y, angle, scale}], desc: Uint32Array(n*8) } in the coordinates of `img`.
 */
export function orb(img, opts = {}) {
  // Thin strips (blot / gel lanes are often 50-90 px high) have no pyramid levels at 64 px: enlarge them first (bilinear),
  // find the keypoints on the larger copy and report them in the coordinates of the original.
  const small = Math.min(img.w, img.h);
  if (small >= 96) return orbCore(img, opts);
  const k = Math.min(4, 96 / Math.max(8, small));
  const up = upscaleGray(img, k);
  const r = orbCore(up, opts);
  return { pts: r.pts.map(p => ({ ...p, x: p.x / k, y: p.y / k })), desc: r.desc };
}

function upscaleGray(src, k) {
  const nw = Math.round(src.w * k), nh = Math.round(src.h * k);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const fy = Math.min(src.h - 1, Math.max(0, (y + 0.5) / k - 0.5)), y0 = Math.floor(fy), y1 = Math.min(src.h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.min(src.w - 1, Math.max(0, (x + 0.5) / k - 0.5)), x0 = Math.floor(fx), x1 = Math.min(src.w - 1, x0 + 1), tx = fx - x0;
      const a = src.g[y0 * src.w + x0] * (1 - tx) + src.g[y0 * src.w + x1] * tx, b = src.g[y1 * src.w + x0] * (1 - tx) + src.g[y1 * src.w + x1] * tx;
      out[y * nw + x] = a * (1 - ty) + b * ty;
    }
  }
  return { w: nw, h: nh, g: out };
}

function orbCore(img, { max = 260, threshold = 18 } = {}) {
  const levels = [];
  let cur = img, scale = 1;
  while (Math.min(cur.w, cur.h) >= 64 && levels.length < 5) {
    levels.push({ img: cur, scale, smooth: blur(cur, 2) });
    scale *= 0.8;
    cur = resizeGray(img, img.w * scale, img.h * scale);
  }
  const border = PATCH + 8;
  let cands = [];
  for (const L of levels) {
    // Adaptive threshold: smooth (enlarged, blurred) images have weak corners
    let corners = [];
    for (const t of [threshold, 12, 8, 5, 3]) {
      corners = fastCorners(L.img, t, border);
      if (corners.length >= 80) break;
    }
    for (const c of corners) cands.push({ ...c, L, score: harris(L.img, c.x, c.y) });
  }
  // non-maximum suppression per level (3px), then the strongest overall
  cands.sort((a, b) => b.score - a.score);
  const taken = new Map();
  const kept = [];
  for (const c of cands) {
    const key = c.L.scale;
    if (!taken.has(key)) taken.set(key, new Set());
    const set = taken.get(key);
    const cell = `${c.x >> 2},${c.y >> 2}`;
    if (set.has(cell)) continue;
    set.add(cell);
    kept.push(c);
    if (kept.length >= max) break;
  }
  const pts = [];
  const desc = new Uint32Array(kept.length * 8);
  kept.forEach((c, n) => {
    const angle = orientation(c.L.img, c.x, c.y);
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const { w, h, g } = c.L.smooth;
    const at = (dx, dy) => {
      const rx = Math.round(c.x + dx * ca - dy * sa), ry = Math.round(c.y + dx * sa + dy * ca);
      return g[Math.min(h - 1, Math.max(0, ry)) * w + Math.min(w - 1, Math.max(0, rx))];
    };
    for (let i = 0; i < 256; i++) {
      if (at(BRIEF[i * 4], BRIEF[i * 4 + 1]) < at(BRIEF[i * 4 + 2], BRIEF[i * 4 + 3])) desc[n * 8 + (i >> 5)] |= 1 << (i & 31);
    }
    pts.push({ x: c.x / c.L.scale, y: c.y / c.L.scale, angle, scale: 1 / c.L.scale });
  });
  return { pts, desc };
}

function dist256(A, i, B, j) {
  let d = 0;
  for (let k = 0; k < 8; k++) d += popcnt(A[i * 8 + k] ^ B[j * 8 + k]);
  return d;
}

/** Mutual-best matches with a ratio test. self=true excludes trivial matches inside one image. */
export function matchFeatures(A, B, { maxDist = 64, ratio = 0.85, self = false, minShift = 20 } = {}) {
  const na = A.pts.length, nb = B.pts.length;
  if (!na || !nb) return [];
  const bestAB = new Int32Array(na).fill(-1), bestBA = new Int32Array(nb).fill(-1), dAB = new Int32Array(na), dBA = new Int32Array(nb).fill(999);
  for (let i = 0; i < na; i++) {
    let b1 = 999, b2 = 999, bj = -1;
    for (let j = 0; j < nb; j++) {
      if (self && (i === j || Math.hypot(A.pts[i].x - B.pts[j].x, A.pts[i].y - B.pts[j].y) < minShift)) continue;
      const d = dist256(A.desc, i, B.desc, j);
      if (d < b1) { b2 = b1; b1 = d; bj = j; } else if (d < b2) b2 = d;
      if (d < dBA[j]) { dBA[j] = d; bestBA[j] = i; }
    }
    if (bj >= 0 && b1 <= maxDist && b1 < ratio * b2) { bestAB[i] = bj; dAB[i] = b1; }
  }
  const out = [];
  for (let i = 0; i < na; i++) {
    const j = bestAB[i];
    if (j >= 0 && (self || bestBA[j] === i)) out.push({ i, j, d: dAB[i] });
  }
  return out;
}

/** RANSAC similarity transform (scale, rotation, translation) A -> B */
export function ransac(matches, A, B, { iters = 400, tol = 4, minScale = 0.25, maxScale = 4, minShift = 0 } = {}) {
  if (matches.length < 4) return null;
  let seed = 98765;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let best = null;
  for (let it = 0; it < iters; it++) {
    const m1 = matches[rnd(matches.length)], m2 = matches[rnd(matches.length)];
    if (m1 === m2) continue;
    const a1 = A.pts[m1.i], a2 = A.pts[m2.i], b1 = B.pts[m1.j], b2 = B.pts[m2.j];
    const dax = a2.x - a1.x, day = a2.y - a1.y, dbx = b2.x - b1.x, dby = b2.y - b1.y;
    const la = Math.hypot(dax, day), lb = Math.hypot(dbx, dby);
    if (la < 8 || lb < 8) continue;
    const s = lb / la;
    if (s < minScale || s > maxScale) continue;
    const th = Math.atan2(dby, dbx) - Math.atan2(day, dax);
    const c = s * Math.cos(th), sn = s * Math.sin(th);
    const tx = b1.x - (c * a1.x - sn * a1.y), ty = b1.y - (sn * a1.x + c * a1.y);
    if (minShift && Math.hypot(tx + (c - 1) * a1.x - sn * a1.y, ty + sn * a1.x + (c - 1) * a1.y) < minShift && Math.abs(th) < 0.05 && Math.abs(s - 1) < 0.05) continue;
    const inl = [];
    for (const m of matches) {
      const a = A.pts[m.i], b = B.pts[m.j];
      const px = c * a.x - sn * a.y + tx, py = sn * a.x + c * a.y + ty;
      if (Math.hypot(px - b.x, py - b.y) <= tol * Math.max(1, s)) inl.push(m);
    }
    if (!best || inl.length > best.inliers.length) best = { inliers: inl, scale: s, rotation: th, tx, ty };
  }
  return best;
}

function bbox(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

// ------------------------------------------------------------------ copy-move by DCT blocks

const DCT8 = (() => { const c = new Float32Array(64); for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) c[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u ? Math.sqrt(2 / 8) : Math.sqrt(1 / 8)); return c; })();
const ZIG = [[0, 0], [0, 1], [1, 0], [2, 0], [1, 1], [0, 2], [0, 3], [1, 2], [2, 1], [3, 0]];

/** Classic block-matching copy-move detection on a reduced grayscale panel */
export function copyMoveBlocks(img, { step = 2, minShift = 16, minBlocks = 30, quant = 6, neigh = 4, minVar = 40, verify = false } = {}) {
  const { w, h, g } = img;
  const feats = [];
  const tmp = new Float32Array(64);
  for (let y = 0; y + 8 <= h; y += step) {
    for (let x = 0; x + 8 <= w; x += step) {
      let s = 0, s2 = 0;
      for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) { const v = g[(y + yy) * w + x + xx]; s += v; s2 += v * v; }
      const varc = s2 / 64 - (s / 64) ** 2;
      if (varc < minVar) continue; // flat block: background, would match everywhere
      for (let u = 0; u < 8; u++) for (let yy = 0; yy < 8; yy++) { let a = 0; for (let xx = 0; xx < 8; xx++) a += g[(y + yy) * w + x + xx] * DCT8[u * 8 + xx]; tmp[u * 8 + yy] = a; }
      const f = ZIG.map(([u, v]) => { let a = 0; for (let yy = 0; yy < 8; yy++) a += tmp[u * 8 + yy] * DCT8[v * 8 + yy]; return Math.round(a / (u + v === 0 ? quant * 2.7 : quant)); });
      feats.push({ x, y, f, k: f.join(',') });
    }
  }
  feats.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const shifts = new Map();
  for (let i = 0; i < feats.length; i++) {
    for (let j = i + 1; j < Math.min(feats.length, i + neigh) && feats[j].k === feats[i].k; j++) {
      let dx = feats[j].x - feats[i].x, dy = feats[j].y - feats[i].y;
      if (Math.hypot(dx, dy) < minShift) continue;
      let src = feats[i], dst = feats[j];
      if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; [src, dst] = [dst, src]; }
      const key = `${Math.round(dx / 2)},${Math.round(dy / 2)}`;
      if (!shifts.has(key)) shifts.set(key, { dx, dy, pairs: [] });
      shifts.get(key).pairs.push([src, dst]);
    }
  }
  const out = [];
  for (const s of shifts.values()) {
    if (s.pairs.length < minBlocks) continue;
    const a = bbox(s.pairs.map(p => ({ x: p[0].x + 4, y: p[0].y + 4 }))), b = bbox(s.pairs.map(p => ({ x: p[1].x + 4, y: p[1].y + 4 })));
    // Loose block matching proposes candidates; a real copy must also agree pixel by pixel (picture and noise residual)
    let px = null;
    if (verify) {
      px = regionAgreement(img, a, b);
      if (!px || px.lp < 0.9 || px.hp < 0.45) continue;
    }
    out.push({ pixel: px, blocks: s.pairs.length, dx: s.dx, dy: s.dy, a: { x: a.x - 4, y: a.y - 4, w: a.w + 8, h: a.h + 8 }, b: { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 } });
  }
  return out.sort((p, q) => q.blocks - p.blocks).slice(0, 3);
}

/** Correlation of the picture (lp) and of its noise residual (hp) between two same-size boxes of one image */
function regionAgreement(img, a, b) {
  const w = Math.round(Math.min(a.w, b.w)), h = Math.round(Math.min(a.h, b.h));
  if (w < 12 || h < 12) return null;
  const sm = img._sm || (img._sm = blur(img, 1.5));
  const at = (src, x, y) => src[Math.min(img.h - 1, Math.max(0, y)) * img.w + Math.min(img.w - 1, Math.max(0, x))];
  const stat = (x1, y1, x2, y2, hp) => {
    let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let va = at(img.g, Math.round(x1) + x, Math.round(y1) + y), vb = at(img.g, Math.round(x2) + x, Math.round(y2) + y);
      if (hp) { va -= at(sm.g, Math.round(x1) + x, Math.round(y1) + y); vb -= at(sm.g, Math.round(x2) + x, Math.round(y2) + y); }
      n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
    const den = Math.sqrt(Math.max(1e-9, (n * saa - sa * sa) * (n * sbb - sb * sb)));
    return (n * sab - sa * sb) / den;
  };
  return { lp: stat(a.x, a.y, b.x, b.y, false), hp: stat(a.x, a.y, b.x, b.y, true) };
}

// ------------------------------------------------------------------ analysis

const WORK = 360; // analysis size (longest side) for keypoints
const describeTransform = t => {
  const deg = ((Math.round(t.rotation * 180 / Math.PI) % 360) + 360) % 360;
  const parts = [];
  if (t.flip) parts.push('mirrored');
  if (deg > 3 && deg < 357) parts.push(`rotated ${deg > 180 ? deg - 360 : deg}°`);
  if (Math.abs(t.scale - 1) > 0.08) parts.push(`resized ×${t.scale.toFixed(2)}`);
  return parts.length ? parts.join(', ') : 'same orientation and size';
};

/**
 * Colour signature of a panel's signal (pixels clearly above black): 'gray', or the dominant channel(s) ('r', 'g', 'b',
 * 'rg' ...), and whether the background is dark (fluorescence). Two views of one microscopy field in different channels
 * (a merge and its green channel, the red and the green channel) match as images but are normal figure practice.
 */
export function colourOf(img, box) {
  const sm = resizeRGBA(img, Math.min(96, box.w), Math.min(96, box.h), box);
  let r = 0, g = 0, b = 0, n = 0, lum = 0;
  for (let i = 0; i < sm.width * sm.height; i++) {
    const R = sm.data[i * 4], G = sm.data[i * 4 + 1], B = sm.data[i * 4 + 2];
    lum += (R + G + B) / 3;
    if (Math.max(R, G, B) < 40) continue;
    r += R; g += G; b += B; n++;
  }
  const dark = lum / Math.max(1, sm.width * sm.height) < 60;
  if (!n) return { cls: 'gray', dark };
  const c = [r / n, g / n, b / n], mx = Math.max(...c), mn = Math.min(...c);
  if ((mx - mn) / Math.max(1, mx) < 0.15) return { cls: 'gray', dark };
  return { cls: ['r', 'g', 'b'].filter((_, i) => c[i] >= 0.75 * mx).join(''), dark };
}

/** Same field in different colour channels: the colour classes differ and at least one is a dark-field (fluorescence) image */
const channelViews = (A, B) => !!(A.colour && B.colour && A.colour.cls !== B.colour.cls && (A.colour.dark || B.colour.dark || A.type === 'fluorescence' || B.type === 'fluorescence'));

/**
 * Pixel-level check of a whole-panel match at 128 x 128 with frame and border trimmed (8% each side): picture
 * correlation (lp) and fine-noise correlation (hp). Copies of one image agree on both; two different images that merely
 * look alike (dark fields, blots in identical frames) agree on the picture but not on the noise.
 */
function verifyWhole(A, B, k) {
  const N = 128, m = Math.round(N * 0.08);
  const a = resizeGray(A.workGray, N, N), b = orient(resizeGray(B.workGray, N, N), k % 4, k >= 4);
  const ha = blur(a, 1.2), hb = blur(b, 1.2);
  const corr = (x, y) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let yy = m; yy < N - m; yy++) for (let xx = m; xx < N - m; xx++) { const i = yy * N + xx, u = x(i), v = y(i); n++; sx += u; sy += v; sxx += u * u; syy += v * v; sxy += u * v; }
    return (n * sxy - sx * sy) / Math.sqrt(Math.max(1e-9, (n * sxx - sx * sx) * (n * syy - sy * sy)));
  };
  return { lp: corr(i => ha.g[i], i => hb.g[i]), hp: corr(i => a.g[i] - ha.g[i], i => b.g[i] - hb.g[i]) };
}

/** Pixel check of the regions matched by keypoints (upright or mirrored matches only): correlation of the two crops */
function verifyRegions(A, B, part) {
  const rot = Math.abs(((part.transform.rotation % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
  if (rot > 0.12) return null;                                              // rotated: not compared this simply
  const N = 48;
  const a = resizeGray(A.workGray, N, N, part.regionA);
  let b = resizeGray(B.workGray, N, N, part.regionB);
  if (part.transform.flip) b = flipH(b);
  return ncc(normalized(a), normalized(b));
}

/** Prepare one panel: reduced grayscale, hashes in 8 orientations, ORB features (normal and mirrored) */
export function preparePanel(img, box, meta, gray = null) {
  gray = gray || toGray(img);
  const type = classify(img, box);
  const s = Math.min(1, WORK / Math.max(box.w, box.h));
  const work = resizeGray(gray, box.w * s, box.h * s, box);
  const sq = resizeGray(gray, 32, 32, box);
  const sq64 = resizeGray(gray, 64, 64, box);
  const st = stats(sq64.g);
  let whiteish = 0;
  for (const v of sq64.g) if (v > 235) whiteish++;
  const blank = st.std < 8 || whiteish / sq64.g.length > 0.93;
  const hashes = [];
  const sqNorm = [];
  for (const mirror of [false, true]) for (let k = 0; k < 4; k++) {
    hashes.push(phash32(orient(sq, k, mirror)));
    sqNorm.push(normalized(orient(sq64, k, mirror)));
  }
  const features = blank || type === 'chart' ? null : orb(work);
  const flipped = blank || type === 'chart' ? null : orb(flipH(work));
  return { ...meta, box, type, blank, colour: colourOf(img, box), scale: s, work: { w: work.w, h: work.h }, workGray: work, hashes, sqNorm, features, flipped, hash: hashHex(hashes[0]) };
}

/** Light-weight fingerprint of a panel (8 orientations of the 64-bit hash) - used where the full analysis is not needed */
export function hashPanel(img, box, gray = null) {
  gray = gray || toGray(img);
  const sq = resizeGray(gray, 32, 32, box);
  const out = [];
  for (const mirror of [false, true]) for (let k = 0; k < 4; k++) out.push(hashHex(phash32(orient(sq, k, mirror))));
  const sq64 = resizeGray(gray, 64, 64, box), st = stats(sq64.g);
  return { hashes: out, blank: st.std < 8 };
}

/**
 * Upright hashes of five crop windows of a panel (centre and the four corners, 75% of each side). Used by the reference
 * databases: a figure cropped from a published one matches a window of the original, and the reverse.
 */
export function windowHashes(gray, box, f = 0.75) {
  const w = Math.max(8, Math.round(box.w * f)), h = Math.max(8, Math.round(box.h * f));
  const dx = box.w - w, dy = box.h - h;
  return [[dx / 2, dy / 2], [0, 0], [dx, 0], [0, dy], [dx, dy]]
    .map(([x, y]) => hashHex(phash32(resizeGray(gray, 32, 32, { x: box.x + Math.round(x), y: box.y + Math.round(y), w, h }))));
}

function pairDuplicate(A, B) {
  // Whole-panel duplicate in any of 8 orientations
  let bestK = -1, bestD = 99;
  for (let k = 0; k < 8; k++) { const d = hamming64(A.hashes[0], B.hashes[k]); if (d < bestD) { bestD = d; bestK = k; } }
  if (bestD > 12) return null;
  const corr = ncc(A.sqNorm[0], B.sqNorm[bestK]);
  if (corr < (A.type === 'chart' || B.type === 'chart' ? 0.97 : 0.88)) return null;
  const mirror = bestK >= 4, rot = (bestK % 4) * 90;
  const scale = Math.sqrt((B.box.w * B.box.h) / (A.box.w * A.box.h));
  return { kind: 'duplicate', hamming: bestD, k: bestK, correlation: Math.round(corr * 100) / 100, transform: { rotation: (rot * Math.PI) / 180, flip: mirror, scale } };
}

function pairPartial(A, B) {
  if (!A.features || !B.features) return null;
  let best = null;
  for (const flip of [false, true]) {
    const FB = flip ? B.flipped : B.features;
    const matches = matchFeatures(A.features, FB);
    if (matches.length < 10) continue;
    const r = ransac(matches, A.features, FB);
    if (!r || r.inliers.length < 12) continue;
    const ptsA = r.inliers.map(m => A.features.pts[m.i]);
    const ptsB = r.inliers.map(m => { const p = FB.pts[m.j]; return flip ? { x: B.work.w - 1 - p.x, y: p.y } : p; });
    const ba = bbox(ptsA), bb = bbox(ptsB);
    const areaA = (ba.w * ba.h) / (A.work.w * A.work.h), areaB = (bb.w * bb.h) / (B.work.w * B.work.h);
    // labels, scale bars: a small matching patch needs many agreeing points to count (and is only "to check", never "strong")
    const strongPatch = r.inliers.length >= 15;
    if (Math.min(areaA, areaB) < (strongPatch ? 0.02 : 0.05) || ba.w < (strongPatch ? 22 : 30) || ba.h < (strongPatch ? 14 : 20) || bb.w < (strongPatch ? 22 : 30) || bb.h < (strongPatch ? 14 : 20)) continue;
    if (!best || r.inliers.length > best.inliers) best = { kind: 'partial', inliers: r.inliers.length, matches: matches.length, regionA: ba, regionB: bb, coverage: Math.round(Math.max(areaA, areaB) * 100), transform: { rotation: flip ? -r.rotation : r.rotation, flip, scale: r.scale } };
  }
  return best;
}

// ------------------------------------------------------------------ dense registration (smooth panels: blots, gels, strips)
// ORB finds too few keypoints on smooth blot strips. Here two panels of similar shape are laid on top of each other
// (small shifts, mirrored / rotated 180°) and compared pixel by pixel. Two different blots that merely look alike
// (a band at the same height) agree on the smooth picture but not on the noise, so the noise residual must agree too.

const REG = 120;
function regData(P) {
  if (P._reg) return P._reg;
  const s = Math.min(1, REG / Math.max(P.work.w, P.work.h));
  const lp = resizeGray(P.workGray, P.work.w * s, P.work.h * s);
  const sm = blur(lp, 1.5);
  const hp = { w: lp.w, h: lp.h, g: lp.g.map((v, i) => v - sm.g[i]) };
  let m = 0;
  for (const v of lp.g) m += v;
  m /= lp.g.length;
  let sd = 0;
  for (const v of lp.g) sd += (v - m) * (v - m);
  // background = the most common grey level; content = pixels clearly away from it (cells on a black field, bands on a white membrane)
  const hist = new Uint32Array(64);
  for (const v of lp.g) hist[Math.min(63, Math.max(0, v >> 2))]++;
  let mode = 0;
  for (let i = 1; i < 64; i++) if (hist[i] > hist[mode]) mode = i;
  const bg = mode * 4 + 2;
  const dev = Float32Array.from(lp.g, v => Math.abs(v - bg)).sort();
  const top = dev[Math.min(dev.length - 1, Math.floor(dev.length * 0.98))];
  P._reg = { lp, hp, sd: Math.sqrt(sd / lp.g.length), bg, top };
  return P._reg;
}

const contentMask = (src, bg, top) => { const m = new Uint8Array(src.g.length); for (let i = 0; i < m.length; i++) m[i] = Math.abs(src.g[i] - bg) > 0.25 * top ? 1 : 0; return m; };
const flipMask = (m, w, h, fh, fv) => { const o = new Uint8Array(m.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = m[(fv ? h - 1 - y : y) * w + (fh ? w - 1 - x : x)]; return o; };

/** NCC over content pixels only: union of both masks for the picture, intersection for the noise residual */
function nccMaskedAt(a, b, ma, mb, w, h, dx, dy, mode) {
  const x0 = Math.max(0, dx), x1 = Math.min(w, w + dx), y0 = Math.max(0, dy), y1 = Math.min(h, h + dy);
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const ia = y * w + x, ib = (y - dy) * w + (x - dx);
    const ina = ma[ia], inb = mb[ib];
    if (mode === 'union' ? !(ina || inb) : !(ina && inb)) continue;
    const va = a[ia], vb = b[ib];
    n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
  }
  if (n < 60) return null;
  return { c: (n * sab - sa * sb) / Math.sqrt(Math.max(1e-9, (n * saa - sa * sa) * (n * sbb - sb * sb))), n };
}

const flipV = src => { const { w, h, g } = src; const out = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = g[(h - 1 - y) * w + x]; return { w, h, g: out }; };
const sameSize = (src, w, h) => (src.w === w && src.h === h ? src : resizeGray(src, w, h));

function nccAt(a, b, w, h, dx, dy) {
  const x0 = Math.max(0, dx), x1 = Math.min(w, w + dx), y0 = Math.max(0, dy), y1 = Math.min(h, h + dy);
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y++) {
    let ia = y * w + x0, ib = (y - dy) * w + (x0 - dx);
    for (let x = x0; x < x1; x++, ia++, ib++) { const va = a[ia], vb = b[ib]; n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb; }
  }
  const den = Math.sqrt(Math.max(1e-9, (n * saa - sa * sa) * (n * sbb - sb * sb)));
  return { c: (n * sab - sa * sb) / den, overlap: n / (w * h), x0, x1, y0, y1 };
}

function pairRegistered(A, B) {
  if (!A.workGray || !B.workGray || A.type === 'chart' || B.type === 'chart') return null;
  const ra = A.box.w / A.box.h, rb = B.box.w / B.box.h;
  if (Math.abs(Math.log(ra / rb)) > 0.2) return null;                       // different shape
  const a = regData(A), b0 = regData(B);
  if (a.sd < 6 || b0.sd < 6) return null;                                   // flat
  // a cheap gate on the 32 x 32 hash keeps this off almost all unrelated pairs
  let hd = 99;
  for (let k = 0; k < 8; k++) hd = Math.min(hd, hamming64(A.hashes[0], B.hashes[k]));
  if (hd > 26) return null;
  const { w, h } = a.lp;
  const variants = [
    { name: 'same', lp: sameSize(b0.lp, w, h), hp: sameSize(b0.hp, w, h), flip: false, rot: 0 },
    { name: 'mirror', lp: flipH(sameSize(b0.lp, w, h)), hp: flipH(sameSize(b0.hp, w, h)), flip: true, rot: 0 },
    { name: 'flipV', lp: flipV(sameSize(b0.lp, w, h)), hp: flipV(sameSize(b0.hp, w, h)), flip: true, rot: Math.PI },
    { name: 'rot180', lp: flipV(flipH(sameSize(b0.lp, w, h))), hp: flipV(flipH(sameSize(b0.hp, w, h))), flip: false, rot: Math.PI }
  ];
  const S = Math.max(3, Math.round(0.08 * Math.min(w, h)));
  let best = null;
  for (const v of variants) {
    // coarse search every 2 px, then refine
    let loc = null;
    for (let dy = -S; dy <= S; dy += 2) for (let dx = -S * 2; dx <= S * 2; dx += 2) {
      const r = nccAt(a.lp.g, v.lp.g, w, h, dx, dy);
      if (r && r.overlap >= 0.45 && (!loc || r.c > loc.c)) loc = { ...r, dx, dy };
    }
    if (!loc) continue;
    for (let dy = loc.dy - 1; dy <= loc.dy + 1; dy++) for (let dx = loc.dx - 1; dx <= loc.dx + 1; dx++) {
      const r = nccAt(a.lp.g, v.lp.g, w, h, dx, dy);
      if (r && r.overlap >= 0.45 && r.c > loc.c) loc = { ...r, dx, dy };
    }
    if (!best || loc.c > best.c) best = { ...loc, v };
  }
  if (!best || best.c < 0.9) return null;
  // the match must hold on the content itself, not on a shared empty background
  const mA = contentMask(a.lp, a.bg, a.top);
  const mB0 = contentMask(sameSize(b0.lp, w, h), b0.bg, b0.top);
  const mB = flipMask(mB0, w, h, best.v.name === 'mirror' || best.v.name === 'rot180', best.v.name === 'flipV' || best.v.name === 'rot180');
  // frames, axes and panel borders are shared by different images of one figure: leave out an 8% margin
  const mg = Math.max(2, Math.round(0.08 * Math.min(w, h)));
  for (const m of [mA, mB]) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < mg || y < mg || x >= w - mg || y >= h - mg) m[y * w + x] = 0;
  let contentPx = 0;
  for (const v of mA) contentPx += v;
  if (a.top < 20 || b0.top < 20 || contentPx < 0.03 * w * h) return null;
  const lpc = nccMaskedAt(a.lp.g, best.v.lp.g, mA, mB, w, h, best.dx, best.dy, 'union');
  if (!lpc || lpc.c < 0.88) return null;
  const hpr = nccMaskedAt(a.hp.g, best.v.hp.g, mA, mB, w, h, best.dx, best.dy, 'both');
  if (!hpr || hpr.c < 0.5) return null;                                     // same look, different noise: different image
  const sx = A.work.w / w, sy = A.work.h / h;
  const regionA = { x: best.x0 * sx, y: best.y0 * sy, w: (best.x1 - best.x0) * sx, h: (best.y1 - best.y0) * sy };
  const bx0 = best.x0 - best.dx, bx1 = best.x1 - best.dx, by0 = best.y0 - best.dy, by1 = best.y1 - best.dy;
  const tx = B.work.w / w, ty = B.work.h / h;
  const regionB = { x: bx0 * tx, y: by0 * ty, w: (bx1 - bx0) * tx, h: (by1 - by0) * ty };
  return { kind: best.overlap >= 0.85 && Math.abs(best.dx) + Math.abs(best.dy) <= 4 ? 'duplicate' : 'partial', correlation: Math.round(best.c * 100) / 100, noise: Math.round(hpr.c * 100) / 100, overlap: best.overlap, regionA, regionB,
    transform: { rotation: best.v.rot, flip: best.v.flip, scale: Math.sqrt((B.box.w * B.box.h) / (A.box.w * A.box.h)) } };
}

function selfClone(P) {
  const out = [];
  if (P.features && P.features.pts.length >= 20) {
    const matches = matchFeatures(P.features, P.features, { self: true, minShift: 24, ratio: 0.8, maxDist: 50 });
    if (matches.length >= 8) {
      const r = ransac(matches, P.features, P.features, { minShift: 24 });
      // BioFors IDD: annotated clones had 14+ agreeing points, clean images at most 11
      if (r && r.inliers.length >= 13) {
        const a = bbox(r.inliers.map(m => P.features.pts[m.i])), b = bbox(r.inliers.map(m => P.features.pts[m.j]));
        const overlap = !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
        if (!overlap && a.w > 12 && a.h > 12) out.push({ kind: 'clone', method: 'keypoints', inliers: r.inliers.length, regionA: a, regionB: b, transform: { rotation: r.rotation, flip: false, scale: r.scale } });
      }
    }
  }
  if (!P.blank && P.type !== 'chart') {
    // tolerant block matching (survives JPEG recompression), every candidate verified pixel by pixel
    for (const c of copyMoveBlocks(P.workGray, { quant: 20, neigh: 12, minBlocks: 15, minVar: 15, verify: true })) {
      // the copied area must also share its fine noise; repeated textures (membrane, tissue) match only in the picture
      if ((c.pixel?.hp ?? 1) < 0.55) continue;
      if (out.some(o => Math.abs(o.regionA.x - c.a.x) < 20 && Math.abs(o.regionA.y - c.a.y) < 20)) continue;
      out.push({ kind: 'clone', method: 'blocks', blocks: c.blocks, pixel: c.pixel, regionA: c.a, regionB: c.b, transform: { rotation: 0, flip: false, scale: 1 } });
    }
  }
  return out;
}

/** Map a box in panel work coordinates to original image pixels */
const toImage = (P, r) => ({ x: Math.round(P.box.x + r.x / P.scale), y: Math.round(P.box.y + r.y / P.scale), w: Math.round(r.w / P.scale), h: Math.round(r.h / P.scale) });

/**
 * Analyse prepared panels. Returns findings:
 * { kind: duplicate|partial|clone, level: high|medium, a: { panel, box }, b: { panel, box }, transform, description, score }
 */
const CHANNEL_NOTE = ' - shown in different colour channels: probably one microscopy field as a merge and single channels, which is normal; a problem only if the legend calls them different samples';

export function findIssues(panels, progress = () => {}) {
  const findings = [];
  const usable = panels.filter(p => !p.blank);
  const pairs = usable.length * (usable.length - 1) / 2;
  let done = 0;
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const A = usable[i], B = usable[j];
      done++;
      if (done % 20 === 0) progress(done / Math.max(1, pairs));
      const channels = channelViews(A, B);
      const dup = pairDuplicate(A, B);
      if (dup) {
        // a strong finding needs the full-resolution picture and its fine noise to agree, not just the 64 x 64 thumbnails
        const v = A.type === 'chart' || B.type === 'chart' ? null : verifyWhole(A, B, dup.k);
        const strong = !!v && v.lp >= 0.85 && v.hp >= 0.5 && !channels;
        if (!v || v.lp >= 0.75 || dup.correlation >= 0.97) {
          findings.push({ kind: 'duplicate', level: strong ? 'high' : 'medium', a: { panel: A.id, box: A.box }, b: { panel: B.id, box: B.box }, transform: dup.transform, score: dup.correlation,
            verification: v ? { picture: Math.round(v.lp * 100) / 100, noise: Math.round(v.hp * 100) / 100 } : null,
            description: `The same image appears twice (${describeTransform(dup.transform)}; correlation ${dup.correlation}${v ? `, full-resolution match ${v.lp.toFixed(2)}, noise pattern ${v.hp.toFixed(2)}` : ''})${channels ? CHANNEL_NOTE : ''}` });
          continue;
        }
      }
      const reg = pairRegistered(A, B);
      if (reg) {
        findings.push({ kind: reg.kind, level: reg.noise >= (reg.transform.flip || reg.transform.rotation ? 0.75 : 0.6) && Math.abs(Math.log(reg.transform.scale)) < 0.1 && !channels ? 'high' : 'medium', a: { panel: A.id, box: reg.kind === 'duplicate' ? A.box : toImage(A, reg.regionA) }, b: { panel: B.id, box: reg.kind === 'duplicate' ? B.box : toImage(B, reg.regionB) }, transform: reg.transform, score: reg.correlation,
          description: `${reg.kind === 'duplicate' ? 'The same image appears twice' : 'Overlapping image content'} (pixel match ${reg.correlation}, noise pattern ${reg.noise}; ${describeTransform(reg.transform)})${channels ? CHANNEL_NOTE : ''}` });
        continue;
      }
      const part = pairPartial(A, B);
      // the matched regions must look alike pixel by pixel: shared labels, scale bars or instrument overlays match as keypoints only
      const pv = part ? verifyRegions(A, B, part) : null;
      if (part && (pv === null || pv >= 0.5)) {
        findings.push({ kind: 'partial', level: part.inliers >= 25 && pv !== null && pv >= 0.75 && !channels ? 'high' : 'medium', verification: pv === null ? null : { region: Math.round(pv * 100) / 100 }, a: { panel: A.id, box: toImage(A, part.regionA) }, b: { panel: B.id, box: toImage(B, part.regionB) }, transform: part.transform, score: part.inliers,
          description: `Overlapping image content (${part.inliers} matching points, ${part.coverage}% of the panel; ${describeTransform(part.transform)}${pv !== null ? `; matched regions correlate ${pv.toFixed(2)}` : ''})${channels ? CHANNEL_NOTE : ''}` });
      }
    }
  }
  usable.forEach(P => {
    for (const c of selfClone(P)) {
      const strong = c.method === 'keypoints' ? c.inliers >= 15 : c.blocks >= 80 && (c.pixel?.hp ?? 0) >= 0.8;
      findings.push({ kind: 'clone', level: strong ? 'high' : 'medium', a: { panel: P.id, box: toImage(P, c.regionA) }, b: { panel: P.id, box: toImage(P, c.regionB) }, transform: c.transform, score: c.inliers || c.blocks,
        description: c.method === 'keypoints' ? `Possible cloned area inside one panel (${c.inliers} matching points, ${describeTransform(c.transform)})` : `Possible cloned area inside one panel (${c.blocks} matching blocks${c.pixel ? `, pixel match ${c.pixel.lp.toFixed(2)}, noise pattern ${c.pixel.hp.toFixed(2)}` : ''})` });
    }
  });
  return findings.sort((a, b) => (a.level === b.level ? b.score - a.score : a.level === 'high' ? -1 : 1));
}

export { describeTransform };
