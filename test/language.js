// test/language.js - Module 6 PJPS Scribe: the in-house rules, research-manuscript checks, scoring, the API
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
  // medical and pharmaceutical terms learned from published papers, names in statistics, abbreviations and prefixes joined
  // by hyphens, web addresses and file names (PJPS Scribe, report of 14 Nov 2026)
  const med = 'Ectopic stromal and myometrial lesions with adnexal fibroids were seen on sagittal scans of the uterine fundus by sonographers; ' +
    'hysteroscopy, gravidity and amenorrhea were recorded, and tolerability, IUC-related and LNG-IUS-containing devices, non-absorbable and pre-specified ' +
    'outcomes, Kaplan-Meier curves and Bonferroni-adjusted tests follow the guide at pjps.pk and the file report.pdf.';
  const { paragraphs: [pm] } = await L.checkParagraphs([med], { goals: { domain: 'academic' } });
  assert.deepStrictEqual(pm.filter(i => i.spelling).map(i => i.text), [], 'no false spelling alarms on medical text');
  // a slip in a medical word is still found
  const { paragraphs: [pt] } = await L.checkParagraphs(['The myometrail thickness was measured.'], { goals: { domain: 'academic' } });
  assert.ok(has(pt, 'spelling', 'myometrail'), 'misspelled medical term still reported');
  // the rule bank (bank.js, also the grammar server's PJPS rules): every rule finds its example and leaves the correction alone
  const BANK = require('../src/language/bank');
  const bankFails = [];
  for (const e of BANK.entries()) {
    if (!BANK.match(e.example.bad).some(i => i.rule === e.rule && i.offset === e.example.offset)) bankFails.push(`${e.id} misses "${e.example.bad}"`);
    if (e.example.good && BANK.match(e.example.good).some(i => i.rule === e.rule && i.offset === e.example.offset)) bankFails.push(`${e.id} flags its correction "${e.example.good}"`);
  }
  assert.deepStrictEqual(bankFails, [], `rule bank: ${bankFails.length} of ${BANK.entries().length} rules fail their examples`);
  assert.ok(BANK.entries().length > 2500 && BANK.typoList().length > 1500, 'rule bank and typing-slip list loaded');
  // slips seen in published papers and drug names in another language's form, with the right word first
  const { paragraphs: [ps] } = await L.checkParagraphs(['The postive control and metformine were given; malodialdehyde rose.'], { goals: { domain: 'academic' } });
  for (const [w, fix] of [['postive', 'positive'], ['metformine', 'metformin'], ['malodialdehyde', 'malondialdehyde']]) assert.ok(ps.find(i => i.spelling && i.text === w)?.replacements[0] === fix, `${w} -> ${fix}`);
  // medical confusions, prepositions, second-language forms, terms and species (Grammarly-style areas, research focus)
  const gram = 'The MTT essay was used and samples were purchased form Sigma. The drug could not calculated and did not showed effects; the plant have mild activity. ' +
    'Rats were treated for 5 week, one of the most important factor is diet, and each patients consented. Patients had underwent surgery for prostrate cancer. ' +
    'Results were associated to age and discussed about in detail. In streptozotocin induced diabetic rats, Escherichia Coli and E.coli grew in-vitro; informations were recorded.';
  const { paragraphs: [pg] } = await L.checkParagraphs([gram], { goals: { domain: 'academic' } });
  for (const [rule, text] of [['medical-confusion', 'essay'], ['medical-confusion', 'form'], ['verb-form', 'calculated'], ['verb-form', 'showed'], ['subject-verb', 'have'],
    ['noun-number', 'week'], ['noun-number', 'factor'], ['noun-number', 'patients'], ['l2-grammar', 'had underwent'], ['medical-confusion', 'prostrate'], ['preposition', 'associated to'],
    ['preposition', 'discussed about'], ['compound-hyphen', 'streptozotocin induced'], ['species-name', 'Escherichia Coli'], ['species-name', 'E.coli'], ['medical-term', 'in-vitro']]) {
    assert.ok(has(pg, rule, text), `rule ${rule} on "${text}"`);
  }
  assert.ok(pg.find(i => i.text === 'informations')?.replacements[0] === 'information', 'uncountable noun: informations -> information');
  // gaps found against Grammarly on a PJPS manuscript (report of 16 Nov 2026): articles, comparatives, ranges, percentages
  const g7 = 'Half were in control group and other half in intervention group. Booklet also included pictures. Standard counselling by physician was provided. ' +
    'T-CED is highly efficacious than routine care and showed high adherence than control. The session ranged from 30-35 minutes. On average, number of contacts was 6.3. ' +
    'Smoking was seen in about 43% participants. Nurses play a suitable role to address these barriers. There is a need of counseling. TB is the leading causes of death.';
  const { paragraphs: [p7] } = await L.checkParagraphs([g7], { goals: { domain: 'academic' } });
  for (const [rule, text, fix] of [['determiner', 'control group', 'the control group'], ['determiner', 'Booklet', 'The booklet'], ['determiner', 'physician', 'a physician'],
    ['comparative', 'highly efficacious', 'more efficacious'], ['comparative', 'high', 'higher'], ['range', '30-35', '30 to 35'], ['determiner', 'number', 'the number'],
    ['percent-of', '43%', '43% of'], ['preposition', 'to address', 'in addressing'], ['preposition', 'a need of', 'a need for'], ['academic-usage', 'is the leading causes', 'is the leading cause']]) {
    assert.ok(p7.some(i => i.rule === rule && i.text === text && i.replacements[0] === fix), `${rule}: "${text}" -> "${fix}"`);
  }
  // and not on correct research writing (false alarms found in 250 published PJPS articles)
  const fine = ['The results obtained in this study suggest a benefit.', 'Ethical approval for the experiments was obtained.', 'A phase 2 trial was done in table 2.',
    'Both patient and physician agreed.', 'How do treated cells respond?', 'This results in lower doses.', 'The interleukin 6 concentration rose.', 'The (+/-)-praeruptorin A was used.',
    'It was, as it were, a test.', 'The structure of compound I is shown.', 'The total does not exceed 10 mg.', 'It is converted in the liver.', 'Systemic bias was low.',
    'Mean values are shown in table 1 vs control.', 'Samples were stored for further study.', 'Further in vivo study is needed.', 'Patients were treated in hospital in group A.',
    'Dilutions ranged between 10 -4 and 10 -8 M.', 'The majority of patients in the control group were women, rather than men.', 'Samples were diluted in mg/ml units at 37 °C.', 'The CO 2 level and the IC 50 value were low.', 'Patients were discussed about 20 times.'];
  for (const s of fine) {
    const { paragraphs: [pf] } = await L.checkParagraphs([s], { goals: { domain: 'academic' } });
    const wrong = pf.filter(i => ['medical-confusion', 'preposition', 'l2-grammar', 'noun-number', 'verb-form', 'subject-verb', 'compound-hyphen', 'academic-usage', 'unit-style', 'medical-term', 'determiner', 'comparative', 'range', 'percent-of', 'spacing-colon', 'word-choice'].includes(i.rule));
    assert.deepStrictEqual(wrong.map(i => `${i.rule}: ${i.text}`), [], `no false alarm in "${s}"`);
  }
  // P values: written as PJPS articles write them ("P<0.05" or "P < 0.05"); only a missing leading zero is reported
  const { paragraphs: [pv] } = await L.checkParagraphs(['Groups differed (P<0.001), and scores did not (P > 0.05); the trend was P<.05.'], { goals: { domain: 'academic' } });
  assert.deepStrictEqual(pv.filter(i => i.rule === 'p-value').map(i => i.text), ['P<.05'], 'P values in PJPS style accepted');
  // the vocabulary of research is not "overused"
  const { paragraphs: [po] } = await L.checkParagraphs(['Levels fell significantly in all groups. Levels rose significantly in two groups. Levels were significantly lower in both groups compared with baseline levels.'], { goals: { domain: 'academic' } });
  assert.ok(!po.some(i => i.rule === 'overused' && /^(?:levels|significantly|groups)$/i.test(i.text)), 'research vocabulary is not overused');
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
  // the title page and capitals used inconsistently (gaps against Grammarly, 16 Nov 2026)
  const title = 'EFFECT OF A NURSE-LED PROGRAM\nJaved Iqbal, RN,MHA\nMedicine department District Headquarters Hospital, Jhang Punjab Pakistan\n' +
    'Adjunct professor, Datta Meghe Institute, Wardha. India\nORCIdD :- https://orcid.org/0000-0003-2627-685X\nE-mail address: a@b.pk\nEmail: c@d.pk\n' +
    'Aga Khan University Pakistan Journal of Pharmaceutical Sciences, Karachi, Pakistan.\nABSTRACT\nBackground: Knowledge of latent infection is low. ' +
    'We measured knowledge and attitudes. Poor knowledge led to poor adherence, and the management of Latent tuberculosis infection and knowledge of it were assessed in households.\n' +
    'Introduction\nThe programme improved knowledge in all participants and the Health Belief Model explains latent infection and latent risk in households of patients with tuberculosis disease.\n';
  const tp = L.checkDocument(title, { counts: {} }).issues;
  const fixed = tp.filter(i => i.rule === 'author-block').map(i => `${i.text}->${i.replacements[0]}`);
  for (const f of ['Medicine department->Department of Medicine', ' ->, ', '. ->, ', ',->, ', 'ORCIdD->ORCID', ' :-->:']) assert.ok(fixed.includes(f), `author block: ${f} (${fixed.join(' | ')})`);
  assert.strictEqual(fixed.filter(f => f === ' ->, ').length, 2, 'Jhang, Punjab, Pakistan: both commas');
  assert.ok(!tp.some(i => i.rule === 'author-block' && i.offset > title.indexOf('Aga Khan') - 1 && i.offset < title.indexOf('Journal')), 'an institution name with a country is not split');
  assert.ok(tp.some(i => i.rule === 'hyphen-consistency' && i.text === 'E-mail'), 'E-mail and Email: one form');
  // second comparison with Grammarly: degrees, titles, labels, a name spelled two ways, phrases
  const tp2 = L.checkDocument('Title\nJaved Iqbal, Degrees ma RN\nCredential: Doctor of Philosophy (PhD), Registered Nurse (RN)\nAdjunct professor, Datta Meghe Institute\nABSTRACT\n' +
    'Background: Data were collected in Jhang district. The Jhang clinics and Jhang hospitals served Jahng villages and nearby areas well.\n', { counts: {} }).issues;
  const fx2 = tp2.map(i => `${i.text}->${i.replacements[0]}`);
  for (const f of ['ma->MA', 'Credential->Credentials', 'professor->Professor', 'Jahng->Jhang']) assert.ok(fx2.includes(f), `${f} (${fx2.join(' | ')})`);
  assert.ok(!fx2.some(f => /^Datta/.test(f)), 'a name that is a word apart (Datta / Data) is not changed');
  const { paragraphs: [ph] } = await L.checkParagraphs(['Medical adherence was assessed pre and post-test, and the attitude also showed the similar pattern. P-value less than 0.05 was significant. P value <0.05 was significant.'], { goals: { domain: 'academic' } });
  for (const [t, f] of [['medical adherence', 'Medication adherence'], ['pre', 'pre-'], ['the similar pattern', 'a similar pattern'], ['P-value', 'A P value']]) assert.ok(ph.some(i => i.text.toLowerCase() === t.toLowerCase() && i.replacements[0] === f), `${t} -> ${f}`);
  assert.ok(!ph.some(i => i.spelling && i.text === 'pre'), '"pre" is a word in manuscripts');
  assert.strictEqual(ph.filter(i => i.rule === 'determiner' && /^P/.test(i.text)).length, 1, '"P value <0.05" (PJPS form) is not changed');
  // third comparison with Grammarly on document 7
  const third = 'The research assistant read each questions aloud. There was also similar slight increase in attitude scores. Beliefs cannot be altered with limited number of sessions. ' +
    'The risk is due to immunocompromised state. Participants received materials including booklet, and a video. Knowledge rose to 37.5%, that is consistent with the literature. ' +
    'Author declare no conflict. Consent was obtained prior the start of the study. Results showed positive impact of the intervention. Patients can be greatly benefited from it. ' +
    'Items were rated on a 5-point Linkert scale. It was translated using standard translating procedures. Some beliefs are deeply penetrated in people. Scholars wish to study.';
  const t3 = require('../src/language/rules').checkParagraph(third, { domain: 'academic' }, { variant: 'en-US' }).map(i => `${i.text}->${i.replacements[0]}`);
  for (const f of ['questions->question', 'There was also similar->There was also a similar', 'with limited number of->with a limited number of', 'due to immunocompromised state->due to an immunocompromised state',
    'booklet->a booklet', 'that->which', 'Author declare->Authors declare', 'prior the->prior to the', 'showed positive impact->showed a positive impact', 'be greatly benefited from->greatly benefit from',
    'Linkert scale->Likert scale', 'translating procedures->translation procedures', 'deeply penetrated in->deeply ingrained in']) assert.ok(t3.includes(f), `${f} (${t3.join(' | ')})`);
  assert.ok(!t3.some(f => /^study->/.test(f)), '"to study" is a verb');
  // comparison with Grammarly on document 8
  const eighth = 'The profile of gestational SSRIs exposure was high. Fluvoxamine released extreme strong signals. Serotonin re-uptake inhibitors were used. Cleaning used MySQ, which removed duplicates. ' +
    'The dataset generated during the study is available. All authors approved publishment of the manuscript. Neonates had Hypoglycaemia neonatal and Infantile apnoea and foetal distress. Haemophilus influenzae and kaempferol were studied.';
  const t8 = require('../src/language/rules').checkParagraph(eighth, { domain: 'academic' }, { variant: 'en-US' }).map(i => `${i.text}->${i.replacements[0]}`);
  for (const f of ['SSRIs->SSRI', 'extreme strong->extremely strong', 're-uptake->reuptake', 'MySQ->MySQL', 'The dataset generated->The datasets generated', 'publishment->publication',
    'Hypoglycaemia->Hypoglycemia', 'apnoea->apnea', 'foetal->fetal']) assert.ok(t8.includes(f), `${f} (${t8.join(' | ')})`);
  assert.ok(!t8.some(f => /^(?:Haemophilus|kaempferol)/.test(f)), 'a genus or a flavonoid is not a British spelling');
  assert.ok(!require('../src/language/rules').checkParagraph('Hypoglycaemia and apnoea were seen.', {}, { variant: 'en-GB' }).some(i => i.spelling), 'British document: British spelling is right');
  const cap8 = require('../src/language/rules').checkParagraph('Figure 2 Signal detection scatter plot', {}, { variant: 'en-US' });
  assert.ok(cap8.some(i => i.replacements[0] === 'Figure 2: '), 'caption label takes a colon');
  assert.ok(!require('../src/language/rules').checkParagraph('Table 1 shows the data.', {}, { variant: 'en-US' }).some(i => i.rule === 'punctuation'), '"Table 1 shows" is a sentence');
  assert.deepStrictEqual(tp.filter(i => i.rule === 'case-consistency').map(i => i.text), ['Latent'], 'capitals: "Latent" mid-sentence, not the Health Belief Model or a sentence start');

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

  // Full Screening (Module 6 in the report): the whole manuscript as it comes out of a Word / PDF file
  const SC = require('../src/language/screen');
  const manuscript = ['Effect of metformin on hypertention in diabetic rats', 'Abstract',
    'Hypertension is common in patients with diabetes and its prevalance is rising worldwide (Kamel et al., 2020; Azim, 2019).',
    'Methods', 'Wistar rats received metformin (200 mg/kg) and the absense of adverse effects was recorded at 4 °C in a cool, dry place.',
    'The tumor size was', 'characterized by the analysts in all groups.', 'Days', 'uncertain', 'A549 cells were exposed to 5 mmol of KBr at 10 MPa.',
    ...Array(30).fill('The treated group showed lower blood pressure than the control group, and the results were analyzed with one-way ANOVA followed by the Tukey test.'),
    'References', '1. Kamel A, Hassan B (2020). Metformin in hypertension. Pak. J. Pharm. Sci., 33(1): 1-5.'].join('\n');
  const sc = await SC.screenLanguage(manuscript, { save: false });
  const miss = sc.spelling.map(w => w.word.toLowerCase());
  assert.strictEqual(sc.summary.variant, 'en-US', 'American spelling detected');
  for (const w of ['hypertention', 'prevalance', 'absense']) assert.ok(miss.includes(w), `screening finds "${w}"`);
  for (const w of ['kamel', 'azim', 'mmol', 'kbr', 'mpa', 'wistar', 'metformin', 'hassan']) assert.ok(!miss.includes(w), `screening accepts "${w}"`);
  const all = Object.values(sc.examples).flat();
  assert.ok(!all.some(e => /^(?:Days|uncertain|was)$/.test(e.text) && /capital|punctuation/i.test(e.title)), 'table cells and PDF line breaks are not sentence errors');
  assert.ok(!all.some(e => e.text === 'cool'), '"cool" (temperature) is not informal');
  assert.ok(sc.summary.score > 0 && sc.summary.score <= 100 && sc.method, 'score and method');
  assert.ok(SC.reflow('a sentence that\ncontinues here.') === 'a sentence that continues here.', 'PDF lines joined');

  // a cover letter before the manuscript and a reference list whose heading was lost in the text extraction (PJPS
  // report 199): the letter's "you" and its abbreviations, the cited authors' names and the journal abbreviations of the
  // references are not the manuscript's language; "Overall response rate" and "In addition to" need no comma
  const ms199 = ['Cover letter', 'Dear editor,', 'We submit our study of NIHSS scores. Thank you for considering our manuscript. We look forward to your response.', 'Sincerely,', 'Xianfeng Zhang',
    'Ginkgo terpene trilactones in hypertensive intracerebral hemorrhage', 'Abstract',
    'Background: Hypertensive intracerebral hemorrhage (HICH) is a major cause of disability. Methods: The National Institutes of Health Stroke Scale (NIHSS) was used.',
    'INTRODUCTION', 'Hypertensive intracerebral hemorrhage (HICH) is common and its outcome is poor (Xia and Fang, 2007; Mlinac and Feng, 2016; Liu et al., 2022).',
    'In addition to inflammatory injury, oxidative stress is another mechanism of brain injury after HICH (Gui et al., 2022).', 'Outcomes were scored with the National Institutes of Health Stroke Scale (NIHSS).', 'Overall response rate (%)',
    ...Array(30).fill('The treated group showed a lower NIHSS score than the control group, and the data were analysed with the t test.'),
    'Liu J, Sun C, Wang Y, Nie G, Dong Q, You J, Li Q, Li M (2022). Efficacy of nimodipine in subarachnoid hemorrhage: a meta-analysis. Arq Neuropsiquiatr 80: 663-670.',
    'Gui T, Luo L, Chhay B, Zhong L (2022). Superoxide dismutase-loaded porous particles. Pak J Pharm Sci 38: 83-88.',
    'Leasure AC, Kuohn LR, Vanent KN (2021). Neuroinflammation in intracerebral haemorrhage. Cerebrovasc Dis 42: 155-169.',
    'Mlinac ME, Feng MC (2016). Assessment of activities of daily living. Arch Clin Neuropsychol 31: 506-516.'].join('\n');
  const s199 = await SC.screenLanguage(ms199, { save: false });
  const m199 = s199.spelling.map(w => w.word);
  assert.deepStrictEqual(m199, [], `no names or journal abbreviations reported as misspelt (${m199.join(', ')})`);
  const a199 = Object.values(s199.examples).flat();
  assert.ok(!a199.some(e => e.rule === 'second-person'), 'the cover letter is not checked');
  assert.ok(!a199.some(e => e.rule === 'intro-comma'), '"Overall response rate" and "In addition to" need no comma');
  assert.ok(!a199.some(e => e.rule === 'abbr-redefined' || e.rule === 'abbr-late'), 'abbreviations defined in the abstract are defined again in the text');
  assert.ok(!a199.some(e => /Dis|Pak|Neuropsiquiatr/.test(e.text)), 'nothing from the reference list');
  assert.ok(SC.refListStart(ms199) < ms199.indexOf('Liu J, Sun C') + 1, 'reference list found without its heading');
  // a typo after a capitalised word is not a Latin species name ("After exclsuion", "No formla"); real species are accepted
  const sp = await SC.screenLanguage(['Wound healing study', 'Abstract', ...Array(30).fill('Extracts of Moringa oleifera and Withania somnifera were tested against E. coli and Staphylococcus aureus in all groups.'), 'After exclsuion, 184 patients were included. No formla power calculation was made.'].join('\n'), { save: false });
  assert.deepStrictEqual(sp.spelling.map(w => w.word).sort(), ['exclsuion', 'formla'], `typos after a capital found, species accepted (${sp.spelling.map(w => w.word)})`);
  // a British spelling in an American manuscript is correct English: a note to use one spelling, with the American form
  const usMs = ['Gentamicin in wound healing', 'Abstract', ...Array(40).fill('The wound area was analyzed and the tumor size was characterized in all groups of rats.'), 'Gentamicin sulphate cream was applied to the wound.'].join('\n');
  const us = await SC.screenLanguage(usMs, { save: false });
  const mix = Object.values(us.examples).flat().find(e => e.rule === 'variant-mix');
  assert.ok(!us.spelling.some(w => w.word === 'sulphate') && mix && mix.text === 'sulphate' && mix.replacement === 'sulfate', 'sulphate: a spelling-mix note offering "sulfate", not a misspelling');

  // AI sentence and paragraph suggestions (Grammarly's "Paragraph can be improved"), with a stand-in client: no paid call
  const AI = require('../src/language/ai');
  let asked = null;
  AI._setTestClient({ beta: { messages: { create: async req => {
    asked = req.messages[0].content;
    return { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: JSON.stringify({
      suggestions: [{ original: 'Total sample size was 240, half of which were present in control group.', replacement: 'The total sample size was 240, half of whom were in the control group.', category: 'correctness', title: 'Ungrammatical sentence', explanation: 'Articles and the relative pronoun are corrected.' }],
      rewrite: 'The total sample size was 240, half of whom were in the control group and half in the intervention group, and all were assessed at 12 weeks.' }) }] };
  } } } });
  process.env.ANTHROPIC_API_KEY = 'test-only';
  const aiPara = 'Total sample size was 240, half of which were present in control group. Other half in intervention group were assessed at 12 weeks.';
  const sug = await AI.suggest(null, aiPara, { goals: { domain: 'academic' }, variant: 'en-US', known: [{ text: 'control group', title: 'Missing article' }] });
  process.env.ANTHROPIC_API_KEY = '';
  AI._setTestClient(null);
  assert.ok(/Already reported by the rule checker[\s\S]*control group/.test(asked), 'the rule findings are given to the AI so it does not repeat them');
  assert.ok(sug.some(s => s.title === 'Ungrammatical sentence' && s.offset === 0 && s.replacements[0].startsWith('The total')), 'a whole ungrammatical sentence corrected');
  const whole = sug.find(s => s.rule === 'ai-paragraph');
  assert.ok(whole && whole.whole && whole.ai && whole.length === aiPara.length && whole.title === 'Paragraph can be improved', 'the paragraph revised as one suggestion');

  console.log('language: all checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
