#!/usr/bin/env node
// scripts/benchmark-novelty.js - the novelty assessment measured on real published papers (Europe PMC and OpenAlex, live).
// For each paper (research articles with an abstract and an indexed reference list, Europe PMC, journals below):
//   related  - its title, abstract and keywords go in as a manuscript; the works the paper itself cites are the ground
//              truth of closely related prior work: how many of them are among the 10 closest works reported
//   copy     - the same abstract under a shortened title (a duplicate submission of a published paper): the published
//              paper must be the closest work and novelty rated low
//
//   node scripts/benchmark-novelty.js [--n 20] [--seed 1] [--json out.json] [--module ../src/checks/other-novelty]
process.env.PGLITE_DIR = process.env.PGLITE_DIR || 'memory://';
delete process.env.DATABASE_URL;
const fs = require('fs');
const db = require('../src/db');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const { checkNovelty } = require(opt('module', '../src/checks/novelty')); // --module: another version, to compare
const N = parseInt(opt('n', '20'), 10);
const SEED = parseInt(opt('seed', '1'), 10);
// open pharmacy and pharmacology journals in Europe PMC whose reference lists are indexed
const ISSNS = ['1424-8247', '1999-4923', '1663-9812', '1319-0164', '1420-3049'];
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const { getJson } = require('../src/http');
const { titleSimilarity } = require('../src/text');
const strip = t => String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const shortTitle = t => { const w = String(t).split(/\s+/); return w.slice(0, Math.max(5, Math.ceil(w.length * 0.6))).join(' '); };

async function sample() {
  const per = Math.ceil(N / ISSNS.length), out = [];
  for (const issn of ISSNS) {
    const q = `ISSN:"${issn}" AND PUB_YEAR:${2022 + (SEED % 3)} AND HAS_ABSTRACT:y AND HAS_REFLIST:y AND PUB_TYPE:"research-article"`;
    const r = await getJson(`${EPMC}/search?format=json&resultType=core&pageSize=${per * 3}&query=${encodeURIComponent(q)}`, { ttl: 30 * 86400, timeout: 30000, retries: 2 });
    // every third paper of the page, so one journal issue does not dominate
    out.push(...(r.ok ? r.data.resultList?.result || [] : []).filter((x, i) => i % 3 === SEED % 3 && x.pmid).slice(0, per));
  }
  return out.slice(0, N);
}

/** Titles of the works a paper cites (Europe PMC reference list) */
async function citedTitles(pmid) {
  const r = await getJson(`${EPMC}/MED/${pmid}/references?format=json&pageSize=500`, { ttl: 30 * 86400, timeout: 30000, retries: 2 });
  return (r.ok ? r.data.referenceList?.reference || [] : []).map(x => strip(x.title)).filter(t => t.length > 20);
}

(async () => {
  await db.init();
  const papers = await sample();
  console.log(`Novelty benchmark: ${papers.length} published papers (seed ${SEED})`);
  const rows = [];
  const t0 = Date.now();
  for (const [k, w] of papers.entries()) {
    const title = strip(w.title).replace(/\.$/, ''), abstract = strip(w.abstractText);
    const keywords = (w.keywordList?.keyword || []).slice(0, 5);
    const cited = await citedTitles(w.pmid);
    const isCited = c => cited.some(t => titleSimilarity(t, c.title) >= 0.9);
    const A = await checkNovelty({ meta: { title, abstract, keywords, doi: w.doi || null } }).catch(e => ({ error: e.message }));
    const top = A.error ? [] : A.closest.slice(0, 10);
    const hits = top.filter(isCited).length;
    const B = await checkNovelty({ meta: { title: shortTitle(title), abstract, keywords } }).catch(e => ({ error: e.message }));
    const copyFirst = !B.error && !!B.closest[0] && (titleSimilarity(B.closest[0].title, title) >= 0.9 || (!!w.doi && String(B.closest[0].doi || '').toLowerCase() === w.doi.toLowerCase()));
    const row = { title, year: w.pubYear, journal: w.journalInfo?.journal?.title, cited: cited.length, hits, score: A.summary?.score ?? null, band: A.summary?.band ?? null,
      copy: { first: copyFirst, score: B.summary?.score ?? null, band: B.summary?.band ?? null, maxSim: B.summary?.maxSimilarity ?? null, top: B.closest?.[0] ? { words: B.closest[0].words, meaning: B.closest[0].meaning } : null },
      top: (A.closest || []).slice(0, 10).map(c => ({ words: c.words, meaning: c.meaning, cited: isCited(c) })), maxSim: A.summary?.maxSimilarity ?? null, components: A.components || null, error: A.error || B.error || null };
    rows.push(row);
    console.log(`${String(k + 1).padStart(2)}. cited in top 10: ${hits}/10 (of ${cited.length} cited) | novelty ${row.score} ${row.band} | copy: ${copyFirst ? 'found first' : 'NOT first'}, ${row.copy.score} ${row.copy.band} | ${title.slice(0, 60)}${row.error ? ` | ERROR ${row.error}` : ''}`);
  }
  const ok = rows.filter(r => !r.error);
  const mean = f => ok.length ? Math.round(ok.reduce((a, r) => a + f(r), 0) / ok.length * 100) / 100 : null;
  const out = {
    papers: rows.length, errors: rows.length - ok.length, minutes: Math.round((Date.now() - t0) / 6000) / 10,
    citedInTop10: mean(r => r.hits), papersWithCitedInTop10: `${ok.filter(r => r.hits > 0).length}/${ok.length}`,
    copyFoundFirst: `${ok.filter(r => r.copy.first).length}/${ok.length}`, copyRatedLow: `${ok.filter(r => r.copy.band === 'low').length}/${ok.length}`,
    publishedBands: Object.fromEntries(['low', 'moderate', 'high'].map(b => [b, ok.filter(r => r.band === b).length])), rows
  };
  console.log(`\nCited works among the 10 closest: ${out.citedInTop10} per paper; papers with at least one: ${out.papersWithCitedInTop10}`);
  console.log(`Duplicate of a published paper: found as the closest work ${out.copyFoundFirst}, rated low novelty ${out.copyRatedLow}`);
  console.log(`Bands of the published papers themselves: ${JSON.stringify(out.publishedBands)}`);
  if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(out, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
