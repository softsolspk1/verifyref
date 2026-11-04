// test/papermill-signals.js - Module 4 reference and ORCID signals built on Retraction Watch: references to journals with
// many paper-mill retractions (full and abbreviated names) and retracted papers on the authors' ORCID records (exact DOI,
// not counted twice by the name match). In-memory database, ORCID API stubbed. Run: node test/papermill-signals.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.APP_MODE;
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) process.env[k] = '';
const assert = require('assert');
// abstracts of two mill retractions for the title + abstract look-alike index (scripts/load-mill-abstracts.js writes the real file)
const ABS_FILE = require('path').join(require('os').tmpdir(), `pjps-mill-abstracts-${process.pid}.json.gz`);
require('fs').writeFileSync(ABS_FILE, require('zlib').gzipSync(JSON.stringify({
  '10.4444/la.1': 'Circular RNAs regulate tumour progression. Here we found that circITGA7 was upregulated in thyroid cancer tissues and cell lines. Knockdown of circITGA7 inhibited proliferation, migration and invasion of thyroid cancer cells and induced apoptosis. Mechanistically circITGA7 acted as a sponge of miR-198 and upregulated FGFR1. Rescue experiments confirmed the circITGA7 miR-198 FGFR1 axis, and xenograft assays in nude mice showed reduced tumour growth.',
  '10.4444/la.2': 'Long non-coding RNA KRAL was decreased in osteosarcoma. Overexpression of KRAL suppressed cell growth and increased sensitivity to doxorubicin by sponging microRNA-141 and regulating its target gene, as shown by luciferase reporter, CCK-8 and Transwell assays.'
})));
process.env.MILL_ABSTRACTS_FILE = ABS_FILE;

// ORCID public API stub (must be installed before src/papermill reads getJson)
const http = require('../src/http');
const ORCID = '0000-0002-1825-0097';
http.getJson = async url => {
  if (url.endsWith(`${ORCID}/works`)) return { ok: true, status: 200, data: { group: [
    { 'external-ids': { 'external-id': [{ 'external-id-type': 'doi', 'external-id-value': 'https://doi.org/10.9999/MILL.7' }] } },
    { 'external-ids': { 'external-id': [{ 'external-id-type': 'doi', 'external-id-value': '10.9999/clean.1' }] } }
  ] } };
  if (url.endsWith(`${ORCID}/person`)) return { ok: true, status: 200, data: { name: { 'given-names': { value: 'Josiah' }, 'family-name': { value: 'Carberry' } } } };
  return { ok: false, status: 404, data: null };
};

const db = require('../src/db');
const D = require('../src/datasets');
const { detectPaperMill } = require('../src/papermill');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

(async () => {
  await db.init();
  const ins = (doi, journal, reason, authors = '') => db.query("INSERT INTO retractions(doi, title, journal, journal_norm, nature, reason, authors, retraction_date) VALUES($1, $2, $3, $4, 'Retraction', $5, $6, '2023-01-01')",
    [doi, `Paper ${doi}`, journal, require('../src/text').normalizeJournal(journal), reason, authors]);
  for (let i = 0; i < 25; i++) await ins(`10.1111/mill.${i}`, 'Evidence-Based Complementary and Alternative Medicine', '+Paper Mill;+Investigation by Journal/Publisher;');
  for (let i = 0; i < 18; i++) await ins(`10.2222/few.${i}`, 'Journal of Few Problems', '+Paper Mill;');
  for (let i = 0; i < 40; i++) await ins(`10.3333/err.${i}`, 'Journal of Honest Errors', '+Error in Data;');
  await ins('10.9999/mill.7', 'Journal of Few Problems', '+Fake Peer Review;', 'Josiah Carberry');
  // titles of mill retractions for the look-alike signal (Papermill Alarm approach); a look-alike retracted for another reason
  const insT = (doi, title, reason) => db.query("INSERT INTO retractions(doi, title, journal, journal_norm, nature, reason, retraction_date) VALUES($1, $2, 'Journal of Lookalikes', 'journal lookalikes', 'Retraction', $3, '2024-03-20')", [doi, title, reason]);
  await insT('10.4444/la.1', 'circITGA7 Functions as an Oncogene by Sponging miR-198 and Upregulating FGFR1 Expression in Thyroid Cancer', '+Paper Mill;');
  await insT('10.4444/la.2', 'LncRNA KRAL suppresses cell growth in osteosarcoma cells by sponging microRNA-141', '+Computer-Aided Content or Computer-Generated Content;+Paper Mill;');
  await insT('10.4444/la.3', 'Metformin matrix tablets with natural gums: formulation and in vitro release', '+Error in Data;');

  // ---- the journal index: threshold, abbreviated names, mill reasons only
  ok((await D.millJournalFor('Evidence-Based Complementary and Alternative Medicine'))?.mill === 25, 'full journal name found with its mill count');
  ok((await D.millJournalFor('Evid Based Complement Alternat Med'))?.mill === 25, 'NLM abbreviation matched word by word');
  ok(!(await D.millJournalFor('Journal of Few Problems')), 'journal below 20 mill retractions not listed');
  ok(!(await D.millJournalFor('Journal of Honest Errors')), 'retractions for other reasons do not count');
  ok(!(await D.millJournalFor('Evid Med')), 'a short abbreviation does not match by prefix');

  // ---- signal: share of the reference list in mill journals
  const ref = (i, journal) => ({ index: i, status: 'verified', record: { journal }, raw: `Ref ${i}` });
  const run = refs => detectPaperMill({ text: `Manuscript text. ORCID ${ORCID}. Contact: author@uni.edu.pk`, meta: { title: 'Short', authors: [{ given: 'Josiah', family: 'Carberry' }] }, references: refs, blast: false, cellosaurus: false });
  const many = [...Array(5)].map((_, i) => ref(i + 1, i % 2 ? 'Evid Based Complement Alternat Med' : 'Evidence-Based Complementary and Alternative Medicine'));
  const r1 = await run([...many, ...[...Array(15)].map((_, i) => ref(i + 6, 'Pak J Pharm Sci'))]);
  const mj = r1.signals.find(s => s.code === 'mill-journals');
  ok(mj && mj.severity === 'medium' && mj.weight === 2, '5 of 20 references (25%) in a mill journal: medium signal');
  ok(/25 paper-mill retractions/.test(mj.evidence[0].text), 'evidence names the Retraction Watch count');
  const r2 = await run([...many.slice(0, 3), ...[...Array(17)].map((_, i) => ref(i + 4, 'Pak J Pharm Sci'))]);
  ok(r2.signals.find(s => s.code === 'mill-journals')?.severity === 'low', '3 of 20 (15%): low signal');
  const r3 = await run([...many.slice(0, 3), ...[...Array(37)].map((_, i) => ref(i + 4, 'Pak J Pharm Sci'))]);
  ok(!r3.signals.some(s => s.code === 'mill-journals'), '3 of 40 (7.5%): no signal');

  // ---- signal: retracted paper on the author's ORCID record, not double-counted by the name match
  const om = r1.signals.find(s => s.code === 'orcid-mill-retraction');
  ok(om && om.severity === 'high', 'retracted-for-fake-peer-review DOI on the ORCID record: strong signal');
  ok(/Josiah Carberry \(ORCID 0000-0002-1825-0097\)/.test(om.evidence[0].text) && om.evidence[0].link === 'https://doi.org/10.9999/mill.7', 'evidence names the ORCID owner and links the DOI');
  ok(!r1.signals.some(s => /^author-(mill-)?retraction/.test(s.code)), 'the same paper is not counted again by the name match');
  ok(r1.details.orcidRetractions.length === 1 && r1.details.millJournals.length === 1, 'details carry both results for the report');

  // ---- the editor's assessment: convergence, recommended action, checklist and a neutral query letter
  const a1 = r1.assessment;
  ok(a1 && a1.convergence.of === 4 && a1.completeness.total === r1.overview.length, 'assessment attached to the report');
  ok(a1.convergence.flagged === new Set(r1.signals.filter(s => s.severity !== 'low').map(s => s.group)).size, 'flagged areas = areas with moderate or strong signals');
  ok(a1.action.tone === { HIGH: 'bad', MEDIUM: 'warn', LOW: 'good' }[r1.risk.level], 'recommended action follows the risk level');
  ok(a1.verify.length === new Set(r1.signals.map(s => s.code)).size, 'one verification line per signal type');
  const A = require('../src/papermill/assessment');
  const sigs = [{ group: 'references', code: 'fabricated', title: '4 references not found', severity: 'high', weight: 4 }, { group: 'authors', code: 'free-mail', title: 'Free-mail', severity: 'medium', weight: 2 },
    { group: 'data', code: 'statistics', title: 'Inconsistent p-values', severity: 'medium', weight: 2 }, { group: 'text', code: 'tortured', title: 'A tortured phrase', severity: 'low', weight: 1 }];
  const rep = { meta: { manuscriptCode: 'PJPS-2026-0999', title: 'A test' }, risk: { level: 'HIGH', score: 9 }, signals: sigs, overview: [{ check: 'x', light: 'red', result: '' }, { check: 'y', light: 'grey', result: 'Not checked — no ORCID iD' }] };
  const a2 = A.assess(rep);
  ok(a2.convergence.flagged === 3 && /3 of 4 independent areas/.test(a2.statement) && /several independent areas/.test(a2.statement), 'three areas: convergence stated');
  ok(a2.action.title === 'Hold the manuscript and escalate' && /COPE/.test(a2.action.text), 'HIGH: hold and escalate (COPE)');
  ok(a2.completeness.run === 1 && a2.completeness.level === 'partial' && /could not be run/.test(a2.statement), 'checks not run lower the completeness');
  ok(a2.ask.length === 4 && a2.verify[0].severity === 'high', 'author requests for every signal in a HIGH case; strongest check first');
  const letter = A.queryLetter(rep, a2);
  ok(letter.includes('PJPS-2026-0999') && letter.includes('DOI or a working link') && !/paper.?mill|screen|integrity|fraud|suspic/i.test(letter), 'query letter is specific and neutral');
  const low = A.assess({ ...rep, risk: { level: 'LOW', score: 1 }, signals: [sigs[3]] });
  ok(low.convergence.flagged === 0 && low.ask.length === 0 && A.queryLetter({ ...rep, signals: [sigs[3]] }, low) === '' && low.action.tone === 'good', 'LOW with a weak signal: no query, continue');

  // paper-mill profiles (benchmark: docs/benchmark-papermill.md)
  const P = require('../src/papermill');
  const millBody = 'Cell viability was measured by CCK-8 assay. Transwell and wound healing assays, colony formation, flow cytometry, western blot, qRT-PCR and dual-luciferase reporter assays were performed in A549 and H1299 cells. A549 cells, H1299 cells and A549 xenografts in nude mice were used; A549 and H1299 lines.';
  const mt = await P.textSignals(millBody, millBody, [], { title: 'LncRNA ABC1 promotes lung cancer progression via regulating the miR-21/PTEN axis' });
  ok(mt.some(s => s.code === 'mill-template' && s.severity === 'medium' && s.weight === 4), 'molecular-oncology template: ncRNA title + assay stack + cell lines + xenograft');
  const one = await P.textSignals(millBody, millBody, [], { title: 'Effect of quercetin on A549 cells' });
  ok(!one.some(s => s.code === 'mill-template' && s.severity === 'medium'), 'the same assays without the template title: not MEDIUM');
  const off = await P.textSignals('Body text.', 'Body text.', [], { title: 'Analysis on the Construction of Marxist Ideological Discourse Power in the Environment of Big Data' });
  ok(off.some(s => s.code === 'off-scope'), 'technology buzzwords on a non-biomedical subject: off-scope');
  const onTopic = await P.textSignals('Body text.', 'Body text.', [], { title: 'Deep learning prediction of drug toxicity in hospital patients' });
  ok(!onTopic.some(s => s.code === 'off-scope'), 'a biomedical machine-learning paper is not off-scope');

  // ---- titles resembling papers retracted for paper-mill reasons
  const look = await P.millLookalikes('circITGA7 acts as an oncogene by sponging miR-198 and upregulating FGFR1 in papillary thyroid cancer');
  ok(look.length === 1 && look[0].doi === '10.4444/la.1' && look[0].similarity >= 0.6, 'reworded mill title found with its similarity');
  ok(/Paper Mill/.test(look[0].reason), 'only the mill reason is quoted');
  ok(!(await P.millLookalikes('circITGA7 Functions as an Oncogene by Sponging miR-198 and Upregulating FGFR1 Expression in Thyroid Cancer')).length, 'the same title is the published signal, not a look-alike');
  ok(!(await P.millLookalikes('Metformin matrix tablets with natural gums: formulation and in vitro release studies')).length, 'retractions for other reasons are not in the index');
  ok(!(await P.millLookalikes('Formulation of sustained release diclofenac sodium microspheres')).length, 'an unrelated title: no look-alike');
  const lr = await detectPaperMill({ text: 'Manuscript text.', meta: { title: 'circITGA7 acts as an oncogene by sponging miR-198 and upregulating FGFR1 in papillary thyroid cancer' }, references: [], blast: false, cellosaurus: false });
  const ls = lr.signals.find(x => x.code === 'mill-lookalike');
  ok(ls && ls.severity === 'medium' && ls.weight === 2 && ls.evidence[0].link === 'https://doi.org/10.4444/la.1', 'detectPaperMill adds the look-alike signal with evidence');
  // title + abstract against the abstracts of mill retractions: the same template with another circRNA, microRNA and cancer
  const MI = require('../src/papermill/millIndex');
  const absText = 'Abstract: Circular RNAs regulate tumour progression. We found that circPVT1 was upregulated in gastric cancer tissues and cell lines. Knockdown of circPVT1 inhibited proliferation, migration and invasion of gastric cancer cells and induced apoptosis. Mechanistically circPVT1 acted as a sponge of miR-124 and upregulated AKT3. Rescue experiments confirmed the circPVT1 miR-124 AKT3 axis, and xenograft assays in nude mice showed reduced tumour growth.\nIntroduction\nGastric cancer is common.';
  const absTitle = 'circPVT1 promotes gastric cancer progression by sponging miR-124 to upregulate AKT3';
  const al = await MI.abstractLookalikes(absTitle, MI.abstractOf({}, absText));
  ok(al && al[0].doi === '10.4444/la.1' && al[0].score >= 0.2, `title + abstract template found (${al && al[0]?.score?.toFixed(2)})`);
  ok(/^Circular RNAs regulate/.test(MI.abstractOf({}, absText)) && !/Gastric cancer is common/.test(MI.abstractOf({}, absText)), 'abstract read from the text up to the next heading');
  ok((await MI.abstractLookalikes('Formulation of metformin tablets', 'Metformin hydrochloride sustained release matrix tablets were prepared by wet granulation using xanthan gum and guar gum in different ratios. Hardness, friability, swelling index and drug release in phosphate buffer were evaluated, and release followed the Higuchi model with non-Fickian diffusion over twelve hours.'))?.length === 0, 'an unrelated pharmaceutics abstract: no look-alike');
  ok((await MI.abstractLookalikes('Short', 'Too short.')) === null, 'too little text: not compared');
  const ar = await detectPaperMill({ text: absText, meta: { title: absTitle }, references: [], blast: false, cellosaurus: false });
  const as = ar.signals.find(x => x.code === 'mill-lookalike');
  ok(as && as.severity === 'medium' && as.weight === 4 && /title and abstract/.test(as.evidence[0].text), 'detectPaperMill: title + abstract look-alike weighs 4');
  ok(ar.details.abstractIndex === true && ar.details.abstractLookalikes.length >= 1, 'details record the abstract comparison');

  ok(!(await detectPaperMill({ text: 'Manuscript text.', meta: { title: 'circITGA7 acts as an oncogene by sponging miR-198 in thyroid cancer' }, references: [], blast: false, cellosaurus: false, millLookalike: false })).signals.some(x => x.code === 'mill-lookalike'), 'can be switched off');

  // ---- submission checks (papermill.txt section 6): cover letter, scope, waves of similar submissions
  const base = { references: [], blast: false, cellosaurus: false, millLookalike: false };
  const cl = await detectPaperMill({ ...base, text: 'Manuscript text. Contact: a.khan@uop.edu.pk', meta: { title: 'Antibacterial potential of neem leaf extract against MRSA isolates' },
    coverLetter: 'Dear Editor, we are pleased to submit our manuscript for publication in the Journal of Ethnopharmacology. Please write to agent.desk@gmail.com. Regards, [Author Name]' });
  const codes = cl.signals.map(x => x.code);
  ok(codes.includes('cover-other-journal') && codes.includes('cover-placeholder') && codes.includes('cover-email'), 'cover letter: other journal, placeholder, outside mailbox');
  ok(cl.checked.coverLetter && cl.overview.some(o => /Cover letter/.test(o.check) && o.light === 'amber'), 'cover letter row in the overview');
  const fine = await detectPaperMill({ ...base, text: 'Manuscript text.', meta: { title: 'Antibacterial potential of neem leaf extract against MRSA isolates' },
    coverLetter: 'Dear Editor, we submit our manuscript for consideration in the Pakistan Journal of Pharmaceutical Sciences. Our earlier work appeared in Phytomedicine. It has not been submitted to any other journal.' });
  ok(!fine.signals.some(x => x.code.startsWith('cover-')), 'an ordinary PJPS cover letter raises nothing');
  const outScope = await detectPaperMill({ ...base, text: 'Abstract. Reinforcement learning controls traffic signals at urban intersections to cut queue length and waiting time for vehicles in smart cities.', meta: { title: 'Traffic signal control with deep reinforcement learning at urban intersections' } });
  const os = outScope.signals.find(x => x.code === 'out-of-scope' || x.code === 'off-scope');
  ok(os && (os.code === 'off-scope' || os.weight === 0), 'outside the PJPS scope: shown (weight 0 unless the mill profile fires)');
  // waves: two recent submissions by other authors on the same title template
  const fp = (code, title, authors) => db.query("INSERT INTO fingerprints(manuscript_code, kind, title, data) VALUES($1, 'text', $2, $3)", [code, title, JSON.stringify({ shingles: [1, 2, 3], authors })]);
  await fp('PJPS-W1', 'LncRNA HOTAIR promotes proliferation and invasion of gastric cancer cells by sponging miR-331 to regulate HER2', ['Wei Zhang', 'Li Na']);
  await fp('PJPS-W2', 'LncRNA MALAT1 promotes proliferation and invasion of colorectal cancer cells by sponging miR-145 to regulate ZEB1', ['Hao Chen']);
  await fp('PJPS-W3', 'Formulation of sustained release diclofenac microspheres', ['Wei Zhang']);
  const wv = await detectPaperMill({ ...base, text: 'Manuscript text.', meta: { title: 'LncRNA SNHG16 promotes proliferation and invasion of bladder cancer cells by sponging miR-200 to regulate ZEB2', authors: [{ given: 'Amir', family: 'Raza' }] } });
  const ws = wv.signals.find(x => x.code === 'submission-wave');
  ok(ws && ws.evidence.length === 2 && ws.weight === 1, 'wave of two same-template submissions by other authors');
  const own = await detectPaperMill({ ...base, text: 'Manuscript text.', meta: { title: 'LncRNA SNHG16 promotes proliferation and invasion of bladder cancer cells by sponging miR-200 to regulate ZEB2', authors: [{ given: 'Wei', family: 'Zhang' }, { given: 'Hao', family: 'Chen' }] } });
  ok(!own.signals.some(x => x.code === 'submission-wave'), "the same research group's own series is not a wave");

  console.log(`papermill-signals: ${n} checks passed`);
  await db.close?.();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
