// test/corpus-bulk.js - the bulk text repository on R2 (src/corpusBulk.js): packs, catalogue and the sharded hash index
// built as scripts/corpus-load-pmc.js builds them, read back with byte-range requests; a manuscript that copies a passage
// finds that paper (and only it), with its text and details; corpus.js merges the bulk matches. R2 is replaced by an
// in-memory store. Run: node test/corpus-bulk.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
const assert = require('assert');
const zlib = require('zlib');

// in-memory R2
const store = new Map();
const U = require('../src/uploads');
let ranges = 0;
Object.assign(U, {
  enabled: () => true,
  putObject: async (k, b) => { store.set(k, Buffer.from(b)); },
  getObject: async k => { if (!store.has(k)) throw new Error('404'); return store.get(k); },
  getObjectRange: async (k, s, e) => { ranges++; const b = store.get(k); return b ? b.subarray(s, e + 1) : null; }
});
const B = require('../src/corpusBulk');
const corpus = require('../src/corpus');
const db = require('../src/db');

const words = n => Array.from({ length: n }, (_, i) => `w${(i * 7919) % 100003}x${i}`).join(' ');
const para = seed => Array.from({ length: 400 }, (_, i) => ['alpha', 'beta', 'gamma', 'delta', 'kappa', 'sigma', 'omega', 'theta', 'lambda', 'zeta'][(i * seed + i * i) % 10] + (((i * seed) % 97) + 3)).join(' ');

(async () => {
  await db.init();
  // three papers in one pack, as the loader writes them
  const docs = [
    { key: 'pmc:PMC1', title: 'Paper one', text: `${para(3)} ${words(300)}` },
    { key: 'pmc:PMC2', title: 'Paper two', text: `${para(11)} ${words(200)}` },
    { key: 'pmc:PMC3', title: 'Paper three', text: para(17) }
  ];
  const parts = [], cat = [], pairs = new Map();
  let off = 0;
  docs.forEach((d, n) => {
    const gz = zlib.gzipSync(d.text);
    cat.push({ id: n, key: d.key, title: d.title, journal: 'J Test', year: 2024, doi: `10.1/${n}`, off, len: gz.length });
    parts.push(gz); off += gz.length;
    for (const h of B.bulkHashes(d.text)) { const f = B.fileOf(h); if (!pairs.has(f)) pairs.set(f, []); pairs.get(f).push(h, n); }
  });
  store.set('bulk/pmc/text/p0.bin', Buffer.concat(parts));
  store.set('bulk/pmc/cat/p0.json', Buffer.from(JSON.stringify(cat)));
  let entries = 0;
  for (let f = 0; f < B.FILES; f++) { const p = new Uint32Array(pairs.get(f) || []); entries += p.length / 2; store.set(`bulk/pmc/idx/v1/f${f.toString(16).padStart(2, '0')}.bin`, B.buildIndexFile(p)); }
  store.set('bulk/pmc/manifest.json', Buffer.from(JSON.stringify({ version: 1, docs: 3, entries, packs: 1 })));
  assert.ok(entries > 50, `index entries (${entries})`);

  // a manuscript copying 300 words of paper two among its own words
  const copied = para(11).split(' ').slice(50, 350).join(' ');
  const manuscript = `${words(500).replace(/w/g, 'm')} ${copied} ${words(400).replace(/w/g, 'q')}`;
  const found = await B.candidatesByHashes(corpus.fingerprints(manuscript));
  assert.strictEqual(found[0]?.sourceKey, 'pmc:PMC2', `copied paper found first (got ${found.map(f => f.sourceKey)})`);
  assert.ok(!found.some(f => f.sourceKey === 'pmc:PMC1'), 'unrelated paper not returned');
  assert.strictEqual(found[0].text, docs[1].text, 'its full text read from the pack');
  assert.deepStrictEqual([found[0].title, found[0].meta.doi, found[0].meta.withRefs], ['Paper two', '10.1/1', true]);
  console.log(`  ✓ copied passage -> its paper (shared ${found[0].shared}), ${ranges} range reads`);

  // nothing copied: nothing found
  assert.strictEqual((await B.candidatesByHashes(corpus.fingerprints(words(800).replace(/w/g, 'z')))).length, 0, 'original text finds nothing');
  console.log('  ✓ original text finds nothing');

  // corpus.js merges the bulk matches with the database repository; a paper in both counts once
  await corpus.addDoc({ kind: 'publication', sourceKey: 'pmc:PMC2', title: 'Paper two', meta: {}, text: docs[1].text });
  const merged = await corpus.candidates(manuscript);
  assert.strictEqual(merged.filter(d => d.sourceKey === 'pmc:PMC2').length, 1, 'counted once');
  assert.ok(merged.length >= 1);
  const st = await corpus.stats();
  assert.strictEqual(st.bulkPmc?.docs, 3, 'bulk size in the repository statistics');
  console.log('  ✓ merged with the database repository; statistics include the bulk part');
  console.log('corpus bulk test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
