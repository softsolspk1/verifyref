// docs/build-audit-report-2026-11-06.js - builds docs/PJPS-Full-Audit-Report-2026-11-06.docx: every feature of Modules 1-5,
// the Full Screening Report and the Similarity Report checked from the start, with the measured accuracy of each, the
// gaps found and fixed on 6 November 2026, the speed of a Full Screening and what still limits accuracy. Every figure
// comes from docs/audit-results-2026-11-06.json (ground-truth audits, benchmarks and test runs of that date; logs in
// D:\pjps-tmp\audit-2026-11-06).
// Run: node docs/build-audit-report-2026-11-06.js [output.docx]
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, AlignmentType, WidthType, ShadingType,
  BorderStyle, LevelFormat, Header, Footer, PageNumber, TableOfContents, PageBreak
} = require('docx');

const R = require('./audit-results-2026-11-06.json');

const FONT = 'Calibri';
const NAVY = '1F3864';
const PAGE_W = 11906, MARGIN = 1134, CONTENT = PAGE_W - 2 * MARGIN; // A4, 2 cm margins
const TONE = { ok: 'E2EFDA', warn: 'FFF2CC', bad: 'FCE4D6', na: 'EDEDED' };
const STATUS = { ok: ['Works', 'ok'], fixed: ['Fixed 6 Nov', 'ok'], limit: ['Works, limited', 'warn'], weak: ['Weak', 'bad'], na: ['Not built (PJPS decision)', 'na'], ext: ['Needs a key / membership', 'na'] };

const run = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 21, bold: o.bold, italics: o.italics, color: o.color });
const p = (text, o = {}) => new Paragraph({ spacing: { after: o.after ?? 120, line: 276 }, alignment: o.align, keepNext: o.keepNext, children: Array.isArray(text) ? text : [run(text, o)] });
const h1 = t => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun({ text: t })] });
const h2 = t => new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun({ text: t })] });
const bullet = (text, level = 0) => new Paragraph({ numbering: { reference: 'bullets', level }, spacing: { after: 60, line: 264 }, children: Array.isArray(text) ? text : [run(text)] });
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
/** Feature table: [no, feature, how it was checked, result / accuracy, status key] */
const features = rows => table(['No.', 'Feature', 'How it was checked', 'Result and accuracy', 'Status'], rows.map(([n, f, how, res, st]) => [n, f, how, res, STATUS[st]]), [7, 22, 25, 34, 12]);

const children = [];
const add = (...x) => children.push(...x);

// ------------------------------------------------------------------ cover and contents
add(
  p('', { after: 1800 }),
  p([run('PJPS Data Integrity System', { size: 44, bold: true, color: NAVY })], { align: AlignmentType.CENTER }),
  p([run('Full Audit Report: Modules 1 to 5', { size: 34, color: NAVY })], { align: AlignmentType.CENTER, after: 400 }),
  p([run('Every feature checked from the start, the accuracy of each, the gaps fixed and the speed of a Full Screening', { size: 24 })], { align: AlignmentType.CENTER }),
  p([run('Pakistan Journal of Pharmaceutical Sciences', { size: 24 })], { align: AlignmentType.CENTER, after: 1200 }),
  p([run(`Audit date: ${R.date}`, { size: 22 })], { align: AlignmentType.CENTER }),
  p([run(`System version: ${R.version} (web portal; the Windows desktop application uses the same code)`, { size: 22 })], { align: AlignmentType.CENTER }),
  p([run('Prepared by Softsols Pakistan', { size: 22 })], { align: AlignmentType.CENTER }),
  new Paragraph({ children: [new PageBreak()] }),
  p([run('Contents', { size: 30, bold: true, color: NAVY })], { after: 140 }),
  new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),
  p([run('Right-click the table and choose Update Field to refresh the page numbers.', { italics: true, size: 18, color: '7F7F7F' })])
);

// ------------------------------------------------------------------ 1. summary
add(
  h1('1. Summary'),
  p(`Every feature of the five modules, the Full Screening Report and the Similarity Report was checked again from the start on ${R.date}: ${R.counts.features} features in all, each against test cases whose correct answer is known in advance, a published benchmark, or both. ${R.counts.fixed} gaps found during the audit were fixed the same day and measured again. The table gives each module's headline figure; sections 3 to 9 list every feature with its result and section 10 what would raise accuracy further.`),
  table(['Module', 'Measured accuracy (6 Nov 2026)', 'Rating', 'Main limit'], R.summary.map(r => [r.module, r.result, [r.rating, r.tone], r.limit]), [18, 44, 11, 27]),
  gap(),
  p([run('What "accuracy" means. ', { bold: true }), run('Modules 1 to 3 give one correct answer per case, so accuracy is the share answered correctly. Modules 4 and 5 and the Similarity Report are screening aids, measured by detection (the share of real problems found) and false alarms (the share of clean papers or images flagged). A perfect score on N cases means the true error rate is below about 3/N (95% confidence).')]),
  h2('1.1 Gaps found and fixed on 6 November'),
  table(['Gap found', 'Effect before the fix', 'Fix and result'], R.fixes.map(f => [f.gap, f.before, [f.after, 'ok']]), [26, 34, 40]),
  gap(),
  h2('1.2 Speed of a Full Screening'),
  p(R.speed.intro),
  table(['Step', 'Before (5 Nov)', 'After (6 Nov)', 'What changed'], R.speed.rows, [22, 14, 14, 50]),
  gap(),
  p(R.speed.note)
);

// ------------------------------------------------------------------ 2. method
add(
  h1('2. How the audit was done'),
  table(['Kind of check', 'What was run on 6 November 2026'], R.method, [24, 76]),
  gap(),
  p([run('Conditions on the day. ', { bold: true }), run(R.conditions)])
);

// ------------------------------------------------------------------ 3. features by module
const sections = [
  ['3. Module 1: Check Bibliography', R.m1],
  ['4. Module 2: Reference Style Check and PJPS Converter', R.m2],
  ['5. Module 3: Citations', R.m3],
  ['6. Module 4: Paper Mill Detection (editor only)', R.m4],
  ['7. Module 5: Image Integrity Detection (editor only)', R.m5],
  ['8. Similarity Report (inside the Full Screening)', R.sim],
  ['9. Full Screening Report and shared functions', R.full]
];
for (const [title, m] of sections) {
  add(h1(title), p(m.intro));
  if (m.tables) for (const t of m.tables) add(h2(t.title), table(t.headers, t.rows, t.widths), gap(), ...(t.note ? [p(t.note)] : []));
  add(h2(m.featuresTitle || 'Every feature'), features(m.features), gap());
  if (m.limits?.length) { add(h2('Honest limits')); for (const l of m.limits) add(bullet(l)); }
}

// ------------------------------------------------------------------ 10. what would raise accuracy
add(
  h1('10. What would raise accuracy further'),
  p('In order of effect. Items marked "PJPS" need a decision, an account or data from PJPS; the others are development work.'),
  table(['Priority', 'Action', 'Module', 'Expected effect'], R.next, [10, 44, 14, 32]),
  gap(),
  h1('11. Test suite'),
  p(R.suite)
);

const doc = new Document({
  creator: 'Softsols Pakistan', title: 'PJPS Full Audit Report, Modules 1 to 5', description: `Full audit of ${R.date}`,
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 30, bold: true, color: NAVY, font: FONT }, paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, color: NAVY, font: FONT }, paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 } }
    ]
  },
  numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }, { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 270 } } } }] }] },
  features: { updateFields: true },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN } } },
    headers: { default: new Header({ children: [p([run('PJPS Data Integrity System — Full Audit Report, ' + R.date, { size: 16, color: '7F7F7F' })], { align: AlignmentType.RIGHT, after: 0 })] }) },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], font: FONT, size: 16, color: '7F7F7F' })] })] }) },
    children
  }]
});

const out = process.argv[2] || path.join(__dirname, 'PJPS-Full-Audit-Report-2026-11-06.docx');
Packer.toBuffer(doc).then(buf => { fs.writeFileSync(out, buf); console.log(`Written ${out} (${buf.length} bytes)`); });
