// tools/verify.js - Verify Citations: is each cited sentence supported by the source it cites?
// The bibliography is verified first; the text is split into citing sentences (claims); each claim is compared with
// the cited source's text — an uploaded file, the open-access full text or the abstract — and marked
// Full match / Partial match / Unsupported / Could not verify, with the best evidence passage quoted.
const { prepare } = require('../pipeline');
const { checkReferences } = require('../checks/reference');
const { detectSystem } = require('../checks/citation');
const { findCitations } = require('./restyle');
const M = require('./match');
const FT = require('./fulltext');
const { surnameKey, stripDiacritics } = require('../text');

const VERDICTS = { full: 'Full match', partial: 'Partial match', unsupported: 'Unsupported', 'not-confirmed': 'Not confirmed from the abstract', 'could-not-verify': 'Could not verify' };
const famKey = s => surnameKey(stripDiacritics(s || ''));

function refNumber(raw, fallback) {
  const m = String(raw).match(/^\s*(?:\[(\d+)\]|(\d+)[.)])/);
  return m ? parseInt(m[1] || m[2], 10) : fallback;
}

function matchAuthorYear(part, refs) {
  const fam = famKey(part.author.replace(/\s+et\s+al\.?/i, '').split(/\s*(?:,|&|\band\b)\s*/)[0]);
  const ym = part.year.match(/^(\d{4})([a-z]?)$/);
  if (!ym) return -1;
  const c = refs.map((r, i) => ({ r, i })).filter(({ r }) => famKey(r.authors?.[0]?.family) === fam && Number(r.year) === Number(ym[1]));
  if (!c.length) return -1;
  return (ym[2] && c.find(x => (x.r.yearSuffix || '') === ym[2]) || c[0]).i;
}

/** Citing sentences with the references each one cites */
function extractClaims(body, refs) {
  const system = detectSystem(body, refs);
  const cites = findCitations(body, system, refs.length);
  const byNum = new Map(refs.map((r, i) => [refNumber(r.raw, i + 1), i]));
  const spans = M.sentenceSpans(body);
  const claims = [];
  for (const c of cites) {
    const targets = c.kind === 'numeric' ? c.nums.map(n => byNum.get(n)).filter(i => i !== undefined) : c.parts.map(p => matchAuthorYear(p, refs)).filter(i => i >= 0);
    if (!targets.length) continue;
    const span = spans.find(s => c.start >= s.start && c.start < s.end + 1) || spans.find(s => s.end >= c.start);
    if (!span) continue;
    let claim = claims.find(x => x.span === span);
    if (!claim) { claim = { span, cites: [], targets: new Set() }; claims.push(claim); }
    claim.cites.push(c);
    for (const t of targets) claim.targets.add(t);
  }
  return {
    system,
    claims: claims.map(cl => {
      // Remove citation markers from the claim text before comparing
      let text = cl.span.text;
      for (const c of cl.cites) text = text.replace(body.slice(c.start, c.end), c.kind === 'narrative' ? body.slice(c.start, c.end).replace(/\s*\([^)]*\)/, '') : ' ');
      return { sentence: cl.span.text, claim: text.replace(/\s+([,.;])/g, '$1').replace(/\s{2,}/g, ' ').trim(), refs: [...cl.targets] };
    })
  };
}

/**
 * input: { text | bodyText + referencesText, meta, mapping: { fileName: refIndex } }
 * files: [{ name, buffer }] full texts of (closed-access) sources
 */
async function verifyCitations(input, files = [], update = () => {}, { keepResults = false } = {}) {
  const { body, refs } = prepare(input);
  if (!body || body.trim().length < 200) throw new Error('Upload or paste the full manuscript (text and reference list) — the text is needed to find the cited claims.');
  if (!refs.length) throw new Error('No reference list was found. The manuscript needs a "References" section.');

  update('Verifying the bibliography', 3);
  const refCheck = await checkReferences(refs, { checkLinks: false, onProgress: (d, n) => update(`Verifying the bibliography (${d}/${n})`, 3 + d / n * 37) });
  const results = refCheck.results;

  update('Splitting the text into cited claims', 42);
  const { system, claims } = extractClaims(body, refs);
  if (!claims.length) throw new Error('No in-text citations could be matched to the reference list.');
  const limited = claims.slice(0, 400);

  update('Reading uploaded source files', 45);
  const uploads = [];
  for (const f of files) {
    try { uploads.push({ name: f.name, pages: await FT.filePages(f.buffer, f.name) }); } catch (e) { uploads.push({ name: f.name, pages: [], error: e.message }); }
  }
  const { map: linked, unlinked } = FT.linkUploads(uploads.filter(u => u.pages.length), results.map(r => ({ index: r.index, record: r.record, parsed: r.parsed })), input.mapping || {});

  // Source text for every cited reference
  const cited = [...new Set(limited.flatMap(c => c.refs))];
  const sources = new Map();
  let k = 0, done = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (k < cited.length) {
      const i = cited[k++];
      const r = results[i];
      const record = r.record ? { ...r.record, abstract: r.openalex?.abstract } : r.parsed?.doi ? r.parsed : null;
      const src = await FT.sourceTextFor(record, linked.get(r.index)).catch(() => null);
      if (src) src.passages = src.pages.flatMap(p => M.passagesOf(p.text, { page: p.page }));
      sources.set(i, src);
      done++;
      update(`Retrieving source texts (${done}/${cited.length})`, 45 + done / cited.length * 45);
    }
  }));

  update('Comparing claims with their sources', 92);
  // the language model reads the passages for meaning for up to 3 minutes; later claims get the word matcher alone
  const deadline = Date.now() + 180e3;
  const out = [];
  for (const cl of limited) out.push({
    sentence: cl.sentence,
    claim: cl.claim,
    citations: await Promise.all(cl.refs.map(async i => {
      const r = results[i];
      const src = sources.get(i);
      const v = await M.judge(cl.claim, src?.passages, { fullText: !!src?.fullText, deadline });
      const best = v.best;
      // read from the abstract only: what the abstract does not contain is not settled, so an "unsupported" that is not
      // a contradiction is reported as not confirmed (full text needed) and a partial match is marked preliminary
      const fromAbstract = !!best && !src.fullText && !src.uploaded;
      if (fromAbstract && v.verdict === 'unsupported' && !v.conflict) v.verdict = 'not-confirmed';
      if (r.status === 'suspicious') v.notes.unshift('The reference itself could not be found — it may be fabricated');
      if (r.status === 'retracted') v.notes.unshift('The cited work has been retracted');
      else if (r.flagged) v.notes.unshift(`The cited work was flagged for integrity problems in a published audit (${r.flagged.issue})`);
      return {
        refIndex: r.index, refRaw: r.raw, refStatus: r.status, refStatusLabel: r.statusLabel, refFlagged: !!r.flagged,
        verdict: v.verdict, verdictLabel: fromAbstract && v.verdict === 'partial' ? 'Partial match (abstract only)' : fromAbstract && v.verdict === 'unsupported' ? 'Contradicted by the abstract' : VERDICTS[v.verdict],
        preliminary: fromAbstract && v.verdict !== 'full', contradicts: !!v.conflict, notes: v.notes,
        score: best ? Math.round(best.score * 100) : null,
        evidence: best ? { quote: best.text, origin: src.origin, page: best.page || null, url: src.url || null, level: src.uploaded ? 'uploaded file' : src.fullText ? 'full text' : 'abstract' } : null
      };
    }))
  });

  const all = out.flatMap(c => c.citations);
  const count = v => all.filter(c => c.verdict === v).length;
  // what each cited source was read from: most paywalled sources give only their abstract, and a claim "unsupported by
  // the abstract" may be in the full text - the references whose PDF would settle a verdict are listed for the editor
  const levelOf = i => { const s = sources.get(i); return !s ? 'none' : s.uploaded ? 'uploaded' : s.fullText ? 'fullText' : 'abstract'; };
  const citedLevels = cited.map(i => ({ index: results[i].index, level: levelOf(i) }));
  const unsettled = new Set(all.filter(c => c.verdict !== 'full' && (!c.evidence || c.evidence.level === 'abstract')).map(c => c.refIndex));
  const sourceText = {
    uploaded: citedLevels.filter(c => c.level === 'uploaded').length,
    fullText: citedLevels.filter(c => c.level === 'fullText').length,
    abstractOnly: citedLevels.filter(c => c.level === 'abstract').length,
    none: citedLevels.filter(c => c.level === 'none').length,
    toUpload: citedLevels.filter(c => unsettled.has(c.index)).map(c => c.index).sort((a, b) => a - b)
  };
  return {
    kind: 'verify',
    ...(keepResults ? { fullResults: results } : {}),
    meta: input.meta || {},
    system,
    claims: out,
    truncated: claims.length > limited.length,
    sourceText,
    summary: { claims: out.length, citations: all.length, full: count('full'), partial: count('partial'), unsupported: count('unsupported'), notConfirmed: count('not-confirmed'), couldNotVerify: count('could-not-verify'), preliminary: all.filter(c => c.preliminary).length },
    references: { summary: refCheck.summary, results: results.map(r => ({ index: r.index, raw: r.raw, status: r.status, statusLabel: r.statusLabel, tone: r.tone, reason: r.reason, retraction: r.retraction, record: r.record ? { title: r.record.title, doi: r.record.doi, year: r.record.year, journal: r.record.journal } : null })) },
    files: { linked: [...linked.entries()].map(([refIndex, f]) => ({ name: f.name, refIndex })), unlinked, errors: uploads.filter(u => u.error).map(u => ({ name: u.name, error: u.error })) },
    method: 'Automated comparison on this server: claim terms (weighted by rarity), figures, negation and the direction of the effect stated about the shared terms are matched against the source passages, and a small language model running on this server reads the best passages (and an abstract also as a whole) for meaning (does the source state the claim, state the opposite, or neither). Source text, in this order: an uploaded file, open-access full text (Europe PMC, PubMed Central, Unpaywall, OpenAlex, CORE, Semantic Scholar, bioRxiv / medRxiv, arXiv), then the abstract. Measured on SciFact expert-labelled claims (abstracts only, held-out split): 74% of supported claims are found and 41% of contradicted claims flagged as contradicted; 1.5% of claims without evidence and 1% of contradicted claims pass as Full support, so verdicts are decision support — read the quoted evidence.'
  };
}

module.exports = { verifyCitations, extractClaims, VERDICTS };
