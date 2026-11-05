// similarityExport.js - the Similarity Report as PDF and Word, laid out as Turnitin's similarity report: a cover page
// with the document details, the Integrity Overview (overall similarity, filters, match groups, top sources by database,
// integrity flags), the numbered list of top sources, then the submitted text with every match highlighted in its
// source's colour and tagged with the source number. Every page carries "Page x of n - <part>" and the report number.
// Turnitin's name, logo and identifiers are not used: the report is the journal's own.
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle, ShadingType, Header, Footer, PageNumber, TabStopType } = require('docx');
const cfg = require('./config');
const { safe } = require('./pdf');

// the source colours of the report view (public/js/views/similarity.js)
const COLORS = ['D7263D', '1B998B', '3A50D9', 'F46036', '8E44AD', '2E86AB', 'C2185B', '8D6E63', '6B8E23', '283593', 'E0A100', '00897B', '7B1FA2', '5D4037', '455A64'];
const colorOf = no => COLORS[(Math.max(1, no) - 1) % COLORS.length];
const tint = (hex, k = 0.28) => hex.match(/../g).map(c => Math.round(255 - (255 - parseInt(c, 16)) * k).toString(16).padStart(2, '0')).join('').toUpperCase();
const INK = '1F2A37', MUTED = '5B6675', LINE = 'D5DBE1', ACCENT = 'C8102E';

const pt = v => (v > 0 && v < 1 ? '<1%' : `${Math.round(v || 0)}%`);
// a listed source always holds matched words: under 1 % is "<1%", never "0%"
const ptSource = v => (v < 1 ? '<1%' : pt(v));
const TYPE = { internet: 'Internet', publication: 'Publication', submission: 'Submitted works' };
const host = u => { try { return new URL(u).hostname; } catch (e) { return ''; } };
const dateTime = d => (d ? `${new Date(d).toISOString().replace('T', ', ').slice(0, 17)} UTC` : '-');

/** A title as plain text: entities decoded (the literature services send "&lt;i&gt;"), tags and the closing full stop removed */
const plain = t => String(t || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');

/** Turnitin names a web source by its address and a publication by its title, journal and year */
function sourceName(x) {
  if (x.type === 'internet') return host(x.url) || plain(x.journal) || plain(x.title) || 'Web page';
  if (x.type === 'submission') return plain(x.title) || 'Submitted work';
  return [plain(x.title), plain(x.journal), x.year].filter(Boolean).map(String).join(', ') || 'Publication';
}

/** Everything both formats print, from a saved check ({ plagiarism, meta, createdAt, id }) */
function model(r) {
  const pl = r.plagiarism, s = pl.summary, meta = r.meta || {}, st = pl.settings || {};
  const text = (pl.document || []).map(d => d.t).join('');
  const floor = pl.floor || 8;
  const ex = new Set(st.excludeSections || []);
  // Turnitin's "Filtered from the Report": only the filters that are on
  const filtered = [
    ...(ex.has('references') ? ['Bibliography'] : []),
    ...(pl.quoted && !st.includeQuotes ? ['Quoted Text'] : []),
    ...((st.minWords || floor) > floor || !pl.floor ? [`Small Matches (less than ${st.minWords || floor} words)`] : []),
    ...(st.minPercent || st.minSourceWords ? [`Small Sources (less than ${[st.minPercent ? `${st.minPercent}%` : '', st.minSourceWords ? `${st.minSourceWords} words` : ''].filter(Boolean).join(' or ')})`] : []),
    ...(ex.has('abstract') ? ['Abstract'] : []),
    ...(ex.has('methods') ? ['Methods and Materials'] : []),
    ...((st.excluded || []).length ? [`Excluded Sources (${st.excluded.length})`] : [])
  ];
  const authors = (meta.authors || []).map(a => (typeof a === 'string' ? a : a.name)).filter(Boolean);
  return {
    pl, s, text, filtered,
    reportId: r.id ? `${cfg.APP_NAME} report no. ${r.id}` : cfg.APP_NAME,
    author: authors.length ? authors.slice(0, 3).join(', ') + (authors.length > 3 ? ' et al.' : '') : (meta.manuscriptCode || 'Manuscript'),
    title: meta.title || meta.fileName || 'Untitled manuscript',
    details: [['Report no.', r.id ? String(r.id) : '-'], ['Manuscript ID', meta.manuscriptCode || '-'], ['Submission Date', dateTime(r.createdAt)], ['Download Date', dateTime(new Date())], ['File Name', meta.fileName || meta.filename || '-']],
    counts: [[s.words, 'Words'], [text.length, 'Characters'], [s.sources, 'Sources']],
    groups: (pl.groups || []).map(g => ({ label: g.label, count: g.matches.length, percent: g.percent, about: g.about })),
    databases: [[s.internet, 'Internet sources'], [s.publications, 'Publications'], [s.submissions, pl.submissions?.compared ? 'Submitted works (earlier PJPS submissions)' : 'Submitted works (not compared)']],
    flags: pl.flags || [],
    sources: (pl.sources || []).map(x => ({ no: x.no, type: TYPE[x.type] || 'Publication', name: sourceName(x), percent: x.percent, url: x.url || (x.doi ? `https://doi.org/${x.doi}` : '') }))
  };
}

const OVERALL_ABOUT = 'The combined total of all matches, including overlapping sources, for each database.';
const FLAGS_ABOUT = 'The text was checked for changes made to hide copied text from similarity software (replaced or hidden characters). A flag is not proof of misconduct; it marks something to look at in the file.';
const SOURCES_ABOUT = 'The sources with the highest number of matches within the submission. Overlapping sources will not be displayed.';

// ------------------------------------------------------------------ PDF

function buildSimilarityPdf(r) {
  const m = model(r);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 64, bottom: 60, left: 54, right: 54 }, info: { Title: `Similarity Report - ${safe(m.title)}`, Author: cfg.APP_VENDOR }, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const top = doc.page.margins.top;
    // the part of the report each page belongs to, for its header
    let part = 'Cover Page';
    const parts = [part];
    doc.on('pageAdded', () => parts.push(part));
    const newPage = p => { part = p; doc.addPage(); doc.y = top; };
    const ensure = h => { if (doc.y + h > bottom()) newPage(part); };
    const c = hex => `#${hex}`;
    const rule = (y, color = LINE, w = 0.6) => doc.moveTo(L, y).lineTo(L + W, y).lineWidth(w).strokeColor(c(color)).stroke();

    // ---- cover page
    doc.font('Helvetica-Bold').fontSize(24).fillColor(c(INK)).text(safe(m.author), L, top + 60, { width: W });
    doc.moveDown(0.3).font('Helvetica-Bold').fontSize(15).fillColor(c(INK)).text(safe(m.title), { width: W });
    doc.moveDown(0.6).font('Helvetica').fontSize(10.5).fillColor(c(MUTED)).text(safe(cfg.APP_NAME), { width: W }).text(safe(cfg.APP_VENDOR), { width: W });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(c(ACCENT)).text('Confidential - for the editor: this report contains the text of an unpublished manuscript.', { width: W });
    let y = Math.max(doc.y + 40, 340);
    doc.font('Helvetica-Bold').fontSize(14).fillColor(c(INK)).text('Document Details', L, y);
    y = doc.y + 12;
    const colW = W * 0.58;
    let yy = y;
    for (const [k, v] of m.details) {
      doc.font('Helvetica').fontSize(8.5).fillColor(c(MUTED)).text(safe(k), L, yy, { width: colW });
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(c(INK)).text(safe(v), L, doc.y + 1, { width: colW - 10 });
      yy = doc.y + 10;
    }
    const bx = L + colW + 10, bw = W - colW - 10, bh = m.counts.length * 30 + 16;
    doc.roundedRect(bx, y, bw, bh, 4).lineWidth(0.8).strokeColor(c(LINE)).stroke();
    m.counts.forEach(([n, label], i) => {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(c(INK)).text(`${Number(n || 0).toLocaleString('en-US')} ${label}`, bx + 14, y + 14 + i * 30, { width: bw - 28 });
      if (i < m.counts.length - 1) doc.moveTo(bx + 10, y + 36 + i * 30).lineTo(bx + bw - 10, y + 36 + i * 30).lineWidth(0.4).strokeColor(c(LINE)).stroke();
    });

    // ---- Integrity Overview
    newPage('Integrity Overview');
    const y0 = doc.y;
    doc.font('Helvetica-Bold').fontSize(34).fillColor(c(INK)).text(pt(m.s.similarity), L, y0, { lineBreak: false });
    const bigW = doc.widthOfString(pt(m.s.similarity));
    doc.font('Helvetica-Bold').fontSize(16).text('Overall Similarity', L + bigW + 10, y0 + 13, { lineBreak: false });
    doc.font('Helvetica').fontSize(9.5).fillColor(c(MUTED)).text(OVERALL_ABOUT, L, y0 + 42, { width: W });
    doc.moveDown(1).font('Helvetica-Bold').fontSize(11).fillColor(c(INK)).text('Filtered from the Report', L, doc.y);
    doc.moveDown(0.3).font('Helvetica').fontSize(9.5).fillColor(c(INK));
    if (m.filtered.length) for (const f of m.filtered) doc.text(`-  ${safe(f)}`, L + 6, doc.y + 2, { width: W - 6 });
    else doc.fillColor(c(MUTED)).text('Nothing filtered: the bibliography, quoted text and matches of every length are included.', L + 6, doc.y + 2, { width: W - 6 });
    doc.moveDown(0.8);
    rule(doc.y);
    y = doc.y + 14;
    // two columns: match groups | top sources by database
    const gw = W * 0.56, sx = L + gw + 18, sw = W - gw - 18;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(c(INK)).text('Match Groups', L, y, { width: gw });
    doc.text('Top Sources', sx, y, { width: sw });
    let gy = y + 20;
    for (const g of m.groups) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(c(INK)).text(`${g.count}   ${safe(g.label)}`, L, gy, { width: gw - 40 });
      doc.text(pt(g.percent), L + gw - 40, gy, { width: 40, align: 'right' });
      doc.font('Helvetica').fontSize(8.5).fillColor(c(MUTED)).text(safe(g.about), L + 18, doc.y + 1, { width: gw - 18 });
      gy = doc.y + 10;
    }
    let ty = y + 20;
    for (const [v, label] of m.databases) {
      doc.font('Helvetica-Bold').fontSize(13).fillColor(c(INK)).text(pt(v), sx, ty, { width: 46 });
      doc.font('Helvetica').fontSize(9.5).fillColor(c(INK)).text(safe(label), sx + 48, ty + 2, { width: sw - 48 });
      ty = Math.max(doc.y, ty + 16) + 8;
    }
    doc.y = Math.max(gy, ty) + 6;
    rule(doc.y);
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(11).fillColor(c(INK)).text('Integrity Flags', L, doc.y);
    doc.moveDown(0.3).font('Helvetica-Bold').fontSize(10).fillColor(c(m.flags.length ? ACCENT : INK)).text(`${m.flags.length} Integrity Flag${m.flags.length === 1 ? '' : 's'} for Review`, L, doc.y);
    for (const f of m.flags) doc.font('Helvetica').fontSize(9.5).fillColor(c(INK)).text(`-  ${safe(f.label)}: ${f.count}  (${safe(f.examples.slice(0, 4).map(e => e.word).join(', '))})`, L + 6, doc.y + 2, { width: W - 6 });
    doc.font('Helvetica').fontSize(8.5).fillColor(c(MUTED)).text(FLAGS_ABOUT, L, doc.y + 6, { width: W });

    // ---- Top Sources
    newPage('Integrity Overview');
    doc.font('Helvetica-Bold').fontSize(13).fillColor(c(INK)).text('Top Sources', L, doc.y);
    doc.font('Helvetica').fontSize(9).fillColor(c(MUTED)).text(SOURCES_ABOUT, L, doc.y + 2, { width: W });
    doc.moveDown(0.8);
    if (!m.sources.length) doc.font('Helvetica').fontSize(10).fillColor(c(INK)).text('No matching text was found in the sources searched.', L, doc.y);
    for (const x of m.sources) {
      const nameW = W - 26 - 92 - 44;
      doc.font('Helvetica').fontSize(9.5);
      const h = Math.max(22, doc.heightOfString(safe(x.name), { width: nameW }) + 10);
      ensure(h);
      const ry = doc.y;
      doc.rect(L, ry + 3, 18, 15).fill(c(colorOf(x.no)));
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF').text(String(x.no), L, ry + 7, { width: 18, align: 'center' });
      doc.font('Helvetica').fontSize(8.5).fillColor(c(MUTED)).text(x.type, L + 26, ry + 6, { width: 88 });
      doc.font('Helvetica').fontSize(9.5).fillColor(c(INK)).text(safe(x.name), L + 26 + 92, ry + 5, { width: nameW, link: x.url || undefined });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(c(INK)).text(ptSource(x.percent), L + W - 44, ry + 5, { width: 44, align: 'right' });
      doc.y = ry + h;
      rule(doc.y - 2, LINE, 0.4);
    }

    // ---- the submission with its matches
    newPage('Integrity Submission');
    markedText(doc, m.pl.document || [], { L, W, top, bottom, newPage: () => newPage('Integrity Submission') });

    // ---- running header and footer: "Page x of n - part" and the report number
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const label = `Page ${i + 1} of ${range.count} - ${parts[i] || 'Integrity Submission'}`;
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      for (const ly of [26, doc.page.height - 34]) {
        doc.font('Helvetica').fontSize(7.5).fillColor(c(MUTED)).text(label, L, ly, { width: W / 2, lineBreak: false });
        doc.text(safe(m.reportId), L + W / 2, ly, { width: W / 2, align: 'right', lineBreak: false });
      }
      doc.moveTo(L, 38).lineTo(L + W, 38).lineWidth(0.4).strokeColor(c(LINE)).stroke();
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}

/**
 * The text laid out word by word: matched words on their source's tint, a numbered tag in the source's colour at the
 * start of every match, paragraphs kept; greyed text for sections the editor excluded
 */
function markedText(doc, segments, { L, W, top, bottom, newPage }) {
  const size = 9.5, lineH = 14, right = L + W;
  doc.font('Helvetica').fontSize(size);
  let x = L, y = doc.y;
  const space = doc.widthOfString(' ');
  const nextLine = () => { x = L; y += lineH; if (y + lineH > bottom()) { newPage(); y = top; } };
  let prev = null; // { s, x } of the last word drawn on this line, to join highlights across the space
  for (const seg of segments) {
    const no = seg.s || 0;
    const parts = String(seg.t).match(/\n+|[^\s]+|[ \t]+/g) || [];
    let tagged = !no;
    for (const p of parts) {
      if (p[0] === '\n') { nextLine(); y += 4; prev = null; continue; } // a paragraph break, with a little space
      if (/^[ \t]+$/.test(p)) { if (x > L) x += space; continue; }
      const word = safe(p);
      doc.font('Helvetica').fontSize(size);
      const w = doc.widthOfString(word);
      let tagW = 0;
      if (!tagged) { doc.font('Helvetica-Bold').fontSize(6.5); tagW = doc.widthOfString(String(no)) + 5; doc.font('Helvetica').fontSize(size); }
      if (x > L && x + tagW + w > right) { nextLine(); prev = null; }
      if (!tagged) {
        doc.rect(x, y + 1, tagW, 9).fill(`#${colorOf(no)}`);
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#FFFFFF').text(String(no), x, y + 2.6, { width: tagW, align: 'center', lineBreak: false });
        x += tagW + 1.5;
        tagged = true;
      }
      if (no) {
        const from = prev && prev.s === no ? prev.x : x;
        doc.rect(from, y - 1, x + w - from, lineH - 1).fill(`#${tint(colorOf(no))}`);
      }
      doc.font('Helvetica').fontSize(size).fillColor(seg.x ? '#9AA0A6' : `#${INK}`).text(word, x, y + 1, { lineBreak: false });
      x += w;
      prev = { s: no, x };
    }
  }
  doc.y = y + lineH;
}

// ------------------------------------------------------------------ Word

async function buildSimilarityDocx(r) {
  const m = model(r);
  const font = 'Calibri';
  const run = (text, o = {}) => new TextRun({ text: String(text ?? ''), font, size: o.size || 20, bold: o.bold, color: o.color || INK, ...(o.extra || {}) });
  const p = (children, o = {}) => new Paragraph({ children: Array.isArray(children) ? children : [run(children, o)], spacing: { before: o.before || 0, after: o.after ?? 80 }, alignment: o.align, indent: o.indent ? { left: o.indent } : undefined });
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noBorders = { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none };
  const line = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  const cellOf = (children, o = {}) => new TableCell({ children, width: o.width ? { size: o.width, type: WidthType.PERCENTAGE } : undefined, shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 }, borders: o.borders || { top: none, bottom: o.lineBelow ? line : none, left: none, right: none }, verticalAlign: o.vAlign });
  const headerFooter = label => {
    const kids = () => [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: 9600 }], children: [
      run('Page ', { size: 15, color: MUTED }), run('', { size: 15, color: MUTED, extra: { children: [PageNumber.CURRENT] } }), run(' of ', { size: 15, color: MUTED }),
      run('', { size: 15, color: MUTED, extra: { children: [PageNumber.TOTAL_PAGES] } }), run(` - ${label}`, { size: 15, color: MUTED }), run(`\t${m.reportId}`, { size: 15, color: MUTED })] })];
    return { headers: { default: new Header({ children: kids() }) }, footers: { default: new Footer({ children: kids() }) } };
  };
  const page = { margin: { top: 1000, bottom: 900, left: 1000, right: 1000 } };

  // cover page
  const cover = [
    p(m.author, { size: 48, bold: true, before: 1200, after: 120 }),
    p(m.title, { size: 30, bold: true, after: 200 }),
    p(cfg.APP_NAME, { size: 21, color: MUTED, after: 20 }), p(cfg.APP_VENDOR, { size: 21, color: MUTED, after: 80 }),
    p('Confidential - for the editor: this report contains the text of an unpublished manuscript.', { size: 18, bold: true, color: ACCENT, after: 600 }),
    p('Document Details', { size: 28, bold: true, after: 160 }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders, rows: [new TableRow({ children: [
      cellOf(m.details.flatMap(([k, v]) => [p(k, { size: 17, color: MUTED, after: 0 }), p(v, { size: 21, bold: true, after: 140 })]), { width: 58 }),
      cellOf(m.counts.map(([n, label], i) => p(`${Number(n || 0).toLocaleString('en-US')} ${label}`, { size: 24, bold: true, before: 120, after: 120 })),
        { width: 42, borders: { top: line, bottom: line, left: line, right: line } })] })] })
  ];

  // Integrity Overview
  const groupRows = m.groups.map(g => new TableRow({ children: [cellOf([p([run(`${g.count}   `, { bold: true }), run(g.label, { bold: true })], { after: 20 }), p(g.about, { size: 17, color: MUTED, after: 40, indent: 280 })], { width: 85 }),
    cellOf([p(pt(g.percent), { bold: true, align: AlignmentType.RIGHT })], { width: 15 })] }));
  const dbRows = m.databases.map(([v, label]) => new TableRow({ children: [cellOf([p(pt(v), { size: 26, bold: true })], { width: 28 }), cellOf([p(label, { size: 19 })], { width: 72, vAlign: 'center' })] }));
  const overview = [
    p([run(pt(m.s.similarity), { size: 68, bold: true }), run('  Overall Similarity', { size: 32, bold: true })], { after: 40 }),
    p(OVERALL_ABOUT, { size: 19, color: MUTED, after: 240 }),
    p('Filtered from the Report', { size: 22, bold: true, after: 80 }),
    ...(m.filtered.length ? m.filtered.map(f => p(`-  ${f}`, { indent: 160, after: 40 })) : [p('Nothing filtered: the bibliography, quoted text and matches of every length are included.', { color: MUTED, indent: 160 })]),
    p('', { after: 160 }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { ...noBorders, top: line, bottom: line }, rows: [new TableRow({ children: [
      cellOf([p('Match Groups', { size: 22, bold: true, after: 100 }), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders, rows: groupRows.length ? groupRows : [new TableRow({ children: [cellOf([p('-')])] })] })], { width: 58 }),
      cellOf([p('Top Sources', { size: 22, bold: true, after: 100 }), new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders, rows: dbRows })], { width: 42 })] })] }),
    p('Integrity Flags', { size: 22, bold: true, before: 240, after: 60 }),
    p(`${m.flags.length} Integrity Flag${m.flags.length === 1 ? '' : 's'} for Review`, { bold: true, color: m.flags.length ? ACCENT : INK, after: 60 }),
    ...m.flags.map(f => p(`-  ${f.label}: ${f.count}  (${f.examples.slice(0, 4).map(e => e.word).join(', ')})`, { indent: 160, after: 40 })),
    p(FLAGS_ABOUT, { size: 17, color: MUTED, after: 120 }),
    // Top Sources list, on a page of its own
    new Paragraph({ pageBreakBefore: true, children: [run('Top Sources', { size: 26, bold: true })], spacing: { after: 40 } }),
    p(SOURCES_ABOUT, { size: 18, color: MUTED, after: 200 }),
    ...(m.sources.length ? [new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: noBorders, rows: m.sources.map(x => new TableRow({ children: [
      cellOf([p(String(x.no), { bold: true, color: 'FFFFFF', align: AlignmentType.CENTER, after: 0 })], { width: 5, fill: colorOf(x.no), lineBelow: true, vAlign: 'center' }),
      cellOf([p(x.type, { size: 17, color: MUTED, after: 0 })], { width: 17, lineBelow: true, vAlign: 'center' }),
      cellOf([p(x.name, { size: 19, after: 0 })], { width: 66, lineBelow: true, vAlign: 'center' }),
      cellOf([p(ptSource(x.percent), { bold: true, align: AlignmentType.RIGHT, after: 0 })], { width: 12, lineBelow: true, vAlign: 'center' })] })) })] : [p('No matching text was found in the sources searched.')])
  ];

  // the submission: matches on their source's tint, a numbered tag in the source's colour at the start of each
  const paras = [[]];
  for (const seg of m.pl.document || []) {
    String(seg.t).split(/\n+/).forEach((piece, i) => {
      if (i > 0) paras.push([]);
      if (!piece) return;
      const cur = paras[paras.length - 1];
      if (seg.s && i === 0) cur.push(new TextRun({ text: ` ${seg.s} `, font, size: 13, bold: true, color: 'FFFFFF', shading: { type: ShadingType.CLEAR, color: 'auto', fill: colorOf(seg.s) } }));
      cur.push(new TextRun({ text: piece, font, size: 20, color: seg.x ? '9AA0A6' : INK, ...(seg.s ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: tint(colorOf(seg.s)) } } : {}) }));
    });
  }
  const submission = paras.filter(x => x.length).map(children => new Paragraph({ children, spacing: { after: 120, line: 288 } }));

  const doc = new Document({ title: `Similarity Report - ${m.title}`, creator: cfg.APP_VENDOR, sections: [
    { properties: { page }, ...headerFooter('Cover Page'), children: cover },
    { properties: { page }, ...headerFooter('Integrity Overview'), children: overview },
    { properties: { page }, ...headerFooter('Integrity Submission'), children: submission.length ? submission : [p('The text of the manuscript is not available in this report.')] }
  ] });
  return Packer.toBuffer(doc);
}

module.exports = { buildSimilarityPdf, buildSimilarityDocx, model };
