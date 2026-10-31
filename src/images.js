// images.js - Module 5 Image Integrity, server side. The analysis itself runs in the editor's browser
// (public/js/images/engine.js), so manuscripts with large figures never have to be uploaded. The server stores the
// result, keeps a fingerprint (perceptual hash + small thumbnail) of every figure panel, and compares new panels
// with all earlier PJPS manuscripts to find re-used figures.
const db = require('./db');
const { saveResult } = require('./pipeline');
const KB = require('./imageKnowledge');
const REFS = require('./imageRefs');
const cfg = require('./config');

const COVERAGE = {
  duplication: { done: true, note: 'Whole, partial, rotated, mirrored, resized, cropped copies - inside the manuscript, against earlier PJPS manuscripts, published PJPS papers and papers retracted for image problems' },
  manipulation: { done: true, note: 'Cloned areas, pasted patches (noise, JPEG grid), erasure, joined blot lanes, stretched contrast' },
  ai: { done: true, note: 'File markers (C2PA, generator tags) + statistical traces; indicators, not proof' },
  chart: { done: true, note: 'Bar heights and curves read from graphs and compared with other graphs, earlier manuscripts and the reference databases' },
  references: { done: true, note: 'PJPS image databases: published PJPS papers (pjps.pk), open-access papers retracted or corrected for image problems, and reference figures held by the editorial office' },
  published: { done: false, note: 'Commercial databases of all published figures (ImageTwin, Proofig) are not searched: by PJPS policy figures never leave the PJPS system' }
};
const METHOD = 'Analysed in the editor browser. (a) Duplication: figures were split into panels; every pair was compared with perceptual hashes in 8 orientations and ORB keypoint matching with RANSAC (rotated, mirrored, resized, cropped or partly overlapping copies), and with the figures of all earlier PJPS manuscripts. (b) Alteration / manipulation: cloned areas (keypoint self-matching and DCT block matching), noise-level and JPEG-grid inconsistency, noise-free retouched areas, sharp background steps between blot lanes, combed histograms and saturated bands. (c) AI-generated images: provenance markers in the image files (C2PA / IPTC, generator names, generation parameters) and statistical traces (spectral peaks, missing or uniform sensor noise); statistics alone are shown only as indicators to check. (d) Graphs and charts: bar heights and curves were read from the pixels and compared across charts - also re-coloured, re-scaled or reversed - and with earlier manuscripts. (e) Reference databases: every panel and chart was also compared - in all orientations, as a crop and as an enlargement - with the figures of published PJPS papers, of open-access papers retracted or corrected for image problems and of the reference figures held by the editorial office; each candidate was verified by correlating the aligned thumbnails.';

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
  const mine = panels.filter(p => Array.isArray(p.hashes) && p.hashes.every(isHex)).map(p => ({ ...p, hv: p.hashes.map(parse), wv: (p.windows || []).filter(isHex).map(parse) }));
  if (!mine.length) return [];
  const rows = await db.all("SELECT id, check_id, manuscript_code, title, data, created_at FROM fingerprints WHERE kind = 'image' ORDER BY created_at DESC LIMIT 5000");
  const out = [];
  for (const r of rows) {
    if (excludeCode && r.manuscript_code === excludeCode) continue;
    if (excludeCheck && r.check_id === excludeCheck) continue;
    for (const h of r.data?.hashes || []) {
      if (!isHex(h.h)) continue;
      const hv = parse(h.h);
      const theirWindows = (h.v || []).filter(isHex).map(parse);
      for (const p of mine) {
        const d = Math.min(...p.hv.map(x => dist(x, hv)));
        if (d <= MATCH_DISTANCE) { out.push({ panel: p.id, panelLabel: p.label, checkId: r.check_id, manuscriptCode: r.manuscript_code, title: r.title, label: h.label, thumb: h.thumb || null, distance: d, how: 'whole', date: r.created_at }); continue; }
        // cropped re-use: this panel = a crop of the earlier one, or the reverse (5 windows of 75%, stricter limit)
        const dc = Math.min(99, ...theirWindows.flatMap(w => p.hv.map(x => dist(x, w))));
        const dw = Math.min(99, ...p.wv.map(w => dist(w, hv)));
        if (Math.min(dc, dw) <= MATCH_DISTANCE - 1) out.push({ panel: p.id, panelLabel: p.label, checkId: r.check_id, manuscriptCode: r.manuscript_code, title: r.title, label: h.label, thumb: h.thumb || null, distance: Math.min(dc, dw), how: dc <= dw ? 'crop' : 'contains', date: r.created_at });
      }
    }
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, 50);
}

const KINDS = ['duplicate', 'partial', 'clone', 'alteration', 'ai', 'chart'];
const CATEGORIES = ['duplication', 'manipulation', 'ai', 'chart'];

const cap = (s, n) => (typeof s === 'string' && s.length <= n ? s : null);

// ---- graph & chart data compared with earlier manuscripts (same rules as public/js/images/forensics.js compareSeries)
const { sameSeries, cleanSeries } = REFS;

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
    id: String(p.id), label: String(p.label || '').slice(0, 120), letter: /^[A-Z]$/.test(String(p.letter || '')) ? String(p.letter) : null, imageId: String(p.imageId || ''), type: String(p.type || ''), blank: !!p.blank,
    box: p.box && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(p.box[k])) ? { x: p.box.x | 0, y: p.box.y | 0, w: p.box.w | 0, h: p.box.h | 0 } : null,
    hashes: (p.hashes || []).filter(isHex).slice(0, 8), windows: (p.windows || []).filter(isHex).slice(0, 5), thumb: cap(p.thumb, 40000), w: p.w | 0, h: p.h | 0
  }));
  const findings = (input.findings || []).slice(0, 80).map((f, i) => ({
    id: String(f.id || `f${i + 1}`), kind: KINDS.includes(f.kind) ? f.kind : 'duplicate', category: CATEGORIES.includes(f.category) ? f.category : 'duplication', details: (Array.isArray(f.details) ? f.details : []).slice(0, 8).map(d => String(d).slice(0, 300)), level: f.level === 'high' ? 'high' : 'medium', description: String(f.description || '').slice(0, 400),
    a: { panel: String(f.a?.panel), label: String(f.a?.label || '').slice(0, 120), box: f.a?.box || null }, b: { panel: String(f.b?.panel), label: String(f.b?.label || '').slice(0, 120), box: f.b?.box || null },
    transform: f.transform || null, score: Number(f.score) || 0,
    verification: f.verification && typeof f.verification === 'object' ? Object.fromEntries(['picture', 'noise', 'region'].filter(k => Number.isFinite(f.verification[k])).map(k => [k, Math.round(f.verification[k] * 100) / 100])) : null,
    thumbA: cap(f.thumbA, 160000), thumbB: cap(f.thumbB, 160000), thumbAW: f.thumbAW | 0, thumbAH: f.thumbAH | 0, thumbBW: f.thumbBW | 0, thumbBH: f.thumbBH | 0
  })).map(f => ({ ...f, assessment: KB.assess(f) }));
  const usable = panels.filter(p => !p.blank && p.type !== 'chart');
  let earlier = await compareWithEarlier(usable, { excludeCode: meta.manuscriptCode || null });
  const charts = cleanSeries(input.charts);
  let earlierCharts = await compareChartsWithEarlier(charts, { excludeCode: meta.manuscriptCode || null });
  let refs;
  if (cfg.DESKTOP) {
    // Desktop: the PJPS-wide fingerprints and the image reference databases are on the web platform; offline, only the
    // manuscripts screened on this computer are compared (and the report says so)
    const r = await require('./desktop').remoteImageMatch(userId, usable, charts, meta.manuscriptCode || null).catch(e => ({ error: e.message }));
    if (r.refs) {
      const keyOf = e => `${e.manuscriptCode}|${e.label}|${e.panel}`;
      const seen = new Set(earlier.map(keyOf));
      earlier = [...earlier, ...r.earlier.filter(e => !seen.has(keyOf(e)))].sort((a, b) => a.distance - b.distance).slice(0, 50);
      earlierCharts = [...earlierCharts, ...r.earlierCharts].sort((a, b) => b.correlation - a.correlation).slice(0, 30);
      refs = r.refs;
    } else refs = { matches: [], charts: [], searched: null, error: `The PJPS image databases are on the web platform and could not be searched (${r.error}). Only the manuscripts screened on this computer were compared; run the check again when online.` };
  } else refs = await REFS.matchManuscript(usable, charts).catch(e => ({ matches: [], charts: [], searched: null, error: e.message }));
  const byLevel = { high: findings.filter(f => f.level === 'high').length, medium: findings.filter(f => f.level === 'medium').length };
  if (earlier.some(e => e.distance <= 3) || earlierCharts.some(e => e.correlation >= 0.998)) byLevel.high++;
  if (refs.matches.some(m => m.level === 'high') || refs.charts.some(c => c.correlation >= 0.998)) byLevel.high++;
  const refCount = refs.matches.length + refs.charts.length;
  const level = byLevel.high ? 'HIGH' : byLevel.medium || earlier.length || earlierCharts.length || refCount ? 'MEDIUM' : 'LOW';
  const result = {
    kind: 'images', module: 5, meta, createdAt: new Date().toISOString(),
    summary: {
      images: Number(input.summary?.images) || 0, panels: panels.length, skipped: (input.skipped || []).length, findings: findings.length,
      byLevel, byKind: findings.reduce((a, f) => ({ ...a, [f.kind]: (a[f.kind] || 0) + 1 }), {}), byCategory: findings.reduce((a, f) => ({ ...a, [f.category]: (a[f.category] || 0) + 1 }), {}), earlier: earlier.length, earlierCharts: earlierCharts.length,
      references: refs.matches.length, referenceCharts: refs.charts.length,
      referencesPjps: refs.matches.filter(m => m.source === 'pjps').length + refs.charts.filter(m => m.source === 'pjps').length,
      referencesRetracted: refs.matches.filter(m => m.source === 'retracted').length + refs.charts.filter(m => m.source === 'retracted').length, level
    },
    images: (input.images || []).slice(0, 200).map(im => ({ id: String(im.id), label: String(im.label || '').slice(0, 160), width: im.width | 0, height: im.height | 0, panels: im.panels | 0, source: String(im.source || '') })),
    panels, findings, earlier, earlierCharts, references: refs.matches, referenceCharts: refs.charts, referencesSearched: refs.searched, referencesError: refs.error || null, coverage: COVERAGE, provenanceChecked: Number(input.provenance) || 0,
    skipped: (input.skipped || []).slice(0, 100).map(s => ({ name: String(s.name || '').slice(0, 160), reason: String(s.reason || '').slice(0, 200) })),
    vendor: await vendorStatus(),
    guidance: KB.guidance(level),
    method: METHOD,
    disclaimer: 'Screening aid only. Repeated textures (cells, tissue, gel background), legitimately re-used control images and heavily processed or denoised pictures can look like copies, edits or AI images; AI-image statistics are indicators only, and a missing marker does not prove an image is genuine; every finding must be checked by the editor, and original images requested where needed. Confidential — not for authors or reviewers.'
  };
  if (!save) return { result, earlier };
  const problems = [`Image risk ${level}`, byLevel.high ? `${byLevel.high} strong image finding(s)` : null, byLevel.medium ? `${byLevel.medium} image finding(s) to check` : null, earlier.length ? `${earlier.length} figure(s) matching earlier PJPS manuscripts` : null,
    refCount ? `${refCount} figure(s) matching published PJPS / retracted-paper figures` : null].filter(Boolean);
  const id = await saveResult(userId, 'images', result, { title: meta.title || meta.filename || 'Image integrity', manuscriptCode: meta.manuscriptCode, refTotal: panels.length, problems, counts: { suspicious: byLevel.high, unverified: byLevel.medium } });
  if (usable.length || charts.length) {
    await db.query("INSERT INTO fingerprints(check_id, user_id, manuscript_code, kind, title, data) VALUES($1, $2, $3, 'image', $4, $5)",
      [id, userId, meta.manuscriptCode || null, meta.title || meta.filename || null, JSON.stringify({ hashes: usable.map(p => ({ h: p.hashes[0], v: p.windows.length === 5 ? p.windows : undefined, label: p.label, thumb: p.thumb && p.thumb.length < 9000 ? p.thumb : null })), charts })]);
  }
  return { id, result, earlier };
}

/**
 * PJPS policy: figures are analysed inside the PJPS system only (in the editor's browser and on the PJPS server) and
 * are never sent to an outside service such as ImageTwin or Proofig. The report states this, and what that leaves out.
 */
async function vendorStatus() {
  return {
    connected: false,
    vendor: null,
    inHouseOnly: true,
    note: 'PJPS policy: figures are checked within the PJPS system only and are never sent to an outside service (ImageTwin, Proofig). Duplication, manipulation, AI-image indicators and chart duplication are checked here, and every figure is compared with all earlier PJPS manuscripts and the PJPS image databases (published PJPS papers, papers retracted for image problems, PubMed Central open-access figures, reference figures). Commercial databases of all published figures are therefore not searched.'
  };
}

/** Width and height of a JPEG (from its SOF marker) */
function jpegSize(buf) {
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xFF) return null;
    const m = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/**
 * Word / PDF export of a Module 5 report: the reference-database figures are kept on R2, so their thumbnails are loaded
 * here and put next to the manuscript's panel (as in the commercial reports). Returns a copy of the result.
 */
async function withExportThumbs(result, userId, { max = 20 } = {}) {
  if (!result?.references?.length) return result;
  const refs = await Promise.all(result.references.map(async (m, i) => {
    if (i >= max || !m.hasThumb || !m.refId) return m;
    const buf = await (cfg.DESKTOP ? require('./desktop').remoteRefThumb(userId, m.refId) : REFS.thumbKey(m.refId).then(k => REFS.refThumb(k))).catch(() => null);
    const size = buf ? jpegSize(buf) : null;
    return size ? { ...m, refThumb: `data:image/jpeg;base64,${buf.toString('base64')}`, refThumbW: size.w, refThumbH: size.h } : m;
  }));
  return { ...result, references: refs };
}

module.exports = { compareWithEarlier, compareChartsWithEarlier, saveImageCheck, vendorStatus, withExportThumbs, MATCH_DISTANCE };
