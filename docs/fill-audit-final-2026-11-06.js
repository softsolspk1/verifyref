// docs/fill-audit-final-2026-11-06.js - the final audit of 6 November 2026: the morning audit (audit-results-2026-11-06.json)
// with the evening re-runs and the fixes made after it. Evening measurements (logs in D:\pjps-tmp\audit-2026-11-06b):
//   Module 1 ground truth again (audit-m1, -hard, -real), Module 4 audit again, BioFors image benchmark again, the author
//   retraction signal measured for the first time on the 109 benchmark papers with author lists, report #117 re-reviewed
//   and re-run, npm test.
// Run: node docs/fill-audit-final-2026-11-06.js  ->  docs/audit-results-2026-11-06-final.json
//      AUDIT_RESULTS=docs/audit-results-2026-11-06-final.json node docs/build-audit-report-2026-11-06.js
const fs = require('fs');
const path = require('path');

const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'audit-results-2026-11-06.json'), 'utf8'));
const S = fs.existsSync('D:/pjps-tmp/audit-2026-11-06b/suite.txt') ? fs.readFileSync('D:/pjps-tmp/audit-2026-11-06b/suite.txt', 'utf8').trim() : null;

R.date = '6 November 2026 (final, evening)';
R.outName = 'PJPS-Audit-Report-Modules-1-5-Final-2026-11-06.docx';

// ------------------------------------------------------------------ fixes made after the morning audit
const evening = [
  { gap: 'Module 4: authors with common names matched to other people\'s paper-mill retractions', before: 'Report #117: "Muhammad Ali" matched 12 paper-mill retractions of 36 different people (physics, economics, fuzzy maths...) through words such as "health", "dental" or the city, and raised a HIGH signal. On 109 benchmark papers the HIGH author signal fired on 23 of 54 ordinary papers (43%)', after: 'Subject words, hospital-name words ("Affiliated", "People\'s", "First"), countries and cities no longer count as an institution match; a name found at 4+ institutions needs two distinctive institution words; the HIGH signal needs an institution match. Report #117: 0 HIGH hits. Ordinary papers with the HIGH signal: 23/54 -> 6/54 (11%); mill papers 31/55 -> 16/55 (29%)' },
  { gap: 'Module 5: Word figures in text boxes read 2-4 times', before: 'Report #117: 14 figures read as 56 pictures (Word keeps text boxes twice; every picture was also read for each paragraph around it); every copy was reported as a duplicate or overlapping image (36 findings)', after: 'Each picture is read once, from its own paragraph; fallback copies and deleted tracked changes skipped (test/docx-pictures.mjs). Saved reports: identical stored copies analysed once' },
  { gap: 'Module 5: bars of drawn bar charts read as western blots', before: 'Report #117: single grey bars cut out as "blot" panels; 8 cloned-area and 16 joined-lane / histogram findings on bars, and 30 bars "matched" published or retracted figures', after: 'Drawn graphics recognised as charts and kept whole (0 of 2,800 BioFors photos, blots, micrographs and FACS plots misread); BioFors benchmark unchanged (91/155 duplicates, 0 false reports on 17,571 pairs)' },
  { gap: 'Module 5: saved reports kept the false findings', before: 'Reports made before the fix still showed them', after: 'Server review re-applied to every saved image report: #116/#117 60 findings -> 0 (HIGH -> LOW), #54 16 -> 9, #64 4 -> 3, #81 58 -> 44 (every removed finding checked by hand); 20 other reports unchanged' },
  { gap: 'Re-check: "Check not found" for a Super Admin', before: 'Re-check (complete report or references), export, summary, letter, comparison, confidential, screening and similarity downloads worked for the report\'s owner only, although the report opened for Super Admins', after: 'Same access as opening the report (owner, Super Admin, case manager of a linked case); re-check fields can no longer be set by the browser' },
  { gap: 'Re-check: a re-run flagged as a duplicate submission of its own original', before: 'A complete re-run raised the HIGH "Matches an earlier PJPS submission" signal (100% overlap with the report it repeats)', after: 'The original and earlier re-runs are left out of the duplicate-submission check and the "submitted works" similarity; report #117 re-run as #120: paper-mill risk HIGH 12.5 -> LOW 2.5, images HIGH -> LOW' }
];
R.fixes = [...R.fixes, ...evening];
R.counts.fixed = R.fixes.length;
R.counts.features += 2; // 5.10 server review, F7 re-check
R.fixesTitle = `1.1 Gaps found and fixed on 6 November (${R.fixes.length}: ${R.fixes.length - evening.length} in the morning audit, ${evening.length} after it)`;
R.summaryText = `Every feature of the five modules, the Full Screening Report and the Similarity Report was checked from the start on 6 November 2026: ${R.counts.features} features, each against cases whose correct answer is known in advance, a published benchmark, or both. ${R.fixes.length} gaps were found and fixed the same day, ${evening.length} of them in the evening after a real manuscript (report #117) showed false image and author findings; Modules 1, 4 and 5 were measured again after those fixes. The table gives each module's headline figure; sections 3 to 9 list every feature, section 10 the gaps still open and section 11 what would raise accuracy further.`;

R.conditions += ' Evening re-runs (Modules 1, 4 and 5): OpenAlex was again out of daily budget and the web-search keys exist only on the web portal, so the office PC ran without OpenAlex, Brave and SerpApi; Module 1 gave the same result as in the morning.';
R.method.push(['Evening re-runs (6 Nov)', 'audit-m1, audit-m1-hard, audit-m1-real and audit-m4 again; BioFors image benchmark again (60 papers, all tasks); the author-retraction signal on the 109 benchmark papers whose author lists and affiliations are in their full text (55 mill, 54 ordinary; each paper\'s own retraction left out); 120 real paper-mill retractees matched against their own institution (60 Pakistan, 60 China); report #117 re-reviewed and re-run in full (#120).']);

// ------------------------------------------------------------------ summary rows
const row = name => R.summary.find(r => r.module.startsWith(name));
row('4.').result = 'Planted mill manuscript: 10 of 10 signals found (HIGH); clean control LOW. Whole module on 150 real mill papers vs 126 ordinary: 46/150 (30.7%) MEDIUM or HIGH, 5/126 (4.0%) false alarms (text and references). Author-retraction signal (new measurement, 109 papers): HIGH on 16/55 mill vs 6/54 ordinary papers after the evening fix (was 31/55 vs 23/54)';
row('4.').limit = 'About 7 in 10 mill papers not flagged from text and references; author matching is by name (ORCID only when given): 1 in 9 ordinary papers still gets the HIGH author signal, 3 in 10 the medium one';
row('5.').result = 'Generated copies: whole-image 125/125, partial 18/25, cloned areas 15/25, 0/30 false alarms. BioFors (real, expert-annotated): duplicates 91/155 (59%; 55 strong), 0 false reports on 17,571 unrelated pairs; cloned areas 33% found vs 11% of clean images. Real manuscript #117: 60 false findings (Word copies, bar charts) -> 0 after the evening fix';
row('5.').limit = 'Cloned areas and splicing are weak; figures never leave PJPS (no commercial figure database); the uploaded file is not kept, so a saved report can be reviewed again but not re-analysed from the figures';

// ------------------------------------------------------------------ Module 1
R.m1.tables[0].title = 'Ground-truth sets (run again in the evening: same result)';

// ------------------------------------------------------------------ Module 4
R.m4.tables.push({
  title: 'Author-retraction signal (new measurement, 6 Nov evening)',
  headers: ['Version', 'Mill papers: HIGH author signal', 'Ordinary papers: HIGH author signal', 'Real retractees still HIGH (own institution)'],
  rows: [
    ['Morning (name and full first name enough)', '35/55 (64%)', ['27/54 (50%)', 'bad'], '60/60 Pakistan; 48/48 China'],
    ['Common names need an institution match', '31/55 (56%)', ['23/54 (43%)', 'bad'], '60/60; 48/48'],
    ['Final: hospital words, countries and cities generic; HIGH needs the institution', '16/55 (29%)', ['6/54 (11%)', 'warn'], '55/60; 40/48 (the rest move to the low "similar name" list, still shown)']
  ],
  widths: [34, 20, 22, 24],
  note: 'Ordinary papers are open-access papers of the same journals and years not in Retraction Watch; some of their authors may truly have earlier retractions, so the false-alarm figure is an upper bound. Name-only matches now give the medium signal "Author(s) with earlier retractions": 17/55 mill and 17/54 ordinary papers (no separation; weight 2). On report #117 the 36 "Muhammad Ali" hits are all low ("probably other people").'
});
const f43 = R.m4.features.find(f => f[0] === '4.3');
f43[3] = 'Planted author with a paper-mill retraction at the same hospital found (HIGH); the same name at another institution gives the medium signal only. Benchmark: HIGH on 16/55 mill vs 6/54 ordinary papers (was 31 vs 23); report #117 false HIGH removed. Free-mail, missing ORCID, authorship change and suggested-reviewer links found';
f43[2] = 'audit-m4 (planted, run again); new author benchmark (109 papers); 120 real retractees';
const f45 = R.m4.features.find(f => f[0] === '4.5');
f45[3] += '; a re-check of the same report is no longer reported as a duplicate (fixed 6 Nov evening)';
f45[4] = 'fixed';
R.m4.limits = [
  'About 7 in 10 real mill papers are not flagged from text and references.',
  'Authors are matched to Retraction Watch by name and affiliation; only an ORCID iD in the manuscript proves identity. 1 in 9 ordinary papers still gets the HIGH author signal and 3 in 10 the medium one, mostly common Chinese and Arabic names at large hospitals; the evidence lists every match for the editor to confirm.',
  'The look-alike signal finds new papers from mills already caught, not a brand-new mill.',
  'PubPeer comments and STM Integrity Hub (cross-publisher duplicates) need a key or membership.'
];

// ------------------------------------------------------------------ Module 5
const m5 = R.m5.tables[0].rows;
const set5 = (task, val, tone) => { const r = m5.find(x => x[1].startsWith(task)); r[2] = [val, tone]; };
set5('Duplicated panels within a paper', '91 found (59%); 55 as Strong (35%) - run again in the evening: identical', 'warn');
set5('Reports not in the annotation', '171 (61 Strong), about 1 Strong per paper; some are real duplicates the annotators missed', 'warn');
set5('Cloned area inside one image (78', '26/78 found (33%) vs 25/231 clean images reported (11%)', 'bad');
set5('Splicing in blots', '14/121 (12%) vs 14/140 (10%): no separation (indicator only)', 'bad');
m5.push(['Drawn graphics (new, 6 Nov evening)', 'BioFors photos, blots, micrographs and FACS plots misread as drawn charts', ['0/2,800 at analysis; 1/2,800 on saved thumbnails', 'ok']]);
m5.push(['Real manuscript (report #117, Word, 14 figures)', 'Pictures read; findings before / after the evening fix', ['56 -> 14 pictures; 60 false findings and 30 false published-figure matches -> 0', 'ok']]);
m5.push(['Saved reports (24 image reports)', 'Re-reviewed with the new rules; every removed finding checked by hand', ['4 reports changed (#116, #54, #64, #81), 20 unchanged; no real finding removed', 'ok']]);
const f51 = R.m5.features.find(f => f[0] === '5.1');
f51[3] = 'Pass; Word text boxes now read once (test/docx-pictures.mjs, fixed 6 Nov evening); drawn bar charts kept whole and typed as charts (test/images-engine.mjs bar-chart case)';
f51[4] = 'fixed';
R.m5.features.push(['5.10', 'Server review of every image report (new and saved): figure-section repeats, stored copies, bars of drawn charts, drawings, generated images', 'test/image-review.js; report #117 and 23 other saved reports re-reviewed', 'Report #117 HIGH 60 findings -> LOW 0; 3 other reports corrected; real re-use under two figure numbers and PDF repeats still reported', 'fixed']);
R.m5.limits = [
  'Exact and lightly altered whole-image copies are found reliably with no false alarms between unrelated figures; partial overlaps, cloned areas and spliced blots are weak.',
  'The Word fix was tested on built test files and on report #117\'s saved results, not yet on the original Word file of #117 (not available); the first new Word manuscript with figures in text boxes should be checked: the figure count must equal the real number of figures.',
  'A whole chart with grid lines is recognised from its very large "background step"; a chart drawn in a way not yet seen could still be read as a blot.',
  'The uploaded manuscript is not kept, so a saved image report can be reviewed again but not analysed again from its figures.',
  'AI-generated images are judged on file markers and statistics only.'
];

// ------------------------------------------------------------------ Full Screening
R.full.features.push(['F7', 'Re-check (complete report or references) by the owner or a Super Admin', 'In-process test with real users on report #117; complete re-run #120', 'Owner and Super Admin re-run, export and download; editors without access refused; the re-run keeps the owner\'s image report and is not reported as a duplicate of its original (fixed 6 Nov evening)', 'fixed']);
R.full.limits = [...(R.full.limits || []), 'A complete re-run uses the text kept in the saved report; figures keep their saved image report (the uploaded file is not kept).'];

// ------------------------------------------------------------------ gaps left
R.gaps = {
  intro: 'What still limits each module after the fixes of 6 November, with the size of the effect where it was measured. "High" means it changes what an editor sees on many manuscripts; "Medium" on some; "Low" rarely or only in edge cases.',
  rows: [
    ['4. Paper Mill', 'Most real mill papers are not flagged from text and references', '46/150 (31%) found; 7 in 10 rely on author, image and history signals', 'High', 'PJPS case decisions to tune weights; PubPeer key; STM Integrity Hub'],
    ['4. Paper Mill', 'Author retractions matched by name and affiliation, not identity', 'HIGH author signal on 6/54 (11%) ordinary papers; medium on 17/54 (31%)', 'High', 'Check each author\'s ORCID works list against the retraction; ask authors for ORCID iDs at submission'],
    ['5. Images', 'Cloned areas inside one image', '33% found vs 11% of clean images reported (BioFors)', 'High', 'Dense copy-move detection; tuning on PJPS figures'],
    ['5. Images', 'Spliced blots', '12% vs 10%: an indicator only', 'Medium', 'Lane-boundary model trained on labelled blots'],
    ['5. Images', 'Partial duplicates', '18/25 generated; 59% of real annotated duplicates', 'Medium', 'Better candidate stage for partial copies'],
    ['5. Images', 'No commercial figure database (PJPS policy)', 'Reuse of figures from other publishers found only through PJPS, Europe PMC and retracted-paper sets', 'Medium', 'Policy decision (vendor search) or larger open-access index'],
    ['5. Images', 'Word fix not yet seen on a real Word file', 'Tested on built files and saved results only', 'Medium', 'Check the next Word manuscript with figures in text boxes'],
    ['5. Images', 'Uploaded file not kept', 'A saved report cannot be analysed again from its figures', 'Low', 'Keep uploads in R2 for a set period (storage and privacy decision)'],
    ['3B. Claim support', 'Abstract-only checks miss claims and contradictions', '28% of supported claims missed; 62% of contradictions not flagged (SciFact)', 'High', 'Open full texts where available; a 100-claim PJPS gold set'],
    ['3C. Citation patterns', 'No public benchmark', 'Planted cases only (6/6)', 'Low', 'PJPS cases'],
    ['1. Bibliography', 'Regional journals no database indexes', 'Stay "Unverified" (correct, but the editor must check)', 'Medium', 'PJPS list of regional journals and their archives'],
    ['1. Bibliography', 'Depends on the OpenAlex daily budget', 'Out of budget on 6 Nov: one miscited case (wrong volume) passed', 'Medium', 'Fund the OpenAlex key'],
    ['2. Style', 'House rules not yet signed off by PJPS editors', 'Constructed test cases only', 'Low', 'Editor sign-off; 100 accepted PJPS manuscripts'],
    ['Similarity', 'Open web only with a web-search key', 'Internet sources missing where the key is absent', 'Medium', 'Brave key on Vercel (in progress)'],
    ['Similarity', 'Paywalled full texts', 'Only through OpenAlex passage search', 'Medium', 'Publisher agreements / Crossref Similarity Check membership'],
    ['Platform', 'Deleting a report leaves its text fingerprint', 'A later screening of the same text can report the deleted report as an earlier submission', 'Low', 'Remove fingerprints with the report, or keep them on purpose as submission history (PJPS decision)']
  ]
};

R.next = [
  ...R.next.slice(0, 2),
  ['3', 'Confirm author identity through ORCID: read each author\'s ORCID works and match the retracted DOI; request ORCID iDs at submission (PJPS)', '4', 'Author false alarms (11% HIGH, 31% medium on ordinary papers) close to zero for authors with an ORCID iD'],
  ...R.next.slice(2).map(r => [String(Number(r[0]) + 1), ...r.slice(1)]),
  [String(R.next.length + 2), 'A regression set of real PJPS Word and PDF manuscripts (figures in text boxes, charts, blots, micrographs) run before every release', '5', 'Layout problems like report #117 caught before they reach editors']
];

if (S) R.suite = S;
fs.writeFileSync(path.join(__dirname, 'audit-results-2026-11-06-final.json'), JSON.stringify(R, null, 1));
console.log(`fixes ${R.fixes.length}, gaps ${R.gaps.rows.length}, next ${R.next.length}${S ? ', suite updated' : ', suite NOT updated'}`);
