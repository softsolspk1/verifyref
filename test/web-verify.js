// test/web-verify.js - Module 1's web search for references no scholarly database holds, without SerpApi: the similarity
// report's web search (Brave Search, replayed in its documented format) looks up the exact title.
//   - a report found on the web: verified, the page linked
//   - a journal article whose page shows the exact title and the first author: verified (journal not covered by the databases)
//   - a journal article found by title only (author not on the page): unverified, never suspicious
//   - unrelated pages: not taken as a match
//   - Google Scholar (read directly, replayed as its results page) lists the article with a [PDF] link: the PDF is read
//     for the title and first author: verified
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
const ARTICLE5 = 'Formulation of zyxomirol mucoadhesive buccal films using sodium alginate and their evaluation';
const ARTICLE4 = 'Zyxomirol loaded chitosan nanoparticles improve oral bioavailability in albino rabbits';
const ARTICLE3 = 'Effervescent floating tablets of zyxomirol using gastro retentive polymers and their in vitro evaluation';
const brave = {
  [REPORT]: [{ url: 'https://health.example.gov.pk/reports/zyxomira-survey.pdf', title: `${REPORT} | Provincial Health Department`, description: 'Survey of 120 community pharmacies' }],
  [ARTICLE]: [{ url: 'https://wjbps.example.com/article/view/88', title: ARTICLE, description: 'Memon A, Shah B. World Journal of Example Sciences 2022; 9: 44-51' }],
  [ARTICLE2]: [{ url: 'https://wjbps.example.com/article/view/89', title: ARTICLE2, description: 'Abstract: nephroprotective activity was studied' }],
  // a repository copy whose result title is a file name: the page itself is read
  [ARTICLE3]: [{ url: 'https://repo.example.edu/files/ejmcm-2020-7-1234.htm', title: 'ejmcm-2020-7-1234', description: '' }]
};
const pages = {
  'https://repo.example.edu/files/ejmcm-2020-7-1234.htm': `<html><head><title>ejmcm-2020-7-1234</title></head><body><h1>${ARTICLE3.toUpperCase()}</h1><p>Vallabhaneni MKP, Meka VS. European Journal of Molecular and Clinical Medicine 7 (2020)</p></body></html>`
};
// a two-page PDF with the article's title and authors on its first page
const pdfOf = (lines) => new Promise(resolve => {
  const PDFDocument = require('pdfkit');
  const doc = new PDFDocument();
  const parts = [];
  doc.on('data', c => parts.push(c)).on('end', () => resolve(Buffer.concat(parts)));
  for (const l of lines) doc.text(l);
  doc.addPage().text('Results and discussion');
  doc.end();
});
let pdf4 = null, pdf5 = null;
const pageBuffers = {};
const scholarHtml = q => q.includes('mucoadhesive') ? '<html><head><title>Verifying...</title></head><body></body></html>' : !q.includes('Zyxomirol loaded chitosan') ? '<div id="gs_res_ccl">Your search did not match any articles.</div>'
  : `<div id="gs_res_ccl"><div class="gs_r gs_or gs_scl" data-cid="abc123" data-did="abc123"><div class="gs_ggs gs_fl"><div class="gs_ggsd"><div class="gs_or_ggsm"><a href="https://ijps.example.org/files/2021-14-3-55.pdf" data-clk="x"><span class="gs_ctg2">[PDF]</span> example.org</a></div></div></div><div class="gs_ri"><h3 class="gs_rt"><a id="abc123" href="https://ijps.example.org/article/55">${ARTICLE4.replace('chitosan', '<b>chitosan</b>')}</a></h3><div class="gs_a">S Qureshi, A Baloch&nbsp;- Example Journal of Pharmaceutical Sc…, 2021 - example.org</div><div class="gs_rs">Abstract …</div></div></div></div>`;
const scholarCalls = [];
let unrelated = false;
const calls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.search.brave.com/')) {
    const q = new URL(u).searchParams.get('q').replace(/^"|"$/g, '').replace(/" filetype:pdf$/, ' filetype:pdf');
    calls.push(q);
    const results = unrelated ? [{ url: 'https://example.org/x', title: 'Community pharmacy services in Pakistan: a review', description: '' }] : brave[q] || [];
    return new Response(JSON.stringify({ web: { results } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.startsWith('https://scholar.google.com/')) {
    const q = new URL(u).searchParams.get('q');
    scholarCalls.push(q);
    return new Response(scholarHtml(q), { status: 200, headers: { 'content-type': 'text/html' } });
  }
  if (u === 'https://ajp.example.edu/pdf/v9-2-101.pdf') return new Response(pdf5, { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (u === 'https://ijps.example.org/files/2021-14-3-55.pdf') return new Response(pdf4, { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (u === 'https://ijps.example.org/article/55') return new Response('<html><title>Article 55</title><body>Access denied</body></html>', { status: 200 });
  if (pageBuffers[u]) return new Response(pageBuffers[u], { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (pages[u]) return new Response(pages[u], { status: 200, headers: { 'content-type': 'text/html' } });
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

  const art3 = await check({ index: 5, raw: `Vallabhaneni, M.K.P., Meka, V.S., ${ARTICLE3}. European Journal of Molecular & Clinical Medicine 7, 2020.`, title: ARTICLE3, authors: [{ family: 'Vallabhaneni', given: 'MKP' }, { family: 'Meka', given: 'VS' }], journal: 'European Journal of Molecular & Clinical Medicine', year: 2020, volume: '7' });
  assert.strictEqual(art3.status, 'verified', `article whose page holds the title and first author verified (got ${art3.status}: ${art3.reason})`);
  console.log('  ✓ result with another title: the page is read, title and first author found: verified');

  pdf4 = await pdfOf(['Example Journal of Pharmaceutical Sciences 14(3): 55-62, 2021', 'Zyxomirol loaded chitosan nano-', 'particles improve oral bioavailability in albino rabbits', 'Sana Qureshi, Ali Baloch']);
  const art4 = await check({ index: 6, raw: `Qureshi S, Baloch A. ${ARTICLE4}. Example Journal of Pharmaceutical Sciences 2021;14(3):55-62.`, title: ARTICLE4, authors: [{ family: 'Qureshi', given: 'S' }, { family: 'Baloch', given: 'A' }], journal: 'Example Journal of Pharmaceutical Sciences', year: 2021, volume: '14', issue: '3', pages: '55-62' });
  assert.ok(scholarCalls.some(q => q.includes(ARTICLE4)), 'Google Scholar asked');
  assert.strictEqual(art4.status, 'verified', `article listed by Google Scholar with a PDF holding the title and first author verified (got ${art4.status}: ${art4.reason})`);
  assert.ok(art4.checked['Google Scholar'] === 'found', 'found in Google Scholar');
  console.log('  ✓ article only in Google Scholar: verified');
  const S = require('../src/sources');
  const seen = await S.pageConfirm({ title: ARTICLE4, authors: [{ family: 'Qureshi' }] }, ['https://ijps.example.org/article/55', 'https://ijps.example.org/files/2021-14-3-55.pdf']);
  assert.ok(seen[0]?.kind === 'PDF' && seen[0].author && seen[0].sim >= 0.95, 'the PDF is read: title (hyphenated over two lines) and first author found');
  console.log('  ✓ Google Scholar [PDF] link read: title and first author found in the PDF');

  const { parseScholarHtml } = require('../src/sources');
  const parsed = parseScholarHtml(scholarHtml(ARTICLE4));
  assert.strictEqual(parsed[0].title, ARTICLE4);
  assert.strictEqual(parsed[0].resources[0].link, 'https://ijps.example.org/files/2021-14-3-55.pdf');
  assert.ok(/Qureshi/.test(parsed[0].publication_info.summary));
  console.log('  ✓ Google Scholar results page parsed (title, [PDF] link, authors)');

  // Google Scholar answers with its bot check: left out quietly; the web search finds the PDF copy and reads it
  brave[`${ARTICLE5} filetype:pdf`] = [{ url: 'https://ajp.example.edu/pdf/v9-2-101.pdf', title: 'v9-2-101.pdf', description: '' }];
  pdf5 = await pdfOf(['Asian Example Journal of Pharmacy 9(2), 2019', ARTICLE5.toUpperCase(), 'Hina Soomro*, Kamran Ali']);
  const art5 = await check({ index: 7, raw: `Soomro H, Ali K. ${ARTICLE5}. Asian Example Journal of Pharmacy 2019;9(2):101-9.`, title: ARTICLE5, authors: [{ family: 'Soomro', given: 'H' }, { family: 'Ali', given: 'K' }], journal: 'Asian Example Journal of Pharmacy', year: 2019, volume: '9', issue: '2', pages: '101-9' });
  assert.ok(!art5.checked['Google Scholar'], 'Google Scholar bot check: not counted as a database or an error');
  assert.ok(calls.includes(`${ARTICLE5} filetype:pdf`), 'PDF copy searched for');
  assert.strictEqual(art5.status, 'verified', `article whose PDF copy holds the title and first author verified (got ${art5.status}: ${art5.reason})`);
  assert.ok(/PDF/.test(art5.reason), art5.reason);
  console.log('  ✓ Google Scholar bot check skipped quietly; PDF copy found by web search and read: verified');

  // a whole issue's PDF (result title "volume 9, january issue 1"): the article is on a later page, cited with a curly
  // apostrophe; other authors are named on the first pages
  const ARTICLE6 = 'Zyxomirol controlled release tablet using an optimization approach for Alzheimer’s disease';
  const issueUrl = 'https://archive.example.org/uploads/journals/wjx/volume-9-issue-1.pdf';
  brave[ARTICLE6.replace('’', "'").toUpperCase()] = [{ url: issueUrl, title: 'volume 9, january issue 1 13652', description: '' }];
  const issue = await pdfOf(['World Journal of Example Research, volume 9, issue 1', 'Contents', 'Patel R. Another paper on tablets']);
  const issueDoc = await new Promise(resolve => {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument(); const parts = [];
    doc.on('data', c => parts.push(c)).on('end', () => resolve(Buffer.concat(parts)));
    doc.text('World Journal of Example Research, volume 9, issue 1').text('Patel R. Another paper on tablets');
    for (let p = 0; p < 6; p++) doc.addPage().text(`Article ${p}: stability of something else. Khan A, Shah B.`);
    doc.addPage().text("ZYXOMIROL CONTROLLED RELEASE TABLET USING AN OPTIMIZATION APPROACH FOR ALZHEIMER'S DISEASE").text('Pankaj Kumar Patel*, Divya Barua and Anu Hardenia');
    doc.end();
  });
  pageBuffers[issueUrl] = issueDoc;
  const art6 = await check({ index: 8, raw: `Patel, P.K., Barua, D., Hardenia, A., 2019. ${ARTICLE6.toUpperCase()}.`, title: ARTICLE6.toUpperCase(), authors: [{ family: 'Patel', given: 'P.K.' }, { family: 'Barua', given: 'D.' }], year: 2019 });
  assert.ok(calls.includes(ARTICLE6.replace('’', "'").toUpperCase()) || calls.some(c => c.includes("ALZHEIMER'S")), 'curly apostrophe searched as a plain one');
  assert.strictEqual(art6.status, 'verified', `article on page 8 of an issue PDF verified (got ${art6.status}: ${art6.reason})`);
  assert.ok(issue.length > 0);
  console.log('  ✓ whole-issue PDF read past the first pages; curly apostrophe searched as plain: verified');

  // a WHO Technical Report Series guideline found on who.int: a report, not a journal article
  const WHO = 'Stability testing of zyxomirol active pharmaceutical ingredients and finished pharmaceutical products';
  brave[WHO] = [{ url: 'https://www.who.int/publications/m/item/trs1010-annex10', title: `TRS 1010 - Annex 10: WHO guidelines on ${WHO.toLowerCase()}`, description: 'regulatory guidelines' }];
  const who = await check({ index: 9, raw: `WECoSfP, P., 2018. ${WHO}. WHO Technical Report Series 1010.`, title: WHO, authors: [{ family: 'WECoSfP', given: 'P.' }], journal: 'WHO Technical Report Series', year: 2018, volume: '1010' });
  assert.strictEqual(who.status, 'verified', `WHO report found on who.int verified (got ${who.status}: ${who.reason})`);
  console.log('  ✓ WHO Technical Report Series found on who.int: verified');

  // the exact-phrase and PDF searches find nothing; the words with the first author find the article's PDF
  const ARTICLE7 = 'Zyxomirol sustained release matrix tablets using optimization approach for Parkinson';
  const looseUrl = 'https://archive.example.org/uploads/journals/wjx/article-1339.pdf';
  brave[`${ARTICLE7} Zyxpatelia`] = [{ url: looseUrl, title: 'volume 9, january issue 1 13653', description: '' }];
  pageBuffers[looseUrl] = await pdfOf(['World Journal of Example Research 1339', `${ARTICLE7.toUpperCase()}'S DISEASE`, 'Pankaj Kumar Zyxpatelia*, Divya Barua']);
  const art7 = await check({ index: 10, raw: `Zyxpatelia, P.K., Barua, D., 2019. ${ARTICLE7}.`, title: ARTICLE7, authors: [{ family: 'Zyxpatelia', given: 'P.K.' }], year: 2019 });
  assert.ok(calls.includes(`${ARTICLE7} Zyxpatelia`), 'looser search asked');
  assert.strictEqual(art7.status, 'verified', `found by the looser search, PDF read (got ${art7.status}: ${art7.reason} ${JSON.stringify(art7.record && [art7.record.title, art7.record.source, art7.record.year])})`);
  console.log('  ✓ exact phrase finds nothing: the title words with the first author find the PDF: verified');

  unrelated = true;
  const none = await check({ index: 4, raw: 'Raza K (2020). Pharmacovigilance awareness among Zyxomira hospital nurses. Larkana.', title: 'Pharmacovigilance awareness among Zyxomira hospital nurses', authors: [{ family: 'Raza', given: 'K' }], year: 2020 });
  assert.ok(!none.web?.length && none.checked['Web search'] === 'not-found' && none.status !== 'verified', 'unrelated pages ignored');
  console.log('  ✓ unrelated pages ignored');
  assert.ok(calls.length >= 4, 'web search asked for every unverified reference');
  console.log('web verify test passed');
  await db.close?.();
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
