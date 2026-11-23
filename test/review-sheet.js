// test/review-sheet.js - the PJPS Preliminary Review Sheet: a manuscript uploaded with its figure files fills the form
// (scope, novelty against published PJPS titles, article type and its guideline, the Authors' Instructions, the
// outcome), the editor's changes are saved and the outcome follows them, the filled journal Word form downloads with
// the answers in its boxes, and editors whose permissions predate the page are given it. Offline, no paid service.
// Run: node test/review-sheet.js
process.env.PGLITE_DIR = 'memory://';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.PORT = '0';
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;
process.env.R2_BUCKET = '';
process.env.LANGUAGETOOL_URL = '';
const assert = require('assert');
const JSZip = require('jszip');
const R = require('../src/review/sheet');
const { permissionsOf } = require('../src/modules');

// a TIFF with its resolution (XResolution / ResolutionUnit inches), as an image program writes it
function tiff(dpi) {
  const b = Buffer.alloc(8 + 2 + 4 * 12 + 4 + 8);
  b.write('II', 0); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(4, 8);
  const tag = (i, t, type, v) => { const o = 10 + i * 12; b.writeUInt16LE(t, o); b.writeUInt16LE(type, o + 2); b.writeUInt32LE(1, o + 4); b.writeUInt32LE(v, o + 8); };
  const rat = 10 + 4 * 12 + 4;
  tag(0, 256, 3, 100); tag(1, 257, 3, 100); tag(2, 282, 5, rat); tag(3, 296, 3, 2);
  b.writeUInt32LE(dpi, rat); b.writeUInt32LE(1, rat + 4);
  return b;
}
const jpeg72 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9]);

const para = 'Patients with type 2 diabetes received metformin and the glycaemic control was compared between the groups over twelve weeks of follow-up (Khan et al., 2020).';
const MS = [
  'Effect of metformin plus lifestyle advice on glycaemic control: a randomized controlled trial',
  'Abstract',
  'Background: Diabetes is common. Objectives: To compare treatments. Methods: A randomized controlled trial of 120 patients. Results: HbA1c fell more with metformin (P<0.05). Conclusion: Metformin improves control.',
  'Keywords: metformin; diabetes; trial',
  'INTRODUCTION', para.repeat(4),
  'MATERIALS AND METHODS', `${para} The trial was registered at ClinicalTrials.gov (NCT01234567) on 12 March 2023. The study was approved by the Ethical Review Committee of the University (Ref. No. ERC/123). This trial is reported according to the CONSORT statement; the CONSORT checklist is provided as a supplementary file. The participant flow diagram is shown in Fig. 1.`,
  'RESULTS', para.repeat(3),
  'DISCUSSION', para.repeat(3),
  'CONCLUSION', 'Metformin improved glycaemic control.',
  'REFERENCES',
  'Khan A, Ali B and Shah C (2020). Metformin in type 2 diabetes. Pak. J. Pharm. Sci., 33(1): 1-5.'
].join('\n');

(async () => {
  // ---------------------------------------------------------------- the analysis
  let s = await R.analyse(MS, { filename: 'G.P-16692-manuscript.txt', figures: [{ name: 'Figure1.tif', buffer: tiff(600) }], pjpsTitles: ['Another published PJPS article'] });
  assert.strictEqual(s.msNo, '16692', 'MS No from the file name');
  assert.ok(/randomized controlled trial/.test(s.title), 'title');
  assert.strictEqual(s.scope.value, 'yes', 'within the scope');
  assert.ok(s.scope.areas.includes('Clinical Pharmacology') && /^Scope: /.test(s.scope.evidence), `scope areas shown (${s.scope.evidence})`);
  assert.ok(s.scope.areas.every(a => R.SCOPE_AREAS.some(x => x.name === a)), 'only the journal\'s scope areas');
  // within the scope only under one of the journal's areas; a sheet filled before the areas gets them when opened
  assert.deepStrictEqual(R.scope('Customer loyalty in football clubs', 'Supporters of football clubs were surveyed about ticket prices.', ['marketing']).areas, [], 'outside every scope area');
  assert.deepStrictEqual(R.scope('Molecular docking of quercetin against COX-2', '', ['in silico', 'docking']).areas[0], 'Molecular Modeling', 'molecular modeling');
  const old = JSON.parse(JSON.stringify(s));
  delete old.scope.areas;
  old.scope.evidence = 'PJPS subject areas: Diabetes';
  assert.ok(R.upgradeScope(old, MS) && old.scope.areas.length && old.scope.value === 'yes', 'earlier sheet upgraded');
  assert.strictEqual(s.novelty.value, 'yes', 'no same-title PJPS article');
  assert.strictEqual(s.type.key, 'rct', 'article type: RCT');
  assert.deepStrictEqual(['followed', 'checklist', 'flow'].map(k => s.type.guideline[k].value), ['yes', 'yes', 'yes'], 'CONSORT followed, checklist and flow diagram');
  for (const k of ['abstract', 'introduction', 'methods', 'registration', 'ethics', 'results', 'discussion', 'figures']) assert.strictEqual(s.items[k].value, 'yes', `${k}: yes (${s.items[k].evidence})`);
  assert.ok(/NCT01234567/.test(s.items.registration.evidence), 'registration evidence');
  assert.ok(/600 dpi/.test(s.items.figures.evidence), 'figure file: TIFF at 600 dpi');

  // figures not as 600 dpi TIFF; a combined Results and Discussion; a same-title PJPS article
  const ms2 = MS.split('\nDISCUSSION\n').join('\n').replace('RESULTS', 'RESULTS AND DISCUSSION');
  s = await R.analyse(ms2, { filename: 'paper.txt', figures: [{ name: 'fig1.jpg', buffer: jpeg72 }], pjpsTitles: ['Effect of metformin plus lifestyle advice on glycaemic control: a randomized controlled trial'] });
  assert.strictEqual(s.items.results.value, 'no', 'combined Results and Discussion: not a separate Results heading');
  assert.strictEqual(s.items.discussion.value, 'no', 'no separate Discussion heading');
  assert.strictEqual(s.items.figures.value, 'no', 'a 72 dpi JPEG is not a 600 dpi TIFF');
  assert.strictEqual(s.novelty.value, 'no', 'the same title is already published in PJPS');
  assert.notStrictEqual(s.outcome, 'peer-review', 'not ready for peer review');
  assert.deepStrictEqual(R.imageInfo(tiff(300)), { format: 'TIFF', dpi: 300 }, 'TIFF resolution read');

  // a laboratory study: no guideline, no registration or ethics needed
  const lab = await R.analyse(['In vitro antioxidant activity of a leaf extract', 'Abstract', 'Background: x. Objectives: y. Methods: DPPH assay of the extract. Results: activity. Conclusion: active.', 'INTRODUCTION', 'The extract was tested in vitro. '.repeat(20), 'MATERIALS AND METHODS', 'The extract was prepared with methanol and tested with the DPPH assay. '.repeat(10), 'RESULTS', 'Activity was found. '.repeat(10), 'DISCUSSION', 'The extract is active. '.repeat(10)].join('\n'), { filename: 'lab.txt' });
  assert.strictEqual(lab.type.key, 'other', 'in vitro study: Others');
  assert.ok(/In vitro/.test(lab.type.specify), 'specified as an in vitro study');
  assert.strictEqual(lab.items.registration.value, 'na', 'registration not applicable');
  assert.strictEqual(lab.items.ethics.value, 'na', 'ethics not applicable');
  assert.strictEqual(lab.items.figures.value, 'na', 'no figures');

  // in the Full Screening: Modules 1-3's reference results, the novelty assessment and the published PJPS version
  const scr = { meta: { title: 'Effect of metformin plus lifestyle advice on glycaemic control: a randomized controlled trial', manuscriptCode: 'PJPS-16692', fileName: 'ms.docx' },
    compliance: { summary: { score: 95, nonCompliant: 0, total: 1, inTextIssues: 0 } }, citations: { summary: { missing: 0, uncited: 0 } }, references: { summary: { total: 1, suspicious: 4, retracted: 0 } },
    novelty: { summary: { score: 30, band: 'low', closeRecent: 4 } }, images: { summary: { images: 3, panels: 5 } } };
  let fs1 = await R.fromScreening(scr, { text: MS, save: false });
  const item = k => fs1.items.find(i => i.key === k);
  assert.strictEqual(fs1.msNo, '16692', 'MS No from the manuscript code');
  assert.ok(item('references').value === 'no' && /not found in any database/.test(item('references').evidence), 'references not found in any database (Module 1) fail the reference item');
  assert.ok(fs1.novelty === 'no', 'low novelty from the Full Screening assessment');
  assert.ok(item('figures').value === 'no' && /3 picture/.test(item('figures').evidence), 'Module 5 found pictures in the manuscript');
  fs1 = await R.fromScreening({ ...scr, references: { summary: { total: 1, suspicious: 0, retracted: 0 } }, novelty: null, publishedOnPjps: { where: 'Vol. 38, No. 2', title: 'The published article', percent: 97 } }, { text: MS, save: false });
  assert.ok(fs1.novelty === 'no' && fs1.items.find(i => i.key === 'references').value === 'yes', 'already published on PJPS: no novelty; references fine');

  // ---------------------------------------------------------------- the API and the Word form
  const app = require('../server');
  const port = await app.start({ port: 0 });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, path, body, form) => {
    const r = await fetch(base + path, { method, headers: { ...(form ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) }, body: form || (body ? JSON.stringify(body) : undefined) });
    const c = r.headers.get('set-cookie');
    if (c) cookie = c.split(';')[0];
    return r;
  };
  assert.ok((await (await call('POST', '/api/auth/login', { email: 'admin@test.local', password: 'admin-pass-123' })).json()).success, 'login');
  const fd = new FormData();
  fd.append('file', new Blob([MS], { type: 'text/plain' }), 'G.P-16692-manuscript.txt');
  fd.append('figures', new Blob([tiff(600)], { type: 'image/tiff' }), 'Figure1.tif');
  let d = await (await call('POST', '/api/review-sheet', null, fd)).json();
  assert.ok(d.success && d.id && d.sheet.type.key === 'rct', 'sheet filled from the upload');
  assert.strictEqual(d.sheet.outcome, 'peer-review', 'every check met: peer review');
  const id = d.id;
  d = await (await call('GET', '/api/review-sheets')).json();
  assert.ok(d.sheets.some(x => x.id === id && x.msNo === '16692'), 'listed');

  d = await (await call('PUT', `/api/review-sheet/${id}`, { items: { ethics: 'no' }, comments: 'Add the ethics approval letter.' })).json();
  assert.ok(d.sheet.items.ethics.value === 'no' && d.sheet.items.ethics.auto === 'yes', 'editor changed an answer');
  assert.strictEqual(d.sheet.outcome, 'resubmit', 'outcome follows the change');
  d = await (await call('PUT', `/api/review-sheet/${id}`, { typeKey: 'observational' })).json();
  assert.ok(d.sheet.type.key === 'observational' && d.sheet.type.guideline.followed.value === 'no', 'type changed: its own guideline (STROBE not named)');

  const res = await call('GET', `/api/review-sheet/${id}/docx`);
  assert.strictEqual(res.status, 200, 'Word form downloads');
  const xml = await (await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()))).file('word/document.xml').async('string');
  const text = xml.replace(/<[^>]+>/g, '');
  assert.ok(text.includes('MS No 16692'), 'MS No in the form');
  assert.ok(text.includes('Effect of metformin plus lifestyle advice'), 'title in the form');
  assert.ok(!text.includes('GC-MS Analysis'), 'the template example title is replaced');
  assert.ok((text.match(/✓/g) || []).length >= 10, 'answers ticked');
  assert.ok(text.includes('Add the ethics approval letter.'), 'comments in the form');

  // editors whose permissions were set before the page existed are given it; reviewers are not
  assert.ok(permissionsOf({ role: 'editor', permissions: ['references', '_v4', '_v6'] }).includes('review-sheet'), 'editor given the page');
  assert.ok(!permissionsOf({ role: 'researcher', permissions: null }).includes('review-sheet'), 'reviewer not given it by default');

  assert.strictEqual((await call('DELETE', `/api/review-sheet/${id}`)).status, 200, 'deleted');
  console.log('review sheet: all checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
