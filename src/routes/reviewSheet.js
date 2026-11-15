// routes/reviewSheet.js - the Preliminary Review Sheet: upload a manuscript (and, if the authors sent them, the figure
// files) and the journal's desk-review form is filled from it; the editor corrects any answer and downloads the form
// as the journal's own Word file. In-house checks only, on the web platform and the desktop alike.
const express = require('express');
const db = require('../db');
const auth = require('../auth');
const P = require('../parse');
const R = require('../review/sheet');
const { upload: uploader } = require('../uploads');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const mod = auth.requireModule('review-sheet');
const upload = uploader({ files: 31 });
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const out = r => r && { id: r.id, msNo: r.ms_no, title: r.title, filename: r.filename, outcome: r.outcome, createdAt: r.created_at, updatedAt: r.updated_at, sheet: typeof r.data === 'string' ? JSON.parse(r.data) : r.data };

router.post('/review-sheet', mod, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'figures', maxCount: 30 }]), wrap(async (req, res) => {
  const f = req.files?.file?.[0];
  if (!f) return res.status(400).json({ success: false, message: 'Choose the manuscript file (Word or PDF).' });
  const text = (await P.extractDocument(f.buffer, f.originalname, f.mimetype)).text || '';
  if (text.trim().length < 500) return res.status(400).json({ success: false, message: 'No text could be read from this file. Upload the manuscript as a Word file or a PDF with text.' });
  const figures = (req.files?.figures || []).map(x => ({ name: x.originalname, buffer: x.buffer }));
  const sheet = await R.analyse(text, { filename: f.originalname, buffer: f.buffer, figures, manuscriptNo: String(req.body?.msNo || '').trim(), pjpsTitles: await R.pjpsTitles() });
  const row = await db.one('INSERT INTO review_sheets(user_id, ms_no, title, filename, outcome, data) VALUES($1, $2, $3, $4, $5, $6) RETURNING *',
    [req.user.id, sheet.msNo, sheet.title, f.originalname, sheet.outcome, JSON.stringify(sheet)]);
  await auth.audit(req, 'review-sheet', String(row.id), { msNo: sheet.msNo, outcome: sheet.outcome }).catch(() => null);
  res.json({ success: true, ...out(row) });
}));

router.get('/review-sheets', mod, wrap(async (req, res) => {
  const rows = await db.all('SELECT id, ms_no, title, filename, outcome, created_at, updated_at FROM review_sheets WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200', [req.user.id]);
  res.json({ success: true, sheets: rows.map(r => ({ id: r.id, msNo: r.ms_no, title: r.title, filename: r.filename, outcome: r.outcome, createdAt: r.created_at, updatedAt: r.updated_at })) });
}));

const mine = (req, id) => db.one('SELECT * FROM review_sheets WHERE id = $1 AND user_id = $2', [id, req.user.id]);

router.get('/review-sheet/:id', mod, wrap(async (req, res) => {
  const r = await mine(req, req.params.id);
  if (!r) return res.status(404).json({ success: false, message: 'Review sheet not found.' });
  res.json({ success: true, ...out(r) });
}));

router.put('/review-sheet/:id', mod, wrap(async (req, res) => {
  const r = await mine(req, req.params.id);
  if (!r) return res.status(404).json({ success: false, message: 'Review sheet not found.' });
  const sheet = R.applyEdits(out(r).sheet, req.body || {});
  const row = await db.one('UPDATE review_sheets SET ms_no = $3, title = $4, outcome = $5, data = $6, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING *',
    [r.id, req.user.id, sheet.msNo, sheet.title, sheet.outcome, JSON.stringify(sheet)]);
  res.json({ success: true, ...out(row) });
}));

router.get('/review-sheet/:id/docx', mod, wrap(async (req, res) => {
  const r = await mine(req, req.params.id);
  if (!r) return res.status(404).json({ success: false, message: 'Review sheet not found.' });
  const buf = await R.toDocx(out(r).sheet);
  res.setHeader('Content-Type', DOCX);
  res.setHeader('Content-Disposition', `attachment; filename="${`Preliminary-Review-Sheet-${r.ms_no || r.id}.docx`.replace(/[^\w.-]+/g, '_')}"`);
  res.send(buf);
}));

router.delete('/review-sheet/:id', mod, wrap(async (req, res) => {
  await db.query('DELETE FROM review_sheets WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

module.exports = router;
