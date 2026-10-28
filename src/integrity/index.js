// integrity/index.js - Integrity Screening: runs every Integrity Suite analyser on one manuscript, adds the Module 4
// paper-mill signals and the linked Module 1 / Module 5 reports for the same manuscript ID, and scores the result.
const db = require('../db');
const { prepare } = require('../pipeline');
const { checkReferences } = require('../checks/reference');
const { analyzeCitationPattern } = require('../editor/pattern');
const { detectPaperMill } = require('../papermill');
const { isOnline } = require('../http');
const { analyzeSimilarity } = require('./similarity');
const { analyzeAiWriting } = require('./aiWriting');
const { analyzeDataIntegrity } = require('./dataIntegrity');
const { analyzePharma } = require('./pharmaValidation');
const { analyzeEthics } = require('./ethics');
const { analyzeAuthors } = require('./authors');
const { analyzeNetwork, storeRecord } = require('./network');
const { scoreIntegrity, linkedDimensions } = require('./scoring');

const DISCLAIMER = 'Screening aid only. Every signal points to something an editor should look at; none is proof of misconduct, and the score never rejects a paper by itself. Confidential — not for authors or reviewers.';

/** Latest saved Module 1 / 4 / 5 results for this manuscript ID (any editor: integrity work is shared within the journal) */
async function linkedReports(code, { imagesCheckId } = {}) {
  const out = {};
  const latest = kinds => db.one(`SELECT id, kind, result FROM checks WHERE manuscript_code = $1 AND kind = ANY($2::text[]) AND result IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [code, kinds]);
  if (imagesCheckId) {
    const r = await db.one("SELECT id, kind, result FROM checks WHERE id = $1 AND kind = 'images'", [imagesCheckId]);
    if (r) out.images = { checkId: r.id, summary: r.result.summary, earlier: r.result.earlier || [] };
  }
  if (!code) return out;
  if (!out.images) { const r = await latest(['images']); if (r) out.images = { checkId: r.id, summary: r.result.summary, earlier: r.result.earlier || [] }; }
  const pm = await latest(['papermill']);
  if (pm) out.papermill = { ...pm.result, id: pm.id };
  const ref = await latest(['manuscript', 'references']);
  if (ref?.result?.references?.summary) out.references = { checkId: ref.id, kind: ref.kind, summary: ref.result.references.summary };
  if (!out.papermill && ref?.result?.papermill) out.papermill = { ...ref.result.papermill, id: ref.id };
  return out;
}

/**
 * input: { text, bodyText, referencesText, meta, suggestedReviewers, imagesCheckId, deep (verify references online) }
 * Returns the result object (kind 'integrity'); _hashes and _record are removed by the caller after saving.
 */
async function runIntegrity(input, update = () => {}) {
  const text = input.text || '';
  const body = input.bodyText || text;
  const meta = input.meta || {};
  const online = isOnline() && input.online !== false;
  const abstract = meta.abstract || '';
  const dims = [];

  update('Text similarity and cross-paper overlap', 4);
  const sim = await analyzeSimilarity(body, { meta, abstract, online });
  dims.push(sim);
  update('AI-written content screening', 14);
  dims.push(analyzeAiWriting(body));
  update('Research data integrity (statistics, GRIM, duplicated values)', 20);
  dims.push(analyzeDataIntegrity(body));
  update('Pharmaceutical validation (doses, identifiers, methods)', 28);
  dims.push(await analyzePharma(body, { online }));
  update('Research ethics (approvals, registration, consent, declarations)', 36);
  dims.push(await analyzeEthics(text, { title: meta.title, online }));
  update('Authors and affiliations (ORCID, CRediT, ROR)', 44);
  dims.push(await analyzeAuthors(text, meta, { online }));
  update('Submission network (coordinated submissions, reviewer and citation rings)', 52);
  const net = await analyzeNetwork({ text, meta, referencesText: input.referencesText, suggestedReviewers: input.suggestedReviewers });
  dims.push(net);

  // Module 4: a fresh run (references verified when "deep"), unless a saved Module 4 report for this manuscript exists
  const linked = await linkedReports(meta.manuscriptCode, { imagesCheckId: input.imagesCheckId }).catch(() => ({}));
  let papermill = linked.papermill || null;
  let refSummary = null;
  if (!papermill || input.deep) {
    let references = [], pattern = null;
    if (input.deep && input.referencesText && online) {
      const { refs } = prepare({ referencesText: input.referencesText, bodyText: body });
      if (refs.length) {
        update(`Verifying ${refs.length} references`, 56);
        const rc = await checkReferences(refs, { checkLinks: false, onProgress: (k, n) => update(`Verifying references (${k}/${n})`, 56 + k / n * 30) });
        references = rc.results;
        refSummary = rc.summary;
        pattern = analyzeCitationPattern(meta, references);
      }
    }
    update('Paper-mill signals (Module 4)', 88);
    papermill = await detectPaperMill({ text, body, meta, references, pattern, suggestedReviewers: input.suggestedReviewers, blast: false });
    delete papermill._shingles;
    papermill.id = null;
  }
  if (refSummary) linked.references = { checkId: null, kind: 'integrity', summary: refSummary };
  const linkedDims = linkedDimensions({ papermill, images: linked.images, references: linked.references });

  update('Scoring', 96);
  const all = [...dims, ...linkedDims];
  const risk = scoreIntegrity(all);
  const result = {
    kind: 'integrity',
    meta: { ...meta, authors: (meta.authors || []).map(a => ({ name: a.name || `${a.given} ${a.family}`.trim(), given: a.given, family: a.family })) },
    createdAt: new Date().toISOString(),
    risk,
    dimensions: all.map(({ _hashes, _record, ...d }) => d),
    linked: {
      papermill: papermill ? { checkId: papermill.id || null, level: papermill.risk?.level, score: papermill.risk?.score } : null,
      images: linked.images ? { checkId: linked.images.checkId, level: linked.images.summary?.level } : null,
      references: linked.references ? { checkId: linked.references.checkId, summary: linked.references.summary } : null
    },
    options: { deep: !!input.deep, online },
    disclaimer: DISCLAIMER,
    _hashes: sim._hashes,
    _record: net._record
  };
  return result;
}

function integrityProblems(r) {
  return [`Integrity risk ${r.risk.level} (${r.risk.score}/100)`, ...r.risk.contributions.filter(c => c.severity !== 'low').slice(0, 5).map(c => c.title)];
}

/** Save the result, store the submission record for later cross-submission checks */
async function saveIntegrity(userId, result, input) {
  const { saveResult } = require('../pipeline');
  const hashes = result._hashes, record = result._record;
  delete result._hashes; delete result._record;
  await saveResult(userId, 'integrity', result, { title: input.meta.title || 'Integrity screening', manuscriptCode: input.meta.manuscriptCode, problems: integrityProblems(result), counts: { suspicious: result.risk.strongSignals } });
  await storeRecord({ checkId: result.id, userId, meta: input.meta, record, hashes }).catch(e => console.error('Integrity record not stored:', e.message));
  return result;
}

module.exports = { runIntegrity, saveIntegrity, integrityProblems, linkedReports, DISCLAIMER };
