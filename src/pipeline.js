// pipeline.js - checks on one upload. 'references' = Module 1 (Check Bibliography); 'citations' = list matching only;
// 'manuscript' = the Full Screening Report: Module 1 + Module 2 compliance + Module 3 (list matching, pattern) +
// Module 4 paper-mill signals (+ Module 5 image findings when an image report is attached), with a front-page summary.
const db = require('./db');
const cfg = require('./config');
const P = require('./parse');
const { checkReferences } = require('./checks/reference');
const { checkCitations } = require('./checks/citation');
const { checkCitedJournals } = require('./checks/journal');
const { analyzeCitationPattern } = require('./editor/pattern');
const { problemsOf } = require('./editor/reports');
const { splitName } = require('./text');

/**
 * Split a whole manuscript (or a bare list) into body + parsed references. kind 'manuscript': a document with no
 * reference list that can be found is reviewed as text only (noList), instead of reading its paragraphs as references.
 */
function prepare({ text, referencesText, bodyText, entries, kind }) {
  let body = bodyText || '';
  let refsText = referencesText || '';
  if (!refsText && text) {
    const sec = P.findReferenceSection(text);
    if (sec.found) { body = body || sec.body; refsText = sec.references; }
    else if (kind === 'manuscript' && text.split(/\s+/).length >= 300) {
      const parts = P.splitReferences(text).entries;
      if (parts.filter(P.looksLikeReference).length < parts.length * 0.5) return { body: body || text, refs: [], truncated: false, totalFound: 0, noList: true };
      refsText = text;
    } else refsText = text;
  }
  let refs;
  if (Array.isArray(entries) && entries.length) {
    // Structured entries (BibTeX / RIS): parsed fields override the heuristic parse where present
    refs = entries.map((e, i) => {
      const base = P.parseReferenceEntry(typeof e === 'string' ? e : e.raw, i + 1);
      if (typeof e === 'string') return base;
      const given = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
      return { ...base, ...given, index: i + 1 };
    });
  } else {
    const { entries: split, strategy } = P.splitReferences(refsText);
    refs = split.map((e, i) => P.parseReferenceEntry(e, i + 1));
    refs.strategy = strategy;
  }
  return { body, refs: refs.slice(0, cfg.MAX_REFERENCES), truncated: refs.length > cfg.MAX_REFERENCES, totalFound: refs.length };
}

function normalizeMeta(meta = {}) {
  const authors = (Array.isArray(meta.authors) ? meta.authors : String(meta.authors || '').split(/\s*[;\n]\s*|\s*,\s*(?=[A-Z])/))
    .map(a => (typeof a === 'string' ? { name: a.trim(), ...splitName(a.trim()) } : { ...a, ...(a.family ? {} : splitName(a.name || '')) }))
    .filter(a => a.family);
  return {
    title: (meta.title || '').trim(),
    abstract: (meta.abstract || '').trim(),
    keywords: Array.isArray(meta.keywords) ? meta.keywords : String(meta.keywords || '').split(/[;,]/).map(s => s.trim()).filter(Boolean),
    authors,
    affiliations: Array.isArray(meta.affiliations) ? meta.affiliations : String(meta.affiliations || '').split('\n').map(s => s.trim()).filter(Boolean),
    manuscriptCode: (meta.manuscriptCode || '').trim(),
    version: meta.version ? parseInt(meta.version, 10) : null,
    ...(meta.fileName ? { fileName: String(meta.fileName).slice(0, 200) } : {})
  };
}

/**
 * kind: 'manuscript' (everything) | 'references' (Reference + Journal check) | 'citations' (Citation Check only)
 * ctx (from the job runner): { stage(key, fn) - a stage finished by an earlier, stopped run is reused; deadline - when
 * this run must save what it has }
 */
async function runCheck(input, update, ctx = {}) {
  const stage = ctx.stage || ((key, fn) => fn());
  const deadline = ctx.deadline || Infinity;
  const jobId = ctx.jobId || null;
  const kind = input.kind || 'manuscript';
  const opts = { citations: kind !== 'references', journals: kind !== 'citations', pattern: kind === 'manuscript', ...(input.options || {}) };
  const meta = normalizeMeta(input.meta);
  update('Reading the reference list', 2);
  const { body, refs, truncated, totalFound, noList } = prepare({ ...input, kind });
  // a Full Screening without a reference list still reviews the text (similarity, paper mill, images, authors)
  const textOnly = !refs.length && kind === 'manuscript' && String(body || '').split(/\s+/).length >= 300;
  if (!refs.length && !textOnly) throw new Error('No references were found. Paste the reference list, or upload the full manuscript (Word or PDF) - the list is found with or without a "References" heading.');

  // just after a server start the retraction and predatory-journal lists are still being restored: wait for them briefly
  await require('./datasets').coreDatasetsReady();
  const result = { kind, meta, createdAt: new Date().toISOString(), truncated, totalFound, datasets: await require('./datasets').datasetHealth() };
  // a re-run and every earlier run of the same report: compared with each other, they are not duplicate submissions
  const recheckChain = recheckIds(input);
  if (recheckChain.length) result.recheckChain = recheckChain;
  if (textOnly) result.noReferenceList = noList ? 'No reference list was found in the document, so the bibliography, PJPS style and citation checks were not run. The other modules reviewed the text.' : 'The reference list is empty.';

  // Full Screening: the similarity report, novelty and author identity need only the text, so they run while Module 1
  // checks the references (they used to wait for it, then for each other); the progress line shows both
  let side = null, say = update;
  if (kind === 'manuscript') {
    const steps = { main: '', text: '' };
    const show = () => update([steps.main, steps.text].filter(Boolean).join(' · '));
    say = (s, p) => { if (s) steps.main = s; update(null, p); show(); };
    const textStep = s => { if (s) { steps.text = s; show(); } };
    // their hundreds of requests go in the background lane, so the reference lookups the report waits for go first
    side = require('./http').inBackground(() => textModules({ input, body, refs, meta, update: textStep, stage, deadline, attempt: ctx.attempt || 0 }));
    require('./papermill').warm().catch(() => null);   // Module 4's lists, loaded while Module 1 runs
    side.catch(() => null);
  }

  if (kind === 'citations') {
    update('Matching in-text citations with the reference list', 30);
    result.citations = checkCitations(body, refs);
    result.references = { results: refs.map(r => ({ index: r.index, raw: r.raw, parsed: r, status: 'unchecked', statusLabel: 'Not checked', issues: [], notices: [], links: [], matchedIn: [], checked: {} })), summary: { total: refs.length } };
    return result;
  }

  const refWeight = opts.journals ? 65 : 90;
  const dbCount = require('./sources').databases().length;
  say(`Checking ${refs.length} references against all ${dbCount} databases and Retraction Watch`, 5);
  result.references = await stage('references', () => checkReferences(refs, {
    onProgress: (d, n) => say(`Checking references (${d}/${n}) against all ${dbCount} databases and Retraction Watch`, 5 + d / n * refWeight)
  }));

  if (opts.citations && result.noReferenceList) {
    result.citations = { error: result.noReferenceList };
  } else if (opts.citations && body && body.trim().length > 200) {
    say('Matching in-text citations with the reference list', 72);
    result.citations = checkCitations(body, refs);
  } else if (opts.citations) {
    result.citations = { error: 'Upload the full manuscript to check in-text citations (only a reference list was provided).' };
  }

  if (opts.journals) {
    say('Checking cited journals (indexing, quartile, predatory lists)', 75);
    result.journals = await stage('journals', () => checkCitedJournals(result.references.results, {
      onProgress: (d, n) => say(`Checking cited journals (${d}/${n})`, 75 + d / n * 20)
    }));
  }

  if (opts.pattern) {
    say('Analysing the citation pattern', 96);
    result.pattern = analyzeCitationPattern(meta, result.references.results, { body });
  }
  say('Bibliography quality indicators', 96);
  const { bibliographyIndicators } = require('./checks/indicators');
  result.indicators = await bibliographyIndicators(meta, result.references.results, result.journals);
  // RefGuard-style reference quality: paratexts, Quality / Impact / Recency / Diversity, comparison with earlier submissions
  result.indicators.referenceQuality = await require('./checks/refQuality').referenceQuality(result.references.results, result.journals, result.indicators, { manuscriptCode: meta.manuscriptCode || null, save: opts.save !== false }).catch(() => null);
  const rq = result.indicators.referenceQuality;
  if (rq?.paratexts?.length) result.indicators.flags.push({ severity: 'low', code: 'paratext', message: `${rq.paratexts.length} reference(s) point to an erratum, editorial, letter, notice or abstract rather than a research paper` });
  if (result.citations?.error && kind === 'manuscript') delete result.citations.summary;

  if (kind === 'manuscript') await screening(result, { input, body, refs, meta, update: say, side, stage, jobId });
  return result;
}

/** Full Screening Report: add Module 2 compliance and Module 4 (+5) to a manuscript check, then the front page */
async function screening(result, { input, body, refs, meta, update, side, stage, jobId }) {
  const { checkCompliance, nlmForRefs } = require('./checks/compliance');
  update('Module 2: PJPS style compliance', 97);
  const recById = new Map(result.references.results.map(r => [r.index, r.record && r.status !== 'suspicious' ? r.record : null]));
  const records = refs.map(r => recById.get(r.index) || null);
  result.compliance = refs.length ? checkCompliance(refs, { records, body, nlm: await stage('nlm', () => nlmForRefs(refs, records)) }) : null;

  // Module 5 runs in the browser while the server screens the text (imagesPending): its report is attached to this job
  // when saved, and is needed from here on (the paper-mill image signal)
  if (input.imagesPending && !input.imagesCheckId && !input.imagesNote && jobId) Object.assign(input, await imagesFromBrowser(jobId, update));
  update('Module 4: paper-mill signals', 98);
  const { detectPaperMill } = require('./papermill');
  let images = null;
  let imageReport = null;
  if (input.imagesCheckId && input.userId) {
    // a re-run started by a Super Admin keeps the figures report of the user who owns the original
    const c = await loadCheck(input.recheckOwner || input.userId, input.imagesCheckId);
    if (c?.result?.summary) { imageReport = c.result; images = { findings: c.result.summary.byLevel || {}, categories: c.result.summary.byCategory || {}, level: c.result.summary.level, checkId: c.row.id, summary: c.result.summary }; }
  }
  const text = input.text || [input.bodyText || '', input.referencesText || ''].join('\n');
  const pm = await stage('papermill', () => detectPaperMill({ text, body, meta, references: result.references.results, pattern: result.pattern, suggestedReviewers: input.suggestedReviewers || '', coverLetter: String(input.coverLetter || '').slice(0, 20000), images, excludeCheckIds: result.recheckChain || [] }));
  result._shingles = pm._shingles;
  delete pm._shingles;
  result.papermill = pm;
  if (images) result.images = imagesBlock(imageReport, images.checkId);
  if (images && input.imagesEmbedded) result._imagesEmbedded = true;
  else if (input.imagesNote) result.imagesNote = String(input.imagesNote).slice(0, 300);

  // the similarity report, novelty and author identity (started with Module 1)
  update('Finishing the similarity report, novelty and author identity', 98);
  Object.assign(result, await side);
  // an earlier PJPS submission with the same text (Module 4 fingerprints) belongs in the overlap report too
  const dup = (pm.signals || []).find(x => x.code === 'duplicate');
  if (dup && result.plagiarism && !result.plagiarism.error) result.plagiarism.earlierSubmissions = (dup.evidence || []).map(e => e.text);
  // Turnitin shows an AI-writing indicator next to the similarity: Module 4's (same text, computed once, local only)
  const aw = pm.details?.aiWriting;
  if (aw && result.plagiarism && !result.plagiarism.error) result.plagiarism.aiWriting = { score: aw.score, parts: aw.parts || [], leftovers: (pm.details.aiLeftovers || []).length };

  markPublishedOnPjps(result);
  result.screening = screeningSummary(result);
}

/**
 * The manuscript is already published by PJPS (pjps.pk, Article in Press or an issue): found by the similarity report
 * (its published full text) or by Module 5 (its own figures in the published PJPS papers). The report says so first; the
 * figures matching that published version and the same-title hit are evidence of it, not of duplication or a paper mill.
 */
function markPublishedOnPjps(result) {
  const { titleSimilarity } = require('./text');
  const title = result.meta?.title || '';
  const num = (String(result.meta?.manuscriptCode || '').match(/\d{4,6}/) || [])[0];
  const clean = t => String(t || '').replace(/\s+/g, ' ').trim();
  const same = x => (title && titleSimilarity(title, clean(x.title)) >= 0.85) || (num && new RegExp(`\\.${num}\\.`).test(x.doi || ''));
  const pjps = x => /pjps\.pk/i.test(x.url || '') || /^10\.36721\/PJPS/i.test(String(x.doi || '')) || /PJPS/.test(x.source || '');
  const text = (result.plagiarism?.publishedOnPjps || [])[0] || null;
  const figs = (result.images?.references || []).filter(m => pjps(m) && same(m));
  if (!text && !figs.length) return;
  const any = text || figs[0];
  const doi = any.doi || figs.find(m => m.doi)?.doi || null;
  const pv = { title: clean(any.title), doi, url: text?.url || (doi ? `https://doi.org/${doi}` : null), percent: text?.percent ?? null,
    figures: figs.map(m => ({ panel: m.panel, figure: m.figure, level: m.level, description: m.description })) };
  result.publishedOnPjps = pv;
  const evidence = [
    { text: `Published version: “${pv.title}”, Pakistan Journal of Pharmaceutical Sciences${doi ? `, DOI ${doi}` : ''} (pjps.pk, Article in Press)`, link: pv.url },
    ...(pv.percent != null ? [{ text: `Similarity report: ${pv.percent}% of the manuscript's words are in this published version (full text compared word for word)` }] : []),
    ...(figs.length ? [{ text: `Module 5: ${figs.length} figure panel(s) of the manuscript are the same figures as in the published version (${[...new Set(figs.map(m => m.figure).filter(Boolean))].slice(0, 8).join(', ')})` }] : [])
  ];
  const pm = result.papermill;
  if (pm?.signals) {
    // the same-title hit and the figure matches are this published version: replaced by one signal that names it
    const own = e => (doi && String(e.link || '').toLowerCase().includes(doi.toLowerCase())) || (title && titleSimilarity(title, clean(String(e.text || '').replace(/^“|”.*$/g, ''))) >= 0.85);
    pm.signals = pm.signals.map(sg => {
      if (sg.code === 'published') { const ev = (sg.evidence || []).filter(e => !own(e)); return ev.length ? { ...sg, evidence: ev, title: `A paper with the same title is published elsewhere (${ev.length})` } : null; }
      // earlier screenings of this same manuscript (saved without its ID): named in the published signal, not as duplicates
      if (sg.code === 'duplicate') {
        const mineEv = (sg.evidence || []).filter(e => title && titleSimilarity(title, clean((String(e.text || '').match(/“([^”]*)”/) || [])[1])) >= 0.9);
        if (mineEv.length) evidence.push({ text: `${mineEv.length} earlier screening(s) of this same manuscript in the portal (${mineEv.map(e => `#${e.checkId}`).join(', ')}) - the same article checked before, not a duplicate submission` });
        const ev = (sg.evidence || []).filter(e => !mineEv.includes(e));
        return ev.length ? { ...sg, evidence: ev, title: `Matches an earlier PJPS submission (${ev.length})` } : null;
      }
      if (sg.code === 'images') {
        const im = result.images;
        const otherHigh = (im?.findings || []).filter(f => f.level === 'high').length + (im?.references || []).filter(m => m.level === 'high' && !(pjps(m) && same(m))).length;
        return otherHigh ? sg : null;
      }
      return sg;
    }).filter(Boolean);
    pm.signals.unshift({ group: 'data', code: 'published-pjps', severity: 'high', weight: 0, title: 'Already published on the PJPS website (Article in Press)', evidence,
      note: 'The manuscript is the article PJPS has already published. Its high similarity and its figures matching a published PJPS paper are explained by this published version and are not evidence of plagiarism, figure re-use or a paper mill. The other signals below are assessed as for any manuscript.' });
    pm.risk = require('./papermill').riskLevel(pm.signals.filter(sg => sg.code !== 'published-pjps'));
    // the written assessment and the query letter, again on the paper-mill signals proper, after the published version
    const A = require('./papermill/assessment');
    const rest = { ...pm, signals: pm.signals.filter(sg => sg.code !== 'published-pjps') };
    pm.assessment = A.assess(rest);
    pm.assessment.letter = A.queryLetter(rest, pm.assessment);
    pm.assessment.statement = `This manuscript is already published on the PJPS website (Article in Press${doi ? `, DOI ${doi}` : ''}); its similarity and its figures matching that published article are explained by it and are not counted as paper-mill evidence. ${pm.assessment.statement || ''}`.trim();
  }
}

/**
 * The Full Screening modules that need only the text, run side by side: the similarity report (text overlap with the
 * literature), novelty / citation outlook and author identity. None may stop the report. -> { plagiarism, novelty, authorIdentity }
 */
/** The report a re-run repeats and every earlier run of it */
const recheckIds = input => [...new Set([input.recheckOf, ...(input.recheckChain || [])].map(Number).filter(Boolean))].slice(0, 20);

// runs of a Full Screening job the similarity search may take (each about 4 minutes on Vercel): a search stopped by the
// time limit goes on in the next run (its searches are cached, so it gets further each time); the last one saves the report
const SIMILARITY_RUNS = 4;

async function textModules({ input, body, refs, meta, update, stage, deadline, attempt = 0 }) {
  const text = input.text || [input.bodyText || '', input.referencesText || ''].join('\n');
  const { ResumeLater, MAX_ATTEMPTS } = require('./jobs');
  const canResume = Number.isFinite(deadline) && attempt > 0 && attempt < Math.min(SIMILARITY_RUNS, MAX_ATTEMPTS - 1);
  const similarity = stage('similarity', async () => {
    if (!(body && body.trim().length > 1500)) return { kind: 'plagiarism', error: 'Upload the full manuscript text to check for plagiarism (only a reference list was provided).' };
    const PL = require('./checks/plagiarism');
    update('Similarity report: comparing the text with published papers, the web and earlier PJPS submissions');
    // "Submitted works" (opt-in): earlier PJPS submissions sharing text, other versions of this manuscript left out
    const submissions = input.compareSubmissions ? await PL.earlierSubmissions(body, { excludeCode: meta.manuscriptCode || null, excludeCheckIds: recheckIds(input) }).catch(() => []) : null;
    // the similarity search stops in time for the rest of the report to be saved within this run
    const out = await PL.checkPlagiarism({ body, bibliography: refs.map(r => r.raw).join('\n'), meta, submissions, external: !!input.externalCompare, deadline: deadline - 30000, canResume }, s => update(`Similarity: ${s}`))
      .catch(e => ({ kind: 'plagiarism', error: `The plagiarism check could not be completed: ${e.message}` }));
    // not saved as a stage: the next run searches on from here
    if (out?.unfinished) throw new ResumeLater(out.unfinished);
    return out;
  });
  const novelty = stage('novelty', () => require('./checks/novelty').checkNovelty({ meta, journal: { name: cfg.HOME_JOURNAL.name, issn: cfg.HOME_JOURNAL.issn[0] } })
    .catch(e => ({ kind: 'novelty', error: `The novelty assessment could not be completed: ${e.message}` })));
  const authors = stage('authors', () => require('./checks/authorIdentity').checkAuthorIdentity({ text, meta })
    .catch(e => ({ kind: 'authors', error: `The author identity check could not be completed: ${e.message}` })));
  const [plagiarism, novelty_, authorIdentity] = await Promise.all([similarity, novelty, authors]);
  return { plagiarism, novelty: novelty_, authorIdentity };
}

/**
 * The Module 5 report the browser attaches to the job ({ imagesCheckId, imagesEmbedded } or { imagesNote }). A run
 * that Vercel stops while waiting resumes here (the stages before are kept); after IMAGES_WAIT_MS from the job's start
 * the screening goes on without the figures.
 */
const IMAGES_WAIT_MS = 25 * 60000;
async function imagesFromBrowser(jobId, update) {
  const { jobInput } = require('./jobs');
  const started = Number((await db.one('SELECT EXTRACT(EPOCH FROM created_at) * 1000 AS t FROM jobs WHERE id = $1', [jobId]))?.t) || Date.now();
  for (let i = 0; ; i++) {
    const cur = await jobInput(jobId).catch(() => null) || {};
    if (cur.imagesCheckId || cur.imagesNote) return { imagesCheckId: cur.imagesCheckId || null, imagesEmbedded: !!cur.imagesEmbedded, imagesNote: cur.imagesNote || null };
    if (Date.now() - started > IMAGES_WAIT_MS) return { imagesNote: 'Not checked — the figure analysis in the browser did not finish (was the page closed?). Run Module 5 on the manuscript file separately.' };
    if (i % 5 === 0) update('Waiting for the figure analysis (Module 5) in this browser');
    await new Promise(r => setTimeout(r, 2000));
  }
}

/** Front page: one line per module and the desk-review recommendation */
/** What the Full Screening Report keeps of the image report (no thumbnails; the full report stays in its own check) */
function imagesBlock(imageReport, checkId) {
  const brief = f => ({ kind: f.kind, category: f.category || 'duplication', level: f.level, a: f.a?.label, b: f.a?.panel !== f.b?.panel ? f.b?.label : null, description: f.description });
  return { checkId, summary: imageReport.summary, findings: (imageReport.findings || []).slice(0, 30).map(brief),
    references: (imageReport.references || []).slice(0, 30).map(m => ({ panel: m.panelLabel, source: m.sourceName, title: m.title, doi: m.doi, journal: m.journal, year: m.year, figure: m.figure, level: m.level, description: m.description })),
    earlier: (imageReport.earlier || []).length, reviewNotes: imageReport.reviewNotes || [] };
}

/**
 * A Full Screening Report brought up to date with its (re-reviewed) image report: the image section, the paper-mill
 * image signal and risk, and the recommendation. Returns the updated result.
 */
function refreshScreeningImages(result, imageReport, checkId) {
  const r = JSON.parse(JSON.stringify(result));
  r.images = imagesBlock(imageReport, checkId);
  if (r.papermill?.signals) {
    const PM = require('./papermill');
    const sig = PM.imagesSignal({ findings: imageReport.summary.byLevel || {}, categories: imageReport.summary.byCategory || {} });
    r.papermill.signals = r.papermill.signals.filter(s => s.code !== 'images').concat(sig ? [sig] : []);
    r.papermill.risk = PM.riskLevel(r.papermill.signals);
  }
  markPublishedOnPjps(r);
  r.screening = screeningSummary(r);
  return r;
}

function screeningSummary(r) {
  const s = r.references.summary;
  const c = r.citations?.summary;
  const cp = r.compliance?.summary;
  const pm = r.papermill?.risk;
  const im = r.images?.summary;
  const pl = r.plagiarism && !r.plagiarism.error ? r.plagiarism.summary : null;
  const nv = r.novelty && !r.novelty.error ? r.novelty.summary : null;
  const ai = r.authorIdentity && !r.authorIdentity.error ? r.authorIdentity : null;
  const reasons = [];
  let rec = 'proceed';
  const escalate = (level, why) => { reasons.push(why); if (level === 'investigate' || (level === 'return' && rec === 'proceed')) rec = level; };
  // name the strong signals, or when the level comes from the sum of several, the weightiest ones
  const pv = r.publishedOnPjps;
  if (pv) escalate('investigate', `Already published on the PJPS website (Article in Press)${pv.doi ? `, DOI ${pv.doi}` : ''}${pv.percent != null ? ` - ${pv.percent}% of the text matches the published version` : ''}${pv.figures?.length ? `; ${pv.figures.length} figure panel(s) are the published figures` : ''}`);
  const pmTop = () => { const sig = r.papermill.signals.filter(x => x.code !== 'published-pjps'); const high = sig.filter(x => x.severity === 'high'); return (high.length ? high : [...sig].sort((a, b) => b.weight - a.weight)).slice(0, 2).map(x => x.title).join('; '); };
  if (pm?.level === 'HIGH') escalate('investigate', `Paper mill risk HIGH (${pmTop()})`);
  const ownFigs = pv?.figures?.length || 0;
  const imOther = r.images ? (r.images.findings || []).filter(f => f.level === 'high').length + (r.images.references || []).filter(m => m.level === 'high').length - (pv?.figures || []).filter(f => f.level === 'high').length : 0;
  if (im?.level === 'HIGH' && (!ownFigs || imOther > 0)) escalate('investigate', `Image integrity: ${im.byLevel?.high || 0} strong finding(s)`);
  if (s.suspicious >= 3) escalate('investigate', `${s.suspicious} references not found in any database (possibly fabricated)`);
  else if (s.suspicious) escalate('return', `${s.suspicious} reference(s) could not be found`);
  if (s.retracted) escalate('return', `${s.retracted} retracted work(s) cited`);
  if (pm?.level === 'MEDIUM') escalate('return', `Paper mill risk MEDIUM — check the signals before review (${pmTop()})`);
  if (im?.level === 'MEDIUM') escalate('return', `Image integrity: ${im.byLevel?.medium || 0} finding(s) to check`);
  if (c && (c.missing >= 3 || c.uncited >= 5)) escalate('return', `${c.missing} citation(s) missing from the list, ${c.uncited} reference(s) never cited`);
  if (cp && cp.score < 60) escalate('return', `Only ${cp.score}% of references follow PJPS style`);
  if (s.miscited >= 5) escalate('return', `${s.miscited} references with wrong details`);
  if (pl?.level === 'bad' && pv) { /* named above: the overlap is the published version */ }
  else if (pl?.level === 'bad') escalate('investigate', `Text overlap ${pl.similarity}% with published papers (largest single source ${pl.largestSource}%)`);
  else if (pl?.level === 'warn') escalate('return', `Text overlap ${pl.similarity}% with published papers — check the matching passages`);
  const aiHigh = ai ? ai.flags.filter(f => f.severity === 'high') : [];
  if (aiHigh.length) escalate('return', `Author identity: ${aiHigh.slice(0, 2).map(f => f.text).join('; ')}`);
  if (r.noReferenceList) escalate('return', 'No reference list was found in the document');
  const label = { proceed: 'Proceed to peer review', return: 'Return to the authors for corrections', investigate: 'Investigate before any further processing' }[rec];
  return {
    recommendation: rec, recommendationLabel: label, reasons,
    lines: {
      bibliography: r.noReferenceList ? 'No reference list found in the document - not checked' : `${s.verified} verified, ${s.miscited} miscited, ${s.suspicious} suspicious, ${s.retracted} retracted (of ${s.total})`,
      style: r.noReferenceList ? 'not checked (no reference list)' : cp ? `${cp.score}% PJPS compliant (${cp.nonCompliant} reference(s) to fix${cp.inTextIssues ? `, ${cp.inTextIssues} in-text problem(s)` : ''})` : 'not checked',
      citations: c ? `${c.missing} missing, ${c.uncited} uncited, ${(c.yearMismatch || 0) + (c.etAlIssues || 0)} year / “et al.” problem(s)` : 'manuscript text not available',
      papermill: pm ? `${pm.level} (score ${pm.score})` : 'not checked',
      plagiarism: pl ? (pl.internet !== undefined
        ? `Similarity Index ${Math.round(pl.similarity)}% (internet ${Math.round(pl.internet)}%, publications ${Math.round(pl.publications)}%, submitted to PJPS ${Math.round(pl.submissions)}%; ${pl.sources} source(s)${pl.sources ? `, largest ${Math.round(pl.largestSource)}%` : ''})`
        : `${pl.similarity}% overlap with ${pl.sources} published source(s)`) : 'not checked',
      novelty: nv ? `Novelty ${nv.score}/100 (${nv.band}); ${nv.closeRecent} close work(s) in the last 5 years; 5-year citation outlook ${nv.outlook}${Number.isFinite(nv.fiveYearMedian) ? ` (median ${nv.fiveYearMedian})` : ''}` : 'not assessed',
      authors: ai ? `${ai.summary.verified} of ${ai.summary.authors} author(s) identified in ORCID${ai.summary.flags ? `; ${ai.summary.flags} problem(s)` : ''}` : 'not checked',
      published: pv ? `Already published on the PJPS website (Article in Press): “${pv.title}”${pv.doi ? `, DOI ${pv.doi}` : ''}${pv.percent != null ? `; ${pv.percent}% of the text matches it` : ''}${ownFigs ? `; ${ownFigs} figure panel(s) are its published figures` : ''}` : null,
      images: im ? `${im.level} — ${im.findings} finding(s) in ${im.panels} panels${ownFigs ? `; ${ownFigs} panel(s) match the manuscript's own published PJPS version (expected, not re-use)` : ''}${(im.references || 0) + (im.referenceCharts || 0) ? `, ${(im.references || 0) + (im.referenceCharts || 0)} matching published / retracted-paper figures` : ''}` : r.imagesNote || 'not checked (upload the Word / PDF manuscript to analyse its figures)'
    }
  };
}

/** Persist a check; saveMode 'counts' keeps only the numbers (no manuscript content) */
async function saveCheck(userId, result, { issueId = null, saveMode = 'full' } = {}) {
  const meta = result.meta || {};
  let version = meta.version;
  if (meta.manuscriptCode && !version) {
    const row = await db.one('SELECT COALESCE(MAX(version), 0) AS v FROM checks WHERE user_id = $1 AND manuscript_code = $2', [userId, meta.manuscriptCode]);
    version = (row?.v || 0) + 1;
  }
  version = version || 1;
  result.meta.version = version;
  const s = result.references?.summary || {};
  const problems = problemsOf(result);
  const row = await db.one(`INSERT INTO checks(user_id, issue_id, kind, manuscript_code, version, title, ref_total, verified, suspicious, unverified, miscited, retracted,
      missing_citations, uncited_references, journal_flags, self_citation_rate, problems, result, origin, pending_online)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id, created_at`,
  [userId, issueId || null, result.kind, meta.manuscriptCode || null, version, meta.title || null, s.total || 0, s.verified || 0, s.suspicious || 0, s.unverified || 0,
    s.miscited || 0, s.retracted || 0, result.citations?.summary?.missing || 0, result.citations?.summary?.uncited || 0, result.journals?.summary?.highRisk || 0,
    result.pattern?.summary?.selfCitationRate || 0, JSON.stringify(problems), saveMode === 'counts' ? null : JSON.stringify(result),
    cfg.DESKTOP ? 'desktop' : 'web', s.pending || 0]);
  if (saveMode !== 'counts') await require('./reportStore').offload(row.id, result);
  result.id = row.id;
  result.createdAt = row.created_at;
  return row.id;
}

/**
 * Save the result of any other tool to My Activity. fields: { title, manuscriptCode, refTotal, problems[], counts:{verified,...}, pending }
 */
async function saveResult(userId, kind, result, fields = {}) {
  const c = fields.counts || {};
  const row = await db.one(`INSERT INTO checks(user_id, kind, manuscript_code, title, ref_total, verified, suspicious, unverified, miscited, retracted, problems, result, origin, pending_online)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, created_at`,
  [userId, kind, fields.manuscriptCode || null, String(fields.title || kind).slice(0, 300), fields.refTotal || 0, c.verified || 0, c.suspicious || 0, c.unverified || 0, c.miscited || 0, c.retracted || 0,
    JSON.stringify(fields.problems || []), JSON.stringify(result), cfg.DESKTOP ? 'desktop' : 'web', fields.pending || 0]);
  await require('./reportStore').offload(row.id, result);
  result.id = row.id;
  result.createdAt = row.created_at;
  return row.id;
}

async function loadCheck(userId, id) {
  const row = await db.one('SELECT * FROM checks WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!row) return null;
  const result = row.result ? await require('./reportStore').load(row.result) : null;
  if (result) { result.id = row.id; result.createdAt = row.created_at; result.issueId = row.issue_id; }
  // similarity reports saved before 6 Nov 2026 named the search services behind them
  if (result?.plagiarism || result?.kind === 'plagiarism') require('./checks/plagiarism').hideServiceNames(result.plagiarism || result);
  return { row, result };
}

/**
 * Read-only access for integrity work: the owner, a Super Admin, or a user with case management for a report that is
 * linked to an integrity case.
 */
async function loadShared(user, id) {
  const own = await loadCheck(user.id, id);
  if (own) return own;
  const row = await db.one('SELECT user_id FROM checks WHERE id = $1', [id]);
  if (!row) return null;
  const { permissionsOf } = require('./modules');
  const shared = user.role === 'super_admin' || (permissionsOf(user).includes('papermill') && await db.one('SELECT 1 FROM cases WHERE check_ids @> $1::jsonb', [JSON.stringify([Number(id)])]));
  return shared ? loadCheck(row.user_id, id) : null;
}

module.exports = { imagesBlock, refreshScreeningImages, runCheck, saveCheck, saveResult, loadCheck, loadShared, prepare, normalizeMeta, screeningSummary };
