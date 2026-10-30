// test/google-scholar.js - Google Scholar through SerpApi (last-resort reference source). SerpApi is paid, so its answers are
// replayed from fixtures in SerpApi's documented response format; the 13 free databases are queried live.
//   - publication_info.summary parsing (authors, venue, year, host; "…" shortened lists)
//   - a reference no free database has is verified by a Scholar result
//   - Scholar "[CITATION]" entries (built from other papers' reference lists) never verify a reference
//   - an exhausted / rejected key pauses Google Scholar instead of failing every reference
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.PGLITE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-test-'));
process.env.SERPAPI_KEY = 'test-key';
const db = require('../src/db');
const S = require('../src/sources');
const { checkReferences } = require('../src/checks/reference');
const check = async ref => (await checkReferences([ref], { checkLinks: false })).results[0];

const TITLE_OK = 'Formulation and evaluation of floating matrix tablets of Zyxomira leaf extract for gastric retention';
const TITLE_CIT = 'Antiulcer activity of Qwertiana nigra bark in pylorus ligated albino rats of Sindh';
const fixtures = {
  ok: { search_metadata: { status: 'Success' }, organic_results: [{
    position: 0, title: TITLE_OK, result_id: 'AbC123xyz', link: 'https://jddtonline.info/index.php/jddt/article/view/3312',
    snippet: 'Floating matrix tablets were prepared by wet granulation…',
    publication_info: { summary: 'A Rehman, S Qureshi, MA Khan - Journal of Drug Delivery and Therapeutics, 2019 - jddtonline.info', authors: [{ name: 'A Rehman' }] },
    inline_links: { cited_by: { total: 7 } }
  }] },
  citation: { search_metadata: { status: 'Success' }, organic_results: [{
    position: 0, title: `[CITATION] ${TITLE_CIT}`, result_id: 'ZZZ999',
    publication_info: { summary: 'N Baloch, R Memon - Pak J Pharm Sci, 2018' }
  }] },
  exhausted: { error: 'Your account has run out of searches.' }
};
let mode = 'ok';
let serpCalls = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://serpapi.com/')) {
    serpCalls++;
    const body = fixtures[mode];
    return new Response(JSON.stringify(body), { status: body.error ? 429 : 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, opts);
};

(async () => {
  await db.init();

  // 1. summary parsing
  const p = S.parseScholarSummary('R Rahbari, L Francis, OJ Guy… - Pharmaceutics, 2023 - mdpi.com');
  assert.deepStrictEqual(p.authors.map(a => a.family), ['Rahbari', 'Francis', 'Guy']);
  assert.strictEqual(p.authors[2].given, 'O. J.');
  assert.strictEqual(p.venue, 'Pharmaceutics');
  assert.strictEqual(p.year, 2023);
  assert.strictEqual(p.host, 'mdpi.com');
  assert(p.truncatedAuthors, 'shortened author list not noticed');
  const book = S.fromScholar({ title: '[BOOK] [B] Remington: the science and practice of pharmacy', publication_info: { summary: 'DB Troy, P Beringer - 2006 - books.google.com' } });
  assert.strictEqual(book.type, 'book');
  assert.strictEqual(book.title, 'Remington: the science and practice of pharmacy');
  assert.strictEqual(book.year, 2006);
  const doiRec = S.fromScholar({ title: 'X', link: 'https://www.tandfonline.com/doi/full/10.1080/10717544.2020.1754527?src=abc', publication_info: { summary: 'A B - J, 2020 - tandfonline.com' } });
  assert.strictEqual(doiRec.doi, '10.1080/10717544.2020.1754527');

  // 2. a reference only Google Scholar knows is verified by it
  mode = 'ok';
  const ok = await check({ index: 1, raw: `Rehman A, Qureshi S, Khan MA. ${TITLE_OK}. J Drug Deliv Ther 2019.`, title: TITLE_OK,
    authors: [{ given: 'A', family: 'Rehman' }, { given: 'S', family: 'Qureshi' }, { given: 'MA', family: 'Khan' }], year: 2019, journal: 'J Drug Deliv Ther' });
  assert(serpCalls >= 1, 'Google Scholar was not asked');
  assert.strictEqual(ok.record?.source, 'Google Scholar', `expected a Google Scholar record, got ${ok.record?.source} (${ok.status}: ${ok.reason})`);
  assert(['verified', 'miscited'].includes(ok.status), `Scholar match not accepted: ${ok.status} — ${ok.reason}`);
  assert.strictEqual(ok.checked?.['Google Scholar'], 'found');

  // 3. a "[CITATION]" entry never verifies a reference
  mode = 'citation';
  const cit = await check({ index: 2, raw: `Baloch N, Memon R. ${TITLE_CIT}. Pak J Pharm Sci 2018.`, title: TITLE_CIT,
    authors: [{ given: 'N', family: 'Baloch' }, { given: 'R', family: 'Memon' }], year: 2018, journal: 'Pak J Pharm Sci' });
  assert.notStrictEqual(cit.record?.source, 'Google Scholar', 'a [CITATION] entry verified a reference');
  assert(cit.status !== 'verified', `[CITATION]-only reference marked verified (${cit.reason})`);

  // 4. an exhausted key pauses Google Scholar
  mode = 'exhausted';
  const r1 = await S.googleScholarSearch({ title: 'Some other reference title that is long enough' });
  assert(r1.error, 'exhausted key not reported');
  const before = serpCalls;
  const r2 = await S.googleScholarSearch({ title: 'Yet another reference title that is long enough' });
  assert(/paused/.test(r2.error || ''), 'Google Scholar not paused after the key ran out');
  assert.strictEqual(serpCalls, before, 'SerpApi asked again while paused');
  assert(S.databases().includes('Google Scholar (SerpApi)'));

  console.log(`google scholar test passed (parsing, Scholar-only verification: ${ok.status}, [CITATION] rejected: ${cit.status}, pause on exhausted key)`);
  await db.close().catch(() => {});
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
