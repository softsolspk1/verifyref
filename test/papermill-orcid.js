// papermill-orcid.js - Module 4: the ORCID iD Crossref lists for a retracted paper's author is matched by name, so a
// name match in Retraction Watch can be confirmed (same iD) or set aside (another iD). Offline: Crossref is stubbed.
const assert = require('assert');
const http = require('../src/http');
const works = {
  '10.1/same': { author: [{ given: 'Rabia Ismail', family: 'Yousuf', ORCID: 'https://orcid.org/0000-0002-1825-0097' }, { given: 'A', family: 'Other' }] },
  '10.1/other': { author: [{ given: 'Muhammad Adnan', family: 'Khan', ORCID: 'http://orcid.org/0000-0003-2405-3222' }] },
  '10.1/none': { author: [{ given: 'Muhammad Adnan', family: 'Khan' }] }
};
http.getJson = async url => {
  const doi = decodeURIComponent(url.split('/works/')[1] || '');
  return works[doi] ? { ok: true, status: 200, data: { message: works[doi] } } : { ok: false, status: 404 };
};
const { crossrefAuthorOrcid } = require('../src/papermill');

(async () => {
  assert.strictEqual(await crossrefAuthorOrcid('10.1/same', { given: 'Rabia Ismail', family: 'Yousuf' }), '0000-0002-1825-0097');
  assert.strictEqual(await crossrefAuthorOrcid('10.1/other', { given: 'Muhammad Adnan', family: 'Khan' }), '0000-0003-2405-3222');
  assert.strictEqual(await crossrefAuthorOrcid('10.1/none', { given: 'Muhammad Adnan', family: 'Khan' }), null, 'no iD deposited');
  assert.strictEqual(await crossrefAuthorOrcid('10.1/same', { given: 'Bilal', family: 'Butt' }), null, 'author not on the paper');
  assert.strictEqual(await crossrefAuthorOrcid('10.1/missing', { given: 'Bilal', family: 'Butt' }), null, 'unknown DOI');
  console.log('  ok - the retracted paper author\'s ORCID iD is found by name (with or without the orcid.org prefix), none when not deposited');
  console.log('papermill ORCID test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
