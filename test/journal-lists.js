// test/journal-lists.js - the Clarivate Master Journal List (collection from a column or from the file name), Index
// Copernicus and Google Scholar Metrics lists: imported, found by ISSN or title, shown as indexing. Run: node test/journal-lists.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
const assert = require('assert');
const db = require('../src/db');
const D = require('../src/datasets');
const { interpretLists } = require('../src/checks/journal');

(async () => {
  await db.init();
  // one MJL collection per file: the collection comes from the file name
  await D.importJournalList('wos_mjl', 'wos-core_SCIE 2026-October-20.csv', 'Journal title,ISSN,eISSN,Publisher name,Web of Science Categories\n"PAKISTAN JOURNAL OF PHARMACEUTICAL SCIENCES",1011-601X,,PAKISTAN JOURNAL OF PHARMACEUTICAL SCIENCES,"Pharmacology & Pharmacy"\n');
  let hits = await D.listLookupAll(['1011-601X'], '');
  let lists = interpretLists(hits);
  assert.strictEqual(lists.wos?.[0]?.index, 'SCIE (Science Citation Index Expanded)', 'SCIE from the file name');
  assert.strictEqual(lists.wos[0].categories, 'Pharmacology & Pharmacy');
  // several collections in one file, with a Collection column; the SCImago WoS list is not shown twice
  await D.importJournalList('wos_mjl', 'mjl-all.csv', 'Journal title,ISSN,Collection\nJournal of Pharmacy Studies,1234-5679,ESCI\n');
  await D.importJournalList('wos_sjr', 'sjr-wos.csv', 'Title,Issn\nJournal of Pharmacy Studies,12345679\n');
  lists = interpretLists(await D.listLookupAll(['1234-5679'], ''));
  assert.deepStrictEqual(lists.wos.map(w => w.index), ['ESCI (Emerging Sources Citation Index)'], 'ESCI from the column, SCImago WoS entry not repeated');

  await D.importJournalList('ici', 'ici-master.csv', 'Title,ISSN,ICV 2024\nJournal of Pharmacy Studies,1234-5679,98.5\n');
  await D.importJournalList('gsm', 'gsm-pharmacy.csv', 'Publication,h5-index,h5-median,Category\nJournal of Pharmacy Studies,41,57,Pharmacy & Pharmaceutical Sciences\n');
  hits = await D.listLookupAll([], 'Journal of Pharmacy Studies');
  lists = interpretLists(hits);
  assert.strictEqual(lists.indexCopernicus?.icv, '98.5', 'Index Copernicus ICV');
  assert.strictEqual(lists.googleScholar?.h5index, '41', 'Google Scholar h5-index');
  assert.strictEqual(lists.googleScholar.h5median, '57');
  assert.strictEqual(lists.googleScholar.category, 'Pharmacy & Pharmaceutical Sciences');
  assert.ok(D.PUBLISHERS.some(p => p.key === 'lancet') && D.PUBLISHERS.some(p => p.key === 'jama') && D.PUBLISHERS.some(p => p.key === 'acs'), 'Lancet, JAMA and ACS journal lists');
  assert.ok(D.PUBLISHERS.find(p => p.key === 'lancet').titles.test('The Lancet Oncology') && !D.PUBLISHERS.find(p => p.key === 'lancet').titles.test('Journal of the Lancet Society'), 'Lancet journals marked by title');
  assert.ok(D.PUBLISHERS.find(p => p.key === 'jama').crossref.test('American Medical Association (AMA)'));
  console.log('journal lists test passed (Clarivate MJL, Index Copernicus, Google Scholar Metrics, Lancet / JAMA / ACS)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
