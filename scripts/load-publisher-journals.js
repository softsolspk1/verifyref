#!/usr/bin/env node
// scripts/load-publisher-journals.js - download the journal lists of the major publishers (Elsevier, Springer Nature,
// Wiley, Taylor & Francis, SAGE, MDPI, OUP, CUP, Wolters Kluwer Health, ACS, IEEE; about 21,000 journals, 2 minutes)
// into the database named in .env. The daily cron refreshes it monthly afterwards.
//
//   npm run datasets:publishers
const db = require('../src/db');
const D = require('../src/datasets');

(async () => {
  await db.init();
  const started = Date.now();
  const count = await D.loadPublisherJournals();
  console.log(`Publisher journal lists loaded: ${Number(count).toLocaleString()} journals in ${Math.round((Date.now() - started) / 1000)} s`);
  const sample = await D.publisherJournal({ name: 'International Journal of Pharmaceutics' });
  if (sample) console.log(`Sample lookup: ${sample.title} - ${sample.publisher} (${sample.imprint})`);
  await db.close();
  process.exit(0);
})().catch(e => { console.error('Publisher journal list download failed:', e.message); process.exit(1); });
