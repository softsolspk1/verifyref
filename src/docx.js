// docx.js - Word exports built from simple blocks: {h1|h2|p|bullets|table|kv}
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType
} = require('docx');
const cfg = require('./config');

function run(text, opts = {}) {
  return new TextRun({ text: String(text ?? ''), font: opts.rtl ? 'Jameel Noori Nastaleeq' : 'Calibri', size: opts.size || 21, bold: opts.bold, italics: opts.italics, color: opts.color, rightToLeft: opts.rtl });
}

function para(text, opts = {}) {
  return new Paragraph({
    children: Array.isArray(text) ? text : [run(text, opts)],
    heading: opts.heading,
    bidirectional: opts.rtl,
    alignment: opts.rtl ? AlignmentType.RIGHT : opts.align,
    spacing: { after: opts.after ?? 80 },
    bullet: opts.bullet ? { level: 0 } : undefined
  });
}

function cell(text, { header = false, rtl = false, width } = {}) {
  return new TableCell({
    children: [para(text, { bold: header, size: 18, rtl, after: 0 })],
    shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'E8EEF5' } : undefined,
    width: width ? { size: width, type: WidthType.PERCENTAGE } : undefined
  });
}

function table(headers, rows, rtl) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFC8D2' };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map(h => cell(h, { header: true, rtl })) }),
      ...rows.map(r => new TableRow({ children: r.map(v => cell(v, { rtl })) }))
    ]
  });
}

async function buildDocx(blocks, { rtl = false, title = cfg.APP_NAME } = {}) {
  const children = [];
  for (const b of blocks) {
    if (b.h1) children.push(para(b.h1, { heading: HeadingLevel.HEADING_1, rtl, after: 120 }));
    else if (b.h2) children.push(para(b.h2, { heading: HeadingLevel.HEADING_2, rtl, after: 100 }));
    else if (b.p !== undefined) children.push(para(b.p, { rtl, bold: b.bold, italics: b.italics, color: b.color }));
    else if (b.bullets) for (const t of b.bullets) children.push(para(t, { rtl, bullet: true }));
    else if (b.kv) for (const [k, v] of b.kv) children.push(para([run(`${k}: `, { bold: true, rtl }), run(v, { rtl })], { rtl }));
    else if (b.table) { children.push(table(b.table.headers, b.table.rows, rtl)); children.push(para('', { after: 120 })); }
  }
  children.push(para(`${cfg.APP_NAME} · ${cfg.APP_VENDOR} · ${new Date().toISOString().slice(0, 10)}`, { size: 16, color: '7A8794', italics: true }));
  const doc = new Document({ title, creator: cfg.APP_VENDOR, sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } }, children }] });
  return Packer.toBuffer(doc);
}

// ------------------------------------------------------------------ report-specific block builders

function decisionSummaryBlocks(ds) {
  const r = ds.references;
  const blocks = [
    { h1: 'Desk Review — Reference Decision Summary' },
    { kv: [['Manuscript', `${ds.manuscript.code ? ds.manuscript.code + ' — ' : ''}${ds.manuscript.title}`], ['Authors', ds.manuscript.authors.join(', ') || '—'], ['Version', String(ds.manuscript.version)], ['Checked', new Date(ds.checkedAt).toLocaleString()]] },
    { h2: 'Recommendation' },
    { p: ds.recommendation, bold: true, color: ds.level === 'reject' ? 'B42318' : ds.level === 'revise' ? 'B54708' : '067647' },
    { bullets: ds.reasons.length ? ds.reasons : ['No significant reference problems were found.'] },
    { h2: 'Reference Check' },
    { table: { headers: ['Total', 'Verified', 'Miscited', 'Unverified', 'Suspicious', 'Retracted', 'DOIs found'], rows: [[r.total, r.verified, r.miscited, r.unverified, r.suspicious, r.retracted, r.doiSuggested].map(String)] } }
  ];
  if (ds.citations) blocks.push({ h2: 'Citation Check' }, { table: { headers: ['System', 'In-text citations', 'Missing from list', 'Never cited', 'Ambiguous'], rows: [[ds.citations.system, ds.citations.citations, ds.citations.missing, ds.citations.uncited, ds.citations.ambiguous].map(String)] } });
  if (ds.journals) blocks.push({ h2: 'Journal Check' }, { table: { headers: ['Journals', 'High-risk', 'Caution', 'Scopus', 'WoS', 'MEDLINE'], rows: [[ds.journals.journals, ds.journals.highRisk, ds.journals.caution, ds.journals.scopus, ds.journals.wos, ds.journals.medline].map(String)] } });
  if (ds.pattern) blocks.push({ h2: 'Citation Pattern' }, { table: { headers: ['Self-citation', 'Irrelevant self-cit.', 'Author piles', 'Journal piles', `${cfg.HOME_JOURNAL.name.split(' ').map(w => w[0]).join('')} citations`, 'Off-topic'], rows: [[`${ds.pattern.selfCitationRate}%`, ds.pattern.irrelevantSelfCitations, ds.pattern.authorConcentration, ds.pattern.journalConcentration, ds.pattern.homeJournalCitations, ds.pattern.offTopic].map(String)] } });
  if (ds.topProblems.length) blocks.push({ h2: 'References needing attention' }, { table: { headers: ['#', 'Status', 'Reason', 'Reference'], rows: ds.topProblems.map(p => [String(p.index), p.status, p.reason, p.raw]) } });
  return blocks;
}

function letterBlocks(letter) {
  const blocks = [{ p: letter.subject, bold: true }];
  for (const line of letter.text.split('\n').slice(1)) blocks.push({ p: line });
  return blocks;
}

function issueReportBlocks(label, rep) {
  const t = rep.totals;
  return [
    { h1: `Issue Report — ${label}` },
    { kv: [['Manuscripts', String(t.manuscripts)], ['References checked', String(t.references)], ['Suspicious references', `${t.suspicious} (in ${t.manuscriptsWithSuspicious} manuscripts)`], ['Retracted', String(t.retracted)], ['Miscited', String(t.miscited)], ['Average self-citation', `${t.avgSelfCitation}%`]] },
    { table: { headers: ['Manuscript', 'Ver.', 'Title', 'Refs', 'Suspicious', 'Retracted', 'Miscited', 'Missing cit.', 'Uncited', 'Self-cit. %', 'Problems'], rows: rep.rows.map(r => [r.manuscriptCode, String(r.version), r.title.slice(0, 80), String(r.references), String(r.suspicious), String(r.retracted), String(r.miscited), String(r.missingCitations), String(r.uncited), String(r.selfCitationRate || 0), r.problems.slice(0, 4).join('; ')]) } },
    ...(rep.frequentProblems.length ? [{ h2: 'Most frequent problems' }, { table: { headers: ['Problem', 'Manuscripts'], rows: rep.frequentProblems.map(p => [p.problem, String(p.manuscripts)]) } }] : [])
  ];
}

function reviewersBlocks(res) {
  return [
    { h1: 'Reviewer Candidates' },
    { kv: [['Manuscript', res.query.title || '—'], ['Publications screened', String(res.works)], ['Since', String(res.query.fromYear)]] },
    { p: res.note, italics: true },
    { table: { headers: ['Name', 'ORCID', 'Institution', 'h-index', 'Relevant papers', 'This year', 'COI / flags', 'Evidence'], rows: res.candidates.map(c => [c.name, c.orcid || '—', `${c.institution || '—'}${c.country ? ` (${c.country})` : ''}`, String(c.hIndex ?? '—'), String(c.relevantCount), String(c.workloadThisYear), [...c.coi.map(x => x.message), ...(c.retractions.length ? [`${c.retractions.length} retraction(s)`] : [])].join('; ') || 'None found', c.relevantWorks.slice(0, 2).map(w => `${w.title} (${w.year})`).join(' | ')]) } }
  ];
}

function referenceReportBlocks(result) {
  const s = result.references.summary;
  return [
    { h1: 'Reference Check Report' },
    { kv: [['Manuscript', result.meta?.title || '—'], ['References', String(s.total)], ['Verified', String(s.verified)], ['Miscited', String(s.miscited)], ['Unverified', String(s.unverified)], ['Suspicious', String(s.suspicious)], ['Retracted', String(s.retracted)]] },
    { table: { headers: ['#', 'Status', 'Confidence', 'Reference', 'Finding', 'Suggested correction'], rows: result.references.results.map(r => [String(r.index), r.statusLabel, String(r.confidence), r.raw, [r.reason, ...r.issues.filter(i => i.severity !== 'info').map(i => i.message)].filter((v, i, a) => a.indexOf(v) === i).join('; '), r.suggestion || '']) } }
  ];
}

function revisionBlocks(cmp) {
  const s = cmp.summary;
  return [
    { h1: 'Revision Comparison' },
    { kv: [['Verdict', cmp.verdict], ['Requested fixes addressed', `${s.addressed} of ${s.requested} (${s.completion}%)`], ['Fixed', String(s.fixed)], ['Problem references removed', String(s.removedProblem)], ['Still problematic', String(s.stillProblem)], ['New problems', String(s.newProblem)], ['Added / removed references', `${s.added} / ${s.removed}`]] },
    { table: { headers: ['Change', 'Before', 'After'], rows: cmp.rows.map(r => [r.change, r.before ? `[${r.before.index}] ${r.before.statusLabel}: ${r.before.raw}` : '—', r.after ? `[${r.after.index}] ${r.after.statusLabel}: ${r.after.raw}` : '—']) } }
  ];
}

module.exports = { buildDocx, decisionSummaryBlocks, letterBlocks, issueReportBlocks, reviewersBlocks, referenceReportBlocks, revisionBlocks };
