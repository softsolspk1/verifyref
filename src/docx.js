// docx.js - Word exports built from simple blocks: {h1|h2|p|bullets|table|kv}
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, ImageRun
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
    else if (b.callout) {
      const color = { ok: '1E6B34', warn: '8A5300', bad: '9B1C1C' }[b.callout.level] || '5B6675';
      children.push(para(b.callout.title, { rtl, bold: true, color }));
      if (b.callout.text) children.push(para(b.callout.text, { rtl }));
    } else if (b.scorecard) {
      const label = { ok: 'Pass', warn: 'Check', bad: 'Action', na: 'Not run' };
      children.push(table(['Module', 'Result', 'Verdict'], b.scorecard.map(r => [r.module, r.result, r.verdict || label[r.level] || '—']), rtl));
      children.push(para('', { after: 120 }));
    } else if (b.images) {
      // Images side by side (data: URLs from the browser), each scaled to fit half a page width
      const runs = [];
      for (const im of b.images) {
        const m = String(im.src || '').match(/^data:image\/(png|jpe?g);base64,(.+)$/);
        if (!m) continue;
        const maxW = im.maxWidth || 300, w = im.width || maxW, h = im.height || maxW;
        const k = Math.min(1, maxW / w, 260 / h);
        runs.push(new ImageRun({ type: m[1] === 'png' ? 'png' : 'jpg', data: Buffer.from(m[2], 'base64'), transformation: { width: Math.round(w * k), height: Math.round(h * k) } }), run('    '));
      }
      if (runs.length) children.push(new Paragraph({ children: runs, spacing: { after: 40 } }));
      if (b.caption) children.push(para(b.caption, { size: 17, italics: true, after: 160 }));
    }
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

// ------------------------------------------------------------------ new tools

function verifyBlocks(r) {
  const s = r.summary;
  return [
    { h1: 'Verify Citations — Claim Support Report' },
    { kv: [['Manuscript', r.meta?.title || '—'], ['Cited claims', String(s.claims)], ['Citations checked', String(s.citations)], ['Full match', String(s.full)], ['Partial match', String(s.partial)], ['Unsupported', String(s.unsupported)], ['Could not verify', String(s.couldNotVerify)]] },
    { p: r.method, italics: true },
    { table: { headers: ['Claim', 'Ref.', 'Verdict', 'Evidence', 'Notes'], rows: r.claims.flatMap(c => c.citations.map(x => [c.claim, `[${x.refIndex}] ${x.refStatusLabel}`, x.verdictLabel, x.evidence ? `“${x.evidence.quote}” — ${x.evidence.origin}${x.evidence.page ? ', p. ' + x.evidence.page : ''}` : '—', x.notes.join('; ')])) } }
  ];
}

function evidenceBlocks(r) {
  return [
    { h1: 'Find Evidence' },
    { kv: [['Claim', r.claim], ['Search', r.query], ['Sources screened', String(r.screened || 0)]] },
    ...r.results.flatMap((x, i) => [
      { h2: `${i + 1}. ${x.record.title}` },
      { p: x.citation.text },
      { kv: [['In-text', x.citation.inText], ['Evidence level', `${x.level} (${x.origin})`], ['Support', x.support]] },
      { p: `“${x.quote}”`, italics: true },
      ...(x.wording ? [{ kv: [['Suggested wording', x.wording.wording]] }, { bullets: x.wording.changes }] : [])
    ]),
    ...(r.note ? [{ p: r.note, italics: true }] : [])
  ];
}

function assistantBlocks(r) {
  const out = [{ h1: `Thesis / Paper Assistant — ${r.topic}` }, { p: r.disclaimer, italics: true }];
  const sec = (s, level) => {
    out.push(level === 1 ? { h1: s.heading } : { h2: s.heading });
    for (const p of s.paragraphs || []) if (p.sentences.length) out.push({ p: p.sentences.map(x => (x.label ? `[${x.label}] ` : '') + x.display).join(' ') });
    for (const sub of s.subsections || []) sec(sub, 2);
  };
  for (const s of r.sections) sec(s, 1);
  if (r.analysis?.topics?.length) out.push({ h2: 'Sub-topics (last six years)' }, { table: { headers: ['Sub-topic', 'Papers', 'Growth (3 yrs)'], rows: r.analysis.topics.map(t => [t.name, String(t.works), t.growth === null || t.growth === undefined ? '—' : `${t.growth}%`]) } });
  out.push({ h1: 'References' }, ...r.references.map(x => ({ p: `${x.number}. ${x.text}` })));
  return out;
}

function journalFinderBlocks(r) {
  const list = r.journals || [];
  return [
    { h1: 'Journal Suggestions' },
    { kv: [['Paper', r.title], ['Similar papers screened', String(r.screened)], ['Period', `${r.since}–present`]] },
    { table: { headers: ['Journal', 'Similar papers', 'Indexing', 'Quartile', 'Access / APC', 'Weeks', 'Signals'], rows: list.map(j => [`${j.name}${j.publisher ? ` (${j.publisher})` : ''}`, String(j.similar), [j.indexing.scopus ? 'Scopus' : null, ...(j.indexing.wos || []), j.indexing.medline ? 'MEDLINE' : null, j.doaj ? 'DOAJ' : null, j.indexing.ebsco ? 'EBSCO' : null, j.indexing.hjrs ? `HJRS ${j.indexing.hjrs}` : null].filter(Boolean).join(', ') || '—', j.quartile ? `Q${j.quartile}` : '—', `${j.diamond ? 'Diamond OA' : j.oa ? 'Open access' : 'Subscription/hybrid'}${j.apcUsd ? ` · $${j.apcUsd}` : ''}`, j.weeksToPublication ? String(j.weeksToPublication) : '—', (j.flags || []).map(f => f.message).join('; ') || (j.scopeMatch === 'weak' ? 'Weak scope match' : '')]) } }
  ];
}

function conferenceBlocks(r) {
  if (r.mode === 'check') {
    return [{ h1: `Conference Check — ${r.query}` }, { p: r.note, italics: true }, ...r.candidates.flatMap(c => [{ h2: c.name }, { kv: [['Publisher', c.publisher || '—'], ['Scopus (uploaded list)', c.scopus.known ? (c.scopus.indexed ? `Indexed: ${c.scopus.coverage || ''}` : 'Discontinued') : 'Not in the uploaded Scopus list'], ['Regularity', c.regularity]] }, { table: { headers: ['Year', 'Papers (OpenAlex)', 'Scopus coverage'], rows: (c.yearByYear || []).map(y => [String(y.year), String(y.works), y.scopus === null ? '—' : y.scopus ? 'Yes' : 'No']) } }])];
  }
  return [{ h1: 'Conference Suggestions' }, { kv: [['Paper', r.title]] }, { p: r.note, italics: true }, { table: { headers: ['Proceedings', 'Similar papers', 'Scopus', 'Years', 'Last edition', 'Example'], rows: r.conferences.map(c => [c.name, String(c.similar), c.scopus.known ? (c.scopus.indexed ? 'Indexed' : 'Discontinued') : 'Unknown', c.regularity, String(c.lastYear || '—'), c.samples[0]?.title || '']) } }];
}

function complianceBlocks(c) {
  if (!c) return [];
  const s = c.summary;
  return [
    { h2: 'PJPS style compliance' },
    { kv: [['Compliant references', `${s.compliant} of ${s.total} (${s.score}%)`], ['Deviations', String(s.deviations)], ['In-text citation problems', String(s.inTextIssues)]] },
    { table: { headers: ['#', 'Reference as submitted', 'Deviations', 'Expected (PJPS)'], rows: c.entries.filter(e => !e.compliant).map(e => [String(e.index), e.original, e.deviations.filter(d => d.severity !== 'info').map(d => d.message + (d.found ? ` (found: ${d.found})` : '') + (d.expected ? ` → ${d.expected}` : '')).join('; '), e.expected || '']) } },
    ...(c.inText.issues.length ? [{ h2: 'In-text citations' }, { table: { headers: ['Citation', 'Problem'], rows: c.inText.issues.map(i => [i.citation || '—', i.message]) } }] : [])
  ];
}

function restyleBlocks(r) {
  return [
    ...complianceBlocks(r.compliance),
    { h1: `Reference Style — ${r.styleLabel}` },
    { kv: [['File', r.filename || 'Pasted list'], ['References', String(r.counts.total)], ['Matched to registered records', String(r.counts.matched)], ['Formatted from the text as written', String(r.counts.parsed)], ['Left unchanged', String(r.counts.kept)], ['In-text citations converted', String(r.citationsConverted || 0)]] },
    { table: { headers: ['#', 'Converted reference', 'Status', 'Filled in / corrected'], rows: r.entries.map(e => [String(e.number), e.text, e.status, [...(e.filled || []), ...(e.corrected || []).map(c => `${c} corrected`)].join(', ')]) } }
  ];
}

function formatBlocks(r) {
  return [
    { h1: `Manuscript Format — ${r.templateLabel}` },
    { kv: [['File', r.filename], ['Article type', r.structure.articleType], ['Abstract', r.structure.abstractWords === null ? 'not found' : `${r.structure.abstractWords} words (limit ${r.structure.abstractLimit})`]] },
    { h2: 'Changes applied' }, { bullets: r.changes },
    { h2: 'Section checklist' }, { table: { headers: ['Section', 'Present'], rows: r.structure.sections.map(s => [s.section, s.present ? 'Yes' : 'Missing']) } },
    { p: r.note, italics: true }
  ];
}

function authorBlocks(r) {
  return [
    { h1: `Publications — ${r.author?.name || ''}` },
    { kv: [['Institution', r.author?.institution || '—'], ['ORCID', r.author?.orcid || '—'], ['Works', String(r.total)]] },
    ...r.works.map(w => ({ p: w.text }))
  ];
}

// ------------------------------------------------------------------ PJPS v4 modules

function citationsBlocks(r) {
  const s = r.summary, c = r.consistency || {};
  const rows = (items, f) => (items || []).map(f);
  return [
    { h1: 'Module 3 — Citations Report' },
    { kv: [['Manuscript', r.meta?.title || '—'], ['References', String(s.references)], ['In-text citations', String(s.citations)], ['Missing from the list', String(s.missing)], ['Never cited', String(s.uncited)], ['Year mismatches', String(s.yearMismatch)], ['“et al.” problems', String(s.etAl)], ['Citation blocks', String(s.blocks)], ['Claims checked', String(s.claims)], ['Unsupported claims', String(s.unsupported)], ['Partially supported', String(s.partial)]] },
    { h2: 'A. Citations and reference list' },
    { table: { headers: ['Problem', 'Citation / reference', 'Detail'], rows: [
      ...rows(c.missing, m => ['Missing from list', m.citation, `${m.reason}${m.para ? ` (paragraph ${m.para})` : ''}${m.context ? ` — …${m.context}…` : ''}`]),
      ...rows(c.uncited, u => ['Never cited', `[${u.index}]`, u.raw]),
      ...rows(c.yearMismatch, y => ['Year mismatch', y.citation, y.message]),
      ...rows(c.spelling, y => ['Name spelling', y.citation, y.message]),
      ...rows(c.ambiguous, a => ['Ambiguous', a.citation, a.message]),
      ...rows(c.etAlIssues, e => ['“et al.”', e.citation, e.message]),
      ...rows(c.blocks, b => ['Citation block', b.citation, b.message]),
      ...rows(c.orderIssues, o => ['Order', '', o.message]),
      ...rows(c.numberingIssues, n => ['Numbering', '', n])
    ] } },
    ...(r.claims && !r.claims.error ? [{ h2: 'B. Claim support' }, { p: r.claims.method, italics: true }, { table: { headers: ['Claim', 'Ref.', 'Verdict', 'Evidence'], rows: r.claims.claims.flatMap(cl => cl.citations.filter(x => x.verdict !== 'full').map(x => [cl.claim, `[${x.refIndex}] ${x.refStatusLabel}`, x.verdictLabel, x.evidence ? `“${x.evidence.quote}” — ${x.evidence.origin}${x.evidence.page ? ', p. ' + x.evidence.page : ''}` : x.notes.join('; ')])) } }] : []),
    { h2: 'C. Citation pattern' },
    { bullets: r.pattern.flags.length ? r.pattern.flags.map(f => `${f.message} — ${f.guidance}`) : ['No unusual citation pattern found.'] }
  ];
}

function papermillBlocks(r) {
  const groups = { text: 'Text signals', references: 'Reference signals', authors: 'Author & submission signals', data: 'Data signals' };
  return [
    { h1: 'CONFIDENTIAL — Module 4 Paper Mill Screening' },
    { p: r.disclaimer, italics: true },
    { kv: [['Manuscript', `${r.meta?.manuscriptCode ? r.meta.manuscriptCode + ' — ' : ''}${r.meta?.title || '—'}`], ['Risk level', `${r.risk.level} (score ${r.risk.score}, ${r.risk.highSignals} strong signal(s))`], ['Date', new Date(r.createdAt).toISOString().slice(0, 10)]] },
    ...Object.entries(groups).flatMap(([g, label]) => {
      const list = r.signals.filter(x => x.group === g);
      return [{ h2: label }, list.length ? { table: { headers: ['Signal', 'Weight', 'Evidence'], rows: list.map(x => [`${x.title}${x.note ? ` — ${x.note}` : ''}`, `${x.severity} (${x.weight})`, (x.evidence || []).slice(0, 12).map(e => `${e.text}${e.quote ? ` — “${e.quote}”` : ''}${e.note ? ` (${e.note})` : ''}`).join('\n')]) } } : { p: 'No signal found.' }];
    }),
    ...(r.guidance?.available ? [{ h2: 'Suggested handling for this risk level' }, { kv: [['Before publication', r.guidance.decision.desk], ['After publication', r.guidance.decision.post]] }, { bullets: r.guidance.evidence }] : []),
    ...(r.decision ? [{ h2: 'Editor decision' }, { kv: [['Decision', r.decision.label || '—'], ['Notes', r.decision.notes || '—'], ['By', `${r.decision.by}, ${r.decision.at.slice(0, 10)}`]] }] : [])
  ];
}

/** Module 5.7: the ImageTwin scan, if the editor sent the manuscript (otherwise the report says it was not checked) */
function vendorBlocks(v) {
  if (!v) return [{ h2: 'ImageTwin (external database of published figures)' }, { p: 'Not checked: the manuscript was not sent to ImageTwin.' }];
  const head = { h2: `ImageTwin (external database of published figures)${v.sandbox ? ' - SANDBOX TEST RESULT, NOT A REAL CHECK' : ''}` };
  const sent = `Sent ${String(v.createdAt || '').slice(0, 10)}${v.files ? ` (${v.files})` : ''}.`;
  if (v.status === 'running') return [head, { p: `${sent} The scan had not finished when this report was produced.` }];
  if (v.status !== 'finished') return [head, { p: `${sent} The scan failed: ${v.error || 'no reason given'}.` }];
  const r = v.result;
  return [head, { kv: [['Risk (ImageTwin confidence bands)', v.level], ['Matches with published figures', String(r.externalDuplicates)], ['Duplicates inside the manuscript', String(r.localDuplicates)], ['Alterations', String(r.alterations)],
    ['Possible AI-generated images', String(r.aiImages)], ['Highest confidence', `${Math.round(r.highestScore * 100)}% (0-32% low, 33-65% fair, 66-100% high)`], ['Findings counted from', `${Math.round(r.minScore * 100)}% confidence`],
    ['Findings at ImageTwin', r.resultUrl || '-'], ['ImageTwin PDF report', r.pdfReport || '-']] },
  { p: `${sent} ImageTwin keeps these links for 90 days; download its PDF report for the editorial file.`, italics: true }];
}

function imagesBlocks(r) {
  const s = r.summary;
  const marks = new Map((r.findingMarks || []).map(m => [m.id, m.mark]));
  const label = { confirmed: 'Confirmed by editor', false: 'False alarm', ask: 'Ask the authors' };
  return [
    { h1: 'CONFIDENTIAL — Module 5 Image Integrity Report' },
    { p: r.disclaimer, italics: true },
    { kv: [['Manuscript', `${r.meta?.manuscriptCode ? r.meta.manuscriptCode + ' — ' : ''}${r.meta?.title || r.meta?.filename || '—'}`], ['Image risk', s.level], ['Images / panels analysed', `${s.images} / ${s.panels}`], ['Findings', `${s.findings} (${s.byLevel.high || 0} strong, ${s.byLevel.medium || 0} to check)`], ['Earlier PJPS manuscripts sharing a figure', String((r.earlier || []).length)], ['(a) Duplication & reuse', String((r.findings || []).filter(f => (f.category || 'duplication') === 'duplication').length)], ['(b) Alteration & manipulation', String((r.findings || []).filter(f => f.category === 'manipulation').length)], ['(c) AI-generated image indicators', String((r.findings || []).filter(f => f.category === 'ai').length)], ['(d) Graph & chart duplication', String((r.findings || []).filter(f => f.category === 'chart').length) + ((r.earlierCharts || []).length ? ` (+${r.earlierCharts.length} matching earlier manuscripts)` : '')], ['PJPS image databases (published PJPS papers, retracted papers, PubMed Central, reference figures)', r.references ? `${r.references.length + (r.referenceCharts || []).length} match(es) in ${(r.referencesSearched?.refs || 0).toLocaleString()} reference panels` : 'Not checked (report made before the databases were added)'], ['Comparison with all 155-160 million published figures', r.vendor?.connected ? 'Checked by vendor' : 'Not checked (vendor not connected)']] },
    { p: r.method, italics: true },
    ...r.findings.flatMap((f, i) => [
      { h2: `Finding ${i + 1} [${({ duplication: "Duplication", manipulation: "Manipulation", ai: "AI-generated", chart: "Chart" })[f.category || "duplication"]}]: ${f.a.label}${f.a.panel !== f.b.panel ? ` ↔ ${f.b.label}` : ''}` },
      { p: `${f.level === 'high' ? 'Strong' : 'Check'} — ${f.description}${marks.get(f.id) ? ` · ${label[marks.get(f.id)] || marks.get(f.id)}` : ''}` },
      ...((f.details || []).length ? [{ bullets: f.details }] : []),
      ...(f.assessment ? [{ p: `Type: ${f.assessment.name} (${f.assessment.category}; usual risk ${f.assessment.risk}, false-alarm risk ${f.assessment.falsePositiveRisk}). Common harmless causes: ${f.assessment.falseAlarms.join('; ') || '—'}.`, italics: true }] : []),
      { images: [{ src: f.thumbA, width: f.thumbAW, height: f.thumbAH }, ...(f.thumbB && f.b.panel !== f.a.panel ? [{ src: f.thumbB, width: f.thumbBW, height: f.thumbBH }] : [])], caption: 'Matched areas are outlined.' }
    ]),
    ...((r.references || []).length ? [{ h2: 'Figures matching published PJPS papers and reference databases' }, { table: { headers: ['This manuscript', 'Database', 'Source paper', 'Figure / how', 'Match'], rows: r.references.map(m => [m.panelLabel, m.sourceName, `${m.title || ''}${m.journal ? ` — ${m.journal}` : ''}${m.year ? ` (${m.year})` : ''}${m.doi ? ` doi:${m.doi}` : ''}${m.note ? ` [${m.note}]` : ''}`, `${m.figure}: ${m.description}`, `${m.level === 'high' ? 'Strong' : 'Check'} · distance ${m.distance}${m.correlation !== null ? ` · correlation ${m.correlation}` : ''}`]) } }] : []),
    ...((r.referenceCharts || []).length ? [{ h2: 'Chart data matching published / reference charts' }, { table: { headers: ['This manuscript', 'Database', 'Source paper', 'Correlation'], rows: r.referenceCharts.map(c => [c.chart, c.sourceName, `${c.title || ''}${c.doi ? ` doi:${c.doi}` : ''}`, String(c.correlation)]) } }] : []),
    ...((r.earlier || []).length ? [{ h2: 'Figures matching earlier PJPS manuscripts' }, { table: { headers: ['This manuscript', 'Earlier manuscript', 'Earlier figure', 'Distance'], rows: r.earlier.map(e => [e.panelLabel, `${e.manuscriptCode || 'check #' + e.checkId}: ${e.title || ''}`, e.label || '', String(e.distance)]) } }] : []),
    ...vendorBlocks(r.vendorScan),
    ...(r.decision ? [{ h2: 'Editor decision' }, { kv: [['Decision', r.decision.label || '—'], ['Notes', r.decision.notes || '—'], ['By', `${r.decision.by}, ${r.decision.at.slice(0, 10)}`]] }] : [])
  ];
}

/**
 * Full Screening Report. version 'editor': all modules with the recommendation; 'author': Modules 1-3 only (problems
 * the authors must fix), for sending after the editor's approval.
 */
/** One row per module of the Full Screening Report with its verdict (ok | warn | bad | na) */
function screeningScorecard(r) {
  const sc = r.screening || { lines: {} };
  const s = r.references.summary;
  const c = r.citations && !r.citations.error ? r.citations.summary : null;
  const cp = r.compliance?.summary;
  const pm = r.papermill?.risk;
  const im = r.images?.summary;
  const lvl = x => ({ HIGH: 'bad', MEDIUM: 'warn', LOW: 'ok' }[x] || 'na');
  const rows = [
    { module: '1. Bibliography (references)', result: sc.lines.bibliography || `${s.verified} verified of ${s.total}`, level: s.suspicious >= 3 || s.retracted ? 'bad' : s.suspicious || s.miscited >= 5 || s.unverified >= Math.max(5, s.total * 0.2) ? 'warn' : 'ok' },
    { module: '2. Reference style (PJPS)', result: sc.lines.style || 'not checked', level: !cp ? 'na' : cp.score >= 80 ? 'ok' : cp.score >= 60 ? 'warn' : 'bad' },
    { module: '3. In-text citations', result: sc.lines.citations || 'not checked', level: !c ? 'na' : c.missing >= 3 || c.uncited >= 5 ? 'bad' : c.missing || c.uncited || c.yearMismatch ? 'warn' : 'ok' },
    { module: '4. Paper mill signals', result: sc.lines.papermill || 'not checked', level: lvl(pm?.level) },
    { module: '5. Image integrity', result: sc.lines.images || 'not checked', level: lvl(im?.level) }
  ];
  if (r.plagiarism) rows.push({ module: '6. Plagiarism (text overlap)', result: r.plagiarism.error || sc.lines.plagiarism || `${r.plagiarism.summary.similarity}% overlap`, level: r.plagiarism.error ? 'na' : r.plagiarism.summary.level });
  if (r.novelty) rows.push({ module: '7. Novelty & citation outlook', result: r.novelty.error || sc.lines.novelty || `novelty ${r.novelty.summary.score}/100`, level: r.novelty.error ? 'na' : r.novelty.summary.level, verdict: r.novelty.error ? null : `${r.novelty.summary.band[0].toUpperCase()}${r.novelty.summary.band.slice(1)}` });
  if (r.authorIdentity) rows.push({ module: '8. Author identity (ORCID)', result: r.authorIdentity.error || sc.lines.authors || '', level: r.authorIdentity.error ? 'na' : r.authorIdentity.summary.level });
  return rows;
}

/** Module 6: text overlap with published papers */
function plagiarismBlocks(pl) {
  const blocks = [{ h2: '6. Plagiarism — text overlap with published papers' }];
  if (!pl || pl.error) return [...blocks, { p: pl?.error || 'Not checked.' }];
  const s = pl.summary;
  blocks.push({ kv: [['Overall similarity', `${s.similarity}% of the manuscript's words`], ['Largest single source', `${s.largestSource}%`], ['Sources with overlap', String(s.sources)],
    ['Passages searched', `${pl.checked.passages} (${pl.checked.queries} searches; ${pl.checked.candidates} candidate papers)`], ['Databases', pl.checked.databases.join('; ')]] });
  if (pl.sources.length) {
    blocks.push({ table: { headers: ['Similarity', 'Source', 'Compared', 'Longest matching passage'], rows: pl.sources.map(x => [`${x.similarity}%`, `${x.title || '—'}${x.journal ? ` — ${x.journal}` : ''}${x.year ? `, ${x.year}` : ''}${x.doi ? ` (doi:${x.doi})` : ''}`, x.compared, x.passages[0] ? `${x.passages[0].words} words: "${x.passages[0].text.slice(0, 300)}${x.passages[0].text.length > 300 ? '...' : ''}"` : '']) } });
  } else blocks.push({ p: 'No overlapping text was found in the searched literature.' });
  if (pl.selfMatches?.length) blocks.push({ p: `Not counted (the manuscript's own published version or preprint): ${pl.selfMatches.map(x => `${x.title}${x.year ? ` (${x.year})` : ''}`).join('; ')}`, italics: true });
  if (pl.earlierSubmissions?.length) blocks.push({ p: `Earlier PJPS submissions with the same text: ${pl.earlierSubmissions.join('; ')}`, bold: true });
  blocks.push({ p: pl.method, italics: true });
  return blocks;
}

/** Module 7: novelty and citation outlook (OpenAlex data model) */
function noveltyBlocks(nv) {
  const blocks = [{ h2: '7. Novelty and citation outlook' }];
  if (!nv || nv.error) return [...blocks, { p: nv?.error || 'Not assessed.' }];
  const s = nv.summary, f = nv.forecast;
  blocks.push({ kv: [['Novelty score', `${s.score}/100 (${s.band})`], ['Components', `distance from closest work ${nv.components.distance}, uncrowded field ${100 - nv.components.crowding}${nv.components.rarity === null ? '' : `, rare concept combination ${nv.components.rarity}`}`],
    ['Closest published work', nv.closest[0] ? `${nv.closest[0].title} (${nv.closest[0].year}) — similarity ${nv.closest[0].similarity}` : '—'],
    ['Close works (last 5 years)', `${s.closeRecent} of ${s.closeWorks} close works`],
    ['Research topic', nv.momentum ? `${nv.momentum.topic}: ${nv.momentum.trend}${nv.momentum.growthPerYear !== null ? ` (${nv.momentum.growthPerYear > 0 ? '+' : ''}${nv.momentum.growthPerYear}% works per year)` : ''}` : '—'],
    ['Works compared', `${nv.checked.works} (${nv.checked.database})`]] });
  if (nv.concepts?.pairs?.length) blocks.push({ table: { headers: ['Concepts studied together', 'Published works'], rows: nv.concepts.pairs.map(p => [`${p.a} + ${p.b}`, p.works === null || p.works === undefined ? '—' : Number(p.works).toLocaleString()]) } });
  blocks.push({ table: { headers: ['Closest published works', 'Year', 'Similarity', 'Cited by'], rows: nv.closest.slice(0, 8).map(w => [`${w.title}${w.journal ? ` — ${w.journal}` : ''}${w.doi ? ` (doi:${w.doi})` : ''}`, String(w.year || ''), String(w.similarity), String(w.citedBy)]) } });
  blocks.push({ p: 'Citation outlook (if published in the journal):', bold: true });
  blocks.push({ table: { headers: ['After', 'Expected citations (median)', 'Likely range (25-75%)', 'Similar works used'], rows: f.horizon.map(h => [`${h.years} year${h.years > 1 ? 's' : ''}`, h.median === null ? 'insufficient data' : String(h.median), h.median === null ? '—' : `${h.low} - ${h.high}`, String(h.basis)]) } });
  if (f.journalNote) blocks.push({ p: f.journalNote, italics: true });
  blocks.push({ p: `${nv.method} ${f.method}`, italics: true });
  return blocks;
}

/** Section 8: author identity from the ORCID registry */
function authorIdentityBlocks(ai) {
  const blocks = [{ h2: '8. Author identity (ORCID)' }];
  if (!ai || ai.error) return [...blocks, { p: ai?.error || 'Not checked.' }];
  const s = ai.summary;
  blocks.push({ kv: [['Authors', String(s.authors)], ['Identified in ORCID', `${s.verified} (${s.fromManuscript} from iDs in the manuscript)`], ['ORCID iDs in the manuscript', String(s.idsInManuscript)], ['Problems', String(s.flags)]] });
  if (ai.flags.length) blocks.push({ callout: { level: s.level, title: 'Author identity problems', text: ai.flags.map(f => f.text).join(' · ') } });
  blocks.push({ table: { headers: ['Author', 'ORCID', 'How identified', 'Institutions (ORCID)', 'Publications', "In the manuscript's field"], rows: ai.authors.map(a => [a.author, a.orcid || '—',
    a.status === 'verified' ? a.source : a.note || a.status,
    a.record ? [...new Set(a.record.employments.map(e => e.organization))].slice(0, 3).join('; ') || '—' : a.candidates?.length ? `candidates: ${a.candidates.map(c => `${c.id}${c.institutions.length ? ` (${c.institutions[0]})` : ''}`).join('; ')}` : '—',
    a.record ? `${Math.max(a.record.works, a.openalex?.works || 0)}${a.openalex?.hIndex != null ? `, h-index ${a.openalex.hIndex}` : ''}` : '—',
    a.record ? [a.claimsThisWork ? 'this manuscript is in the record' : '', a.field?.relatedWorks ? `${a.field.relatedWorks} related work(s)` : '', a.field?.topicMatch ? 'topic match' : ''].filter(Boolean).join('; ') || 'none listed' : '—']) } });
  blocks.push({ p: ai.method, italics: true });
  return blocks;
}

function screeningBlocks(r, version = 'editor') {
  const sc = r.screening || { lines: {} };
  const s = r.references.summary;
  const meta = r.meta || {};
  const problemRefs = r.references.results.filter(x => ['suspicious', 'retracted', 'miscited', 'unverified'].includes(x.status));
  const c = r.citations && !r.citations.error ? r.citations : null;
  const blocks = [
    { h1: version === 'editor' ? 'Full Screening Report — editor version (confidential)' : 'Manuscript screening — items to correct' },
    { kv: [['Manuscript', `${meta.manuscriptCode ? meta.manuscriptCode + ' — ' : ''}${meta.title || '—'}`], ['Version', String(meta.version || 1)], ['Date', new Date(r.createdAt).toISOString().slice(0, 10)]] }
  ];
  if (version === 'editor') {
    blocks.push({ h2: 'Summary' }, { callout: { level: { proceed: 'ok', return: 'warn', investigate: 'bad' }[sc.recommendation] || 'na', title: `Recommendation: ${sc.recommendationLabel || '—'}`, text: (sc.reasons || []).join(' · ') } });
    blocks.push({ scorecard: screeningScorecard(r) });
    if (r.decision) blocks.push({ kv: [['Editor decision', r.decision.label || '—'], ['Notes', r.decision.notes || '—']] });
  } else {
    blocks.push({ p: `Before peer review your manuscript was checked: references against international scholarly databases, the journal's reference style, and in-text citations against the reference list. Please correct the items below and resubmit with a point-by-point response.` });
  }
  blocks.push({ h2: '1. References' }, { kv: [['Checked', String(s.total)], ['Verified', String(s.verified)], ['Wrong details', String(s.miscited)], ['Not found in any database', String(s.suspicious)], ['Retracted', String(s.retracted)]] });
  if (problemRefs.length) blocks.push({ table: { headers: ['#', 'Reference', 'Problem', 'Suggested correction'], rows: problemRefs.map(x => [String(x.index), x.raw, `${x.statusLabel}: ${x.reason}`, x.suggestion || '']) } });
  if (r.indicators?.flags?.length) blocks.push({ bullets: r.indicators.flags.map(f => f.message) });
  if (r.compliance) blocks.push(...complianceBlocks(r.compliance).map(b => (b.h2 ? { h2: '2. Reference style (PJPS)' } : b)));
  blocks.push({ h2: '3. In-text citations' });
  if (c) {
    const rows = [
      ...(c.missing || []).map(m => ['Cited but not in the list', m.citation, m.reason]),
      ...(c.uncited || []).map(u => ['In the list but never cited', `[${u.index}]`, u.raw]),
      ...(c.yearMismatch || []).map(y => ['Year differs', y.citation, y.message]),
      ...(c.ambiguous || []).map(a => ['Ambiguous', a.citation, a.message]),
      ...(c.etAlIssues || []).map(e => ['“et al.”', e.citation, e.message])
    ];
    blocks.push(rows.length ? { table: { headers: ['Problem', 'Citation', 'Detail'], rows } } : { p: 'No problems found.' });
  } else blocks.push({ p: 'Not checked (manuscript text not available).' });
  if (version === 'editor') {
    if (r.pattern?.flags?.length) blocks.push({ h2: 'Citation pattern' }, { bullets: r.pattern.flags.map(f => f.message) });
    if (r.papermill) blocks.push(...papermillBlocks(r.papermill).map(b => (b.h1 ? { h2: '4. Paper mill screening (confidential)' } : b)));
    blocks.push({ h2: '5. Image integrity' }, { p: r.images ? `Image risk ${r.images.summary.level}: ${r.images.summary.findings} finding(s) in ${r.images.summary.panels} panels${(r.images.summary.references || 0) + (r.images.summary.referenceCharts || 0) ? `, ${(r.images.summary.references || 0) + (r.images.summary.referenceCharts || 0)} figure(s) matching published PJPS / retracted-paper figures` : ''} — see the separate confidential image report.` : 'Not checked — run Module 5 and attach its report.' });
    if (r.plagiarism) blocks.push(...plagiarismBlocks(r.plagiarism));
    if (r.novelty) blocks.push(...noveltyBlocks(r.novelty));
    if (r.authorIdentity) blocks.push(...authorIdentityBlocks(r.authorIdentity));
  }
  return blocks;
}

module.exports = {
  complianceBlocks, citationsBlocks, papermillBlocks, imagesBlocks, screeningBlocks, plagiarismBlocks, noveltyBlocks, authorIdentityBlocks,
  buildDocx, decisionSummaryBlocks, letterBlocks, issueReportBlocks, reviewersBlocks, referenceReportBlocks, revisionBlocks,
  verifyBlocks, evidenceBlocks, assistantBlocks, journalFinderBlocks, conferenceBlocks, restyleBlocks, formatBlocks, authorBlocks
};
