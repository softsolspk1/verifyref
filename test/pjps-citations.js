// pjps-citations.js - references to earlier PJPS articles: found in the PJPS dataset by DOI or by title and year (also
// with no or a garbled journal name), not by a similar title of another year; the dataset's full author list finds a
// self-citation hidden behind "et al."; the citation pattern lists each one with its year, issue, self-citation and
// relevance, and flags several self-citations of PJPS articles. Offline: the dataset is stubbed, no network.
const assert = require('assert');
const path = require('path');

const ROWS = [
  { article_id: 101, title: 'Antibacterial activity of Nigella sativa seed extract against clinical isolates of Staphylococcus aureus', authors: 'Muhammad Khan; Ayesha Siddiqui; Bilal Ahmed', year: '2016', volume: '29', issue: '4', pages: '1201-1206', in_press: false, doi: '10.36721/pjps.2016.29.4.reg.1201-1206.1', url: 'https://pjps.pk/single-article?id=101' },
  { article_id: 102, title: 'Antioxidant potential of black seed oil measured by the DPPH radical scavenging assay', authors: 'Zainab Raza; Muhammad Khan; Sara Mozafari', year: '2025', volume: '38', issue: '2', pages: '455-461', in_press: false, doi: null, url: 'https://pjps.pk/single-article?id=102' },
  { article_id: 103, title: 'Formulation and evaluation of floating tablets of famotidine using natural polymers', authors: 'Imran Shah; Hina Akram', year: '2012', volume: '25', issue: '1', pages: '11-17', in_press: false, doi: null, url: 'https://pjps.pk/single-article?id=103' },
  { article_id: 104, title: 'Thymoquinone loaded nanoparticles for wound infections caused by resistant bacteria', authors: 'Omar Farooq', year: '2026', volume: '0', issue: '0', pages: '', in_press: true, doi: null, url: 'https://pjps.pk/single-article?id=104' }
];
let served = ROWS;
require.cache[path.resolve(__dirname, '../src/db.js')] = { id: 'db', filename: 'db', loaded: true, exports: { all: async () => served.slice(), one: async () => null, query: async () => ({ rows: [] }) } };

const { markPjpsArticles } = require('../src/checks/pjpsCitations');
const { analyzeCitationPattern } = require('../src/editor/pattern');

const ok = m => console.log(`  ok - ${m}`);
const ref = (index, title, extra = {}) => ({ index, raw: title, status: extra.status || 'unverified', record: null,
  parsed: { title, year: extra.year || null, journal: extra.journal || null, doi: extra.doi || null, authors: extra.authors || [{ given: 'X', family: `Other${index}` }] } });

(async () => {
  const meta = {
    title: 'Antibacterial and antioxidant activity of Nigella sativa seed extract against Staphylococcus aureus',
    abstract: 'Nigella sativa seed extracts were tested against Staphylococcus aureus and for antioxidant activity by DPPH assay.',
    authors: [{ given: 'Muhammad', family: 'Khan' }, { given: 'Sara', family: 'Mozafari' }]
  };
  const results = [
    // by DOI, the journal name missing; written "Khan M et al." - the dataset has the full list
    ref(1, 'Antibacterial activity of Nigella sativa extract', { doi: 'https://doi.org/10.36721/PJPS.2016.29.4.REG.1201-1206.1', authors: [{ given: 'B', family: 'Ahmed' }] }),
    // by title and year, a garbled journal name; authors written as other people, the dataset names the manuscript authors
    ref(2, 'Antioxidant potential of black seed oil measured by the DPPH radical scavenging assay', { year: 2025, journal: 'Pak J Pharm' }),
    // the same title words but another year: not this PJPS article
    ref(3, 'Formulation and evaluation of floating tablets of famotidine using natural polymers', { year: 2019, journal: 'Int J Pharm' }),
    // named as PJPS but not in the dataset: counted by the journal name
    ref(4, 'Some other paper on seed oils in Pakistan', { year: 2010, journal: 'Pakistan Journal of Pharmaceutical Sciences' }),
    // Article in Press, by title
    ref(5, 'Thymoquinone loaded nanoparticles for wound infections caused by resistant bacteria', { year: 2026 }),
    ref(6, 'An unrelated reference about cardiology outcomes in adults', { year: 2018, journal: 'Heart' })
  ];
  await markPjpsArticles(results);
  assert.strictEqual(results[0].pjps?.articleId, 101); assert.strictEqual(results[0].pjps.by, 'DOI');
  ok('a PJPS article is found by its DOI without a journal name');
  assert.strictEqual(results[1].pjps?.articleId, 102); assert.strictEqual(results[1].pjps.by, 'title');
  ok('a PJPS article is found by its title and year with a garbled journal name');
  assert.strictEqual(results[2].pjps, undefined);
  ok('the same title in another year is not taken for the PJPS article');
  assert.strictEqual(results[4].pjps?.inPress, true);
  assert.strictEqual(results[5].pjps, undefined);

  const p = analyzeCitationPattern(meta, results);
  const rows = p.homeJournal.refs;
  assert.deepStrictEqual(rows.map(h => h.index), [1, 2, 4, 5]);
  ok('the dataset matches and the PJPS-named reference are all counted as PJPS citations');
  assert.ok(rows.find(h => h.index === 1).self, 'self-citation from the dataset author list');
  assert.ok(rows.find(h => h.index === 2).self);
  assert.ok(p.selfCitation.refs.some(s => s.index === 1) && p.selfCitation.refs.some(s => s.index === 2));
  ok('self-citations hidden behind "et al." are found from the PJPS author list');
  assert.strictEqual(rows.find(h => h.index === 4).inDataset, false);
  assert.strictEqual(rows.find(h => h.index === 4).matchedBy, 'journal name');
  assert.strictEqual(rows.find(h => h.index === 5).where, 'Article in Press');
  assert.strictEqual(rows.find(h => h.index === 1).where, 'Vol. 29, No. 4, pp. 1201-1206');
  assert.strictEqual(rows.find(h => h.index === 1).year, 2016);
  const year = new Date().getFullYear();
  assert.strictEqual(p.summary.homeJournalRecent, rows.filter(h => h.year >= year - 2).length);
  assert.strictEqual(p.summary.homeJournalOlder, rows.length - p.summary.homeJournalRecent);
  assert.strictEqual(p.summary.homeJournalSelf, 2);
  assert.strictEqual(p.summary.homeJournalInDataset, 3);
  ok('each PJPS citation has its year, issue, age group and source');
  assert.ok(p.flags.some(f => f.code === 'pjps-self-citation'));
  ok('two or more self-citations of PJPS articles are flagged');

  // without the dataset nothing is marked and nothing breaks
  served = [];
  const fresh = [ref(1, 'Antibacterial activity of Nigella sativa extract', { doi: '10.36721/PJPS.2016.29.4.REG.1201-1206.1' })];
  await markPjpsArticles(fresh); // cache still holds the first read: still found
  assert.strictEqual(fresh[0].pjps?.articleId, 101);
  ok('the dataset is read once and kept');
  console.log('pjps-citations: all passed');
})().catch(e => { console.error(e); process.exit(1); });
