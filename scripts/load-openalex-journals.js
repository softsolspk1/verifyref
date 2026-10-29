#!/usr/bin/env node
// scripts/load-openalex-journals.js - first, full download of the OpenAlex journal list (~220,000 journals, about 10
// minutes) into the database named in .env. The platform keeps it fresh afterwards (monthly, a few minutes per daily
// cron run), which on its own would take days for the first download. Needs OPENALEX_API_KEY. Stopping it is safe:
// the next run continues where it stopped.
//
//   npm run datasets:openalex
const db = require('../src/db');
const D = require('../src/datasets');

(async () => {
  await db.init();
  const started = Date.now();
  const timer = setInterval(async () => {
    const n = (await db.one('SELECT COUNT(*)::int AS n FROM openalex_journals_stage').catch(() => ({ n: '?' }))).n;
    console.log(`  ${Number(n).toLocaleString()} journals downloaded (${Math.round((Date.now() - started) / 1000)} s)`);
  }, 30000);
  const count = await D.loadOpenAlexJournals();
  clearInterval(timer);
  console.log(`OpenAlex journal list loaded: ${Number(count).toLocaleString()} journals in ${Math.round((Date.now() - started) / 60000)} min`);
  const sample = await D.openalexJournal({ issns: ['1011-601X'] });
  if (sample) console.log(`Sample lookup (ISSN 1011-601X): ${sample.display_name} - ${sample.works_count} works, h-index ${sample.summary_stats.h_index}`);
  await db.close();
  process.exit(0);
})().catch(e => { console.error('OpenAlex journal list download failed:', e.message); process.exit(1); });
