#!/usr/bin/env node
// index-image-refs.js - build the Module 5 image reference databases (npm run images:index -- <options>)
//   --source pjps [--from 1] [--to 8100] [--limit 500] [--concurrency 3] [--force]
//        published PJPS papers from pjps.pk (default: articles newer than the newest indexed one)
//   --source retracted [--limit 500] [--force]
//        open-access papers retracted / corrected for image problems (needs data/public-images/retracted_image_cases.json)
//   --source pmc [--limit 500] [--restart]
//        open-access PubMed Central papers in pharmacy / pharmacology / medicinal plants (continues where it stopped)
//   --file <path> [--file <path>] --title "..." [--doi ...] [--note ...]
//        reference figures from local PDF / Word / PNG / JPEG files
//   --status   what the databases hold
// Already indexed papers are skipped, so an interrupted run can simply be started again.
const fs = require('fs');
const path = require('path');
const REFS = require('../src/imageRefs');
const db = require('../src/db');

const argv = process.argv.slice(2);
const opt = (name, d = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : d);
const all = name => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
const int = (name, d) => (opt(name) ? parseInt(opt(name), 10) : d);
let last = 0;
const log = (step) => { if (Date.now() - last > 1000) { last = Date.now(); console.log(step); } };

(async () => {
  let out;
  if (argv.includes('--status')) out = await REFS.status();
  else if (all('file').length) {
    const files = all('file').map(f => ({ name: path.basename(f), buffer: fs.readFileSync(f) }));
    out = await REFS.indexUpload(files, { title: opt('title'), doi: opt('doi'), journal: opt('journal'), year: opt('year'), note: opt('note'), url: opt('url') });
  } else if (opt('source') === 'pjps') {
    out = await REFS.indexPjps({ from: int('from', null), to: int('to', null), limit: int('limit', 500), concurrency: int('concurrency', 3), force: argv.includes('--force') }, log);
  } else if (opt('source') === 'retracted') {
    out = await REFS.indexRetracted({ limit: int('limit', 500), concurrency: int('concurrency', 3), force: argv.includes('--force') }, log);
  } else if (opt('source') === 'pmc') {
    out = await REFS.indexPmc({ limit: int('limit', 500), concurrency: int('concurrency', 3), restart: argv.includes('--restart') }, log);
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 11).join('\n').replace(/^\/\/ ?/gm, ''));
    return db.close();
  }
  console.log(JSON.stringify(out, null, 2));
  await db.close();
})().catch(async e => { console.error(e); await db.close().catch(() => {}); process.exit(1); });
