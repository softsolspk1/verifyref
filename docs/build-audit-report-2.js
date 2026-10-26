// docs/build-audit-report-2.js - generates PJPS-Platform-Re-Audit-Report.docx (second project-manager audit, after the defect fixes).
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
// [id, requirement, status now, evidence, status in audit 1]
const REQ = {
  'Shared requirements': [
    ['S1', 'Upload once, reuse in every module', 'M', 'Seen in the browser: after one upload every module shows "Manuscript already uploaded in this session: … Use it here / Forget".', 'P'],
    ['S2', 'Input formats .docx .doc .pdf .odt .rtf .txt, .bib/.ris', 'P', 'docx, txt, rtf, pdf, bib, ris read correctly; all eight extensions are accepted by the upload box. A damaged file now gives a clear 400 message instead of a 500. .doc and .odt were only tried with invalid stand-in files, so genuine files are unproven. TIFF figure files (spec 5.1) are not accepted.', 'P'],
    ['S3', 'Roles: Super Admin, Editor, Reviewer (Modules 4–5 editor-only)', 'M', 'Reviewer receives 403/404 on Module 4 run, confidential export, Module 5 save, admin users and other users\' reports.', 'M'],
    ['S4', 'Saved reports and history per manuscript number', 'M', 'Versions 1 and 2 stored under one manuscript code; compare endpoint works.', 'M'],
    ['S5', 'Exports: Word, PDF, CSV (+ BibTeX/RIS in Module 1)', 'M', 'Word, CSV, BibTeX, RIS and server-side PDF (HTTP 200) all produced; the Module 3 Word report now works.', 'P'],
    ['S6', 'Windows desktop app with offline mode', 'N', 'Excluded: project decision is web portal only.', 'N']
  ],
  'Module 1 — Check Bibliography': [
    ['1.1', 'Input: upload, paste, .bib/.ris; edit/split/merge list; clean garbled text', 'M', 'Upload, paste, bib/ris (2/2 each), garbled-text clean-up (4/4). A "Review detected references" editor is on the screen; its split/merge was not exercised.', 'P'],
    ['1.2', 'Verification against 12 databases', 'M', 'All 12 sources reported; 27 references in 79 s.', 'M'],
    ['1.3', 'Verdicts, 0–100 confidence, matched record, corrected reference, link', 'P', 'All present. 25 of 27 verdicts as expected (93%). Two miscited references still pass as Verified (D6, D16).', 'P'],
    ['1.4', 'Fabrication checks; fewer false alarms; "Not indexed" for regional journals', 'P', '4/4 fabricated flagged Suspicious (incl. fake DOI); invented words in a real title caught; wrong DOI and junk DOI caught. The "Not indexed" label never appears (0 in all runs, D12).', 'P'],
    ['1.5', 'Retraction Watch status, reason, date; monitoring alerts', 'M', '2/2 retracted works found (64,343 records). The alert run starts; delivery of a message was not verified.', 'M'],
    ['1.6', 'Link check separate from verdict', 'M', 'Link summary (4 working, 2 broken) kept apart from the verdicts.', 'M'],
    ['1.7', 'Age chart, % last 5/10 years, older-than-10 list, threshold warning', 'M', 'All present; "only 15% from the last 5 years (minimum 30%)" raised correctly.', 'M'],
    ['1.8', 'Self-citation, PJPS citations, predatory/hijacked journals, duplicates', 'M', 'Self-citation now measured (50% in test); PJPS count 2; a Beall-listed journal flagged high-risk; 4 duplicate groups found. The hijacked-journal list could not be confirmed (sample query returned no rows).', 'P'],
    ['1.9', 'Summary, filter, exports, Re-check', 'M', 'CSV, BibTeX, RIS, Word, corrected list returned; re-check ran.', 'M']
  ],
  'Module 2 — Reference Style Check & PJPS Converter': [
    ['2.1', 'Rule-by-rule compliance incl. in-text, order, a/b suffix, score', 'M', '14/14 planted rule breaks found, 0 false alarms; 6/6 in-text rules; order and suffix rules.', 'M'],
    ['2.2', 'Converter: any style → PJPS, in-text + list, re-sort, fill DOI, flag unmatched', 'P', '5 of 7 source styles give exactly the PJPS text (audit 1: 0 of 7); no crash; no lost author. Chicago keeps title case, Nature drops the issue. Filling missing fields from the matched record was not demonstrated (0 of 3 matched in the test).', 'P'],
    ['2.3', 'Before/after view, Track Changes, download, change report', 'M', 'Track Changes verified in the file (7 insertions, 7 deletions; none when off); before/after view exists in the code. Converter takes .docx only.', 'M']
  ],
  'Module 3 — Citations': [
    ['3.A', 'Citation ↔ list consistency', 'M', 'Missing 3/3 (incl. a footnote and a table citation), uncited 1/1 with no false extra, year mismatch, ambiguous 2020a/b, "et al." misuse, spelling variant, numbered [9] and gaps; paragraph numbers shown.', 'P'],
    ['3.B', 'Claim ↔ source verification', 'P', '5/6 claims correct against a real PDF with page number and quote. A claim that contradicts the paper is rated Partial, not Unsupported. Fabricated and retracted references now return "could not verify" and a red flag instead of aborting.', 'P'],
    ['3.C', 'Citation pattern flags', 'M', 'Self-citation, author concentration, stacking and 2 citation blocks flagged.', 'M'],
    ['3.D', 'Combined report; Word/PDF/CSV; author letter EN/UR with approval', 'M', 'Word report, summary, letter (EN/UR) and CSV all return files.', 'P']
  ],
  'Module 4 — Paper Mill Detection': [
    ['4.1', 'Text signals: tortured phrases, templates, AI leftovers, vague methods', 'M', 'All four fire; 36/40 tortured phrases recalled; 0 false alarms on the correct terms.', 'M'],
    ['4.2', 'Reference signals', 'M', 'Fabricated (3), retracted and stacking signals fired.', 'M'],
    ['4.3', 'Author and submission signals', 'P', 'Author mill-retraction (by name), free-mail, ORCID, reviewers, authorship change all fired. Name-only matching remains; it is now labelled "probably other people" and weighted low. The affiliation-spread check exists but was not tested.', 'P'],
    ['4.4', 'Biology / data signals incl. phase 3', 'P', 'Cell lines (4 found). Phase 3 now built: impossible p-values and percentages found in standard formats; primer sanity checks work; live NCBI BLAST confirmed the GAPDH primer in 33 s. Gaps: some phrasings are missed and primer gene names can be misread (D21, D22).', 'P'],
    ['4.5', 'Duplicate submission check', 'M', 'Exact and lightly edited resubmissions found.', 'M'],
    ['4.6', 'Risk badge, evidence, notes, decision record, confidential export', 'M', 'LOW (clean) / HIGH (mill, score 34); decision saved; confidential Word export produced.', 'M']
  ],
  'Module 5 — Image Integrity Detection': [
    ['5.1', 'Extraction from docx/pdf/figure files; panel split; panel letters; figure type', 'P', 'Demo manuscript: 5 figures, 8 panels, labels "Fig. 1 … Fig. 5" read, types guessed. Panel-letter reading now exists but was not scored. TIFF not accepted.', 'P'],
    ['5.2', 'Duplication inside the manuscript', 'P', 'Perfect on planted copies; on real expert-annotated figures 54 of 102 known duplicate pairs found (53%, audit 1: 39%).', 'P'],
    ['5.3', 'Cloned areas inside one image', 'P', 'On real images 18 of 60 flagged (30%, audit 1: 9%); 16 located correctly.', 'P'],
    ['5.4', 'Forensic viewer', 'P', 'Viewer code and filters present; not driven filter by filter in this audit.', 'P'],
    ['5.5', 'Western blot and gel lane checks', 'P', 'A lane-comparison module now exists; real-figure splice recall is only 12% (9 of 77).', 'P'],
    ['5.6', 'Earlier figures: PJPS store; authors\' open-access figures', 'P', 'PJPS store works (earlier-manuscript and chart reuse match). The Europe PMC author-figure check is built (tab and job route present) but was not run against real authors.', 'P'],
    ['5.7', 'Optional ImageTwin / Proofig connection', 'X', 'Not connected; the report says so ("not checked"). Needs a vendor contract and API specification.', 'X'],
    ['5.8', 'Risk badge, side-by-side findings, marks, query letter, confidential export', 'M', 'Browser walk-through: HIGH, 9 findings in 4 categories, no console errors; decision, Word and PDF buttons present. The crash of audit 1 is gone.', 'P'],
    ['5.9', 'Runs as a background job', 'P', 'Deliberately runs in the editor\'s browser (4.5 MB Vercel limit); differs from the spec but works.', 'P']
  ],
  'Full Screening Report': [
    ['F1', 'One upload → five sections + summary + recommendation', 'M', '31 s on the demo manuscript; recommendation "Investigate" with four reasons.', 'M'],
    ['F2', 'Editor version (all) and author version (Modules 1–3)', 'M', 'Editor file mentions paper mill, image and "confidential"; the author file mentions none.', 'M'],
    ['F3', 'Navigation reduced to five modules', 'M', 'Confirmed in the browser: Home, Full Screening Report, five modules, saved reports, alerts, admin.', 'M']
  ]
};
function score(rows, k) { const c = { M: 0, P: 0, X: 0, N: 0 }; rows.forEach(r => c[r[k]]++); const n = c.M + c.P + c.X; return { ...c, n, pct: n ? Math.round((c.M + 0.5 * c.P) / n * 100) : 0 }; }
const sc = Object.fromEntries(Object.entries(REQ).map(([k, v]) => [k, score(v, 2)]));
const sc1 = Object.fromEntries(Object.entries(REQ).map(([k, v]) => [k, score(v, 4)]));
const coreRows = Object.entries(REQ).filter(([k]) => !k.startsWith('Shared')).flatMap(([, v]) => v);
const core = score(coreRows, 2), core1 = score(coreRows, 4);
const all = score(Object.values(REQ).flat(), 2), all1 = score(Object.values(REQ).flat(), 4);
console.log('core now', core, 'then', core1, 'all', all.pct, all1.pct);

// ------------------------------------------------------------------ audit-1 defects: status now
const FIX = { F: { text: 'Fixed', fill: C.met }, P: { text: 'Partly fixed', fill: C.part }, O: { text: 'Still open', fill: C.miss }, U: { text: 'Not re-tested', fill: C.na } };
const D1 = [
  ['D1', 'High', 'Module 5 results screen crashed ("catFilter is not defined")', 'F', 'Demo manuscript analysed in Chrome: results, 9 findings, no console errors.'],
  ['D2', 'High', 'Converter crashed on unparseable entries', 'F', 'All 7 source styles converted without a crash.'],
  ['D3', 'High', 'Claim check aborted for fabricated / retracted references', 'F', 'Fabricated ref → "could not verify"; retracted ref → flagged; the job finishes.'],
  ['D4', 'Medium', 'Module 3 Word report returned HTTP 500', 'F', 'HTTP 200, 10 KB file.'],
  ['D5', 'High', 'Converter silently dropped an author (Chicago)', 'F', 'Three authors kept.'],
  ['D6', 'Medium', 'Article-number locators misread (e1000097, BMJ n71)', 'P', 'PLoS e1000097 now Verified correctly; the BMJ wrong-volume case (370 vs 372) still passes as Verified.'],
  ['D7', 'Medium', 'Title with internal full stop cut early (Higuchi 1963)', 'F', 'Now Verified.'],
  ['D8', 'Medium', 'Converter journal abbreviations', 'P', '5 of 7 exact; Chicago keeps title case, Nature drops the issue.'],
  ['D9', 'Medium', 'Self-citation counted 0 for unmatched references', 'F', 'Rate 50%, two references found.'],
  ['D10', 'Medium', 'Invented words in a real title passed as Verified', 'F', 'Now Miscited (87%) naming the extra words.'],
  ['D11', 'Medium', 'Fake DOI stayed "Unverified"', 'F', 'Now Suspicious.'],
  ['D12', 'Medium', '"Not indexed" label never shown; real PJPS references risk "Suspicious"', 'O', 'Label still 0; a fabricated PJPS reference is Suspicious (40%) because PJPS is "well indexed" with 3,966 records.'],
  ['D13', 'Medium', 'Footnote citations missed; footnote text listed as fake reference', 'F', 'Footnote citation found; the uncited list has only the true one.'],
  ['D14', 'Medium', 'Author retractions matched by name only', 'P', 'Still by name; now labelled "probably other people" and low weight. ORCID matching not seen.'],
  ['D15', 'High', 'Real-figure sensitivity low (duplicates 39%, clones 9%, splices 14%)', 'P', 'Improved to 53%, 30%, 12%. Splice detection unchanged; false-alarm rate on clean images about 10% for clones and splices.'],
  ['D16', 'Low', 'Year off by one plus wrong last page stays Verified', 'O', 'Still Verified at 97% with a note.'],
  ['D17', 'Low', 'Reference merged with a wrapped line', 'U', 'The 27-reference list parsed as 27; the original case was not re-run.'],
  ['D18', 'Low', 'Misspelt author shown as "missing"', 'F', 'Reported as a spelling mismatch.'],
  ['D19', 'Low', 'Duplicate indicator listed every pair', 'F', '4 groups for 4 duplicate works.'],
  ['D20', 'Medium', 'Reference datasets load silently in the background', 'P', 'A warning routine now exists in the code; the first full load still took about 100 s after start-up and the warning was not seen on a report.']
];
const NEW = [
  ['D21', 'Medium', 'Module 4', 'Primer gene names misread when the sentence is "Primers for GAPDH were forward …": the gene becomes "were" or "and", so the BLAST gene check cannot match. Written as "GAPDH forward: …" it works.', 'Read the gene name from the nearest gene symbol, not the preceding word.'],
  ['D22', 'Low', 'Module 4', 'Statistics checks miss some phrasings: "7 of 20 rats (45%)" (noun between), "t = 0.2, df = 18, p = 0.0001", and a percentage above 100%.', 'Widen the patterns; add an out-of-range percentage rule.'],
  ['D23', 'Medium', 'Module 5', 'Clone and splice checks flag about 10% of clean real images (clones 24 of 231, 5 of them high; splices 13 of 130). Editors will see many "check this" cases.', 'Keep the screening-aid wording; consider hiding low-confidence cases by default.'],
  ['D24', 'Low', 'Module 5', 'TIFF figure files are not accepted although the specification lists them.', 'Add a TIFF decoder or tell users to convert.'],
  ['D25', 'Medium', 'Process', 'Three source files (reference.js, datasets.js, core.js) carry uncommitted changes that hold the fixes for D6/D7/D20 and a bad-file message. The audit ran on that working copy, not on the last commit. The browser screens still have no automated test.', 'Commit, then add one browser test per module screen.']
];

// ------------------------------------------------------------------ content
const kids = [];
const cnt = k => D1.filter(d => d[3] === k).length;
kids.push(new Paragraph({ spacing: { before: 1800, after: 120 }, children: [new TextRun({ text: 'PJPS Reference Checker', font: FONT, size: 56, bold: true, color: C.head })] }));
kids.push(new Paragraph({ spacing: { after: 360 }, children: [new TextRun({ text: 'Platform re-audit (second audit): completeness against the requirements, and accuracy of testing', font: FONT, size: 30, color: C.muted })] }));
kids.push(table([2600, 7866], ['Item', 'Detail'], [
  ['Prepared for', 'Project sponsor, Softsols Pakistan / PJPS Editor'],
  ['Prepared by', 'Project Manager (audit role), assisted by Claude'],
  ['Audit date', '26 October 2026'],
  ['Purpose', 'Re-test the whole platform after the development team reported all 20 defects of the first audit fixed and the open features built. This is a separate report from "PJPS-Platform-Audit-Report.docx" (audit 1, 25 October).'],
  ['Scope', 'Web portal: Modules 1–5 and the Full Screening Report. Desktop app excluded (project decision).'],
  ['Baseline', 'Requirements: docs/PJPS-Final-4-Modules.txt (rev. 2). Code: commit 46734a3 plus three uncommitted source changes (see D25), branch main.'],
  ['Environment', 'Local server, Node 24, embedded database, live internet to the reference databases and NCBI. Vercel deployment not tested.'],
  ['Classification', 'Confidential, internal']
]));
kids.push(spacer());
kids.push(p('No product code was changed. The audit test scripts from audit 1 were re-run unchanged; the only file added is this report generator.', { italics: true, color: C.muted }));

kids.push(h1('1. Executive summary'));
kids.push(p([t('Verdict: ', { bold: true }), t(`the platform is about ${core.pct}% complete against the requirements (audit 1: ${core1.pct}%) and is ready for a supervised pilot with editors, but not yet for unsupervised release.`, { bold: true }),
  t(' All five high-severity items of audit 1 are fixed or improved, reference-checking accuracy rose from 78% to 93%, and the image engine finds more real manipulation than before. What remains is smaller but real: image detection is still a screening aid with a high miss rate and about 10% false alarms on clean images, one vendor feature needs a contract, and a few accuracy gaps remain.')]));
kids.push(h2('Headline numbers'));
kids.push(table([3000, 1450, 1450, 4566], ['Measure', 'Audit 1', 'Audit 2', 'What it means'], [
  ['Requirement completeness, Modules 1–5 + Full Report', `${core1.pct}%`, { text: core.pct + '%', bold: true }, `Now ${core.M} of ${core.n} items fully met, ${core.P} partly, ${core.X} not met (audit 1: ${core1.M} / ${core1.P} / ${core1.X}). A partly met item counts as half.`],
  ['Including shared requirements', `${all1.pct}%`, { text: all.pct + '%', bold: true }, 'Shared requirements S1–S5: upload once, formats, roles, history, exports.'],
  ['Module 1 verdict accuracy', '78% (21/27)', { text: '93% (25/27)', bold: true }, 'Same 27 references. Genuine references wrongly flagged: 0 of 10 (was 2). Fabricated: 4 of 4 flagged. Retracted: 2 of 2. Two miscited references still pass as Verified.'],
  ['Module 2 rules / converter', '100% / 0%', { text: '100% / 71%', bold: true }, 'Compliance found 14/14 planted rule breaks; the converter gave the exact PJPS text for 5 of 7 source styles.'],
  ['Module 3 accuracy', '83%', { text: '83% claims; all consistency cases', bold: true }, '5/6 claim verdicts right; every planted consistency problem found, including the footnote citation.'],
  ['Module 4 accuracy', '10/10', { text: '10/10 signals; 36/40 phrases', bold: true }, 'Clean paper LOW; mill paper HIGH. Developer benchmark on real mill papers (not re-run): 4.7% caught by text signals.'],
  ['Module 5 on real figures (duplicates / clones / splices)', '39% / 9% / 14%', { text: '53% / 30% / 12%', bold: true }, 'Expert-annotated BioFors images. False alarms on clean images about 10% for clones and splices.'],
  ['Audit-1 defects (20)', '20 open', { text: `${cnt('F')} fixed, ${cnt('P')} partly, ${cnt('O')} open`, bold: true }, `${cnt('U')} not re-tested. Five new findings (D21–D25): none high, 3 medium, 2 low.`],
  ['Developer test suite (npm test)', 'All pass', { text: 'All pass', bold: true }, 'Passes in 27 s. Still no browser test of the module screens.']
]));
kids.push(h2('What the sponsor should know'));
kids.push(bt('Good: ', 'every blocking defect is fixed and was re-tested the same way it failed. Module 5 now shows its results; the converter does not crash or lose authors; fabricated and retracted citations no longer break claim checking; all exports work, including server-side PDF; one upload now serves all modules.'));
kids.push(bt('Honest limits: ', 'Module 5 finds about half of real duplicated pairs, under a third of cloned areas and one in eight spliced areas. "No findings" must never be read as "clean". Module 4 text signals catch about 1 in 20 real paper-mill papers.'));
kids.push(bt('Still open: ', 'the ImageTwin/Proofig connection (needs a contract), the "Not indexed" label for regional journals, and two miscitation types that pass as Verified.'));
kids.push(bt('Process: ', 'part of the fixes sits in uncommitted files, so a deployment from the last commit would lack them. Commit before any release.'));
kids.push(h2('Recommendation'));
kids.push(p('Approve a two-week pilot with 2–3 editors on real submissions, after committing the pending changes and fixing D21 and D6 (about 2–3 working days). Position Module 5 as a screening aid in all training and wording. Decide on the vendor connection only after the pilot shows how many findings editors actually act on.'));

kids.push(h1('2. Audit approach and its limits'));
kids.push(p('The same known-answer method as audit 1 was used so that results are comparable: inputs with a known correct answer were run through the real code and databases and the outcome compared with the expected one. New in this round: phase-3 statistics and primer checks, a live NCBI BLAST call, and the Module 5 benchmark on real figures was re-run.'));
kids.push(table([2300, 4200, 3966], ['Module', 'Test set (ground truth)', 'Method'], [
  ['1 Bibliography', 'The same 27 references (10 genuine, 4 miscited, 4 fabricated, 1 invented words, 1 wrong DOI, 2 retracted, 2 regional, duplicates) plus 4 regional-journal articles, a predatory journal, garbled text, BibTeX/RIS and file formats', 'Live API run, 12 databases'],
  ['2 Style / converter', '14 references with one planted break each; 8 in-text rules; 7 source styles of one known work; a numbered Word file', 'Engine and API; Word file unzipped'],
  ['3 Citations', 'Word manuscript with planted errors (missing, uncited, year, ambiguous, et al., table, footnote, misspelling); numbered manuscript; a real arXiv PDF and an open-access article as sources; fabricated and retracted references', 'API runs, each verdict scored'],
  ['4 Paper mill', 'Clean and mill manuscripts with planted signals; resubmissions; authorship change; 40 tortured phrases; invented statistics and primers; a live BLAST', 'API and direct tests, datasets loaded (Retraction Watch 64,343; screener 8,993; Beall 2,920)'],
  ['5 Images', 'Developer planted tests; demo manuscript in Chrome; BioFors real figures (40 papers, 102 duplicate pairs, 60 clone and 77 splice images, 231 and 130 clean images)', 'Browser walk-through; benchmark script re-run (reproduced the developer\'s stored duplicate result exactly)'],
  ['Full report, admin', 'Demonstration manuscript; exports; history; user creation and roles', 'API runs']
]));
kids.push(h2('Limits of this audit (read before relying on the numbers)'));
kids.push(bullet('The test sets are small and written by me; one reference moves Module 1 by 3.7 points. Percentages are indicative, not statistical estimates.'));
kids.push(bullet('Only Module 5 and general navigation were driven through the browser; Modules 1–4 were tested at API level. The project has no automated browser test.'));
kids.push(bullet('Genuine .doc and .odt files were not available; only invalid stand-ins were tried. Large uploads, load, e-mail alerts and the Vercel deployment were not tested.'));
kids.push(bullet('The audit ran on the working copy, which includes three uncommitted source edits (D25).'));
kids.push(bullet('The Module 4 real-paper benchmark (4.7% / 1.6%) is the developer\'s and was not re-run. The Module 5 benchmark was re-run and matched the developer\'s stored file for duplicates; the clone and splice clean-image samples are larger here (231 and 130 images against the developer\'s stored 81 and 42), so their false-alarm rates differ.'));
kids.push(bullet('The Module 3 PDF test needed a real PDF; the arXiv paper was downloaded for it.'));
kids.push(bullet('A "pass" on planted examples does not predict real-world performance, which is why real-figure and real-reference results are reported separately.'));

kids.push(h1('3. Completeness against the requirements'));
kids.push(p('Each numbered item of the requirement document was marked Met, Partial or Not met after testing; the last column shows the result of audit 1 for comparison. Met counts 1, Partial 0.5.'));
kids.push(table([3066, 900, 900, 900, 1100, 1600, 2000], ['Area', 'Met', 'Partial', 'Not met', 'Out of scope', 'Audit 2', 'Audit 1'], Object.entries(sc).map(([k, v]) => [k, { text: String(v.M), align: AlignmentType.CENTER }, { text: String(v.P), align: AlignmentType.CENTER }, { text: String(v.X), align: AlignmentType.CENTER }, { text: String(v.N), align: AlignmentType.CENTER }, { text: v.pct + '%', bold: true, fill: v.pct >= 80 ? C.met : v.pct >= 55 ? C.part : C.miss }, { text: sc1[k].pct + '%', align: AlignmentType.CENTER }]).concat([[{ text: 'All items', bold: true }, { text: String(all.M), align: AlignmentType.CENTER }, { text: String(all.P), align: AlignmentType.CENTER }, { text: String(all.X), align: AlignmentType.CENTER }, { text: String(all.N), align: AlignmentType.CENTER }, { text: all.pct + '%', bold: true }, { text: all1.pct + '%', align: AlignmentType.CENTER }]])));
kids.push(spacer());
kids.push(p('Completeness measures what is built. It does not measure how well it works: accuracy is in section 4 and defects in section 5. A Partial item in Module 5 usually means "built, but detection rates on real figures are modest".', { italics: true, color: C.muted }));
for (const [area, rows] of Object.entries(REQ)) {
  kids.push(h2(area));
  kids.push(table([620, 2600, 1000, 5446, 800], ['Ref', 'Requirement', 'Status', 'Evidence from testing', 'Audit 1'], rows.map(r => [r[0], r[1], ST[r[2]], r[3], ST[r[4]]])));
}

kids.push(h1('4. Accuracy of testing: results by module'));
kids.push(h2('Module 1 — Check Bibliography (same 27 references as audit 1)'));
kids.push(table([2300, 900, 1500, 1700, 4066], ['Case type', 'Count', 'Audit 1', 'Audit 2', 'What happened now'], [
  ['Genuine, correctly cited', '10', '8', { text: '10', fill: C.met }, 'Higuchi (title with a full stop) and Moher (e-locator) now Verified.'],
  ['Genuine, hard format / junk DOI', '2', '2', { text: '2', fill: C.met }, 'Verified; junk DOI flagged with the correct DOI supplied.'],
  ['Miscited (wrong year, volume, pages)', '4', '2', { text: '2', fill: C.part }, 'Volume and year errors caught. Year off by one with a wrong last page, and a wrong BMJ volume (370 vs 372), still Verified (D16, D6).'],
  ['Fabricated (incl. fake DOI)', '4', '2 Suspicious', { text: '4 Suspicious', fill: C.met }, 'The fake-DOI reference is now Suspicious (56%).'],
  ['Real title + invented words', '1', '0', { text: '1', fill: C.met }, 'Miscited (87%) naming the invented words.'],
  ['Real work, wrong DOI', '1', '1', { text: '1', fill: C.met }, 'Miscited.'],
  ['Retracted', '2', '2', { text: '2', fill: C.met }, 'Both Retracted at 99%.'],
  ['Regional journal (fictional refs) and duplicate', '3', '3', { text: '3', fill: C.met }, 'Accepted outcomes; the "Not indexed" label is still absent (D12).'],
  [{ text: 'Overall', bold: true }, '27', '21 (78%)', { text: '25 (93%)', bold: true }, 'Both failures are miscited references passing as Verified: no genuine reference was rejected and no fabricated one was accepted.']
]));
kids.push(spacer());
kids.push(p('Four real regional-journal articles (PJPS and similar): 2 Verified, 1 Miscited (first page), 1 Suspicious. The Suspicious one is a fabricated PJPS reference, as intended, but it shows the D12 risk for real PJPS references missing from international databases. Extra checks passed: age chart and threshold, Beall-listed journal flagged high-risk, self-citation measured (50%), garbled text 4/4, BibTeX and RIS import, five exports, re-check.'));
kids.push(h2('Module 2 — Style check and converter'));
kids.push(table([4300, 2000, 4166], ['Test', 'Result', 'Comment'], [
  ['Compliance: one planted break per reference', { text: '14 / 14', fill: C.met }, 'No false alarms on the two compliant references.'],
  ['In-text format rules', { text: '6 / 6', fill: C.met }, 'Comma, "and", "et al.,", semicolon, author count versus et al.'],
  ['List order and a/b suffix', { text: '2 / 2', fill: C.met }, ''],
  ['Converter, 7 source styles → exact PJPS text', { text: '5 / 7 (audit 1: 0 / 7)', fill: C.part }, 'APA, Vancouver, Harvard, IEEE, AMA exact. Chicago keeps title case; Nature drops the issue number. No crash, no lost author.'],
  ['Word round trip', { text: 'Pass', fill: C.met }, '4 citations converted to (Author, Year); list sorted A–Z; untouched sentence unchanged.'],
  ['Track Changes', { text: 'Pass', fill: C.met }, '7 insertions and 7 deletions on; none off.'],
  ['Fill missing fields from the matched record', { text: 'Not shown', fill: C.part }, '0 of 3 references matched in the test run, so this could not be demonstrated.']
]));
kids.push(h2('Module 3 — Citations'));
kids.push(table([4300, 2000, 4166], ['Test', 'Result', 'Comment'], [
  ['Missing from list (3 planted, incl. footnote and table)', { text: '3 / 3', fill: C.met }, 'Audit 1: the footnote citation was missed.'],
  ['Uncited reference', { text: '1 / 1, no false extra', fill: C.met }, 'The footnote artefact is gone.'],
  ['Year mismatch, ambiguous 2020a/b, et al. misuse', { text: '3 / 3', fill: C.met }, ''],
  ['Misspelt author', { text: '1 / 1', fill: C.met }, 'Reported as a spelling mismatch (audit 1: "missing").'],
  ['Numbered: [9] pointing to nothing; unused numbers', { text: '2 / 2', fill: C.met }, 'One order issue reported.'],
  ['Claim support vs real PDF and open-access article', { text: '5 / 6', fill: C.part }, 'Full, number-mismatch and unsupported verdicts right; a claim that contradicts the paper ("relies on recurrent networks") is Partial (46%) and quotes a passage about convolutions. Page numbers and quotes shown.'],
  ['Fabricated and retracted references in a claim check', { text: 'Pass', fill: C.met }, 'The job completes: fabricated → "could not verify" with a note; retracted → red flag, "unsupported".'],
  ['Pattern flags', { text: '6 flags + 2 blocks', fill: C.met }, 'Self-citation, concentration, stacking, off-topic.'],
  ['Exports', { text: '6 / 6', fill: C.met }, 'Letter EN and UR, letter Word, summary Word, CSV and Word report.']
]));
kids.push(h2('Module 4 — Paper Mill Detection'));
kids.push(table([4300, 2000, 4166], ['Test', 'Result', 'Comment'], [
  ['Clean manuscript stays LOW', { text: 'LOW (0)', fill: C.met }, 'No false signal.'],
  ['Mill manuscript, 10 planted signals', { text: '10 / 10', fill: C.met }, 'Risk HIGH, score 34. Author mill-retraction fired once the Retraction Watch data had loaded. The hidden-character signal fired (1 mixed-alphabet word); the audit script\'s own check wrongly reports it as missing.'],
  ['Duplicate submission: exact and lightly edited', { text: 'Both found', fill: C.met }, ''],
  ['Authors added/removed between versions', { text: 'Found', fill: C.met }, 'Name-only retractions are now labelled "probably other people".'],
  ['40 random tortured phrases', { text: '36 / 40 (90%)', fill: C.met }, '0 false alarms on correct terms. Missed: protein work, co-reconciliation, warmth transport, loads and predispositions.'],
  ['Phase 3: impossible statistics', { text: 'Works in common formats', fill: C.part }, 'Caught: t, χ² and F with a wrong p; "7/20 (45%)", "12 of 40 (60%)". Missed: "7 of 20 rats (45%)", "t = 0.2, df = 18", 130% (D22). No false alarm on the correct example.'],
  ['Phase 3: primers and BLAST', { text: 'Works', fill: C.met }, 'Poly-A and repeat primers flagged; the GAPDH primer was confirmed by live NCBI BLAST in 33 s ("matches the named gene"). Gene name misread in one phrasing (D21).'],
  ['Reviewer blocked from Module 4/5', { text: 'Blocked', fill: C.met }, '403/404 on all probes.'],
  ['Developer benchmark (150 retracted vs 126 normal papers)', { text: '4.7% / 1.6%', fill: C.part }, 'Not re-run. Text signals alone catch about 1 in 20 real mill papers, with 1.6% false alarms; honestly stated in docs/benchmark-papermill.md.']
]));
kids.push(h2('Module 5 — Image Integrity Detection'));
kids.push(table([3200, 2300, 4966], ['Test', 'Result', 'Comment'], [
  ['Developer tests: planted copies, clones, AI markers, charts, demo check', { text: 'All pass', fill: C.met }, 'Rotated, mirrored, resized and partial copies found; 0 false alarms between unrelated panels.'],
  ['Demonstration manuscript in Chrome', { text: 'HIGH, 9 findings', fill: C.met }, '5 figures, 8 panels, 5 strong findings, 4 to check; categories a–d all populated; no console errors. (Audit 1: crash.)'],
  ['Real duplicate pairs (BioFors, 40 papers, 102 pairs)', { text: '54 / 102 (53%)', fill: C.part }, '40 rated high. Audit 1: 39%. 134 further reports (some may be unlabelled genuine duplicates).'],
  ['Real cloned regions (60 images)', { text: '18 / 60 (30%)', fill: C.miss }, '16 located; 8 high. Audit 1: 9%. On 231 clean images: 24 flagged (10.4%), 5 high (2.2%).'],
  ['Real spliced regions (77 images)', { text: '9 / 77 (12%)', fill: C.miss }, '4 located; none high. On 130 clean images: 13 flagged (10%), 1 high.'],
  ['Unrelated blots and microscopy (251 images, 16,815 pairs)', { text: '2 reports', fill: C.met }, 'Blots 0; microscopy 2 medium reports (textures). None high.']
]));
kids.push(p('Reading: duplicate detection is now reasonable (about half of real pairs); clone and splice detection are weak and noisy. The report text already states these are screening aids; the proposal and training should state the rates above too.', { after: 80 }));
kids.push(h2('Full Screening Report and administration'));
kids.push(bullet('Demonstration manuscript: 31 seconds (audit 1: 97 s). Front page: 2 verified, 1 miscited, 3 suspicious, 1 retracted of 7 references; 29% PJPS-compliant; 1 missing and 1 uncited citation; paper mill HIGH; recommendation "Investigate" with four reasons. The image line reads "not checked" until a Module 5 report is attached, as designed.'));
kids.push(bullet('Word exports: editor version, author version, decision summary, letter, reference report, CSV, BibTeX, RIS, corrected list and server PDF all produced. The author version contains no paper-mill or image text.'));
kids.push(bullet('Administration: editor created with default module permissions, duplicate e-mail refused (409), age rule and tortured-phrase list editable, audit log and statistics available, revision comparison works.'));

kids.push(h1('5. Defect register'));
kids.push(h2('5.1 Defects from audit 1: status now'));
kids.push(table([620, 900, 3800, 1200, 3946], ['ID', 'Severity', 'Defect', 'Status', 'Evidence in this audit'], D1.map(d => [d[0], SEV[d[1]], d[2], FIX[d[3]], d[4]])));
kids.push(spacer());
kids.push(p(`Summary: ${cnt('F')} fixed, ${cnt('P')} partly fixed, ${cnt('O')} still open, ${cnt('U')} not re-tested. Of the five High items, four are fixed (D1, D2, D3, D5) and one is improved but open (D15, image sensitivity).`));
kids.push(h2('5.2 New findings'));
kids.push(p('Severity: High = a feature fails or data is silently wrong in normal use. Medium = wrong results in some cases or a missing promised behaviour. Low = cosmetic or edge case.'));
kids.push(table([620, 900, 1100, 5146, 2700], ['ID', 'Severity', 'Module', 'Finding', 'Suggested fix'], NEW.map(d => [d[0], SEV[d[1]], d[2], d[3], d[4]])));

kids.push(h1('6. Project risks'));
kids.push(table([3000, 1300, 6166], ['Risk', 'Level', 'Why and what to do'], [
  ['Overstated detection accuracy (images, paper mill)', { text: 'High', fill: C.hi }, 'Planted tests pass at 100%; real-figure rates are 12–53% and real mill papers are caught about 1 in 20 by text alone. Publish the real numbers; do not compare with ImageTwin or Proofig, which were not tested.'],
  ['No browser-level tests', { text: 'High', fill: C.hi }, 'D1 shipped once despite a passing suite. Add one browser test per module screen before further releases.'],
  ['Fixes not committed', { text: 'Medium', fill: C.med }, 'D25: a deployment from the last commit would lose the fixes for D6, D7 and the dataset loader time-out.'],
  ['Dependence on third-party services', { text: 'Medium', fill: C.med }, 'Crossref, PubMed, OpenAlex, Retraction Watch and NCBI BLAST (33 s per primer). Free APIs may rate-limit under editor load. Datasets take about 100 s to load after a cold start.'],
  ['Regional journal coverage', { text: 'Medium', fill: C.med }, 'PJPS has sparse records in international databases; real PJPS references may be called Suspicious (D12).'],
  ['False alarms in image screening', { text: 'Medium', fill: C.med }, 'About 10% of clean images raise a clone or splice flag (D23). Editor time and trust are at stake.'],
  ['Name-based author matching', { text: 'Medium', fill: C.med }, 'Risk of implicating authors with common names. Wording is cautious and weight is low; keep it that way.'],
  ['Vercel limits', { text: 'Medium', fill: C.med }, '4.5 MB upload limit (images analysed in the browser); cron-driven dataset refresh. Not tested.'],
  ['Vendor connection and desktop app', { text: 'Low', fill: C.low }, 'ImageTwin/Proofig needs a contract and API specification; the desktop app is out of scope by decision.']
]));

kids.push(h1('7. Recommended plan'));
kids.push(p('Effort figures are my estimates for one developer who knows the code; they are not commitments.'));
kids.push(table([1500, 5766, 1500, 1700], ['Phase', 'Work', 'Items', 'Estimate'], [
  ['A. Secure the fixes', 'Commit the pending changes; add one browser test per module screen; re-run the audit scripts.', 'D25', '1–2 days'],
  ['B. Close accuracy gaps', 'BMJ-style volume check and year-plus-pages rule (D6, D16); regional-journal handling (D12); primer gene name (D21); statistics phrasings (D22); converter title case and issue (D8); ORCID matching (D14).', 'Open defects', '4–6 days'],
  ['C. Image tuning', 'Reduce clone/splice false alarms (D23); improve splice recall on BioFors; TIFF input (D24).', 'D15, D23, D24', '1–2 weeks'],
  ['D. Pilot', 'Two weeks with 2–3 editors on real submissions; record each finding as confirmed / false alarm; compare with what editors found themselves.', 'Validation', '2 weeks'],
  ['E. Vendor', 'Decide on ImageTwin or Proofig after the pilot; sign the contract first.', '5.7', 'Decide after pilot']
]));
kids.push(h2('Decisions needed from the sponsor'));
kids.push(bullet('Approve the pilot, conditional on Phase A.'));
kids.push(bullet('Confirm the PJPS house style against the current author guidelines (the specification says so); it decides the journal-abbreviation form used by Modules 1–2.'));
kids.push(bullet('Confirm Module 5 is positioned as a screening aid, not a replacement for a commercial tool.'));
kids.push(bullet('Agree a pilot success measure, for example no confirmed false accusation and at least one real finding the editor had not already seen.'));

kids.push(h1('8. Appendix: how to repeat the tests'));
kids.push(table([3600, 6866], ['Script', 'Purpose'], [
  ['npm test', 'Developer suite (permissions, Modules 2/4/5, image engine, forensics, demo check).'],
  ['node test/audit-m1.js, audit-m1b.js', 'Module 1 accuracy (27 references) and supplementary checks. Needs internet.'],
  ['node test/audit-m23.js', 'Module 2 compliance and converter; Module 3 consistency (incl. footnote).'],
  ['node test/audit-m3b.js, audit-m3c.js', 'Module 3 claim support. audit-m3c needs vaswani.pdf (arXiv 1706.03762) in the output folder.'],
  ['node test/audit-m4.js, audit-full.js', 'Module 4 planted signals, duplicates, tortured phrases, role blocking; Full Screening Report, exports, administration.'],
  ['node scripts/benchmark-images.mjs --docs 40', 'Module 5 on BioFors real figures (overwrites data/benchmark/images-results.json: copy it first).'],
  ['Environment variables AUDIT_DB, AUDIT_OUT', 'AUDIT_DB is a folder for a persistent test database so the large datasets load once (about 100 s); without it the first dataset-dependent checks run on empty data. AUDIT_OUT is where result files are written.']
]));
kids.push(spacer());
kids.push(p('Test data note: Retraction Watch matches used publicly listed author names for one planted test only; no personal findings are reported here.', { italics: true, color: C.muted }));

const doc = new Document({
  creator: 'PJPS audit', title: 'PJPS Reference Checker — Platform Re-audit',
  styles: { default: { document: { run: { font: FONT, size: 21 } } } },
  numbering: { config: [{ reference: 'b', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] }] },
  sections: [{
    properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, bottom: 1080, left: 720, right: 720 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'PJPS Reference Checker re-audit · Confidential · page ', font: FONT, size: 16, color: C.muted }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: C.muted })] })] }) },
    children: kids
  }]
});
const out = process.argv[2] || path.join(__dirname, 'PJPS-Platform-Re-Audit-Report.docx');
Packer.toBuffer(doc).then(b => { fs.writeFileSync(out, b); console.log('written', out, b.length); });
