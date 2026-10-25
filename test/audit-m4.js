// test/audit-m4.js - Module 4 Paper Mill Detection audit with planted ground truth. Needs the warmed on-disk DB (AUDIT_DB)
// so Retraction Watch / Problematic Paper Screener / Beall are present.
const fs = require('fs');
const path = require('path');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname;
const R = {};

const CLEAN = `Effect of standardized Nigella sativa seed oil on lipid profile in alloxan-induced diabetic Wistar rats
Sana Rehman, Imran Qureshi, Naila Akhtar
Department of Pharmacology, University of Sargodha, Sargodha, Pakistan
Corresponding author: sana.rehman@uos.edu.pk
ORCID: 0000-0002-1825-0097

Abstract
Nigella sativa seed oil has been used in traditional medicine for diabetes. The present study evaluated the effect of a standardized seed oil on serum lipids in alloxan-induced diabetic rats over four weeks.

Introduction
Diabetes mellitus is associated with dyslipidaemia and cardiovascular risk (Hanahan and Weinberg, 2011). Herbal oils are widely used by patients in South Asia.

Materials and methods
Seed oil was purchased from Sigma-Aldrich (St. Louis, MO, USA; catalogue number N-9812) and thymoquinone content was determined by HPLC. Male Wistar rats (180-220 g, n = 6 per group) were obtained from the National Institute of Health, Islamabad. The study was approved by the Institutional Bioethics Committee of the University of Sargodha (approval number IBC/PHARM/2023/045). Diabetes was induced with alloxan monohydrate (120 mg/kg, intraperitoneal). Rats were divided into four groups: normal control, diabetic control, seed oil 150 mg/kg body weight by oral gavage daily for 28 days, and glibenclamide 5 mg/kg as the reference drug. Serum total cholesterol, triglycerides, HDL and LDL were measured with commercial kits (Randox, Crumlin, UK; catalogue numbers CH200, TR210, CH203). Data were analysed by one-way ANOVA with Tukey post-hoc test using GraphPad Prism 9; p < 0.05 was significant.

Results
Seed oil reduced total cholesterol and triglycerides compared with the diabetic control (p < 0.01) and increased HDL. The effect at 150 mg/kg was comparable with glibenclamide for triglycerides.

Discussion
The lipid-lowering effect may be related to thymoquinone content. Limitations include the short duration and the absence of histopathology.

References
Hanahan D and Weinberg RA (2011). Hallmarks of cancer: the next generation. Cell, 144(5): 646-674.
Mosmann T (1983). Rapid colorimetric assay for cellular growth and survival: application to proliferation and cytotoxicity assays. J. Immunol. Methods, 65(1-2): 55-63.
Livak KJ and Schmittgen TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): 402-408.
`;

const MILL = `Counterfeit consciousness assisted network pharmacology of a plant extract against breast cancer through the PI3K/AKT signaling pathway
Chen Fang, Fukang Sun, Ahmed Raza
Department of Biomedical Sciences, Shenzhen Institute of Technology, Shenzhen, China
Corresponding author: fang.chen2024@163.com; ahmed.raza.research@gmail.com

Abstract
Bosom peril is a leading cause of death. We used profound learning and information mining to screen the plant extract. As an AI language model, I cannot verify clinical outcomes, but the extract inhibited proliferation, migration and invasion of cancer cells. Regenerate response.

Introduction
Malignant growth remains a major burden (Smith and Brown, 2019; Zhang et al., 2022; Ahmed et al., 2020).

Materials and methods
Cells were purchased and treated with the extract. Animals were obtained and housed. HEp-2 cells, Intestine 407 cells, KB cells and Chang liver cells were cultured. Network pharmacology, molecular docking, hub genes, protein-protein interaction and KEGG enrichment were performed. The lncRNA sponges miR-21 to promote tumour growth, and miR-155 sponges circRNA to promote metastasis. The extract inhibited the growth via the PI3K/AKT pathway, the NF-kB pathway and the MAPK pathway.

Results
The extract inhibited proliferation, migration and invasion of cells. The prоtein levels (western blot) were altered. Hub genes were enriched in the PI3K/AKT signaling pathway.

Discussion
Our results show that the plant extract is a promising agent. The mechanism is the PI3K/AKT pathway.

References
Smith J and Brown K (2019). Machine learning for drug toxicity prediction in clinical trials. Nat. Med., 25: 1234-1240. doi:10.1038/s41591-019-9999-0
Zhang L, Wang H and Chen Y (2022). Network pharmacology reveals berberine alleviates cisplatin nephrotoxicity through the PI3K/AKT axis. Phytomedicine, 98: 153940.
Ahmed R, Hussain M and Qureshi N (2020). Green synthesis of silver nanoparticles from Moringa seeds and their antidiabetic efficacy: a randomized controlled trial. Lancet, 395(10225): 891-902.
Wakefield AJ, Murch SH, Anthony A et al. (1998). Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet, 351(9103): 637-641.
`;

async function run(api, fields, label) {
  const s = await api.json('POST', '/api/papermill', fields);
  if (!s.data.success) { console.log(label, 'REFUSED', s.status, s.data.message); return null; }
  const j = await api.job(s.data.jobId, 900);
  if (j.status !== 'done') { console.log(label, 'FAILED', j.error); return null; }
  return j.result;
}
const show = (label, r) => {
  console.log(`== ${label}: ${r.risk.level} score=${r.risk.score} high=${r.risk.highSignals}`);
  r.signals.forEach(s => console.log(`   ${s.severity.padEnd(6)} w${s.weight} ${s.code.padEnd(22)} ${s.title.slice(0, 100)}`));
};

(async () => {
  const api = await boot();
  const db = require('../src/db');
  // ---- control (must stay LOW)
  const clean = await run(api, { text: CLEAN, manuscriptCode: 'AUDIT-PM-CLEAN', authors: 'Sana Rehman\nImran Qureshi\nNaila Akhtar' }, 'clean');
  if (clean) { show('CLEAN control', clean); R.clean = { level: clean.risk.level, score: clean.risk.score, signals: clean.signals.map(s => `${s.code}:${s.severity}`) }; }
  // ---- mill manuscript
  const mill = await run(api, { text: MILL, manuscriptCode: 'AUDIT-PM-MILL', authors: 'Chen Fang\nFukang Sun\nAhmed Raza', suggestedReviewers: 'Prof. A Friend <friend.reviewer@gmail.com>\nDr B Colleague <b.colleague@yahoo.com>' }, 'mill');
  if (mill) { show('MILL manuscript', mill); R.mill = { level: mill.risk.level, score: mill.risk.score, signals: mill.signals.map(s => `${s.code}:${s.severity}`) }; }
  const want = ['tortured', 'ai-leftover', 'template', 'methods', 'cell-lines', 'free-mail', 'no-orcid', 'hidden', 'fabricated', 'author-mill-retraction'];
  const got = new Set((mill?.signals || []).map(s => s.code));
  R.expectedSignals = want.map(c => ({ code: c, found: got.has(c) }));
  console.log('planted signals found:', R.expectedSignals.map(x => `${x.code}=${x.found ? 'Y' : 'N'}`).join(' '));
  console.log('all codes returned:', [...got].join(','));
  // ---- exact resubmission + near-duplicate (small edits) under other IDs
  const dup1 = await run(api, { text: MILL, manuscriptCode: 'AUDIT-PM-DUP1', authors: 'Chen Fang\nFukang Sun\nAhmed Raza' }, 'dup exact');
  R.dupExact = !!dup1?.signals.some(s => s.code === 'duplicate');
  const edited = MILL.replace(/\bextract\b/g, 'preparation').replace('promising agent', 'promising candidate').replace('Cells were purchased', 'Cell lines were bought').replace('major burden', 'serious burden');
  const dup2 = await run(api, { text: edited, manuscriptCode: 'AUDIT-PM-DUP2', authors: 'Chen Fang\nFukang Sun\nAhmed Raza' }, 'dup edited');
  R.dupEdited = !!dup2?.signals.some(s => s.code === 'duplicate');
  console.log('duplicate exact:', R.dupExact, '| duplicate after small edits:', R.dupEdited);
  // ---- authorship change between versions (same manuscript code)
  const v1 = await run(api, { text: CLEAN, manuscriptCode: 'AUDIT-PM-AUTH', authors: 'Sana Rehman\nImran Qureshi\nNaila Akhtar', version: '1' }, 'v1');
  const v2 = await run(api, { text: CLEAN, manuscriptCode: 'AUDIT-PM-AUTH', authors: 'Sana Rehman\nWei Zhang\nLi Chen\nNaila Akhtar', version: '2' }, 'v2');
  R.authorshipChange = !!v2?.signals.some(s => /author/i.test(s.code) && /change|added|remov|order/i.test(s.title + s.code));
  console.log('authorship change detected:', R.authorshipChange, '|', (v2?.signals || []).filter(s => s.group === 'authors').map(s => s.code + ': ' + s.title.slice(0, 80)).join(' ; '));
  // ---- tortured phrase recall / false-alarm on 40 random PPS fingerprints
  const fp = await db.all("SELECT terms, expected FROM pps_fingerprints WHERE kind = 'tortured' ORDER BY random() LIMIT 40");
  const neutral = t => `The study evaluated the pharmacological activity of the extract in rats. ${t} was discussed in the context of the previous literature. `.repeat(1) + 'Further experimental details are provided in the methods section of this manuscript and the statistical analysis followed standard procedures. '.repeat(3);
  let tp = 0, fpCount = 0; const missed = [];
  const { textSignals } = require('../src/papermill');
  for (const f of fp) {
    const terms = JSON.parse(f.terms); const t = terms[0];
    const r1 = await (textSignals ? textSignals(neutral(`The phrase ${t}`), neutral(`The phrase ${t}`), []) : []);
    if ((r1 || []).some(s => s.code === 'tortured')) tp++; else missed.push(`${t} => ${f.expected}`);
    const r2 = await textSignals(neutral(`The correct term ${f.expected}`), neutral(`The correct term ${f.expected}`), []);
    if ((r2 || []).some(s => s.code === 'tortured')) fpCount++;
  }
  R.tortured = { n: fp.length, detected: tp, falseAlarmOnCorrectTerm: fpCount, missed: missed.slice(0, 8) };
  console.log('tortured recall', tp + '/' + fp.length, 'false alarms on correct term', fpCount, 'missed sample', JSON.stringify(missed.slice(0, 5)));
  // ---- decision record + exports
  if (mill) {
    const d = await api.json('PUT', `/api/checks/${mill.id}/decision`, { decision: 'investigate', notes: 'Audit note' });
    const x = await api.raw(`/api/checks/${mill.id}/confidential`);
    R.exports = { decision: d.status, docx: x.status, bytes: x.buffer.length };
    console.log('decision', d.status, 'confidential docx', x.status, x.buffer.length);
    // reviewer role must not reach Module 4
    const cu = await api.json('POST', '/api/admin/users', { email: 'rev@test.local', name: 'Rev Tester', role: 'researcher', password: 'revpass-12345', allowWeb: true });
    console.log('created reviewer', cu.status);
    const rApi = Object.assign({}, api);
    const lg = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rev@test.local', password: 'revpass-12345' }) });
    const ck = lg.headers.get('set-cookie')?.split(';')[0];
    const probe = async (m, p, b) => (await fetch(api.base + p, { method: m, headers: { 'Content-Type': 'application/json', Cookie: ck }, body: b ? JSON.stringify(b) : undefined })).status;
    R.reviewerAccess = {
      papermillRun: await probe('POST', '/api/papermill', { text: MILL }),
      confidentialExport: await probe('GET', `/api/checks/${mill.id}/confidential`),
      imagesSave: await probe('POST', '/api/images', { result: { findings: [] } }),
      adminUsers: await probe('GET', '/api/admin/users'),
      otherUserCheck: await probe('GET', `/api/checks/${mill.id}`)
    };
    console.log('reviewer access (403/404 = blocked):', JSON.stringify(R.reviewerAccess));
  }
  fs.writeFileSync(path.join(OUT, 'audit-m4.json'), JSON.stringify(R, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
