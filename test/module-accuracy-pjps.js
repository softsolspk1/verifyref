// test/module-accuracy-pjps.js - the gaps found by running every module on 240 published PJPS articles (18 Nov 2026), each
// pinned with the real case that exposed it: reference lists flattened to one line (stray "1." / "2.", multi-word surnames,
// cuts at an initial, organisation authors on their own line, captions between references), the title page of a one-line
// text, citations of organisations by acronym and with name particles, model numbers and species authorities that are not
// citations, article numbers / e-locators / books in the style check, British spelling suggestions, articles before "X",
// stains, books in Module 1 and 3C, and the Retraction Watch author match (city alone, generic words, common co-authors,
// other fields). In-memory database for the author match. Run: node test/module-accuracy-pjps.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.APP_MODE;
process.env.ANTHROPIC_API_KEY = ''; process.env.LANGUAGETOOL_URL = '';
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) process.env[k] = '';
const assert = require('assert');
const P = require('../src/parse');
const { prepare } = require('../src/pipeline');
const { checkCitations } = require('../src/checks/citation');
const { checkEntry } = require('../src/checks/compliance');

(async () => {
  // ---- reference lists flattened to one line
  const flat = 'Ahmad I, Ahmed S and Anwar Z (2016). Photostability of drugs and drug products. Int. J. Photoenergy, 2016: 1-19. Adil A and Moutawakil A (2012). The quality cost reduction in hollow glass manufacturing. J. Sci. Res., 4(1): 155-172. Schott-Rohrglas (2003). Special glass containers for primary packaging: Amber glass, Part 1. News Letter, pp.1-4. Shivsharan US, Rault ES and Shaikh ZM (2014). Packaging of cosmetics: A review. J. Pharm. Sci. Innov., 3(4): 286-292. Tonnesen HH (1996). Photostability of drugs and drug formulations. Chap 2. Taylor & Francis, London, UK. Zweifel H and Amos SE (2001). Plastics additives handbook. Hanser Publishers, Munich, Germany.';
  assert.strictEqual(P.splitReferences(flat).entries.length, 6, '"Part 1." and "Chap 2." inside entries are not a numbered list');
  const cut = (raw, n, msg) => assert.strictEqual(P.splitReferences(raw).entries.length, n, msg);
  cut('Liu XH, Ji QW, Huang Y and Zeng Q (2011). Th17 response promotes angiotensin II-induced atherosclerosis. Med. Hypotheses, 76: 593-595. Del Rosario Espinoza Mora M, Bohm M and Link A (2014). The Th17/Treg imbalance in patients with cardiogenic shock. Clin. Res. Cardiol., 103: 301-313. Wang X, Jiang Z and Cao W (2014). Th17/Treg imbalance in hypertension. Hypertens. Res., 37: 101-109.', 3, 'a surname of four words begins its own reference');
  cut('Cheung RCF, Ng TB, Wong JH and Chan WY (2015). Chitosan: an update on potential biomedical and pharmaceutical applications. Mar. Drugs, 13(8): 5156- 5186. Das S and Ganesh E. A (2010). Extraction of chitin from trash crabs by an eccentric method. Curr. Res. J. Biol. Sci., 2(1): 72-75. Ali D, Ahmad M and Alma. UD (2011). Bioactive glass nanoparticles with negative zeta potential. Ceram. Int., 37(7): 2311-2316.', 3, 'a cut at an initial before the year is repaired');
  cut('Shemesh M and Schreiber G (2021). IFNAR1 and IFNAR2 play distinct roles in type I interferon signaling. Sci. Signal., 14(710): eabe4627. TODAY Study Group, Bjornstad P, Drews KL and Zeitler P (2021). Long-term complications in youth-onset type 2 diabetes. N. Engl. J. Med., 385(5): 416-426. Dacie JV and Lewis SM (1991). Practical haematology. Churchill Livingstone, Edinburgh, 7: 521-534. de Arriba SG, Naser B and Nolte KU (2013). Risk assessment of free hydroquinone. Int. J. Toxicol., 32: 442-453.', 4, 'after an e-locator, and before a lower-case particle');
  cut('Clinical Laboratory Standards Institute (2011). Performance standards for antimicrobial susceptibility testing. CLSI document M100-S21, Wayne, PA.\nWorld Health Organization (2013). Global action plan for the prevention of NCDs. WHO, Geneva.\nKhan A and Ali B (2019). A study of something important. J. Pharm., 3: 1-5.', 3, 'an organisation as author on its own line');
  const cap = P.splitReferences('Adjei A, Newburger J and Martin A (1980). Extended Hildebrand approach: solubility of caffeine. J. Pharm. Sci., 69: 659-661. Table 2: Mole fraction solubility of meloxicam in water and dioxane at 25 °C').entries;
  assert.ok(!/Table 2/.test(cap.join(' ')), 'a table caption after the last reference is left out');

  // ---- the title page of a one-line text
  const page = 'Pak. J. Pharm. Sci., Vol.31, No.3(Special), May 2018, pp.1151-1156 1151 Intervention and effect analysis of Achyranthes bidentata combined with aerobic exercise in type 2 diabetes Chi Ma 1 *, Chengtao Zhang 2 and Xin Li 3 1 College of Sports Science, Mudanjiang Normal University, Mudanjiang, China 2 Mudanjiang Cardiovascular Hospital, Endocrinology Department, Mudanjiang, China 3 Qinhuangdao Institute of Technology, Qinhuangdao, China Abstract: With the continuous progress of traditional Chinese medicine extraction technology in recent years, the active components of traditional Chinese medicine have been continuously extracted and analyzed in many studies. Keywords: Achyranthes bidentata, aerobic exercise, diabetes INTRODUCTION Diabetes is common.';
  const m = P.extractManuscriptMeta(page);
  assert.strictEqual(m.title, 'Intervention and effect analysis of Achyranthes bidentata combined with aerobic exercise in type 2 diabetes');
  assert.ok(m.abstract.startsWith('With the continuous progress'), 'abstract');
  assert.deepStrictEqual(m.authors.map(a => a.name), ['Chi Ma', 'Chengtao Zhang', 'Xin Li']);
  assert.ok(m.affiliations[0].startsWith('College of Sports Science'), 'affiliations');

  // ---- citations
  const cites = (body, refsText) => { const { refs } = prepare({ referencesText: refsText, bodyText: body }); return checkCitations(body, refs); };
  const c1 = cites('Susceptibility of all the isolates was tested by disc diffusion as recommended (CLSI, 2011). Diabetes and obesity are common in the region and the burden is rising every year (WHO, 2013; Khan and Ali, 2019). We followed the reporting guideline for observational studies in this work (von Elm et al., 2014).',
    'Clinical Laboratory Standards Institute (2011). Performance standards for antimicrobial susceptibility testing. CLSI document M100-S21, Wayne, PA.\nWorld Health Organization (2013). Global action plan for the prevention of NCDs. WHO, Geneva.\nKhan A and Ali B (2019). A study of something important. J. Pharm., 3: 1-5.\nElm E, Altman DG, Egger M and Pocock SJ (2014). The STROBE statement. Int. J. Surg., 12(11): 1495-1499.');
  assert.deepStrictEqual(c1.missing, [], 'acronym and particle citations are matched');
  assert.strictEqual(c1.uncited.length, 0);
  const ay = t => P.extractAuthorYearCitations(t).map(c => `${c.authors[0]} ${c.year}`);
  assert.deepStrictEqual(ay('read with a spectrophotometer (Shimadzu 1601, Japan) and (UV 2000, Hitachi). Genus : Acanthaster (Gervais, 1841) Species : A. planci (Linnaeus, 1758) and (Folin and Ciocalteu, 1927).'), ['Folin 1927']);

  // ---- style check (Module 2): article numbers, e-locators, a journal without its comma, books
  const fields = raw => { const r = P.parseReferenceEntry(raw, 1); return [r.volume, r.issue, r.pages].join('|'); };
  assert.strictEqual(fields('Rodrigues A and Silva B (2011). Knowledge of parents in Greece. BMC Pediatrics, 11: 60.'), '11||60');
  assert.strictEqual(fields('Wu L (2023). Generic herb-symptom effectiveness of traditional Chinese medicine. Sci Adv., 9(43): eadh0215.'), '9|43|eadh0215');
  assert.strictEqual(fields('Khan A (2019). Enanthramides against ehrlich solid tumors in mice. Oxid. Med. Cell. Longev., 2019: ID 5162687.'), '2019||5162687');
  assert.strictEqual(fields('Al-Juboori E and Khudhier S (2023). Hepatocellular carcinoma prediction. Baghdad Sci. J. 20: 15-20.'), '20||15-20');
  assert.strictEqual(fields('Jouvet M (1999). Sleep and serotonin: an unfinished story. Neuropsychopharmacology, 21: 24S-27S.'), '21||24S-27S');
  const dev = raw => checkEntry(P.parseReferenceEntry(raw, 1), null).deviations.map(d => d.message);
  for (const b of ['Beckett AH and Stenlake JB (2002). Practical Pharmaceutical Chemistry, Part-1, CBS Publishers, New Delhi, p.168.', 'British Pharmacopoeia (2016). Her Majesty\'s Stationery Office, London.'])
    assert.ok(!dev(b).some(x => /Volume missing|Page numbers|sentence case/.test(x)), `a book is not judged as an article: ${b}`);

  // ---- Module 6
  const L = require('../src/language');
  const { paragraphs: [p] } = await L.checkParagraphs(['ANOVA was used to analyse the interaction between the drugs. Separation used an Xterra MS C18 column. Sections were examined by HE staining.'], { goals: { domain: 'academic' } });
  assert.strictEqual(p.find(i => i.text === 'analyse')?.replacements[0], 'analyze', 'the US spelling of the same word, not "analyte"');
  assert.ok(!p.some(i => i.rule === 'a-an'), '"an Xterra"');
  assert.ok(!p.some(i => i.rule === 'determiner'), '"by HE staining" takes no article');

  // ---- Module 1: a book's edition year, a registry "author" that is an affiliation
  const R = require('../src/checks/reference');
  const cmp = (raw, rec) => { const ref = P.parseReferenceEntry(raw, 1); const r2 = { title: ref.title, authors: ref.authors, year: ref.year, journal: ref.journal, volume: ref.volume, issue: ref.issue, pages: ref.pages, ...rec }; return R.compare(ref, r2, R.scoreCandidate(ref, r2)).filter(i => i.severity !== 'low').map(i => i.code); };
  assert.deepStrictEqual(cmp('Huang KC (1988). The Pharmacology of Chinese Herbs. 2nd ed. CRC Press, Boca Raton, p.544.', { year: 1998, type: 'book', pages: '1-600' }), []);
  assert.deepStrictEqual(cmp('Jeph A and Khan J (2020). Ethnomedicinal study in reserve forest area of Jhunjhunu District. Trop. Plant Res., 7(2): 379-387.', { authors: [{ family: 'Deparment of Botany, Govt. Girls College, Jhunjhunu-333001', given: '' }] }), []);
  assert.deepStrictEqual(cmp('Mosmann T (1983). Rapid colorimetric assay for cellular growth and survival. J. Immunol. Methods, 65(1-2): 65-73.', { year: 1985, pages: '55-63' }), ['year', 'pages'], 'an article\'s errors are still reported');

  // ---- Module 4: Retraction Watch author match
  const db = require('../src/db');
  await db.init();
  const PM = require('../src/papermill');
  const ins = (doi, authors, inst) => db.query("INSERT INTO retractions(doi, title, journal, journal_norm, nature, reason, authors, institution, retraction_date) VALUES($1, 'A retracted paper', 'J X', 'j x', 'Retraction', '+Paper Mill', $2, $3, '2023-01-01')", [doi, authors, inst]);
  await ins('10.9/a1', 'Sajid Bashir;Zara Khan', 'Department of Pharmacology, Allama Iqbal Medical College, Lahore, Pakistan');
  await ins('10.9/a2', 'Muhammad Akram;Syed Muhammad Ali Shah', 'Department of Mathematics, University of the Punjab, Lahore, Pakistan');
  await ins('10.9/a3', 'Jie Zhu;Chang Liu', 'Key Laboratory of Textile Science, College of Textiles, Donghua University, Shanghai, China');
  await ins('10.9/a4', 'Nael Abutaha;Fahd Alharbi', 'Department of Zoology, College of Science, King Saud University, Riyadh, Saudi Arabia');
  await ins('10.9/a5', 'Ghulam Rasool;Fahad Said Khan;Muhammad Riaz', '');
  const conf = async (authors, affs) => (await PM.authorRetractions(authors.map(n => { const w = n.split(' '); return { given: w.slice(0, -1).join(' '), family: w[w.length - 1] }; }), affs)).map(h => `${h.author}:${h.confidence}`).sort();
  assert.deepStrictEqual(await conf(['Sajid Bashir'], ['Faculty of Pharmacy, University of Sargodha, Sargodha; Department of Pharmacy, Lahore, Pakistan']), ['Sajid Bashir:medium'], 'a city alone is not the same institution');
  assert.deepStrictEqual(await conf(['Muhammad Akram', 'Syed Muhammad Ali Shah'], ['Faculty of Pharmacy, University of Lahore, Pakistan']), ['Muhammad Akram:low', 'Syed Muhammad Ali Shah:low'], 'mathematics: another person, co-author or not');
  assert.ok((await conf(['Jie Zhu', 'Chang Liu'], ['Third Xiangya Hospital, Central South University, Changsha, China'])).every(x => !x.endsWith(':high')), 'two names on a textile paper');
  assert.deepStrictEqual(await conf(['Nael Abutaha'], ['Bioproducts Research Chair, Department of Zoology, College of Science, King Saud University, Riyadh']), ['Nael Abutaha:high'], 'same person, same department');
  assert.ok((await conf(['Ghulam Rasool', 'Fahad Said Khan', 'Muhammad Riaz'], ['Department of Biochemistry, Government College University, Faisalabad'])).every(x => x.endsWith(':high')), 'three co-authors on one retracted paper are the group');

  console.log('module-accuracy-pjps: all checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
