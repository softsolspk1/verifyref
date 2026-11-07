// test/blacklist-entries.js - journals added one at a time to the HEC / institutional blacklist (Admin > Data): validated,
// no duplicates, found by ISSN or title with the reason, kept when a CSV of the list is uploaded, removed one by one.
// Run: node test/blacklist-entries.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
const assert = require('assert');
const db = require('../src/db');
const D = require('../src/datasets');
const { interpretLists } = require('../src/checks/journal');

(async () => {
  await db.init();
  const count = async () => (await D.listStatus()).lists.find(l => l.type === 'hec_blacklist').row_count || 0;
  await assert.rejects(D.addListEntry('hec_blacklist', {}), /title or its ISSN/);
  await assert.rejects(D.addListEntry('hec_blacklist', { title: 'X', issn: '12345' }), /ISSN must look like/);
  await assert.rejects(D.addListEntry('sjr', { title: 'X' }), /only to the HEC/);
  const a = await D.addListEntry('hec_blacklist', { title: 'International Journal of Fast Pharmacy Research', issn: '2345-6784', reason: 'No peer review' }, { by: 'admin@pjps.pk' });
  assert.ok(a.Id && a.Manual === 'yes' && a['Added by'] === 'admin@pjps.pk');
  await assert.rejects(D.addListEntry('hec_blacklist', { title: 'International Journal of FAST Pharmacy Research' }), /Already on the list/);
  await assert.rejects(D.addListEntry('hec_blacklist', { eissn: '23456784' }), /Already on the list/);
  assert.strictEqual(await count(), 1);

  let lists = interpretLists(await D.listLookupAll(['2345-6784'], ''));
  assert.strictEqual(lists.hecBlacklist?.data?.Reason, 'No peer review', 'found by ISSN with the reason');
  lists = interpretLists(await D.listLookupAll([], 'International Journal of Fast Pharmacy Research'));
  assert.strictEqual(lists.hecBlacklist?.matchedBy, 'title', 'found by title');

  // a CSV upload replaces the uploaded rows but keeps the journals added by hand
  await D.importJournalList('hec_blacklist', 'hec-blacklist.csv', 'Title,ISSN\nJournal A,1111-1111\nJournal B,2222-2222\n');
  assert.strictEqual(await count(), 3);
  await D.importJournalList('hec_blacklist', 'hec-blacklist-v2.csv', 'Title,ISSN\nJournal C,3333-3333\n');
  assert.strictEqual(await count(), 2, 'old CSV rows replaced, manual row kept');
  assert.ok(interpretLists(await D.listLookupAll(['2345-6784'], '')).hecBlacklist, 'manual row still matched');

  assert.strictEqual(await D.removeListEntry('hec_blacklist', a.Id), 1);
  assert.strictEqual(await D.removeListEntry('hec_blacklist', a.Id), 0);
  assert.strictEqual(await count(), 1);
  assert.ok(!interpretLists(await D.listLookupAll(['2345-6784'], '')).hecBlacklist, 'removed');
  // the last journal removed: the list is empty again
  await D.importJournalList('sjr', 'sjr.csv', 'Title,Issn\nJournal Z,4444-4444\n');
  const b = await D.addListEntry('hec_blacklist', { title: 'Journal Y' });
  await db.query("DELETE FROM journal_list_entries WHERE list_type = 'hec_blacklist' AND data->>'Manual' IS DISTINCT FROM 'yes'");
  await D.removeListEntry('hec_blacklist', b.Id);
  assert.ok(!(await D.listStatus()).lists.find(l => l.type === 'hec_blacklist').row_count, 'empty list shows as not uploaded');
  console.log('blacklist entries test passed (add, validate, duplicates, lookup with reason, kept on CSV upload, remove)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
