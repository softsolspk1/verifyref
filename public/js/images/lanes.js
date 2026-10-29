// images/lanes.js - Western blot / gel lane-by-lane comparison (Module 5.5). A blot strip is cut into lanes (vertical
// bands separated by clear gaps) and every lane is compared with every other lane - in the same blot and in the other
// blots of the manuscript. A lane that reappears (also shifted a little) is reported with both lanes marked.
// A band pattern alone is not proof: loading controls look alike. A lane counts only when the noise left after
// removing the smooth picture also agrees, because two different lanes never share that noise.
import { resizeGray } from './engine.js';

const hann = (src, sigma) => {                       // small separable blur for the noise residual
  const r = Math.max(1, Math.ceil(sigma * 2.5)), k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const { w, h, g } = src, tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += g[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + r]; tmp[y * w + x] = a; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r]; out[y * w + x] = a; }
  return { w, h, g: out };
};

const percentile = (a, p) => { const s = Float32Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

function backgroundOf(g) {
  const hist = new Uint32Array(64);
  for (const v of g) hist[Math.min(63, Math.max(0, v >> 2))]++;
  let mode = 0;
  for (let i = 1; i < 64; i++) if (hist[i] > hist[mode]) mode = i;
  return mode * 4 + 2;
}

/** Lanes of a blot panel as column ranges in work coordinates */
export function findLanes(P) {
  const { w, h, g } = P.workGray;
  if (w < 60 || h < 12) return [];
  // background level = the most common grey value (the empty membrane / gel), not the median: in a crowded blot the median sits on the bands
  const hist = new Uint32Array(64);
  for (const v of g) hist[Math.min(63, Math.max(0, v >> 2))]++;
  let mode = 0;
  for (let i = 1; i < 64; i++) if (hist[i] > hist[mode]) mode = i;
  const med = mode * 4 + 2;
  const s = new Float32Array(w);
  for (let x = 0; x < w; x++) { let a = 0; for (let y = 0; y < h; y++) a += Math.abs(g[y * w + x] - med); s[x] = a / h; }
  const sm = s.map((_, x) => (s[Math.max(0, x - 1)] + s[x] + s[Math.min(w - 1, x + 1)]) / 3);
  const thr = Math.max(4, 0.3 * percentile(sm, 0.9));
  const runs = [];
  let start = -1;
  for (let x = 0; x <= w; x++) {
    const on = x < w && sm[x] > thr;
    if (on && start < 0) start = x;
    if (!on && start >= 0) { runs.push([start, x - 1]); start = -1; }
  }
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] <= 3) last[1] = r[1]; else merged.push([...r]);
  }
  return merged.filter(([a, b]) => b - a + 1 >= 7 && b - a + 1 <= w * 0.35).map(([a, b]) => ({ x0: Math.max(0, a - 1), x1: Math.min(w - 1, b + 1) }));
}

function laneImage(P, lane) {
  const w = lane.x1 - lane.x0 + 1, h = P.workGray.h;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = P.workGray.g[y * P.workGray.w + lane.x0 + x];
  return { w, h, g: out };
}

function ncc(a, b, w, h, dx, dy) {
  const x0 = Math.max(0, dx), x1 = Math.min(w, w + dx), y0 = Math.max(0, dy), y1 = Math.min(h, h + dy);
  if (x1 - x0 < 5 || y1 - y0 < 8) return null;
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const va = a[y * w + x], vb = b[(y - dy) * w + (x - dx)];
    n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
  }
  return (n * sab - sa * sb) / Math.sqrt(Math.max(1e-9, (n * saa - sa * sa) * (n * sbb - sb * sb)));
}

function resizeMask(m, w, h, nw, nh) {
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = m[Math.min(h - 1, Math.floor(y * h / nh)) * w + Math.min(w - 1, Math.floor(x * w / nw))];
  return out;
}

function compareLanes(A, B) {
  // same lane size: resize B to A (lane widths differ by a few pixels at most)
  if (Math.abs(A.w - B.w) > Math.max(4, A.w * 0.3) || Math.abs(A.h - B.h) > A.h * 0.3) return null;
  const Bs = B.w === A.w && B.h === A.h ? B : resizeGray(B, A.w, A.h);
  const hpA = A.hp, hpB = B.w === A.w && B.h === A.h ? B.hp : resizeGray(B.hp, A.w, A.h);
  let best = null;
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const c = ncc(A.g, Bs.g, A.w, A.h, dx, dy);
    if (c !== null && (!best || c > best.c)) best = { c, dx, dy };
  }
  if (!best || best.c < 0.94) return null;
  const mB = B.w === A.w && B.h === A.h ? B.mask : resizeMask(B.mask, B.w, B.h, A.w, A.h);
  const hp = nccMasked(hpA.g, hpB.g, A.mask, mB, A.w, A.h, best.dx, best.dy);
  return hp === null ? null : { lp: best.c, hp };
}

/** NCC over the pixels that belong to a band in both lanes only (the empty membrane has no texture worth comparing) */
function nccMasked(a, b, ma, mb, w, h, dx, dy) {
  const x0 = Math.max(0, dx), x1 = Math.min(w, w + dx), y0 = Math.max(0, dy), y1 = Math.min(h, h + dy);
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const ia = y * w + x, ib = (y - dy) * w + (x - dx);
    if (!ma[ia] || !mb[ib]) continue;
    const va = a[ia], vb = b[ib];
    n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
  }
  if (n < 60) return null;
  return (n * sab - sa * sb) / Math.sqrt(Math.max(1e-9, (n * saa - sa * sa) * (n * sbb - sb * sb)));
}

const toImage = (P, x, y, w, h) => ({ x: Math.round(P.box.x + x / P.scale), y: Math.round(P.box.y + y / P.scale), w: Math.round(w / P.scale), h: Math.round(h / P.scale) });

/** panels: prepared panels (preparePanel). Returns findings in the format of engine.findIssues. */
export function laneFindings(panels) {
  const lanes = [];
  for (const P of panels) {
    if (P.blank || P.type !== 'blot' || !P.workGray) continue;
    const found = findLanes(P);
    if (found.length < 3 || found.length > 40) continue;
    const bg = backgroundOf(P.workGray.g);
    // frame lines and panel borders run across the whole strip and are identical in every lane: leave those rows out
    const { w: pw, h: ph, g: pg } = P.workGray;
    const rowMean = new Float32Array(ph);
    for (let y = 0; y < ph; y++) { let a = 0; for (let x = 0; x < pw; x++) a += Math.abs(pg[y * pw + x] - bg); rowMean[y] = a / pw; }
    const maxRow = Math.max(...rowMean);
    const frameRow = new Uint8Array(ph);
    for (let y = 0; y < ph; y++) if ((y < ph * 0.14 || y > ph * 0.86) && rowMean[y] > 0.7 * maxRow) frameRow[y] = 1;
    found.forEach((l, i) => {
      const img = laneImage(P, l);
      const sm = hann(img, 0.8);
      const hp = { w: img.w, h: img.h, g: img.g.map((v, k) => v - sm.g[k]) };
      let m = 0, sd = 0;
      for (const v of img.g) m += v;
      m /= img.g.length;
      for (const v of img.g) sd += (v - m) * (v - m);
      if (Math.sqrt(sd / img.g.length) < 7) return;              // empty lane
      // band pixels = clearly different from the membrane background; the texture inside them is what must agree
      const dev = img.g.map(v => Math.abs(v - bg));
      const top = percentile(dev.filter((_, k) => !frameRow[(k / img.w) | 0]), 0.98);
      const mask = new Uint8Array(dev.length);
      let bandPx = 0, hs = 0;
      if (top >= 25) for (let k = 0; k < dev.length; k++) if (dev[k] > 0.3 * top && !frameRow[(k / img.w) | 0]) { mask[k] = 1; bandPx++; hs += hp.g[k] * hp.g[k]; }
      const noiseSd = bandPx ? Math.sqrt(hs / bandPx) : 0;
      if (bandPx < 60) return;
      lanes.push({ P, index: i + 1, count: found.length, lane: l, noiseSd, mask, ...img, hp });
    });
  }
  const out = [];
  for (let i = 0; i < lanes.length; i++) for (let j = i + 1; j < lanes.length; j++) {
    const A = lanes[i], B = lanes[j];
    const same = A.P === B.P;
    if (same && Math.abs(A.index - B.index) < 1) continue;
    // a smooth, denoised lane has no noise to compare: its residual is just the shape of the band, which similar lanes share
    if (A.noiseSd < 1.5 || B.noiseSd < 1.5) continue;
    const r = compareLanes(A, B);
    if (!r || r.hp < 0.6) continue;
    const boxA = toImage(A.P, A.lane.x0, 0, A.lane.x1 - A.lane.x0 + 1, A.P.workGray.h), boxB = toImage(B.P, B.lane.x0, 0, B.lane.x1 - B.lane.x0 + 1, B.P.workGray.h);
    out.push({
      kind: same ? 'clone' : 'partial', lane: true, level: r.lp >= 0.97 && r.hp >= 0.65 ? 'high' : 'medium',
      a: { panel: A.P.id, box: boxA }, b: { panel: B.P.id, box: boxB }, transform: { rotation: 0, flip: false, scale: 1 }, score: Math.round(r.lp * 100) / 100,
      description: `Blot lane ${A.index} looks identical to lane ${B.index}${same ? ' of the same blot' : ` of ${B.P.label}`} (band pattern ${r.lp.toFixed(2)}, noise pattern ${r.hp.toFixed(2)})`
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 12);
}
