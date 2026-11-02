// imageScore.js - Module 5 confidence scores (0-100 %) in the bands ImageTwin uses: Low 0-32 (hidden by default),
// Fair 33-65, High 66-100. The score says how likely a finding is a real integrity concern rather than acceptable or
// expected re-use. It is built from the measurements each detector already reports (pixel and noise agreement, matching
// points, fingerprint distance), the finding type's usual false-alarm risk (taxonomy) and known harmless patterns (one
// microscopy field shown as a merge and its single channels). A "strong" finding always lands in High and a "to check"
// finding in Fair, unless a harmless pattern pushes it to Low - so the score refines the level, it never contradicts it.
// Also: which AI image generator is named by a file marker (attribution only from evidence in the file).

const BANDS = [[66, 'high', 'High'], [33, 'fair', 'Fair'], [0, 'low', 'Low']];
const band = c => BANDS.find(([min]) => c >= min);
const clamp01 = v => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.5);

const CHANNELS = /different colour channels/i;
// taxonomy false-alarm risk -> share of the band kept
const FP_FACTOR = { VERY_LOW: 1, LOW: 1, MEDIUM: 0.8, MEDIUM_HIGH: 0.6, HIGH: 0.4 };

/** Strength of the measured evidence of a finding, 0..1 */
function strength(f) {
  const v = f.verification || {};
  switch (f.kind) {
    case 'duplicate': {
      const parts = [];
      if (Number.isFinite(v.picture)) parts.push(norm(v.picture, 0.75, 1));
      if (Number.isFinite(v.noise)) parts.push(norm(v.noise, 0.3, 1));
      if (!parts.length) parts.push(norm(f.score, 0.9, 1));
      return mean(parts);
    }
    case 'partial': return Number.isFinite(v.region) ? 0.6 * norm(v.region, 0.5, 1) + 0.4 * norm(f.score, 10, 40) : 0.6 * norm(f.score, 10, 40);
    // keypoint clones report 8-40 matching points, DCT block clones 30-300 blocks
    case 'clone': return f.score > 60 ? norm(f.score, 30, 200) : norm(f.score, 6, 30);
    case 'chart': return norm(f.score, 95, 100);
    case 'ai': return f.code === 'provenance' ? 1 : norm(f.score, 1, 4);
    case 'alteration': return f.score >= 3 ? 0.7 : 0.4;
    default: return 0.5;
  }
}

/** Confidence of an in-manuscript finding: { confidence, band, bandLabel } */
function findingConfidence(f) {
  const q = strength(f);
  const fp = FP_FACTOR[f.assessment?.falsePositiveRisk] ?? 0.8;
  let c;
  if (CHANNELS.test(f.description || '')) c = 12 + 20 * q;                 // a merge and its single channels: normal practice
  else if (f.level === 'high') c = 66 + 34 * q * (0.5 + 0.5 * fp);
  else c = 33 + 32 * q * fp;
  c = Math.round(Math.max(0, Math.min(100, c)));
  const [, key, label] = band(c);
  return { confidence: c, band: key, bandLabel: label };
}

/** Confidence of a match with a reference / published figure or an earlier manuscript (fingerprint distance 0-64) */
function matchConfidence(m, strongDistance = 3) {
  const d = Number(m.distance);
  const q = mean([1 - norm(d, 0, 6), ...(Number.isFinite(m.correlation) ? [norm(m.correlation, 0.8, 1)] : [])]);
  const strong = m.level ? m.level === 'high' : d <= strongDistance;
  const c = Math.round(strong ? 66 + 34 * q : 33 + 32 * q);
  const [, key, label] = band(c);
  return { confidence: c, band: key, bandLabel: label };
}

const GENERATORS = [
  [/DALL[-·\s]?E|Bing Image Creator/i, 'DALL-E (OpenAI)'], [/Midjourney/i, 'Midjourney'], [/Adobe Firefly|Firefly/i, 'Adobe Firefly'],
  [/Stable ?Diffusion|DreamStudio|Automatic1111|ComfyUI|InvokeAI|Steps:|Sampler:|CFG scale|Negative prompt/i, 'Stable Diffusion'],
  [/Leonardo\.?Ai/i, 'Leonardo.Ai'], [/Ideogram/i, 'Ideogram'], [/NightCafe/i, 'NightCafe'], [/Craiyon/i, 'Craiyon'],
  [/SynthID|Imagen ?\d|Nano ?Banana/i, 'Google Imagen / Gemini']
];

/**
 * Generator attribution of an AI finding. Only a name written in the file counts; a C2PA / IPTC marker without a
 * name and the statistical indicators say "not identified" - no model guesses a generator here.
 */
function aiAttribution(f) {
  if (f.kind !== 'ai') return null;
  const text = (f.details || []).join(' ');
  const named = [...new Set(GENERATORS.filter(([re]) => re.test(text)).map(([, n]) => n))];
  if (named.length) return { generators: named.map(name => ({ name, share: Math.round(100 / named.length) })), basis: 'named in the image file (metadata marker)' };
  if (f.code === 'provenance') return { generators: [], basis: 'AI-generation marker in the file, generator not named' };
  return { generators: [], basis: 'statistical indicators only - generator not identified' };
}

/** Adds confidence (and AI attribution) to a saved Module 5 result in place; returns the counts per band */
function scoreResult(r) {
  for (const f of r.findings || []) Object.assign(f, findingConfidence(f), f.kind === 'ai' ? { attribution: aiAttribution(f) } : {});
  for (const m of r.references || []) Object.assign(m, matchConfidence(m));
  for (const e of r.earlier || []) Object.assign(e, matchConfidence(e));
  for (const m of r.authorFigures?.matches || []) Object.assign(m, matchConfidence(m));
  const all = [...(r.findings || []), ...(r.references || []), ...(r.earlier || [])];
  return { high: all.filter(x => x.band === 'high').length, fair: all.filter(x => x.band === 'fair').length, low: all.filter(x => x.band === 'low').length };
}

module.exports = { findingConfidence, matchConfidence, aiAttribution, scoreResult, band, BANDS };
