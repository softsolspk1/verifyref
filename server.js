// server.js - Express server for Academic Article Reference Verifier
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const {
  splitReferences,
  parseReferenceEntry,
  verifyAllReferences
} = require('./verifier');
const samples = require('./samples');

const app = express();


// Setup upload directory and Multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Optional dynamic loaders for PDF and DOCX
let pdfParse = null;
try { pdfParse = require('pdf-parse'); } catch (e) { console.warn('pdf-parse not loaded yet'); }
let mammoth = null;
try { mammoth = require('mammoth'); } catch (e) { console.warn('mammoth not loaded yet'); }

/**
 * GET /api/samples - List curated sample bibliographies
 */
app.get('/api/samples', (req, res) => {
  res.json({ success: true, samples });
});

/**
 * POST /api/parse - Quick preview of references split & parsed (fast, no network)
 */
app.post('/api/parse', (req, res) => {
  const { text, strategy = 'auto' } = req.body;
  if (!text || typeof text !== 'string') {
    return res.json({ success: true, references: [], strategy: 'empty', total: 0 });
  }

  const { entries, strategy: detectedStrategy } = splitReferences(text, strategy);
  const references = entries.map((entry, idx) => parseReferenceEntry(entry, idx + 1));
  const withDoiCount = references.filter(r => r.doi).length;

  res.json({
    success: true,
    total: references.length,
    strategy: detectedStrategy,
    withDoiCount,
    references
  });
});

/**
 * POST /api/verify - Full verification against CrossRef, Handle Registry & Retraction databases
 */
app.post('/api/verify', async (req, res) => {
  try {
    const { text, strategy = 'auto', references: incomingRefs } = req.body;
    let references = [];

    if (Array.isArray(incomingRefs) && incomingRefs.length > 0) {
      references = incomingRefs.map((r, idx) => typeof r === 'string' ? parseReferenceEntry(r, idx + 1) : r);
    } else if (text && typeof text === 'string') {
      const { entries } = splitReferences(text, strategy);
      references = entries.map((entry, idx) => parseReferenceEntry(entry, idx + 1));
    }

    if (references.length === 0) {
      return res.status(400).json({ success: false, message: 'No references provided to verify.' });
    }

    // Limit batch to 100 entries for safety
    const batch = references.slice(0, 100);

    const results = await verifyAllReferences(batch, 5);

    // Compute metrics
    const summary = {
      total: results.length,
      verified: results.filter(r => r.status === 'verified').length,
      discrepancies: results.filter(r => r.status === 'discrepancy').length,
      retracted: results.filter(r => r.status === 'retracted').length,
      unregistered: results.filter(r => r.status === 'unregistered').length,
      probableMatch: results.filter(r => r.status === 'probable-match').length,
      otherRegistry: results.filter(r => r.status === 'not-in-crossref').length,
      noMatch: results.filter(r => r.status === 'no-match').length,
      failed: results.filter(r => r.status === 'check-failed').length
    };

    res.json({
      success: true,
      summary,
      results
    });
  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({
      success: false,
      message: 'Verification failed due to an unexpected server error.',
      error: err.message
    });
  }
});

/**
 * POST /api/upload - Handle document upload (.pdf, .docx, .txt, .bib)
 */
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    const { originalname, buffer, mimetype } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let extractedText = '';

    if (ext === '.pdf' || mimetype === 'application/pdf') {
      if (!pdfParse) pdfParse = require('pdf-parse');
      const pdfData = await pdfParse(buffer);
      extractedText = pdfData.text || '';
    } else if (ext === '.docx' || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      if (!mammoth) mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value || '';
    } else {
      // Plain text, bibtex, ris
      extractedText = buffer.toString('utf-8');
    }

    // Try to isolate the reference/bibliography section if article is a full paper
    let referencesText = extractedText;
    const refHeadingRegex = /(?:\n|^)\s*(?:References|Bibliography|Literature Cited|Works Cited)\s*(?:\n|$)/i;
    const headingMatch = extractedText.search(refHeadingRegex);

    if (headingMatch !== -1) {
      referencesText = extractedText.slice(headingMatch).replace(refHeadingRegex, '').trim();
    }

    const { entries, strategy } = splitReferences(referencesText, 'auto');

    res.json({
      success: true,
      filename: originalname,
      extractedReferenceCount: entries.length,
      strategy,
      text: referencesText,
      fullTextFound: headingMatch !== -1
    });
  } catch (err) {
    console.error('Upload processing error:', err);
    res.status(500).json({ success: false, message: 'Failed to process document.', error: err.message });
  }
});

/**
 * POST /api/export - Generate downloadable report or cleaned bibliography
 */
app.post('/api/export', (req, res) => {
  const { results = [], format = 'csv' } = req.body;

  if (format === 'csv') {
    const headers = ['Index', 'Status', 'Input Reference', 'DOI As Written', 'Registered Title', 'Registered Authors', 'Registered Year', 'Discrepancies', 'Notices'];
    const rows = results.map(r => [
      r.index,
      `"${(r.statusLabel || r.status || '').replace(/"/g, '""')}"`,
      `"${(r.raw || '').replace(/"/g, '""')}"`,
      `"${(r.doi || r.doiAsWritten || '').replace(/"/g, '""')}"`,
      `"${(r.work?.title || '').replace(/"/g, '""')}"`,
      `"${(r.work?.authors || '').replace(/"/g, '""')}"`,
      `"${(r.work?.year || '').toString().replace(/"/g, '""')}"`,
      `"${(r.discrepancies?.map(d => d.message).join('; ') || '').replace(/"/g, '""')}"`,
      `"${(r.notices?.map(n => `${n.type}: ${n.label}`).join('; ') || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="reference_audit_report.csv"');
    return res.send(csvContent);
  }

  if (format === 'cleaned') {
    const cleaned = results.map((r, i) => {
      let line = r.raw;
      if (r.suggestedDoi && !r.doi) {
        line += ` https://doi.org/${r.suggestedDoi}`;
      }
      return `${i + 1}. ${line}`;
    }).join('\n\n');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cleaned_references.txt"');
    return res.send(cleaned);
  }

  res.status(400).json({ success: false, message: 'Invalid format requested.' });
});

let PORT = parseInt(process.env.PORT || '3005', 10);

function startServer(portToTry) {
  const server = app.listen(portToTry, () => {
    console.log(`Academic Reference Verifier running at http://localhost:${portToTry}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`Port ${portToTry} is in use, trying port ${portToTry + 1}...`);
      startServer(portToTry + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(PORT);

