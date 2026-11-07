// docs/build-accuracy-report-2026-11-07.js - builds docs/PJPS-Accuracy-Fixes-Report-2026-11-07.docx: the gaps of the final
// audit report of 6 November 2026 worked on 7 November, the cause found for each, the fix and the accuracy measured
// before and after (test/audit-m1*.js, test/audit-m3b.js, test/audit-m4.js, scripts/benchmark-papermill-authors.js, npm test).
// Run: node docs/build-accuracy-report-2026-11-07.js [output.docx]
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, WidthType, ShadingType,
  BorderStyle, LevelFormat, Footer, PageNumber, PageBreak
} = require('docx');

const FONT = 'Calibri';
const NAVY = '1F3864';
const PAGE_W = 11906, MARGIN = 1134, CONTENT = PAGE_W - 2 * MARGIN; // A4, 2 cm margins
const TONE = { ok: 'E2EFDA', warn: 'FFF2CC', bad: 'FCE4D6', na: 'EDEDED' };

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 21, bold: o.bold, italics: o.italics, color: o.color });
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after ?? 120, line: 276 }, alignment: o.align, keepNext: o.keepNext, children: Array.isArray(text) ? text : [run(text, o)] });
const h1 = (t, o = {}) => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: o.pageBreak, children: [new TextRun({ text: t })] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun({ text: t })] });
const bullet = text => new Paragraph({ numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60, line: 264 }, children: Array.isArray(text) ? text : [run(text)] });
const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const borders = { top: border, bottom: border, left: border, right: border };

/** Table with dual widths (columnWidths + every cell), header row shaded; a cell may be [text, tone] */
function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const w = widths.map(x => Math.round(x * CONTENT / total));
  w[w.length - 1] += CONTENT - w.reduce((a, b) => a + b, 0);
  const cell = (content, i, header, tone) => new TableCell({
    width: { size: w[i], type: WidthType.DXA }, borders, margins: { top: 60, bottom: 60, left: 90, right: 90 },
    shading: header ? { fill: NAVY, type: ShadingType.CLEAR, color: 'auto' } : tone ? { fill: TONE[tone], type: ShadingType.CLEAR, color: 'auto' } : undefined,
    children: String(content).split('\n').map(line => new Paragraph({ spacing: { after: 0, line: 252 }, children: [new TextRun({ text: line, font: FONT, size: header ? 19 : 18, bold: header, color: header ? 'FFFFFF' : undefined })] }))
  });
  return new Table({
    width: { size: CONTENT, type: WidthType.DXA }, columnWidths: w,
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((t, i) => cell(t, i, true)) }),
      ...rows.map(r => new TableRow({ cantSplit: true, children: r.map((c, i) => (Array.isArray(c) ? cell(c[0], i, false, c[1]) : cell(c, i, false))) }))
    ]
  });
}
const gap = () => p('', { after: 60 });

const children = [];
const add = (...x) => children.push(...x);

// ------------------------------------------------------------------ title
add(
  p([run('PJPS Data Integrity System', { size: 40, bold: true, color: NAVY })], { after: 60 }),
  p([run('Accuracy Fixes Report: gaps of the 6 November audit', { size: 30, color: NAVY })], { after: 120 }),
  p([run('Pakistan Journal of Pharmaceutical Sciences  ·  7 November 2026  ·  Prepared by Softsols Pakistan', { size: 20, color: '595959' })], { after: 240 })
);

// ------------------------------------------------------------------ 1. summary
add(
  h1('1. Summary'),
  p('The final audit report of 6 November 2026 (PJPS-Audit-Report-Modules-1-5-Final-2026-11-06.docx) lists the gaps still open in each module (its section 10) and what would raise accuracy further (section 11). On 7 November the gaps that development work can close were taken in order of effect. Each fix was measured against the same ground-truth sets and benchmarks as the audit, before and after. Three modules gained accuracy; two secondary Module 4 figures got slightly worse (section 3.3); all 35 test programs pass.'),
  table(['Module', 'Gap (6 Nov report)', 'Before', 'After (7 Nov)'], [
    ['1. Check Bibliography', 'A miscited reference passes when OpenAlex has no budget (PRISMA 2020 with a wrong BMJ volume)', '84 of 85 correct (98.8%)', ['85 of 85 correct (100%): 27/27, 30/30, 28/28', 'ok']],
    ['4. Paper Mill: author signal', 'Authors matched to retractions by name and affiliation, not identity', 'HIGH author signal: 16/55 mill vs 6/54 ordinary papers', ['22/55 mill vs 5/54 ordinary papers; better on both halves of the set', 'ok']],
    ['4. Paper Mill: two-letter surnames', 'Not in the report: found on 7 Nov', 'Authors named Li, Ma, Fu, Yu, Wu... never checked against Retraction Watch', ['Checked (with a full first name); real Chinese retractees found HIGH 15/60 -> 18/60', 'ok']],
    ['3B. Claim support', 'Claims left "Could not verify" when OpenAlex is out of budget and the source is closed-access', 'Abstract taken from OpenAlex first; Crossref and Semantic Scholar not used', ['Free abstract sources first (Europe PMC, Crossref, then OpenAlex, CORE, Semantic Scholar, preprints)', 'ok']],
    ['5. Image Integrity', 'Partial duplicates and cloned areas weak', '18/25 partial; 33% cloned areas', ['Not started: the D: drive was failing (section 4)', 'warn']]
  ], [17, 30, 25, 28]),
  gap(),
  p([run('Not committed yet. ', { bold: true }), run('The changes are in the working copy on D: and a copy is kept on C:. They have not been committed to Git or deployed to the web portal; the desktop application gets them with the next build.')])
);

// ------------------------------------------------------------------ 2. Module 1
add(
  h1('2. Module 1: the wrong-volume case without OpenAlex'),
  h2('2.1 Cause'),
  p('PRISMA 2020 was published in several journals at once (BMJ, PLoS Medicine, Journal of Clinical Epidemiology, International Journal of Surgery, Revista Española de Cardiología...). The BMJ record in Crossref carries no volume. The system already fills a missing volume from another database\'s record of the same DOI, but the title searches of Europe PMC and PubMed returned only the other journals\' copies, never the BMJ one. Only OpenAlex gave the BMJ volume (372), so with OpenAlex out of its daily budget the wrong volume (370) could not be seen and the reference was reported Verified.'),
  h2('2.2 Fix'),
  p('When the matched record still has no volume or pages and the reference cites them, Europe PMC is asked for that DOI directly (one extra request, only in that case). Europe PMC holds the BMJ record with volume 372 (src/checks/reference.js).'),
  h2('2.3 Result'),
  table(['Test', 'Before', 'After'], [
    ['PRISMA 2020 cited as BMJ 2020, 370: n71 (OpenAlex switched off)', 'Verified; year difference only', ['Miscited: volume wrong (372), year wrong, DOI supplied', 'ok']],
    ['PRISMA 2020 cited correctly as BMJ 2021, 372: n71 (OpenAlex switched off)', 'Verified', ['Verified (no false alarm)', 'ok']],
    ['Original audit set (test/audit-m1.js)', '26/27', ['27/27', 'ok']],
    ['Held-out set (test/audit-m1-hard.js)', '30/30', ['30/30', 'ok']],
    ['Real-world forms (test/audit-m1-real.js)', '28/28', ['28/28', 'ok']],
    ['Total', '84/85 (98.8%)', ['85/85 (100%)', 'ok']]
  ], [50, 22, 28]),
  gap(),
  p('A perfect score on 85 cases means the true error rate is below about 3.5% (95% confidence). Labelled references from real PJPS submissions would show whether it is below 1-2%.')
);

// ------------------------------------------------------------------ 3. Module 4
add(
  h1('3. Module 4: author retractions'),
  p('The author-retraction signal matches each manuscript author with Retraction Watch, which lists authors by name only. The 6 November report gave it as the main source of false alarms in Module 4: the HIGH signal on 6 of 54 (11%) ordinary papers. A benchmark script was written so the figures can be reproduced (scripts/benchmark-papermill-authors.js): the 109 benchmark papers whose full text names the authors and affiliations (55 retracted for paper-mill reasons, 54 ordinary papers of the same journals and years, each paper\'s own retraction left out), and a recall test on real repeat retractees (first authors with two or more paper-mill retractions; the "manuscript" gives the name and the institution of one, and the others must still give the HIGH signal). Its baseline reproduced the report exactly: 16/55 mill vs 6/54 ordinary.'),
  h2('3.1 Gaps found and fixed'),
  table(['Gap found', 'Effect before the fix', 'Fix'], [
    ['Two-letter surnames skipped', 'Li, Ma, Fu, Yu, Wu, Hu... (some of the most common surnames among authors) were never searched: an author named Wen Li with four paper-mill retractions was not found at all', ['Searched when a full first name is given (src/datasets.js, src/papermill/index.js)', 'ok']],
    ['First name and surname matched apart', 'The search accepted any paper with "Li" somewhere and "Wen" somewhere in its author list. For short names the 2,000-row limit filled with other people\'s papers before the right person\'s were reached', ['Both names must belong to the same author of the list ("Wen Li" or "Li Wen")', 'ok']],
    ['Initials taken as a first name', '"M. A. Khan" counted as a full first name (two letters), so initials-only matches could reach HIGH', ['Only a first word of two or more letters counts as a first name', 'ok']],
    ['Co-authors not used', 'Retraction Watch lists every author of a retracted paper, but only the one name was compared', ['Another manuscript author with the same full name on the same retracted paper confirms identity (HIGH)', 'ok']],
    ['Unrelated field', 'Biomedical authors matched retractions from engineering, business or mathematics departments', ['Such a match (every institution of the retracted paper outside biomedicine) is low: "probably a different person"', 'ok']],
    ['Generic institution words', '"Ministry of Education", "electronic", "mechanical", "Facultad de Ciencias de la Salud", Indian state and city names counted as the same institution', ['Added to the generic words; Indian states and cities treated like other cities', 'ok']]
  ], [22, 42, 36]),
  h2('3.2 Result'),
  table(['Measure', '6 Nov (baseline)', '7 Nov'], [
    ['Mill papers with the HIGH author signal (detection)', '16/55 (29%)', ['22/55 (40%)', 'ok']],
    ['Ordinary papers with the HIGH author signal (false alarms, upper bound)', '6/54 (11%)', ['5/54 (9%)', 'ok']],
    ['Half A of the set: mill / ordinary HIGH', '9/28 / 3/27', ['12/28 / 3/27', 'ok']],
    ['Half B of the set: mill / ordinary HIGH', '7/27 / 3/27', ['10/27 / 2/27', 'ok']],
    ['Real repeat retractees still HIGH, Pakistan', '34/37', ['33/37', 'warn']],
    ['Real repeat retractees still HIGH, China', '15/60', ['18/60', 'ok']],
    ['Medium author signal: mill / ordinary papers', '32/55 / 21/54', ['34/55 / 25/54', 'warn']],
    ['Planted mill manuscript (test/audit-m4.js)', '10/10 signals, HIGH', ['10/10 signals, HIGH', 'ok']]
  ], [52, 22, 26]),
  gap(),
  p('Of the 5 ordinary papers that still get the HIGH signal, 4 look like the same people: the retracted reviews of one share five co-authors with it, and the others share a distinctive institution (Universidad Arturo Prat, Madawalabu University, Amity / KIIT, Daping Hospital). Ordinary papers are open-access papers not in Retraction Watch, but their authors can have earlier retractions, so the false-alarm figure is an upper bound.'),
  h2('3.3 What got worse, and a rule that was tried and dropped'),
  bullet('Pakistan recall 34/37 -> 33/37: the lost case is Ying Wang (School of Mathematics and Information Science, Guangzhou University). A name this common needs two distinctive institution words; "mathematics" and "information" are now generic and Guangzhou is a city, so the match is low. Outside the PJPS field, but a real loss.'),
  bullet('The medium signal ("Author(s) with earlier retractions", weight 2) now fires on 25/54 ordinary papers (was 21/54), mostly authors with two-letter surnames who are searched for the first time. It still separates mill papers only weakly (62% vs 46%) and the evidence lists every match for the editor.'),
  bullet('Treating a shared city alone ("Lahore") as medium instead of HIGH was measured and dropped: it lost mill papers (22 -> 18) and Pakistani retractees (33 -> 31) for no gain in false alarms (5 either way). Institutions such as Government College University Faisalabad are named only with generic words and the city.'),
  bullet('This retractee sample is drawn differently from the one in the 6 November report (60 Pakistan, 48 China), so those figures are not comparable with these.')
);

// ------------------------------------------------------------------ 4. Module 3B and 5
add(
  h1('4. Module 3B and Module 5'),
  h2('4.1 Module 3B: source text when OpenAlex has no budget'),
  p('Claim support already reads the open-access full text where one exists (Europe PMC, Unpaywall, OpenAlex, CORE, Semantic Scholar, bioRxiv / medRxiv, arXiv) and falls back to the abstract. The abstract was asked of OpenAlex first, a paid service; Crossref, which carries the abstract many publishers deposit, and Semantic Scholar were not asked at all. The free sources now come first: Europe PMC, Crossref, then OpenAlex, CORE, Semantic Scholar and the preprint servers (src/tools/fulltext.js).'),
  bullet('Example with OpenAlex switched off: an MDPI Sustainability paper not in Europe PMC (10.3390/su12010001) now gets its abstract from Crossref; before, its claims were "Could not verify".'),
  bullet('test/audit-m3b.js gives the same verdicts as before (1 full, 3 unsupported, 3 could-not-verify by design: no source given); test/claim-match.js passes.'),
  bullet('The SciFact benchmark (72% of supported claims found, 38% of contradictions flagged) is unchanged: it gives the abstract to the matcher directly, so this fix does not affect it. It helps real manuscripts on days without OpenAlex budget.'),
  h2('4.2 Module 5: not started'),
  p('Partial duplicates (18/25 generated, 59% of real BioFors duplicates) and cloned areas (33% found vs 11% of clean images) need a new candidate stage and dense copy-move detection, measured again on BioFors (tens of thousands of image files on D:). The D: drive (USB disk) reset repeatedly during the morning: the Windows log recorded device resets every 50 seconds and "a corruption was discovered in the file system structure on volume D:" at 07:58, and read retries again at 08:39. The online scan found no errors, but a long image benchmark on that disk risked being killed part-way, as on 1 November, so this work was left for a stable drive. A full chkdsk D: /f is still advisable.')
);

// ------------------------------------------------------------------ 5. open gaps
add(
  h1('5. Gaps still open'),
  table(['Module', 'Gap', 'What closes it', 'Who'], [
    ['5. Images', 'Partial duplicates; cloned areas; spliced blots', 'Patch-level candidate stage; dense copy-move detection; BioFors re-run', 'Development (needs a stable D: drive)'],
    ['5. Images', 'Regression set of real Word / PDF manuscripts', 'Test files with figures in text boxes, charts, blots, micrographs', 'Development + PJPS files'],
    ['4. Paper Mill', 'Most mill papers not flagged from text and references (31%)', 'PJPS case decisions to tune weights; PubPeer key; STM Integrity Hub', 'PJPS'],
    ['4. Paper Mill', 'Identity of authors without co-author or institution evidence', 'Ask authors for ORCID iDs at submission (ORCID records are already matched exactly)', 'PJPS'],
    ['3B. Claim support', 'Abstract-only checks miss claims and contradictions', 'A 100-claim PJPS gold set checked by an editor', 'PJPS'],
    ['1. Bibliography', 'Regional journals no database indexes stay "Unverified"', 'PJPS list of regional journals and their archives', 'PJPS'],
    ['1, 3, 4, Similarity', 'OpenAlex daily budget (spent again during today\'s tests: "no daily budget left, not asked for 20 h")', 'Fund the OpenAlex key', 'PJPS'],
    ['Similarity', 'Open web only with a web-search key; paywalled full texts', 'BRAVE_API_KEY on Vercel; Crossref Similarity Check membership', 'PJPS'],
    ['2. Style', 'House rules not signed off', 'Editor sign-off; 100 accepted PJPS manuscripts', 'PJPS']
  ], [15, 33, 34, 18])
);

// ------------------------------------------------------------------ 6. tests
add(
  h1('6. Tests run on 7 November'),
  table(['Test', 'Result'], [
    ['npm test (35 programs)', ['35 of 35 passed. In the full run test/screening-embedded-images.js stopped on a dropped network connection (ECONNRESET); run on its own it passed', 'ok']],
    ['test/audit-m1.js, audit-m1-hard.js, audit-m1-real.js', ['27/27, 30/30, 28/28', 'ok']],
    ['test/audit-m4.js (planted mill manuscript, duplicates, access)', ['10/10 planted signals, HIGH; duplicates found; reviewer blocked', 'ok']],
    ['test/papermill-signals.js', ['46 checks passed', 'ok']],
    ['test/audit-m3b.js, test/claim-match.js', ['Same verdicts as before; 14 cases + language-model cases passed', 'ok']],
    ['scripts/benchmark-papermill-authors.js (new)', ['Section 3.2', 'ok']]
  ], [45, 55]),
  gap(),
  p([run('Conditions. ', { bold: true }), run('The office PC ran with the free OpenAlex allowance until it was spent during the tests; the PRISMA case was also tested with OpenAlex switched off. Brave and SerpApi keys exist only on the web portal and were not used. The tortured-phrase line of test/audit-m4.js samples 40 fingerprints at random on each run (35/40 today, 38/40 on 6 November); no change was made to that code.')]),
  h2('6.1 Files changed'),
  bullet('src/checks/reference.js: Europe PMC asked for the DOI when the matched record has no volume or pages'),
  bullet('src/datasets.js: Retraction Watch author search by full name within one author; two-letter surnames'),
  bullet('src/papermill/index.js: co-authors, initials, unrelated field, generic institution words, two-letter surnames'),
  bullet('src/tools/fulltext.js: abstract from Europe PMC, Crossref and Semantic Scholar; OpenAlex after the free sources'),
  bullet('scripts/benchmark-papermill-authors.js (new): author-signal benchmark and real-retractee recall'),
  bullet('docs/build-accuracy-report-2026-11-07.js (new): builds this report')
);

const doc = new Document({
  creator: 'Softsols Pakistan', title: 'PJPS Accuracy Fixes Report 2026-11-07',
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 30, bold: true, color: NAVY }, paragraph: { spacing: { before: 280, after: 140 }, keepNext: true, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 24, bold: true, color: NAVY }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true, outlineLevel: 1 } }
    ]
  },
  numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'PJPS Accuracy Fixes Report · 7 November 2026 · page ', font: FONT, size: 16, color: '7F7F7F' }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: '7F7F7F' })] })] }) },
    children
  }]
});

const out = process.argv[2] || path.join(__dirname, 'PJPS-Accuracy-Fixes-Report-2026-11-07.docx');
Packer.toBuffer(doc).then(b => { fs.writeFileSync(out, b); console.log('written', out, b.length, 'bytes'); });
