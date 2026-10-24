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

const VERDICTS = { full: 'Full match', partial: 'Partial match', unsupported: 'Unsupported', 'could-not-verify': 'Could not verify' };
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
  const out = limited.map(cl => ({
    sentence: cl.sentence,
    claim: cl.claim,
    citations: cl.refs.map(i => {
      const r = results[i];
      const src = sources.get(i);
      const best = src?.passages?.length ? M.bestPassages(cl.claim, src.passages, 1)[0] : null;
      const v = M.verdictOf(best, { fullText: !!src?.fullText });
      if (r.status === 'suspicious') v.notes.unshift('The reference itself could not be found — it may be fabricated');
      if (r.status === 'retracted') v.notes.unshift('The cited work has been retracted');
      return {
        refIndex: r.index, refRaw: r.raw, refStatus: r.status, refStatusLabel: r.statusLabel,
        verdict: v.verdict, verdictLabel: VERDICTS[v.verdict], notes: v.notes,
        score: best ? Math.round(best.score * 100) : null,
        evidence: best ? { quote: best.text, origin: src.origin, page: best.page || null, url: src.url || null, level: src.uploaded ? 'uploaded file' : src.fullText ? 'full text' : 'abstract' } : null
      };
    })
  }));

  const all = out.flatMap(c => c.citations);
  const count = v => all.filter(c => c.verdict === v).length;
  return {
    kind: 'verify',
    ...(keepResults ? { fullResults: results } : {}),
    meta: input.meta || {},
    system,
    claims: out,
    truncated: claims.length > limited.length,
    summary: { claims: out.length, citations: all.length, full: count('full'), partial: count('partial'), unsupported: count('unsupported'), couldNotVerify: count('could-not-verify') },
    references: { summary: refCheck.summary, results: results.map(r => ({ index: r.index, raw: r.raw, status: r.status, statusLabel: r.statusLabel, tone: r.tone, reason: r.reason, retraction: r.retraction, record: r.record ? { title: r.record.title, doi: r.record.doi, year: r.record.year, journal: r.record.journal } : null })) },
    files: { linked: [...linked.entries()].map(([refIndex, f]) => ({ name: f.name, refIndex })), unlinked, errors: uploads.filter(u => u.error).map(u => ({ name: u.name, error: u.error })) },
    method: 'Automated comparison on this server: claim terms (weighted by rarity), figures and direction of effect are matched against the source passage. Verdicts are decision support — read the quoted evidence.'
  };
}

module.exports = { verifyCitations, extractClaims, VERDICTS };
