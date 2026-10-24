// images.js - Module 5 Image Integrity, server side. The analysis itself runs in the editor's browser
// (public/js/images/engine.js), so manuscripts with large figures never have to be uploaded. The server stores the
// result, keeps a fingerprint (perceptual hash + small thumbnail) of every figure panel, and compares new panels
// with all earlier PJPS manuscripts to find re-used figures.
const db = require('./db');
const { saveResult } = require('./pipeline');

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

const cap = (s, n) => (typeof s === 'string' && s.length <= n ? s : null);

/** Sanitise and store a browser analysis; returns { id, earlier } */
async function saveImageCheck(userId, input, { save = true } = {}) {
  const meta = { title: String(input.meta?.title || '').slice(0, 300), manuscriptCode: String(input.meta?.manuscriptCode || '').slice(0, 60), filename: String(input.meta?.filename || '').slice(0, 200) };
  const panels = (input.panels || []).slice(0, 400).map(p => ({
    id: String(p.id), label: String(p.label || '').slice(0, 120), imageId: String(p.imageId || ''), type: String(p.type || ''), blank: !!p.blank,
    hashes: (p.hashes || []).filter(isHex).slice(0, 8), thumb: cap(p.thumb, 40000), w: p.w | 0, h: p.h | 0
  }));
  const findings = (input.findings || []).slice(0, 80).map((f, i) => ({
    id: String(f.id || `f${i + 1}`), kind: String(f.kind), level: f.level === 'high' ? 'high' : 'medium', description: String(f.description || '').slice(0, 400),
    a: { panel: String(f.a?.panel), label: String(f.a?.label || '').slice(0, 120), box: f.a?.box || null }, b: { panel: String(f.b?.panel), label: String(f.b?.label || '').slice(0, 120), box: f.b?.box || null },
    transform: f.transform || null, score: Number(f.score) || 0,
    thumbA: cap(f.thumbA, 160000), thumbB: cap(f.thumbB, 160000), thumbAW: f.thumbAW | 0, thumbAH: f.thumbAH | 0, thumbBW: f.thumbBW | 0, thumbBH: f.thumbBH | 0
  }));
  const usable = panels.filter(p => !p.blank && p.type !== 'chart');
  const earlier = await compareWithEarlier(usable, { excludeCode: meta.manuscriptCode || null });
  const byLevel = { high: findings.filter(f => f.level === 'high').length, medium: findings.filter(f => f.level === 'medium').length };
  if (earlier.some(e => e.distance <= 3)) byLevel.high++;
  const level = byLevel.high ? 'HIGH' : byLevel.medium || earlier.length ? 'MEDIUM' : 'LOW';
  const result = {
    kind: 'images', module: 5, meta, createdAt: new Date().toISOString(),
    summary: {
      images: Number(input.summary?.images) || 0, panels: panels.length, skipped: (input.skipped || []).length, findings: findings.length,
      byLevel, byKind: findings.reduce((a, f) => ({ ...a, [f.kind]: (a[f.kind] || 0) + 1 }), {}), earlier: earlier.length, level
    },
    images: (input.images || []).slice(0, 200).map(im => ({ id: String(im.id), label: String(im.label || '').slice(0, 160), width: im.width | 0, height: im.height | 0, panels: im.panels | 0, source: String(im.source || '') })),
    panels, findings, earlier,
    skipped: (input.skipped || []).slice(0, 100).map(s => ({ name: String(s.name || '').slice(0, 160), reason: String(s.reason || '').slice(0, 200) })),
    vendor: await vendorStatus(),
    method: 'Analysed in the editor\'s browser: figures were split into panels; every pair of panels was compared with perceptual hashes in 8 orientations and ORB keypoint matching with RANSAC (catches rotated, mirrored, resized, cropped and partly overlapping copies); each panel was searched for cloned areas (keypoint self-matching and DCT block matching). Panels were compared with the figures of all earlier PJPS manuscripts.',
    disclaimer: 'Screening aid only. Repeated textures (cells, tissue, gel background) and legitimately re-used control images can look like copies; every finding must be checked by the editor, and original images requested where needed. Confidential — not for authors or reviewers.'
  };
  if (!save) return { result, earlier };
  const problems = [`Image risk ${level}`, byLevel.high ? `${byLevel.high} strong image finding(s)` : null, byLevel.medium ? `${byLevel.medium} image finding(s) to check` : null, earlier.length ? `${earlier.length} figure(s) matching earlier PJPS manuscripts` : null].filter(Boolean);
  const id = await saveResult(userId, 'images', result, { title: meta.title || meta.filename || 'Image integrity', manuscriptCode: meta.manuscriptCode, refTotal: panels.length, problems, counts: { suspicious: byLevel.high, unverified: byLevel.medium } });
  if (usable.length) {
    await db.query("INSERT INTO fingerprints(check_id, user_id, manuscript_code, kind, title, data) VALUES($1, $2, $3, 'image', $4, $5)",
      [id, userId, meta.manuscriptCode || null, meta.title || meta.filename || null, JSON.stringify({ hashes: usable.map(p => ({ h: p.hashes[0], label: p.label, thumb: p.thumb && p.thumb.length < 9000 ? p.thumb : null })) })]);
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
      : 'Not connected. Comparison with 155–160 million published figures and AI-generated image detection are available only through a commercial vendor (ImageTwin or Proofig). These two checks are reported as “not checked”.'
  };
}

module.exports = { compareWithEarlier, saveImageCheck, vendorStatus, MATCH_DISTANCE };
