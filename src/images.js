// images.js - Module 5 Image Integrity, server side. The analysis itself runs in the editor's browser
// (public/js/images/engine.js), so manuscripts with large figures never have to be uploaded. The server stores the
// result, keeps a fingerprint (perceptual hash + small thumbnail) of every figure panel, and compares new panels
// with all earlier PJPS manuscripts to find re-used figures.
const db = require('./db');
const { saveResult } = require('./pipeline');

const COVERAGE = {
  duplication: { done: true, note: 'Whole, partial, rotated, mirrored, resized copies - inside the manuscript and against earlier PJPS manuscripts' },
  manipulation: { done: true, note: 'Cloned areas, pasted patches (noise, JPEG grid), erasure, joined blot lanes, stretched contrast' },
  ai: { done: true, note: 'File markers (C2PA, generator tags) + statistical traces; indicators, not proof' },
  chart: { done: true, note: 'Bar heights and curves read from graphs and compared with other graphs and earlier manuscripts' },
  published: { done: false, note: 'Comparison with 155-160 million published figures needs an ImageTwin / Proofig contract: not checked' }
};
const METHOD = 'Analysed in the editor browser. (a) Duplication: figures were split into panels; every pair was compared with perceptual hashes in 8 orientations and ORB keypoint matching with RANSAC (rotated, mirrored, resized, cropped or partly overlapping copies), and with the figures of all earlier PJPS manuscripts. (b) Alteration / manipulation: cloned areas (keypoint self-matching and DCT block matching), noise-level and JPEG-grid inconsistency, noise-free retouched areas, sharp background steps between blot lanes, combed histograms and saturated bands. (c) AI-generated images: provenance markers in the image files (C2PA / IPTC, generator names, generation parameters) and statistical traces (spectral peaks, missing or uniform sensor noise); statistics alone are shown only as indicators to check. (d) Graphs and charts: bar heights and curves were read from the pixels and compared across charts - also re-coloured, re-scaled or reversed - and with earlier manuscripts.';

const MATCH_DISTANCE = 6; // max differing bits (of 64) for "same figure"

const popcnt = v => { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
const parse = hex => [parseInt(String(hex).slice(0, 8), 16) >>> 0, parseInt(String(hex).slice(8, 16), 16) >>> 0];
const dist = (a, b) => popcnt(a[0] ^ b[0]) + popcnt(a[1] ^ b[1]);
const isHex = h => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h);

/**
 * panels: [{ id, label, hashes: [8 hex], thumb }] — compares every orientation of the new panels with the stored
 * (upright) hashes of earlier manuscripts.
 */
async function compareWithEarlier(panels, { excludeCode = null, excludeCheck = null } = {}) {
  const mine = panels.filter(p => Array.isArray(p.hashes) && p.hashes.every(isHex)).map(p => ({ ...p, hv: p.hashes.map(parse) }));
  if (!mine.length) return [];
  const rows = await db.all("SELECT id, check_id, manuscript_code, title, data, created_at FROM fingerprints WHERE kind = 'image' ORDER BY created_at DESC LIMIT 5000");
  const out = [];
  for (const r of rows) {
    if (excludeCode && r.manuscript_code === excludeCode) continue;
    if (excludeCheck && r.check_id === excludeCheck) continue;
    for (const h of r.data?.hashes || []) {
      if (!isHex(h.h)) continue;
      const hv = parse(h.h);
      for (const p of mine) {
        const d = Math.min(...p.hv.map(x => dist(x, hv)));
        if (d <= MATCH_DISTANCE) out.push({ panel: p.id, panelLabel: p.label, checkId: r.check_id, manuscriptCode: r.manuscript_code, title: r.title, label: h.label, thumb: h.thumb || null, distance: d, date: r.created_at });
      }
    }
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, 50);
}

const KINDS = ['duplicate', 'partial', 'clone', 'alteration', 'ai', 'chart'];
const CATEGORIES = ['duplication', 'manipulation', 'ai', 'chart'];

const cap = (s, n) => (typeof s === 'string' && s.length <= n ? s : null);

// ---- graph & chart data compared with earlier manuscripts (same rules as public/js/images/forensics.js compareSeries)
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
function sameSeries(a, b) {
  if (a.kind !== b.kind) return null;
  if (a.kind === 'bars') {
    if (a.n !== b.n || a.n < 4 || a.spread < 0.12 || b.spread < 0.12) return null;
    const c = Math.max(pearson(a.v, b.v), pearson(a.v, [...b.v].reverse()));
    return c >= (a.n >= 6 ? 0.995 : 0.998) ? c : null;
  }
  if ((a.wiggle || 0) < 0.06 || (b.wiggle || 0) < 0.06) return null;
  const c = pearson(a.v, b.v);
  return c >= 0.996 ? c : null;
}
const cleanSeries = list => (Array.isArray(list) ? list : []).slice(0, 60).filter(c => c && Array.isArray(c.v) && c.v.length >= 4 && c.v.length <= 64 && c.v.every(Number.isFinite))
  .map(c => ({ label: String(c.label || '').slice(0, 120), kind: c.kind === 'line' ? 'line' : 'bars', n: c.v.length, v: c.v, spread: Number(c.spread) || 0, wiggle: Number(c.wiggle) || 0 }));

async function compareChartsWithEarlier(charts, { excludeCode = null, excludeCheck = null } = {}) {
  if (!charts.length) return [];
  const rows = await db.all("SELECT check_id, manuscript_code, title, data, created_at FROM fingerprints WHERE kind = 'image' ORDER BY created_at DESC LIMIT 5000");
  const out = [];
  for (const r of rows) {
    if (excludeCode && r.manuscript_code === excludeCode) continue;
    if (excludeCheck && r.check_id === excludeCheck) continue;
    for (const t of cleanSeries(r.data?.charts)) for (const m of charts) {
      const c = sameSeries(m, t);
      if (c) out.push({ chart: m.label, checkId: r.check_id, manuscriptCode: r.manuscript_code, title: r.title, label: t.label, correlation: Math.round(c * 1000) / 1000, date: r.created_at });
    }
  }
  return out.sort((a, b) => b.correlation - a.correlation).slice(0, 30);
}

/** Sanitise and store a browser analysis; returns { id, earlier } */
async function saveImageCheck(userId, input, { save = true } = {}) {
  const meta = { title: String(input.meta?.title || '').slice(0, 300), manuscriptCode: String(input.meta?.manuscriptCode || '').slice(0, 60), filename: String(input.meta?.filename || '').slice(0, 200) };
  const panels = (input.panels || []).slice(0, 400).map(p => ({
    id: String(p.id), label: String(p.label || '').slice(0, 120), imageId: String(p.imageId || ''), type: String(p.type || ''), blank: !!p.blank,
    hashes: (p.hashes || []).filter(isHex).slice(0, 8), thumb: cap(p.thumb, 40000), w: p.w | 0, h: p.h | 0
  }));
  const findings = (input.findings || []).slice(0, 80).map((f, i) => ({
    id: String(f.id || `f${i + 1}`), kind: KINDS.includes(f.kind) ? f.kind : 'duplicate', category: CATEGORIES.includes(f.category) ? f.category : 'duplication', details: (Array.isArray(f.details) ? f.details : []).slice(0, 8).map(d => String(d).slice(0, 300)), level: f.level === 'high' ? 'high' : 'medium', description: String(f.description || '').slice(0, 400),
    a: { panel: String(f.a?.panel), label: String(f.a?.label || '').slice(0, 120), box: f.a?.box || null }, b: { panel: String(f.b?.panel), label: String(f.b?.label || '').slice(0, 120), box: f.b?.box || null },
    transform: f.transform || null, score: Number(f.score) || 0,
    thumbA: cap(f.thumbA, 160000), thumbB: cap(f.thumbB, 160000), thumbAW: f.thumbAW | 0, thumbAH: f.thumbAH | 0, thumbBW: f.thumbBW | 0, thumbBH: f.thumbBH | 0
  }));
  const usable = panels.filter(p => !p.blank && p.type !== 'chart');
  const earlier = await compareWithEarlier(usable, { excludeCode: meta.manuscriptCode || null });
  const charts = cleanSeries(input.charts);
  const earlierCharts = await compareChartsWithEarlier(charts, { excludeCode: meta.manuscriptCode || null });
  const byLevel = { high: findings.filter(f => f.level === 'high').length, medium: findings.filter(f => f.level === 'medium').length };
  if (earlier.some(e => e.distance <= 3) || earlierCharts.some(e => e.correlation >= 0.998)) byLevel.high++;
  const level = byLevel.high ? 'HIGH' : byLevel.medium || earlier.length || earlierCharts.length ? 'MEDIUM' : 'LOW';
  const result = {
    kind: 'images', module: 5, meta, createdAt: new Date().toISOString(),
    summary: {
      images: Number(input.summary?.images) || 0, panels: panels.length, skipped: (input.skipped || []).length, findings: findings.length,
      byLevel, byKind: findings.reduce((a, f) => ({ ...a, [f.kind]: (a[f.kind] || 0) + 1 }), {}), byCategory: findings.reduce((a, f) => ({ ...a, [f.category]: (a[f.category] || 0) + 1 }), {}), earlier: earlier.length, earlierCharts: earlierCharts.length, level
    },
    images: (input.images || []).slice(0, 200).map(im => ({ id: String(im.id), label: String(im.label || '').slice(0, 160), width: im.width | 0, height: im.height | 0, panels: im.panels | 0, source: String(im.source || '') })),
    panels, findings, earlier, earlierCharts, coverage: COVERAGE, provenanceChecked: Number(input.provenance) || 0,
    skipped: (input.skipped || []).slice(0, 100).map(s => ({ name: String(s.name || '').slice(0, 160), reason: String(s.reason || '').slice(0, 200) })),
    vendor: await vendorStatus(),
    method: METHOD,
    disclaimer: 'Screening aid only. Repeated textures (cells, tissue, gel background), legitimately re-used control images and heavily processed or denoised pictures can look like copies, edits or AI images; AI-image statistics are indicators only, and a missing marker does not prove an image is genuine; every finding must be checked by the editor, and original images requested where needed. Confidential — not for authors or reviewers.'
  };
  if (!save) return { result, earlier };
  const problems = [`Image risk ${level}`, byLevel.high ? `${byLevel.high} strong image finding(s)` : null, byLevel.medium ? `${byLevel.medium} image finding(s) to check` : null, earlier.length ? `${earlier.length} figure(s) matching earlier PJPS manuscripts` : null].filter(Boolean);
  const id = await saveResult(userId, 'images', result, { title: meta.title || meta.filename || 'Image integrity', manuscriptCode: meta.manuscriptCode, refTotal: panels.length, problems, counts: { suspicious: byLevel.high, unverified: byLevel.medium } });
  if (usable.length || charts.length) {
    await db.query("INSERT INTO fingerprints(check_id, user_id, manuscript_code, kind, title, data) VALUES($1, $2, $3, 'image', $4, $5)",
      [id, userId, meta.manuscriptCode || null, meta.title || meta.filename || null, JSON.stringify({ hashes: usable.map(p => ({ h: p.hashes[0], label: p.label, thumb: p.thumb && p.thumb.length < 9000 ? p.thumb : null })), charts })]);
  }
  return { id, result, earlier };
}

/**
 * Optional commercial connection (ImageTwin / Proofig) for the two checks that cannot be built in-house: comparison
 * with 155-160 million published figures and AI-generated image detection. Requires a PJPS contract and the vendor's
 * API documentation; until then the report states "not checked".
 */
async function vendorStatus() {
  const vendor = process.env.IMAGETWIN_API_KEY ? 'ImageTwin' : process.env.PROOFIG_API_KEY ? 'Proofig' : null;
  return {
    connected: false,
    vendor,
    note: vendor
      ? `${vendor} API key configured — the connection will be activated once the vendor's API specification is provided under the PJPS contract.`
      : 'Not connected. Comparison with 155–160 million published figures is available only through a commercial vendor (ImageTwin or Proofig) and is reported as “not checked”. Duplication, manipulation, AI-image indicators and chart duplication are checked inside PJPS.'
  };
}

module.exports = { compareWithEarlier, compareChartsWithEarlier, saveImageCheck, vendorStatus, MATCH_DISTANCE };
