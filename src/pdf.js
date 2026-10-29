// pdf.js - server-side PDF export. Renders the same simple blocks as docx.js ({h1|h2|p|bullets|kv|table|images})
// so every Word report is also available as a PDF without a browser print dialog.
const PDFDocument = require('pdfkit');
const cfg = require('./config');

// pdfkit loads its built-in fonts by internal '#standard-fonts/...' aliases that Vercel's file tracing does not follow,
// so on Vercel every PDF failed with "Cannot find module .../standard-fonts/Helvetica.cjs". Requiring the fonts used
// here by their public names makes the tracer bundle them; pdfkit's own require then finds the same files.
require('pdfkit/standard-fonts/Helvetica');
require('pdfkit/standard-fonts/HelveticaBold');
require('pdfkit/standard-fonts/HelveticaOblique');

const INK = '#1F2A37', MUTED = '#5B6675', HEAD = '#0F4C5C', LINE = '#C9D1D9', SOFT = '#EEF3F5';
// verdict colours of scorecards and call-outs
const LEVEL = { ok: { fill: '#E6F4EA', ink: '#1E6B34', label: 'Pass' }, warn: { fill: '#FFF4E0', ink: '#8A5300', label: 'Check' }, bad: { fill: '#FDE8E8', ink: '#9B1C1C', label: 'Action' }, na: { fill: '#F1F3F5', ink: '#5B6675', label: 'Not run' } };

// Built-in PDF fonts cover Latin text only; characters outside WinAnsi (e.g. Urdu) are replaced so the file still opens
const safe = s => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/•/g, '-')
  .replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, '?'); // eslint-disable-line no-control-regex

function buildPdf(blocks, { title = cfg.APP_NAME } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 48, bottom: 52, left: 44, right: 44 }, info: { Title: title, Author: cfg.APP_VENDOR }, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const left = doc.page.margins.left;
    const width = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = h => { if (doc.y + h > bottom()) doc.addPage(); };

    for (const b of blocks) {
      if (b.h1 && b === blocks[0]) {
        // cover banner: report title on a coloured band across the top of the first page
        const bandH = 78;
        doc.rect(0, 0, doc.page.width, bandH).fill(HEAD);
        doc.font('Helvetica').fontSize(8.5).fillColor('#BFD9DF').text(`${safe(cfg.APP_NAME).toUpperCase()}  |  ${safe(cfg.APP_VENDOR)}`, left, 18, { width: width(), lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF').text(safe(b.h1), left, 34, { width: width(), height: 40, ellipsis: true });
        doc.y = bandH + 16;
      } else if (b.h1) { ensure(40); doc.moveDown(0.3).font('Helvetica-Bold').fontSize(17).fillColor(HEAD).text(safe(b.h1), left, doc.y, { width: width() }); doc.moveDown(0.4); }
      else if (b.h2) {
        ensure(40);
        doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12.5).fillColor(HEAD).text(safe(b.h2), left, doc.y, { width: width() });
        const y = doc.y + 2;
        doc.moveTo(left, y).lineTo(left + width(), y).lineWidth(0.8).strokeColor(HEAD).stroke();
        doc.y = y + 6;
      } else if (b.callout) {
        // recommendation box: coloured bar, title and text
        const L = LEVEL[b.callout.level] || LEVEL.na;
        const text = safe(b.callout.text || '');
        const h = 22 + (text ? doc.font('Helvetica').fontSize(9.5).heightOfString(text, { width: width() - 24 }) + 6 : 0);
        ensure(h + 8);
        const y = doc.y;
        doc.rect(left, y, width(), h).fill(L.fill);
        doc.rect(left, y, 4, h).fill(L.ink);
        doc.font('Helvetica-Bold').fontSize(11).fillColor(L.ink).text(safe(b.callout.title), left + 14, y + 7, { width: width() - 24 });
        if (text) doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(text, left + 14, y + 23, { width: width() - 24 });
        doc.y = y + h + 10;
      } else if (b.scorecard) scorecard(doc, b.scorecard);
      else if (b.p !== undefined) {
        const color = b.color && /^[0-9a-f]{6}$/i.test(b.color) ? '#' + b.color : b.italics ? MUTED : INK;
        doc.font(b.bold ? 'Helvetica-Bold' : b.italics ? 'Helvetica-Oblique' : 'Helvetica').fontSize(10).fillColor(color).text(safe(b.p) || ' ', left, doc.y, { width: width() });
        doc.moveDown(0.4);
      } else if (b.bullets) {
        for (const t of b.bullets) {
          ensure(18);
          const y = doc.y;
          doc.font('Helvetica').fontSize(10).fillColor(INK).text('-', left + 4, y, { width: 10 });
          doc.text(safe(t), left + 18, y, { width: width() - 18 });
          doc.moveDown(0.15);
        }
        doc.moveDown(0.3);
      } else if (b.kv) {
        // key facts as a two-column box: label column shaded
        const kw = Math.min(150, width() * 0.32);
        for (const [k, v] of b.kv) {
          const vh = doc.font('Helvetica').fontSize(9.5).heightOfString(safe(v) || ' ', { width: width() - kw - 12 });
          const h = Math.max(16, vh + 7);
          ensure(h);
          const y = doc.y;
          doc.rect(left, y, kw, h).fill(SOFT);
          doc.rect(left, y, width(), h).lineWidth(0.4).strokeColor(LINE).stroke();
          doc.font('Helvetica-Bold').fontSize(9.5).fillColor(HEAD).text(safe(k), left + 6, y + 4, { width: kw - 10 });
          doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(safe(v) || ' ', left + kw + 6, y + 4, { width: width() - kw - 12 });
          doc.y = y + h;
        }
        doc.moveDown(0.6);
      } else if (b.table) table(doc, b.table.headers, b.table.rows);
      else if (b.images) {
        for (const im of b.images) {
          const m = String(im.src || '').match(/^data:image\/(png|jpe?g);base64,(.+)$/);
          if (!m) continue;
          const maxW = Math.min(im.maxWidth || 250, width() / 2 - 6), w = im.width || maxW, h = im.height || maxW;
          const k = Math.min(1, maxW / w, 200 / h);
          ensure(h * k + 8);
          try { doc.image(Buffer.from(m[2], 'base64'), left, doc.y, { width: w * k, height: h * k }); doc.y += h * k + 6; } catch (e) { /* unreadable image: skip */ }
        }
        if (b.caption) { doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(safe(b.caption), left, doc.y, { width: width() }); doc.moveDown(0.5); }
      }
    }
    // footer with page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // running header from page 2 on
      if (i > range.start) {
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`${safe(cfg.APP_NAME)}  |  ${safe(title === cfg.APP_NAME ? (blocks.find(x => x.h1)?.h1 || '') : title)}`, left, 22, { width: width(), lineBreak: false, ellipsis: true });
        doc.moveTo(left, 34).lineTo(left + width(), 34).lineWidth(0.4).strokeColor(LINE).stroke();
      }
      // the footer sits inside the bottom margin: without lifting the margin pdfkit starts a new (blank) page for it,
      // which doubled every report with empty pages
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`${safe(cfg.APP_NAME)} - ${safe(cfg.APP_VENDOR)} - ${new Date().toISOString().slice(0, 10)} - page ${i + 1} of ${range.count}`,
        left, doc.page.height - 34, { width: width(), align: 'center', lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}

/** Module scorecard: [{ module, result, level: ok|warn|bad|na }] with a coloured verdict column */
function scorecard(doc, rows) {
  const left = doc.page.margins.left;
  const total = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cw = [total * 0.27, total * 0.55, total * 0.18];
  const pad = 5;
  const head = (y) => {
    ['Module', 'Result', 'Verdict'].forEach((t, i) => {
      const x = left + cw.slice(0, i).reduce((a, b) => a + b, 0);
      doc.rect(x, y, cw[i], 18).fill(HEAD);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF').text(t, x + pad, y + 5, { width: cw[i] - pad * 2 });
    });
    return y + 18;
  };
  let y = head(doc.y);
  for (const r of rows) {
    const L = LEVEL[r.level] || LEVEL.na;
    const h = Math.max(22, doc.font('Helvetica').fontSize(9).heightOfString(safe(r.result) || ' ', { width: cw[1] - pad * 2 }) + pad * 2,
      doc.font('Helvetica-Bold').fontSize(9).heightOfString(safe(r.module), { width: cw[0] - pad * 2 }) + pad * 2);
    if (y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); y = head(doc.y); }
    doc.rect(left, y, total, h).lineWidth(0.4).strokeColor(LINE).stroke();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(safe(r.module), left + pad, y + pad, { width: cw[0] - pad * 2 });
    doc.font('Helvetica').fontSize(9).fillColor(INK).text(safe(r.result) || ' ', left + cw[0] + pad, y + pad, { width: cw[1] - pad * 2 });
    const vx = left + cw[0] + cw[1];
    doc.rect(vx + 4, y + 4, cw[2] - 8, h - 8).fill(L.fill);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(L.ink).text(safe(r.verdict || L.label), vx + 4, y + h / 2 - 5, { width: cw[2] - 8, align: 'center' });
    y += h;
  }
  doc.y = y + 10;
}

function table(doc, headers, rows) {
  const left = doc.page.margins.left;
  const total = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const n = headers.length;
  // narrow columns for short headers, the rest shared by the text-heavy ones
  const weight = headers.map((h, i) => {
    const longest = Math.max(String(h).length, ...rows.slice(0, 40).map(r => String(r[i] ?? '').length));
    return Math.max(4, Math.min(60, longest));
  });
  const sum = weight.reduce((a, b) => a + b, 0);
  const widths = weight.map(w => Math.max(34, (w / sum) * total));
  const scale = total / widths.reduce((a, b) => a + b, 0);
  const cw = widths.map(w => w * scale);
  const pad = 3;
  // a cell taller than a page would make pdfkit flow it over new pages: long cells are shortened
  const cellText = c => { const t = safe(c) || ' '; return t.length > 1200 ? t.slice(0, 1200) + '...' : t; };
  const rowHeight = (cells, bold) => Math.max(...cells.map((c, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(cellText(c), { width: cw[i] - pad * 2 }))) + pad * 2;
  const drawRow = (cells, header) => {
    const h = rowHeight(cells, header);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); drawRow(headers, true); }
    const y = doc.y;
    let x = left;
    cells.forEach((c, i) => {
      if (header) doc.rect(x, y, cw[i], h).fill(HEAD);
      else doc.rect(x, y, cw[i], h).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(header ? '#FFFFFF' : INK).text(cellText(c), x + pad, y + pad, { width: cw[i] - pad * 2 });
      x += cw[i];
    });
    doc.y = y + h;
  };
  drawRow(headers, true);
  for (const r of rows) drawRow(Array.from({ length: n }, (_, i) => r[i] ?? ''), false);
  doc.moveDown(0.8);
}

module.exports = { buildPdf };
