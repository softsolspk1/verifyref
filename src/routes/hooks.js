// routes/hooks.js - callbacks of outside services, without a user session: each URL carries a signature that only this
// server can make (src/externalSimilarity.js), and a callback without it is refused.
const express = require('express');
const X = require('../externalSimilarity');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// the external similarity service: /hooks/sim/<scanId>/<completed|error|creditsChecked|indexed|export-done> and
// /hooks/sim/<scanId>/result/<resultId>
router.post(['/hooks/sim/:scanId/:what', '/hooks/sim/:scanId/:what/:id'], wrap(async (req, res) => {
  const { scanId, what, id } = req.params;
  if (!X.verify(scanId, req.query.t)) return res.status(403).json({ success: false });
  await X.receive(scanId, what, id || null, req.body || {});
  res.json({ success: true });
}));

module.exports = router;
