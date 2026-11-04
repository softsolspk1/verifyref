// docs/build-accuracy-report-2026-11-04.js - builds docs/PJPS-Accuracy-Audit-Report-2026-11-04.docx: measured accuracy of
// Modules 1-5 (re-audit of 4 November 2026) and how to raise it. Every figure comes from a ground-truth audit, a benchmark
// run or a read-only count of the live database on that date (logs in D:\pjps-tmp\audit-2026-11-04).
// Run: node docs/build-accuracy-report-2026-11-04.js [output.docx]
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, WidthType, ShadingType,
  BorderStyle, LevelFormat, Header, Footer, PageNumber, TableOfContents, PageBreak
} = require('docx');

const R = require('./accuracy-results-2026-11-04.json');

const FONT = 'Calibri';
const NAVY = '1F3864';
const PAGE_W = 11906, MARGIN = 1134, CONTENT = PAGE_W - 2 * MARGIN; // A4, 2 cm margins
const TONE = { ok: 'E2EFDA', warn: 'FFF2CC', bad: 'FCE4D6', na: 'EDEDED' };

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 21, bold: o.bold, italics: o.italics, color: o.color });
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after ?? 120, line: 276 }, alignment: o.align, keepNext: o.keepNext, children: Array.isArray(text) ? text : [run(text, o)] });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t })] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t })] });
const bullet = (text, level = 0) => new Paragraph({ numbering: { reference: 'bullets', level }, spacing: { after: 60, line: 264 }, children: Array.isArray(text) ? text : [run(text)] });
const rich = parts => parts.map(x => (typeof x === 'string' ? run(x) : run(x[0], x[1])));

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
const pct = (a, b) => `${Math.round(a / b * 1000) / 10}%`;

const children = [];
const add = (...x) => children.push(...x);
const m4 = R.m4, m5 = R.m5;

// ------------------------------------------------------------------ cover and contents
add(
  p('', { after: 1800 }),
  p([run('PJPS Data Integrity System', { size: 44, bold: true, color: NAVY })], { align: AlignmentType.CENTER }),
  p([run('Accuracy Audit Report: Modules 1 to 5', { size: 34, color: NAVY })], { align: AlignmentType.CENTER, after: 400 }),
  p([run('Measured accuracy of each module and how to increase it', { size: 24 })], { align: AlignmentType.CENTER }),
  p([run('Pakistan Journal of Pharmaceutical Sciences', { size: 24 })], { align: AlignmentType.CENTER, after: 1200 }),
  p([run('Audit date: 4 November 2026', { size: 22 })], { align: AlignmentType.CENTER }),
  p([run(`System version: ${R.version} (web portal; the Windows desktop application uses the same code)`, { size: 22 })], { align: AlignmentType.CENTER }),
  p([run('Prepared by Softsols Pakistan', { size: 22 })], { align: AlignmentType.CENTER }),
  new Paragraph({ children: [new PageBreak()] }),
  p([run('Contents', { size: 30, bold: true, color: NAVY })], { after: 140 }),
  new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),
  p([run('Right-click the table and choose Update Field to refresh the page numbers.', { italics: true, size: 18, color: '7F7F7F' })]),
  new Paragraph({ children: [new PageBreak()] })
);

// ------------------------------------------------------------------ 1. summary
add(
  h1('1. Summary'),
  p('All five modules were audited again on 4 November 2026. Each module was measured in two ways: ground-truth audits, where test cases with a known correct answer are run through the live system and its real databases, and benchmarks built from published datasets (retracted papers, expert-annotated images, expert-labelled scientific claims). The table gives the headline figure of each module; sections 3 to 7 give the details and section 9 how to raise each figure.'),
  table(['Module', 'Accuracy measured', 'Rating', 'Main limit'], [
    ['1. Check Bibliography', `57 of 57 references judged correctly (100%) on two ground-truth sets: 27 mixed + 30 held-out (genuine, miscited, invented, wrong DOI, retracted, regional)`, ['Very high', 'ok'], 'Regional journals not in any database stay "Unverified" (by design); tested on 57 cases only'],
    ['2. Reference Style & PJPS Converter', '14 of 14 style deviations found with 0 false alarms; 6 of 6 in-text rules; conversion correct from 7 of 7 source styles; Track Changes output works', ['Very high', 'ok'], 'PJPS house style still needs the editor\'s written sign-off; small test set'],
    ['3A. Citations: list consistency', 'Every planted problem found: missing, uncited, year mismatch, ambiguous, wrong "et al.", numbering', ['Very high', 'ok'], 'Planted cases only'],
    ['3B. Citations: claim support', `Ground truth: 13 of 13 verdicts as expected (incl. 6 of 6 on a real PDF). SciFact (340 held-out expert-labelled pairs, abstract only): ${R.m3.dev.found}% of supported claims found; ${R.m3.dev.contraAsFull}% of contradicted claims pass as "Full support"; ${R.m3.dev.neiAsFull}% of no-evidence claims pass as Full`, ['Moderate', 'warn'], 'Word-based matcher: misses reworded support and most contradictions'],
    ['4. Paper Mill Detection', `Planted mill manuscript: 10 of 10 signals found, HIGH; clean manuscript LOW. Benchmark (150 real mill papers vs 126 ordinary, text-based signals): ${m4.withLook.mill}/150 (${pct(m4.withLook.mill, 150)}) flagged MEDIUM+ with ${m4.withLook.ctrl}/126 (${pct(m4.withLook.ctrl, 126)}) false alarms`, ['Screening aid', 'warn'], 'Most mill papers read cleanly; reference, author and image signals add detection not counted in the text benchmark'],
    ['5. Image Integrity', `${m5.rsiidLine}. BioFors (expert-annotated real figures): duplicated panels ${m5.edd}; cloned areas ${m5.idd}; ${m5.neg}`, ['Good on copies,\nweak on edits', 'warn'], 'Cloned areas and splicing are hard; reference databases still filling'],
    ['Full Screening Report', R.full.line, [R.full.ok ? 'Works' : 'See section 8', R.full.ok ? 'ok' : 'warn'], 'Depends on the modules above']
  ], [17, 41, 12, 30]),
  gap(),
  p([run('What "accuracy" means here. ', { bold: true }), run('For Modules 1 to 3 the test cases have one correct answer, so accuracy is the share answered correctly. Modules 4 and 5 are screening aids: they are measured by detection (the share of real problems flagged) and false alarms (the share of clean papers or images flagged). No paper-mill or image tool, commercial or in-house, detects everything; ImageTwin states 80 to 90% detection for its own scope.')]),
  p([run('Changes since the 30 October audit. ', { bold: true }), run(`Module 4 now compares each manuscript's title and abstract with 13,447 papers retracted for paper-mill reasons, which raised benchmark detection from 24 to ${m4.withLook.mill} of 150 mill papers (false alarms 2 to ${m4.withLook.ctrl} of 126), and checks the cover letter, waves of similar submissions and the journal scope. Module 1 now reformats every reference in the style the editor chooses.`)])
);

// ------------------------------------------------------------------ 2. method
add(
  h1('2. How the audit was done'),
  table(['Step', 'What was done on 4 November 2026'], [
    ['Ground-truth audits (live)', 'test/audit-m1.js, audit-m1-hard.js, audit-m23.js, audit-m3b.js, audit-m3c.js, audit-m4.js and audit-full.js run the web edition with its real databases over the internet on cases whose correct answer is known in advance.'],
    ['Module 3.B benchmark', 'SciFact (Wadden et al., EMNLP 2020): expert-written claims with the abstract they cite, labelled SUPPORT, CONTRADICT or NOT ENOUGH INFO. The dev split (340 pairs) was never used for tuning.'],
    ['Module 4 benchmark', '150 papers retracted for paper-mill reasons (Retraction Watch) against 126 ordinary papers from the same journals and years (Europe PMC). Thresholds are set on one half (even PMC numbers) and checked on the other.'],
    ['Module 5 benchmarks', 'RSIID scientific figures with generated copies and copy-moves; BioFors (Sabir et al., ICCV 2021): 47,805 real figure panels with expert annotations of duplication, cloning and splicing.'],
    ['Automated test suite', 'npm test (31 test programs, offline). All passed on 4 November 2026.'],
    ['Data stores', 'Read-only counts of the live database (section 10).']
  ], [24, 76]),
  gap(),
  p([run('Note. ', { bold: true }), run(R.note)])
);

// ------------------------------------------------------------------ 3. Module 1
add(
  h1('3. Module 1: Check Bibliography'),
  p('Every reference is searched in 13 scholarly databases (Crossref, DOI registry, DataCite, OpenAlex, PubMed, Europe PMC, Semantic Scholar, arXiv, DBLP, Open Library, Google Books, ERIC, CORE) and Retraction Watch (64,429 notices).'),
  h2('3.1 Ground-truth results'),
  table(['Test set', 'Cases', 'Correct', 'Accuracy'], [
    ['Original audit set: genuine, miscited, fabricated, wrong DOI, inserted words, retracted, regional, duplicate', '27', '27', ['100%', 'ok']],
    ['Held-out set: genuine (12), title typo, book, report, wrong details (7), wrong DOI, invented (4), retracted (3)', '30', '30', ['100%', 'ok']],
    ['Total', '57', '57', ['100%', 'ok']]
  ], [58, 12, 12, 18]),
  gap(),
  table(['Verdict', 'Result on the 27-reference set'], [
    ['Verified', '13 (confidence 89-100)'],
    ['Miscited (real work, details wrong)', '6: wrong year, volume, pages, journal or DOI; inserted words in the title found'],
    ['Suspicious (possibly fabricated)', '4 of 4 invented references, including a DOI that does not exist'],
    ['Retracted', '2 of 2, with retraction date and reason'],
    ['Unverified (regional journals not indexed)', '2 Pakistani journal references: never called Suspicious'],
    ['Exports', 'CSV, BibTeX, RIS, Word report and corrected list all produced (HTTP 200)']
  ], [35, 65]),
  gap(),
  h2('3.2 Limits'),
  bullet('57 test references are enough to show the engine works on every case type, not to give a precise error rate: with 57 of 57 correct, the true error rate is below about 5% with 95% confidence.'),
  bullet('A real reference in a journal that no database indexes (many regional journals) cannot be confirmed; it is shown as "Unverified, check manually", never as fabricated.'),
  bullet('The databases are free public APIs; when one is slow or rate-limited the reference is retried, and an unanswered database is shown as not checked.')
);

// ------------------------------------------------------------------ 4. Module 2
add(
  h1('4. Module 2: Reference Style Check and PJPS Converter'),
  table(['Check', 'Cases', 'Result'], [
    ['Style compliance, rule by rule (authors, title, journal abbreviation, volume/issue/pages, year, missing fields)', '14 references with known deviations', ['14 of 14 correct; 0 false alarms; 0 missed', 'ok']],
    ['List order and a/b suffixes', '2 rules', ['Both found', 'ok']],
    ['In-text citation format: comma, "and", "et al.", semicolons, author count', '6 rules', ['6 of 6 found', 'ok']],
    ['Conversion to PJPS from APA, Vancouver, Harvard, IEEE, AMA, Chicago, Nature', '7 source styles', ['7 of 7 correct (Nature input has no issue number, so none is invented)', 'ok']],
    ['Word file: numbered citations to author-year, list re-sorted, Track Changes', '1 manuscript, 4 citations', ['4 of 4 converted; 19 insertions / 7 deletions tracked; layout kept', 'ok']],
    ['Earlier style-error test (test/style-errors.js)', '32 cases', ['32 of 32', 'ok']]
  ], [48, 20, 32]),
  gap(),
  bullet('The PJPS house style rules pass the official PJPS examples; the specification asks for the editor\'s written confirmation before release.'),
  bullet('A missing full stop after the title is only reported when Module 1 matched the reference (the record shows where the title ends).')
);

// ------------------------------------------------------------------ 5. Module 3
add(
  h1('5. Module 3: Citations'),
  h2('5.1 Citation and reference list consistency (3.A)'),
  table(['Planted problem', 'Found'], [
    ['Cited in the text but missing from the list (Noor 2021, Zubair 2020, Malik 2022)', ['3 of 3', 'ok']],
    ['In the list but never cited', ['1 of 1', 'ok']],
    ['Year mismatch (2018 in the text, 2019 in the list)', ['1 of 1', 'ok']],
    ['Ambiguous author-year citation (Ali 2020 with two candidates)', ['1 of 1', 'ok']],
    ['"et al." used for a two-author work', ['1 of 1', 'ok']],
    ['Numbered style: number pointing to nothing, uncited numbers, order problem', ['All found', 'ok']],
    ['Citations inside tables and footnotes', ['Included', 'ok']]
  ], [75, 25]),
  gap(),
  h2('5.2 Claim and source verification (3.B)'),
  table(['Test', 'Result'], [
    ['Real uploaded PDF (arXiv 1706.03762) and open full text: 6 claims with known verdicts', ['6 of 6 correct, with page numbers', 'ok']],
    ['Generated source PDFs: 7 claims (supported, opposite direction, wrong figure, source not available, retracted evidence, invented work)', ['7 of 7 as expected; retracted evidence flagged; "could not verify" when no source is available', 'ok']],
    ['Citation pattern flags (3.C): self-citation, stacking, author concentration, off-topic, citation blocks', ['All 6 planted patterns flagged', 'ok']]
  ], [55, 45]),
  gap(),
  p([run('SciFact benchmark (expert-labelled, abstract only)', { bold: true })], { keepNext: true }),
  table(['', 'Held-out dev split (340 pairs)', 'Train split (919 pairs)'], [
    ['Supported claims found (Full or Partial support)', [`${R.m3.dev.found}%`, 'warn'], `${R.m3.train.found}%`],
    ['Supported claims judged "Full support"', `${R.m3.dev.full}%`, `${R.m3.train.full}%`],
    ['Contradicted claims passed as "Full support"', [`${R.m3.dev.contraAsFull}%`, 'warn'], `${R.m3.train.contraAsFull}%`],
    ['Contradicted claims flagged as contradicted', [`${R.m3.dev.contraFlagged}%`, 'bad'], `${R.m3.train.contraFlagged}%`],
    ['No-evidence claims passed as "Full support"', [`${R.m3.dev.neiAsFull}%`, 'ok'], `${R.m3.train.neiAsFull}%`]
  ], [50, 25, 25]),
  gap(),
  bullet('The matcher is cautious: it rarely calls an unsupported claim "Full support" (2%), so a "Full" verdict can be trusted.'),
  bullet('Its weakness is meaning: reworded support and contradictions written in different words are missed. The SciFact figures use the abstract only; with the uploaded PDF or open full text more support is found.')
);

// ------------------------------------------------------------------ 6. Module 4
add(
  h1('6. Module 4: Paper Mill Detection'),
  h2('6.1 Ground-truth audit'),
  table(['Test', 'Result'], [
    ['Clean control manuscript', ['LOW, score 0', 'ok']],
    ['Planted mill manuscript', ['HIGH, score 28 (3 strong signals)', 'ok']],
    ['Planted signals found: tortured phrases, AI leftovers, template wording, vague methods, hidden text, cell lines, fabricated references, free-mail, no ORCID, author mill retraction', ['10 of 10', 'ok']],
    ['Tortured phrases', ['39 of 40 found; 0 false alarms on the correct terms', 'ok']],
    ['Exact resubmission, and resubmission after small edits', ['Both detected', 'ok']],
    ['Authors changed between versions', ['Detected', 'ok']],
    ['Reviewer role blocked from Module 4 and its confidential export', ['Blocked (403 / 404)', 'ok']]
  ], [65, 35]),
  gap(),
  h2('6.2 Benchmark on real paper-mill papers'),
  p(`150 papers retracted for paper-mill reasons against 126 ordinary papers from the same journals and years. "Flagged" means risk MEDIUM or HIGH.`),
  table(['Signals scored', 'Mill papers flagged (detection)', 'Ordinary papers flagged (false alarms)'], [
    ['Text signals only (30 Oct state)', `${m4.text.mill}/150 (${pct(m4.text.mill, 150)})`, `${m4.text.ctrl}/126 (${pct(m4.text.ctrl, 126)})`],
    ['Text + title/abstract look-alikes of known mill papers (new)', [`${m4.withLook.mill}/150 (${pct(m4.withLook.mill, 150)})`, 'warn'], [`${m4.withLook.ctrl}/126 (${pct(m4.withLook.ctrl, 126)})`, 'ok']],
    ['Flagged HIGH, text signals', `${m4.text.high}/150`, '0/126']
  ], [46, 27, 27]),
  gap(),
  table(['Single signal on the benchmark', 'Mill papers', 'Ordinary papers'], m4.signals.map(s => [s[0], s[1], s[2]]), [56, 22, 22]),
  gap(),
  bullet('Precision depends on how common mill papers are. With 2% of submissions from mills and the rates above, about 1 in 6 flagged manuscripts would truly be a mill paper: the flag says "look closer", it is not a finding.'),
  bullet('The look-alike signal finds new output of mills whose papers have already been retracted. Counting only retractions dated before each benchmark paper appeared, its separation nearly disappears: it does not find a brand-new mill.'),
  bullet('Not measurable on published papers: cover letter, waves of submissions, suggested reviewers, ORCID records and authorship changes. They are tested with planted cases only.')
);

// ------------------------------------------------------------------ 7. Module 5
add(
  h1('7. Module 5: Image Integrity'),
  p(m5.intro),
  table(['Benchmark', 'Task', 'Result'], m5.rows.map(r => [r[0], r[1], [r[2], r[3]]]), [22, 40, 38]),
  gap(),
  bullet('Whole-image copies, including rotated, mirrored, resized and re-compressed ones, are found reliably; no false alarms were raised on thousands of pairs of unrelated figures.'),
  bullet('Partial overlaps, cloned areas inside one image and spliced blots are the weak points: many annotated cases never become candidates in the matching stage.'),
  bullet('By PJPS decision figures never leave the PJPS system, so the 155-160 million figure databases of Proofig and ImageTwin are not searched and AI-generated images are judged on file markers and statistics only.')
);

// ------------------------------------------------------------------ 8. Full Screening
add(
  h1('8. Full Screening Report'),
  p(R.full.text)
);

// ------------------------------------------------------------------ 9. recommendations
add(
  h1('9. How to increase accuracy'),
  p('The recommendations are ordered by expected gain within each module. "Needs" names what is required beyond programming: a key, a contract, a PJPS decision or editor time.'),
  ...R.recommendations.flatMap(m => [
    h2(m.module),
    table(['Recommendation', 'Expected gain', 'Needs', 'Priority'], m.items.map(i => [i[0], i[1], i[2], [i[3], i[3] === 'High' ? 'bad' : i[3] === 'Medium' ? 'warn' : 'ok']]), [44, 26, 18, 12]),
    gap()
  ]),
  h2('All modules'),
  ...R.general.map(g => bullet(rich(g)))
);

// ------------------------------------------------------------------ 10. data
add(
  h1('10. Data behind the checks (live database, 4 November 2026)'),
  table(['Data store', 'Size', 'Used by'], R.data, [40, 30, 30])
);

// ------------------------------------------------------------------ 11. reproducing
add(
  h1('11. Reproducing these results'),
  table(['Command', 'What it measures'], [
    ['npm test', 'Full automated test suite (offline)'],
    ['node test/audit-m1.js; node test/audit-m1-hard.js', 'Module 1 on 27 + 30 known references (internet)'],
    ['node test/audit-m23.js', 'Module 2 compliance and conversion; Module 3.A'],
    ['node test/audit-m3b.js; node test/audit-m3c.js', 'Module 3.B claim support and 3.C patterns'],
    ['node scripts/benchmark-claims.js --split dev', 'Module 3.B on SciFact'],
    ['node test/audit-m4.js', 'Module 4 planted signals'],
    ['node scripts/benchmark-papermill.js 150 --rescore; node scripts/benchmark-papermill-lookalike.js', 'Module 4 on real mill papers'],
    ['node scripts/benchmark-public-images.mjs 60; node scripts/benchmark-images.mjs --task all --docs 60 --neg 300', 'Module 5 on RSIID and BioFors'],
    ['node test/audit-full.js', 'Full Screening Report end to end']
  ], [55, 45])
);

// ------------------------------------------------------------------ document
const doc = new Document({
  creator: 'Softsols Pakistan',
  title: 'PJPS Data Integrity System - Accuracy Audit Report Modules 1-5 (4 November 2026)',
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 30, bold: true, color: NAVY }, paragraph: { spacing: { before: 240, after: 140 }, keepNext: true, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 25, bold: true, color: NAVY }, paragraph: { spacing: { before: 200, after: 100 }, keepNext: true, outlineLevel: 1 } }
    ]
  },
  numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }, { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 270 } } } }] }] },
  features: { updateFields: true },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } }, titlePage: true },
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'PJPS Data Integrity System · Accuracy Audit Report Modules 1-5 · 4 November 2026', font: FONT, size: 16, color: '7F7F7F' })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: '7F7F7F' })] })] }) },
    children
  }]
});

const out = process.argv[2] || path.join(__dirname, 'PJPS-Accuracy-Audit-Report-2026-11-04.docx');
Packer.toBuffer(doc).then(buf => { fs.writeFileSync(out, buf); console.log(`Written ${out} (${buf.length} bytes)`); });
