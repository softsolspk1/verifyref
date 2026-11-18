// test/papermill-accuracy.js - Module 4 false alarms found by running it on genuine published PJPS articles (17 Nov 2026):
// ordinary English taken for tortured phrases ("activity against inflammatory factors", "super-critical fluid
// chromatography", "traditional medicine against liver ailments"), ethics approvals worded without the word "committee",
// long-running webmail services on the disposable-mail blocklist, address words and countries taken for a shared
// institution in the Retraction Watch name match, and the no-ORCID / free-mail notes counted in the risk. Real signals
// are still reported. In-memory database. Run: node test/papermill-accuracy.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.APP_MODE;
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) process.env[k] = '';
const assert = require('assert');
const http = require('../src/http');
http.getJson = async () => ({ ok: false, status: 404, data: null });
http.isOnline = () => false;
const db = require('../src/db');
const D = require('../src/datasets');
const PM = require('../src/papermill');
const { approvalNumber } = require('../src/papermill/studyEthics');

(async () => {
  await db.init();

  // ---- tortured phrases: ordinary English is not flagged, real tortured phrases still are
  const phrases = t => PM.torturedPhrases(t).map(x => x.phrase.toLowerCase());
  for (const t of ['The compound demonstrates significant inhibitory activity against inflammatory factors such as NO and IL-6.',
    'These can be a therapeutic target against oxidant induced damage in heart failure.',
    'Super-critical fluid chromatography was used to determine losartan potassium.',
    'Food matrices that delay lipid digestion in the gastrointestinal tract.',
    'Gastrodia and Uncaria can tranquilize liver and yang.',
    'Quality expression of pharmaceuticals cannot be assessed by price.',
    'The extract showed activity against bacterial strains of S. aureus.']) assert.deepStrictEqual(phrases(t), [], t);
  assert.deepStrictEqual(phrases('Rats showed high phases of oxidative pressure and were analysed by high-execution fluid chromatography.').sort(), ['high-execution fluid chromatography', 'oxidative pressure']);
  assert.deepStrictEqual(phrases('The frame temperature rose; the carbon impression of the process was estimated.').sort(), ['carbon impression', 'frame temperature']);

  // ---- screener fingerprints that are ordinary English are left out
  await db.query("INSERT INTO pps_fingerprints(kind, terms, expected) VALUES('tortured', $1, 'liver diseases'), ('tortured', $2, 'oxidative stress')", [JSON.stringify(['liver ailments']), JSON.stringify(['oxidative pressure'])]).catch(() => null);
  const fps = await D.ppsFingerprints().catch(() => []);
  if (fps.length) {
    const s = await PM.screenerMatches('A medicinal plant used in traditional medicine against liver ailments. Rats showed oxidative pressure.');
    assert.deepStrictEqual(s.tortured.map(x => x.phrase), ['oxidative pressure'], 'liver ailments is ordinary English');
  }

  // ---- ethics approvals worded without "committee"
  for (const t of ['The animal research was approved by the Council on Animal Care at Jiangsu University.',
    'After consented by Shanghai Association of Medical Ethics and informed consent obtained from patients, 30 patients were enrolled.',
    'The study was conducted in a cancer hospital of Karachi, following institutional approval, on selected patients.']) assert.ok(approvalNumber(t).approval, t);
  assert.strictEqual(approvalNumber('Rats were housed in standard cages and fed a pellet diet.').approval, null);

  // ---- e-mail domains: an old public webmail on the disposable blocklist is free-mail, a real throw-away stays disposable
  await db.query("INSERT INTO email_domains(domain, kind) VALUES('gawab.com', 'disposable'), ('mailinator.com', 'disposable'), ('gmail.com', 'freemail')");
  await D.warmEmailDomains();
  assert.strictEqual(D.emailDomainKind('arayne@gawab.com'), 'freemail');
  assert.strictEqual(D.emailDomainKind('x@mailinator.com'), 'disposable');

  // ---- Retraction Watch name match: address words and countries are not a shared institution
  const ins = (doi, inst) => db.query("INSERT INTO retractions(doi, title, journal, journal_norm, nature, reason, authors, institution, retraction_date) VALUES($1, 'A retracted paper', 'J X', 'j x', 'Retraction', '+Paper Mill', 'Tariq Mahmood; Lee Min', $2, '2023-01-01')", [doi, inst]);
  await ins('10.9/rw.1', 'Department of Physics, Army Public School, Post Office Box 12, Seoul, Korea');
  await ins('10.9/rw.2', 'Department of Business Administration, Hanyang Institute, Korea');
  const hits = await PM.authorRetractions([{ given: 'Tariq', family: 'Mahmood' }], ['Faculty of Pharmacy, Army Medical College, Post Box 1, Rawalpindi, Pakistan; Department of Business Administration, Korea']);
  assert.strictEqual(hits.length, 2);
  assert.ok(hits.every(h => h.confidence !== 'high'), JSON.stringify(hits.map(h => [h.confidence, h.institutionMatch])));
  // the same person at the same institution is still a high-confidence match
  await ins('10.9/rw.3', 'Faculty of Pharmacy, Hamdard University, Karachi, Pakistan');
  const same = await PM.authorRetractions([{ given: 'Tariq', family: 'Mahmood' }], ['Faculty of Pharmacy, Hamdard University, Karachi, Pakistan']);
  assert.strictEqual(same.find(h => h.doi === '10.9/rw.3').confidence, 'high');

  // ---- no ORCID and all free-mail are shown but not counted; a single weak signal stays LOW
  const text = `Effect of a plant extract on wound healing in rats\nAhmed Raza, Sana Khan\nCorresponding author: ahmed.raza@gmail.com\n\nAbstract\nThe extract was tested.\n\nMaterials and methods\nThirty Wistar rats were divided into groups (n = 6) and given 100 mg/kg orally. Approved by the Animal Ethics Committee (No. AEC/2023/11).\n\nResults\nThe extract healed wounds.\n`;
  const r = await PM.detectPaperMill({ text, body: text, meta: { title: 'Effect of a plant extract on wound healing in rats', authors: [{ given: 'Ahmed', family: 'Raza' }, { given: 'Sana', family: 'Khan' }], affiliations: [], manuscriptCode: 'ACC-1' }, references: [], millLookalike: false, blast: false, cellosaurus: false });
  const of = c => r.signals.find(s => s.code === c);
  assert.ok(of('no-orcid') && of('no-orcid').weight === 0, 'no-orcid shown, weight 0');
  assert.ok(of('free-mail') && of('free-mail').weight === 0, 'free-mail shown, weight 0');
  assert.strictEqual(r.risk.level, 'LOW');

  // ---- risk levels
  const lv = ws => PM.riskLevel(ws.map(w => ({ weight: w, severity: 'medium' }))).level;
  assert.strictEqual(lv([2, 1]), 'LOW');
  assert.strictEqual(lv([2, 2]), 'MEDIUM');
  assert.strictEqual(lv([3, 2]), 'MEDIUM');
  assert.strictEqual(lv([4, 2]), 'HIGH');
  assert.strictEqual(PM.riskLevel([{ weight: 5, severity: 'high' }, { weight: 5, severity: 'high' }]).level, 'HIGH');
  // one strong signal plus a weak note stays MEDIUM; moderate signals from several checks adding up to 6 are HIGH
  assert.strictEqual(PM.riskLevel([{ weight: 5, severity: 'high' }, { weight: 1, severity: 'low' }]).level, 'MEDIUM');
  assert.strictEqual(PM.riskLevel([{ weight: 5, severity: 'high' }, { weight: 3, severity: 'medium' }]).level, 'HIGH');

  // ---- statistics: a product code "SD-101" is not a negative standard deviation
  const DC = require('../src/papermill/dataChecks');
  const neg = t => DC.statisticsCheck(t).findings.filter(f => /negative/.test(f.recalculated)).length;
  assert.strictEqual(neg('Cells were treated with the TLR9 agonist SD-101 (1, 2.5, 5 μM).'), 0);
  assert.strictEqual(neg('Body weight 210 g, SD = -1.2 g.'), 1);
  assert.strictEqual(neg('The mean was 4.2 ± -0.3 mg.'), 1);

  console.log('papermill-accuracy: all checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
