// build-proposal-4modules.js - generates docs/PJPS-4-Modules-Proposal.docx  (node docs/build-proposal-4modules.js)
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType,
  BorderStyle, ShadingType, LevelFormat, Header, Footer, PageNumber, TableOfContents, VerticalAlign
} = require('docx');

const BRAND = '0B4F6C', ACCENT = '1F8A70', MUTED = '5B6B7A';
const W = 9638; // A4 width minus 2 cm margins, in DXA
const FONT = 'Calibri';

const t = (text, o = {}) => new TextRun({ text, font: FONT, size: o.size || 22, bold: o.bold, italics: o.italics, color: o.color });
const p = (text, o = {}) => new Paragraph({
  children: Array.isArray(text) ? text : [t(text, o)],
  alignment: o.align, spacing: { after: o.after ?? 120, before: o.before ?? 0, line: 288 }
});
const h1 = text => new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun({ text, font: FONT })] });
const h2 = text => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text, font: FONT })] });
const bullets = (items, level = 0) => items.map(it => new Paragraph({
  numbering: { reference: 'bullets', level },
  spacing: { after: 60, line: 276 },
  children: Array.isArray(it) ? it : typeof it === 'object' ? [t(it.b, { bold: true }), t(` — ${it.d}`)] : [t(it)]
}));
const numbered = items => items.map(it => new Paragraph({ numbering: { reference: 'steps', level: 0 }, spacing: { after: 60 }, children: [t(it)] }));

const border = { style: BorderStyle.SINGLE, size: 4, color: 'C3CCD5' };
const borders = { top: border, bottom: border, left: border, right: border };
function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = W / total;
  const cols = widths.map(w => Math.round(w * scale));
  cols[cols.length - 1] += W - cols.reduce((a, b) => a + b, 0);
  const mk = (text, i, header, shade) => new TableCell({
    width: { size: cols[i], type: WidthType.DXA },
    borders,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: BRAND } : shade ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F4F7F9' } : undefined,
    children: String(text).split('\n').map(line => new Paragraph({ spacing: { after: 0 }, children: [t(line, { size: 19, bold: header, color: header ? 'FFFFFF' : undefined })] }))
  });
  return new Table({
    width: { size: W, type: WidthType.DXA },
    columnWidths: cols,
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => mk(h, i, true)) }),
      ...rows.map((r, ri) => new TableRow({ children: r.map((c, i) => mk(c, i, false, ri % 2 === 1)) }))
    ]
  });
}
const gap = () => p('', { after: 120 });
const note = text => new Paragraph({
  spacing: { before: 80, after: 160 },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 8 } },
  shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF7F3' },
  children: [t(text, { size: 20, italics: true })]
});

// ------------------------------------------------------------------ content

const today = '24 October 2026';
const TITLE = 'PJPS Reference Checker — Five-Module Proposal';
const feat = rows => table(['Feature', 'Description', 'Status'], rows, [1.6, 4.6, 1]);

const cover = [
  p('', { after: 1800 }),
  p([t('SOFTSOLS PAKISTAN', { bold: true, color: ACCENT, size: 24 })], { after: 200 }),
  p([t('PJPS Reference Checker', { bold: true, color: BRAND, size: 64 })], { after: 120 }),
  p([t('Five-Module Manuscript Screening System', { color: BRAND, size: 32 })], { after: 480 }),
  new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 1 } }, spacing: { after: 360 }, children: [] }),
  p([t('Proposal for Approval', { bold: true, size: 28 })], { after: 120 }),
  p([t('Prepared for: ', { bold: true }), t('The Editor, Pakistan Journal of Pharmaceutical Sciences (PJPS)')]),
  p([t('Prepared by: ', { bold: true }), t('Softsols Pakistan')]),
  p([t('Date: ', { bold: true }), t(today)]),
  p([t('Version: ', { bold: true }), t('2.1')]),
  p('', { after: 2400 }),
  p([t('Confidential — prepared for PJPS. Not for redistribution.', { italics: true, color: MUTED, size: 18 })])
];

const docControl = [
  p([t('Document control', { bold: true, color: ACCENT, size: 27 })], { before: 120 }),
  table(['Version', 'Date', 'Author', 'Change'], [
    ['1.0', '21 October 2026', 'Softsols Pakistan', 'Full platform proposal (all tools)'],
    ['2.0', today, 'Softsols Pakistan', 'Scope reduced to the four modules requested by the PJPS Editor; Paper Mill Detection added'],
    ['2.1', today, 'Softsols Pakistan', 'Module 5 — Image Integrity Detection added (benchmarked against ImageTwin and Proofig)']
  ], [1, 1.5, 2, 4]),
  gap(),
  p([t('Contents', { bold: true, color: ACCENT, size: 27 })], { before: 240 }),
  new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' })
];

const exec = [
  h1('1. Executive summary'),
  p('Fake and AI-generated references, wrongly cited sources, retracted papers, references that don’t follow the journal style, paper-mill manuscripts and duplicated or edited figures now reach PJPS in every submission batch. Checking them by hand takes an editor hours per manuscript, and many problems are only found after publication.'),
  p('At the Editor’s request, this proposal narrows the PJPS Reference Checker to five modules:'),
  table(['#', 'Module', 'What it answers'], [
    ['1', 'Check Bibliography', 'Is every reference real, correct and not retracted?'],
    ['2', 'Reference Style Check & PJPS Converter', 'Do the references follow PJPS style? If not, convert them.'],
    ['3', 'Citations', 'Do in-text citations match the reference list, and does each source support its claim?'],
    ['4', 'Paper Mill Detection', 'Does this manuscript show signs of coming from a paper mill?'],
    ['5', 'Image Integrity Detection', 'Are any figures duplicated, reused or edited?']
  ], [0.4, 2.4, 4.6]),
  gap(),
  p('A single Full Screening Report runs all five modules on one upload and gives the editor a one-page summary with a desk-review recommendation.'),
  note('Recommendation: build on the existing PJPS Reference Checker instead of starting again. Most of Modules 1–3 already exist and work; all other tools will be switched off and removed from the menu. The new work goes where it adds the most value: the PJPS style compliance check, Paper Mill Detection and Image Integrity Detection.')
];

const approach = [
  h1('2. Approach: modify the existing software'),
  h2('2.1 Why not build a new system'),
  ...bullets([
    { b: 'Proven core', d: 'the reference engine already checks 12 scholarly databases (Crossref, PubMed, Europe PMC, OpenAlex, Semantic Scholar, DataCite and others) plus Retraction Watch.' },
    { b: 'PJPS style already defined', d: 'the style engine already contains the PJPS house style and converts Word files.' },
    { b: 'Lower cost and risk', d: 'a rebuild would repeat months of matching, database and Word-handling work and bring new defects.' },
    { b: 'Easy to simplify', d: 'the software already has a module/permission system, so other tools can be switched off without removing code, and turned back on later if PJPS wants.' }
  ]),
  h2('2.2 What changes'),
  table(['Area', 'Change'], [
    ['Navigation', 'Only the five modules and the Full Screening Report are shown. Find a Journal, Conferences, Thesis Assistant, Find by Author, Find Evidence, Manuscript Format and Reviewer tools are switched off.'],
    ['Dashboard', 'Redesigned around the five modules and the PJPS manuscript number.'],
    ['New work', 'PJPS style compliance check, Track Changes output, extra bibliography indicators, merged Citations module, Paper Mill Detection, Image Integrity Detection, Full Screening Report.'],
    ['Kept', 'Users and roles, saved reports, retraction alerts, exports, web platform and Windows desktop application.']
  ], [1.4, 5.6]),
  gap(),
  h2('2.3 Features shared by all five modules'),
  ...bullets([
    'Upload once (.docx, .doc, .pdf, .odt, .rtf, .txt; .bib/.ris for Module 1) and reuse the file in every module.',
    'Each check is linked to the PJPS manuscript number, with a history of saved reports.',
    'Exports: Word, PDF and CSV (plus BibTeX/RIS in Module 1).',
    'Available on the web and in the Windows desktop application.',
    'Manuscripts are processed on PJPS-controlled systems; no manuscript text is sent to an outside AI service. The only exception is the optional image vendor check in Module 5, which the editor switches on per manuscript.'
  ])
];

const m1 = [
  h1('3. Module 1 — Check Bibliography'),
  p('Purpose: confirm that every reference is real, correct and not retracted.'),
  h2('3.1 Input and verification'),
  feat([
    ['Input', 'Upload a manuscript (the reference list is found automatically) or paste references; import .bib/.ris. The editor can correct the detected list (split or merge entries) before checking.', 'Existing'],
    ['Text clean-up', 'Repairs text broken by PDF extraction (line breaks, hyphenation, special characters) before searching.', 'Existing'],
    ['Database check', 'Crossref, DOI registry, DataCite, OpenAlex, PubMed, Europe PMC, Semantic Scholar, arXiv, DBLP, Open Library, Google Books and ERIC. PubMed and Europe PMC are searched first because PJPS is a biomedical journal.', 'Existing'],
    ['Matching', 'Each reference is matched on title, authors, year, journal, volume, issue, pages and DOI.', 'Existing']
  ]),
  gap(),
  h2('3.2 Results per reference'),
  feat([
    ['Verdict', 'Verified (green), Miscited (yellow: real work, wrong details), Unverified (grey), Suspicious (orange), Retracted (red).', 'Existing'],
    ['Confidence score', '0–100 score for each reference.', 'Existing'],
    ['Comparison', 'The matched record is shown next to the original, with the differing fields highlighted.', 'Existing'],
    ['Corrected reference', 'The correct reference in PJPS style, ready to copy.', 'Existing'],
    ['Source link', 'Link to the matched record (DOI, PubMed or publisher).', 'Existing']
  ]),
  gap(),
  h2('3.3 Fake and AI-generated reference checks'),
  feat([
    ['DOI checks', 'DOI doesn’t resolve, or points to a different paper; DOIs with page numbers or junk attached are repaired.', 'Existing'],
    ['PMID / arXiv checks', 'Identifiers that don’t exist or point to another work.', 'Existing'],
    ['Journal mismatch', 'Journal name doesn’t match the DOI or the database record.', 'Existing'],
    ['Altered titles', 'Real titles with invented words inserted.', 'Existing'],
    ['Unknown authors', 'Author names not found on the matched work.', 'Existing'],
    ['Missing from indexes', 'A reference that claims to be in an indexed journal but is in no database is marked Suspicious.', 'Existing'],
    ['Fewer false alarms', 'Multi-line references, book reviews, thesis-based articles and Pakistani or regional journals that aren’t indexed are shown as “Not indexed”, not as fake.', 'Improve']
  ]),
  gap(),
  h2('3.4 Retractions, links and reference age'),
  feat([
    ['Retractions', 'Retraction Watch: retraction, expression of concern or correction, with reason and date.', 'Existing'],
    ['Retraction monitoring', 'The editor is alerted if a reference in a saved report is retracted later.', 'Existing'],
    ['Link check', 'Every URL and DOI link is tested (working, broken or redirected), separately from the verdict, because a dead link doesn’t mean a fake reference.', 'Existing'],
    ['Reference age', 'Chart of references by year; share from the last 5 and 10 years; list of references older than 10 years; warning when recent references fall below a limit set by PJPS.', 'Improve']
  ]),
  gap(),
  h2('3.5 Extra quality indicators'),
  feat([
    ['Self-citation', 'References that include the manuscript’s own authors.', 'New'],
    ['PJPS citations', 'References to PJPS articles, counted separately.', 'New'],
    ['Predatory / hijacked journals', 'References to journals on predatory or hijacked journal lists.', 'New'],
    ['Duplicates', 'The same work listed more than once.', 'New']
  ]),
  gap(),
  h2('3.6 Output'),
  ...bullets([
    'Summary bar with counts per verdict; filter by verdict.',
    'Exports: Word report, PDF, CSV, BibTeX, RIS and a corrected reference list in PJPS style.',
    'Re-check button that shows only what changed since the last run.'
  ])
];

const m2 = [
  h1('4. Module 2 — Reference Style Check & PJPS Converter'),
  p('Purpose: check that references and in-text citations follow PJPS style, and convert them when they don’t.'),
  h2('4.1 PJPS house style'),
  table(['Element', 'PJPS format'], [
    ['In-text, one author', '(Khan, 2019)'],
    ['In-text, two authors', '(Khan and Ali, 2019)'],
    ['In-text, three or more', '(Khan et al., 2019)'],
    ['Journal article', 'Khan A, Ali B and Shah C (2019). Title of article. Pak. J. Pharm. Sci., 32(1): 1-5.'],
    ['Book', 'Khan A and Ali B (2019). Title of book. Publisher, Place.'],
    ['Order', 'Alphabetical by first author, then year; 2019a / 2019b for the same author and year.']
  ], [2, 5]),
  note('To be confirmed by the PJPS Editor: these rules come from the house style already in the software. The compliance check will enforce exactly the rules PJPS approves, so please check them against the current Instructions to Authors.'),
  h2('4.2 Style compliance check'),
  feat([
    ['Author format', 'Surname followed by initials without full stops; commas between authors; “and” before the last author; the number of authors before “et al.”.', 'New'],
    ['Year', 'Year in parentheses after the authors.', 'New'],
    ['Title', 'Sentence case, ending with a full stop.', 'New'],
    ['Journal name', 'Correct NLM/ISO abbreviation.', 'New'],
    ['Volume, issue, pages', 'Format Vol(Issue): pages; page range with a hyphen; no “pp.”.', 'New'],
    ['Missing details', 'Missing volume, issue, pages, year or publisher.', 'New'],
    ['Order', 'Alphabetical order; correct a/b suffixes.', 'New'],
    ['In-text format', '(Author, Year) format, correct “et al.” use, semicolons between citations, chronological order inside one bracket.', 'New'],
    ['Result', 'Percentage of references that comply, plus each problem with the expected correct form.', 'New']
  ]),
  gap(),
  h2('4.3 Converter to PJPS format'),
  feat([
    ['Input', 'Word manuscript or a pasted reference list.', 'Existing'],
    ['Source styles', 'APA, Vancouver / numbered [1], Harvard, IEEE, AMA, Chicago, Nature, Elsevier and others, detected automatically.', 'Existing'],
    ['Full conversion', 'Converts both the in-text citations and the reference list; numbered [1] becomes (Author, Year) and the list is re-sorted alphabetically.', 'Existing'],
    ['Completing references', 'Missing DOI, volume, issue and pages are filled from the matched record (Module 1 engine).', 'Existing'],
    ['No silent changes', 'References that can’t be matched, and suspicious DOIs, are flagged for the editor instead of being changed.', 'Existing'],
    ['Layout kept', 'Only citations and references change; the rest of the manuscript layout stays the same.', 'Existing']
  ]),
  gap(),
  h2('4.4 Review and output'),
  feat([
    ['Before / after view', 'Original and converted references side by side.', 'Existing'],
    ['Track Changes', 'Changes appear in the Word file as Track Changes, so the editor or author can accept or reject each one.', 'New'],
    ['Downloads', 'Converted .docx, a copyable reference list, and a report of what changed and what still needs a manual fix.', 'Improve']
  ])
];

const m3 = [
  h1('5. Module 3 — Citations'),
  p('Purpose: check that in-text citations and the reference list match, and that each cited source really supports the claim made.'),
  h2('5.1 Citations vs reference list'),
  feat([
    ['Missing references', 'Cited in the text but not in the reference list.', 'Existing'],
    ['Uncited references', 'In the reference list but never cited.', 'Existing'],
    ['Mismatches', 'Different year or author spelling between the text and the list.', 'Existing'],
    ['Ambiguous citations', '“Khan, 2020” when the list has 2020a and 2020b, or two different authors named Khan in 2020.', 'Existing'],
    ['“et al.” misuse', 'For example “et al.” used for a two-author work.', 'New'],
    ['Numbered citations', 'Gaps, numbers out of sequence, numbers with no matching reference.', 'Existing'],
    ['Whole document', 'Citations in tables, figure captions and footnotes are included; each problem links to its location.', 'Improve']
  ]),
  gap(),
  h2('5.2 Claim support'),
  feat([
    ['Claim extraction', 'The text is split into cited claims (a sentence with its citation).', 'Existing'],
    ['Comparison', 'Each claim is compared with the cited source: an uploaded PDF (with page number), open-access full text, or the abstract.', 'Existing'],
    ['Verdicts', 'Full support, Partial, Unsupported or Could not verify, with the supporting passage from the source.', 'Existing'],
    ['PDF matching', 'Shows which uploaded PDF matched which reference, and separates “not found in your PDF” from “source not accessible”.', 'Existing'],
    ['Retracted evidence', 'A claim supported by a retracted paper is flagged red.', 'Existing'],
    ['Privacy', 'Runs on PJPS systems; manuscript text isn’t sent to an outside AI.', 'Existing']
  ]),
  gap(),
  h2('5.3 Citation patterns'),
  feat([
    ['Self-citation', 'Heavy citation of the authors’ own work.', 'Existing'],
    ['Citation stacking', 'Many citations to one journal or one group of authors.', 'Existing'],
    ['Citation blocks', 'Large groups of citations with no specific claim (for example [1–25]).', 'New']
  ]),
  gap(),
  h2('5.4 Output'),
  ...bullets([
    'One Citations report combining list matching, claim support and pattern flags.',
    'Exports: Word, PDF and CSV.',
    'Author letter in English or Urdu listing the citation problems to fix. The editor previews and approves it before it is sent.'
  ])
];

const m4 = [
  h1('6. Module 4 — Paper Mill Detection'),
  p('A paper mill is a business that sells fake or template-based research papers and authorship places, often for degree or promotion requirements. Pharmaceutical and biomedical journals are among the most targeted. Typical examples are template “drug X inhibits cancer via the A/B pathway” papers, network-pharmacology and molecular-docking papers, and studies with recycled images or invented data.'),
  p('Purpose: alert the editor to signs that a manuscript may come from a paper mill. This module is for editors only.'),
  note('Module 4 is a screening aid, not a judgement. It gives a LOW / MEDIUM / HIGH risk level and the evidence for each signal, so the editor knows where to look closer. It never rejects a paper by itself, and no tool can detect paper mills with certainty. The final decision always stays with the editor.'),
  h2('6.1 Text signals'),
  feat([
    ['Tortured phrases', 'Odd synonyms used to get past plagiarism checks, such as “counterfeit consciousness” for artificial intelligence or “bosom peril” for breast cancer. Uses the published Problematic Paper Screener list plus a PJPS pharmacy list the editors can add to.', 'Phase 1'],
    ['AI-text leftovers', 'Clear traces such as “As an AI language model”, “Regenerate response” or placeholder text. Only definite matches are flagged; there is no AI-probability score, because such scores are unreliable.', 'Phase 1'],
    ['Template wording', 'Wording typical of mill templates (network pharmacology, docking, “miR-X sponges Y” papers).', 'Phase 2'],
    ['Vague methods', 'Missing supplier, catalogue number, dose, sample size or ethics approval number.', 'Phase 2']
  ]),
  gap(),
  h2('6.2 Reference signals (using Module 1)'),
  feat([
    ['Fake references', 'Results of the Module 1 fake-reference checks.', 'Phase 1'],
    ['Paper-mill retractions', 'References to papers retracted by publishers for paper-mill reasons (Retraction Watch).', 'Phase 1'],
    ['Problem journals', 'Many references to predatory, hijacked or mill-affected journals.', 'Phase 1'],
    ['Citation stacking', 'Results of the Module 3 citation pattern checks.', 'Phase 1']
  ]),
  gap(),
  h2('6.3 Author and submission signals'),
  feat([
    ['Earlier retractions', 'Authors with earlier retractions, especially for paper mills or fake peer review (by name and ORCID).', 'Phase 1'],
    ['E-mail addresses', 'Free e-mail addresses instead of institutional ones.', 'Phase 1'],
    ['ORCID', 'Missing ORCID, or a new ORCID with no publications.', 'Phase 1'],
    ['Affiliations', 'Affiliations that don’t fit the topic, or distant institutions with no clear collaboration.', 'Phase 2'],
    ['Authorship changes', 'Authors added, removed or reordered between the original and the revised version.', 'Phase 2'],
    ['Suggested reviewers', 'Suggested reviewers with free e-mail addresses or links to the authors.', 'Phase 2']
  ]),
  gap(),
  h2('6.4 Data and biology signals'),
  feat([
    ['Cell lines', 'Misidentified or contaminated cell lines named in the methods (Cellosaurus / ICLAC register).', 'Phase 2'],
    ['Duplicate submission', 'Comparison with earlier PJPS submissions to find the same text with small edits or a recycled title and abstract (figures through the Module 5 image fingerprint store).', 'Phase 2'],
    ['Primer and gene sequences', 'Sequences checked against NCBI to find wrong or impossible primers.', 'Phase 3'],
    ['Statistics', 'Percentages, sample sizes or p-values that can’t come from the stated data.', 'Phase 3'],
    ['Images', 'Duplicated or edited images are now covered by Module 5; its findings count as one signal in the paper mill risk level.', 'Module 5']
  ]),
  gap(),
  h2('6.5 Output'),
  ...bullets([
    'Risk badge (LOW / MEDIUM / HIGH) with each signal, its weight and its evidence (quoted text, matched record, link).',
    'Editor notes and a decision record: cleared, needs investigation, or referred to the integrity committee.',
    'Confidential PDF/Word export for the editorial file.',
    'Never shown to authors or reviewers.'
  ])
];

const m5 = [
  h1('7. Module 5 — Image Integrity Detection'),
  p('Duplicated, reused and edited figures (Western blots, gels, microscopy, histology) are among the most common reasons for retraction in biomedical journals, and a typical sign of paper-mill work. Commercial tools such as ImageTwin and Proofig check for them; this module brings the same kind of check into the PJPS system.'),
  p('Purpose: find figures that are duplicated, reused or edited, and show the editor the evidence side by side. This module is for editors only.'),
  note('Module 5 is a screening aid, not a judgement. Repeated textures such as cells, tissue or gel background can look like copies, so every finding is shown as images side by side for the editor to confirm or dismiss. By default no images leave PJPS systems.'),
  h2('7.1 Comparison with commercial tools'),
  p('We reviewed ImageTwin and Proofig (October 2026). The table shows which of their features this module covers.'),
  table(['Feature', 'ImageTwin / Proofig', 'PJPS Module 5'], [
    ['Duplication inside the manuscript (rotated, flipped, resized, partly overlapping)', 'Yes', 'Yes — built in (Phase 1)'],
    ['Cloned areas inside one image', 'Yes', 'Yes — built in (Phase 1)'],
    ['Splicing and other edits', 'Yes', 'Forensic viewer for the editor (Phase 1)'],
    ['Western blot / gel lane checks', 'Yes', 'Yes — built in (Phase 2)'],
    ['Reuse of earlier PJPS figures', 'No', 'Yes — PJPS image store (Phase 2)'],
    ['Reuse of the authors’ own earlier figures', 'Proofig', 'Open-access papers via Europe PMC (Phase 2)'],
    ['Comparison against 155–160 million published figures', 'Yes', 'Through the optional vendor connection'],
    ['AI-generated image detection', 'Yes', 'Through the optional vendor connection'],
    ['Report', 'Yes', 'Yes, plus editor decisions and author query letter']
  ], [3.4, 1.6, 2.6]),
  note('The two features marked “vendor connection” need a database of over 150 million figures and AI models trained on proprietary data. They can’t be rebuilt reliably in-house, so the module offers them through the ImageTwin or Proofig API instead. Without that connection they are reported as “not checked”.'),
  h2('7.2 Image extraction'),
  feat([
    ['Extraction', 'Images are taken out of .docx and .pdf files at full resolution; separate figure files (TIFF, PNG, JPG) are also accepted.', 'Phase 1'],
    ['Panels', 'Multi-panel figures are split into sub-panels; panel labels and figure numbers are read, so each finding says, for example, “Fig. 2C vs Fig. 4A”.', 'Phase 1'],
    ['Figure type', 'Each image is classed as Western blot / gel, microscopy / histology, photo or graph.', 'Phase 1']
  ]),
  gap(),
  h2('7.3 Detection'),
  feat([
    ['Duplicated images', 'The same image or panel used twice, including copies that are rotated, flipped, resized, cropped or only partly overlapping. Matched areas are outlined on both images.', 'Phase 1'],
    ['Cloned areas', 'Part of an image copied to another place in the same image. Shown as “check this area”, not as a verdict.', 'Phase 1'],
    ['Forensic viewer', 'Contrast boost, error level analysis, noise map, edge view and an overlay slider, to help the editor spot splicing, erased bands or pasted backgrounds.', 'Phase 1'],
    ['Western blots and gels', 'Lanes and bands compared with each other: repeated, flipped or stretched lanes, sharp cut lines, and the same band used for different proteins.', 'Phase 2'],
    ['Earlier PJPS figures', 'Fingerprints of every PJPS submission and published paper are stored; each new manuscript is compared with all of them.', 'Phase 2'],
    ['Authors’ earlier figures', 'Figures from the authors’ earlier open-access papers (found through Module 1 and ORCID) are downloaded from Europe PMC and compared.', 'Phase 2']
  ]),
  gap(),
  h2('7.4 Optional vendor connection'),
  feat([
    ['Published-figure check', 'Comparison against 155–160 million published figures through the ImageTwin or Proofig API.', 'Optional'],
    ['AI-generated images', 'Detection of figures made with image-generating AI, through the same API.', 'Optional'],
    ['Control', 'Off by default; the editor switches it on per manuscript, because the figures are sent to the vendor. The vendor charges PJPS per use (Proofig’s published prices start at USD 99 for 120 sub-images; ImageTwin quotes on request).', 'Optional']
  ]),
  gap(),
  h2('7.5 Output'),
  ...bullets([
    'Image risk badge (LOW / MEDIUM / HIGH) and a list of findings, each with the two images side by side, the matched area outlined, figure and panel labels, and a confidence level.',
    'The editor marks each finding as confirmed, false alarm or ask the authors; the decision is kept with the manuscript.',
    '“Ask the authors” prepares a query letter with the image pairs, asking for the original images or raw blots. The editor approves it before it is sent.',
    'Confidential PDF/Word export for the editorial file.',
    'Findings count as one signal in the Module 4 paper mill risk level.'
  ]),
  h2('7.6 Technical notes'),
  ...bullets([
    'Runs in the background on the existing job queue; about 1–3 minutes for a manuscript with around 30 figures.',
    'In the Windows desktop application, extraction, detection and the forensic viewer work offline; the Europe PMC and vendor checks run when the connection is available.',
    'Uses established open-source image libraries (OpenCV, MuPDF, Tesseract OCR); no new paid software is needed for the in-house checks.'
  ])
];

const full = [
  h1('8. Full Screening Report'),
  p('One upload runs all five modules and produces a single report.'),
  table(['Section', 'Summary shown on the front page'], [
    ['Bibliography', 'Verified, miscited, suspicious and retracted counts'],
    ['Style', 'Percentage of references that comply with PJPS style'],
    ['Citations', 'Missing, uncited and unsupported citations'],
    ['Paper mill risk', 'LOW / MEDIUM / HIGH'],
    ['Image integrity', 'Number of findings to check; LOW / MEDIUM / HIGH'],
    ['Recommendation', 'Proceed to review, return to author, or investigate']
  ], [2, 5]),
  gap(),
  ...bullets([
    { b: 'Editor version', d: 'all five modules, including Paper Mill Detection and Image Integrity Detection.' },
    { b: 'Author version', d: 'Modules 1–3 only; the editor previews and approves it before it is sent.' }
  ])
];

const access = [
  new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 480, after: 200 }, children: [new TextRun({ text: '9. Users and access', font: FONT })] }),
  table(['Role', 'Access'], [
    ['Super Admin', 'Creates and manages all user accounts, roles and module permissions; manages datasets and settings. There is no public sign-up.'],
    ['Editor', 'All five modules and the Full Screening Report.'],
    ['Reviewer', 'Modules 1–3 if the Super Admin enables them. No access to Paper Mill Detection or Image Integrity Detection.']
  ], [1.6, 5.4]),
  gap()
];

const plan = [
  h1('10. Implementation plan'),
  p('The timeline below is indicative and will be confirmed after approval.'),
  table(['Stage', 'Work', 'Indicative time'], [
    ['1. Set-up', 'Switch off the other tools, new menu and dashboard, manuscript number field', 'Week 1'],
    ['2. Module 1', 'Fewer false alarms, reference age limits, new quality indicators', 'Weeks 2–3'],
    ['3. Module 2', 'PJPS style compliance check, Track Changes output, change report', 'Weeks 3–5'],
    ['4. Module 3', 'Merged Citations module, “et al.” checks, citation blocks, whole-document coverage', 'Weeks 5–6'],
    ['5. Module 4, phase 1', 'Tortured phrases, AI-text leftovers, reference and author signals, risk report', 'Weeks 6–8'],
    ['6. Module 5, phase 1', 'Image extraction, duplicated images, cloned areas, forensic viewer, image report', 'Weeks 8–11'],
    ['7. Full report and testing', 'Full Screening Report, testing with sample PJPS manuscripts, training, go-live', 'Weeks 11–12'],
    ['8. Module 4, phases 2–3', 'Template wording, cell lines, duplicate submissions, authorship changes; then sequences and statistics', 'After go-live, agreed separately'],
    ['9. Module 5, phase 2 and vendor option', 'Western blot / gel checks, PJPS image store, authors’ earlier figures; optional ImageTwin or Proofig connection', 'After go-live, agreed separately']
  ], [1.6, 4.2, 1.4]),
  gap(),
  h2('10.1 Deliverables'),
  ...bullets([
    'Updated web platform and Windows desktop application with the five modules.',
    'Editor and Super Admin user guides.',
    'Test report using sample PJPS manuscripts and an acceptance sign-off sheet.',
    'Training session for the editorial team.'
  ]),
  h2('10.2 Acceptance criteria'),
  ...numbered([
    'Each of the five modules runs end to end on sample PJPS manuscripts, on the web and on the desktop.',
    'The style compliance check enforces the PJPS rules approved by the Editor.',
    'Converted Word files keep their layout and show changes as Track Changes.',
    'Paper Mill Detection is visible only to editors and shows the evidence for every signal.',
    'Image Integrity Detection finds duplicated panels (including rotated, flipped and resized copies) in a test set of manuscripts with known problems, and shows every finding side by side.',
    'The Full Screening Report produces both an editor version and an author version.'
  ])
];

const decisions = [
  h1('11. Decisions needed from the Editor'),
  table(['#', 'Decision', 'Our suggestion'], [
    ['1', 'Approve the five modules and the Full Screening Report as the final scope', 'Approve'],
    ['2', 'Approve modifying the existing software instead of building a new system', 'Modify'],
    ['3', 'Confirm the PJPS reference and in-text citation rules (Section 4.1)', 'Check against the current Instructions to Authors'],
    ['4', 'Set the minimum share of recent references (last 5 years)', 'For example 30%'],
    ['5', 'Approve Module 4 phase 1 now, with phases 2–3 to follow', 'Phase 1 now'],
    ['6', 'Who receives the author version of reports', 'Corresponding author, after editor approval'],
    ['7', 'Allow reviewers to use Modules 1–3', 'Optional, set by the Super Admin'],
    ['8', 'Approve Module 5 phase 1 now, with phase 2 to follow', 'Phase 1 now'],
    ['9', 'Whether to subscribe to an image vendor (ImageTwin or Proofig) for the published-figure and AI-image checks', 'Decide after phase 1; ask both for a journal quote'],
    ['10', 'Provide sample manuscripts with known image problems for testing', 'Retracted or corrected PJPS papers, if available']
  ], [0.4, 4.2, 2.4]),
  gap()
];

const terms = [
  h1('12. Assumptions and limitations'),
  h2('12.1 Assumptions'),
  ...bullets([
    'PJPS continues to provide hosting and the PostgreSQL database used by the current system.',
    'PJPS provides a sample set of manuscripts (with personal data removed) for testing.',
    'External databases (Crossref, PubMed, OpenAlex, Retraction Watch and others) stay publicly available under their current terms; their availability is outside Softsols Pakistan’s control.',
    'Commercial terms are provided separately. Any ImageTwin or Proofig subscription is contracted and paid by PJPS directly with the vendor.'
  ]),
  h2('12.2 Limitations'),
  ...bullets([
    'All results support the editor’s decision; they don’t replace it. A green result doesn’t guarantee a reference is genuine, and a red one doesn’t prove fabrication.',
    'Claim-support results depend on access to the source; abstract-only checks are labelled as such.',
    'Paper Mill Detection shows risk signals, not proof. No tool detects paper mills with certainty.',
    'Image Integrity Detection can miss edits hidden by heavy compression, and repeated textures can cause false alarms. Without the vendor connection it doesn’t compare figures with the wider published literature or detect AI-generated images.'
  ]),
  h2('12.3 Approval'),
  p('By signing below, PJPS approves the scope described in this proposal.'),
  table(['', 'Pakistan Journal of Pharmaceutical Sciences', 'Softsols Pakistan'], [
    ['Name', '', ''], ['Designation', '', ''], ['Signature', '', ''], ['Date', '', '']
  ], [1.2, 3, 3])
];

// ------------------------------------------------------------------ document

const margin = { top: 1134, bottom: 1134, left: 1134, right: 1134 };
const doc = new Document({
  creator: 'Softsols Pakistan',
  title: TITLE,
  description: 'Proposal for approval: five-module manuscript screening system for PJPS',
  features: { updateFields: true },
  styles: {
    default: { document: { run: { font: FONT, size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 34, bold: true, color: BRAND, font: FONT }, paragraph: { spacing: { before: 240, after: 200 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 27, bold: true, color: ACCENT, font: FONT }, paragraph: { spacing: { before: 260, after: 120 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 23, bold: true, color: BRAND, font: FONT }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } }
    ]
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 300 } } } }, { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1000, hanging: 300 } } } }] },
      { reference: 'steps', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 340 } } } }] }
    ]
  },
  sections: [
    { properties: { page: { margin } }, children: cover },
    {
      properties: { page: { margin } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C3CCD5', space: 4 } }, children: [t(TITLE, { size: 17, color: MUTED })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [t('Softsols Pakistan · Page ', { size: 17, color: MUTED }), new TextRun({ children: [PageNumber.CURRENT], size: 17, color: MUTED, font: FONT })] })] }) },
      children: [...docControl, ...exec, ...approach, ...m1, ...m2, ...m3, ...m4, ...m5, ...full, ...access, ...plan, ...decisions, ...terms]
    }
  ]
});

const out = path.join(__dirname, 'PJPS-4-Modules-Proposal.docx');
Packer.toBuffer(doc).then(buf => { fs.writeFileSync(out, buf); console.log('Wrote', out, buf.length, 'bytes'); });

