// test/language.js - Module 6 Language Editing: the in-house rules, research-manuscript checks, scoring, the API
// (checking, documents, dictionary, Word downloads with tracked changes) and access for users whose permissions predate
// the module. No paid service is called: the AI key and the grammar server are removed for the run.
// Run: node test/language.js
process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.PORT = '0';
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;
process.env.ANTHROPIC_API_KEY = ''; // empty, not deleted: .env would fill a missing variable back in
process.env.LANGUAGETOOL_URL = '';
const assert = require('assert');

const L = require('../src/language');
const { permissionsOf } = require('../src/modules');

const has = (list, rule, text) => list.some(i => i.rule === rule && (text === undefined || i.text === text));

(async () => {
  // ---------------------------------------------------------------- rules
  const para = 'the effect of the extract were studied in order to determine it\'s activity. Their is a large number of studys and teh compound have a very important role. We recieved 10mg from a university and a HPLC system was used .However the data shows that P<.05 in the the treated group. I think it is kind of promising.';
  const { paragraphs: [p1] } = await L.checkParagraphs([para], { goals: { domain: 'academic' } });
  for (const [rule, text] of [['spelling', 'studys'], ['spelling', 'teh'], ['spelling', 'recieved'], ['its-possessive', "it's"], ['their-there', 'Their'], ['wordy', 'in order to'],
    ['wordy', 'a large number of'], ['weak-adjective', 'very important'], ['unit-space', '10mg'], ['a-an', 'a'], ['p-value', 'P<.05'], ['hedging', 'I think'], ['hedging', 'kind of'], ['sentence-capital', 't']]) {
    assert.ok(has(p1, rule, text), `rule ${rule} on "${text}"`);
  }
  assert.ok(p1.find(i => i.rule === 'spelling' && i.text === 'recieved').replacements[0] === 'received', 'spelling suggestion');
  assert.ok(!has(p1, 'a-an', 'university') && !p1.some(i => i.rule === 'a-an' && i.offset === para.indexOf('a university')), '"a university" is correct');
  // scientific vocabulary is not misspelled; a word the writer keeps using is accepted
  const sci = 'Pharmacokinetic parameters of paracetamol and nanoformulated curcumin were assessed in Wistar rats using HPLC-UV, and IL-6 and TNF-α were measured by ELISA.';
  const { paragraphs: [p2] } = await L.checkParagraphs([sci], { goals: { domain: 'academic' } });
  assert.deepStrictEqual(p2.filter(i => i.rule === 'spelling').map(i => i.text), [], 'no false spelling alarms on scientific text');
  // personal dictionary and UK spelling
  const { paragraphs: [p3] } = await L.checkParagraphs(['The colour of the zorbaxin solution changed.'], { variant: 'en-US', personal: ['zorbaxin'] });
  assert.ok(has(p3, 'variant-spelling', 'colour') && !has(p3, 'spelling', 'zorbaxin'), 'variant spelling and personal dictionary');
  const { paragraphs: [p4] } = await L.checkParagraphs(['The colour of the solution changed.'], { variant: 'en-GB' });
  assert.ok(!p4.some(i => i.spelling), 'UK spelling accepted in a UK document');
  // goals: contractions and passive voice depend on them
  const { paragraphs: [p5] } = await L.checkParagraphs(["We don't know why the samples were destroyed by the staff."], { goals: { domain: 'general', formality: 'formal' } });
  assert.ok(has(p5, 'contraction') && has(p5, 'passive'), 'formal general writing: contraction and passive');
  const { paragraphs: [p6] } = await L.checkParagraphs(['The samples were destroyed by the staff.'], { goals: { domain: 'academic' } });
  assert.ok(!has(p6, 'passive'), 'academic writing: passive accepted');

  // ---------------------------------------------------------------- research manuscript checks
  const ms = `Abstract
This study proves that the extract is effective.
Introduction
Several studies have reported the antioxidant activity of Moringa oleifera. Flavonoids are widely used in medicine (Khan et al., 2019). Reactive oxygen species (ROS) damage cells [3]. MDA rises when ROS increase and MDA falls after treatment.
Materials and Methods
The powder is dissolved in methanol. We measure the absorbance at 517 nm. Results are in Fig. 2 and Fig. 1.
Results
The data were analysed.
References
1. Khan A, Ali B. Some title. J Pharm. 2019;12:1-5. HPLC MDA XYZ.`;
  const d = L.checkDocument(ms, { goals: { domain: 'academic' } });
  for (const [rule, text] of [['methods-tense', 'is'], ['methods-tense', 'measure'], ['overclaim', 'proves'], ['abbr-undefined', 'MDA'], ['figure-order', 'Fig. 2']]) assert.ok(has(d.issues, rule, text), `document rule ${rule} on "${text}"`);
  assert.ok(has(d.issues, 'needs-citation', 'Several studies have reported the antioxidant activity of Moringa oleifera.'), 'claim without a citation');
  assert.ok(!d.issues.some(i => i.rule === 'needs-citation' && /Flavonoids/.test(i.text)), 'cited claim not flagged');
  assert.ok(!d.issues.some(i => i.offset >= d.structure.referencesAt), 'no checks inside the reference list');
  assert.deepStrictEqual(d.structure.sections.map(s => s.key), ['abstract', 'introduction', 'methods', 'results', 'references'], 'sections found');
  assert.ok(d.score.overall >= 0 && d.score.overall <= 100 && d.stats.words > 50 && d.tone.tones.length, 'score, statistics, tone');
  const clean = L.checkDocument('The extract reduced inflammation in treated rats. The effect was dose dependent.', { counts: {} });
  assert.ok(clean.score.overall >= 90, `clean text scores high (${clean.score.overall})`);

  // ---------------------------------------------------------------- permissions: users customised before Module 6 get it
  assert.ok(permissionsOf({ role: 'editor', permissions: ['references', 'papermill', '_v4'] }).includes('language'), 'editor with older custom permissions');
  assert.ok(permissionsOf({ role: 'researcher', permissions: null }).includes('language'), 'reviewer default');
  assert.ok(!permissionsOf({ role: 'editor', permissions: ['references', '_v4', '_v6'] }).includes('language'), 'removed by the Super Admin after v6');

  // ---------------------------------------------------------------- API
  const app = require('../server');
  const port = await app.start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, path, body, raw = false) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const c = r.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    if (raw) return r;
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  assert.ok((await call('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123' })).data.success, 'login');
  let r = await call('GET', '/api/language/config');
  assert.ok(r.data.success && r.data.ai === false && r.data.languagetool === false, 'config: no AI, no grammar server');
  r = await call('POST', '/api/language/check', { paragraphs: ['Their is a error here.', ''], text: 'Their is a error here.', goals: { domain: 'academic' }, counts: { correctness: 2 } });
  assert.ok(r.data.paragraphs[0].length >= 2 && r.data.document.score.overall < 100, 'check endpoint');
  r = await call('POST', '/api/language/rewrite', { text: 'Some text.', mode: 'improve' });
  assert.strictEqual(r.status, 503, 'AI off: clear refusal, no call made');
  r = await call('POST', '/api/language/docs', { title: 'Test manuscript', body: 'The powder is dissolved in methanol.' });
  const id = r.data.doc.id;
  assert.ok(id, 'document created');
  r = await call('PUT', `/api/language/docs/${id}`, { body: 'The powder was dissolved in methanol.', settings: { variant: 'en-GB', dismissed: ['x'] }, score: 88 });
  assert.ok(r.data.success, 'document saved');
  r = await call('GET', `/api/language/docs/${id}`);
  assert.ok(r.data.doc.original === 'The powder is dissolved in methanol.' && r.data.doc.settings.variant === 'en-GB' && r.data.doc.score === 88, 'document read back');
  r = await call('GET', '/api/language/docs');
  assert.strictEqual(r.data.docs.length, 1, 'document list');
  r = await call('POST', '/api/language/dictionary', { word: 'Zorbaxin' });
  assert.deepStrictEqual(r.data.words, ['zorbaxin'], 'dictionary add');
  r = await call('POST', '/api/language/check', { paragraphs: ['The zorbaxin was given.'] });
  assert.ok(!r.data.paragraphs[0].some(i => i.spelling), 'dictionary used in checks');
  const res = await call('POST', '/api/language/export', { format: 'tracked', title: 'Test', original: 'The powder is dissolved in methanol.', text: 'The powder was dissolved in methanol.' }, true);
  assert.strictEqual(res.status, 200);
  const xml = await (await require('jszip').loadAsync(Buffer.from(await res.arrayBuffer()))).file('word/document.xml').async('string');
  assert.ok(/<w:del [^>]*>.*?is<\/w:delText>/.test(xml) && /<w:ins [^>]*>.*?was<\/w:t>/.test(xml), 'tracked changes in Word');
  const rep = await call('POST', '/api/language/export', { format: 'report', title: 'Test', text: 'x', score: d.score, stats: d.stats, tone: d.tone, issues: d.issues, structure: d.structure }, true);
  assert.strictEqual(rep.status, 200, 'language report');
  r = await call('POST', '/api/language/ai-detect', { text: 'word '.repeat(200) });
  assert.ok(r.data.success && typeof r.data.result.score === 'number', 'AI-writing indicator');
  r = await call('DELETE', `/api/language/docs/${id}`);
  assert.ok(r.data.success, 'document deleted');

  console.log('language: all checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
