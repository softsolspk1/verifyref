// integrity/scoring.js - Integrity Risk Scoring Engine. Combines the evidence of every dimension (Integrity Suite
// analysers, Module 4 paper-mill signals, Module 5 image findings, Module 1 reference findings) into one 0-100 score and
// a level, and explains it: every point of the score is traced to a signal with its evidence.
//
//   points per dimension = sum of signal weights, capped (so one noisy dimension cannot dominate)
//   score                = 100 x (1 - e^(-points / 12))          (diminishing returns; 12 points ≈ 63)
//   level                = LOW < 15 ≤ MODERATE < 40 ≤ HIGH < 70 ≤ CRITICAL
//   escalation           = a "definite" strong signal makes the level at least HIGH; three strong signals make it CRITICAL
// The score orders the editor's work; it is not a finding of misconduct.

const DIMENSIONS = {
  similarity: { label: 'Plagiarism & text similarity', cap: 10 },
  ai: { label: 'AI-written content', cap: 6 },
  images: { label: 'Scientific image forensics', cap: 10 },
  data: { label: 'Research data integrity', cap: 8 },
  references: { label: 'Reference & DOI verification', cap: 8 },
  papermill: { label: 'Paper-mill signals', cap: 10 },
  network: { label: 'Submission network', cap: 8 },
  pharma: { label: 'Pharmaceutical validation', cap: 6 },
  ethics: { label: 'Research ethics', cap: 8 },
  authors: { label: 'Authors & affiliations', cap: 6 },
  peer: { label: 'Peer-review integrity', cap: 8 }
};

// Module 4 signals that an Integrity Suite dimension already covers (counted once, there)
const PM_COVERED = new Set(['tortured', 'hidden-text', 'duplicate', 'duplicate-partial', 'ai-leftover', 'statistics', 'statistics-minor', 'primers', 'cell-lines', 'orcid-invalid', 'orcid-empty', 'no-orcid', 'methods', 'images']);

// Strong signals that are close to proof on their own
const DEFINITE = new Set(['leftover', 'archive', 'duplicate-publication', 'published-other', 'registration-not-found', 'shared-email', 'reviewer-ring', 'mill-retraction', 'author-mill-retraction', 'scigen', 'images-strong', 'paraphrase', 'hidden', 'coercive-citation', 'review-recycled']);

const LEVELS = [[70, 'CRITICAL'], [40, 'HIGH'], [15, 'MODERATE'], [0, 'LOW']];
const RANK = { LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };

const RECOMMEND = {
  LOW: 'No integrity concern that needs action. Proceed with the normal editorial process.',
  MODERATE: 'Proceed, but ask the authors about the listed points (author query) before or during peer review.',
  HIGH: 'Hold the manuscript. Open an integrity case, verify the strong signals and query the authors before any further step.',
  CRITICAL: 'Open an integrity case and refer it to the integrity committee (COPE flowcharts). Do not send for review until the case is resolved.'
};

/** Dimension from linked Module 4 / Module 5 / Module 1 results */
function linkedDimensions({ papermill, images, references }) {
  const out = [];
  if (papermill?.signals) {
    const signals = papermill.signals.filter(s => !PM_COVERED.has(s.code)).map(s => ({ ...s, group: 'papermill' }));
    out.push({ key: 'papermill', label: DIMENSIONS.papermill.label, checked: true, signals, source: papermill.id ? { kind: 'papermill', checkId: papermill.id } : null });
  }
  if (images?.summary) {
    const s = images.summary, by = s.byLevel || {};
    const signals = [];
    if (by.high) signals.push({ group: 'images', code: 'images-strong', title: `${by.high} strong image finding(s) (duplicated, manipulated or AI-generated figures)`, severity: 'high', weight: Math.min(8, 4 + by.high), evidence: [], note: 'From the Module 5 Image Integrity report.' });
    if (by.medium) signals.push({ group: 'images', code: 'images-check', title: `${by.medium} image finding(s) to check`, severity: 'medium', weight: Math.min(4, 1 + by.medium * 0.5), evidence: [] });
    if ((images.earlier || []).length) signals.push({ group: 'images', code: 'images-earlier', title: `Figure(s) matching ${images.earlier.length} earlier manuscript(s)`, severity: 'high', weight: 4, evidence: [] });
    out.push({ key: 'images', label: DIMENSIONS.images.label, checked: true, signals, source: images.checkId ? { kind: 'images', checkId: images.checkId } : null });
  }
  if (references?.summary) {
    const s = references.summary;
    const signals = [];
    if (s.suspicious) signals.push({ group: 'references', code: 'fabricated-refs', title: `${s.suspicious} reference(s) not found in any database`, severity: s.suspicious >= 3 ? 'high' : 'medium', weight: s.suspicious >= 3 ? 4 : 2, evidence: [] });
    if (s.retracted) signals.push({ group: 'references', code: 'retracted-refs', title: `${s.retracted} retracted paper(s) cited`, severity: 'low', weight: 1, evidence: [] });
    if (s.miscited >= 5) signals.push({ group: 'references', code: 'miscited', title: `${s.miscited} references with wrong details`, severity: 'low', weight: 1, evidence: [] });
    out.push({ key: 'references', label: DIMENSIONS.references.label, checked: true, signals, source: references.checkId ? { kind: references.kind || 'references', checkId: references.checkId } : null });
  }
  return out;
}

function scoreIntegrity(dimensions) {
  const contributions = [];
  const perDimension = [];
  let points = 0;
  for (const d of dimensions) {
    const cfg = DIMENSIONS[d.key] || { label: d.label, cap: 6 };
    const raw = (d.signals || []).reduce((a, s) => a + (s.weight || 0), 0);
    const capped = Math.min(cfg.cap, raw);
    points += capped;
    perDimension.push({ key: d.key, label: cfg.label, checked: d.checked !== false || (d.signals || []).length > 0, signals: (d.signals || []).length, points: +capped.toFixed(1), capped: raw > cfg.cap, source: d.source || null });
    const scale = raw ? capped / raw : 0;
    for (const s of d.signals || []) contributions.push({ dimension: cfg.label, key: d.key, code: s.code, title: s.title, severity: s.severity, points: +(s.weight * scale).toFixed(2) });
  }
  const score = Math.round(100 * (1 - Math.exp(-points / 12)));
  let level = LEVELS.find(([min]) => score >= min)[1];
  const strong = contributions.filter(c => c.severity === 'high');
  const definite = strong.filter(c => DEFINITE.has(c.code));
  const reasons = [];
  if (definite.length && RANK[level] < RANK.HIGH) { level = 'HIGH'; reasons.push(`Raised to HIGH: definite signal — ${definite[0].title}`); }
  if (strong.length >= 3 && RANK[level] < RANK.CRITICAL) { level = 'CRITICAL'; reasons.push(`Raised to CRITICAL: ${strong.length} strong signals in ${new Set(strong.map(s => s.key)).size} dimension(s)`); }
  // A manuscript screening covers every dimension except peer review (its own check); a peer-review check covers only that
  const expected = dimensions.length && dimensions.every(d => d.key === 'peer') ? ['peer'] : Object.keys(DIMENSIONS).filter(k => k !== 'peer');
  const done = new Set(perDimension.filter(d => d.checked).map(d => d.key));
  const checked = expected.filter(k => done.has(k)).length;
  const notChecked = expected.filter(k => !done.has(k)).map(k => DIMENSIONS[k].label);
  return {
    score, level, points: +points.toFixed(1), strongSignals: strong.length,
    recommendation: RECOMMEND[level],
    explanation: [
      `Score ${score}/100 from ${contributions.length} signal(s) in ${perDimension.filter(d => d.signals).length} of ${perDimension.length} dimension(s) checked.`,
      ...contributions.filter(c => c.points > 0).sort((a, b) => b.points - a.points).slice(0, 12).map(c => `+${c.points} ${c.dimension}: ${c.title} (${c.severity})`),
      ...reasons,
      ...(notChecked.length ? [`Not included (not run or not linked): ${notChecked.join(', ')}.`] : [])
    ],
    dimensions: perDimension,
    contributions: contributions.sort((a, b) => b.points - a.points),
    coverage: { checked, total: expected.length, notChecked },
    method: 'Points per dimension = sum of signal weights (capped per dimension); score = 100 × (1 − e^(−points/12)); LOW < 15 ≤ MODERATE < 40 ≤ HIGH < 70 ≤ CRITICAL; a definite strong signal raises the level to at least HIGH, three strong signals to CRITICAL.'
  };
}

module.exports = { scoreIntegrity, linkedDimensions, DIMENSIONS, RECOMMEND, PM_COVERED };
