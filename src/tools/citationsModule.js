// tools/citationsModule.js - Module 3 Citations: one run combines
//   A. in-text citations <-> reference list (missing, uncited, year/spelling mismatch, ambiguous, et al., numbering)
//   B. claim <-> source support (uploaded PDFs, open-access full text, abstracts)
//   C. citation pattern flags (self-citation, stacking on one journal/author group, citation blocks)
const { prepare } = require('../pipeline');
const { checkCitations } = require('../checks/citation');
const { analyzeCitationPattern } = require('../editor/pattern');
const { verifyCitations } = require('./verify');

async function runCitationsModule(input, files = [], update = () => {}) {
  const { body, refs } = prepare(input);
  if (!body || body.trim().length < 200) throw new Error('Upload or paste the full manuscript (text and reference list) — the text is needed to check in-text citations.');
  if (!refs.length) throw new Error('No reference list was found. The manuscript needs a "References" section.');
  const meta = input.meta || {};

  update('Matching in-text citations with the reference list', 3);
  const consistency = checkCitations(body, refs);

  let claims = null, refResults = null;
  if (input.claims !== false) {
    try {
      const v = await verifyCitations(input, files, (s, p) => update(s, 5 + (p || 0) * 0.9), { keepResults: true });
      refResults = v.fullResults;
      delete v.fullResults;
      claims = v;
    } catch (e) {
      claims = { error: e.message, claims: [], summary: {} };
    }
  }
  update('Analysing the citation pattern', 96);
  const results = refResults || refs.map(r => ({ index: r.index, raw: r.raw, parsed: r, record: null }));
  const pattern = analyzeCitationPattern(meta, results);
  if (consistency.blocks?.length) {
    pattern.flags.push({ severity: consistency.blocks.length >= 3 ? 'high' : 'medium', code: 'citation-blocks', message: `${consistency.blocks.length} citation block(s): many references cited at once with no claim for each`, guidance: 'Large groups such as [1–25] often pad the reference list. Ask the authors to cite each source where its specific finding is used.' });
  }

  const cs = consistency.summary || {};
  const ks = claims?.summary || {};
  if (claims?.error) claims.references = { summary: { total: refs.length }, results: refs.map(r => ({ index: r.index, raw: r.raw })) };
  return {
    kind: 'citations',
    module: 3,
    meta,
    createdAt: new Date().toISOString(),
    datasets: await require('../datasets').datasetHealth(),
    consistency,
    claims,
    pattern,
    references: claims?.references ? claims.references : { summary: { total: refs.length }, results: refs.map(r => ({ index: r.index, raw: r.raw })) },
    summary: {
      references: refs.length,
      citations: cs.citations || 0,
      missing: cs.missing || 0,
      uncited: cs.uncited || 0,
      yearMismatch: cs.yearMismatch || 0,
      spelling: cs.spelling || 0,
      ambiguous: cs.ambiguous || 0,
      etAl: cs.etAlIssues || 0,
      blocks: cs.blocks || 0,
      claims: ks.claims || 0,
      unsupported: ks.unsupported || 0,
      partial: ks.partial || 0,
      full: ks.full || 0,
      couldNotVerify: ks.couldNotVerify || 0,
      retractedEvidence: claims ? claims.claims.reduce((a, c) => a + c.citations.filter(x => x.refStatus === 'retracted').length, 0) : 0,
      flaggedEvidence: claims ? claims.claims.reduce((a, c) => a + c.citations.filter(x => x.refFlagged).length, 0) : 0,
      patternFlags: pattern.flags.length,
      selfCitationRate: pattern.summary.selfCitationRate
    }
  };
}

/** Short problem list for My Activity */
function citationProblems(r) {
  const s = r.summary;
  return [
    s.missing && `${s.missing} citation(s) missing from the list`, s.uncited && `${s.uncited} reference(s) never cited`,
    s.yearMismatch && `${s.yearMismatch} year mismatch(es)`, s.spelling && `${s.spelling} author name spelled differently`, s.spelling && `${s.spelling} author name spelled differently`, s.spelling && `${s.spelling} author name spelled differently`, s.etAl && `${s.etAl} “et al.” problem(s)`,
    s.unsupported && `${s.unsupported} unsupported claim(s)`, s.retractedEvidence && `${s.retractedEvidence} claim(s) resting on retracted work`, s.flaggedEvidence && `${s.flaggedEvidence} claim(s) resting on work flagged in an integrity audit`,
    s.patternFlags && `${s.patternFlags} citation-pattern flag(s)`
  ].filter(Boolean);
}

module.exports = { runCitationsModule, citationProblems };
