// test/web-verify.js - Module 1's web search for references no scholarly database holds, without SerpApi: the similarity
// report's web search (Brave Search, replayed in its documented format) looks up the exact title.
//   - a report found on the web: verified, the page linked
//   - a journal article whose page shows the exact title and the first author: verified (journal not covered by the databases)
//   - a journal article found by title only (author not on the page): unverified, never suspicious
//   - unrelated pages: not taken as a match
// The free databases are queried live. Run: node test/web-verify.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'web-verify-'));
process.env.SERPAPI_KEY = '';
process.env.BRAVE_API_KEY = 'test-key';
const db = require('../src/db');
const { checkReferences } = require('../src/checks/reference');
const check = async ref => (await checkReferences([ref], { checkLinks: false })).results[0];

const REPORT = 'Zyxomira district drug utilisation survey of community pharmacies in Larkana division';
const ARTICLE = 'Qwertiana plumbago leaf extract lowers serum creatinine in gentamicin treated Wistar rats';
const ARTICLE2 = 'Qwertiana plumbago root extract protects against cisplatin nephrotoxicity in Wistar rats';
const brave = {
  [REPORT]: [{ url: 'https://health.example.gov.pk/reports/zyxomira-survey.pdf', title: `${REPORT} | Provincial Health Department`, description: 'Survey of 120 community pharmacies' }],
  [ARTICLE]: [{ url: 'https://wjbps.example.com/article/view/88', title: ARTICLE, description: 'Memon A, Shah B. World Journal of Example Sciences 2022; 9: 44-51' }],
  [ARTICLE2]: [{ url: 'https://wjbps.example.com/article/view/89', title: ARTICLE2, description: 'Abstract: nephroprotective activity was studied' }]
};
let unrelated = false;
const calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.search.brave.com/')) {
    const q = new URL(u).searchParams.get('q').replace(/^"|"$/g, '');
    calls.push(q);
    const results = unrelated ? [{ url: 'https://example.org/x', title: 'Community pharmacy services in Pakistan: a review', description: '' }] : brave[q] || [];
    return new Response(JSON.stringify({ web: { results } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

(async () => {
  await db.init();
  const report = await check({ index: 1, raw: `Provincial Health Department (2021). ${REPORT}. Larkana.`, title: REPORT, authors: [], year: 2021 });
  assert.strictEqual(report.status, 'verified', `report verified on the web (got ${report.status}: ${report.reason})`);
  assert.ok(report.checked['Web search'] === 'found' && report.web?.[0]?.host === 'health.example.gov.pk', 'web search recorded, page linked');
  console.log('  ✓ report found on the web: verified, page linked');

  const art = await check({ index: 2, raw: `Memon A, Shah B (2022). ${ARTICLE}. World Journal of Example Sciences, 9: 44-51.`, title: ARTICLE, authors: [{ family: 'Memon', given: 'A' }, { family: 'Shah', given: 'B' }], journal: 'World Journal of Example Sciences', year: 2022, volume: '9', pages: '44-51' });
  assert.strictEqual(art.status, 'verified', `article with title and first author on its page verified (got ${art.status}: ${art.reason})`);
  assert.ok(/first author match/.test(art.reason), 'reason says what matched');
  console.log('  ✓ journal article with exact title and first author on the web: verified');

  const art2 = await check({ index: 3, raw: `Memon A, Shah B (2022). ${ARTICLE2}. World Journal of Example Sciences, 9: 52-60.`, title: ARTICLE2, authors: [{ family: 'Memon', given: 'A' }, { family: 'Shah', given: 'B' }], journal: 'World Journal of Example Sciences', year: 2022, volume: '9', pages: '52-60' });
  assert.strictEqual(art2.status, 'unverified', `article found by title only stays unverified (got ${art2.status})`);
  assert.ok(/not a sign of fabrication/.test(art2.reason), 'reason says it exists on the web');
  console.log('  ✓ journal article found by title only: unverified, not suspicious');

  unrelated = true;
  const none = await check({ index: 4, raw: 'Raza K (2020). Pharmacovigilance awareness among Zyxomira hospital nurses. Larkana.', title: 'Pharmacovigilance awareness among Zyxomira hospital nurses', authors: [{ family: 'Raza', given: 'K' }], year: 2020 });
  assert.ok(!none.web?.length && none.checked['Web search'] === 'not-found' && none.status !== 'verified', 'unrelated pages ignored');
  console.log('  ✓ unrelated pages ignored');
  assert.ok(calls.length >= 4, 'web search asked for every unverified reference');
  console.log('web verify test passed');
  await db.close?.();
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
