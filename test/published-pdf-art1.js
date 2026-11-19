// test/published-pdf-art1.js - reports 211 / 212 / 214 (17 Nov 2026), a published Pak. J. Bot. article screened as a PDF:
// its references ("Surname, A.B., C. Name and D. Name. 2017. Title.") are not cut where a PDF line ends, the authors'
// running head is not a reference, the title page in capitals gives the title and the authors (so their retractions are
// looked up), and a retraction of "Khalid M. A. Almutairi" is not given to "Khalid F. Almutairi". No internet needed.
const assert = require('assert');
const P = require('../src/parse');
const { middleConflict } = require('../src/papermill');

// title page as the PDF text gives it: affiliation marks, commas and "AND" on lines of their own
const head = ['Pak. J. Bot., 58(9): 1849-1856, September 2026. ', 'Received: 09-02-2026 Revised: 26-04-2026    Accepted: 05-05-2026 Online: 05-06-2026 ', ' ',
  'ARTICLE  doi: http://dx.doi.org/10.30848/PJB2026-9(17) ', ' ', 'CHITOSAN ENHANCES DROUGHT TOLERANCE IN DIANTHUS CARYOPHYLLUS ', 'VIA ANTIOXIDANT REGULATION AND OSMOTIC ADJUSTMENT ', ' ',
  'HOSAM O. ELANSARY¹, KHALID F. ALMUTAIRI', '1', ', ADEL M. AL-SAIF', '1', ', MAJED ALOTAIBI', '1', ' AND ', 'ABDULLAH ALEBIDI', '1', ' ', '1',
  'Department of Plant Production, College of Food and Agricultural Sciences, King Saud University, P.O. Box 2455, Riyadh 11451, ', 'Saudi Arabia ', ' ',
  "*Corresponding author's email: helansary@ksu.edu.sa ", ' ', 'Abstract ', ' ', 'Severe water shortages limit horticultural crop growth and development.'].join('\n');
const meta = P.extractManuscriptMeta(head);
assert.strictEqual(meta.title, 'CHITOSAN ENHANCES DROUGHT TOLERANCE IN DIANTHUS CARYOPHYLLUS VIA ANTIOXIDANT REGULATION AND OSMOTIC ADJUSTMENT', 'the journal header is not the title');
assert.deepStrictEqual(meta.authors.map(a => `${a.given} ${a.family}`), ['Hosam O. Elansary', 'Khalid F. Almutairi', 'Adel M. Al-Saif', 'Majed Alotaibi', 'Abdullah Alebidi'], 'authors in capitals read');
assert.ok(/King Saud University/.test(meta.affiliations[0]), 'affiliation');

// references cut by the PDF's line ends, and the running head between two pages
const refs = ['Balusamy, S.R., S. Rahimi, J. Sukweenadhi, S. Sunderraj, R.', 'Shanmugam, L. Thangavelu, I. Mijakovic and H. Perumalsamy. 2022. Chitosan, chitosan nanoparticles and modified chitosan biomaterials. Carbohyd. Polym., 284: 119189.',
  'Chandra, S., D.S. Rawat, D. Chandra and J. Rastogi. 2015.', 'Nativity, phytochemistry, ethnobotany and pharmacology of Dianthus caryophyllus. Res. J. Med. Plant, 10: 1-9.',
  'Jones, F. Jotzo, T. Krug, R. Lasco, Y.-Y. Lee, V. Masson-', 'Delmotte, M. Meinshausen and M. Ha. 2023. Climate Change 2023: Synthesis Report. IPCC, Geneva, Switzerland.',
  'Sardans, J. and J. Peñuelas. 2021. Potassium control of plant functions. Plants, 10: 419.', 'HOSAM O. ELANSARY', ' ', 'ET AL., ', '1856 ',
  'Sood, M. 2025. Reactive oxygen species (ROS): Plant perspectives on oxidative signalling. Discover Plants. 2.'].join('\n');
const list = P.splitReferences(refs).entries;
assert.deepStrictEqual(list.map(e => e.split(',')[0]), ['Balusamy', 'Chandra', 'Jones', 'Sardans', 'Sood'], 'five whole references, no running head');
assert.ok(/Perumalsamy\. 2022/.test(list[0]) && /Masson-\s?Delmotte/.test(list[2]), 'joined across the line ends');

// Retraction Watch: the same first name and surname with other middle initials is another person
assert.strictEqual(middleConflict('Khalid M A', 'Khalid F.'), true, 'Khalid M. A. is not Khalid F.');
assert.strictEqual(middleConflict('Hosam O.', 'Hosam O.'), false);
assert.strictEqual(middleConflict('Hosam', 'Hosam O.'), false, 'no middle initial on one side: not a conflict');
assert.strictEqual(middleConflict('M. A.', 'M. F.'), false, 'initials only: decided by the other rules');

// Report 217: a running title above the title, degrees with letter affiliation marks after each author, "* Corresponding Author:"
const m217 = P.extractManuscriptMeta(['Running Title: J. regia Attenuates Ethanol Damage',
  'Juglans regia Oil Attenuates Ethanol-Associated Changes in Male Reproductive Parameters in Rats',
  'Sadia Suri Kashif Ph.D.,a# Saira Saeed Khan Ph.D.,b#* Sadaf Naeem Ph.D.,c Muhammad Naveed Ph.D.d, Jennifer W. Hill Ph.D.d, Rahela Ikram Ph.D.b',
  'a. Department of Pharmacology, Faculty of Pharmacy and Pharmaceutical Sciences, Ziauddin University, Karachi, Pakistan',
  'b. Department of Pharmacology, Faculty of Pharmacy and Pharmaceutical Sciences, University of Karachi, Pakistan',
  '# These co-authors contributed equally to this work', '* Corresponding Author: ', 'Saira Saeed Khan', 'University of Karachi',
  'E-mail: saira.khan@uok.edu.pk', 'Abstract', 'Male reproductive dysfunction is frequently associated with hormonal imbalance.'].join('\n'));
assert.strictEqual(m217.title, 'Juglans regia Oil Attenuates Ethanol-Associated Changes in Male Reproductive Parameters in Rats', 'title below a running title');
assert.deepStrictEqual(m217.authors.map(a => a.name), ['Sadia Suri Kashif', 'Saira Saeed Khan', 'Sadaf Naeem', 'Muhammad Naveed', 'Jennifer W. Hill', 'Rahela Ikram'], 'six authors, degrees and letter marks removed');
assert.ok(!m217.affiliations.some(a => /corresponding/i.test(a)), '"Corresponding Author:" is not an affiliation');
assert.deepStrictEqual(P.extractManuscriptMeta('Effects of a drug on rats in a trial\nM. D. Smith, A. B. Jones\nAbstract\nText.').authors.map(a => a.name), ['M. D. Smith', 'A. B. Jones'], 'initials "M. D." are not a degree');

console.log('published-pdf-art1: all checks passed');
