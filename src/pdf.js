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

const INK = '#1F2A37', MUTED = '#5B6675', HEAD = '#0F4C5C', LINE = '#C9D1D9';

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
      if (b.h1) { ensure(40); doc.moveDown(0.3).font('Helvetica-Bold').fontSize(17).fillColor(HEAD).text(safe(b.h1), left, doc.y, { width: width() }); doc.moveDown(0.4); }
      else if (b.h2) { ensure(34); doc.moveDown(0.5).font('Helvetica-Bold').fontSize(12.5).fillColor(HEAD).text(safe(b.h2), left, doc.y, { width: width() }); doc.moveDown(0.25); }
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
        for (const [k, v] of b.kv) {
          ensure(16);
          doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(`${safe(k)}: `, left, doc.y, { continued: true, width: width() });
          doc.font('Helvetica').text(safe(v));
        }
        doc.moveDown(0.4);
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
      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`${safe(cfg.APP_NAME)} - ${safe(cfg.APP_VENDOR)} - ${new Date().toISOString().slice(0, 10)} - page ${i + 1} of ${range.count}`,
        left, doc.page.height - 34, { width: width(), align: 'center', lineBreak: false });
    }
    doc.end();
  });
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
  const rowHeight = (cells, bold) => Math.max(...cells.map((c, i) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(safe(c) || ' ', { width: cw[i] - pad * 2 }))) + pad * 2;
  const drawRow = (cells, header) => {
    const h = rowHeight(cells, header);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) { doc.addPage(); drawRow(headers, true); }
    const y = doc.y;
    let x = left;
    cells.forEach((c, i) => {
      if (header) doc.rect(x, y, cw[i], h).fill(HEAD);
      else doc.rect(x, y, cw[i], h).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(header ? '#FFFFFF' : INK).text(safe(c) || ' ', x + pad, y + pad, { width: cw[i] - pad * 2 });
      x += cw[i];
    });
    doc.y = y + h;
  };
  drawRow(headers, true);
  for (const r of rows) drawRow(Array.from({ length: n }, (_, i) => r[i] ?? ''), false);
  doc.moveDown(0.8);
}

module.exports = { buildPdf };
