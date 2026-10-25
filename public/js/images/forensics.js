// images/forensics.js - Module 5 checks beyond duplication (pure JavaScript; runs in the Web Worker and in Node tests)
//   a) Alteration / manipulation inside one image: noise-level inconsistency (spliced patches), unnaturally smooth patches
//      (erasure / retouching), JPEG compression-grid mismatch (pasted from another picture), sharp background steps between
//      blot lanes, combed histograms (contrast stretching), saturated bands. Cloning is found by engine.js.
//   c) AI-generated image indicators: provenance markers in the file (C2PA / IPTC "trainedAlgorithmicMedia", generator
//      names, Stable-Diffusion parameter blocks) and statistical hints (spectral peaks, missing / uniform sensor noise).
//      File markers are strong evidence; statistics alone are only ever "check", never a verdict.
//   d) Graph & chart duplication: data series (bar heights, curves) are read from the chart pixels and compared across
//      charts - the same data re-plotted with other colours, axes or scale is found.
// Everything returns findings for the editor to check, never verdicts.
import { resizeRGBA } from './engine.js';

const CAT = { duplicate: 'duplication', partial: 'duplication', clone: 'manipulation', alteration: 'manipulation', ai: 'ai', chart: 'chart' };
export const categoryOf = kind => CAT[kind] || 'duplication';

const median = a => { if (!a.length) return 0; const s = Float32Array.from(a).sort(); return s[s.length >> 1]; };
const percentile = (a, p) => { if (!a.length) return 0; const s = Float32Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = a => { let s = 0; for (const v of a) s += v; return a.length ? s / a.length : 0; };
const std = a => { const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / Math.max(1, a.length)); };
export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Connected groups (4-neighbourhood) of flagged grid cells -> [{cells, x0, y0, x1, y1}] */
function groups(flag, nx, ny) {
  const seen = new Uint8Array(nx * ny), out = [];
  for (let s = 0; s < nx * ny; s++) {
    if (!flag[s] || seen[s]) continue;
    const stack = [s], cells = [];
    seen[s] = 1;
    while (stack.length) {
      const c = stack.pop(); cells.push(c);
      const x = c % nx, y = (c / nx) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue;
        const k = Y * nx + X;
        if (flag[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    let x0 = nx, y0 = ny, x1 = 0, y1 = 0;
    for (const c of cells) { const x = c % nx, y = (c / nx) | 0; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    out.push({ cells, x0, y0, x1, y1 });
  }
  return out;
}

// ------------------------------------------------------------------ noise map

/** Noise floor per BxB block: 25th percentile of the residual deviation of 8x8 sub-blocks (texture-resistant) */
function noiseGrid(gray, box, B = 32, img = null) {
  const { w, g } = gray;
  const nx = Math.floor(box.w / B), ny = Math.floor(box.h / B);
  const floor = new Float32Array(nx * ny), avg = new Float32Array(nx * ny);
  const res = (x, y) => { // value minus 3x3 mean
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += g[(y + j) * w + x + i];
    return g[y * w + x] - s / 9;
  };
  for (let by = 0; by < ny; by++) for (let bx = 0; bx < nx; bx++) {
    const x0 = box.x + bx * B, y0 = box.y + by * B;
    const subs = [];
    let m = 0;
    for (let sy = 0; sy < B; sy += 8) for (let sx = 0; sx < B; sx += 8) {
      let ss = 0, n = 0;
      for (let y = y0 + sy; y < y0 + sy + 8; y++) for (let x = x0 + sx; x < x0 + sx + 8; x++) {
        if (x < 1 || y < 1 || x >= gray.w - 1 || y >= gray.h - 1) continue;
        const r = res(x, y); ss += r * r; n++; m += g[y * w + x];
      }
      subs.push(n ? Math.sqrt(ss / n) : 0);
    }
    floor[by * nx + bx] = percentile(subs, 0.25);
    avg[by * nx + bx] = m / (B * B);
    if (img) { // saturated areas are flat by nature, not retouched
      let clip = 0;
      for (let y = y0; y < y0 + B; y++) for (let x = x0; x < x0 + B; x++) { const j = (y * img.width + x) * 4; if (Math.max(img.data[j], img.data[j + 1], img.data[j + 2]) >= 254) clip++; }
      if (clip > B * B * 0.15) avg[by * nx + bx] = -1;
    }
  }
  return { nx, ny, floor, avg, B };
}

function noiseFindings(gray, box, img = null) {
  const out = [];
  const N = noiseGrid(gray, box, 32, img);
  if (N.nx < 4 || N.ny < 4) return { out, N };
  const ok = [];
  for (let i = 0; i < N.floor.length; i++) if (N.avg[i] > 15 && N.avg[i] < 240) ok.push(N.floor[i]);
  if (ok.length < 12) return { out, N };
  const M = median(ok);
  const total = N.nx * N.ny;
  const place = (grp, code, message) => {
    const sz = (grp.x1 - grp.x0 + 1) * (grp.y1 - grp.y0 + 1);
    if (grp.cells.length < 3 || grp.cells.length > total * 0.5 || sz > total * 0.6) return;
    out.push({ code, level: 'medium', message, box: { x: box.x + grp.x0 * N.B, y: box.y + grp.y0 * N.B, w: (grp.x1 - grp.x0 + 1) * N.B, h: (grp.y1 - grp.y0 + 1) * N.B } });
  };
  if (M >= 0.8) {
    // camera noise grows with brightness: compare each block with blocks of similar brightness
    const bins = new Map();
    for (let i = 0; i < total; i++) if (N.avg[i] > 15 && N.avg[i] < 240) { const k = Math.floor(N.avg[i] / 30); if (!bins.has(k)) bins.set(k, []); bins.get(k).push(N.floor[i]); }
    const binMed = new Map([...bins].filter(([, v]) => v.length >= 6).map(([k, v]) => [k, median(v)]));
    const hi = new Uint8Array(total), lo = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      if (N.avg[i] <= 15 || N.avg[i] >= 240) continue;
      const ref = binMed.get(Math.floor(N.avg[i] / 30));
      if (!ref || ref < 0.8) continue;
      if (N.floor[i] > ref * 2.6) hi[i] = 1;
      else if (N.floor[i] < ref / 2.6 && N.floor[i] >= 0.3) lo[i] = 1;
    }
    for (const g of groups(hi, N.nx, N.ny)) place(g, 'noise', 'Area with a clearly different noise level (noisier) than the rest of the image - typical of a patch taken from another picture');
    for (const g of groups(lo, N.nx, N.ny)) place(g, 'noise', 'Area with a clearly different noise level (smoother) than the rest of the image - typical of a patch taken from another picture');
  }
  if (M >= 1.5) {
    const flat = new Uint8Array(total);
    for (let i = 0; i < total; i++) if (N.floor[i] < 0.3 && N.avg[i] > 25 && N.avg[i] < 235) flat[i] = 1;
    for (const g of groups(flat, N.nx, N.ny)) place(g, 'smooth', 'Unnaturally smooth area without any image noise - possible erasure or retouching');
  }
  return { out, N, M };
}

// ------------------------------------------------------------------ JPEG compression grid

function gridFindings(gray, box) {
  const { w, g } = gray;
  const W = 64;
  const nx = Math.floor(box.w / W), ny = Math.floor(box.h / W);
  if (nx < 3 || ny < 3) return [];
  const info = [];
  for (let wy = 0; wy < ny; wy++) for (let wx = 0; wx < nx; wx++) {
    const x0 = box.x + wx * W, y0 = box.y + wy * W;
    if (x0 < 1 || y0 < 1) { info.push(null); continue; }
    const col = new Float32Array(8), row = new Float32Array(8), cn = new Float32Array(8), rn = new Float32Array(8);
    for (let y = y0; y < y0 + W; y++) for (let x = x0; x < x0 + W; x++) {
      const v = g[y * w + x];
      col[x & 7] += Math.abs(v - g[y * w + x - 1]); cn[x & 7]++;
      row[y & 7] += Math.abs(v - g[(y - 1) * w + x]); rn[y & 7]++;
    }
    for (let i = 0; i < 8; i++) { col[i] /= cn[i]; row[i] /= rn[i]; }
    const mc = mean(col), mr = mean(row);
    let pc = 0, pr = 0;
    for (let i = 1; i < 8; i++) { if (col[i] > col[pc]) pc = i; if (row[i] > row[pr]) pr = i; }
    const rc = mc > 0.5 ? col[pc] / mc : 0, rr = mr > 0.5 ? row[pr] / mr : 0;
    info.push({ pc, pr, blocky: rc > 1.3 && rr > 1.3 });
  }
  const votes = new Map();
  let blocky = 0;
  for (const i of info) if (i?.blocky) { blocky++; const k = `${i.pc},${i.pr}`; votes.set(k, (votes.get(k) || 0) + 1); }
  if (blocky < 8) return [];
  const [dom, count] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  if (count / blocky < 0.6) return [];
  const odd = new Uint8Array(nx * ny);
  info.forEach((i, k) => { if (i?.blocky && `${i.pc},${i.pr}` !== dom) odd[k] = 1; });
  const out = [];
  for (const grp of groups(odd, nx, ny)) {
    if (grp.cells.length < 3) continue;
    out.push({ code: 'grid', level: 'medium', message: 'Area with a different JPEG compression grid than the rest of the image - typical of content pasted from another picture',
      box: { x: box.x + grp.x0 * W, y: box.y + grp.y0 * W, w: (grp.x1 - grp.x0 + 1) * W, h: (grp.y1 - grp.y0 + 1) * W } });
  }
  return out;
}

// ------------------------------------------------------------------ blots: lane splices, saturation, histogram

function blotFindings(gray, box) {
  const out = [];
  const { w, g } = gray;
  const sub = new Float32Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) for (let x = 0; x < box.w; x++) sub[y * box.w + x] = g[(box.y + y) * w + box.x + x];
  const range = percentile(sub, 0.95) - percentile(sub, 0.05);
  if (range < 40) return out;
  for (const vertical of [true, false]) {
    const len = vertical ? box.w : box.h, span = vertical ? box.h : box.w;
    if (len < 60) continue;
    const prof = new Float32Array(len), tmp = new Float32Array(span);
    for (let i = 0; i < len; i++) {
      for (let j = 0; j < span; j++) tmp[j] = vertical ? sub[j * box.w + i] : sub[i * box.w + j];
      prof[i] = percentile(tmp, 0.9);
    }
    const P = new Float32Array(len);
    for (let i = 0; i < len; i++) { let s = 0, n = 0; for (let k = -2; k <= 2; k++) if (prof[i + k] !== undefined) { s += prof[i + k]; n++; } P[i] = s / n; }
    const thr = Math.max(10, range * 0.06);
    let best = null;
    for (let x = 12; x < len - 12; x++) {
      const left = median(Array.from(P.subarray(x - 10, x - 2))), right = median(Array.from(P.subarray(x + 3, x + 11)));
      const d = right - left;
      if (Math.abs(d) < thr) continue;
      const jump = (P[x + 1] + P[x + 2]) / 2 - (P[x - 2] + P[x - 1]) / 2;
      if (Math.abs(jump) < 0.6 * Math.abs(d) || Math.sign(jump) !== Math.sign(d)) continue;
      if (!best || Math.abs(d) > Math.abs(best.d)) best = { x, d };
    }
    if (!best) continue;
    let agree = 0;
    for (let j = 0; j < span; j++) {
      let a = -1, b = -1; // the brightest pixel of each side is the background (bands are darker)
      for (let k = 1; k <= 6; k++) {
        const l = vertical ? sub[j * box.w + best.x - k] : sub[(best.x - k) * box.w + j];
        const r = vertical ? sub[j * box.w + best.x + k] : sub[(best.x + k) * box.w + j];
        if (l > a) a = l;
        if (r > b) b = r;
      }
      if (Math.sign(b - a) === Math.sign(best.d) && Math.abs(b - a) > 0.4 * Math.abs(best.d)) agree++;
    }
    if (agree / span < 0.8) continue;
    out.push({ code: 'splice-edge', level: 'medium', message: `Sharp straight ${vertical ? 'vertical' : 'horizontal'} step in the background level (${Math.round(Math.abs(best.d))} grey levels) across the whole blot - typical of lanes cut from different blots and joined`,
      box: vertical ? { x: box.x + best.x - 8, y: box.y, w: 16, h: box.h } : { x: box.x, y: box.y + best.x - 8, w: box.w, h: 16 } });
    break;
  }
  return out;
}

function histogramFindings(img, box, type) {
  const out = [];
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) { hist[img.data[(y * img.width + x) * 4 + 1]]++; n++; }
  if (n < 30000) return out;
  let lo = 0, hi = 255, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.005) lo++;
  acc = 0;
  while (hi > 0 && (acc += hist[hi]) < n * 0.005) hi--;
  if (hi - lo >= 120) {
    let empty = 0;
    for (let i = lo; i <= hi; i++) if (hist[i] === 0) empty++;
    if (empty / (hi - lo + 1) > 0.25) out.push({ code: 'histogram', level: 'medium', message: `Comb-shaped brightness histogram (${Math.round(100 * empty / (hi - lo + 1))}% of grey levels missing) - the contrast or levels were stretched after capture`, box });
  }
  if (type === 'blot' && hist[0] + hist[1] + hist[2] > n * 0.15) out.push({ code: 'saturated', level: 'medium', message: `${Math.round(100 * (hist[0] + hist[1] + hist[2]) / n)}% of the pixels are pure black - bands are saturated (over-exposed or over-adjusted), so band intensities cannot be compared`, box });
  return out;
}

// ------------------------------------------------------------------ AI-generated image indicators

const MARKERS = [
  [/trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|algorithmicMedia/, 'IPTC digital source type: AI-generated (trainedAlgorithmicMedia)'],
  [/\bc2pa\b|jumbf|contentcredentials|cai:/i, 'Content Credentials (C2PA) manifest present - check who signed it'],
  [/parameters\0[\s\S]{0,400}?(?:Steps:|Sampler:|CFG scale|Seed:)|Negative prompt:/, 'Stable-Diffusion style generation parameters (prompt, steps, sampler, seed)'],
  [/DALL[-·\s]?E|Midjourney|Stable ?Diffusion|Adobe Firefly|Leonardo\.?Ai|Ideogram|NightCafe|Craiyon|DreamStudio|ComfyUI|Automatic1111|InvokeAI|Bing Image Creator|SynthID|Imagen ?\d|Nano ?Banana/i, 'Software / generator name of an AI image tool in the file']
];

/** bytes: Uint8Array of the original image file (head and tail are scanned) */
export function scanProvenance(bytes) {
  if (!bytes?.length) return [];
  const take = bytes.length > 400000 ? [bytes.subarray(0, 200000), bytes.subarray(bytes.length - 200000)] : [bytes];
  let text = '';
  for (const part of take) { let s = ''; for (let i = 0; i < part.length; i += 8192) s += String.fromCharCode.apply(null, part.subarray(i, i + 8192)); text += s + '\n'; }
  const found = [];
  for (const [re, label] of MARKERS) { const m = text.match(re); if (m) found.push({ marker: label, found: m[0].slice(0, 60).replace(/[^\x20-\x7e]/g, ' ').trim() }); }
  return found;
}

// 2-D FFT (radix 2) for the spectral test
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? -1 : 1), wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Number of strong periodic spectral peaks in the noise residual of the central 128x128 area (upsampling traces) */
export function spectralPeaks(gray, box) {
  const N = 128;
  if (box.w < N || box.h < N) return 0;
  const x0 = box.x + ((box.w - N) >> 1), y0 = box.y + ((box.h - N) >> 1);
  const { w, g } = gray;
  const re = new Float32Array(N * N), im = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const X = x0 + x, Y = y0 + y;
    let s = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += g[Math.min(gray.h - 1, Math.max(0, Y + j)) * w + Math.min(w - 1, Math.max(0, X + i))];
    const hann = 0.25 * (1 - Math.cos(2 * Math.PI * x / (N - 1))) * (1 - Math.cos(2 * Math.PI * y / (N - 1)));
    re[y * N + x] = (g[Y * w + X] - s / 9) * hann;
  }
  const rr = new Float32Array(N), ri = new Float32Array(N);
  for (let y = 0; y < N; y++) { rr.set(re.subarray(y * N, y * N + N)); ri.set(im.subarray(y * N, y * N + N)); fft(rr, ri); re.set(rr, y * N); im.set(ri, y * N); }
  for (let x = 0; x < N; x++) { for (let y = 0; y < N; y++) { rr[y] = re[y * N + x]; ri[y] = im[y * N + x]; } fft(rr, ri); for (let y = 0; y < N; y++) { re[y * N + x] = rr[y]; im[y * N + x] = ri[y]; } }
  const mag = new Float32Array(N * N);
  for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(re[i], im[i]);
  let peaks = 0;
  for (let v = 4; v < N - 4; v++) for (let u = 4; u < N - 4; u++) {
    const fu = Math.min(u, N - u), fv = Math.min(v, N - v);
    if (fu < 3 || fv < 3 || Math.hypot(fu, fv) > 60) continue; // axis lines and very high frequencies carry edges / rounding
    if (u % 16 === 0 && v % 16 === 0) continue; // 8x8 JPEG block harmonics
    const ring = [];
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (Math.max(Math.abs(i), Math.abs(j)) >= 2) ring.push(mag[(v + j) * N + u + i]);
    if (mag[v * N + u] > 7 * median(ring)) peaks++;
  }
  return peaks;
}

/** Statistical hints for one panel -> [{code, message}] */
export function aiStatistics(gray, box, N) {
  const hints = [];
  if (N && N.nx >= 6 && N.ny >= 6) {
    const f = [], m = [];
    for (let i = 0; i < N.floor.length; i++) if (N.avg[i] > 20 && N.avg[i] < 235) { f.push(N.floor[i]); m.push(N.avg[i]); }
    if (f.length >= 30) {
      const med = median(f), cv = std(f) / (mean(f) || 1);
      let gs = 0;
      { const s = []; for (let y = box.y; y < box.y + box.h; y += 4) for (let x = box.x; x < box.x + box.w; x += 4) s.push(gray.g[y * gray.w + x]); gs = std(s); }
      if (med < 0.35 && gs > 25) hints.push({ code: 'noise-free', message: 'No sensor / camera noise at all in a detailed image (real microscope and camera images always carry noise)' });
      else if (cv < 0.2 && Math.abs(pearson(m, f)) < 0.15 && med >= 0.35) hints.push({ code: 'noise-uniform', message: 'Image noise is uniform and unrelated to brightness (real images are noisier in brighter areas)' });
    }
  }
  const peaks = spectralPeaks(gray, box);
  if (peaks >= 8) hints.push({ code: 'spectrum', message: `Regular periodic pattern in the noise spectrum (${peaks} peaks) - a trace of the up-sampling used by image generators` });
  if (gray.w && box.w === box.h && [512, 768, 1024, 1536, 2048].includes(box.w)) hints.push({ code: 'size', message: `Square panel of exactly ${box.w} × ${box.h} px, a typical output size of image generators` });
  return hints;
}

// ------------------------------------------------------------------ chart data series

/** Reads bar heights / curves of every colour in a chart panel -> [{kind, colour, values, n, spread}] */
export function chartSeries(img, box) {
  const k = Math.min(1, 520 / Math.max(box.w, box.h));
  const sm = resizeRGBA(img, box.w * k, box.h * k, box);
  const { width: w, height: h, data } = sm;
  const cls = new Int16Array(w * h).fill(-1);
  const hueOf = (r, g, b) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn || 1; let hu = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hu = (hu * 60 + 360) % 360; return hu; };
  const cnt = new Map();
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mn > 222) continue;
    let c;
    if (mx - mn >= 45) c = 10 + Math.floor(hueOf(r, g, b) / 30) * 2 + (mx < 150 ? 0 : 1);
    else if (mx < 100) c = 0;
    else c = 1;
    cls[i] = c; cnt.set(c, (cnt.get(c) || 0) + 1);
  }
  // axis lines and frames: dark rows / columns that span most of the plot
  for (let y = 0; y < h; y++) { let d = 0; for (let x = 0; x < w; x++) if (cls[y * w + x] === 0) d++; if (d > w * 0.5) for (let x = 0; x < w; x++) if (cls[y * w + x] === 0) cls[y * w + x] = -1; }
  for (let x = 0; x < w; x++) { let d = 0; for (let y = 0; y < h; y++) if (cls[y * w + x] === 0) d++; if (d > h * 0.5) for (let y = 0; y < h; y++) if (cls[y * w + x] === 0) cls[y * w + x] = -1; }
  const series = [];
  for (const [c, total] of cnt) {
    if (total < w * h * 0.004) continue;
    const top = new Int16Array(w).fill(-1), bot = new Int16Array(w).fill(-1), num = new Int16Array(w), sumY = new Float32Array(w);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (cls[y * w + x] === c) { if (top[x] < 0) top[x] = y; bot[x] = y; num[x]++; sumY[x] += y; }
    // bars: runs of columns with a flat, solid top
    const segs = [];
    let s0 = -1;
    const solid = x => num[x] >= 3 && num[x] >= 0.8 * (bot[x] - top[x] + 1);
    for (let x = 0; x <= w; x++) {
      const okc = x < w && solid(x) && (s0 < 0 || Math.abs(top[x] - top[x - 1]) <= 2);
      if (okc && s0 < 0) s0 = x;
      else if (!okc && s0 >= 0) { if (x - s0 >= (c === 0 ? 8 : 5)) segs.push({ x0: s0, x1: x - 1 }); s0 = (x < w && solid(x)) ? x : -1; }
    }
    if (segs.length >= 3) {
      const bases = segs.map(s => bot[(s.x0 + s.x1) >> 1]);
      const base = median(bases);
      const vals = segs.map(s => base - mean(Array.from(top.subarray(s.x0, s.x1 + 1))));
      if (vals.every(v => v >= 6) && segs.length <= 40) {
        series.push({ kind: 'bars', colour: c, values: vals.map(v => Math.round(v * 10) / 10), n: vals.length, spread: (Math.max(...vals) - Math.min(...vals)) / Math.max(...vals), size: h });
        continue;
      }
    }
    // curve
    let x0 = -1, x1 = -1, present = 0;
    for (let x = 0; x < w; x++) if (num[x] >= 1) { if (x0 < 0) x0 = x; x1 = x; present++; }
    if (present >= 30 && x1 - x0 >= w * 0.3 && present >= (x1 - x0) * 0.35) {
      const ys = [];
      for (let x = x0; x <= x1; x++) ys.push(num[x] ? sumY[x] / num[x] : null);
      let prev = null;
      for (let i = 0; i < ys.length; i++) {
        if (ys[i] !== null) { prev = i; continue; }
        let nx = i; while (nx < ys.length && ys[nx] === null) nx++;
        if (prev === null || nx >= ys.length) { ys[i] = prev === null ? (ys[nx] ?? 0) : ys[prev]; continue; }
        ys[i] = ys[prev] + (ys[nx] - ys[prev]) * (i - prev) / (nx - prev);
      }
      const v = [];
      for (let i = 0; i < 48; i++) v.push(h - ys[Math.min(ys.length - 1, Math.round(i * (ys.length - 1) / 47))]);
      // wiggle: what remains after removing the straight line between the ends
      const lin = v.map((_, i) => v[0] + (v[47] - v[0]) * i / 47), resid = v.map((y, i) => y - lin[i]);
      const range = Math.max(...v) - Math.min(...v);
      if (range >= h * 0.08) series.push({ kind: 'line', colour: c, values: v.map(y => Math.round(y * 10) / 10), n: 48, spread: range / h, wiggle: std(resid) / range, size: h });
    }
  }
  return series;
}

const sameHue = (a, b) => { const x = a.colour, y = b.colour; if (x < 10 || y < 10) return x === y; const d = Math.abs(((x - 10) >> 1) - ((y - 10) >> 1)); return Math.min(d, 12 - d) <= 1; };

/** Do two data series carry the same data? -> null or { level, corr, reversed } */
export function compareSeries(a, b, sameChart = false) {
  if (a.kind !== b.kind) return null;
  if (sameChart && sameHue(a, b)) return null;
  if (a.kind === 'bars') {
    if (a.n !== b.n || a.n < 4 || a.spread < 0.12 || b.spread < 0.12) return null;
    let best = null;
    for (const rev of [false, true]) {
      const c = pearson(a.values, rev ? [...b.values].reverse() : b.values);
      if (!best || c > best.corr) best = { corr: c, reversed: rev };
    }
    const need = a.n >= 6 ? 0.995 : 0.998;
    if (best.corr < need) return null;
    return { ...best, level: a.n >= 6 ? 'high' : 'medium' };
  }
  if ((a.wiggle || 0) < 0.06 || (b.wiggle || 0) < 0.06) return null;
  const c = pearson(a.values, b.values);
  if (c < 0.996) return null;
  return { corr: c, reversed: false, level: Math.min(a.wiggle, b.wiggle) >= 0.12 && c >= 0.998 ? 'high' : 'medium' };
}

// ------------------------------------------------------------------ panel analysis and findings

/**
 * Analyse one prepared panel. img = { width, height, data }, gray = toGray(img), box in image pixels,
 * meta = { provenance: [{marker}], width, height } of the whole image.
 */
export function analysePanel(img, gray, box, type, blank) {
  const res = { alterations: [], aiHints: [], series: [] };
  if (blank) return res;
  if (type === 'chart') { try { res.series = chartSeries(img, box); } catch (e) { /* unreadable chart */ } return res; }
  const noise = noiseFindings(gray, box, img);
  res.alterations.push(...noise.out, ...gridFindings(gray, box));
  if (type === 'blot' || type === 'grayscale') res.alterations.push(...blotFindings(gray, box));
  res.alterations.push(...histogramFindings(img, box, type));
  res.aiHints = aiStatistics(gray, box, noise.N);
  // two independent methods on the same area raise the level
  for (const a of res.alterations) {
    const overlap = res.alterations.some(o => o !== a && o.code !== a.code && !(o.box.x > a.box.x + a.box.w || a.box.x > o.box.x + o.box.w || o.box.y > a.box.y + a.box.h || a.box.y > o.box.y + o.box.h));
    if (overlap) a.level = 'high';
  }
  return res;
}

/** Findings of kinds alteration, ai and chart from analysed panels + image-level provenance */
export function forensicFindings(panels, provenanceByImage = {}, existing = []) {
  const out = [];
  const used = new Set();
  const alreadyDup = (p, q) => existing.some(f => f.kind === 'duplicate' && ((f.a.panel === p && f.b.panel === q) || (f.a.panel === q && f.b.panel === p)));
  for (const P of panels) {
    const F = P.forensic;
    if (!F) continue;
    for (const a of F.alterations) {
      out.push({ kind: 'alteration', level: a.level, a: { panel: P.id, box: a.box }, b: { panel: P.id, box: a.box }, transform: null, score: a.level === 'high' ? 3 : 2, code: a.code,
        description: a.message, details: [] });
    }
    const prov = provenanceByImage[P.imageId] || [];
    if (prov.length && !used.has(P.imageId) && !F.series.length) {
      used.add(P.imageId);
      out.push({ kind: 'ai', level: 'high', a: { panel: P.id, box: P.box }, b: { panel: P.id, box: P.box }, transform: null, score: 10, code: 'provenance',
        description: 'The image file carries a marker of AI image generation', details: prov.map(p => p.marker + (p.found ? ` (“${p.found}”)` : '')) });
    } else if (F.aiHints.length >= 2 && !F.series.length) {
      out.push({ kind: 'ai', level: 'medium', a: { panel: P.id, box: P.box }, b: { panel: P.id, box: P.box }, transform: null, score: F.aiHints.length, code: 'statistics',
        description: `Statistical traces typical of AI-generated images (${F.aiHints.length} indicators) - not proof; ask for the raw image`, details: F.aiHints.map(h => h.message) });
    }
  }
  // chart duplication
  const charts = panels.filter(p => p.forensic?.series?.length);
  for (let i = 0; i < charts.length; i++) {
    for (let j = i; j < charts.length; j++) {
      const A = charts[i], B = charts[j];
      if (i !== j && alreadyDup(A.id, B.id)) continue;
      for (let x = 0; x < A.forensic.series.length; x++) for (let y = i === j ? x + 1 : 0; y < B.forensic.series.length; y++) {
        const sa = A.forensic.series[x], sb = B.forensic.series[y];
        const r = compareSeries(sa, sb, i === j);
        if (!r) continue;
        const what = sa.kind === 'bars' ? `${sa.n} bars with the same relative heights` : 'a curve with the same shape';
        out.push({ kind: 'chart', level: r.level, a: { panel: A.id, box: A.box }, b: { panel: B.id, box: B.box }, transform: null, score: Math.round(r.corr * 1000) / 10, code: sa.kind,
          description: i === j ? `Two data series in one chart panel carry the same data (${what}; correlation ${r.corr.toFixed(3)})` : `Same data plotted in two charts (${what}${r.reversed ? ', in reverse order' : ''}; correlation ${r.corr.toFixed(3)}) - possibly re-scaled or re-coloured`,
          details: [] });
      }
    }
  }
  return out;
}

/** Compact data-series fingerprints stored for comparison with later manuscripts */
export function seriesFingerprints(panels) {
  const out = [];
  for (const P of panels) for (const s of P.forensic?.series || []) {
    out.push({ label: P.label, kind: s.kind, n: s.n, v: s.values.map(v => Math.round(v)), spread: Math.round(s.spread * 100) / 100, wiggle: s.wiggle ? Math.round(s.wiggle * 100) / 100 : 0 });
  }
  return out.slice(0, 60);
}
