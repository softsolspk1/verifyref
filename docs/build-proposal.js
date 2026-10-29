// build-proposal.js - generates docs/PJPS-Reference-Checker-Proposal.docx  (node docs/build-proposal.js)
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

const today = '21 October 2026';

const cover = [
  p('', { after: 1800 }),
  p([t('SOFTSOLS PAKISTAN', { bold: true, color: ACCENT, size: 24 })], { after: 200 }),
  p([t('PJPS Reference Checker', { bold: true, color: BRAND, size: 64 })], { after: 120 }),
  p([t('Web Platform & Windows Desktop Application with Offline Mode', { color: BRAND, size: 32 })], { after: 480 }),
  new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: ACCENT, space: 1 } }, spacing: { after: 360 }, children: [] }),
  p([t('Technical & Functional Proposal', { bold: true, size: 28 })], { after: 120 }),
  p([t('Prepared for: ', { bold: true }), t('Pakistan Journal of Pharmaceutical Sciences (PJPS)')]),
  p([t('Prepared by: ', { bold: true }), t('Softsols Pakistan')]),
  p([t('Date: ', { bold: true }), t(today)]),
  p([t('Version: ', { bold: true }), t('1.0')]),
  p('', { after: 2400 }),
  p([t('Confidential — prepared for the evaluation of PJPS. Not for redistribution.', { italics: true, color: MUTED, size: 18 })])
];

const docControl = [
  p([t('Document control', { bold: true, color: ACCENT, size: 27 })], { before: 120 }),
  table(['Version', 'Date', 'Author', 'Change'], [['1.0', today, 'Softsols Pakistan', 'Initial proposal']], [1, 1.5, 2, 4]),
  gap(),
  p([t('Contents', { bold: true, color: ACCENT, size: 27 })], { before: 240 }),
  new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-2' }),
];

const exec = [
  h1('1. Executive summary'),
  p('Fabricated and AI-generated references, miscited sources, retracted papers, coercive citation requests and predatory journals now reach journals in every manuscript batch. Checking each reference by hand takes an editor hours per manuscript. PJPS already runs an editor-only Reference Checker built by Softsols Pakistan; this proposal extends it into a complete reference-integrity and research-support platform modelled on the full tool set of ReferenceVerify (referenceverify.com).'),
  p('The proposed solution has three parts:'),
  ...bullets([
    { b: 'Web platform', d: 'every ReferenceVerify tool — bibliography checking, reference-style conversion, citation verification, evidence search, manuscript formatting, journal and conference finders/checkers, thesis/paper assistant, author search, editor tools and alerts — hosted for PJPS.' },
    { b: 'Windows desktop application', d: 'an installable application (setup .exe) that runs the same tools on the editor’s own computer, with its own local database.' },
    { b: 'Offline mode', d: 'on the desktop, documents can be parsed, restyled, formatted and checked against locally synchronised datasets (Retraction Watch, predatory lists, journal index lists, cached lookups) with no internet connection; online-only checks are queued and completed automatically when the connection returns.' }
  ]),
  p('Access is controlled centrally: there is no public sign-up. The Super Admin creates every user account, assigns a role and module permissions, and decides who may use the web platform, the desktop application, or both.'),
  note('Out of scope, as requested: all integration modules (Microsoft Word add-in, OJS plugin, browser extension, public API) and the pricing module (plans, quotas, payments, subscriptions).')
];

const background = [
  h1('2. Background and objectives'),
  h2('2.1 Reference application reviewed'),
  p('ReferenceVerify is a reference-verification and research-support service. Its public site groups its features into Check tools (Bibliography Check, Reference Style, Verify Citations, Find Evidence, Manuscript Format), Find tools (Find & Check Journal, Find & Check Conference, Thesis/Paper Assistant, Find by Author), editor tools (citation pattern, reviewer finder, coercive-citation detection), My Activity with alerts, and paid plans and integrations. This proposal covers every functional feature except integrations and pricing, adapted to PJPS (for example HEC HJRS replaces Turkish national indexes, and Urdu replaces Turkish as the second correspondence language).'),
  h2('2.2 Objectives'),
  ...bullets([
    'Detect fabricated, AI-hallucinated, miscited and retracted references before peer review.',
    'Verify that cited sources actually support the claims made in the manuscript.',
    'Convert references and whole manuscripts to the required style and template in one step.',
    'Help editors choose reviewers and spot coercive or stacked citations.',
    'Give authors and editors evidence-based journal, conference and literature discovery tools.',
    'Make the tools available on Windows desktops, including when offline.',
    'Keep all user administration in the hands of a single Super Admin role.'
  ]),
  h2('2.3 Current system and what is reused'),
  p('The existing PJPS Reference Checker (Node.js, PostgreSQL, deployed on Vercel) already provides the Reference Check against 12 databases, Citation Check, Journal Check, Citation pattern, Reviewer Finder, Reviewer report check, Editor report and Issue report. These modules are retained and extended. New modules, the Super Admin user model and the desktop application are added on the same code base so that the web and desktop editions behave identically.')
];

const scope = [
  h1('3. Scope of work'),
  h2('3.1 In scope'),
  table(['Area', 'Modules'], [
    ['Check tools', 'Bibliography / Reference Check · Reference Style converter · Verify Citations (claim support) · Citation Check (in-text ↔ reference list) · Find Evidence · Manuscript Format converter'],
    ['Find tools', 'Find a Journal · Check a Journal · Find a Conference · Check a Conference · Thesis/Paper Assistant · Find by Author'],
    ['Editor tools', 'Citation pattern · Reviewer Finder · Reviewer report (coercive citation) check · Editor report (decision summary, EN/UR letters, revision comparison) · Issue report'],
    ['My Activity & alerts', 'Saved reports · daily retraction monitoring of saved checks · citation alerts (ORCID) · topic alerts · author alerts · in-app notification centre · e-mail notifications'],
    ['Administration', 'Super Admin user management · roles & module permissions · web/desktop access control · datasets & journal index lists · audit log · system settings'],
    ['Desktop application', 'Windows installer · local database · offline sign-in · offline tools · sync with the web platform · offline queue'],
    ['Deployment', 'Web deployment (Vercel or VPS), Windows installer build, documentation and training']
  ], [1.4, 5]),
  gap(),
  h2('3.2 Out of scope'),
  table(['Excluded item', 'Notes'], [
    ['Integration modules', 'Microsoft Word add-in, OJS 3.x plugin, browser extension (Chrome/Edge), public REST API for third parties, DergiPark/submission-system connectors.'],
    ['Pricing module', 'Guest/Free/Pro/Max/Thesis Pack/Campus plans, usage quotas, credit counters, payment gateway, invoices, refunds and subscription management.'],
    ['Licensed data', 'Scopus, Web of Science/JCR and HEC HJRS lists are uploaded by PJPS from its own access; the system does not scrape licensed services.'],
    ['Generative AI drafting', 'The Thesis/Paper Assistant and Find Evidence are evidence-extractive (they quote and assemble real abstracts); a generative language model can be added later as a change request.']
  ], [1.6, 5]),
  gap()
];

const roles = [
  h1('4. Users, roles and access management'),
  p('Self-registration is removed. Only the Super Admin can create accounts. Each account receives a role, a set of enabled modules and an access channel (web, desktop or both).'),
  h2('4.1 Roles'),
  table(['Role', 'Created by', 'Capabilities'], [
    ['Super Admin', 'Seeded at installation', 'Creates, edits, suspends and deletes users; resets passwords; assigns roles and module permissions; grants web and/or desktop access; manages datasets and journal index lists; views the audit log and usage statistics; system settings. Cannot be locked out (at least one active Super Admin is enforced).'],
    ['Editor', 'Super Admin', 'All check, find and editor tools (as permitted), issue management, reports, letters, revision comparison, alerts.'],
    ['Reviewer / Researcher', 'Super Admin', 'Check and find tools (as permitted) for their own work; no access to editor-only tools such as Reviewer Finder, Citation pattern or Issue report unless enabled.']
  ], [1.3, 1.3, 5]),
  gap(),
  h2('4.2 User management features'),
  ...bullets([
    'Create user: name, e-mail, role, journal, designation, ORCID, initial password (or generated password shown once).',
    'Module permissions per user: tick boxes for each tool; defaults follow the role.',
    'Access channel per user: Web, Desktop, or both. Desktop access includes an “offline allowed for N days” limit after which the desktop must reconnect to re-validate.',
    'Status: active / suspended. Suspending signs the user out everywhere and blocks the desktop at its next sync or offline-grace expiry.',
    'Force password change at next sign-in; password reset by Super Admin.',
    'Registered desktop devices per user (device name, last sync) with the option to revoke a device.',
    'Audit log: sign-ins, user changes, permission changes, dataset uploads, with date, actor and IP/device.',
    'Usage dashboard: checks run per user and per module, references checked, flags found.'
  ])
];

function moduleTable(rows) { return table(['Feature', 'Description'], rows, [1.6, 5]); }

const modules = [
  h1('5. Functional modules'),
  p('Every module accepts uploads (PDF, Word .docx, ODT, RTF, plain text, BibTeX .bib, RIS .ris) or pasted text, detects the reference section, title, authors, affiliations, abstract and keywords automatically, and exports its results (Word, CSV, BibTeX, RIS, or text as appropriate). Results can be saved to My Activity.'),

  h2('5.1 Bibliography / Reference Check'),
  p('Checks every reference against international scholarly databases and integrity datasets and assigns a status and a 0–100 confidence score.'),
  moduleTable([
    ['Databases', 'Crossref, DOI Foundation (Handle), DataCite, OpenAlex, PubMed, Europe PMC, Semantic Scholar, arXiv, DBLP, Open Library, Google Books, ERIC; Retraction Watch dataset.'],
    ['Statuses', 'Verified (green), Miscited (details wrong), Unverified (yellow — partial match, verify manually), Suspicious (red — no record or wrong/dead DOI, likely fabricated), Retracted.'],
    ['Detected problems', 'Non-existent DOI/PMID/arXiv ID; identifier pointing to a different paper; wrong journal, year, volume, pages or author order; claimed articles in well-indexed journals that appear nowhere; preprint vs published version; broken links (with archive.org copy); reference-age distribution.'],
    ['Matched record', 'Side-by-side view of the reference as written and the registered record, with the databases it was found in.'],
    ['Corrections', 'Suggested corrected reference and missing DOIs (only for green results — yellow/red entries are never auto-corrected).'],
    ['Exports', 'Word report, CSV, BibTeX, RIS, corrected reference list.']
  ]),
  gap(),

  h2('5.2 Reference Style converter'),
  p('Restyles the in-text citations and reference list of a Word document, or a pasted list, into a chosen style while keeping the rest of the document layout untouched.'),
  moduleTable([
    ['Styles (20+)', 'APA 7, APA 6, Chicago author-date, Chicago notes & bibliography, Harvard, MLA 9, IEEE, Vancouver, AMA, ACS, CSE (citation-sequence and name-year), Nature, Science, Cell, The Lancet, BMJ, PLOS, Springer (basic), Elsevier Harvard, OSCOLA, APSA, PJPS house style.'],
    ['Metadata completion', 'Each entry is matched to its registered record; missing DOI, issue and page ranges are filled in.'],
    ['In-text conversion', 'Numbered ↔ author–year conversion; renumbering in order of first citation; note styles produce footnote-style output.'],
    ['Preview', 'Original vs converted, entry by entry, with unmatched entries highlighted for manual review.'],
    ['Output', 'Converted Word document (.docx) or copy/download of the restyled reference list. Up to 250 references per conversion.']
  ]),
  gap(),

  h2('5.3 Verify Citations (claim support)'),
  p('Checks whether each cited sentence is actually supported by the source it cites.'),
  moduleTable([
    ['Workflow', 'The bibliography is verified first; the text is split into citing sentences (claims); each claim is compared with the cited source’s full text (open access or uploaded PDF) or abstract.'],
    ['Source upload', 'Editors may upload full-text PDFs of closed-access sources; files are linked to references automatically by DOI or title/author, with manual re-linking.'],
    ['Verdicts', 'Full match · Partial match · Unsupported · Could not verify (source text unavailable).'],
    ['Evidence', 'The best-matching passage is quoted, with its origin (uploaded file and page number, full text or abstract); number and direction-of-effect mismatches are highlighted.'],
    ['Privacy', 'All analysis runs on PJPS’s own server or the desktop; manuscript text is not sent to external AI services or plagiarism databases.'],
    ['Output', 'Word or CSV report; saved to My Activity.']
  ]),
  gap(),

  h2('5.4 Citation Check (in-text ↔ reference list)'),
  moduleTable([
    ['Systems', 'Numbered (Vancouver/IEEE) and author–year (APA/Harvard/PJPS).'],
    ['Findings', 'Citations missing from the list, references never cited, ambiguous same-author/same-year citations, year mismatches, numbering order and alphabetical order problems.']
  ]),
  gap(),

  h2('5.5 Find Evidence'),
  p('Finds published sources that support a sentence the author needs to cite.'),
  moduleTable([
    ['Input', 'A claim (ideally with population, relationship and figures); optional context; citation style; scope (international / Pakistan-focused / no preference).'],
    ['Search', 'Scholarly indexes (OpenAlex, Europe PMC, PubMed, Crossref) are searched; open full texts and abstracts are retrieved; retracted papers are excluded.'],
    ['Results', 'Formatted citation and in-text label, the verbatim evidence quote, evidence level (full text / abstract), source trail.'],
    ['Wording adjustment', 'When the claim says more than the source supports (e.g. figures or causal language absent from the source), a more cautious wording based only on what the source states is suggested.'],
    ['Output', 'Copy citation, download Word, save to My Activity.']
  ]),
  gap(),

  h2('5.6 Manuscript Format converter'),
  moduleTable([
    ['Templates', 'Springer Nature, Elsevier, IEEE, Wiley, Taylor & Francis, SAGE, MDPI, Frontiers, PLOS and PJPS (general submission templates).'],
    ['Changes applied', 'Page size and margins, fonts and sizes, line spacing, single/double column, heading styles, in-text citation and reference style.'],
    ['Article types', 'Research article, review, short communication, case report.'],
    ['Input / output', 'Editable Word (.docx) in, converted .docx out. Decision support only — the target journal’s current guidelines remain authoritative.']
  ]),
  gap(),

  h2('5.7 Find a Journal'),
  moduleTable([
    ['Input', 'Paper title (required) and abstract (recommended).'],
    ['Evidence', 'Journals ranked by how many similar papers they actually published in the last three years (“published N papers like yours”), with the sample papers shown.'],
    ['Decision bar', 'Filters for indexing (Scopus, SCIE, SSCI, AHCI, ESCI/WoS, MEDLINE, DOAJ, HEC HJRS W/X/Y), minimum quartile, open access, APC limit, Diamond OA (no fee).'],
    ['Signals', 'Scope-match badge when evidence is weak, predatory/hijacked warnings, typical time to publication where available, articles per year.'],
    ['Closest alternatives', '“Journals closest to your filters” with the reason each was excluded.'],
    ['Export', 'CSV for discussion with a supervisor or co-authors.']
  ]),
  gap(),

  h2('5.8 Check a Journal'),
  moduleTable([
    ['Search', 'Journal name, abbreviation or ISSN.'],
    ['Report', 'Scopus status and SJR quartile by category, Web of Science collections and JCR quartile, HEC HJRS category, MEDLINE, DOAJ (seal, APC, review type), ISSN registry and check digit, publisher and homepage, articles per year, Retraction Watch counts.'],
    ['Risk signals', 'Unregistered or invalid ISSN, high APC without DOAJ listing, sudden output spikes, hijacked-clone records, Beall’s-list matches, high retraction rate, “this quartile may no longer hold” when a journal was dropped from an index.']
  ]),
  gap(),

  h2('5.9 Find a Conference / Check a Conference'),
  moduleTable([
    ['Find', 'Paper title → conferences where similar papers were actually published, ranked by the number of similar papers, with “Why suggested?” sample papers. Filters: Pakistan-based authors, recent records only, exclude general series.'],
    ['Badges', 'Scopus coverage status, years covered, annual regularity, whether upcoming proceedings are registered.'],
    ['Check', 'Search by acronym, name or ISBN; year-by-year indexing status from the uploaded Scopus source list and OpenAlex, explaining that Scopus indexes proceedings sources rather than events.'],
    ['Follow', 'Follow a conference to be notified when a new edition appears in the index.'],
    ['Community entries', 'Users can add regional conferences not represented in international databases; entries are marked as user-contributed.'],
    ['Not provided', 'Dates, venues and submission deadlines — users are linked to the conference website.']
  ]),
  gap(),

  h2('5.10 Thesis / Paper Assistant'),
  moduleTable([
    ['Input', 'Topic or keywords, draft type (article or thesis), section (introduction, literature review, research-gap analysis), optional year range, up to three key papers (DOI or title), focus notes, citation style.'],
    ['Process', 'Builds search queries, scans around 50 relevant abstracts, follows the citation network of key papers (references and citing works), groups sources by sub-topic.'],
    ['Output', 'A structured draft assembled from the source abstracts with in-text citations; clicking a citation shows the abstract sentence it is based on; automatic reference list in the chosen style; “Verify & fix references” runs the Reference Check on it.'],
    ['Research gaps', 'Publication trend by year, prominent sub-topics, and candidate gaps labelled by reliability: “from review”, “from data”, “inferred”.'],
    ['Disclaimer', 'A rapid draft from abstracts, not a systematic (PRISMA) review.']
  ]),
  gap(),

  h2('5.11 Find by Author'),
  moduleTable([
    ['Search', 'Author name with optional topic to separate people with the same name.'],
    ['Disambiguation', 'Candidates shown with institution, ORCID, publication and citation counts.'],
    ['Publications', 'Verified publication list (not AI-generated), selectable and copyable in the chosen citation style, or added to a bibliography.'],
    ['Follow', 'Follow the author for weekly notifications of new publications.']
  ]),
  gap(),

  h2('5.12 Editor tools'),
  moduleTable([
    ['Citation pattern', 'Self-citation rate (by ORCID or name), irrelevant self-citations, references piled on one author or one journal, citation stacking toward PJPS (including the two-year impact-factor window), off-topic references, uncited entries.'],
    ['Reviewer Finder', 'Candidates who published on the topic in the last 3–8 years with ORCID, institution, h-index, current workload, retractions and conflict-of-interest flags; filters for ORCID only, hide conflicts, Pakistan-based/international; Word and CSV export.'],
    ['Reviewer report check', 'Extracts citation requests from a reviewer report, verifies them, flags the reviewer’s own work, single-journal or single-author groups, weakly related sources and coercive wording; drafts a note to the author.'],
    ['Editor report', 'One-page desk-review decision summary (proceed / revise / consider rejection), correction letter in English and Urdu, revision comparison showing fixed, removed, still-problematic and new problems.'],
    ['Issue report', 'Summary table of every manuscript in an issue or period; Word and CSV; option to save counts only (no manuscript content stored).']
  ]),
  gap(),

  h2('5.13 My Activity and alerts'),
  moduleTable([
    ['My Activity', 'All saved reports from every module, searchable and filterable by tool, date and manuscript ID; reopen, export or delete.'],
    ['Retraction monitoring', 'Saved bibliography checks are re-checked daily against the Retraction Watch dataset; the user is notified if a cited paper is retracted later.'],
    ['Citation alerts', 'Linked to the user’s ORCID: notification when their works receive new citations, with the citing journal’s quartile, predatory signals and self-citation flags.'],
    ['Topic alerts', 'Up to 10 topics per user; weekly digest of new publications.'],
    ['Author alerts', 'Followed authors; weekly digest of their new work.'],
    ['Delivery', 'In-app notification centre (web and desktop) and e-mail (SMTP configured by the Super Admin).']
  ])
];

const desktop = [
  h1('6. Windows desktop application'),
  p('The desktop application packages the complete PJPS Reference Checker for Windows 10 and 11 (64-bit). It is installed with a standard setup wizard (PJPS-Reference-Checker-Setup.exe), creates Start-menu and desktop shortcuts, and can be uninstalled from Windows Settings.'),
  h2('6.1 Architecture'),
  ...bullets([
    { b: 'Same features as the web', d: 'the desktop runs the same application engine as the server, so every tool, report and export behaves the same way.' },
    { b: 'Local database', d: 'an embedded PostgreSQL-compatible database stored in the user’s profile folder keeps saved reports, the lookup cache, datasets and the offline queue. No separate database installation is needed.' },
    { b: 'Connected to the web platform', d: 'the desktop signs in against the PJPS web platform, downloads the datasets and journal lists, and uploads saved reports so they appear in My Activity on the web as well.' },
    { b: 'Direct lookups', d: 'when online, the desktop queries the academic databases directly from the editor’s computer, sharing the load with the server.' }
  ]),
  h2('6.2 Sign-in and security'),
  ...bullets([
    'Only accounts created by the Super Admin with Desktop access enabled can sign in.',
    'First sign-in must be online; afterwards the user can sign in offline with the same password (a salted hash is kept locally, never the password).',
    'Offline grace period set by the Super Admin (e.g. 14 days); after it expires the desktop must reconnect to re-validate the account.',
    'Suspended users or revoked devices are signed out at the next connection.',
    'The desktop server listens only on the local machine (127.0.0.1) and is not reachable from the network.'
  ]),
  h2('6.3 Offline features'),
  p('The table shows which features are available without an internet connection.'),
  table(['Feature', 'Offline on desktop', 'Notes'], [
    ['Document reading (PDF, DOCX, ODT, RTF, TXT, BIB, RIS)', 'Full', 'Text, reference section and manuscript metadata are extracted locally.'],
    ['Reference parsing & structure check', 'Full', 'Splitting, author/year/journal/volume/pages parsing, DOI/ISSN format and check digits.'],
    ['Citation Check (in-text ↔ list)', 'Full', 'Entirely local.'],
    ['Retraction check', 'Full', 'Against the locally synchronised Retraction Watch dataset.'],
    ['Predatory / hijacked journal check', 'Full', 'Against the synchronised Beall’s and hijacked-journal lists.'],
    ['Journal index lookup (Scopus/WoS/JCR/HJRS)', 'Full', 'Against the synchronised journal index lists.'],
    ['Reference Check (databases)', 'Partial', 'References already in the local cache are verified offline; the rest are marked “Pending — online verification” and queued.'],
    ['Reference Style converter', 'Full*', 'Restyling from parsed data offline; DOI/page completion is applied when online.'],
    ['Manuscript Format converter', 'Full', 'Template formatting is entirely local.'],
    ['Citation pattern', 'Full', 'Self-citation, author and journal piles computed locally.'],
    ['Verify Citations', 'Partial', 'Works offline with uploaded source PDFs; abstract retrieval needs a connection.'],
    ['Editor report, letters (EN/UR), revision comparison, Issue report', 'Full', 'Generated from locally saved checks.'],
    ['My Activity, exports (Word, CSV, BibTeX, RIS)', 'Full', 'Local reports; synchronised when online.'],
    ['Find Evidence, Journal/Conference Finder, Thesis Assistant, Author search, Reviewer Finder', 'Online', 'Need live database searches; requests can be queued.']
  ], [3, 1.3, 3.2]),
  gap(),
  h2('6.4 Offline queue and synchronisation'),
  ...bullets([
    'A status indicator shows Online / Offline and the date of the last synchronisation.',
    'Checks that need online lookups are added to an offline queue; when the connection returns they are completed automatically and the user is notified.',
    'Datasets (Retraction Watch, Beall’s list, hijacked journals, uploaded journal index lists) are synchronised from the web platform on sign-in and on demand.',
    'Saved reports are uploaded to the web platform so they are available everywhere; reports created on the web can be downloaded for offline use.'
  ]),
  h2('6.5 Installation and updates'),
  ...bullets([
    'Installer: NSIS setup wizard with choice of installation folder, per-user or all-users installation.',
    'Size: approximately 150–250 MB installed plus datasets (~60 MB).',
    'Configuration: the web platform address is set at first launch (pre-configured for PJPS).',
    'Updates: a new setup file is published with each release; the application shows a notice when a newer version is available.'
  ])
];

const tech = [
  h1('7. Technical architecture'),
  table(['Layer', 'Web platform', 'Desktop application'], [
    ['Runtime', 'Node.js 20+, Express', 'Electron (Chromium + Node.js) running the same Express engine on 127.0.0.1'],
    ['Database', 'PostgreSQL (Neon / Supabase / managed)', 'Embedded PostgreSQL-compatible database (PGlite) in the user profile'],
    ['User interface', 'Responsive web application (no build step), light/dark theme', 'Same interface in a native window with menu, offline indicator and sync panel'],
    ['Documents', 'mammoth/pdf-parse for reading; docx and OOXML editing for Word output', 'Same'],
    ['Background work', 'Resumable jobs stored in PostgreSQL; scheduled daily job', 'Same, plus the offline queue'],
    ['Hosting', 'Vercel (current) or a Pakistan-based VPS', 'Windows 10/11 x64'],
    ['Notifications', 'SMTP e-mail + in-app', 'In-app (and e-mail via the web platform)']
  ], [1.2, 2.6, 3]),
  gap(),
  h2('7.1 Data sources'),
  p('Crossref, DOI Foundation, DataCite, OpenAlex, PubMed/NCBI E-utilities, NLM Catalog, Europe PMC, Semantic Scholar, arXiv, DBLP, Open Library, Google Books, ERIC, DOAJ, ISSN Portal, Wikidata, Internet Archive, Retraction Watch (via Crossref), Beall’s list and hijacked-journal lists, OpenAPC; plus PJPS-uploaded Scopus/SJR, Web of Science, JCR and HEC HJRS lists. Free API keys (OpenAlex, Semantic Scholar, NCBI, Google Books) are recommended for production volume.'),
  h2('7.2 Security and privacy'),
  ...bullets([
    'Passwords hashed with scrypt; HTTP-only, SameSite session cookies; HTTPS in production.',
    'Role- and permission-checked API on every request; Super Admin-only administration endpoints.',
    'Manuscripts are processed for checking only; they are never sent to plagiarism databases or external AI services.',
    '“Counts only” saving for editors who do not want manuscript content stored.',
    'Audit log of administrative actions; rate-limited sign-in.'
  ]),
  h2('7.3 Non-functional requirements'),
  table(['Requirement', 'Target'], [
    ['Reference Check speed', '50 references in about 1–3 minutes online (depends on database response times); cached references are instant.'],
    ['Capacity', 'Up to 250 references per manuscript; 50 MB uploads on desktop (≈4.5 MB on Vercel web; larger on VPS hosting).'],
    ['Availability', 'Web: hosting provider SLA; desktop: independent of server for offline features.'],
    ['Browsers', 'Current Chrome, Edge, Firefox, Safari.'],
    ['Languages', 'English interface; Urdu correspondence letters (right-to-left).']
  ], [1.6, 5]),
  gap()
];

const plan = [
  h1('8. Implementation plan'),
  table(['Phase', 'Work', 'Duration'], [
    ['1. Foundation', 'Super Admin user model, roles, module permissions, web/desktop access, audit log, notification centre', 'Week 1–2'],
    ['2. Check tools', 'Reference Style converter, Verify Citations, Find Evidence, Manuscript Format converter; extended citation styles', 'Week 3–6'],
    ['3. Find tools', 'Find a Journal, Find/Check a Conference, Thesis/Paper Assistant, Find by Author', 'Week 7–9'],
    ['4. My Activity & alerts', 'Saved reports for all tools, retraction monitoring, citation/topic/author alerts, e-mail', 'Week 10'],
    ['5. Desktop application', 'Electron shell, embedded database, offline sign-in, dataset sync, offline queue, report sync, Windows installer', 'Week 11–13'],
    ['6. Testing & UAT', 'Functional, offline/online transition, installer and security testing; user acceptance by PJPS editors', 'Week 14–15'],
    ['7. Go-live', 'Production deployment, desktop roll-out, training, handover documentation', 'Week 16']
  ], [1.4, 4.4, 1.2]),
  gap(),
  h2('8.1 Deliverables'),
  ...bullets([
    'Updated web platform deployed to PJPS hosting, with source code in the PJPS repository.',
    'Windows installer (PJPS-Reference-Checker-Setup.exe) and portable build.',
    'Super Admin guide, editor user guide and desktop installation guide.',
    'Test report and user-acceptance sign-off sheet.',
    'Training session(s) for the Super Admin and editors.'
  ]),
  h2('8.2 Acceptance criteria'),
  ...numbered([
    'Every module listed in Section 5 runs end-to-end on the web and on the desktop with sample PJPS manuscripts.',
    'Only the Super Admin can create users; a user without desktop access cannot sign in on the desktop, and a suspended user loses access on both.',
    'With the network disconnected, the desktop signs in, opens saved reports and performs every feature marked “Full” in Section 6.3; queued checks complete after reconnecting.',
    'The installer installs, launches and uninstalls cleanly on Windows 10 and Windows 11.'
  ])
];

const terms = [
  h1('9. Support, assumptions and dependencies'),
  h2('9.1 Support and maintenance'),
  ...bullets([
    'Warranty period after go-live for defect fixes.',
    'Optional annual maintenance: dependency and security updates, adaptation to changes in external database APIs, new citation styles or templates.',
    'Commercial terms are provided separately (the pricing module of the reference site is not part of this scope).'
  ]),
  h2('9.2 Assumptions'),
  ...bullets([
    'PJPS provides the hosting account (or approves Vercel/VPS hosting) and a PostgreSQL database.',
    'PJPS supplies current Scopus/SJR, Web of Science, JCR and HEC HJRS list exports for upload.',
    'An SMTP account is provided for e-mail notifications.',
    'Free API keys for OpenAlex, Semantic Scholar, NCBI and Google Books are registered in PJPS’s name.',
    'External databases remain publicly accessible under their current terms; their availability and rate limits are outside Softsols Pakistan’s control.',
    'A code-signing certificate, if PJPS wants Windows to show a verified publisher, is purchased by PJPS.'
  ]),
  h2('9.3 Limitations'),
  ...bullets([
    'Results are decision support. A green status does not guarantee a reference is genuine, and red does not prove fabrication; editors make the final judgement.',
    'Claim-support verdicts depend on the availability of the source full text; abstract-only verification is labelled as such.',
    'Offline database verification is limited to references previously looked up or covered by the synchronised datasets.'
  ]),
  h2('10. Approval'),
  p('By signing below, both parties agree to the scope described in this proposal.'),
  table(['', 'Pakistan Journal of Pharmaceutical Sciences', 'Softsols Pakistan'], [
    ['Name', '', ''], ['Designation', '', ''], ['Signature', '', ''], ['Date', '', '']
  ], [1.2, 3, 3])
];

// ------------------------------------------------------------------ document

const doc = new Document({
  creator: 'Softsols Pakistan',
  title: 'PJPS Reference Checker — Web & Desktop Proposal',
  description: 'Technical and functional proposal',
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
    { properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children: cover },
    {
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C3CCD5', space: 4 } }, children: [t('PJPS Reference Checker — Web & Desktop Proposal', { size: 17, color: MUTED })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [t('Softsols Pakistan · Page ', { size: 17, color: MUTED }), new TextRun({ children: [PageNumber.CURRENT], size: 17, color: MUTED, font: FONT })] })] }) },
      children: [...docControl, ...exec, ...background, ...scope, ...roles, ...modules, ...desktop, ...tech, ...plan, ...terms]
    }
  ]
});

const out = path.join(__dirname, 'PJPS-Reference-Checker-Proposal.docx');
Packer.toBuffer(doc).then(buf => { fs.writeFileSync(out, buf); console.log('Wrote', out, buf.length, 'bytes'); });
