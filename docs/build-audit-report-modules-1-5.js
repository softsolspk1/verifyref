// docs/build-audit-report-modules-1-5.js - builds docs/PJPS-Audit-Report-Modules-1-5.docx: completion, accuracy and
// datasets of Modules 1-5 (audit of 30 October 2026). Every figure comes from a test or benchmark run, a dataset file or
// a read-only count of the live database on that date. Run: node docs/build-audit-report-modules-1-5.js
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, WidthType, ShadingType,
  BorderStyle, LevelFormat, Header, Footer, PageNumber, TableOfContents, PageBreak
} = require('docx');

const FONT = 'Calibri';
const NAVY = '1F3864';
const GREY = 'F2F2F2';
const PAGE_W = 11906, MARGIN = 1134, CONTENT = PAGE_W - 2 * MARGIN; // A4, 2 cm margins
const TONE = { ok: 'E2EFDA', warn: 'FFF2CC', bad: 'FCE4D6', na: 'EDEDED' };

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 21, bold: o.bold, italics: o.italics, color: o.color });
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after ?? 120, line: 276 }, alignment: o.align, children: Array.isArray(text) ? text : [run(text, o)] });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 140 }, children: [new TextRun({ text: t, font: FONT, size: 30, bold: true, color: NAVY })] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 }, children: [new TextRun({ text: t, font: FONT, size: 25, bold: true, color: NAVY })] });
const bullet = (text, level = 0) => new Paragraph({ numbering: { reference: 'bullets', level }, spacing: { after: 60, line: 264 }, children: Array.isArray(text) ? text : [run(text)] });
const rich = parts => parts.map(x => (typeof x === 'string' ? run(x) : run(x[0], x[1])));

const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const borders = { top: border, bottom: border, left: border, right: border };

/** Table with dual widths (columnWidths + every cell), header row shaded; rows may carry a tone per cell: [text, tone] */
function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = CONTENT / total;
  const w = widths.map(x => Math.round(x * scale));
  w[w.length - 1] += CONTENT - w.reduce((a, b) => a + b, 0);
  const cell = (content, i, header, tone) => new TableCell({
    width: { size: w[i], type: WidthType.DXA }, borders, margins: { top: 60, bottom: 60, left: 90, right: 90 },
    shading: header ? { fill: NAVY, type: ShadingType.CLEAR, color: 'auto' } : tone ? { fill: TONE[tone], type: ShadingType.CLEAR, color: 'auto' } : undefined,
    children: String(content).split('\n').map(line => new Paragraph({ spacing: { after: 0, line: 252 }, children: [new TextRun({ text: line, font: FONT, size: header ? 19 : 18, bold: header, color: header ? 'FFFFFF' : undefined })] }))
  });
  return new Table({
    width: { size: CONTENT, type: WidthType.DXA }, columnWidths: w,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((t, i) => cell(t, i, true)) }),
      ...rows.map(r => new TableRow({ children: r.map((c, i) => (Array.isArray(c) ? cell(c[0], i, false, c[1]) : cell(c, i, false))) }))
    ]
  });
}
const gap = () => p('', { after: 60 });

// ------------------------------------------------------------------ content

const DONE = ['Complete', 'ok'];
const children = [];
const add = (...x) => children.push(...x);

// Cover
add(
  p('', { after: 1800 }),
  p([run('PJPS Data Integrity System', { size: 44, bold: true, color: NAVY })], { align: AlignmentType.CENTER }),
  p([run('Audit Report: Modules 1 to 5', { size: 34, color: NAVY })], { align: AlignmentType.CENTER, after: 400 }),
  p([run('Completion, measured accuracy and datasets', { size: 24 })], { align: AlignmentType.CENTER }),
  p([run('Pakistan Journal of Pharmaceutical Sciences', { size: 24 })], { align: AlignmentType.CENTER, after: 1200 }),
  p([run('Audit date: 30 October 2026', { size: 22 })], { align: AlignmentType.CENTER }),
  p([run('System version: 3.2.1 (web portal and Windows desktop application)', { size: 22 })], { align: AlignmentType.CENTER }),
  p([run('Prepared by Softsols Pakistan', { size: 22 })], { align: AlignmentType.CENTER }),
  new Paragraph({ children: [new PageBreak()] }),
  p([run('Contents', { size: 30, bold: true, color: NAVY })], { after: 140 }),
  new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),
  p([run('Right-click the table and choose Update Field to refresh the page numbers.', { italics: true, size: 18, color: '7F7F7F' })]),
  new Paragraph({ children: [new PageBreak()] })
);

// 1. Executive summary
add(
  h1('1. Executive summary'),
  p('All five modules and the Full Screening Report are built against the PJPS specification (PJPS-Final-5-Modules.txt) and run in both the web portal and the Windows desktop application. Accuracy was measured on 30 October 2026 with ground-truth audits, in which test cases with known correct answers are run through the live system and its real databases, and with benchmarks built from real retracted papers and published image-integrity datasets.'),
  table(['Module', 'Completion', 'Measured accuracy (30 Oct 2026)', 'Data'], [
    ['1. Check Bibliography', DONE, ['27 of 27 references judged correctly (genuine, miscited, fabricated, retracted, regional)', 'ok'], '13 live scholarly databases, Retraction Watch (64,429)'],
    ['2. Reference Style & PJPS Converter', DONE, ['14 of 14 compliance cases; 6 of 6 in-text rules; exact conversion from 6 of 7 styles', 'ok'], 'NLM Catalog (42,146 journals), LTWA'],
    ['3. Citations', DONE, ['All planted citation errors found; 7 of 7 claim verdicts as expected', 'ok'], 'Uploaded PDFs, Europe PMC, Unpaywall, OpenAlex, CORE'],
    ['4. Paper Mill Detection', DONE, ['Strongest single signals: 16 of 150 mill papers vs 3 of 126 ordinary; text signals alone 7 of 150 vs 2 of 126', 'warn'], 'Retraction Watch, Problematic Paper Screener (8,993), ICLAC, Cellosaurus, ORCID'],
    ['5. Image Integrity', ['Complete (in-house only)', 'ok'], ['Whole / rotated / mirrored copies 100%; crops 72%; cloned areas 64%; 0 false alarms in 20 clean images; weaker on BioFors', 'warn'], 'PJPS image databases: 11,129 papers, 111,651 panels indexed'],
    ['Full Screening Report', DONE, ['Demonstration manuscript: all modules, recommendation "investigate", in 64 s', 'ok'], 'All of the above']
  ], [20, 13, 40, 27]),
  gap(),
  p([run('Main conclusions', { bold: true })]),
  bullet('Modules 1, 2 and 3 were correct on every ground-truth test case after the fixes made during this audit (section 9).'),
  bullet('Module 4 and Module 5 are screening aids. Every signal is built on a real dataset and shown with its evidence, but no detector catches every problem: the figures in sections 6 and 7 show what each one finds and misses.'),
  bullet('By PJPS decision, figures are checked inside the PJPS system only and are never sent to ImageTwin, Proofig or any other outside service.'),
  bullet('Two data stores are still filling (section 10): the image reference databases are partly indexed, and the store of earlier PJPS submissions holds very few manuscripts because the system has only just gone into use.'),
  p([run('A note on "100% authentic". ', { bold: true }), run('Authentic here means that every check uses real, named data sources and that every flag shows the evidence behind it. It does not mean 100% detection: no reference, paper-mill or image detector, commercial or in-house, can catch every problem without false alarms. The results point the editor to what to check; the editor decides.')])
);

// 2. Method
add(
  h1('2. How the audit was done'),
  table(['Step', 'What was done'], [
    ['Feature check', 'Every item of the specification for each module was located in the code and exercised.'],
    ['Ground-truth audits', 'test/audit-m1.js, audit-m1b.js, audit-m23.js, audit-m3b.js and audit-full.js run the live engine (real databases over the internet) on cases whose correct answer is known in advance.'],
    ['Benchmarks', 'Module 4: 150 papers retracted for paper-mill reasons (Retraction Watch) against 126 ordinary papers from the same journals and years (Europe PMC). Module 5: forgeries generated from RSIID scientific figures, and the BioFors expert-annotated dataset (ICCV 2021).'],
    ['Automated test suite', 'npm test: 13 test programs (offline, in-memory database), including regression checks for every defect fixed in this audit. All passed on 30 October 2026 (the desktop test on a second run: its internet check timed out once while Crossref was slow).'],
    ['Datasets', 'Record counts read from the dataset files and, read-only, from the live platform database on 30 October 2026.']
  ], [22, 78])
);

// 3. Module 1
add(
  h1('3. Module 1: Check Bibliography'),
  p('Purpose: confirm that every reference is real, correctly cited and not retracted.'),
  h2('3.1 Completion'),
  table(['Specification item', 'Status'], [
    ['1.1 Upload or paste; .bib / .ris import; edit list; clean garbled PDF text', DONE],
    ['1.2 Verification in Crossref, DOI registry, DataCite, OpenAlex, PubMed, Europe PMC, Semantic Scholar, arXiv, DBLP, Open Library, Google Books, ERIC (plus CORE; Google Scholar as last resort)', DONE],
    ['1.3 Verdict, 0-100 confidence, differing fields, corrected PJPS reference, link', DONE],
    ['1.4 Fabrication checks (DOI / PMID / arXiv, wrong journal, inserted words, regional journals "Not indexed")', DONE],
    ['1.5 Retraction Watch: retraction, concern, correction; later-retraction monitoring', DONE],
    ['1.6 Link check, kept separate from the verdict', DONE],
    ['1.7 Reference-age chart and PJPS rule', DONE],
    ['1.8 Self-citation, PJPS citations, predatory / hijacked journals, duplicates', DONE],
    ['1.9 Summary, filter, Word / PDF / CSV / BibTeX / RIS / corrected list, Re-check', DONE]
  ], [80, 20]),
  h2('3.2 Measured accuracy (test/audit-m1.js, 27 references, 75 seconds)'),
  table(['Case type', 'Cases', 'Correct', 'Result'], [
    ['Genuine, correctly cited', '11', ['11', 'ok'], 'Verified, confidence 95-100'],
    ['Genuine, DOI with text appended', '1', ['1', 'ok'], 'DOI repaired, Verified'],
    ['Real paper, wrong year / volume / pages', '4', ['4', 'ok'], 'Miscited, with the wrong field named'],
    ['Fabricated reference', '4', ['4', 'ok'], 'Suspicious, with the reason'],
    ['Real title with invented words', '1', ['1', 'ok'], 'Miscited, inserted words listed'],
    ['DOI of a different paper', '1', ['1', 'ok'], 'Miscited'],
    ['Retracted (Wakefield 1998, Seralini 2012)', '2', ['2', 'ok'], 'Retracted'],
    ['Pakistani regional journal', '2', ['2', 'ok'], 'Not indexed / Unverified, never Suspicious'],
    ['Same work in another format', '1', ['1', 'ok'], 'Verified'],
    ['Total', '27', ['27 (100%)', 'ok'], 'Before the audit fixes: 25 of 27']
  ], [36, 10, 14, 40]),
  gap(),
  p('Further checks (test/audit-m1b.js): .bib and .ris import read correctly; four garbled PDF references parsed correctly; 50% self-citation detected on a planted case; all five exports (CSV, BibTeX, RIS, Word, corrected list) produced; Re-check runs and shows changes only.'),
  p([run('Limits: ', { bold: true }), run('a reference in a journal that no database covers can only be marked "Not indexed", not verified. Results depend on the external databases being reachable; when a source is down, the saved copy is used (for example, Retraction Watch on 30 October) and unreachable lookups are retried.')])
);

// 4. Module 2
add(
  h1('4. Module 2: Reference Style & PJPS Converter'),
  h2('4.1 Completion'),
  table(['Specification item', 'Status'], [
    ['2.1 Rule-by-rule PJPS compliance: authors, et al., year, title, journal abbreviation, volume(issue): pages, missing fields, order, a/b suffixes, % score', DONE],
    ['2.1 In-text citations: comma, et al., "and", semicolons, chronological order', DONE],
    ['2.2 Conversion to PJPS from any of 23 styles, in-text and list; numbered to (Author, Year), list re-sorted', DONE],
    ['2.2 Missing fields filled from the matched record; unmatched entries flagged, never silently changed', DONE],
    ['2.3 Before / after view, Word Track Changes, download, change report', DONE]
  ], [80, 20]),
  h2('4.2 Measured accuracy (test/audit-m23.js, test/pjps-style.js)'),
  table(['Test', 'Result'], [
    ['Compliance of 14 references with planted errors', ['14 of 14 correct; 0 false alarms; 0 missed', 'ok']],
    ['Order and a/b suffix rules', ['Both detected', 'ok']],
    ['In-text citation rules (6 planted errors)', ['6 of 6 found, expected form shown', 'ok']],
    ['Conversion to PJPS from APA, Vancouver, Harvard, IEEE, AMA, Chicago', ['6 of 6 exact', 'ok']],
    ['Conversion from Nature style', ['Correct except the issue number, which the Nature form does not contain (filled only with the online lookup)', 'warn']],
    ['Word output with Track Changes', ['4 citations converted; 19 insertions and 7 deletions tracked; rest of sentence untouched', 'ok']],
    ['Official examples in the PJPS Instructions for Authors', ['3 of 3 read, formatted and judged compliant exactly as printed', 'ok']]
  ], [45, 55])
);

// 5. Module 3
add(
  h1('5. Module 3: Citations'),
  h2('5.1 Completion'),
  table(['Specification item', 'Status'], [
    ['3.A Citation and list consistency: missing, uncited, year, spelling, ambiguous, et al., numbering; tables, captions, footnotes', DONE],
    ['3.B Claim vs source: uploaded PDF (with page), open-access full text (Europe PMC, Unpaywall, OpenAlex, CORE), abstract; runs locally, no outside AI', DONE],
    ['3.C Citation pattern: self-citation, stacking, citation blocks', DONE],
    ['3.D Combined report, Word / PDF / CSV, author letter in English and Urdu', DONE]
  ], [80, 20]),
  h2('5.2 Measured accuracy (test/audit-m23.js, test/audit-m3b.js)'),
  table(['Test', 'Result'], [
    ['3.A planted problems: 3 missing, 1 uncited, 1 year mismatch, 1 spelling, 1 ambiguous (2020a/b), 1 wrong "et al."', ['All 8 found', 'ok']],
    ['3.A numbered style: missing, uncited, out-of-order numbers', ['All found', 'ok']],
    ['3.B claim supported by the uploaded source PDF', ['Full support, page 1 quoted', 'ok']],
    ['3.B claim the source contradicts ("no activity was observed")', ['Unsupported, contradiction noted', 'ok']],
    ['3.B claim with a figure not in the source (40%)', ['Unsupported, missing figure named', 'ok']],
    ['3.B claims whose source was not available', ['Could not verify (correct)', 'ok']],
    ['3.B citing the retracted Wakefield paper as evidence', ['Unsupported and Retracted', 'ok']],
    ['3.C planted self-citation, stacking and blocks', ['6 pattern flags raised as expected', 'ok']],
    ['3.D author letter and exports', ['Produced', 'ok']]
  ], [62, 38]),
  p([run('Limits: ', { bold: true }), run('claim support compares wording, figures and direction of effect; it does not understand the science. When only the abstract is available the report says so, and a claim unsupported by the abstract may still be supported by the full text.')])
);

// 6. Module 4
add(
  h1('6. Module 4: Paper Mill Detection'),
  p('Purpose: point the editor to signs that a manuscript came from a paper mill. Output: LOW / MEDIUM / HIGH with the evidence for every signal. Confidential; it never rejects a paper by itself.'),
  h2('6.1 Completion'),
  table(['Specification item', 'Status', 'Data source'], [
    ['4.1 Tortured phrases', DONE, 'Problematic Paper Screener (Cabanac et al.) + PJPS list'],
    ['4.1 Template wording, AI-text leftovers, vague methods, hidden characters', DONE, 'Built-in rules'],
    ['4.2 Fabricated references; citations to papers retracted for paper-mill reasons', DONE, 'Module 1; Retraction Watch'],
    ['4.2 Predatory / hijacked journals; journals with many paper-mill retractions', DONE, 'Beall list; Retraction Watch (84 journals with 20+)'],
    ['4.2 Citation stacking', DONE, 'Module 3.C'],
    ['4.3 Author retractions by name and by ORCID (exact DOI)', DONE, 'Retraction Watch; ORCID registry'],
    ['4.3 Free-mail / disposable e-mail, ORCID checks, affiliations, authorship changes, suggested reviewers', DONE, 'E-mail domain lists (32,210); ORCID'],
    ['4.4 Misidentified cell lines', DONE, 'ICLAC register v14 (581); Cellosaurus (live)'],
    ['4.4 Primer sequences; statistics recalculation', DONE, 'NCBI BLAST (Seek & Blastn); built-in tests'],
    ['4.5 Duplicate submissions; same title already published', DONE, 'PJPS fingerprint store; Crossref, OpenAlex, CORE'],
    ['4.6 Risk badge, evidence, decision record, confidential Word / PDF', DONE, '']
  ], [44, 14, 42]),
  h2('6.2 Measured accuracy'),
  p('Benchmark: 150 papers retracted for paper-mill reasons (Retraction Watch) against 126 ordinary papers from the same journals and years (Europe PMC open access); full texts and reference lists from 311 JATS files.'),
  table(['Signal', 'Mill papers flagged', 'Ordinary papers flagged'], [
    ['References built largely on journals with many paper-mill retractions (low)', ['16 / 150 (10.7%)', 'warn'], ['3 / 126 (2.4%)', 'ok']],
    ['Same, stronger threshold (medium)', ['9 / 150 (6.0%)', 'warn'], ['1 / 126 (0.8%)', 'ok']],
    ['Cites a paper retracted for paper-mill reasons', ['8 / 150 (5.3%)', 'warn'], ['2 / 126 (1.6%)', 'ok']],
    ['Text signals combined, MEDIUM or HIGH', ['7 / 150 (4.7%)', 'warn'], ['2 / 126 (1.6%)', 'ok']],
    ['Misidentified cell lines', ['11 / 150', 'warn'], ['2 / 126', 'ok']],
    ['Tortured phrases', ['8 / 150', 'warn'], ['2 / 126', 'ok']],
    ['Title resembling mill-retracted titles (tested, not used)', ['9 / 150', 'na'], ['4 / 126', 'na']]
  ], [52, 24, 24]),
  gap(),
  p('Demonstration manuscript (test/audit-full.js): risk HIGH with the planted signals found: AI-text leftovers, tortured phrases, template wording, vague methods, a retracted citation, missing ORCID, free-mail addresses and a misidentified cell line.'),
  p([run('What the numbers mean: ', { bold: true }), run('each signal flags several times more mill papers than ordinary ones, so a flag is worth a closer look. But most mill papers read cleanly and many are retracted for image, authorship or peer-review reasons that leave no trace in the text, so a LOW result is not a clearance. Author retractions by ORCID, duplicate submissions and image findings (Module 5) were not part of this benchmark. Thresholds were chosen on these papers; a fresh sample would give a fairer estimate.')])
);

// 7. Module 5
add(
  h1('7. Module 5: Image Integrity'),
  p('Purpose: find duplicated, re-used, edited and AI-generated figures. The analysis runs in the editor\'s browser and on the PJPS server; by PJPS decision, figures are never sent to an outside service.'),
  h2('7.1 Completion'),
  table(['Specification item', 'Status'], [
    ['5.1 Figures from Word, PDF and image files; panels split; panel letters read; figure type', DONE],
    ['5.2 Duplication inside the manuscript: rotated, mirrored, resized, cropped, overlapping', DONE],
    ['5.3 Edits inside one image: cloned areas, pasted patches, erased areas', DONE],
    ['5.4 Forensic viewer: contrast, error level, noise, edges, overlay and swipe, flicker', DONE],
    ['5.5 Western blot / gel lanes compared; joined lanes', DONE],
    ['5.6 Earlier PJPS manuscripts and published papers; authors\' open-access figures', DONE],
    ['AI-generated images: file markers (C2PA, IPTC) and statistical indicators', DONE],
    ['Graph and chart duplication', DONE],
    ['5.7 Outside vendor (ImageTwin / Proofig)', ['Not used: PJPS decision', 'na']],
    ['5.8 Risk badge, side-by-side findings, editor marks, query letter, confidential Word / PDF', DONE]
  ], [80, 20]),
  h2('7.2 Measured accuracy'),
  p([run('Forgeries generated from 40 real scientific figures (RSIID source set), 25 per type:', { bold: true })]),
  table(['Manipulation', 'Found', 'Rate'], [
    ['Copy rotated 90°', '25 / 25', ['100%', 'ok']],
    ['Copy rotated 180°', '25 / 25', ['100%', 'ok']],
    ['Mirrored copy', '25 / 25', ['100%', 'ok']],
    ['Copy rescaled to 60%', '25 / 25', ['100%', 'ok']],
    ['JPEG recompression (quality 40)', '25 / 25', ['100%', 'ok']],
    ['Contrast / brightness changed', '22 / 25', ['88%', 'ok']],
    ['Partial copy (55% crop)', '18 / 25', ['72%', 'warn']],
    ['Cloned area inside one image', '16 / 25', ['64%', 'warn']],
    ['Clean images (false alarms)', '0 / 20', ['0 false alarms', 'ok']]
  ], [55, 20, 25]),
  gap(),
  p([run('BioFors (ICCV 2021), real biomedical figures annotated by experts:', { bold: true })]),
  table(['Task', 'Result'], [
    ['Duplicates between figures (40 papers, 102 testable pairs)', ['54 found (40 strong); 134 further reports to review', 'warn']],
    ['Duplicated areas inside one image', ['18 of 60 flagged; 3 of 81 clean images flagged', 'bad']],
    ['Cut-and-joined lanes', ['9 of 77 flagged; 4 of 42 clean images flagged', 'bad']],
    ['False alarms on clean blots / gels', ['0 reports in 4,095 pairs', 'ok']],
    ['False alarms on clean microscopy', ['2 medium reports in 12,720 pairs', 'ok']]
  ], [50, 50]),
  gap(),
  p('Demonstration figures (test/demo-check.mjs): every planted problem was found: duplicated panels, joined blot lanes, an AI-generated image marker, a retouched area and a duplicated chart.'),
  p([run('Limits: ', { bold: true }), run('whole copies are found reliably; duplicated areas inside one image and joined blot lanes are found much less often, and these are the main improvement areas. AI-image statistics are indicators only, and a missing marker does not prove an image is genuine. Commercial databases of all published figures are not searched, by PJPS decision.')])
);

// 8. Full screening
add(
  h1('8. Full Screening Report'),
  table(['Check (test/audit-full.js, demonstration manuscript)', 'Result'], [
    ['One upload runs Modules 1-4 and attaches Module 5', ['Done in 64 seconds', 'ok']],
    ['Front-page summary per module', ['Bibliography 2 verified / 1 miscited / 1 retracted; style 57% compliant; citations 1 missing, 1 uncited; paper mill HIGH', 'ok']],
    ['Desk-review recommendation', ['"Investigate before any further processing", with the reasons', 'ok']],
    ['Editor version (all modules, confidential)', ['Produced; includes paper mill and image sections', 'ok']],
    ['Author version (Modules 1-3 only)', ['Produced; contains no paper-mill or image content', 'ok']],
    ['History by manuscript number, Super Admin functions, permissions', ['Working', 'ok']]
  ], [45, 55])
);

// 9. Fixes
add(
  h1('9. Defects found and fixed during the audit'),
  table(['Defect', 'Effect', 'Fix', 'Status'], [
    ['Wrong year plus wrong pages passed as Verified', 'Author not told about errors', 'Year difference counts when volume or pages also differ', ['Fixed, tested', 'ok']],
    ['Reference matched to a preprint instead of the journal article', 'Wrong year / volume not seen', 'Journal references matched to the published version; missing volume taken from another database', ['Fixed, tested', 'ok']],
    ['DOI with text appended not repaired', 'Wrong verdict', 'Extra text removed and the DOI retried', ['Fixed, tested', 'ok']],
    ['About 1 in 3 valid PDFs refused as "damaged"', 'Uploads failed in all modules', 'PDF reader given a clean copy of the data', ['Fixed, tested', 'ok']],
    ['Source that negates a claim counted as support', 'Contradicted claims passed', 'Negation of claim terms counts as contradiction', ['Fixed, tested', 'ok']],
    ['Module 4: no "mill-affected journals" or ORCID check (spec 4.2, 4.3)', 'Spec items incomplete', 'Both added from Retraction Watch and ORCID', ['Added, tested', 'ok']]
  ], [27, 20, 37, 16]),
  gap(),
  p('All fixes are live on the web portal and in desktop version 3.2.1 (published 30 October 2026).')
);

// 10. Datasets
add(
  h1('10. Datasets: all real, named sources'),
  p('Record counts read from the live platform database on 30 October 2026 (read-only). Refreshable datasets are updated by the daily job; the last good download of each is kept on Cloudflare R2 and used automatically when a source is down.'),
  h2('10.1 Reference, journal and integrity datasets'),
  table(['Dataset', 'Source', 'Records (live)', 'Loaded', 'Used by'], [
    ['Retraction Watch', 'Crossref Labs', '64,429 papers', '29 Oct 2026', 'M1, M3, M4'],
    ['Problematic Paper Screener', 'IRIT (Cabanac, Labbé, Magazinov)', '8,993 fingerprints', '26 Oct 2026', 'M4'],
    ['Predatory / hijacked journals', "Beall's list, hijacked list", '2,920', '26 Oct 2026', 'M1, M4'],
    ['NLM Catalog', 'US National Library of Medicine', '42,146 journals', '29 Oct 2026', 'M1, M2'],
    ['DOAJ', 'Directory of Open Access Journals', '23,554 journals', '29 Oct 2026', 'M1'],
    ['LTWA', 'ISSN International Centre', '11,438 words', '29 Oct 2026', 'M2'],
    ['Crossref journal titles', 'Crossref', '168,461', '29 Oct 2026', 'M1'],
    ['OpenAlex journals', 'OpenAlex', '216,923', 'Monthly', 'M1'],
    ['Publisher journal lists', '11 publishers (Elsevier, Springer, Wiley, ...)', '24,619', '30 Oct 2026', 'M1'],
    ['E-mail domains', 'Free-mail and disposable registers', '32,210', '29 Oct 2026', 'M4'],
    ['FDA Orange Book', 'US Food and Drug Administration', '48,865 products', '27 Oct 2026', 'Integrity'],
    ['ICLAC register v14', 'International Cell Line Authentication Committee', '581 cell lines', 'Bundled', 'M4'],
    ['Journal index lists', 'Scopus, SJR, Web of Science, EBSCO, HEC HJRS, DOAJ removed', '49,104 / 32,193 / 17,816 / 32,212 / 774 / 10,407', 'Files', 'M1']
  ], [20, 26, 22, 14, 18]),
  h2('10.2 Live services queried during a check'),
  p('Crossref, DOI Foundation (Handle), DataCite, OpenAlex, PubMed, Europe PMC, Semantic Scholar, arXiv, DBLP, Open Library, Google Books, ERIC, CORE, Google Scholar (SerpApi, last resort), Unpaywall, ORCID, Cellosaurus, NCBI BLAST, ROR, PubChem and ClinicalTrials.gov.'),
  h2('10.3 PJPS image reference databases (Module 5)'),
  table(['Database', 'Papers indexed', 'Panels', 'Coverage'], [
    ['Retracted / corrected for image problems (Retraction Watch + PMC)', '2,421', '38,421', ['2,421 of 4,055 open-access papers', 'warn']],
    ['BioFors (expert-annotated biomedical figures)', '1,031', '35,135', ['All 1,031 papers', 'ok']],
    ['PubMed Central open access (pharmacy, pharmacology, medicinal plants)', '2,453', '25,939', ['About 2% of about 105,000; continues daily', 'bad']],
    ['BINDER (near-duplicate patches)', '2,692', '5,453', ['Complete', 'ok']],
    ['Published PJPS papers (pjps.pk)', '228', '3,330', ['Partial; full archive not yet indexed', 'bad']],
    ['RSIID (scientific figures, CC-BY)', '2,286', '3,205', ['Complete', 'ok']],
    ['Publisher open-access figures', '18', '168', ['Started', 'bad']],
    ['Total', '11,129', '111,651', '']
  ], [40, 15, 15, 30]),
  gap(),
  h2('10.4 Benchmark and evaluation data'),
  bullet('Module 4: 150 paper-mill retractions and 126 controls, full texts from Europe PMC (311 JATS files).'),
  bullet('Module 5: BioFors (2 GB archive with expert annotations), RSIID (493 MB), BINDER (12,876 files), 10,363 retracted image cases.'),
  bullet('Modules 1-3: ground-truth reference lists, manuscripts and source PDFs in test/audit-*.js; the official PJPS Instructions for Authors examples.')
);

// 11. Open items
add(
  h1('11. Open items and recommendations'),
  table(['Item', 'Why it matters', 'Recommendation', 'Priority'], [
    ['Published PJPS archive only partly indexed (228 papers)', 'Re-use of figures from earlier PJPS papers can be missed', 'Run the full archive once: npm run images:index -- --source pjps --from 1', ['High', 'bad']],
    ['PubMed Central figures about 2% indexed', 'Fewer matches with published figures', 'Let the daily job continue; run longer batches on a server', ['Medium', 'warn']],
    ['Earlier-submission store nearly empty (system just in use)', 'Duplicate submissions and re-used figures between PJPS submissions cannot yet be found', 'Fills automatically as manuscripts are screened; consider loading recent submissions', ['Medium', 'warn']],
    ['Duplicated areas inside one image (30%) and joined lanes (12%) on BioFors', 'Main gap in in-house image detection', 'Improve these two detectors next', ['High', 'bad']],
    ['Module 4 thresholds chosen on the benchmark sample', 'Estimates may be optimistic', 'Re-measure on a fresh sample of retracted papers', ['Low', 'ok']],
    ['Drive C: of the build computer nearly full (under 1 GB)', 'Tests and desktop builds can fail', 'Free space on C:', ['Medium', 'warn']]
  ], [27, 25, 34, 14])
);

// 12. Reproducing
add(
  h1('12. Reproducing these results'),
  table(['Command', 'What it measures'], [
    ['npm test', 'Full automated test suite (offline)'],
    ['node test/audit-m1.js', 'Module 1 accuracy on 27 known references (internet)'],
    ['node test/audit-m23.js', 'Module 2 compliance and conversion; Module 3.A'],
    ['node test/audit-m3b.js', 'Module 3.B claim support and 3.C patterns'],
    ['node test/audit-full.js', 'Full Screening Report end to end'],
    ['node scripts/benchmark-papermill.js 150 --rescore', 'Module 4 text signals'],
    ['node scripts/benchmark-papermill-refs.js', 'Module 4 reference signals'],
    ['node scripts/benchmark-public-images.mjs; node scripts/benchmark-images.mjs', 'Module 5 on RSIID and BioFors']
  ], [48, 52])
);

// ------------------------------------------------------------------ document

const doc = new Document({
  creator: 'Softsols Pakistan',
  title: 'PJPS Data Integrity System - Audit Report Modules 1-5',
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 30, bold: true, color: NAVY }, paragraph: { outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 25, bold: true, color: NAVY }, paragraph: { outlineLevel: 1 } }
    ]
  },
  numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }, { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 270 } } } }] }] },
  features: { updateFields: true },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } }, titlePage: true },
    headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'PJPS Data Integrity System · Audit Report Modules 1-5 · 30 October 2026', font: FONT, size: 16, color: '7F7F7F' })] })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: '7F7F7F' })] })] }) },
    children
  }]
});

const out = path.join(__dirname, 'PJPS-Audit-Report-Modules-1-5.docx');
Packer.toBuffer(doc).then(buf => { fs.writeFileSync(out, buf); console.log(`Written ${out} (${buf.length} bytes)`); });
