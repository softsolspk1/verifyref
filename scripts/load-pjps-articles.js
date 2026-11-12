#!/usr/bin/env node
// load-pjps-articles.js - the PJPS dataset: every article published on pjps.pk (2007 onwards, Article in Press included)
// into pjps_articles, with its full text in the PJPS text repository (Admin > Datasets > PJPS)
//   [--limit N] [--concurrency 4]   load the next N articles (default: all up to the latest on pjps.pk)
//   [--round 400]                   articles per round (the full texts' fingerprints move to R2 after each)
//   [--from ID] [--to ID]           a range of article ids (default: from where the last run stopped)
//   --restart                       start again from article 1 (articles already loaded with their text are skipped)
//   --force                         load again articles already in the dataset
//   --status                        what the dataset holds
// Continues where it stopped, so an interrupted run can simply be started again.
const db = require('../src/db');
const REFS = require('../src/imageRefs');

const argv = process.argv.slice(2);
const opt = (name, d = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : d);
const int = (name, d) => (opt(name) ? parseInt(opt(name), 10) : d);
let last = 0;
const log = step => { if (Date.now() - last > 2000) { last = Date.now(); console.log(`${new Date().toISOString().slice(11, 19)} ${step}`); } };

(async () => {
  await db.init();
  let out;
  if (argv.includes('--status')) {
    out = await db.one(`SELECT COUNT(*)::int AS articles, COUNT(*) FILTER (WHERE text_from = 'pdf')::int AS full_texts, COUNT(*) FILTER (WHERE text_from = 'abstract')::int AS abstracts_only,
      COUNT(*) FILTER (WHERE words IS NULL)::int AS no_text, COUNT(*) FILTER (WHERE in_press)::int AS in_press, MIN(article_id) AS first_id, MAX(article_id) AS last_id, MAX(loaded_at) AS updated FROM pjps_articles`);
    out.next = await db.getMeta('pjpsa_next');
  } else {
    if (argv.includes('--restart')) await db.setMeta('pjpsa_next', '1');
    console.log(`=== PJPS articles ${new Date().toISOString()}`);
    // rounds of --round articles; after each, the texts' fingerprints move from the database to the index on R2
    // (corpus.compactIndex, as the daily cron does), so ~1,000 rows per article never pile up in the database
    const corpus = require('../src/corpus');
    const range = { from: int('from', null), to: int('to', null), concurrency: int('concurrency', 4), force: argv.includes('--force') };
    let left = int('limit', Infinity);
    out = { rounds: [] };
    for (;;) {
      const r = await REFS.loadPjpsArticles({ ...range, limit: Math.min(left, int('round', 400)) }, log);
      left -= r.queued;
      const moved = await corpus.compactIndex({ log: console.log }).catch(e => ({ error: e.message }));
      console.log(`round: ${r.articles} articles (${r.fullTexts} full texts, ${r.abstracts} abstracts only, ${r.missing} ids without an article, ${r.errors.length} errors); ${r.total} in the dataset; index ${JSON.stringify(moved)}`);
      if (r.errors.length) console.log(r.errors.join('\n'));
      out.rounds.push({ articles: r.articles, fullTexts: r.fullTexts, errors: r.errors.length });
      out.total = r.total;
      if (r.done || !r.queued || left <= 0 || r.stoppedEarly) break;
      if (range.from) range.from = r.last + 1;   // a given range continues after this round's last id
    }
  }
  console.log(JSON.stringify(out, null, 2));
  await db.close?.();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
