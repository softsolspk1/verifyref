// routes/language.js - Module 6 Language Editing: checking as the writer types (paragraphs that changed), whole-document
// checks, AI rewrites / writing / tone / reviewer feedback, source suggestions for claims without a citation, the AI-writing
// indicator, the writer's documents and personal dictionary, file import and Word downloads. On the desktop the in-house
// checks run locally and the AI features are asked of the web platform with the device token.
const express = require('express');
const cfg = require('../config');
const db = require('../db');
const auth = require('../auth');
const P = require('../parse');
const L = require('../language');
const E = require('../language/export');
const { upload: uploader } = require('../uploads');

const router = express.Router();
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const mod = auth.requireModule('language');
const upload = uploader({ files: 1 });
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_TEXT = 400000;

const VARIANTS = ['en-US', 'en-GB'];
function goalsOf(g = {}) {
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    domain: pick(g.domain, ['academic', 'business', 'general', 'email', 'casual', 'creative'], 'academic'),
    formality: pick(g.formality, ['informal', 'neutral', 'formal'], 'formal'),
    audience: pick(g.audience, ['general', 'knowledgeable', 'expert'], 'expert'),
    intent: pick(g.intent, ['inform', 'describe', 'convince', 'tell'], 'inform'),
    passive: g.passive === 'flag' ? 'flag' : 'allow',
    abstractWords: Math.min(1000, Math.max(50, parseInt(g.abstractWords, 10) || 250))
  };
}
const variantOf = v => (VARIANTS.includes(v) ? v : 'en-US');

async function personalWords(userId) {
  return (await db.all('SELECT word FROM language_dictionary WHERE user_id = $1', [userId])).map(r => r.word);
}

// ------------------------------------------------------------------ AI: local on the web platform, via the platform on the desktop

async function viaPlatform(req, op, body) {
  const desk = require('../desktop');
  const token = await desk.deviceToken(req.user.id);
  if (!token) { const e = new Error('AI writing features need this computer to be linked to the web platform: sign in online once.'); e.status = 503; throw e; }
  try {
    return (await desk.remote(`/api/sync/language/${op}`, { method: 'POST', token, body, timeout: 100000 })).result;
  } catch (e) {
    const err = new Error(e.network ? 'AI writing features need an internet connection. The grammar, spelling and style checks keep working offline.' : e.message);
    err.status = e.status || 503;
    throw err;
  }
}

/** Run an AI operation for this user: { op, ...args } -> result or null */
async function aiRun(userId, op, b) {
  const goals = goalsOf(b.goals), variant = variantOf(b.variant);
  const text = String(b.text || '').slice(0, MAX_TEXT);
  if (op === 'rewrite') return L.AI.rewrite(userId, text, { mode: b.mode, instruction: b.instruction, goals, variant });
  if (op === 'generate') return L.AI.generate(userId, String(b.prompt || ''), { documentText: text, selection: String(b.selection || '').slice(0, 20000), goals, variant });
  if (op === 'tone') return L.AI.tone(userId, text, { goals, variant });
  if (op === 'review') return L.AI.review(userId, text, { goals, variant, focus: b.focus });
  if (op === 'suggest') return Promise.all((b.paragraphs || []).slice(0, 60).map(p => L.AI.suggest(userId, String(p).slice(0, 8000), { goals, variant })));
  const e = new Error('Unknown AI operation.'); e.status = 400; throw e;
}

async function ai(req, op, body) {
  if (cfg.DESKTOP) return viaPlatform(req, op, body);
  if (!L.AI.enabled()) { const e = new Error('AI writing features are not switched on for this platform (the administrator sets ANTHROPIC_API_KEY). The grammar, spelling and style checks work without them.'); e.status = 503; throw e; }
  return aiRun(req.user.id, op, body);
}

// ------------------------------------------------------------------ configuration

router.get('/language/config', mod, wrap(async (req, res) => {
  const aiOn = cfg.DESKTOP ? !!(await require('../desktop').deviceToken(req.user.id)) : L.AI.enabled();
  res.json({
    success: true, ai: aiOn, aiVia: cfg.DESKTOP ? 'platform' : 'local', languagetool: L.LT.enabled(), modes: Object.keys(L.AI.MODES),
    usage: !cfg.DESKTOP && aiOn ? await L.AI.usageToday(req.user.id) : null, dictionary: await personalWords(req.user.id)
  });
}));

// ------------------------------------------------------------------ checking

router.post('/language/check', mod, wrap(async (req, res) => {
  const b = req.body || {};
  const paragraphs = (Array.isArray(b.paragraphs) ? b.paragraphs : []).slice(0, 2000).map(p => String(p).slice(0, 20000));
  const text = b.text !== undefined ? String(b.text).slice(0, MAX_TEXT) : null;
  const goals = goalsOf(b.goals), variant = variantOf(b.variant), disabled = Array.isArray(b.disabled) ? b.disabled.map(String) : [];
  const personal = await personalWords(req.user.id);
  const r = await L.checkParagraphs(paragraphs, { variant, goals, personal, disabled, docText: text || undefined, userId: req.user.id, ai: false });
  // AI sentence suggestions: on request only (they cost per paragraph), on the desktop through the platform
  if (b.ai && paragraphs.length) {
    try {
      const extra = await ai(req, 'suggest', { paragraphs, goals, variant });
      if (extra) r.paragraphs = r.paragraphs.map((list, k) => L.merge([list, extra[k] || []]));
      r.engines.ai = 'on';
    } catch (e) { r.engines.ai = 'unavailable'; r.engines.aiError = e.message; }
  }
  const out = { success: true, paragraphs: r.paragraphs, engines: r.engines };
  if (text !== null) out.document = L.checkDocument(text, { goals, disabled, counts: b.counts || {} });
  res.json(out);
}));

for (const op of ['rewrite', 'generate', 'tone', 'review']) {
  router.post(`/language/${op}`, mod, wrap(async (req, res) => {
    const b = req.body || {};
    if (op !== 'generate' && !String(b.text || '').trim()) return res.status(400).json({ success: false, message: 'There is no text to work on.' });
    if (op === 'generate' && !String(b.prompt || '').trim()) return res.status(400).json({ success: false, message: 'Say what you would like written.' });
    const result = await ai(req, op, b);
    if (!result) return res.status(502).json({ success: false, message: 'The AI writing service did not answer. Try again in a moment.' });
    await auth.audit(req, `language-${op}`, null, { words: String(b.text || '').split(/\s+/).length, mode: b.mode });
    res.json({ success: true, result });
  }));
}

/** AI-written content indicator (in-house, the same measures as the Paper Mill module; no text leaves the server) */
router.post('/language/ai-detect', mod, wrap(async (req, res) => {
  const text = String(req.body?.text || '').slice(0, MAX_TEXT);
  if (text.split(/\s+/).length < 150) return res.status(400).json({ success: false, message: 'The AI-writing indicator needs at least 150 words.' });
  const d = require('../integrity/aiWriting').analyzeAiWriting(text);
  res.json({ success: true, result: { score: d.details?.score ?? 0, parts: d.details?.parts || [], signals: d.signals || [], rhythm: d.details?.rhythm, vocabulary: d.details?.vocabulary, leftovers: d.details?.leftovers || [], checked: d.checked } });
}));

const STOPWORDS = new Set('the a an and or of to in on at for with by from as is are was were be been has have had this that these those it its which who their there than then also has have been reported shown studies study several many previous recent widely commonly known used it well'.split(' '));

/** Published sources for a claim that has no citation (Europe PMC and Crossref, both free) */
router.post('/language/sources', mod, wrap(async (req, res) => {
  const claim = String(req.body?.claim || '').slice(0, 600);
  const terms = [...new Set((claim.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter(w => !STOPWORDS.has(w)))].slice(0, 10);
  if (terms.length < 2) return res.status(400).json({ success: false, message: 'The sentence has too few specific words to search for.' });
  const { getJson } = require('../http');
  const S = require('../sources');
  const [epmc, cr] = await Promise.all([
    getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(terms.join(' '))}&resultType=lite&pageSize=6&format=json`).catch(() => null),
    S.crossrefSearch({ raw: terms.join(' ') }).catch(() => null)
  ]);
  const seen = new Set();
  const out = [];
  for (const r of epmc?.data?.resultList?.result || []) {
    const doi = (r.doi || '').toLowerCase();
    if (doi) seen.add(doi);
    out.push({ title: (r.title || '').replace(/\.$/, ''), authors: r.authorString || '', year: +r.pubYear || null, journal: r.journalTitle || '', doi: r.doi || '', pmid: r.pmid || '', source: 'Europe PMC' });
  }
  for (const r of cr?.records || []) {
    if (r.doi && seen.has(r.doi.toLowerCase())) continue;
    out.push({ title: r.title, authors: r.authors.slice(0, 6).map(a => `${a.family} ${(a.given || '').replace(/[^A-Z]/g, '')}`.trim()).join(', ') + (r.authors.length > 6 ? ', et al.' : ''), year: r.year, journal: r.journal, doi: r.doi, retracted: r.retracted, source: 'Crossref' });
  }
  res.json({ success: true, terms, sources: out.slice(0, 8) });
}));

// ------------------------------------------------------------------ personal dictionary

router.get('/language/dictionary', mod, wrap(async (req, res) => res.json({ success: true, words: await personalWords(req.user.id) })));
router.post('/language/dictionary', mod, wrap(async (req, res) => {
  const word = String(req.body?.word || '').trim().slice(0, 80);
  if (!word || /\s/.test(word)) return res.status(400).json({ success: false, message: 'Add one word at a time.' });
  await db.query('INSERT INTO language_dictionary(user_id, word) VALUES($1, $2) ON CONFLICT DO NOTHING', [req.user.id, word.toLowerCase()]);
  res.json({ success: true, words: await personalWords(req.user.id) });
}));
router.delete('/language/dictionary/:word', mod, wrap(async (req, res) => {
  await db.query('DELETE FROM language_dictionary WHERE user_id = $1 AND word = $2', [req.user.id, String(req.params.word).toLowerCase()]);
  res.json({ success: true, words: await personalWords(req.user.id) });
}));

// ------------------------------------------------------------------ documents

const docOut = d => d && ({ id: d.id, title: d.title, body: d.body, original: d.original, settings: typeof d.settings === 'string' ? JSON.parse(d.settings) : d.settings || {}, words: d.words, score: d.score, createdAt: d.created_at, updatedAt: d.updated_at });
const countWords = s => (String(s).match(/\S+/g) || []).length;

router.get('/language/docs', mod, wrap(async (req, res) => {
  const rows = await db.all('SELECT id, title, words, score, created_at, updated_at, left(body, 200) AS preview FROM language_docs WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200', [req.user.id]);
  res.json({ success: true, docs: rows.map(r => ({ id: r.id, title: r.title, words: r.words, score: r.score, preview: r.preview, updatedAt: r.updated_at, createdAt: r.created_at })) });
}));

router.post('/language/docs', mod, wrap(async (req, res) => {
  const b = req.body || {};
  const body = String(b.body || '').slice(0, MAX_TEXT);
  const d = await db.one('INSERT INTO language_docs(user_id, title, body, original, settings, words) VALUES($1, $2, $3, $3, $4, $5) RETURNING *',
    [req.user.id, String(b.title || 'Untitled document').slice(0, 200), body, JSON.stringify(b.settings || {}), countWords(body)]);
  res.json({ success: true, doc: docOut(d) });
}));

router.get('/language/docs/:id', mod, wrap(async (req, res) => {
  const d = await db.one('SELECT * FROM language_docs WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!d) return res.status(404).json({ success: false, message: 'Document not found.' });
  res.json({ success: true, doc: docOut(d) });
}));

router.put('/language/docs/:id', mod, wrap(async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [req.params.id, req.user.id];
  const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.title !== undefined) set('title', String(b.title).slice(0, 200) || 'Untitled document');
  if (b.body !== undefined) { set('body', String(b.body).slice(0, MAX_TEXT)); set('words', countWords(b.body)); }
  if (b.settings !== undefined) set('settings', JSON.stringify(b.settings || {}));
  if (b.score !== undefined) set('score', b.score === null ? null : Math.round(+b.score) || 0);
  if (b.resetOriginal) sets.push('original = body');
  if (!sets.length) return res.json({ success: true });
  const d = await db.one(`UPDATE language_docs SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING id, updated_at`, vals);
  if (!d) return res.status(404).json({ success: false, message: 'Document not found.' });
  res.json({ success: true, updatedAt: d.updated_at });
}));

router.delete('/language/docs/:id', mod, wrap(async (req, res) => {
  await db.query('DELETE FROM language_docs WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ success: true });
}));

/** Upload a Word, PDF, ODT, RTF or text file: its text becomes a new document */
router.post('/language/import', mod, upload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  if (!f) return res.status(400).json({ success: false, message: 'Choose a file to open.' });
  const ref = { name: f.originalname };
  {
    let text = (await P.extractDocument(f.buffer, f.originalname, f.mimetype)).text || '';
    text = String(text).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
    const title = ref.name.replace(/\.[^.]+$/, '').slice(0, 200);
    const d = await db.one('INSERT INTO language_docs(user_id, title, body, original, settings, words) VALUES($1, $2, $3, $3, $4, $5) RETURNING *', [req.user.id, title, text, JSON.stringify(req.body?.settings ? JSON.parse(req.body.settings) : {}), countWords(text)]);
    await auth.audit(req, 'language-import', ref.name, { words: countWords(text) });
    res.json({ success: true, doc: docOut(d) });
  }
}));

// ------------------------------------------------------------------ downloads

function send(res, buffer, filename, type) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`);
  res.send(buffer);
}

router.post('/language/export', mod, wrap(async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || 'Document').slice(0, 120);
  const text = String(b.text || '').slice(0, MAX_TEXT);
  if (b.format === 'txt') return send(res, Buffer.from(text, 'utf8'), `${title}.txt`, 'text/plain; charset=utf-8');
  if (b.format === 'tracked') return send(res, await E.trackedDocx(title, String(b.original || ''), text, `${req.user.name || 'Editor'} (Language Editing)`), `${title}-tracked-changes.docx`, DOCX);
  if (b.format === 'report') return send(res, await E.reportDocx({ title, score: b.score, stats: b.stats, tone: b.tone, issues: Array.isArray(b.issues) ? b.issues.slice(0, 2000) : [], structure: b.structure }), `${title}-language-report.docx`, DOCX);
  send(res, await E.cleanDocx(title, text), `${title}.docx`, DOCX);
}));

module.exports = router;
module.exports.aiRun = aiRun;
