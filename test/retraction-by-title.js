// test/retraction-by-title.js - a retracted paper cited without a DOI is still reported as retracted when no registry
// record is found: its title in the Retraction Watch table, confirmed by the first author's surname. A paper with the same
// title by other authors is not, and a short generic title is never looked up. Module 4 then counts a paper-mill
// retraction found this way. All network access is blocked (registries unreachable). Run: node test/retraction-by-title.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.APP_MODE;
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'SERPAPI_KEY', 'BRAVE_API_KEY', 'OPENALEX_API_KEY', 'CORE_API_KEY', 'NCBI_API_KEY']) process.env[k] = '';
const assert = require('assert');
global.fetch = async () => { throw new Error('offline'); };
const http = require('../src/http');
http.getJson = async () => ({ ok: false, status: 0, data: null, error: 'offline' });
http.getText = async () => ({ ok: false, status: 0, data: null, error: 'offline' });
const db = require('../src/db');
const P = require('../src/parse');

(async () => {
  await db.init();
  await db.query("INSERT INTO retractions(doi, title, journal, journal_norm, nature, reason, authors, retraction_date) VALUES($1, $2, 'Biomed Res Int', 'biomed res int', 'Retraction', '+Paper Mill;+Fake Peer Review', 'Ahmed Khan;Sara Ali;Bilal Shah', '2022-03-01')",
    ['10.9999/rw.1', 'Hepatoprotective activity of Berberis lycium root extract against carbon tetrachloride-induced liver damage in rats']);
  await db.query("INSERT INTO retractions(doi, title, journal, journal_norm, nature, reason, authors, retraction_date) VALUES('10.9999/rw.2', 'Diabetes mellitus', 'X', 'x', 'Retraction', '+Error in Data', 'Lee Min', '2021-01-01')");
  const { checkReferences } = require('../src/checks/reference');
  const refs = [
    'Khan A, Ali S and Shah B (2018). Hepatoprotective activity of Berberis lycium root extract against carbon tetrachloride induced liver damage in rats. Biomed. Res. Int., 2018: 1-9.',
    'Brown K and White J (2019). Hepatoprotective activity of Berberis lycium root extract against carbon tetrachloride induced liver damage in rats. Pharm. Biol., 57: 10-19.',
    'Lee M (2020). Diabetes mellitus. J. Med., 4: 1-3.'
  ].map((raw, i) => P.parseReferenceEntry(raw, i + 1));
  const { results } = await checkReferences(refs, { checkLinks: false });
  assert.strictEqual(results[0].status, 'retracted', 'retracted paper cited without DOI is reported');
  assert.ok(/paper mill/i.test(results[0].retraction?.reason || ''), 'the Retraction Watch reason is kept');
  assert.notStrictEqual(results[1].status, 'retracted', 'the same title by other authors is not');
  assert.notStrictEqual(results[2].status, 'retracted', 'a short generic title is not looked up');

  // Module 4: the paper-mill retraction found by title is counted
  const { detectPaperMill } = require('../src/papermill');
  const text = 'Effect of an extract on liver damage in rats\n\nIntroduction\nLiver damage is common (Khan et al., 2018).\n\nReferences\n' + refs[0].raw;
  const r = await detectPaperMill({ text, body: text, meta: { title: 'Effect of an extract on liver damage in rats', authors: [], affiliations: [] }, references: results, millLookalike: false, blast: false, cellosaurus: false });
  assert.ok(r.signals.some(s => s.code === 'mill-retraction'), 'Module 4 counts the cited paper-mill retraction');

  console.log('retraction-by-title: all checks passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
