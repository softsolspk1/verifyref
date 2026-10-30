// test/papermill-signals.js - Module 4 reference and ORCID signals built on Retraction Watch: references to journals with
// many paper-mill retractions (full and abbreviated names) and retracted papers on the authors' ORCID records (exact DOI,
// not counted twice by the name match). In-memory database, ORCID API stubbed. Run: node test/papermill-signals.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.APP_MODE;
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) process.env[k] = '';
const assert = require('assert');

// ORCID public API stub (must be installed before src/papermill reads getJson)
const http = require('../src/http');
const ORCID = '0000-0002-1825-0097';
http.getJson = async url => {
  if (url.endsWith(`${ORCID}/works`)) return { ok: true, status: 200, data: { group: [
    { 'external-ids': { 'external-id': [{ 'external-id-type': 'doi', 'external-id-value': 'https://doi.org/10.9999/MILL.7' }] } },
    { 'external-ids': { 'external-id': [{ 'external-id-type': 'doi', 'external-id-value': '10.9999/clean.1' }] } }
  ] } };
  if (url.endsWith(`${ORCID}/person`)) return { ok: true, status: 200, data: { name: { 'given-names': { value: 'Josiah' }, 'family-name': { value: 'Carberry' } } } };
  return { ok: false, status: 404, data: null };
};

const db = require('../src/db');
const D = require('../src/datasets');
const { detectPaperMill } = require('../src/papermill');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

(async () => {
  await db.init();
  const ins = (doi, journal, reason, authors = '') => db.query("INSERT INTO retractions(doi, title, journal, journal_norm, nature, reason, authors, retraction_date) VALUES($1, $2, $3, $4, 'Retraction', $5, $6, '2023-01-01')",
    [doi, `Paper ${doi}`, journal, require('../src/text').normalizeJournal(journal), reason, authors]);
  for (let i = 0; i < 25; i++) await ins(`10.1111/mill.${i}`, 'Evidence-Based Complementary and Alternative Medicine', '+Paper Mill;+Investigation by Journal/Publisher;');
  for (let i = 0; i < 18; i++) await ins(`10.2222/few.${i}`, 'Journal of Few Problems', '+Paper Mill;');
  for (let i = 0; i < 40; i++) await ins(`10.3333/err.${i}`, 'Journal of Honest Errors', '+Error in Data;');
  await ins('10.9999/mill.7', 'Journal of Few Problems', '+Fake Peer Review;', 'Josiah Carberry');

  // ---- the journal index: threshold, abbreviated names, mill reasons only
  ok((await D.millJournalFor('Evidence-Based Complementary and Alternative Medicine'))?.mill === 25, 'full journal name found with its mill count');
  ok((await D.millJournalFor('Evid Based Complement Alternat Med'))?.mill === 25, 'NLM abbreviation matched word by word');
  ok(!(await D.millJournalFor('Journal of Few Problems')), 'journal below 20 mill retractions not listed');
  ok(!(await D.millJournalFor('Journal of Honest Errors')), 'retractions for other reasons do not count');
  ok(!(await D.millJournalFor('Evid Med')), 'a short abbreviation does not match by prefix');

  // ---- signal: share of the reference list in mill journals
  const ref = (i, journal) => ({ index: i, status: 'verified', record: { journal }, raw: `Ref ${i}` });
  const run = refs => detectPaperMill({ text: `Manuscript text. ORCID ${ORCID}. Contact: author@uni.edu.pk`, meta: { title: 'Short', authors: [{ given: 'Josiah', family: 'Carberry' }] }, references: refs, blast: false, cellosaurus: false });
  const many = [...Array(5)].map((_, i) => ref(i + 1, i % 2 ? 'Evid Based Complement Alternat Med' : 'Evidence-Based Complementary and Alternative Medicine'));
  const r1 = await run([...many, ...[...Array(15)].map((_, i) => ref(i + 6, 'Pak J Pharm Sci'))]);
  const mj = r1.signals.find(s => s.code === 'mill-journals');
  ok(mj && mj.severity === 'medium' && mj.weight === 2, '5 of 20 references (25%) in a mill journal: medium signal');
  ok(/25 paper-mill retractions/.test(mj.evidence[0].text), 'evidence names the Retraction Watch count');
  const r2 = await run([...many.slice(0, 3), ...[...Array(17)].map((_, i) => ref(i + 4, 'Pak J Pharm Sci'))]);
  ok(r2.signals.find(s => s.code === 'mill-journals')?.severity === 'low', '3 of 20 (15%): low signal');
  const r3 = await run([...many.slice(0, 3), ...[...Array(37)].map((_, i) => ref(i + 4, 'Pak J Pharm Sci'))]);
  ok(!r3.signals.some(s => s.code === 'mill-journals'), '3 of 40 (7.5%): no signal');

  // ---- signal: retracted paper on the author's ORCID record, not double-counted by the name match
  const om = r1.signals.find(s => s.code === 'orcid-mill-retraction');
  ok(om && om.severity === 'high', 'retracted-for-fake-peer-review DOI on the ORCID record: strong signal');
  ok(/Josiah Carberry \(ORCID 0000-0002-1825-0097\)/.test(om.evidence[0].text) && om.evidence[0].link === 'https://doi.org/10.9999/mill.7', 'evidence names the ORCID owner and links the DOI');
  ok(!r1.signals.some(s => /^author-(mill-)?retraction/.test(s.code)), 'the same paper is not counted again by the name match');
  ok(r1.details.orcidRetractions.length === 1 && r1.details.millJournals.length === 1, 'details carry both results for the report');

  console.log(`papermill-signals: ${n} checks passed`);
  await db.close?.();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
