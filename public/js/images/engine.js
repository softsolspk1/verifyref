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
function orient(src, k, mirror) {
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
  for (let i = 0; i <= len; i++) {
    const g = i < len && prof[i] >= 0.985;
    if (g && start < 0) start = i;
    if (!g && start >= 0) { if (i - start >= minRun) runs.push([start, i]); start = -1; }
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
    if (depth > 0) {
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
    if (contentFraction(mask, w, box) < 0.12) return; // text label or empty area
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
export function orb(img, { max = 260, threshold = 18 } = {}) {
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
export function copyMoveBlocks(img, { step = 2, minShift = 16, minBlocks = 30 } = {}) {
  const { w, h, g } = img;
  const feats = [];
  const tmp = new Float32Array(64);
  for (let y = 0; y + 8 <= h; y += step) {
    for (let x = 0; x + 8 <= w; x += step) {
      let s = 0, s2 = 0;
      for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) { const v = g[(y + yy) * w + x + xx]; s += v; s2 += v * v; }
      const varc = s2 / 64 - (s / 64) ** 2;
      if (varc < 40) continue; // flat block: background, would match everywhere
      for (let u = 0; u < 8; u++) for (let yy = 0; yy < 8; yy++) { let a = 0; for (let xx = 0; xx < 8; xx++) a += g[(y + yy) * w + x + xx] * DCT8[u * 8 + xx]; tmp[u * 8 + yy] = a; }
      const f = ZIG.map(([u, v]) => { let a = 0; for (let yy = 0; yy < 8; yy++) a += tmp[u * 8 + yy] * DCT8[v * 8 + yy]; return Math.round(a / (u + v === 0 ? 16 : 6)); });
      feats.push({ x, y, f, k: f.join(',') });
    }
  }
  feats.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const shifts = new Map();
  for (let i = 0; i < feats.length; i++) {
    for (let j = i + 1; j < Math.min(feats.length, i + 4) && feats[j].k === feats[i].k; j++) {
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
    out.push({ blocks: s.pairs.length, dx: s.dx, dy: s.dy, a: { x: a.x - 4, y: a.y - 4, w: a.w + 8, h: a.h + 8 }, b: { x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 } });
  }
  return out.sort((p, q) => q.blocks - p.blocks).slice(0, 3);
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
  return { ...meta, box, type, blank, scale: s, work: { w: work.w, h: work.h }, workGray: work, hashes, sqNorm, features, flipped, hash: hashHex(hashes[0]) };
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
  return { kind: 'duplicate', hamming: bestD, correlation: Math.round(corr * 100) / 100, transform: { rotation: (rot * Math.PI) / 180, flip: mirror, scale } };
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
    if (Math.min(areaA, areaB) < 0.05 || ba.w < 30 || ba.h < 20 || bb.w < 30 || bb.h < 20) continue; // labels, scale bars
    if (!best || r.inliers.length > best.inliers) best = { kind: 'partial', inliers: r.inliers.length, matches: matches.length, regionA: ba, regionB: bb, coverage: Math.round(Math.max(areaA, areaB) * 100), transform: { rotation: flip ? -r.rotation : r.rotation, flip, scale: r.scale } };
  }
  return best;
}

function selfClone(P) {
  const out = [];
  if (P.features && P.features.pts.length >= 20) {
    const matches = matchFeatures(P.features, P.features, { self: true, minShift: 24, ratio: 0.8, maxDist: 50 });
    if (matches.length >= 8) {
      const r = ransac(matches, P.features, P.features, { minShift: 24 });
      if (r && r.inliers.length >= 10) {
        const a = bbox(r.inliers.map(m => P.features.pts[m.i])), b = bbox(r.inliers.map(m => P.features.pts[m.j]));
        const overlap = !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
        if (!overlap && a.w > 12 && a.h > 12) out.push({ kind: 'clone', method: 'keypoints', inliers: r.inliers.length, regionA: a, regionB: b, transform: { rotation: r.rotation, flip: false, scale: r.scale } });
      }
    }
  }
  if (!P.blank && P.type !== 'chart') {
    for (const c of copyMoveBlocks(P.workGray)) {
      if (out.some(o => Math.abs(o.regionA.x - c.a.x) < 20 && Math.abs(o.regionA.y - c.a.y) < 20)) continue;
      out.push({ kind: 'clone', method: 'blocks', blocks: c.blocks, regionA: c.a, regionB: c.b, transform: { rotation: 0, flip: false, scale: 1 } });
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
      const dup = pairDuplicate(A, B);
      if (dup) {
        findings.push({ kind: 'duplicate', level: A.type === 'chart' ? 'medium' : 'high', a: { panel: A.id, box: A.box }, b: { panel: B.id, box: B.box }, transform: dup.transform, score: dup.correlation,
          description: `The same image appears twice (${describeTransform(dup.transform)}; correlation ${dup.correlation})` });
        continue;
      }
      const part = pairPartial(A, B);
      if (part) {
        findings.push({ kind: 'partial', level: part.inliers >= 25 ? 'high' : 'medium', a: { panel: A.id, box: toImage(A, part.regionA) }, b: { panel: B.id, box: toImage(B, part.regionB) }, transform: part.transform, score: part.inliers,
          description: `Overlapping image content (${part.inliers} matching points, ${part.coverage}% of the panel; ${describeTransform(part.transform)})` });
      }
    }
  }
  usable.forEach(P => {
    for (const c of selfClone(P)) {
      const strong = c.method === 'keypoints' ? c.inliers >= 15 : c.blocks >= 80;
      findings.push({ kind: 'clone', level: strong ? 'high' : 'medium', a: { panel: P.id, box: toImage(P, c.regionA) }, b: { panel: P.id, box: toImage(P, c.regionB) }, transform: c.transform, score: c.inliers || c.blocks,
        description: c.method === 'keypoints' ? `Possible cloned area inside one panel (${c.inliers} matching points, ${describeTransform(c.transform)})` : `Possible cloned area inside one panel (${c.blocks} identical blocks)` });
    }
  });
  return findings.sort((a, b) => (a.level === b.level ? b.score - a.score : a.level === 'high' ? -1 : 1));
}

export { describeTransform };
