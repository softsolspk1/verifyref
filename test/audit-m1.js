// test/audit-m1.js - Module 1 accuracy audit. A reference list with KNOWN ground truth is run through the live engine
// (12 databases) and each verdict is scored against the expected one. Needs internet. Output: scratchpad/audit-m1.json
const fs = require('fs');
const path = require('path');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname;

// expect: acceptable verdict(s). kind: what the test case is.
const CASES = [
  // ---- genuine, correctly cited
  ['Watson JD and Crick FHC (1953). Molecular structure of nucleic acids. Nature, 171(4356): 737-738. doi:10.1038/171737a0', ['verified'], 'genuine'],
  ['LeCun Y, Bengio Y and Hinton G (2015). Deep learning. Nature, 521(7553): 436-444. doi:10.1038/nature14539', ['verified'], 'genuine'],
  ['Hanahan D and Weinberg RA (2011). Hallmarks of cancer: the next generation. Cell, 144(5): 646-674.', ['verified'], 'genuine'],
  ['Livak KJ and Schmittgen TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) method. Methods, 25(4): 402-408.', ['verified'], 'genuine'],
  ['Bray F, Ferlay J, Soerjomataram I, Siegel RL, Torre LA and Jemal A (2018). Global cancer statistics 2018: GLOBOCAN estimates of incidence and mortality worldwide for 36 cancers in 185 countries. CA Cancer J. Clin., 68(6): 394-424.', ['verified'], 'genuine'],
  ['Page MJ, McKenzie JE, Bossuyt PM et al. (2021). The PRISMA 2020 statement: an updated guideline for reporting systematic reviews. BMJ, 372: n71.', ['verified'], 'genuine'],
  ['Higuchi T (1963). Mechanism of sustained-action medication. Theoretical analysis of rate of release of solid drugs dispersed in solid matrices. J. Pharm. Sci., 52(12): 1145-1149.', ['verified'], 'genuine'],
  ['Lipinski CA, Lombardo F, Dominy BW and Feeney PJ (1997). Experimental and computational approaches to estimate solubility and permeability in drug discovery and development settings. Adv. Drug Deliv. Rev., 23(1-3): 3-25.', ['verified'], 'genuine'],
  ['Moher D, Liberati A, Tetzlaff J and Altman DG (2009). Preferred reporting items for systematic reviews and meta-analyses: the PRISMA statement. PLoS Med., 6(7): e1000097.', ['verified'], 'genuine'],
  ['Mosmann T (1983). Rapid colorimetric assay for cellular growth and survival: application to proliferation and cytotoxicity assays. J. Immunol. Methods, 65(1-2): 55-63.', ['verified'], 'genuine'],
  // ---- genuine paper, no DOI given, minor formatting
  ['Pearson K. (1901) On lines and planes of closest fit to systems of points in space. Philosophical Magazine 2(11): 559-572.', ['verified', 'miscited'], 'genuine-hard'],
  // ---- genuine paper, DOI with junk appended (should be repaired)
  ['LeCun Y, Bengio Y and Hinton G (2015). Deep learning. Nature, 521: 436-444. https://doi.org/10.1038/nature14539.pp436-444', ['verified', 'miscited'], 'doi-junk'],
  // ---- miscited: real work, wrong details
  ['LeCun Y, Bengio Y and Hinton G (2014). Deep learning. Nature, 512(7553): 436-444.', ['miscited'], 'miscited'],
  ['Hanahan D and Weinberg RA (2012). Hallmarks of cancer: the next generation. Cell, 144(5): 646-700.', ['miscited'], 'miscited'],
  ['Page MJ, McKenzie JE, Bossuyt PM et al. (2020). The PRISMA 2020 statement: an updated guideline for reporting systematic reviews. BMJ, 370: n71.', ['miscited'], 'miscited'],
  ['Mosmann T (1985). Rapid colorimetric assay for cellular growth and survival: application to proliferation and cytotoxicity assays. J. Immunol. Methods, 75(1-2): 155-163.', ['miscited'], 'miscited'],
  // ---- fabricated
  ['Khan A, Raza S and Malik T (2021). Nanoparticle-mediated delivery of quercetin enhances hepatoprotective effect via modulation of CYP3A4 in diabetic rats. J. Control. Release, 330: 112-125.', ['suspicious', 'unverified'], 'fabricated'],
  ['Smith J and Brown K (2019). Machine learning for drug toxicity prediction in clinical trials. Nat. Med., 25: 1234-1240. doi:10.1038/s41591-019-9999-0', ['suspicious'], 'fabricated-doi'],
  ['Ahmed R, Hussain M and Qureshi N (2020). Green synthesis of silver nanoparticles from Moringa seeds and their antidiabetic efficacy: a randomized controlled trial. Lancet, 395(10225): 891-902.', ['suspicious', 'unverified'], 'fabricated'],
  ['Zhang L, Wang H and Chen Y (2022). Network pharmacology reveals berberine alleviates cisplatin nephrotoxicity through the PI3K/AKT axis. Phytomedicine, 98: 153940.', ['suspicious', 'unverified'], 'fabricated'],
  ['Hanahan D and Weinberg RA (2011). Hallmarks of cancer: the next generation of metabolic and immune dysregulation in pharmaceutical nanomedicine. Cell, 144(5): 646-674.', ['miscited', 'suspicious'], 'inserted-words'],
  ['Watson JD and Crick FHC (1953). Molecular structure of nucleic acids. Nature, 171: 737-738. doi:10.1038/nature14539', ['miscited', 'suspicious'], 'wrong-doi'],
  // ---- retracted
  ['Wakefield AJ, Murch SH, Anthony A et al. (1998). Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet, 351(9103): 637-641. doi:10.1016/S0140-6736(97)11096-0', ['retracted'], 'retracted'],
  ['Seralini GE, Clair E, Mesnage R et al. (2012). Long term toxicity of a Roundup herbicide and a Roundup-tolerant genetically modified maize. Food Chem. Toxicol., 50(11): 4221-4231.', ['retracted'], 'retracted'],
  // ---- regional journal, not in international databases: must NOT be "suspicious"
  ['Ahmad N, Bibi S and Iqbal Z (2019). Evaluation of antibacterial activity of selected medicinal plants of Khyber Pakhtunkhwa. Pak. J. Pharm. Sci., 32(3): 1121-1127.', ['unverified', 'notindexed', 'verified', 'miscited'], 'regional'],
  ['Rehman A, Shah SA and Khan MI (2018). Formulation and in vitro evaluation of metformin sustained release tablets. Pak. J. Pharm. Sci., 31(4): 1405-1412.', ['unverified', 'notindexed', 'verified', 'miscited'], 'regional'],
  // ---- duplicate (same work as #2, different formatting)
  ['Yann LeCun, Yoshua Bengio, Geoffrey Hinton. Deep learning. Nature 2015;521:436–44.', ['verified', 'miscited'], 'duplicate']
];

(async () => {
  const api = await boot();
  const text = CASES.map((c, i) => `${i + 1}. ${c[0]}`).join('\n');
  const t0 = Date.now();
  const start = await api.json('POST', '/api/checks', { kind: 'references', referencesText: text, manuscriptCode: 'AUDIT-M1', save: true });
  const job = await api.job(start.data.jobId, 900);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (job.status !== 'done') { console.error('job failed', job); process.exit(1); }
  const R = job.result;
  const rows = R.references.results;
  const label = r => (r.notIndexed || /not indexed/i.test(r.statusLabel || '') ? 'notindexed' : r.status);
  let ok = 0; const confusion = {}; const detail = [];
  CASES.forEach((c, i) => {
    const r = rows[i]; if (!r) { detail.push({ n: i + 1, kind: c[2], got: 'MISSING', pass: false }); return; }
    const got = label(r); const pass = c[1].includes(got) || c[1].includes(r.status);
    if (pass) ok++;
    const key = `${c[2]} -> ${r.status}`; confusion[key] = (confusion[key] || 0) + 1;
    detail.push({ n: i + 1, kind: c[2], expected: c[1].join('|'), got: r.status, label: r.statusLabel, conf: r.confidence, pass, reason: (r.reason || '').slice(0, 140), retraction: r.retraction ? r.retraction.nature : null, doi: r.record?.doi || null });
  });
  console.log(`Module 1: ${ok}/${CASES.length} correct, ${secs}s, parsed ${rows.length} refs`);
  detail.forEach(d => console.log(`${d.pass ? 'PASS' : 'FAIL'} #${String(d.n).padStart(2)} ${d.kind.padEnd(14)} exp=${String(d.expected).padEnd(34)} got=${String(d.got).padEnd(10)} conf=${d.conf} ${d.label || ''} | ${d.reason}`));
  console.log('summary', JSON.stringify(R.references.summary));
  console.log('indicators', JSON.stringify(R.indicators || null).slice(0, 1500));
  console.log('journals', JSON.stringify(R.journals?.summary || null));
  // exports
  const id = R.id; const ex = {};
  for (const f of ['csv', 'bibtex', 'ris', 'docx', 'corrected']) { const x = await api.raw(`/api/checks/${id}/export?format=${f}`); ex[f] = { status: x.status, bytes: x.buffer.length }; }
  console.log('exports', JSON.stringify(ex));
  // re-check
  const rc = await api.json('POST', `/api/checks/${id}/recheck`, {});
  const rj = rc.data.jobId ? await api.job(rc.data.jobId, 600) : { status: 'nojob' };
  console.log('recheck', rj.status, JSON.stringify(rj.result?.changes ? { rows: rj.result.changes.rows.length } : null));
  fs.writeFileSync(path.join(OUT, 'audit-m1.json'), JSON.stringify({ ok, total: CASES.length, secs, detail, confusion, summary: R.references.summary, indicators: R.indicators, exports: ex, recheck: rj.result?.changes?.rows?.length ?? null, refKeys: Object.keys(rows[0] || {}) }, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
