// test/external-similarity.js - the external full-text similarity service in the Similarity Report, without the network:
// callback signatures, which side of the service's comparison is the manuscript (both orientations), the fallback when
// its positions do not fit the text, paraphrased passages, and the credit in the report. Run: node test/external-similarity.js
process.env.COPYLEAKS_API_KEY = process.env.COPYLEAKS_API_KEY || 'test-key';
const assert = require('assert');
const X = require('../src/externalSimilarity');
const P = require('../src/checks/plagiarism');

const ok = m => console.log(`  ✓ ${m}`);

(async () => {
  const SIM = await P.shared();

  // callback signatures
  const t = X.sign('pjpsabc');
  assert.ok(X.verify('pjpsabc', t) && !X.verify('pjpsabc', 'x'.repeat(32)) && !X.verify('pjpsother', t) && !X.verify('pjpsabc', undefined));
  ok('callback URLs are signed; a wrong or missing signature is refused');

  // what is kept of the callbacks
  const c = X.slimCompleted({ scannedDocument: { totalWords: 300, credits: 1 }, results: { internet: [{ id: 'r1', url: 'https://example.org/a', title: 'A page', matchedWords: 30, identicalWords: 25 }], database: [{ id: 'r2', matchedWords: 9 }], score: { aggregatedScore: 12.5 } },
    notifications: { alerts: [{ code: 'suspected-ai-text', title: 'AI', additionalData: JSON.stringify({ summary: { ai: 0.83, human: 0.17 } }) }] } });
  assert.strictEqual(c.items.length, 2);
  assert.strictEqual(X.aiEstimate(c), 83);
  ok('completed callback: matched sources and the AI-text estimate');

  // a manuscript with a copied and a paraphrased sentence
  const copied = 'Chitosan nanoparticles loaded with curcumin were prepared by ionic gelation with sodium tripolyphosphate and characterised for size and zeta potential';
  const para = 'The extract strongly lowered paw swelling in rats given carrageenan over a period of six hours';
  const ms = `Our own opening about an unrelated herbal remedy from the Thar desert region written here plainly. ${copied}. More of our own words follow here about goats and grazing. ${para}. Closing words of ours.`;
  const prep = P.prepare(ms);
  const page = `Some page text first. ${copied}. Later the page says that the extract markedly reduced paw oedema in carrageenan treated rats during six hours of observation.`;
  const cs = ms.indexOf(copied), ps = page.indexOf(copied), qs = ms.indexOf(para), rs = page.indexOf('the extract markedly');
  const cmp = mineSide => {
    const theirs = mineSide === 'source' ? 'suspected' : 'source';
    return {
      identical: { [mineSide]: { chars: { starts: [cs], lengths: [copied.length] } }, [theirs]: { chars: { starts: [ps], lengths: [copied.length] } } },
      minorChanges: null,
      relatedMeaning: { [mineSide]: { chars: { starts: [qs], lengths: [para.length] } }, [theirs]: { chars: { starts: [rs], lengths: 110 } } }
    };
  };
  const ext = side => ({ items: [{ id: 'r1', kind: 'internet', url: 'https://example.org/a', title: 'A page', matchedWords: 40 }], results: { r1: X.slimResult({ text: { value: page, comparison: cmp(side) } }) } });
  for (const side of ['source', 'suspected']) {
    const [s] = P.externalSources(ext(side), prep);
    assert.ok(s, `a source (${side})`);
    const id = s.passages.find(p => !p.paraphrased);
    assert.ok(id && /^Chitosan/.test(id.text) && /zeta potential/.test(id.text) && /Chitosan/.test(id.source), `identical passage mapped (${side}): ${id?.text}`);
    assert.ok(s.passages.some(p => p.paraphrased && /paw swelling/.test(p.text)), `paraphrased passage marked (${side})`);
  }
  ok('the manuscript side is recognised in both orientations; identical and paraphrased passages mapped to its words');

  // positions that do not fit the text: identical passages found again by their wording
  const bad = ext('source');
  bad.results.r1.comparison.identical.source.chars.starts = [5];
  bad.results.r1.comparison.relatedMeaning = null;
  const [f] = P.externalSources(bad, prep);
  assert.ok(f && f.passages.length === 1 && /^Chitosan/.test(f.passages[0].text), 'fallback by wording');
  ok('positions that do not fit: the identical passage is found by its wording');

  // credited in the report like any other source
  const [src] = P.externalSources(ext('source'), prep);
  const all = [{ key: src.key, type: src.type, title: src.title, ranges: src.passages.map(p => [p.from, p.to]), passages: src.passages }];
  const v = SIM.recompute(all, prep.text, { tokens: prep.words });
  assert.ok(v.summary.internet > 30 && v.sources[0].key === 'ext:https://example.org/a', `credited: ${v.summary.similarity}%`);
  ok(`credited in the Similarity Index (${v.summary.similarity}%, internet sources)`);

  // the database of submitted documents is "Submitted works", without a link
  const dbExt = { items: [{ id: 'd1', kind: 'database', title: null, matchedWords: 20 }], results: { d1: ext('source').results.r1 } };
  const [d] = P.externalSources(dbExt, prep);
  assert.strictEqual(d.type, 'submission');
  assert.ok(!/copyleaks/i.test(JSON.stringify(d)), 'the service is not named');
  ok('external database matches are submitted works; the service is never named');
  // the callbacks as stored for the waiting report (in-memory database)
  process.env.PGLITE_DIR = 'memory://';
  delete process.env.DATABASE_URL;
  const db = require('../src/db');
  await db.init();
  await db.query("INSERT INTO ext_scans(scan_id, text_hash) VALUES('pjpstest1', 'h')");
  await X.receive('pjpstest1', 'creditsChecked', null, {});
  await X.receive('pjpstest1', 'completed', null, { scannedDocument: { totalWords: 10 }, results: { internet: [{ id: 'r1', url: 'https://example.org/a', matchedWords: 5 }] } });
  await X.receive('pjpstest1', 'result', 'r1', { text: { value: 'page', comparison: {} } });
  let row = await db.one("SELECT * FROM ext_scans WHERE scan_id = 'pjpstest1'");
  assert.strictEqual(row.status, 'completed');
  assert.strictEqual(row.completed.items[0].id, 'r1');
  assert.strictEqual(row.results.r1.value, 'page');
  await db.query("UPDATE ext_scans SET status = 'exporting' WHERE scan_id = 'pjpstest1'");
  await X.receive('pjpstest1', 'export-done', null, {});
  await X.receive('pjpstest1', 'completed', null, {}); // a repeated callback changes nothing
  row = await db.one("SELECT * FROM ext_scans WHERE scan_id = 'pjpstest1'");
  assert.strictEqual(row.status, 'exported');
  assert.strictEqual(row.completed.items.length, 1);
  ok('callbacks stored: completed, each exported result, export done; repeats ignored');
  console.log('external similarity test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
