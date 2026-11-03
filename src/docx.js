// docx.js - Word exports built from simple blocks: {h1|h2|p|bullets|table|kv}
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, ImageRun,
  Header, Footer, PageNumber, PageBreak
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

// Similarity report text: runs of the manuscript highlighted in their source's colour, with the source number (Turnitin style)
// the same colours as the report view (public/js/views/similarity.js) and the PDF
const MARK_COLORS = ['D7263D', '1B998B', '3A50D9', 'F46036', '8E44AD', '2E86AB', 'C2185B', '8D6E63', '6B8E23', '283593', 'E0A100', '00897B', '7B1FA2', '5D4037', '455A64'];
const markColor = no => MARK_COLORS[(no - 1) % MARK_COLORS.length];
const lighten = hex => hex.match(/../g).map(c => Math.round(255 - (255 - parseInt(c, 16)) * 0.22).toString(16).padStart(2, '0')).join('').toUpperCase();
function markedParagraphs(segments) {
  const paras = [[]];
  for (const seg of segments) {
    const lines = String(seg.t).split(/\n+/);
    lines.forEach((line, i) => {
      if (i > 0) paras.push([]);
      if (!line) return;
      const cur = paras[paras.length - 1];
      if (seg.s && i === 0) cur.push(new TextRun({ text: String(seg.s), superScript: true, bold: true, color: markColor(seg.s), font: 'Calibri', size: 17 }));
      // text of a section the editor excluded from the comparison is greyed
      cur.push(new TextRun({ text: line, font: 'Calibri', size: 19, ...(seg.s ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: lighten(markColor(seg.s)) } } : seg.x ? { color: '9AA0A6' } : {}) }));
    });
  }
  return paras.filter(r => r.length).map(r => new Paragraph({ children: r, spacing: { after: 100, line: 276 } }));
}

async function buildDocx(blocks, { rtl = false, title = cfg.APP_NAME } = {}) {
  const children = [];
  for (const b of blocks) {
    if (b.pageBreak) children.push(new Paragraph({ children: [new PageBreak()] }));
    else if (b.h1) children.push(para(b.h1, { heading: HeadingLevel.HEADING_1, rtl, after: 120 }));
    else if (b.h2) children.push(para(b.h2, { heading: HeadingLevel.HEADING_2, rtl, after: 100 }));
    else if (b.h3) children.push(para(b.h3, { heading: HeadingLevel.HEADING_3, rtl, after: 80 }));
    else if (b.p !== undefined) children.push(para(b.p, { rtl, bold: b.bold, italics: b.italics, color: b.color }));
    else if (b.bullets) for (const t of b.bullets) children.push(para(t, { rtl, bullet: true }));
    else if (b.kv) for (const [k, v] of b.kv) children.push(para([run(`${k}: `, { bold: true, rtl }), run(v, { rtl })], { rtl }));
    else if (b.table) { children.push(table(b.table.headers, b.table.rows, rtl)); children.push(para('', { after: 120 })); }
    else if (b.marked) children.push(...markedParagraphs(b.marked));
    else if (b.callout) {
      // a shaded box with a coloured bar on the left, as in the PDF
      const L = { ok: ['1E6B34', 'E6F4EA'], warn: ['8A5300', 'FFF4E0'], bad: ['9B1C1C', 'FDE8E8'] }[b.callout.level] || ['5B6675', 'F1F3F5'];
      const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: none, bottom: none, right: none, insideHorizontal: none, insideVertical: none, left: { style: BorderStyle.SINGLE, size: 24, color: L[0] } },
        rows: [new TableRow({ children: [new TableCell({
          shading: { type: ShadingType.CLEAR, color: 'auto', fill: L[1] },
          margins: { top: 100, bottom: 100, left: 160, right: 160 },
          children: [para(b.callout.title, { rtl, bold: true, color: L[0], size: 24, after: b.callout.text ? 60 : 0 }), ...(b.callout.text ? [para(b.callout.text, { rtl, after: 0 })] : [])]
        })] })]
      }));
      children.push(para('', { after: 120 }));
    } else if (b.scorecard) {
      const label = { ok: 'Pass', warn: 'Check', bad: 'Action', na: 'Not run' };
      children.push(table(['Module', 'Result', 'Verdict'], b.scorecard.map(r => [r.module, r.result, r.verdict || label[r.level] || '—']), rtl));
      children.push(para('', { after: 120 }));
    } else if (b.images) {
      // Images side by side (data: URLs from the browser), each scaled to fit half a page width
      const pics = b.images.map(im => ({ im, m: String(im.src || '').match(/^data:image\/(png|jpe?g);base64,(.+)$/) })).filter(x => x.m);
      const maxW = pics.length > 2 ? 200 : 300;
      const picture = ({ im, m }) => {
        const mw = Math.min(im.maxWidth || maxW, maxW), w = im.width || mw, h = im.height || mw;
        const k = Math.min(im.upscale ? 4 : 1, mw / w, (im.upscale ? 200 : 260) / h);
        return new ImageRun({ type: m[1] === 'png' ? 'png' : 'jpg', data: Buffer.from(m[2], 'base64'), transformation: { width: Math.round(w * k), height: Math.round(h * k) } });
      };
      if (pics.length && pics.some(x => x.im.label)) {
        // one column per picture with its label underneath (which panel / source figure / original area / copy)
        const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
          rows: [new TableRow({ children: pics.map(x => new TableCell({
            width: { size: Math.floor(100 / pics.length), type: WidthType.PERCENTAGE },
            margins: { top: 40, bottom: 40, left: 40, right: 120 },
            children: [new Paragraph({ children: [picture(x)], spacing: { after: 40 } }), para(x.im.label || '', { size: 17, bold: true, color: x.im.tone === 'bad' ? '9B1C1C' : '0F4C5C', after: 0 })]
          })) })]
        }));
      } else if (pics.length) children.push(new Paragraph({ children: pics.flatMap(x => [picture(x), run('    ')]), spacing: { after: 40 } }));
      if (b.caption) children.push(para(b.caption, { size: 17, italics: true, after: 160 }));
    }
  }
  children.push(para(`${cfg.APP_NAME} · ${cfg.APP_VENDOR} · ${new Date().toISOString().slice(0, 10)}`, { size: 16, color: '7A8794', italics: true }));
  // running header (report title) and footer with page numbers on every page
  const name = title === cfg.APP_NAME ? (blocks.find(x => x.h1)?.h1 || '') : title;
  const small = (text, o = {}) => new TextRun({ ...(text ? { text } : {}), font: 'Calibri', size: 16, color: '7A8794', ...o });
  const headers = { default: new Header({ children: [new Paragraph({ children: [small(`${cfg.APP_NAME}  |  ${name}`)], border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'BFC8D2', space: 4 } } })] }) };
  const footers = { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [small(`${cfg.APP_NAME} · ${cfg.APP_VENDOR} · page `), small('', { children: [PageNumber.CURRENT] }), small(' of '), small('', { children: [PageNumber.TOTAL_PAGES] })] })] }) };
  const doc = new Document({ title, creator: cfg.APP_VENDOR, sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 900, right: 900 } } }, headers, footers, children }] });
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

/** Module 1 reference quality (RefGuard style): four scores, comparison with earlier PJPS submissions, paratexts */
function referenceQualityBlocks(rq) {
  if (!rq?.scores) return [];
  const c = rq.comparison || {};
  const rows = [['quality', 'Quality'], ['impact', 'Impact'], ['recency', 'Recency'], ['diversity', 'Diversity']].map(([k, l]) => [l, rq.scores[k]?.score ?? '—', c.available && c[k]?.average !== null ? `${c[k].average} (${c[k].difference >= 0 ? '+' : ''}${c[k].difference})` : '—', rq.scores[k]?.facts || ''].map(String));
  return [
    { h2: 'Reference quality' },
    { table: { headers: ['Score (0–100)', 'This manuscript', 'PJPS average (difference)', 'Based on'], rows } },
    { p: c.available ? `Averages over ${c.n} manuscripts screened earlier in this system.` : `The comparison with earlier PJPS submissions appears once 10 manuscripts have been screened (${c.n || 0} so far).`, italics: true },
    ...(rq.paratexts?.length ? [{ h3: 'References that are not research papers' }, { table: { headers: ['#', 'Type', 'Matched record', 'How it was recognised'], rows: rq.paratexts.map(p => [String(p.index), p.label, p.title, p.basis]) } }] : [])
  ];
}

function referenceReportBlocks(result) {
  const s = result.references.summary;
  return [
    { h1: 'Reference Check Report' },
    { kv: [['Manuscript', result.meta?.title || '—'], ['References', String(s.total)], ['Verified', String(s.verified)], ['Miscited', String(s.miscited)], ['Unverified', String(s.unverified)], ['Suspicious', String(s.suspicious)], ['Retracted', String(s.retracted)]] },
    ...referenceQualityBlocks(result.indicators?.referenceQuality),
    { h2: 'Every reference' },
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

const PM_GROUPS = { text: 'Text signals', references: 'Reference signals', authors: 'Author & submission signals', data: 'Data signals' };
const PM_SEV = { high: 'Strong', medium: 'Moderate', low: 'Weak' };
const pmEvidence = e => `${e.text || ''}${e.quote ? ` — “${e.quote}”` : ''}${e.note ? ` (${e.note})` : ''}${e.link ? ` — ${e.link}` : ''}`;

/** What Module 4 checked, as [check, result] rows (the same list as on screen) */
function papermillCoverage(r) {
  // traffic-light overview (STM Integrity Hub style) for reports made since it was added
  if (r.signals && r.checked) return require('./papermill/overview').overview(r).map(o => [{ red: 'RED', amber: 'AMBER', green: 'GREEN', grey: 'NOT CHECKED' }[o.light], o.check, o.result]);
  const c = r.checked || {}, d = r.details || {};
  const no = why => `Not checked${why ? ` — ${why}` : ''}`;
  const millRefs = (d.millJournals || []).reduce((n, j) => n + (j.refs || []).length, 0);
  return [
    ['Manuscript text (tortured phrases, AI-text leftovers, template wording, methods, hidden text)', c.text ? 'Checked' : no()],
    ['References against the scholarly databases and Retraction Watch', c.references ? `${d.references?.total || 0} checked: ${d.references?.fabricated || 0} not found, ${d.references?.retracted || 0} retracted` : no('no reference list found')],
    ['Cited journals with 20 or more paper-mill retractions (Retraction Watch)', c.references ? `${millRefs} reference(s)` : no('no reference list found')],
    ['Authors against Retraction Watch (by name)', c.authors ? 'Checked' : no('no author names found')],
    ['ORCID iDs and their publications against Retraction Watch', c.orcid ? `${(d.orcids || []).length} iD(s); ${(d.orcidRetractions || []).length} retracted publication(s)` : no('no ORCID iD in the manuscript')],
    ['E-mail addresses (free-mail, disposable, institution)', (d.emails || []).length ? `${d.emails.length} address(es)` : no('no e-mail address found')],
    ['Suggested reviewers', c.reviewers ? 'Checked' : no('none given')],
    ['Statistics recalculated (p-values, percentages)', c.statistics ? `${c.statistics} value(s), ${(d.statistics?.findings || []).length} inconsistent` : no('no test statistics found')],
    ['Primer sequences (NCBI BLAST)', c.primers ? `${c.primers} found${c.primersBlasted ? `, ${c.primersBlasted} checked in BLAST` : ', BLAST not run'}` : no('no primer sequences')],
    ['Earlier version of this manuscript (author changes)', c.previousVersion ? 'Compared' : no('no earlier version with this manuscript ID')],
    ['Earlier PJPS submissions (text overlap)', `${c.earlierSubmissions || 0} compared`],
    ['Image Integrity (Module 5)', c.images ? 'Included' : no('no Module 5 report attached')]
  ];
}

/**
 * Module 4 report: case details, risk box, main reasons, signals at a glance, every signal with its numbered evidence,
 * what was checked, suggested handling, how the level is set, and the editor's sign-off. section: number when part of
 * the Full Screening Report.
 */
function papermillBlocks(r, { section = null } = {}) {
  const signals = r.signals || [];
  const count = (list, sev) => list.filter(x => x.severity === sev).length;
  const sub = (no, t) => (section ? { h3: `${section}.${no} ${t}` } : { h2: t });
  const authors = (r.meta?.authors || []).map(a => a.name).filter(Boolean);
  const level = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'ok' }[r.risk.level] || 'na';
  const blocks = [
    section ? { h2: `${section}. Paper mill screening (confidential)` } : { h1: 'CONFIDENTIAL — Paper Mill Screening Report (Module 4)' },
    { p: 'Confidential — for the editor only. Not to be shared with authors or reviewers.', bold: true, color: '9B1C1C' },
    { kv: [
      ['Manuscript ID', r.meta?.manuscriptCode || '—'],
      ['Title', r.meta?.title || '—'],
      ...(authors.length ? [['Authors', authors.join(', ')]] : []),
      ['Screened on', r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '—'],
      ...(r.id ? [['Report no.', String(r.id)]] : [])
    ] },
    { callout: { level, title: `Paper mill risk: ${r.risk.level}`, text: `Score ${r.risk.score} (MEDIUM from 4, HIGH from 8 or with two strong signals) · ${count(signals, 'high')} strong, ${count(signals, 'medium')} moderate and ${count(signals, 'low')} weak signal(s). ${r.disclaimer || ''}`.trim() } }
  ];
  // the editor's assessment (reports saved before it existed get it made now)
  const A = r.assessment || require('./papermill/assessment').assess(r);
  const letter = r.assessment ? r.assessment.letter : require('./papermill/assessment').queryLetter(r, A);
  blocks.push(sub(1, 'Assessment and recommended action'), { p: A.statement },
    { callout: { level: { bad: 'bad', warn: 'warn', good: 'ok' }[A.action.tone] || 'na', title: `Recommended action: ${A.action.title}`, text: A.action.text } },
    { kv: [['Independent areas with moderate or strong signals', `${A.convergence.flagged} of ${A.convergence.of}`], ['Screening completeness', `${A.completeness.run} of ${A.completeness.total} checks run (${A.completeness.level})`]] });
  const main = signals.filter(x => x.severity !== 'low').sort((a, b) => b.weight - a.weight).slice(0, 6);
  blocks.push(sub(2, 'Main reasons'), { bullets: main.length ? main.map(x => `${PM_SEV[x.severity]}: ${x.title}`) : ['No strong or moderate signal was found. Weak signals, if any, are listed below.'] });
  blocks.push(sub(3, 'Evidence by area'), { table: { headers: ['Area', 'Signals', 'Strong', 'Moderate', 'Weak', 'Weight'], rows: [
    ...Object.entries(PM_GROUPS).map(([g, label]) => { const l = signals.filter(x => x.group === g); return [label, String(l.length), String(count(l, 'high')), String(count(l, 'medium')), String(count(l, 'low')), String(l.reduce((a, x) => a + x.weight, 0))]; }),
    ['Total', String(signals.length), String(count(signals, 'high')), String(count(signals, 'medium')), String(count(signals, 'low')), String(r.risk.score)]
  ] } });
  let n = 0;
  blocks.push(sub(4, 'Signals and evidence'));
  for (const [g, label] of Object.entries(PM_GROUPS)) {
    const list = signals.filter(x => x.group === g);
    blocks.push({ p: `${label} (${list.length})`, bold: true, color: '0F4C5C' });
    if (!list.length) { blocks.push({ p: 'No signal found.', italics: true }); continue; }
    for (const x of list) {
      n++;
      blocks.push({ p: `Signal ${n}. ${x.title}`, bold: true, color: x.severity === 'high' ? '9B1C1C' : x.severity === 'medium' ? '8A5300' : '1F2A37' });
      blocks.push({ kv: [['Strength', `${PM_SEV[x.severity]} (weight ${x.weight})`], ...(x.note ? [['What it means', x.note]] : [])] });
      const ev = x.evidence || [];
      if (ev.length) {
        blocks.push({ table: { headers: ['#', 'Evidence'], rows: ev.slice(0, 15).map((e, i) => [String(i + 1), pmEvidence(e)]) } });
        if (ev.length > 15) blocks.push({ p: `… and ${ev.length - 15} more item(s), listed in the on-screen report.`, italics: true });
      }
    }
  }
  if (A.verify.length) blocks.push(sub(5, 'What to verify'), { table: { headers: ['Strength', 'Check'], rows: A.verify.map(v => [PM_SEV[v.severity], v.text]) } });
  if (letter) blocks.push({ p: 'Draft query letter to the authors (neutral wording: it does not mention paper mills or this report)', bold: true, color: '0F4C5C' }, ...letter.split('\n').map(l => ({ p: l })));
  const cov = papermillCoverage(r);
  blocks.push(sub(6, 'What was checked'), cov[0]?.length === 3
    ? { table: { headers: ['Status', 'Check', 'Result'], rows: cov } }
    : { table: { headers: ['Check', 'Result'], rows: cov } });
  if (cov[0]?.length === 3) blocks.push({ p: 'RED: a strong signal. AMBER: a moderate or weak signal. GREEN: checked, nothing found. NOT CHECKED: the information was not in the manuscript.', italics: true });
  blocks.push(sub(7, 'How the risk level is set'), { bullets: [
    'Every signal has a weight. The weights were set on a benchmark of 150 papers retracted for paper-mill reasons and 126 ordinary papers from the same journals and years.',
    'The risk is LOW below a total of 4, MEDIUM from 4 (or with one strong signal) and HIGH from 8 (or with two strong signals).',
    'Text signals alone find only a small share of known mill papers; reference, author and data signals add most of the evidence. No single signal proves that a paper came from a paper mill.',
    'The report never rejects a paper by itself: the editor reviews the evidence and decides.'
  ] });
  const d = r.decision;
  blocks.push(sub(8, 'Editor review'), { table: { headers: ['Decision', 'Notes', 'Reviewed by', 'Date'], rows: [[d?.label || '', d?.notes || '', d?.by || '', d?.at ? d.at.slice(0, 10) : '']] } });
  return blocks;
}

// a JPEG / PNG data URL with its pixel size read from the file header: { src, width, height } or null
function imgSize(src) {
  const m = String(src || '').match(/^data:image\/(png|jpe?g);base64,(.+)$/);
  if (!m) return null;
  const b = Buffer.from(m[2], 'base64');
  if (m[1] === 'png') return b.length > 24 ? { src, width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xFF) { i++; continue; }
    const mk = b[i + 1];
    if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) return { src, width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

const IMG_KIND = { duplicate: 'Duplicated image', partial: 'Overlapping / re-used region', clone: 'Cloned area inside one panel', alteration: 'Possible alteration / manipulation', ai: 'Possible AI-generated image', chart: 'Graph / chart data duplicated' };
const IMG_CAT = { duplication: 'Duplication & reuse', manipulation: 'Alteration & manipulation', ai: 'AI-generated image', chart: 'Graph & chart duplication' };
const imgTransform = t => {
  if (!t) return '—';
  const deg = ((Math.round((t.rotation || 0) * 180 / Math.PI) % 360) + 360) % 360;
  const parts = [];
  if (t.flip) parts.push('mirrored');
  if (deg > 3 && deg < 357) parts.push(`rotated ${deg > 180 ? deg - 360 : deg}°`);
  if (t.scale && Math.abs(t.scale - 1) > 0.08) parts.push(`resized ×${t.scale.toFixed(2)}`);
  return parts.length ? parts.join(', ') : 'none (same orientation and size)';
};
// the measured agreement behind a finding, in words an editor can quote
const imgEvidence = f => {
  const v = f.verification || {};
  const out = [];
  if (v.picture !== undefined) out.push(`picture ${v.picture}`);
  if (v.noise !== undefined) out.push(`noise pattern ${v.noise}`);
  if (v.region !== undefined) out.push(`matched regions ${v.region}`);
  if (!out.length && f.score !== undefined && f.score !== null) out.push(f.kind === 'partial' || (f.kind === 'clone' && f.score > 1) ? `${f.score} matching points / blocks` : `correlation ${f.score}`);
  return out.join(', ') || '—';
};

/**
 * Module 5 report in the layout of the commercial image-integrity reports: case summary, findings overview table, each
 * finding with the two image regions side by side and the measured agreement, matches with the reference databases
 * (this manuscript's panel next to the published / retracted figure), then method and limits. Thumbnails of the
 * reference figures must be loaded beforehand (images.withExportThumbs). section: number when part of the Full Screening Report.
 */
function imagesBlocks(r, { section = null } = {}) {
  const s = r.summary;
  const marks = new Map((r.findingMarks || []).map(m => [m.id, m.mark]));
  const label = { confirmed: 'Confirmed by editor', false: 'False alarm', ask: 'Ask the authors' };
  // the editor's report selection (Proofig) and the confidence threshold (ImageTwin: Low < 33 % hidden by default)
  const excluded = new Set(r.reportExclude || []);
  const threshold = Number.isFinite(r.confidenceThreshold) ? r.confidenceThreshold : 33;
  const keep = x => !excluded.has(x.id) && (x.confidence === undefined || x.confidence >= threshold);
  const findings = (r.findings || []).filter(keep);
  const refs = (r.references || []).filter(m => m.confidence === undefined || m.confidence >= threshold);
  const omitted = { selection: (r.findings || []).filter(f => excluded.has(f.id)).length, low: (r.findings || []).filter(f => !excluded.has(f.id) && f.confidence !== undefined && f.confidence < threshold).length + (r.references || []).length - refs.length };
  const conf = x => (x.confidence !== undefined ? `${x.confidence}% (${x.bandLabel})` : '—');
  const panelThumb = new Map((r.panels || []).map(p => [p.id, p]));
  // the sharpest saved picture of a panel: the 340 px view kept for matched panels, else the 150 px thumbnail
  const view = id => {
    const v = r.panelViews?.[id], p = panelThumb.get(id);
    if (v?.src) return { src: v.src, width: v.w, height: v.h };
    return p?.thumb ? { src: p.thumb, width: p.w, height: p.h } : null;
  };
  const loc = f => (f.a.panel !== f.b.panel ? `${f.a.label} vs ${f.b.label}` : f.a.label);
  const sev = l => (l === 'high' ? 'Strong' : 'To check');
  const h = t => (section ? { h2: `${section}. ${t}` } : { h2: t });
  const blocks = [
    section ? { h2: `${section}. Image integrity (confidential)` } : { h1: 'CONFIDENTIAL — Module 5 Image Integrity Report' },
    { kv: [['Manuscript', `${r.meta?.manuscriptCode ? r.meta.manuscriptCode + ' — ' : ''}${r.meta?.title || r.meta?.filename || '—'}`], ['File analysed', r.meta?.filename || '—'], ['Date and time of the scan', r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—'], ['Overall risk assessment', s.level], ...(r.analysisVersion ? [['Analysis version', r.analysisVersion]] : [])] },
    { callout: { level: { HIGH: 'bad', MEDIUM: 'warn', LOW: 'ok' }[s.level] || 'na', title: `Image risk: ${s.level}`, text: s.findings ? `${s.byLevel.high || 0} strong finding(s), ${s.byLevel.medium || 0} to check, in ${s.panels} panels from ${s.images} figure(s).` : `No duplicated, re-used or altered content was found in ${s.panels} panels from ${s.images} figure(s).` } },
    ...(s.byConfidence ? [{ p: `Confidence of the findings and matches: ${s.byConfidence.high} High (66–100 %), ${s.byConfidence.fair} Fair (33–65 %), ${s.byConfidence.low} Low (0–32 %). This report shows those of ${threshold} % and above${omitted.low ? ` (${omitted.low} below it left out)` : ''}${omitted.selection ? `; ${omitted.selection} finding(s) left out by the editor` : ''}.` }] : []),
    { table: { headers: ['Check', 'Result'], rows: [
      ['(a) Duplication & reuse inside the manuscript', String(findings.filter(f => (f.category || 'duplication') === 'duplication').length)],
      ['(b) Alteration & manipulation', String(findings.filter(f => f.category === 'manipulation').length)],
      ['(c) AI-generated image indicators', String(findings.filter(f => f.category === 'ai').length)],
      ['(d) Graph & chart data duplication', String(findings.filter(f => f.category === 'chart').length) + ((r.earlierCharts || []).length ? ` (+${r.earlierCharts.length} matching earlier manuscripts)` : '')],
      ['Earlier PJPS manuscripts (this system)', `${(r.earlier || []).length} matching figure(s)`],
      ['Reference databases (published PJPS papers, retracted papers, PubMed Central, publishers, research datasets)', r.references ? `${refs.length + (r.referenceCharts || []).length} match(es) among ${(r.referencesSearched?.refs || 0).toLocaleString('en')} reference panels` : 'not searched'],
      ['Commercial databases of all published figures (ImageTwin, Proofig)', r.vendor?.connected ? 'searched by the vendor' : 'not searched (figures do not leave the PJPS system)']
    ] } }
  ];
  // the main points in plain words, strongest first
  const key = [
    ...findings.filter(f => f.level === 'high').map(f => `${IMG_KIND[f.kind] || f.kind}: ${loc(f)} (strong)`),
    ...refs.filter(m => m.level === 'high').map(m => `${m.panelLabel} matches ${m.figure} of a paper in “${m.sourceName}”${m.source === 'retracted' ? ' — a paper retracted or corrected for image problems' : ''} (strong)`),
    ...(r.earlier || []).filter(e => e.distance <= 3).map(e => `${e.panelLabel} matches a figure of earlier PJPS manuscript ${e.manuscriptCode || 'check #' + e.checkId}`),
    ...(r.authorFigures?.matches || []).filter(m => m.distance <= 3).map(m => `${m.panelLabel || 'A panel'} matches ${m.figure} of the authors' earlier paper${m.year ? ` (${m.year})` : ''}`)
  ];
  const toCheck = findings.filter(f => f.level !== 'high').length + refs.filter(m => m.level !== 'high').length;
  blocks.push({ h3: 'Key findings' }, { bullets: key.length ? [...key.slice(0, 8), ...(key.length > 8 ? [`… and ${key.length - 8} more (see below)`] : []), ...(toCheck ? [`${toCheck} further finding(s) to check by eye`] : [])] : [toCheck ? `No strong finding; ${toCheck} finding(s) to check by eye (see below).` : 'No duplicated, re-used, altered or AI-generated content was found in the figures that could be read.'] });
  // what the figures were compared with: every reference database with its size when the analysis ran
  const searchedDbs = Object.values(r.referencesSearched?.bySource || {}).filter(x => x.papers || x.panels);
  if (searchedDbs.length) {
    blocks.push(h('Databases searched'), { table: { headers: ['Database', 'Papers', 'Panels', 'Last updated'], rows: [
      ...searchedDbs.map(x => [x.name, Number(x.papers).toLocaleString('en'), Number(x.panels).toLocaleString('en'), x.updated ? new Date(x.updated).toISOString().slice(0, 10) : '—']),
      ['Earlier PJPS manuscripts screened in this system', '—', '—', '—']
    ] } }, { p: `Matches are reported only against these ${(r.referencesSearched.refs || 0).toLocaleString('en')} reference panels and earlier PJPS manuscripts. A figure re-used from a paper outside them (for example a paywalled article) cannot be detected here.`, italics: true });
  }
  // external publication matches on their own page (as page 2 of the ImageTwin PDF report)
  const external = [...refs.map(m => [m.panelLabel, `${m.title || '—'}${m.journal ? `, ${m.journal}` : ''}${m.year ? ` (${m.year})` : ''}`, m.doi ? `https://doi.org/${m.doi}` : m.url || '—', m.sourceName, conf(m)]),
    ...(r.authorFigures?.matches || []).filter(m => m.confidence === undefined || m.confidence >= threshold).map(m => [m.panelLabel || '', `${m.article || m.pmcid}${m.journal ? `, ${m.journal}` : ''}${m.year ? ` (${m.year})` : ''}`, m.url || '—', 'Authors\' earlier papers', conf(m)])];
  if (external.length && !section) blocks.push({ pageBreak: true }, { h2: 'External publication matches' }, { p: `${external.length} panel(s) of this manuscript match figures published elsewhere. Each match is shown with both pictures further below.` }, { table: { headers: ['This manuscript', 'Publication', 'Link', 'Database', 'Confidence'], rows: external } });
  if (r.guidance?.available) blocks.push({ p: `Suggested handling — ${r.guidance.decision.action}. ${r.guidance.decision.desk}`, bold: true });
  if (r.disclaimer) blocks.push({ p: r.disclaimer, italics: true });

  if (findings.length) {
    blocks.push(h('Findings overview'), { table: { headers: ['#', 'Finding', 'Location', 'Transformation', 'Measured agreement', 'Severity', 'Confidence', 'Editor'], rows: findings.map((f, i) => [String(i + 1), `${IMG_KIND[f.kind] || f.kind} (${IMG_CAT[f.category || 'duplication']})`, loc(f), f.kind === 'duplicate' || f.kind === 'partial' || f.kind === 'clone' ? imgTransform(f.transform) : '—', imgEvidence(f), sev(f.level), conf(f), label[marks.get(f.id)] || '—']) } });
    blocks.push(h('Findings in detail'));
    findings.forEach((f, i) => {
      blocks.push({ p: `Finding ${i + 1}: ${IMG_KIND[f.kind] || f.kind} — ${loc(f)}`, bold: true, color: f.level === 'high' ? '9B1C1C' : '8A5300' });
      blocks.push({ kv: [['Severity', `${sev(f.level)}${marks.get(f.id) ? ` · ${label[marks.get(f.id)]}` : ''}`], ['Confidence', conf(f)], ['What was found', f.description],
        ...(f.attribution ? [['AI assessment', f.attribution.generators.length ? `most probable generator: ${f.attribution.generators.map(g => `${g.name} (${g.share} %)`).join(', ')} — ${f.attribution.basis}` : f.attribution.basis]] : []), ...(f.kind === 'duplicate' || f.kind === 'partial' || f.kind === 'clone' ? [['Transformation', imgTransform(f.transform)]] : []), ['Measured agreement', imgEvidence(f)]] });
      if ((f.details || []).length) blocks.push({ bullets: f.details });
      if (f.assessment) blocks.push({ p: `Type: ${f.assessment.name} (usual risk ${f.assessment.risk}, false-alarm risk ${f.assessment.falsePositiveRisk}). Often harmless when: ${f.assessment.falseAlarms.join('; ') || '—'}.`, italics: true });
      const two = f.a.panel !== f.b.panel;
      const pics = [
        f.thumbA && { src: f.thumbA, width: f.thumbAW, height: f.thumbAH, label: f.kind === 'clone' ? `Whole panel ${f.a.label}: red = original area, blue = cloned copy` : two ? `A: ${f.a.label}` : f.a.label },
        two && f.thumbB && { src: f.thumbB, width: f.thumbBW, height: f.thumbBH, label: `B: ${f.b.label}${f.kind === 'duplicate' ? ' (copy)' : ''}` }
      ].filter(Boolean);
      if (pics.length) blocks.push({ images: pics, caption: f.kind === 'partial' ? 'The matching part is outlined in both panels.' : f.kind === 'clone' ? 'The original area and its copy are outlined.' : f.kind === 'alteration' ? 'The flagged area is outlined.' : '' });
      // cloned area / overlap: both areas enlarged, original first
      // manipulation: the enhanced view and the suspicious area close up (ImageTwin shows original, enhanced, close-up)
      const views3 = [f.enhA && { src: f.enhA, width: f.enhAW, height: f.enhAH, label: 'Enhanced view (contrast and background)', maxWidth: 230 }, f.zoomA && !f.zoomB && { src: f.zoomA, width: f.zoomAW, height: f.zoomAH, label: 'Suspicious area, close up', tone: 'bad', maxWidth: 230, upscale: true }].filter(Boolean);
      if (views3.length) blocks.push({ images: views3 });
      if (f.zoomA && f.zoomB) blocks.push({ images: [{ src: f.zoomA, width: f.zoomAW, height: f.zoomAH, label: f.kind === 'clone' ? 'Enlarged: original area' : `Enlarged: region in ${f.a.label}`, maxWidth: 230, upscale: true }, { src: f.zoomB, width: f.zoomBW, height: f.zoomBH, label: f.kind === 'clone' ? 'Enlarged: cloned copy' : `Enlarged: same region in ${f.b.label}`, tone: 'bad', maxWidth: 230, upscale: true }], caption: f.kind === 'clone' ? `The copy may be ${imgTransform(f.transform) === 'none (same orientation and size)' ? 'an exact copy' : imgTransform(f.transform)}.` : '' });
    });
  }

  if (refs.length) {
    blocks.push(h('Matches with published and reference figures'), { table: { headers: ['#', 'This manuscript', 'Database', 'Source paper', 'Figure', 'Similarity', 'Severity', 'Confidence'], rows: refs.map((m, i) => [String(i + 1), m.panelLabel, m.sourceName, `${m.title || ''}${m.journal ? ` — ${m.journal}` : ''}${m.year ? ` (${m.year})` : ''}${m.doi ? ` doi:${m.doi}` : ''}`, m.figure, `${m.correlation !== null && m.correlation !== undefined ? `${Math.round(m.correlation * 100)}% similar (aligned pixels), ` : 'fingerprint match, '}fingerprint distance ${m.distance}/64`, sev(m.level), conf(m)]) } });
    refs.forEach((m, i) => {
      const mine = view(m.panel);
      const pics = [mine && { ...mine, label: `This manuscript: ${m.panelLabel}` }, m.refThumb && { src: m.refThumb, width: m.refThumbW, height: m.refThumbH, label: `Source figure: ${m.sourceName}, ${m.figure}`, tone: m.source === 'retracted' ? 'bad' : '' }].filter(Boolean);
      blocks.push({ p: `Match ${i + 1}: ${m.panelLabel} vs ${m.sourceName}, ${m.figure}`, bold: true, color: m.level === 'high' ? '9B1C1C' : '8A5300' });
      blocks.push({ kv: [['Source paper', `${m.title || '—'}${m.journal ? `, ${m.journal}` : ''}${m.year ? ` (${m.year})` : ''}`], ...(m.doi ? [['DOI', `https://doi.org/${m.doi}`]] : []), ['Database', m.sourceName], ['How it matches', m.description], ['Similarity', `${m.correlation !== null && m.correlation !== undefined ? `${Math.round(m.correlation * 100)}% pixel similarity of the aligned images` : 'fingerprints near-identical (no stored picture to compare)'}; fingerprint distance ${m.distance} of 64`], ...(m.note ? [['Note', m.note]] : [])] });
      if (pics.length) blocks.push({ images: pics, caption: m.refThumb ? '' : 'The source figure is not available as a picture; open the source paper to compare.' });
    });
    blocks.push({ p: 'A match with a published figure is not always misconduct: authors may re-use their own figure with permission and a citation. A match with a paper retracted for image problems needs particular care.', italics: true });
  }
  if ((r.referenceCharts || []).length) blocks.push(h('Chart data matching published / reference charts'), { table: { headers: ['This manuscript', 'Database', 'Source paper', 'Correlation'], rows: r.referenceCharts.map(c => [c.chart, c.sourceName, `${c.title || ''}${c.doi ? ` doi:${c.doi}` : ''}`, String(c.correlation)]) } });
  if ((r.earlier || []).length) {
    blocks.push(h('Figures matching earlier PJPS manuscripts'), { table: { headers: ['This manuscript', 'Earlier manuscript', 'Earlier figure', 'Similarity'], rows: r.earlier.map(e => [e.panelLabel, `${e.manuscriptCode || 'check #' + e.checkId}: ${e.title || ''}`, e.label || '', Number.isFinite(e.similarity) ? `${e.similarity}% (distance ${e.distance}/64)` : `fingerprint distance ${e.distance}/64`]) } });
    r.earlier.slice(0, 12).forEach(e => {
      const mine = view(e.panel), theirs = imgSize(e.thumb);
      if (mine && theirs) blocks.push({ images: [{ ...mine, label: `This manuscript: ${e.panelLabel}` }, { ...theirs, label: `Earlier manuscript ${e.manuscriptCode || 'check #' + e.checkId}: ${e.label || ''}` }] });
    });
  }
  if (r.authorFigures?.matches?.length) {
    blocks.push(h("Figures matching the authors' earlier papers"), { table: { headers: ['This manuscript', 'Earlier paper', 'Figure', 'Distance'], rows: r.authorFigures.matches.map(m => [m.panelLabel || '', `${m.article || m.pmcid}${m.journal ? ` — ${m.journal}` : ''}${m.year ? ` (${m.year})` : ''}`, m.figure || '', String(m.distance)]) } });
    r.authorFigures.matches.slice(0, 12).forEach(m => {
      const mine = view(m.panel);
      if (mine && m.refThumb) blocks.push({ images: [{ ...mine, label: `This manuscript: ${m.panelLabel || ''}` }, { src: m.refThumb, width: m.refThumbW, height: m.refThumbH, label: `Earlier paper: ${m.figure || ''}${m.year ? ` (${m.year})` : ''}` }] });
    });
  }
  if (r.decision) blocks.push(h('Editor decision'), { kv: [['Decision', r.decision.label || '—'], ['Notes', r.decision.notes || '—'], ['By', `${r.decision.by}, ${r.decision.at.slice(0, 10)}`]] });
  blocks.push(h('Method and limits'), { p: r.method || '', italics: true },
    { bullets: ['“Strong” means the full-resolution picture and its fine noise pattern agree (copies of one image), not only the overall look; “To check” findings need the editor\'s judgement.', 'Two views of one microscopy field in different colour channels (a merge and its single channels) are normal practice and are never reported as strong.', 'Only figures readable from the file were analysed (see “Not readable” in the on-screen report). Image findings are indicators for the editor, not proof of misconduct; ask the authors for the original images before any decision.'] });
  return blocks;
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
  const blocks = [{ h2: '6. Similarity report (originality)' }];
  if (!pl || pl.error) return [...blocks, { p: pl?.error || 'Not checked.' }];
  const s = pl.summary;
  const pt = v => (v > 0 && v < 1 ? '<1%' : `${Math.round(v)}%`);
  if (!pl.version) {
    blocks.push({ kv: [['Overall similarity', `${s.similarity}%`], ['Sources with overlap', String(s.sources)]] });
    if (pl.sources.length) blocks.push({ table: { headers: ['Similarity', 'Source'], rows: pl.sources.map(x => [`${x.similarity}%`, `${x.title || '-'}${x.journal ? ` - ${x.journal}` : ''}`]) } });
    return [...blocks, { p: 'Report made with the earlier method; run the screening again for the full similarity report.', italics: true }];
  }
  blocks.push({ kv: [['Similarity Index', pt(s.similarity)], ['Internet sources', pt(s.internet)], ['Publications', pt(s.publications)], ...(pl.repository ? [] : [['Submitted to PJPS', pt(s.submissions)]]),
    ['Words compared', s.words.toLocaleString()], ['Filters', simFilters(pl)], ...(pl.repository ? [['Repository', pl.repository]] : [])] });
  if (pl.sources.length) {
    blocks.push({ p: 'Primary sources', bold: true });
    blocks.push(simSourcesTable(pl));
    if (pl.version >= 3) blocks.push({ p: 'Largest matches next to the source wording', bold: true }, ...simMatchBlocks(pl, 3));
  } else blocks.push({ p: 'No matching text was found in the sources searched.' });
  if (pl.selfMatches?.length) blocks.push({ p: `Not counted (the manuscript's own published version or preprint): ${pl.selfMatches.map(x => `${x.title}${x.year ? ` (${x.year})` : ''}`).join('; ')}`, italics: true });
  if (pl.earlierSubmissions?.length) blocks.push({ p: `Earlier PJPS submissions with the same text: ${pl.earlierSubmissions.join('; ')}`, bold: true });
  if (pl.sources.length && pl.document?.length) {
    blocks.push({ p: 'Match overview: matched text is highlighted in the colour of its source, with the source number', bold: true });
    blocks.push({ marked: pl.document });
  }
  blocks.push({ p: `${pl.method} Coverage: ${pl.coverage}`, italics: true });
  return blocks;
}

const SIM_TYPE = { internet: 'Internet source', publication: 'Publication', submission: 'Submitted to PJPS' };
const simPt = v => (v > 0 && v < 1 ? '<1%' : `${Math.round(v)}%`);
const simFilters = pl => [`bibliography ${pl.filters.bibliography}`, `quotes ${pl.filters.quotes}`, ...(pl.filters.citations ? [`in-text citations ${pl.filters.citations}`] : []), `small matches ${pl.filters.smallMatches}`,
  ...(pl.filters.smallSources ? [pl.filters.smallSources] : []), ...(pl.filters.sources ? [pl.filters.sources] : []), ...(pl.filters.sections ? [`sections ${pl.filters.sections}`] : [])].join('; ');
/** Similarity of each section of the manuscript (only when its headings were found) */
const simSectionsTable = pl => ({ table: { headers: ['Section', 'Words', 'Matched words', 'Similarity'], rows: pl.sections.map(x => [x.label, x.words.toLocaleString(), x.excluded ? '-' : x.matched.toLocaleString(), x.excluded ? 'excluded by the editor' : simPt(x.similarity)]) } });
const simSourcesTable = pl => ({ table: { headers: ['No.', 'Match', 'Source', 'Type', 'Words'], rows: pl.sources.map(x => [String(x.no), simPt(x.percent),
  `${x.title || '-'}${x.journal ? ` - ${x.journal}` : ''}${x.year ? `, ${x.year}` : ''}${x.doi ? ` (doi:${x.doi})` : x.url && !x.checkId ? ` (${x.url})` : ''}`, SIM_TYPE[x.type] || x.type, String(x.words ?? '')]) } });

/** The largest matches of the first n primary sources, the manuscript next to the source's wording */
function simMatchBlocks(pl, n) {
  const out = [];
  for (const x of (pl.sources || []).slice(0, n)) {
    const list = (x.passages || []).filter(p => p.words >= (pl.settings?.minWords || 8)).slice(0, 4);
    if (!list.length) continue;
    out.push({ p: `[${x.no}] ${simPt(x.percent)} - ${x.title || 'Source'}${x.journal ? ` (${x.journal}${x.year ? `, ${x.year}` : ''})` : ''}`, bold: true, color: markColor(x.no) });
    out.push({ table: { headers: ['Manuscript', 'Source'], rows: list.map(p => [`${p.text} (${p.words} words)`, p.source || 'Exact passage found in this source; its full text is paywalled, so the wording is not shown.']) } });
  }
  return out;
}

/** The similarity report alone (Word / PDF from the report's own page): cover, primary sources, matches, highlighted text */
function similarityReportBlocks(r) {
  const pl = r.plagiarism;
  if (!pl || pl.error || !pl.version) return plagiarismBlocks(pl);
  const s = pl.summary, meta = r.meta || {};
  const blocks = [
    { h1: 'Similarity Report' },
    { p: 'Confidential - for the editor. This report contains the text of an unpublished manuscript.', bold: true, color: '9B1C1C' },
    { kv: [['Manuscript ID', meta.manuscriptCode || '-'], ['Title', meta.title || '-'], ['Checked on', r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '-'], ...(r.id ? [['Report no.', String(r.id)]] : []), ['Words compared', `${(s.compared ?? s.words).toLocaleString()}${s.compared !== undefined && s.compared < s.words ? ` of ${s.words.toLocaleString()} (sections excluded)` : ''}`]] },
    { callout: { level: { ok: 'ok', warn: 'warn', bad: 'bad' }[s.level] || 'na', title: `Similarity Index: ${simPt(s.similarity)}`,
      text: `Publications ${simPt(s.publications)} - Internet sources ${simPt(s.internet)} - Submitted works: not compared (no repository). ${s.sources} primary source(s), the largest ${simPt(s.largestSource)}.` } },
    { kv: [['Filters', simFilters(pl)], ['Repository', pl.repository || 'not stored']] }
  ];
  if (pl.privacy) blocks.push({ p: pl.privacy.statement, italics: true });
  if (pl.selfMatches?.length) blocks.push({ p: `Not counted (the manuscript's own published version or preprint): ${pl.selfMatches.map(x => `${x.title}${x.year ? ` (${x.year})` : ''}`).join('; ')}`, italics: true });
  if (pl.sections?.length > 1) blocks.push({ h2: 'Similarity by section' }, simSectionsTable(pl));
  blocks.push({ h2: 'Primary sources' });
  if (!pl.sources.length) blocks.push({ p: 'No matching text was found in the sources searched.' });
  else {
    blocks.push(simSourcesTable(pl));
    if (pl.version >= 3) blocks.push({ h2: 'Matches next to the source' }, ...simMatchBlocks(pl, 8));
  }
  if (pl.document?.length) blocks.push({ pageBreak: true }, { h2: 'Manuscript text' }, { p: `Matched text is highlighted in the colour of its source, with the source number.${pl.document.some(d => d.x) ? ' Text of the excluded sections is grey.' : ''}`, italics: true }, { marked: pl.document });
  const c = pl.checked || {};
  blocks.push({ h2: 'What was searched' }, { p: `${c.passages} passages searched (${c.passagesFound ?? '-'} found elsewhere); ${c.queries} literature searches${c.openalexSearches ? `, ${c.openalexSearches} in publisher full texts` : ''}${c.webSearches ? `, ${c.webSearches} on the web` : ''}; ${c.candidates} candidate sources, ${c.sourcesCompared} compared in full.` },
    { bullets: c.databases || [] }, { p: pl.method, italics: true }, { p: `Coverage: ${pl.coverage}`, italics: true });
  return blocks;
}

/** Module 7: novelty and citation outlook (OpenAlex data model) */
function noveltyBlocks(nv) {
  const blocks = [{ h2: '7. Novelty and citation outlook' }];
  if (!nv || nv.error) return [...blocks, { p: nv?.error || 'Not assessed.' }];
  const s = nv.summary, f = nv.forecast, c = nv.components;
  const w = nv.weights || { distance: 50, uncrowded: 25, rarity: c.rarity === null ? 0 : 25 };
  const parts = [['Distance from the closest published work', c.distance, w.distance], ['Uncrowded field (last five years)', 100 - c.crowding, w.uncrowded], ...(c.rarity === null ? [] : [['Rare combination of key concepts', c.rarity, w.rarity]])];
  const wsum = parts.reduce((a, p) => a + p[2], 0) || 1;
  blocks.push({ callout: { level: s.band === 'high' ? 'ok' : s.band === 'moderate' ? 'warn' : 'bad', title: `Novelty ${s.score}/100 - ${s.band}${s.confidence ? ` (confidence ${s.confidence})` : ''}`, text: nv.statement || '' } });
  blocks.push({ p: 'Score breakdown', bold: true });
  blocks.push({ table: { headers: ['Component', 'Value (0-100)', 'Weight', 'Points'], rows: [...parts.map(([l, v, wt]) => [l, v === null ? '-' : String(v), `${Math.round(wt / wsum * 100)}%`, v === null ? '-' : String(Math.round(v * wt / wsum))]), ['Novelty score (70-100 high, 45-69 moderate, 0-44 low)', '', '', String(s.score)]] } });
  blocks.push({ p: 'Closest published works', bold: true });
  blocks.push({ table: { headers: ['#', 'Work', 'Shared key terms', 'Year', 'Similarity', 'Cited by'], rows: nv.closest.slice(0, 10).map((x, i) => [String(i + 1), `${x.title}${x.journal ? ` - ${x.journal}` : ''}${x.doi ? ` (doi:${x.doi})` : ''}`, (x.shared || []).join(', ') || '-', String(x.year || ''), `${Math.round(x.similarity * 100)}%`, String(x.citedBy ?? '')]) } });
  if (nv.concepts?.pairs?.length) blocks.push({ p: 'Research landscape', bold: true }, { table: { headers: ['Key concepts studied together', 'Published works'], rows: nv.concepts.pairs.map(p => [`${p.a} + ${p.b}`, p.works === null || p.works === undefined ? '-' : Number(p.works).toLocaleString()]) } });
  if (nv.momentum) blocks.push({ p: `Research topic: ${nv.momentum.topic} - ${nv.momentum.trend}${nv.momentum.growthPerYear !== null ? ` (${nv.momentum.growthPerYear > 0 ? '+' : ''}${nv.momentum.growthPerYear}% works per year)` : ''}; works per year: ${(nv.momentum.worksByYear || []).map(y => `${y.year}: ${y.works.toLocaleString()}`).join(', ')}.` });
  blocks.push({ p: 'Citation outlook (if published in the journal)', bold: true });
  blocks.push({ table: { headers: ['After', 'Expected citations (median)', 'Likely range (25-75%)', 'Similar works used'], rows: f.horizon.map(h => [`${h.years} year${h.years > 1 ? 's' : ''}`, h.median === null || h.median === undefined ? 'insufficient data' : String(h.median), h.median === null || h.median === undefined ? '-' : `${h.low}-${h.high}`, String(h.basis)]) } });
  if (f.journalNote) blocks.push({ p: f.journalNote, italics: true });
  if (nv.guidance?.length) blocks.push({ p: 'Guidance for the editor', bold: true }, { bullets: nv.guidance });
  if (nv.selfMatches?.length) blocks.push({ p: `Not counted as prior work (the manuscript's own published version or preprint): ${nv.selfMatches.map(x => x.title).join('; ')}`, italics: true });
  blocks.push({ p: 'Method and limitations', bold: true }, { p: `${nv.method} ${f.method}`, italics: true });
  if (nv.limitations?.length) blocks.push({ bullets: nv.limitations });
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
    { kv: [['Manuscript', `${meta.manuscriptCode ? meta.manuscriptCode + ' — ' : ''}${meta.title || '—'}`], ['Version', String(meta.version || 1)], ['Date', new Date(r.createdAt).toISOString().slice(0, 10)]] },
    ...(r.noReferenceList ? [{ p: r.noReferenceList, bold: true, color: '8A5300' }] : [])
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
  blocks.push(...referenceQualityBlocks(r.indicators?.referenceQuality).map(b => (b.h2 ? { h3: b.h2 } : b.h3 ? { p: b.h3, bold: true } : b)));
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
    if (r.papermill) blocks.push(...papermillBlocks(r.papermill, { section: 4 }));
    // the complete Module 5 report (loaded by the export route as r.images.report), else its summary
    if (r.images?.report) blocks.push(...imagesBlocks(r.images.report, { section: 5 }));
    else blocks.push({ h2: '5. Image integrity' }, { p: r.images ? `Image risk ${r.images.summary.level}: ${r.images.summary.findings} finding(s) in ${r.images.summary.panels} panels${(r.images.summary.references || 0) + (r.images.summary.referenceCharts || 0) ? `, ${(r.images.summary.references || 0) + (r.images.summary.referenceCharts || 0)} figure(s) matching published PJPS / retracted-paper figures` : ''}.` : r.imagesNote || 'Not checked — upload the Word / PDF manuscript (or attach a Module 5 report) to analyse its figures.' });
    if (r.plagiarism) blocks.push(...plagiarismBlocks(r.plagiarism));
    if (r.novelty) blocks.push(...noveltyBlocks(r.novelty));
    if (r.authorIdentity) blocks.push(...authorIdentityBlocks(r.authorIdentity));
  }
  return blocks;
}

module.exports = {
  complianceBlocks, citationsBlocks, papermillBlocks, papermillCoverage, imagesBlocks, screeningBlocks, plagiarismBlocks, similarityReportBlocks, noveltyBlocks, authorIdentityBlocks,
  buildDocx, decisionSummaryBlocks, referenceQualityBlocks, letterBlocks, issueReportBlocks, reviewersBlocks, referenceReportBlocks, revisionBlocks,
  verifyBlocks, evidenceBlocks, assistantBlocks, journalFinderBlocks, conferenceBlocks, restyleBlocks, formatBlocks, authorBlocks
};
