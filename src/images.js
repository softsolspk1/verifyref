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
  published: { done: false, note: 'Comparison with all published figures (ImageTwin database): only when the editor sends the manuscript to ImageTwin (Module 5.7); otherwise not checked' }
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
    vendor: await vendorStatus(userId),
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

// ------------------------------------------------------------------ 5.7 ImageTwin API (optional, per manuscript)

const IT = require('./vendors/imagetwin');
const NOT_CONNECTED = 'Not connected. Comparison with ImageTwin’s database of published figures and its AI-image detection are reported as “not checked”. Duplication, manipulation, AI-image indicators and chart duplication are checked inside PJPS, and every figure is compared with the PJPS image databases (published PJPS papers, papers retracted for image problems, reference figures). To connect, the Super Admin sets IMAGETWIN_API_KEY on the web platform (key from the PJPS ImageTwin account: Account > API Access, after ImageTwin activates API access).';

/**
 * Whether the ImageTwin API can be used. The key is held by the web platform only; the desktop asks the platform.
 */
async function vendorStatus(userId = null) {
  if (cfg.DESKTOP) {
    const r = userId ? await require('./desktop').remoteVendor(userId, 'GET', '/api/sync/images/vendor').catch(() => null) : null;
    if (r?.connected) return { ...r, success: undefined, viaPlatform: true };
    return { connected: false, vendor: null, note: r ? NOT_CONNECTED : 'ImageTwin is used through the PJPS web platform, which could not be reached (offline). ' + NOT_CONNECTED };
  }
  if (!IT.configured()) return { connected: false, vendor: null, note: NOT_CONNECTED };
  return {
    connected: true, vendor: 'ImageTwin', sandbox: IT.sandbox(),
    note: `ImageTwin API connected${IT.sandbox() ? ' in SANDBOX mode (free, predefined test results - not a real check)' : ''}. Sending is off by default and chosen per manuscript: the manuscript file leaves PJPS systems and each scan is charged to the PJPS ImageTwin account. ImageTwin compares the figures with its database of published figures and checks for AI-generated images, alterations and duplicates; results stay available at ImageTwin for 90 days.`,
    limits: 'One PDF or Word file under 30 MB with fewer than 50 pages, or up to 25 image files under 20 MB each'
  };
}

const scanRow = r => r && ({ id: r.id, vendor: r.vendor, scanId: r.scan_id, sandbox: r.sandbox, checkId: r.check_id, manuscriptCode: r.manuscript_code, files: r.files, status: r.status,
  result: r.result, level: IT.level(r.result), error: r.error, createdAt: r.created_at, finishedAt: r.finished_at });

/** Copy a finished (or failed) scan into the saved Module 5 report, so exports and later views show it */
async function attachVendorScan(userId, row) {
  if (!row.check_id) return;
  const c = await require('./pipeline').loadCheck(userId, row.check_id).catch(() => null);
  if (!c?.result || c.row.kind !== 'images') return;
  c.result.vendorScan = scanRow(row);
  delete c.result.id; delete c.result.createdAt; delete c.result.issueId;
  await db.query('UPDATE checks SET result = $1 WHERE id = $2 AND user_id = $3', [JSON.stringify(c.result), c.row.id, userId]);
}

/**
 * Send a manuscript (or figure files) to ImageTwin. files: [{ name, buffer, type }]. opts: { checkId, manuscriptCode,
 * minScore, excludeIdenticalPaper, req (for the audit log) }. The desktop forwards through the web platform.
 */
async function startVendorScan(userId, files, opts = {}) {
  const names = files.map(f => f.name).join(', ').slice(0, 500);
  let scanId, sandbox = false, vendor = 'ImageTwin';
  if (cfg.DESKTOP) {
    const r = await require('./desktop').remoteVendorScan(userId, files, opts);
    scanId = String(r.scan.id); sandbox = !!r.scan.sandbox; vendor = 'ImageTwin (via web platform)';
  } else {
    const r = await IT.scan(files, { minScore: opts.minScore, excludeIdenticalPaper: opts.excludeIdenticalPaper });
    scanId = r.scanId; sandbox = r.sandbox;
  }
  const row = await db.one(`INSERT INTO vendor_scans(vendor, scan_id, sandbox, user_id, check_id, manuscript_code, files) VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [vendor, scanId, sandbox, userId, opts.checkId ? Number(opts.checkId) || null : null, opts.manuscriptCode || null, names]);
  require('./auth').audit(opts.req, 'vendor.imagetwin.scan', opts.manuscriptCode || names, { scan: row.id, files: names, sandbox });
  await attachVendorScan(userId, row);
  return scanRow(row);
}

/** Current state of a scan; asks ImageTwin (or the platform) while it is still running */
async function vendorScan(userId, id) {
  let row = await db.one('SELECT * FROM vendor_scans WHERE id = $1 AND user_id = $2', [Number(id) || 0, userId]);
  if (!row) return null;
  if (row.status !== 'running') return scanRow(row);
  let status = 'running', result = null, error = null;
  try {
    if (cfg.DESKTOP) {
      const r = await require('./desktop').remoteVendor(userId, 'GET', `/api/sync/images/vendor/scans/${encodeURIComponent(row.scan_id)}`);
      ({ status, result, error } = r.scan);
    } else {
      result = await IT.result(row.scan_id);
      status = result.status;
      if (status === 'running') result = null;
    }
  } catch (e) {
    // a failed scan (HTTP 500) or an expired one (404) is final; a network problem is retried at the next poll
    if (e.status === 404 || /could not process/i.test(e.message)) { status = 'failed'; error = e.message; }
    else return { ...scanRow(row), pollError: e.message };
  }
  if (status === 'running') return scanRow(row);
  row = await db.one('UPDATE vendor_scans SET status = $1, result = $2, error = $3, finished_at = now() WHERE id = $4 RETURNING *', [status, result ? JSON.stringify(result) : null, error || null, row.id]);
  await attachVendorScan(userId, row);
  return scanRow(row);
}

/** Link a scan started before the report was saved to that report */
async function linkVendorScan(userId, id, checkId) {
  const row = await db.one('UPDATE vendor_scans SET check_id = $1 WHERE id = $2 AND user_id = $3 RETURNING *', [Number(checkId) || null, Number(id) || 0, userId]);
  if (row) await attachVendorScan(userId, row);
  return scanRow(row);
}

module.exports = { compareWithEarlier, compareChartsWithEarlier, saveImageCheck, vendorStatus, startVendorScan, vendorScan, linkVendorScan, MATCH_DISTANCE };
