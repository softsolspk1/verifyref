// test/audit-m1-hard.js - Module 1 held-out accuracy set: real papers cited correctly in several styles, the same papers
// with ONE realistic error each (author, journal, volume, pages, year, DOI), AI-style invented references that borrow
// real authors and journals, and retracted papers given without a DOI. Needs internet. Output: audit-m1-hard.json
const fs = require('fs');
const path = require('path');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname;

const CASES = [
  // ---- genuine, several citation styles
  ['Bradford MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2): 248-254.', ['verified'], 'genuine'],
  ['Bradford, M. M. (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Analytical Biochemistry, 72(1–2), 248–254. https://doi.org/10.1016/0003-2697(76)90527-3', ['verified'], 'genuine-apa'],
  ['Laemmli UK (1970). Cleavage of structural proteins during the assembly of the head of bacteriophage T4. Nature, 227(5259): 680-685.', ['verified'], 'genuine'],
  ['Schneider CA, Rasband WS, Eliceiri KW. NIH Image to ImageJ: 25 years of image analysis. Nat Methods. 2012 Jul;9(7):671-5.', ['verified'], 'genuine-vancouver'],
  ['Altschul SF, Gish W, Miller W, Myers EW and Lipman DJ (1990). Basic local alignment search tool. J. Mol. Biol., 215(3): 403-410.', ['verified'], 'genuine'],
  ['Kilkenny C, Browne WJ, Cuthill IC, Emerson M and Altman DG (2010). Improving bioscience research reporting: the ARRIVE guidelines for reporting animal research. PLoS Biol., 8(6): e1000412.', ['verified'], 'genuine'],
  ['Ellman GL, Courtney KD, Andres V and Featherstone RM (1961). A new and rapid colorimetric determination of acetylcholinesterase activity. Biochem. Pharmacol., 7(2): 88-95.', ['verified'], 'genuine'],
  ['Brand-Williams W, Cuvelier ME and Berset C (1995). Use of a free radical method to evaluate antioxidant activity. LWT - Food Sci. Technol., 28(1): 25-30.', ['verified'], 'genuine'],
  ['Re R, Pellegrini N, Proteggente A, Pannala A, Yang M and Rice-Evans C (1999). Antioxidant activity applying an improved ABTS radical cation decolorization assay. Free Radic. Biol. Med., 26(9-10): 1231-1237.', ['verified'], 'genuine'],
  ['Korsmeyer RW, Gurny R, Doelker E, Buri P and Peppas NA (1983). Mechanisms of solute release from porous hydrophilic polymers. Int. J. Pharm., 15(1): 25-35.', ['verified'], 'genuine'],
  ['Jumper J, Evans R, Pritzel A et al. (2021). Highly accurate protein structure prediction with AlphaFold. Nature, 596(7873): 583-589. doi:10.1038/s41586-021-03819-2', ['verified'], 'genuine'],
  ['Lowry OH, Rosebrough NJ, Farr AL and Randall RJ (1951). Protein measurement with the Folin phenol reagent. J. Biol. Chem., 193(1): 265-275.', ['verified'], 'genuine-old'],
  ['Kilkenny C, Browne WJ, Cuthill IC, Emerson M and Altman DG (2010). Improving bioscience reserach reporting: the ARRIVE guideline for reporting animal research. PLoS Biol., 8(6): e1000412.', ['verified', 'miscited'], 'title-typo'],
  ['Lakowicz JR (2006). Principles of fluorescence spectroscopy. 3rd ed. Springer, New York.', ['verified', 'unverified', 'notindexed'], 'book'],
  ['World Health Organization (2023). Global tuberculosis report 2023. World Health Organization, Geneva.', ['verified', 'unverified', 'notindexed'], 'report'],
  // ---- one realistic error each: must be Miscited (never Verified)
  ['Lowry MM (1976). A rapid and sensitive method for the quantitation of microgram quantities of protein utilizing the principle of protein-dye binding. Anal. Biochem., 72(1-2): 248-254.', ['miscited'], 'wrong-author'],
  ['Laemmli UK (1970). Cleavage of structural proteins during the assembly of the head of bacteriophage T4. Science, 227(5259): 680-685.', ['miscited'], 'wrong-journal'],
  ['Schneider CA, Rasband WS and Eliceiri KW (2012). NIH Image to ImageJ: 25 years of image analysis. Nat. Methods, 19(7): 671-675.', ['miscited'], 'wrong-volume'],
  ['Altschul SF, Gish W, Miller W, Myers EW and Lipman DJ (1990). Basic local alignment search tool. J. Mol. Biol., 215(3): 503-510.', ['miscited'], 'wrong-pages'],
  ['Ellman GL, Courtney KD, Andres V and Featherstone RM (1971). A new and rapid colorimetric determination of acetylcholinesterase activity. Biochem. Pharmacol., 7(2): 88-95.', ['miscited'], 'wrong-year'],
  ['Benzie IF and Strain JJ (1996). The ferric reducing ability of plasma (FRAP) as a measure of "antioxidant power": the FRAP assay. Anal. Biochem., 239(1): 70-76. doi:10.1016/0003-2697(76)90527-3', ['miscited'], 'doi-other-paper'],
  ['Re R, Pellegrini N, Proteggente A, Pannala A, Yang M and Rice-Evans C (1999). Antioxidant activity applying an improved ABTS radical cation decolorization assay. Free Radic. Biol. Med., 26(9-10): 2231-2237.', ['miscited'], 'wrong-pages'],
  ['Korsmeyer RW and Peppas NA (1983). Mechanisms of solute release from porous hydrophilic polymers. J. Control. Release, 15(1): 25-35.', ['miscited'], 'wrong-journal'],
  // ---- invented (AI-style): real authors / journals, title that does not exist
  ['Jumper J, Evans R, Pritzel A et al. (2021). AlphaFold reveals the structural basis of artemisinin resistance in malaria parasites. Nature, 596(7873): 590-596.', ['suspicious', 'unverified', 'miscited'], 'invented-real-authors'],
  ['Brand-Williams W and Berset C (2005). An improved DPPH assay for flavonoid-rich plant extracts of South Asian origin. J. Agric. Food Chem., 53(4): 1123-1130.', ['suspicious', 'unverified'], 'invented'],
  ['Bradford MM and Lowry OH (1981). Comparison of dye-binding and Folin methods for protein estimation in herbal formulations. Anal. Biochem., 112(2): 301-309.', ['suspicious', 'unverified'], 'invented'],
  ['Iqbal J, Abbasi BA, Mahmood T et al. (2023). Machine-learning guided discovery of novel antidiabetic flavonoids from Pakistani medicinal plants. Nat. Commun., 14: 4412. doi:10.1038/s41467-023-99999-1', ['suspicious'], 'invented-doi'],
  // ---- retracted, no DOI given
  ['Obokata H, Wakayama T, Sasai Y et al. (2014). Stimulus-triggered fate conversion of somatic cells into pluripotency. Nature, 505(7485): 641-647.', ['retracted'], 'retracted'],
  ['Hwang WS, Roh SI, Lee BC et al. (2005). Patient-specific embryonic stem cells derived from human SCNT blastocysts. Science, 308(5729): 1777-1783.', ['retracted'], 'retracted'],
  ['Mehra MR, Desai SS, Ruschitzka F and Patel AN (2020). Hydroxychloroquine or chloroquine with or without a macrolide for treatment of COVID-19: a multinational registry analysis. Lancet.', ['retracted'], 'retracted']
];

(async () => {
  const api = await boot();
  const text = CASES.map((c, i) => `${i + 1}. ${c[0]}`).join('\n');
  const t0 = Date.now();
  const start = await api.json('POST', '/api/checks', { kind: 'references', referencesText: text, manuscriptCode: 'AUDIT-M1-HARD', save: false });
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
  console.log(`Module 1 (held-out): ${ok}/${CASES.length} correct, ${secs}s`);
  detail.forEach(d => console.log(`${d.pass ? 'PASS' : 'FAIL'} #${String(d.n).padStart(2)} ${d.kind.padEnd(22)} exp=${d.expected.padEnd(30)} got=${String(d.got).padEnd(10)} conf=${d.conf} | ${d.reason}`));
  console.log('by kind', JSON.stringify(byKind));
  fs.writeFileSync(path.join(OUT, 'audit-m1-hard.json'), JSON.stringify({ ok, total: CASES.length, secs, detail, byKind }, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
