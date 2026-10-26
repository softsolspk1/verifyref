// imageKnowledge.js - Module 5 knowledge base built from the ImageTwin / Proofig data in data/new:
// problem-type taxonomy (risk, typical false alarms), the PJPS decision matrix and the author query-letter templates.
// Everything is read from disk once; if the folder is missing the module returns empty guidance and Module 5 still works.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DIR = path.join(cfg.DATA_DIR, 'new');
let cache = null;

const readJson = rel => { try { return JSON.parse(fs.readFileSync(path.join(DIR, rel), 'utf8')); } catch { return null; } };
const readText = rel => { try { return fs.readFileSync(path.join(DIR, rel), 'utf8'); } catch { return ''; } };

// Decision matrix (editorial_guidelines/decision_framework_matrix.md, section 1)
const DECISIONS = {
  LOW: { action: 'Proceed', desk: 'Proceed to standard peer review. No author contact is needed.', post: 'No action required.' },
  MEDIUM: { action: 'Return to author', desk: 'Return to the authors for technical clarification (query letter) and hold peer review until the original raw data are verified.', post: 'Request the original data; if it was an honest mistake, publish a corrigendum.' },
  HIGH: { action: 'Hold and investigate', desk: 'Do not send to reviewers. Send a formal query letter; if the explanation is inadequate, desk reject (Editor-in-Chief sign-off required).', post: 'Expression of concern, institutional inquiry, retraction if confirmed.' }
};
const EVIDENCE = ['Keep side-by-side images with the matched areas outlined', 'Save the complete Module 5 report', 'Keep all author correspondence, original files and dates', 'High-risk desk rejections need the Editor-in-Chief\'s sign-off'];

function load() {
  if (cache) return cache;
  const tax = readJson('taxonomy/image_manipulation_taxonomy.json');
  const types = new Map();
  for (const c of tax?.categories || []) for (const p of c.problemTypes || []) types.set(p.code, { ...p, category: c.name, bik: c.bikCategory });
  const letters = [];
  const md = readText('editorial_guidelines/author_query_letter_templates.md');
  for (const part of md.split(/^## Template /m).slice(1)) {
    const m = part.match(/^(\d+):\s*(.+)\r?\n/);
    if (!m) continue;
    const body = part.slice(m[0].length).replace(/\r/g, '').replace(/^---\s*$/gm, '').trim();
    letters.push({ id: Number(m[1]), title: m[2].trim(), subject: (body.match(/\*\*Subject\*\*:\s*(.+)/) || [])[1] || '', text: body.replace(/^\*\*Subject\*\*:.*\n+/, '').replace(/\*\*|\*(?=\S)|(?<=\S)\*/g, '').trim() });
  }
  cache = { types, letters, available: types.size > 0 };
  return cache;
}

/** Taxonomy code of a finding (kind + description are written by public/js/images/*) */
function typeCode(f) {
  const t = `${f.description || ''} ${(f.details || []).join(' ')}`.toLowerCase();
  if (f.kind === 'duplicate') return f.transform && (f.transform.flip || Math.abs(f.transform.rotation || 0) > 0.05 || Math.abs((f.transform.scale || 1) - 1) > 0.05) ? 'DUP_TRANSFORMED' : 'DUP_IDENTICAL';
  if (f.kind === 'partial') return 'DUP_PARTIAL_OVERLAP';
  if (f.kind === 'clone') return 'MANIP_CLONING';
  if (f.kind === 'chart') return /curve|line|spectr|xrd/.test(t) ? 'CHART_CURVE_DUPLICATION' : 'CHART_BAR_DUPLICATION';
  if (f.kind === 'ai') return /c2pa|iptc|marker|metadata|generator|provenance/.test(t) ? 'AI_PROVENANCE_METADATA' : 'AI_FREQUENCY_ANOMALIES';
  if (f.kind === 'alteration') {
    if (/lane|splic|step|join/.test(t)) return 'MANIP_SPLICING';
    if (/noise-free|retouch|erase|erasure|smooth/.test(t)) return 'MANIP_ERASURE_RETOUCH';
    if (/histogram|contrast|saturat|comb|clip/.test(t)) return 'MANIP_CONTRAST_STRETCH';
    return 'MANIP_NOISE_INCONSISTENCY';
  }
  return null;
}

/** Query-letter template that fits a finding (ids from author_query_letter_templates.md) */
const letterFor = (f, code) => (code === 'MANIP_SPLICING' ? 2 : f.kind === 'clone' ? 3 : f.kind === 'duplicate' || f.kind === 'partial' ? 1 : 5);

/** Adds `assessment` to a finding: what it is called in the taxonomy, how reliable it is, typical false alarms, template */
function assess(f) {
  const { types } = load();
  const code = typeCode(f);
  const p = code && types.get(code);
  if (!p) return null;
  return { code, name: p.name, category: p.category, bik: p.bik, risk: p.riskLevel, falsePositiveRisk: p.falsePositiveRisk, falseAlarms: (p.falsePositiveCauses || []).slice(0, 3), letter: letterFor(f, code) };
}

/** Guidance block saved with the report: decision for the risk level + evidence rules */
function guidance(level) {
  const { available } = load();
  return { available, level, decision: DECISIONS[level] || DECISIONS.LOW, evidence: EVIDENCE, source: 'ImageTwin / Proofig documentation, PJPS decision framework' };
}

const letters = () => load().letters;

module.exports = { assess, guidance, letters, DECISIONS };
