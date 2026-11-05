// test/audit-m1-real.js - Module 1 third held-out set: references written the way they arrive in real submissions
// (ALL-CAPS titles, "&" and full first names, abbreviated page ranges, Greek symbols in titles, dx.doi.org links, print
// year one after the online year, no year, "et al" without a full stop), subtle single errors (author order swapped,
// wrong issue, one-digit DOI typo, abbreviated page range wrong), retracted papers cited with and without their DOI and
// invented references. Ground truth checked on Crossref on 4 Nov 2026. Needs internet. Output: audit-m1-real.json
const fs = require('fs');
const path = require('path');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname;

const CASES = [
  // ---- genuine, written as real authors write them
  ['MOSMANN T (1983). RAPID COLORIMETRIC ASSAY FOR CELLULAR GROWTH AND SURVIVAL: APPLICATION TO PROLIFERATION AND CYTOTOXICITY ASSAYS. J. IMMUNOL. METHODS, 65(1-2): 55-63.', ['verified'], 'genuine-caps'],
  ['Trott, Oleg & Olson, Arthur J. 2010. AutoDock Vina: improving the speed and accuracy of docking with a new scoring function, efficient optimization, and multithreading. Journal of Computational Chemistry 31(2), 455–461.', ['verified'], 'genuine-fullnames-printyear'],
  ['Huang DW, Sherman BT, Lempicki RA. Systematic and integrative analysis of large gene lists using DAVID bioinformatics resources. Nat Protoc 2009;4:44-57.', ['verified'], 'genuine-vancouver-printyear'],
  ['Dixon SJ et al Ferroptosis: an iron-dependent form of nonapoptotic cell death. Cell 2012;149:1060-72.', ['verified'], 'genuine-etal-shortpages'],
  ['Livak KJ and Schmittgen TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2-ΔΔCT method. Methods, 25(4): 402-408.', ['verified'], 'genuine-greek'],
  ['Livak KJ, Schmittgen TD. Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) Method. Methods. 2001 Dec;25(4):402-8.', ['verified'], 'genuine-greek-words'],
  ['Higuchi T (1963). Mechanism of sustained-action medication. Theoretical analysis of rate of release of solid drugs dispersed in solid matrices. J. Pharm. Sci., 52(12): 1145-1149. https://dx.doi.org/10.1002/jps.2600521210.', ['verified'], 'genuine-dxdoi'],
  ['Singleton VL and Rossi JA (1965). Colorimetry of total phenolics with phosphomolybdic-phosphotungstic acid reagents. Am. J. Enol. Vitic., 16(3): 144-158.', ['verified'], 'genuine-old'],
  ['Moher D, Liberati A, Tetzlaff J, Altman DG, The PRISMA Group. Preferred reporting items for systematic reviews and meta-analyses: the PRISMA statement. PLoS Med. 2009;6(7):e1000097.', ['verified'], 'genuine-group-author'],
  ['Page MJ, McKenzie JE, Bossuyt PM et al. (2021). The PRISMA 2020 statement: an updated guideline for reporting systematic reviews. BMJ, 372: n71.', ['verified'], 'genuine-article-number'],
  ['Daina A, Michielin O and Zoete V. SwissADME: a free web tool to evaluate pharmacokinetics, drug-likeness and medicinal chemistry friendliness of small molecules. Sci. Rep., 7: 42717.', ['verified'], 'genuine-noyear'],
  ['Lipinski CA, Lombardo F, Dominy BW and Feeney PJ (1997). Experimental and computational approaches to estimate solubility and permeability in drug discovery and development settings. Adv. Drug Deliv. Rev., 23(1-3): 3-25.', ['verified'], 'genuine'],
  ['Gibaldi M and Perrier D (1982). Pharmacokinetics, 2nd ed., Marcel Dekker, New York.', ['verified', 'unverified', 'notindexed'], 'book'],
  ['ICH Harmonised Tripartite Guideline (2005). Validation of analytical procedures: text and methodology Q2(R1). International Conference on Harmonisation, Geneva.', ['verified', 'unverified', 'notindexed'], 'guideline'],
  // ---- one subtle error each: must be Miscited (never Verified)
  ['Olson AJ and Trott O (2010). AutoDock Vina: improving the speed and accuracy of docking with a new scoring function, efficient optimization, and multithreading. J. Comput. Chem., 31(2): 455-461.', ['miscited'], 'author-order-swapped'],
  ['Mosmann T (1983). Rapid colorimetric assay for cellular growth and survival: application to proliferation and cytotoxicity assays. J. Immunol. Methods, 65(1-2): 65-73.', ['miscited'], 'wrong-pages'],
  ['Dixon SJ, Lemberg KM, Lamprecht MR et al. Ferroptosis: an iron-dependent form of nonapoptotic cell death. Cell 2012;149:1160-72.', ['miscited'], 'wrong-short-pages'],
  ['Daina A, Michielin O and Zoete V (2017). SwissADME: a free web tool to evaluate pharmacokinetics, drug-likeness and medicinal chemistry friendliness of small molecules. Sci. Rep., 7: 42717. doi:10.1038/srep42718', ['miscited'], 'doi-typo'],
  ['Sung H, Ferlay J, Siegel RL et al. (2021). Global cancer statistics 2020: GLOBOCAN estimates of incidence and mortality worldwide for 36 cancers in 185 countries. CA Cancer J. Clin., 81(3): 209-249.', ['miscited'], 'wrong-volume'],
  ['Higuchi T (1973). Mechanism of sustained-action medication. Theoretical analysis of rate of release of solid drugs dispersed in solid matrices. J. Pharm. Sci., 52(12): 1145-1149.', ['miscited'], 'wrong-year'],
  ['Lipinski CA, Lombardo F, Dominy BW and Feeney PJ (1997). Experimental and computational approaches to estimate solubility and permeability in drug discovery and development settings. Eur. J. Pharm. Sci., 23(1-3): 3-25.', ['miscited'], 'wrong-journal'],
  // ---- retracted
  ['Wakefield AJ, Murch SH, Anthony A et al. (1998). Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet, 351(9103): 637-641. doi:10.1016/S0140-6736(97)11096-0', ['retracted'], 'retracted-doi'],
  ['Séralini GE, Clair E, Mesnage R et al. (2012). Long term toxicity of a Roundup herbicide and a Roundup-tolerant genetically modified maize. Food Chem. Toxicol., 50(11): 4221-4231.', ['retracted'], 'retracted-nodoi'],
  ['Seralini GE, Clair E, Mesnage R, Gress S, Defarge N, Malatesta M, Hennequin D and de Vendomois JS (2012). Long term toxicity of a Roundup herbicide and a Roundup-tolerant genetically modified maize. Food Chem Toxicol 50: 4221-31.', ['retracted'], 'retracted-noaccent'],
  // ---- invented
  ['Daina A and Zoete V (2019). SwissADME 2.0: deep-learning prediction of oral bioavailability for natural products of Asian medicinal plants. Sci. Rep., 9: 15432.', ['suspicious', 'unverified'], 'invented-real-authors'],
  ['Trott O and Olson AJ (2012). AutoDock Vina 2: flexible receptor docking of flavonoids against SARS-CoV-2 main protease. J. Comput. Chem., 33(4): 512-520. doi:10.1002/jcc.2133499', ['suspicious'], 'invented-baddoi'],
  ['Mosmann T and Lowry OH (1988). A tetrazolium-based assay for the cytotoxicity of Pakistani herbal extracts on HepG2 cells. J. Immunol. Methods, 110(2): 201-208.', ['suspicious', 'unverified'], 'invented'],
  ['Dixon SJ and Stockwell BR (2015). Ferroptosis is the principal mechanism of paracetamol hepatotoxicity in rats. Cell, 160(3): 412-425.', ['suspicious', 'unverified', 'miscited'], 'invented-real-authors']
];

(async () => {
  const api = await boot();
  const text = CASES.map((c, i) => `${i + 1}. ${c[0]}`).join('\n');
  const t0 = Date.now();
  const start = await api.json('POST', '/api/checks', { kind: 'references', referencesText: text, manuscriptCode: 'AUDIT-M1-REAL', save: false });
  const job = await api.job(start.data.jobId, 900);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (job.status !== 'done') { console.error('job failed', job); process.exit(1); }
  const rows = job.result.references.results;
  const label = r => (r.notIndexed || /not indexed/i.test(r.statusLabel || '') ? 'notindexed' : r.status);
  let ok = 0; const byKind = {}; const detail = [];
  CASES.forEach((c, i) => {
    const r = rows[i];
    const got = r ? label(r) : 'MISSING'; const pass = !!r && (c[1].includes(got) || c[1].includes(r.status));
    if (pass) ok++;
    const k = c[2].replace(/-.*/, ''); byKind[k] = byKind[k] || [0, 0]; byKind[k][1]++; if (pass) byKind[k][0]++;
    detail.push({ n: i + 1, kind: c[2], expected: c[1].join('|'), got: r?.status, conf: r?.confidence, pass, reason: (r?.reason || '').slice(0, 160), doi: r?.record?.doi || null });
  });
  console.log(`Module 1 (real-world forms): ${ok}/${CASES.length} correct, ${secs}s`);
  detail.forEach(d => console.log(`${d.pass ? 'PASS' : 'FAIL'} #${String(d.n).padStart(2)} ${d.kind.padEnd(28)} exp=${d.expected.padEnd(30)} got=${String(d.got).padEnd(10)} conf=${d.conf} | ${d.reason}`));
  console.log('by kind', JSON.stringify(byKind));
  fs.writeFileSync(path.join(OUT, 'audit-m1-real.json'), JSON.stringify({ ok, total: CASES.length, secs, detail, byKind }, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
