// image-refs-r2.js - Module 5 figure store on R2: exported panels' rows leave the database with their display data kept on
// R2; matches, a paper's panel list and thumbnails still read them; a re-indexed or removed paper's old panels are no
// longer reported; merging segments keeps only current panels. Offline: in-memory database, R2 replaced by a Map.
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
const assert = require('assert');
const R2 = require('../src/uploads');
const store = new Map();
R2.enabled = () => true;
R2.putObject = async (key, body) => { store.set(key, Buffer.from(body)); };
R2.getObject = async key => { if (!store.has(key)) throw new Error(`no ${key}`); return store.get(key); };
R2.deleteObject = async key => { store.delete(key); };
R2.listObjects = async prefix => [...store.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key, size: store.get(key).length }));
const db = require('../src/db');
const IR = require('../src/imageRefs');
const ok = m => console.log(`  ok - ${m}`);
const hx = n => n.toString(16).padStart(16, '0');

async function addDoc(key, panels) {
  const d = await db.one("INSERT INTO image_ref_docs(source, source_key, title, status, panels) VALUES('pmc', $1, $2, 'done', $3) RETURNING id", [key, `Paper ${key}`, panels]);
  const ids = [];
  for (let i = 0; i < panels; i++) {
    const thumb = `image-refs/pmc/${d.id}/${i + 1}-t.jpg`;
    store.set(thumb, Buffer.from('jpg'));
    const hashes = Array.from({ length: 6 }, (_, k) => hx(d.id * 1000 + i * 10 + k)).join(',');
    ids.push((await db.one("INSERT INTO image_refs(doc_id, source, figure, panel, type, hashes, thumb_key, w, h) VALUES($1, 'pmc', $2, $3, 'blot', $4, $5, 100, 80) RETURNING id", [d.id, `Figure ${i + 1}`, `Figure ${i + 1}, panel 1`, hashes, thumb])).id);
  }
  return { id: d.id, ids };
}

(async () => {
  await db.init();
  const a = await addDoc('A', 3), b = await addDoc('B', 2), c = await addDoc('C', 2);

  // export: segments of 4 panels; the rows leave the database, the data is on R2
  const ex = await IR.exportIndex({ batch: 4 });
  assert.ok(ex.segments >= 2, JSON.stringify(ex));
  assert.strictEqual((await db.one('SELECT count(*)::int AS n FROM image_refs')).n, 0, 'exported rows deleted');
  const all = [...a.ids, ...b.ids, ...c.ids];
  let rows = await IR.refRows(all);
  assert.strictEqual(rows.size, 7, 'every panel found on R2');
  assert.strictEqual(rows.get(a.ids[1]).panel, 'Figure 2, panel 1');
  assert.strictEqual(rows.get(b.ids[0]).title, 'Paper B', 'with its paper');
  assert.ok((await IR.loadIndex()).n === 7, 'fingerprints still searched');
  assert.deepStrictEqual((await IR.panelsOf(a.id)).map(p => p.id), a.ids, "a paper's panel list read from R2");
  assert.strictEqual(await IR.thumbKey(c.ids[1]), `image-refs/pmc/${c.id}/2-t.jpg`);
  ok('exported panels leave the database and are read from R2 (matches, panel list, thumbnail)');

  // paper A indexed again: new rows (as storeDoc writes them); the old panels on R2 are no longer reported
  await db.query('DELETE FROM image_refs WHERE doc_id = $1', [a.id]);
  const newIds = [];
  for (let i = 0; i < 2; i++) newIds.push((await db.one("INSERT INTO image_refs(doc_id, source, figure, panel, type, hashes, w, h) VALUES($1, 'pmc', 'Figure 9', 'Figure 9', 'photo', $2, 10, 10) RETURNING id", [a.id, Array(6).fill(hx(99 + i)).join(',')])).id);
  await db.query('UPDATE image_ref_docs d SET ref_min = r.lo, ref_max = r.hi FROM (SELECT min(id) AS lo, max(id) AS hi FROM image_refs WHERE doc_id = $1) r WHERE d.id = $1', [a.id]);
  rows = await IR.refRows([...a.ids, ...newIds]);
  assert.deepStrictEqual([...rows.keys()].sort((x, y) => x - y), newIds, 'only the new indexing');
  assert.deepStrictEqual((await IR.panelsOf(a.id)).map(p => p.id), newIds);
  ok('a re-indexed paper: its earlier panels on R2 are no longer reported');

  // paper B removed: its panels and thumbnails go
  await IR.deleteDoc(b.id);
  assert.strictEqual((await IR.refRows(b.ids)).size, 0);
  assert.ok(![...store.keys()].some(k => k.startsWith(`image-refs/pmc/${b.id}/`)), 'thumbnails removed by prefix');
  ok('a removed paper: panels no longer reported, thumbnails removed from R2');

  // the new rows exported too, then all segments merged: only current panels are kept
  await IR.exportIndex({ batch: 10 });
  const before = (await db.all('SELECT * FROM image_index_segments')).length;
  const m = await IR.compactIndex({ maxSegments: 1, mergeLimit: 100 });
  assert.ok(m.merged >= 2, JSON.stringify(m));
  const segs = await db.all('SELECT * FROM image_index_segments');
  assert.ok(segs.length < before);
  rows = await IR.refRows([...a.ids, ...newIds, ...b.ids, ...c.ids]);
  assert.deepStrictEqual([...rows.keys()].sort((x, y) => x - y), [...newIds, ...c.ids].sort((x, y) => x - y), 'current panels only');
  assert.strictEqual((await IR.loadIndex()).n, 4, 'merged index: 2 new panels of A + 2 of C');
  ok('merging segments keeps only current panels and their data');

  console.log('image refs R2 test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
