// docs/build-audit-report.js - generates PJPS-Platform-Audit-Report.docx (project-manager audit of the five-module platform).
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, HeadingLevel, AlignmentType, LevelFormat, BorderStyle, Footer, PageNumber, TableOfContents } = require('docx');

const W = 10466; // content width, A4 with 0.75" margins (DXA)
const C = { ink: '1F2A37', muted: '5B6675', head: '0F4C5C', line: 'C9D1D9', band: 'EEF3F6',
  met: 'D9F0DF', part: 'FFF0C2', miss: 'F9D4D4', na: 'E5E7EB', hi: 'F9D4D4', med: 'FFF0C2', low: 'E5EEF9' };
const FONT = 'Calibri';

const t = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 21, bold: o.bold, italics: o.italics, color: o.color || C.ink });
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after ?? 120, line: 288 }, alignment: o.align, children: Array.isArray(text) ? text : [t(text, o)] });
const h1 = text => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { before: 0, after: 200 }, children: [new TextRun({ text, font: FONT, size: 34, bold: true, color: C.head })] });
const h1n = text => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 0, after: 200 }, children: [new TextRun({ text, font: FONT, size: 34, bold: true, color: C.head })] });
const h2 = text => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 120 }, children: [new TextRun({ text, font: FONT, size: 26, bold: true, color: C.head })] });
const bullet = (text, o = {}) => new Paragraph({ numbering: { reference: 'b', level: 0 }, spacing: { after: 60, line: 276 }, children: Array.isArray(text) ? text : [t(text, o)] });
const bt = (b, rest) => bullet([t(b, { bold: true }), t(rest)]);

const border = { style: BorderStyle.SINGLE, size: 4, color: C.line };
const borders = { top: border, bottom: border, left: border, right: border };
function cell(content, w, o = {}) {
  const paras = (Array.isArray(content) ? content : [content]).map(x => (typeof x === 'string'
    ? new Paragraph({ spacing: { after: 20 }, alignment: o.align, children: [t(x, { size: o.size || 18, bold: o.bold, color: o.color })] }) : x));
  return new TableCell({ borders, width: { size: w, type: WidthType.DXA }, margins: { top: 60, bottom: 60, left: 90, right: 90 },
    shading: o.fill ? { fill: o.fill, type: ShadingType.CLEAR, color: 'auto' } : undefined, verticalAlign: 'top', children: paras });
}
function table(widths, header, rows, o = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const head = new TableRow({ tableHeader: true, children: header.map((h, i) => cell(h, widths[i], { fill: C.head, bold: true, color: 'FFFFFF', size: 18 })) });
  const body = rows.map(r => new TableRow({ cantSplit: true, children: r.map((c, i) => {
    const obj = (c && typeof c === 'object' && !Array.isArray(c) && c.text !== undefined) ? c : { text: c };
    return cell(obj.text, widths[i], { fill: obj.fill, bold: obj.bold, align: obj.align });
  }) }));
  return new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: widths, rows: [head, ...body] });
}
const spacer = () => new Paragraph({ spacing: { after: 120 }, children: [] });
const ST = { M: { text: 'Met', fill: C.met }, P: { text: 'Partial', fill: C.part }, X: { text: 'Not met', fill: C.miss }, N: { text: 'Out of scope', fill: C.na } };
const SEV = { High: { text: 'High', fill: C.hi, bold: true }, Medium: { text: 'Medium', fill: C.med }, Low: { text: 'Low', fill: C.low } };

// ------------------------------------------------------------------ requirement traceability (spec: docs/PJPS-Final-4-Modules.txt, rev. 2)
// [id, requirement, status, evidence]
const REQ = {
  'Shared requirements': [
    ['S1', 'Upload once, reuse in every module', 'P', 'Each module page has its own upload; no shared manuscript session observed.'],
    ['S2', 'Input formats .docx .doc .pdf .odt .rtf .txt, .bib/.ris', 'P', 'docx, txt, rtf, pdf, bib, ris read correctly. .doc/.odt not verified with genuine files. An invalid PDF returns a raw "Invalid PDF structure" error (HTTP 500).'],
    ['S3', 'Roles: Super Admin, Editor, Reviewer (Modules 4–5 editor-only)', 'M', 'Tested: Reviewer gets 403/404 on Modules 4, 5, confidential exports, admin and other users\' reports.'],
    ['S4', 'Saved reports and history per manuscript number', 'M', 'Versions 1, 2 stored per manuscript code; revision comparison endpoint works.'],
    ['S5', 'Exports: Word, PDF, CSV (+ BibTeX/RIS in Module 1)', 'P', 'Word, CSV, BibTeX, RIS work. PDF is only the browser "Print / PDF" button, no server PDF. Module 3 Word export fails (defect D4).'],
    ['S6', 'Windows desktop app with offline mode', 'N', 'Excluded from this audit: project decision is web portal only.']
  ],
  'Module 1 — Check Bibliography': [
    ['1.1', 'Input: upload, paste, .bib/.ris; edit/split/merge list; clean garbled PDF text', 'P', 'Upload, paste, bib/ris and garbled-text clean-up (hyphenation, broken lines, ligatures: 4/4) work. No split/merge editor for the detected list.'],
    ['1.2', 'Verification against 12 databases', 'M', 'All 12 sources reported in the run summary; 27-reference run completed in 110 s.'],
    ['1.3', 'Verdicts, 0–100 confidence, matched record, corrected PJPS reference, link', 'P', 'All present. Verdict accuracy 78% on audit set (section 4); two false "Miscited" caused by the parser (D6, D7).'],
    ['1.4', 'Fabrication checks; fewer false alarms; "Not indexed" for regional journals', 'P', 'Junk-DOI repair, wrong-DOI and fabricated-in-indexed-journal detected. Invented words in a real title not detected (D10); fake DOI only "Unverified" (D11); "Not indexed" never applied (D12).'],
    ['1.5', 'Retraction Watch status, reason, date; monitoring alerts', 'M', '2/2 retracted works detected (64,343 records loaded). Alert run starts; delivery of a notification was not verified.'],
    ['1.6', 'Link check kept separate from verdict', 'M', 'Link summary (working/broken) reported separately; "Broken links" filter exists.'],
    ['1.7', 'Reference age chart, % last 5/10 years, older list, threshold warning', 'M', 'All items present; Super Admin can change the rule (verified: 5 y/30% → 10 y/20%).'],
    ['1.8', 'Self-citation, PJPS citations, predatory/hijacked journals, duplicates', 'P', 'Predatory/hijacked 2/2 and duplicates 4/4 groups found. Self-citation and PJPS counts under-report when a reference is not cleanly matched (D9).'],
    ['1.9', 'Summary, verdict filter, exports, Re-check showing changes', 'M', 'CSV, BibTeX, RIS, Word, corrected list all return files; filters and re-check present.']
  ],
  'Module 2 — Reference Style Check & PJPS Converter': [
    ['2.1', 'Rule-by-rule compliance incl. in-text format, order, a/b suffixes, score', 'M', '14/14 planted entry rules, 6/6 in-text rules, order and suffix rules detected; % compliant score reported.'],
    ['2.2', 'Converter: any style → PJPS, in-text + list, re-sort, fill DOI, flag unmatched', 'P', 'Word round-trip correct (4 citations converted, list sorted, untouched text preserved). But: crashes on any unparseable entry (D2), drops an author (D5), keeps full journal names so its own output fails 2.1 (D8).'],
    ['2.3', 'Before/after view, Track Changes, download, change report', 'M', 'Track Changes verified in the .docx (7 insertions, 7 deletions; none when switched off). Before/after view not exercised.']
  ],
  'Module 3 — Citations': [
    ['3.A', 'Citation ↔ list consistency', 'P', 'Missing, uncited, year mismatch, ambiguous, "et al." misuse, numbered gaps and table citations found. Footnote citations missed (D13); author misspelling reported as "missing"; location given as context text, not page/paragraph.'],
    ['3.B', 'Claim ↔ source verification', 'P', '5/6 claims correct against a real uploaded PDF, with page number and quoted passage; open-access full text retrieved. Whole check fails when a cited reference is fabricated or retracted and has no source text (D3).'],
    ['3.C', 'Citation pattern flags', 'M', 'Self-citation, author concentration, journal stacking and 2 citation blocks all flagged.'],
    ['3.D', 'Combined report; Word/PDF/CSV; author letter EN/UR with approval', 'P', 'Letters EN and UR (Word) and CSV work; Module 3 Word report returns an error (D4).']
  ],
  'Module 4 — Paper Mill Detection': [
    ['4.1', 'Text signals: tortured phrases, templates, AI leftovers, vague methods', 'M', 'All four detected; 37/40 tortured phrases found, 0/40 false alarms on correct terms.'],
    ['4.2', 'Reference signals', 'M', 'Fabricated, retracted, mill-retraction, predatory and stacking signals present and fired.'],
    ['4.3', 'Author and submission signals', 'P', 'Author retraction, free-mail, ORCID, authorship change, reviewers found. Retractions matched by name only, so common names raise false signals (D16); "institutions far apart" not implemented.'],
    ['4.4', 'Biology/data signals', 'P', 'Misidentified cell lines (ICLAC register) work. Primer/sequence and statistics checks (phase 3) not built — as declared in the spec.'],
    ['4.5', 'Duplicate submission check', 'M', 'Exact resubmission and a lightly edited resubmission both detected.'],
    ['4.6', 'Risk badge, evidence, notes, decision record, confidential export', 'M', 'LOW/MEDIUM/HIGH with weighted signals; decision saved; confidential Word export (13 KB) produced.']
  ],
  'Module 5 — Image Integrity Detection': [
    ['5.1', 'Extraction from docx/pdf; panel split; panel-letter OCR; figure type', 'P', 'Extraction, panel split and type guess work (8 panels from demo). Panel-letter OCR not built (declared open).'],
    ['5.2', 'Duplication inside the manuscript (rotated/flipped/resized/partial)', 'P', 'Perfect on planted copies; on real expert-annotated figures only 39% of known duplicate pairs found (section 4).'],
    ['5.3', 'Cloned areas inside one image', 'P', 'Works on planted clones; 9% recall on real annotated images.'],
    ['5.4', 'Forensic viewer (filters, ELA, noise, slider)', 'P', 'Code present; not exercised in this audit.'],
    ['5.5', 'Western blot / gel lane checks', 'P', 'Only joined-lane "sharp step" detection (14% real recall). Lane-by-lane comparison not built (declared open).'],
    ['5.6', 'Earlier figures: PJPS fingerprint store; authors\' open-access figures', 'P', 'Fingerprint store works (earlier-manuscript match, chart reuse). Europe PMC author-figure check not built (declared open).'],
    ['5.7', 'Optional ImageTwin / Proofig connection', 'X', 'Not built (needs vendor contract). Report correctly says "not checked".'],
    ['5.8', 'Risk badge, findings side by side, marks, query letter, confidential export', 'P', 'All present, but the results screen crashes after every analysis (D1).'],
    ['5.9', 'Runs as background job on the job queue', 'P', 'Deliberately runs in the editor\'s browser (4.5 MB Vercel limit). Works, but differs from the spec.']
  ],
  'Full Screening Report': [
    ['F1', 'One upload → five sections + front-page summary + recommendation', 'M', 'Completed in 97 s on the demo manuscript; recommendation "Investigate" with reasons.'],
    ['F2', 'Editor version (all modules) and author version (Modules 1–3)', 'M', 'Verified in the .docx: editor version holds paper-mill and image text and "confidential"; author version holds neither.'],
    ['F3', 'Navigation reduced to five modules; other tools switched off', 'M', 'Confirmed in the browser; legacy API routes refused.']
  ]
};

function score(rows) { const c = { M: 0, P: 0, X: 0, N: 0 }; rows.forEach(r => c[r[2]]++); const n = c.M + c.P + c.X; return { ...c, n, pct: n ? Math.round((c.M + 0.5 * c.P) / n * 100) : 0 }; }
const sc = Object.fromEntries(Object.entries(REQ).map(([k, v]) => [k, score(v)]));
const all = score(Object.values(REQ).flat());
// Modules 1-5 + full report only (shared excluded) for the headline
const core = score(Object.entries(REQ).filter(([k]) => !k.startsWith('Shared')).flatMap(([, v]) => v));
console.log('overall', all, 'core', core);
Object.entries(sc).forEach(([k, v]) => console.log(k, v.pct + '%', v));

// ------------------------------------------------------------------ defects
const DEF = [
  ['D1', 'High', 'Module 5', 'The results screen crashes after every analysis: "catFilter is not defined" (variable used in images.js, never declared). The analysis and save succeed but the editor sees an error and no findings.', 'Declare the variable (one line). Add a browser UI test.'],
  ['D2', 'High', 'Module 2', 'The converter crashes (TypeError) if any reference cannot be parsed: a Nature-style entry, a WHO guideline, a web page. Real pharmacy manuscripts contain such entries. Spec says they must be flagged, not fail.', 'Skip unparseable records when sorting; keep them as "flagged for editor".'],
  ['D3', 'High', 'Module 3', 'Claim verification aborts when a cited reference is fabricated or retracted and no source text exists (notes list missing). These are the cases the module exists to catch.', 'Return a notes array in every verdict.'],
  ['D4', 'Medium', 'Module 3', 'Word export of a Module 3 report returns HTTP 500 (reference report builder expects fields the citations report lacks).', 'Build a Module 3 Word layout.'],
  ['D5', 'High', 'Module 2', 'Silent data loss: a Chicago-style entry with three authors was converted with two. A converter that alters content without flagging breaks the "never silently correct" rule.', 'Fix author parsing for "Surname, I., I. Surname, and I. Surname"; flag any author-count change.'],
  ['D6', 'Medium', 'Module 1', 'Article-number locators are mis-read: e1000097 becomes e100009 (false "First page is wrong" on a genuine PLoS paper); "372: n71" (BMJ style) is not read at all, so a wrong volume cannot be caught.', 'Extend locator parsing (e-numbers, n-numbers).'],
  ['D7', 'Medium', 'Module 1', 'A title containing an internal full stop (common subtitle form) is cut early and the rest becomes the "journal": genuine Higuchi 1963 marked Miscited "wrong journal" although year, volume, issue and pages all matched.', 'Use matched-record fields to re-split before judging the journal.'],
  ['D8', 'Medium', 'Module 2', 'Converter keeps full journal names (APA/Harvard) or removes dots (Vancouver), so output fails the platform\'s own journal-abbreviation rule.', 'Apply the same abbreviation routine used by the checker.'],
  ['D9', 'Medium', 'Module 1', 'Self-citation and PJPS-citation indicators read authors/journal of the rejected nearest-neighbour record: two references by the manuscript\'s own authors counted as 0.', 'Use as-written fields unless status is Verified.'],
  ['D10', 'Medium', 'Module 1', 'A real title with 8 invented words appended was "Verified" at 97% (spec 1.4).', 'Penalise unmatched extra title words.'],
  ['D11', 'Medium', 'Module 1', 'A reference with a non-existent DOI in a major journal stays "Unverified" (56%) instead of Suspicious.', 'Escalate to Suspicious when DOI is unregistered and no title match.'],
  ['D12', 'Medium', 'Module 1', '"Not indexed" never appeared in the audit (0 of 2 regional refs; label only applies when no candidate is found). A fabricated PJPS reference is Suspicious because PJPS is "well indexed" (3,966 records, sparse metadata); real PJPS articles missing from Crossref would meet the same fate.', 'Treat the home journal as regional; require author/volume match, not title alone.'],
  ['D13', 'Medium', 'Module 3', 'Citations in footnotes are missed, and the footnote text is added to the end as a fake reference listed as "uncited".', 'Read footnotes separately from the reference list.'],
  ['D14', 'Medium', 'Module 4', 'Author retractions are matched by name only (spec: name + ORCID). Names such as "Wei Zhang" produced "6 retractions" for a clean paper.', 'Use ORCID/affiliation, show confidence, lower weight for common names.'],
  ['D15', 'High', 'Module 5', 'Real-world sensitivity is low (section 4): known duplicate pairs 39%, cloned regions 9%, spliced regions 14%. The built-in tests use planted copies and pass 100%, so they overstate field performance.', 'Report recall honestly in the UI and proposal; tune on BioFors.'],
  ['D16', 'Low', 'Module 1', 'A year off by one and a wrong last page remain "Verified" (97%).', 'Show as note or lower to Miscited by editor rule.'],
  ['D17', 'Low', 'Module 1', 'A reference with no pages followed by an initials-first reference is merged as a wrapped line (14 lines read as 12).', 'Require a year or terminator before merging.'],
  ['D18', 'Low', 'Module 3', 'A misspelt author ("Siddique" for "Siddiqui") is reported as missing, not as a spelling mismatch.', 'Add fuzzy-match message.'],
  ['D19', 'Low', 'Module 1', 'Duplicate indicator lists every pair (11 entries for 4 duplicate groups).', 'Group by work.'],
  ['D20', 'Medium', 'Platform', 'Reference datasets (Retraction Watch, Beall, Problematic Paper Screener) load in the background; in this audit the first load took over 3 minutes and in one run had not started after 3 minutes. Until loaded, retractions and tortured phrases pass unnoticed with no warning to the editor.', 'Show dataset status on each report; block or warn when empty.']
];

// ------------------------------------------------------------------ content
const kids = [];
// cover
kids.push(new Paragraph({ spacing: { before: 1800, after: 120 }, children: [new TextRun({ text: 'PJPS Reference Checker', font: FONT, size: 56, bold: true, color: C.head })] }));
kids.push(new Paragraph({ spacing: { after: 360 }, children: [new TextRun({ text: 'Platform audit: completeness against the requirements, and accuracy of testing', font: FONT, size: 30, color: C.muted })] }));
kids.push(table([2600, 7866], ['Item', 'Detail'], [
  ['Prepared for', 'Project sponsor, Softsols Pakistan / PJPS Editor'],
  ['Prepared by', 'Project Manager (audit role), assisted by Claude'],
  ['Audit date', '25 October 2026'],
  ['Scope', 'Web portal: Modules 1–5 and the Full Screening Report. Desktop app excluded (project decision).'],
  ['Baseline', 'Requirements: docs/PJPS-Final-4-Modules.txt (rev. 2, 24 Oct 2026). Code: git commit e0cac9d, branch main.'],
  ['Environment', 'Local server, Node 24, embedded PostgreSQL, live internet to the reference databases. The Vercel deployment was not tested.'],
  ['Classification', 'Confidential, internal']
]));
kids.push(spacer());
kids.push(p('Nothing in this report was changed in the product. The only files added to the repository are the audit test scripts (test/audit-*.js) and this report generator.', { italics: true, color: C.muted }));

// 1 summary
kids.push(h1('1. Executive summary'));
kids.push(p([t('Verdict: ', { bold: true }), t(`the platform is about ${core.pct}% complete against the requirements, but it is not ready for release.`, { bold: true }),
  t(` Almost every specified feature exists in some form. However, five high-severity defects stop whole features from working in realistic use, and the image-detection accuracy on real figures is far lower than the project's own tests suggest.`)]));
kids.push(h2('Headline numbers'));
kids.push(table([3300, 1500, 5666], ['Measure', 'Result', 'What it means'], [
  ['Requirement completeness (Modules 1–5 + Full Report)', { text: core.pct + '%', bold: true }, `${core.M} of ${core.n} items fully met, ${core.P} partly met, ${core.X} not met. A partly met item counts as half. Shared requirements (S1–S5) add ${sc['Shared requirements'].pct}%.`],
  ['Module 1 reference verdict accuracy', { text: '78%', bold: true }, '21 of 27 test references got the expected verdict. Genuine references wrongly flagged: 2 of 10 (both parser faults). Retracted: 2 of 2 found.'],
  ['Module 2 rule accuracy', { text: '100% / 0%', bold: true }, 'The compliance checker found 14/14 planted rule breaks. The converter matched the expected PJPS text in 0 of 7 source styles, crashed once, and dropped an author once.'],
  ['Module 3 accuracy', { text: '83%', bold: true }, '5 of 6 claim verdicts correct against a real PDF; consistency checks found all planted problem types except a footnote citation (missed) and a misspelt author (shown as "missing").'],
  ['Module 4 accuracy', { text: '10/10', bold: true }, 'All planted signals found; clean paper stayed LOW; 37/40 tortured phrases found, no false alarms. Developer benchmark on real mill papers: only 4.7% caught by text signals.'],
  ['Module 5 accuracy on real figures', { text: '9–39%', bold: true }, 'Duplicates 39%, cloned regions 9%, spliced regions 14% on expert-annotated BioFors images. Planted-copy tests pass 100%.'],
  ['Defects found', { text: String(DEF.length), bold: true }, `${DEF.filter(d => d[1] === 'High').length} high, ${DEF.filter(d => d[1] === 'Medium').length} medium, ${DEF.filter(d => d[1] === 'Low').length} low. None existed in the project's own test suite.`],
  ['Existing project tests', { text: 'All pass', bold: true }, 'npm test passes. It covers permissions and planted examples but no browser screens, so it did not catch the Module 5 crash.']
]));
kids.push(h2('What the sponsor should know'));
kids.push(bt('Good: ', 'the architecture, permissions, saved reports, Word exports (including Track Changes), Module 4 and the Full Screening Report work well and are honest about their limits.'));
kids.push(bt('Blocking: ', 'Module 5 shows an error instead of results (D1); the Module 2 converter crashes on ordinary entries and can drop an author (D2, D5); Module 3 claim checking fails on fabricated or retracted citations (D3). Each is a small fix.'));
kids.push(bt('Accuracy risk: ', 'Module 5 finds planted copies perfectly but only about one real duplicate in three. It must be presented as a screening aid, not as the equal of ImageTwin or Proofig.'));
kids.push(bt('Declared open items: ', 'Module 4 phase 3, panel-letter OCR, blot-lane comparison, Europe PMC author figures and the vendor connection are known to be unbuilt. They are counted as gaps here.'));
kids.push(h2('Recommendation'));
kids.push(p('Do not hand over or go live until D1–D5 are fixed and re-tested (estimated 3–5 working days, see section 7). Then release to a small editor group as a pilot, with Module 5 labelled as a screening aid.'));

// 2 approach
kids.push(h1('2. Audit approach and its limits'));
kids.push(p('Testing used a known-answer method. For each module I prepared inputs where the correct result is known in advance, ran them through the real code and databases, and compared the result with the expected one. The scripts are kept in test/audit-*.js so the audit can be repeated.'));
kids.push(table([2300, 4200, 3966], ['Module', 'Test set (ground truth)', 'Method'], [
  ['1 Bibliography', '27 references: 10 genuine, 1 hard, 1 junk DOI, 4 miscited, 4 fabricated (one with fake DOI), 1 invented-words, 1 wrong DOI, 2 retracted, 2 regional, 1 duplicate; plus real regional articles, predatory/hijacked journals, garbled text, BibTeX/RIS', 'Live API run against 12 databases; verdicts scored against expected'],
  ['2 Style / converter', '14 references with one planted rule break each; 7 source styles of one known work; a Word file with numbered citations', 'Engine and API; Word file unzipped and inspected'],
  ['3 Citations', 'A Word manuscript with planted errors (missing, uncited, year, ambiguous, et al., table, footnote); a numbered manuscript; a real arXiv PDF as source; two real open-access works', 'API runs; each verdict scored'],
  ['4 Paper mill', 'A clean manuscript, a mill-style manuscript with 10 planted signals, resubmissions, an authorship change, 40 random tortured phrases', 'API runs against loaded Retraction Watch (64,343), screener (8,993) and Beall lists (2,920)'],
  ['5 Images', 'Developer\'s planted tests; BioFors real figures with expert labels (sample: 40 papers / 102 pairs, 78 clone images, 125 splice images)', 'Engine benchmark; Chrome walk-through of the real screen'],
  ['Full report, admin', 'The demonstration manuscript; user creation, roles, settings', 'API runs and Word files inspected']
]));
kids.push(h2('Limits of this audit (read before relying on the numbers)'));
kids.push(bullet('The test sets are small and were written by me. Percentages have wide uncertainty: 27 references means one reference moves the score by 3.7 points.'));
kids.push(bullet('Only Module 5 was driven through the real browser screen. The other modules were tested at API level, so layout, buttons and wording in their screens were not checked (the verdict filter and navigation were read in code or seen on screen only).'));
kids.push(bullet('The live Vercel deployment, e-mail alerts, large uploads (over 4.5 MB) and load were not tested.'));
kids.push(bullet('The desktop application was excluded. Several uploaded-file formats (.doc, .odt) could only be tried with invalid stand-in files.'));
kids.push(bullet('A hand-made PDF I generated was rejected by the PDF reader, so Module 3.B was re-tested with a real arXiv PDF. That was a fault in my test file, not a product defect, and is not counted.'));
kids.push(bullet('I did not run the Module 4 benchmark on real mill papers myself; those figures (4.7% recall, 1.6% false alarms) are the developer\'s own and are quoted as such.'));
kids.push(bullet('The developer\'s tests ("npm test") all pass; I ran them first.'));

// 3 completeness
kids.push(h1('3. Completeness against the requirements'));
kids.push(p('Each numbered item of the requirement document was marked Met, Partial or Not met after testing. A Partial item works in part, or works but has a known defect. Scores count Met as 1, Partial as 0.5.'));
kids.push(table([3566, 1200, 1200, 1200, 1200, 2100], ['Area', 'Met', 'Partial', 'Not met', 'Out of scope', 'Completeness'], Object.entries(sc).map(([k, v]) => [k, { text: String(v.M), align: AlignmentType.CENTER }, { text: String(v.P), align: AlignmentType.CENTER }, { text: String(v.X), align: AlignmentType.CENTER }, { text: String(v.N), align: AlignmentType.CENTER }, { text: v.pct + '%', bold: true, fill: v.pct >= 80 ? C.met : v.pct >= 55 ? C.part : C.miss }]).concat([[{ text: 'All items', bold: true }, { text: String(all.M), align: AlignmentType.CENTER }, { text: String(all.P), align: AlignmentType.CENTER }, { text: String(all.X), align: AlignmentType.CENTER }, { text: String(all.N), align: AlignmentType.CENTER }, { text: all.pct + '%', bold: true }]])));
kids.push(spacer());
kids.push(p('Completeness measures what is built. It does not measure how well it works; accuracy is in section 4 and defects in section 5.', { italics: true, color: C.muted }));
for (const [area, rows] of Object.entries(REQ)) {
  kids.push(h2(area));
  kids.push(table([700, 3000, 1100, 5666], ['Ref', 'Requirement', 'Status', 'Evidence from testing'], rows.map(r => [r[0], r[1], ST[r[2]], r[3]])));
}

// 4 accuracy
kids.push(h1('4. Accuracy of testing: results by module'));
kids.push(h2('Module 1 — Check Bibliography (27 references)'));
kids.push(table([2300, 1100, 1100, 5966], ['Case type', 'Count', 'Correct', 'What happened'], [
  ['Genuine, correctly cited', '10', { text: '8', fill: C.part }, 'Two wrongly marked Miscited: Higuchi 1963 (title with a full stop, D7) and Moher 2009 (e-locator cut, D6).'],
  ['Genuine, hard format', '1', '1', 'Verified.'],
  ['Genuine, junk added to DOI', '1', '1', 'DOI flagged, correct DOI supplied.'],
  ['Miscited (wrong year, volume, pages)', '4', { text: '2', fill: C.part }, 'Volume and year errors caught. Year off by one with a wrong last page, and a wrong volume parsed as blank (BMJ n71), stayed Verified (D6, D16).'],
  ['Fabricated (4 incl. fake DOI)', '4', { text: '2 Suspicious, 2 Unverified', fill: C.part }, 'None passed as Verified. The fake-DOI reference was only Unverified (D11).'],
  ['Real title + invented words', '1', { text: '0', fill: C.miss }, 'Verified at 97% (D10).'],
  ['Real work, wrong DOI', '1', '1', 'Miscited: "identifier belongs to a different publication".'],
  ['Retracted', '2', { text: '2', fill: C.met }, 'Both Retracted at 99%.'],
  ['Regional journal (fictional refs)', '2', '2', 'Not Suspicious as required, but "Not indexed" label not shown (D12).'],
  ['Duplicate entries', '1 (4 groups)', { text: 'all', fill: C.met }, 'Duplicate groups detected by DOI, including one in a different format.'],
  [{ text: 'Overall', bold: true }, '27', { text: '21 (78%)', bold: true }, 'Four extra real regional-journal references: 3 behaved as expected; one JPMA page-number mismatch was not investigated.']
]));
kids.push(spacer());
kids.push(p('Extra checks passed: reference-age chart and threshold; predatory 1/1 and hijacked 1/1 journals found; garbled-text clean-up 4/4; BibTeX and RIS import 2/2 each; exports CSV, BibTeX, RIS, Word and corrected list all produced; re-check runs. Failed or weak: self-citation count (D9).'));
kids.push(h2('Module 2 — Style check and converter'));
kids.push(table([4300, 2000, 4166], ['Test', 'Result', 'Comment'], [
  ['Compliance: one planted break per reference', { text: '14 / 14', fill: C.met }, 'Authors, title case, journal abbreviation, "pp.", "Vol./No.", dash, Vancouver format, missing fields, et al.'],
  ['In-text format rules', { text: '6 / 6', fill: C.met }, 'Comma, "and", "et al.,", semicolon, author count versus et al.'],
  ['List order and a/b suffix', { text: '2 / 2', fill: C.met }, ''],
  ['Converter, 7 source styles → exact PJPS text', { text: '0 / 7', fill: C.miss }, 'Five differ only in journal abbreviation form (D8). One lost an author (D5). One crashed (D2).'],
  ['Word round trip', { text: 'Pass', fill: C.met }, '[1] → (Zahid et al., 2019); [2,3] → (Ali and Khan, 2018; Khan et al., 2019); list sorted A–Z; untouched sentence unchanged; no [n] left.'],
  ['Track Changes', { text: 'Pass', fill: C.met }, '7 insertions and 7 deletions when on; none when off.']
]));
kids.push(h2('Module 3 — Citations'));
kids.push(table([4300, 2000, 4166], ['Test', 'Result', 'Comment'], [
  ['Missing from list (3 planted)', { text: '3 / 3', fill: C.met }, 'Includes one inside a table. One was a spelling variant reported as "missing".'],
  ['Citation inside a footnote', { text: '0 / 1', fill: C.miss }, 'Missed; footnote text became a false "uncited" reference (D13).'],
  ['Uncited reference', { text: '1 / 1 (+1 false)', fill: C.part }, 'The false one is the footnote artefact.'],
  ['Year mismatch, ambiguous 2020a/b, et al. misuse', { text: '3 / 3', fill: C.met }, ''],
  ['Numbered: [9] pointing to nothing; unused 3 and 5', { text: '2 / 2', fill: C.met }, 'A numbering gap is shown as "uncited", not as a gap.'],
  ['Claim support vs real PDF and open-access article', { text: '5 / 6', fill: C.part }, 'Full, number-mismatch, and unsupported claims right; a contradicting claim ("relies on recurrent networks") gave Partial. Page numbers and quotes shown.'],
  ['Retracted source flagged', { text: '1 / 1', fill: C.met }, '"The cited work has been retracted".'],
  ['Pattern flags (self-citation, stacking, blocks)', { text: '6 flags', fill: C.met }, '2 citation blocks found.'],
  ['Fabricated reference in claim check', { text: 'Fail', fill: C.miss }, 'Whole check aborts (D3).'],
  ['Exports', { text: '5 / 6', fill: C.part }, 'EN/UR letter, letter Word, summary Word, CSV pass; Word report fails (D4).']
]));
kids.push(p('The claim checker matches terms, numbers and direction of effect on this server; it does not use an outside AI, as the specification requires. This makes it explainable but limited: it cannot reliably detect a contradiction.', { after: 80 }));
kids.push(h2('Module 4 — Paper Mill Detection'));
kids.push(table([4300, 2000, 4166], ['Test', 'Result', 'Comment'], [
  ['Clean manuscript stays LOW', { text: 'LOW (0)', fill: C.met }, 'No false signal.'],
  ['Mill manuscript, 10 planted signals', { text: '10 / 10', fill: C.met }, 'Tortured, AI leftover, template, methods, cell lines, free-mail, no ORCID, hidden characters, fabricated references, author mill-retraction. Risk HIGH (score 32). Fabricated refs: 2 of 3 planted.'],
  ['Exact resubmission under new ID', { text: 'Found', fill: C.met }, ''],
  ['Resubmission with small word changes', { text: 'Found', fill: C.met }, ''],
  ['Authors added/removed between versions', { text: 'Found', fill: C.met }, 'But also 6 name-only retractions for common names (D14).'],
  ['40 random tortured phrases', { text: '37 / 40 (93%)', fill: C.met }, 'Zero false alarms using the correct term. Missed: "top learning", "highlight map", "seen value".'],
  ['Reviewer blocked from Module 4/5', { text: 'Blocked', fill: C.met }, '403/404 on every probe.'],
  ['Developer benchmark (150 retracted vs 126 normal papers)', { text: '4.7% / 1.6%', fill: C.part }, 'Text signals catch about 1 in 20 real mill papers, with 1.6% false alarms. Honestly stated in docs/benchmark-papermill.md.']
]));
kids.push(h2('Module 5 — Image Integrity Detection'));
kids.push(table([3200, 2300, 4966], ['Test', 'Result', 'Comment'], [
  ['Developer tests: planted copies, crops, mirrors, clones, AI markers, charts', { text: 'All pass', fill: C.met }, 'Rotated/mirrored/resized copies found; no false alarms between unrelated panels.'],
  ['Demonstration manuscript in Chrome', { text: 'Found 7', fill: C.part }, 'HIGH, 8 panels, 5 strong findings. The screen first showed an error (D1).'],
  ['Real duplicate pairs (BioFors, 40 papers, 102 pairs)', { text: '40 / 102 (39%)', fill: C.miss }, '35 flagged as high. 75 further reports (some may be unlabelled genuine duplicates).'],
  ['Real cloned regions (78 images)', { text: '7 / 78 (9%)', fill: C.miss }, 'All 7 located correctly. False alarms 2 / 113 (1.8%).'],
  ['Real spliced regions (125 images)', { text: '17 / 125 (14%)', fill: C.miss }, '9 located. False alarms 5 / 74 (6.8%), none rated high.'],
  ['Unrelated panels, 260 images', { text: '0 false alarms', fill: C.met }, 'About 17,600 pairs compared (developer\'s run).']
]));
kids.push(p('Reading: the engine rarely raises a false alarm, but it misses most real manipulation. For editorial use that is acceptable only if editors understand that "no findings" does not mean "clean". The report text already says so; the proposal and training should too.', { after: 80 }));
kids.push(h2('Full Screening Report and administration'));
kids.push(bullet('Demo manuscript: 97 seconds. Front page: 2 verified, 1 miscited, 3 suspicious, 1 retracted of 7 references; 29% PJPS-compliant; 1 missing and 1 uncited citation; paper mill HIGH; recommendation "Investigate". The image line reads "not checked" until a Module 5 report is attached, as designed.'));
kids.push(bullet('Word exports: editor version, author version, decision summary, letter, reference report, CSV, BibTeX, RIS and corrected list all produced. The author version contained no paper-mill or image text.'));
kids.push(bullet('Administration: users created with correct default permissions; duplicate e-mail refused (409); age rule and tortured-phrase list editable; audit log and statistics available.'));

// 5 defects
kids.push(h1('5. Defect register'));
kids.push(p('Severity: High = a feature fails or data is silently wrong in normal use. Medium = wrong results in some cases or a missing promised behaviour. Low = cosmetic or edge case.'));
kids.push(table([620, 900, 1100, 5146, 2700], ['ID', 'Severity', 'Module', 'Finding', 'Suggested fix'], DEF.map(d => [d[0], SEV[d[1]], d[2], d[3], d[4]])));

// 6 risks
kids.push(h1('6. Project risks'));
kids.push(table([3000, 1300, 6166], ['Risk', 'Level', 'Why and what to do'], [
  ['Overstated detection accuracy', { text: 'High', fill: C.hi }, 'Module 5 results on real figures are far below the planted-copy tests. Publish the real numbers; avoid comparing with ImageTwin or Proofig, which were not tested here.'],
  ['No browser-level tests', { text: 'High', fill: C.hi }, 'D1 shipped despite a passing test suite. Add a small set of browser tests for each module screen.'],
  ['Dependence on third-party databases', { text: 'Medium', fill: C.med }, 'Crossref, PubMed, OpenAlex and the Retraction Watch download are external. Dataset load is slow and silent (D20). Free APIs may rate-limit under editor load.'],
  ['Regional journal coverage', { text: 'Medium', fill: C.med }, 'PJPS and similar journals have sparse records in international databases. Real submissions will include many; risk of false "Suspicious" (D12).'],
  ['Name-based author matching', { text: 'Medium', fill: C.med }, 'Risk of falsely implicating authors with common names. The report already says "confirm it is the same person"; keep the weight low.'],
  ['Vercel limits', { text: 'Medium', fill: C.med }, '4.5 MB upload limit (images analysed in browser to avoid it); scheduled dataset refresh depends on a cron secret. Not tested.'],
  ['Developer workstation disk', { text: 'Medium', fill: C.med }, 'The C: drive of the audit machine was full (about 160 MB free) and blocked a test copy. Free space before further builds.'],
  ['Scope: desktop and vendor connection', { text: 'Low', fill: C.low }, 'Desktop is out of scope by decision; ImageTwin/Proofig needs a contract and API documentation.']
]));

// 7 plan
kids.push(h1('7. Recommended plan'));
kids.push(p('Effort figures are my estimates for one developer who knows the code; they are not commitments.'));
kids.push(table([1500, 5766, 1500, 1700], ['Phase', 'Work', 'Items', 'Estimate'], [
  ['A. Stabilise', 'Fix D1, D2, D3, D4, D5; add browser tests for each module screen; re-run the audit scripts.', 'High defects', '3–5 days'],
  ['B. Accuracy', 'Parser fixes (D6, D7, D17), indicators (D9), converter abbreviations (D8), fabrication rules (D10–D12), footnotes (D13), author matching (D14).', 'Medium defects', '6–8 days'],
  ['C. Honest reporting', 'Show dataset status on reports (D20), state real image-detection recall in the proposal and UI, add server PDF export.', 'D15, D20, S5', '2–3 days'],
  ['D. Pilot', 'Release to 2–3 editors for two weeks on real submissions; collect false alarms and misses; compare against the editors\' own findings.', 'Validation', '2 weeks'],
  ['E. Remaining spec', 'Phase 3 of Module 4, panel-letter OCR, blot-lane comparison, Europe PMC author figures, vendor connection (contract first).', 'Open items', 'Decide after pilot']
]));
kids.push(h2('Decisions needed from the sponsor'));
kids.push(bullet('Approve Phase A as the condition for go-live.'));
kids.push(bullet('Confirm the PJPS house style (the spec itself says "confirm with the current author guidelines"): journal abbreviation form with or without dots affects Modules 2 and the converter.'));
kids.push(bullet('Decide whether Module 5 is positioned as a screening aid (recommended) or as a replacement for a commercial tool.'));
kids.push(bullet('Agree a pilot success measure, for example no confirmed false accusation and at least one real finding the editor had not already seen.'));

// 8 appendix
kids.push(h1('8. Appendix: how to repeat the tests'));
kids.push(table([3600, 6866], ['Script', 'Purpose'], [
  ['npm test', 'Developer suite: permissions, Modules 2/4/5 planted cases, image engine, forensics, demo check.'],
  ['node test/audit-m1.js, audit-m1b.js', 'Module 1 accuracy (27 references) and supplementary checks. Needs internet.'],
  ['node test/audit-m23.js', 'Module 2 compliance and converter; Module 3 consistency.'],
  ['node test/audit-m3b.js, audit-m3c.js', 'Module 3 claim support and pattern flags; real arXiv PDF source (download it first).'],
  ['node test/audit-m4.js', 'Module 4 planted signals, duplicates, tortured-phrase recall, role blocking.'],
  ['node test/audit-full.js', 'Full Screening Report, exports, history, administration.'],
  ['scripts/benchmark-images.mjs', 'Module 5 on BioFors real figures (writes data/benchmark/images-results.json).'],
  ['Environment variable AUDIT_DB', 'Directory for a persistent test database so the large datasets download once. Default is in-memory; the real DATABASE_URL is never used by these scripts.']
]));
kids.push(spacer());
kids.push(p('Test data note: Retraction Watch matches used publicly listed author names for one planted test only; no personal findings are reported here.', { italics: true, color: C.muted }));

const doc = new Document({
  creator: 'PJPS audit', title: 'PJPS Reference Checker — Platform Audit',
  styles: { default: { document: { run: { font: FONT, size: 21 } } } },
  numbering: { config: [{ reference: 'b', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, bottom: 1080, left: 720, right: 720 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'PJPS Reference Checker audit · Confidential · page ', font: FONT, size: 16, color: C.muted }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: C.muted })] })] }) },
    children: kids
  }]
});
const out = process.argv[2] || path.join(__dirname, 'PJPS-Platform-Audit-Report.docx');
Packer.toBuffer(doc).then(b => { fs.writeFileSync(out, b); console.log('written', out, b.length); });
