// images/gbdt.js - small gradient-boosted decision trees (logistic loss), pure JavaScript: trained offline by
// scripts/train-image-models.mjs on labelled figures, applied in the Web Worker, the desktop app and Node.
// A model is { features: [names], base, rate, trees: [{ f, t, l, r } | { v }] } - plain JSON, a few kilobytes.

const sigmoid = z => 1 / (1 + Math.exp(-z));

function leafValue(node, x) {
  while (node.v === undefined) node = (x[node.f] ?? 0) <= node.t ? node.l : node.r;
  return node.v;
}

/** Probability (0-1) that feature vector x (array in model.features order) is a positive */
export function predict(model, x) {
  let z = model.base;
  for (const t of model.trees) z += model.rate * leafValue(t, x);
  return sigmoid(z);
}

/** Feature object -> array in the model's order */
export const vector = (model, obj) => model.features.map(f => (Number.isFinite(obj[f]) ? obj[f] : 0));

/**
 * Train on rows X (arrays of numbers) with labels y (0/1). Options: trees, depth, rate, minLeaf, bins, weightPos
 * (positives weighted up when they are rare), subsample (rows per tree, seeded). Splits are searched on quantile bins.
 */
export function train(X, y, { trees = 200, depth = 3, rate = 0.08, minLeaf = 8, bins = 32, weightPos = 1, subsample = 0.8, lambda = 1, seed = 11, features = null, monotone = [] } = {}) {
  // monotone: indexes of features the probability may only rise with (bounds passed down the tree, as in XGBoost)
  const mono = new Set(monotone);
  const n = X.length, d = X[0].length;
  const w = y.map(v => (v ? weightPos : 1));
  const p0 = y.reduce((s, v, i) => s + v * w[i], 0) / w.reduce((a, b) => a + b, 0);
  const base = Math.log(Math.max(1e-6, p0) / Math.max(1e-6, 1 - p0));
  // candidate thresholds per feature: quantiles of the training values
  const cuts = [];
  for (let f = 0; f < d; f++) {
    const s = X.map(r => r[f]).sort((a, b) => a - b), c = new Set();
    for (let k = 1; k < bins; k++) c.add(s[Math.floor(k * n / bins)]);
    cuts.push([...c].sort((a, b) => a - b));
  }
  const bin = X.map(r => r.map((v, f) => { const c = cuts[f]; let lo = 0, hi = c.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v <= c[m]) hi = m; else lo = m + 1; } return lo; }));
  const F = new Float64Array(n).fill(base);
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const out = [];
  for (let t = 0; t < trees; t++) {
    const g = new Float64Array(n), h = new Float64Array(n);
    for (let i = 0; i < n; i++) { const p = sigmoid(F[i]); g[i] = (p - y[i]) * w[i]; h[i] = Math.max(1e-6, p * (1 - p)) * w[i]; }
    const rows = [];
    for (let i = 0; i < n; i++) if (rnd() < subsample) rows.push(i);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const grow = (idx, lvl, lo = -Infinity, hi = Infinity) => {
      let G = 0, H = 0;
      for (const i of idx) { G += g[i]; H += h[i]; }
      const leaf = { v: clamp(-G / (H + lambda), lo, hi) };
      if (lvl >= depth || idx.length < 2 * minLeaf) return leaf;
      let best = null;
      const parent = G * G / (H + lambda);
      for (let f = 0; f < d; f++) {
        const nb = cuts[f].length + 1, gb = new Float64Array(nb), hb = new Float64Array(nb), cb = new Int32Array(nb);
        for (const i of idx) { const b = bin[i][f]; gb[b] += g[i]; hb[b] += h[i]; cb[b]++; }
        let gl = 0, hl = 0, cl = 0;
        for (let b = 0; b < nb - 1; b++) {
          gl += gb[b]; hl += hb[b]; cl += cb[b];
          if (cl < minLeaf || idx.length - cl < minLeaf) continue;
          const gain = gl * gl / (hl + lambda) + (G - gl) ** 2 / (H - hl + lambda) - parent;
          if (mono.has(f) && clamp(-gl / (hl + lambda), lo, hi) > clamp(-(G - gl) / (H - hl + lambda), lo, hi)) continue;
          if (gain > 1e-9 && (!best || gain > best.gain)) best = { gain, f, b, wl: clamp(-gl / (hl + lambda), lo, hi), wr: clamp(-(G - gl) / (H - hl + lambda), lo, hi) };
        }
      }
      if (!best) return leaf;
      const L = [], R = [];
      for (const i of idx) (bin[i][best.f] <= best.b ? L : R).push(i);
      if (mono.has(best.f)) { const mid = (best.wl + best.wr) / 2; return { f: best.f, t: cuts[best.f][best.b], l: grow(L, lvl + 1, lo, Math.min(hi, mid)), r: grow(R, lvl + 1, Math.max(lo, mid), hi) }; }
      return { f: best.f, t: cuts[best.f][best.b], l: grow(L, lvl + 1, lo, hi), r: grow(R, lvl + 1, lo, hi) };
    };
    const tree = grow(rows, 0);
    out.push(tree);
    for (let i = 0; i < n; i++) F[i] += rate * leafValue(tree, X[i]);
  }
  return { features: features || Array.from({ length: d }, (_, i) => `f${i}`), base, rate, trees: out };
}

/** Round thresholds and leaves so the saved model stays small */
export function compact(model) {
  const r = v => Math.round(v * 1e5) / 1e5;
  const walk = n => (n.v !== undefined ? { v: r(n.v) } : { f: n.f, t: r(n.t), l: walk(n.l), r: walk(n.r) });
  return { ...model, base: r(model.base), trees: model.trees.map(walk) };
}
