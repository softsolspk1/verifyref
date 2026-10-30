// test/auto-search.js - the automatic searches that replace the manual links on unverified references:
//   - PubMed citation matcher (ECitMatch, live): a paper found from journal, year, volume and page although its title is misspelled
//   - Google web search (SerpApi engine "google", replayed in SerpApi's documented format): a report found only on the web is
//     verified; a journal article found only on the web is unverified, never "suspicious"; unrelated pages are ignored
// The free databases are queried live. Run: node test/auto-search.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-search-'));
process.env.SERPAPI_KEY = 'test-key';
const db = require('../src/db');
const S = require('../src/sources');
const { checkReferences } = require('../src/checks/reference');
const check = async ref => (await checkReferences([ref], { checkLinks: false })).results[0];

const REPORT = 'Zyxomira district drug utilisation survey of community pharmacies in Larkana division';
const ARTICLE = 'Qwertiana plumbago leaf extract lowers serum creatinine in gentamicin treated Wistar rats';
const google = {
  [REPORT]: [{ title: `${REPORT} | Provincial Health Department`, link: 'https://health.example.gov.pk/reports/zyxomira-survey.pdf', snippet: 'Survey of 120 community pharmacies…' }],
  [ARTICLE]: [{ title: `${ARTICLE.slice(0, 60)}...`, link: 'https://journal.example.edu.pk/article/view/88', snippet: 'Wistar rats were given…' }],
  unrelated: [{ title: 'Community pharmacy services in Pakistan: a review', link: 'https://example.org/x', snippet: '' }]
};
let unrelated = false;
const serpCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://serpapi.com/')) {
    const params = new URL(u).searchParams;
    serpCalls.push(params.get('engine'));
    const title = params.get('q').replace(/^"|"$/g, '').replace(/"\s*author:.*$/, '');
    const organic = params.get('engine') === 'google' ? (unrelated ? google.unrelated : google[title] || []) : [];
    return new Response(JSON.stringify({ search_metadata: { status: 'Success' }, organic_results: organic }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

(async () => {
  await db.init();

  // 1. PubMed citation matcher: found from journal / year / volume / page (live NCBI)
  const cm = await S.pubmedCitationMatch({ journal: 'Cell', year: 2011, volume: '144', pages: '646-674', authors: [{ family: 'Hanahan', given: 'D' }] });
  assert.ok(!cm.error, `citation matcher error: ${cm.error}`);
  assert.strictEqual(cm.records[0]?.sourceId || cm.records[0]?.pmid || (cm.records[0]?.url || '').match(/\d+/)?.[0], '21376230', 'Hanahan & Weinberg 2011 found by citation');
  const typo = await check({ index: 1, raw: 'Hanahan D and Weinberg RA (2011). Halmarks of cancr: the nxt generaton. Cell, 144(5): 646-674.', title: 'Halmarks of cancr: the nxt generaton', authors: [{ family: 'Hanahan', given: 'D' }, { family: 'Weinberg', given: 'RA' }], journal: 'Cell', year: 2011, volume: '144', issue: '5', pages: '646-674' });
  assert.notStrictEqual(typo.status, 'suspicious', 'misspelled title of a real paper is not called fabricated');
  assert.ok(typo.record && /hallmarks of cancer/i.test(typo.record.title), `misspelled title still matched to the real paper (got ${typo.record?.title})`);
  console.log(`  ✓ PubMed citation matcher; misspelled title matched (${typo.status})`);

  // 2. a report found only on the web by Google: verified, with the page
  const report = await check({ index: 2, raw: `Provincial Health Department (2021). ${REPORT}. Larkana.`, title: REPORT, authors: [], year: 2021, looksLikeWeb: false, looksLikeBook: false });
  assert.strictEqual(report.status, 'verified', `report verified by Google (got ${report.status}: ${report.reason})`);
  assert.ok(/Google/.test(report.reason) && report.web?.[0]?.host === 'health.example.gov.pk', 'reason and page shown');
  assert.strictEqual(report.confidence, 70);
  assert.strictEqual(report.checked.Google, 'found');
  console.log('  ✓ report found only on the web: verified by Google, page linked');

  // 3. a journal article found only on the web (title shortened by Google): unverified, never suspicious
  const art = await check({ index: 3, raw: `Memon A, Shah B (2022). ${ARTICLE}. J Pharm Res Sindh, 9(2): 44-51.`, title: ARTICLE, authors: [{ family: 'Memon', given: 'A' }, { family: 'Shah', given: 'B' }], journal: 'J Pharm Res Sindh', year: 2022, volume: '9', issue: '2', pages: '44-51' });
  assert.strictEqual(art.status, 'unverified', `journal article found only on the web stays unverified (got ${art.status})`);
  assert.ok(/not a sign of fabrication/.test(art.reason) && art.web?.length === 1, 'reason says it exists on the web');
  console.log('  ✓ journal article found only on the web: unverified, not suspicious');

  // 4. unrelated Google results are not taken as a match
  unrelated = true;
  const none = await check({ index: 4, raw: 'Raza K (2020). Pharmacovigilance awareness among Zyxomira hospital nurses. Larkana.', title: 'Pharmacovigilance awareness among Zyxomira hospital nurses', authors: [{ family: 'Raza', given: 'K' }], year: 2020 });
  assert.ok(!none.web?.length && none.checked.Google === 'not-found', 'unrelated pages ignored');
  assert.notStrictEqual(none.status, 'verified');
  console.log('  ✓ unrelated Google results ignored');
  assert.ok(serpCalls.includes('google') && serpCalls.includes('google_scholar'), 'Google Scholar and Google both searched automatically');

  console.log('auto-search test passed');
  await db.close?.();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
