// test/similarity-engine.js - the similarity report's matching and attribution without the internet: citation markers do
// not break a copied sentence, search stretches start at the sentences, the primary-source percentages add up and are
// recomputed when a source is excluded or the minimum match length is raised (the same code as the report view), and a
// phrase search leaves no manuscript text in the cache. Run: node test/similarity-engine.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
const assert = require('assert');
const http = require('http');
const db = require('../src/db');
const P = require('../src/checks/plagiarism');

const ok = m => console.log(`  ✓ ${m}`);

(async () => {
  await db.init();
  const SIM = await P.shared();

  // ---- citation markers are ignored on both sides
  const copied = 'Chitosan nanoparticles loaded with curcumin were prepared by ionic gelation with sodium tripolyphosphate and characterised for size, zeta potential and entrapment efficiency before the release study';
  const ms = `Introduction\n\nOur own opening sentence about an unrelated herbal remedy from the Thar desert region is written here in plain words. ${copied} [12]. Another sentence of ours closes this paragraph about goats and their grazing habits.\n\nReferences\n\n1. A reference.`;
  const src = `Background text of the source paper. ${copied} (Ahmed et al., 2019). The rest of the source paper continues here.`;
  const prep = P.prepare(ms);
  assert.ok(prep.bibliographyExcluded, 'bibliography cut off');
  assert.ok(prep.citeWords >= 1, 'citation marker found');
  const o = P.overlap(prep, src);
  assert.strictEqual(o.passages.length, 1, 'one passage');
  const matched = o.passages[0].text;
  assert.ok(matched.startsWith('Chitosan') && /release study/.test(matched), `the whole copied sentence is matched: ${matched}`);
  assert.ok(/Chitosan nanoparticles/.test(o.passages[0].source || ''), 'the source wording of the match is kept');
  ok('citation markers ignored: a copied sentence with another citation is one match, with the source wording');

  // a sentence in the source with a citation in the middle still matches the manuscript sentence without it
  const ms2 = 'Opening words of our own manuscript about something unrelated to everything else here. The extract reduced paw oedema in a dose dependent manner in carrageenan treated rats over six hours of observation. Closing words of our own manuscript.';
  const src2 = 'The extract reduced paw oedema in a dose dependent manner [4, 7] in carrageenan treated rats over six hours of observation.';
  const p2 = P.prepare(ms2.repeat(1));
  const o2 = P.overlap(p2, src2);
  assert.ok(o2.passages[0]?.words >= 18, `match across a citation in the source: ${o2.passages[0]?.words} words`);
  ok('a citation inside the source sentence does not split the match');

  // quoted text never matches
  const p3 = P.prepare(`As they wrote, "${copied}" and we agree with that view entirely in this paper.`);
  assert.strictEqual(P.overlap(p3, src).passages.length, 0, 'quotation excluded');
  ok('quoted text is not matched');

  // ---- search stretches are aligned on the sentences
  const sents = ['Alpha beta gamma delta epsilon zeta theta iota kappa lambda.', 'Murmur nuance xylem omicron pistil rhodium sigma taurine upsilon phial chimera psyche omega.', 'Unus duo tres quattuor quinque sex septem octo novem decem.'];
  const pw = P.prepare(sents.join(' '));
  const { windows } = P.searchWindows(pw, new Uint8Array(pw.words.length));
  const starts = new Set(windows.map(w => pw.words[w.from].raw));
  for (const first of ['Alpha', 'Murmur', 'Unus']) assert.ok(starts.has(first), `a stretch starts at "${first}"`);
  assert.ok(windows.some(w => /omega\.$/.test(pw.words[w.to - 1].raw)), 'a stretch ends with the sentence');
  ok(`search stretches start at every sentence and end with it (${windows.length} stretches for ${pw.words.length} words)`);

  // ---- primary sources: shared attribution, exclusions, minimum match length
  const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ');
  const all = [
    { key: 'a', type: 'publication', title: 'A', ranges: [[0, 30]] },
    { key: 'b', type: 'internet', title: 'B', ranges: [[20, 40], [60, 70]] },
    { key: 'c', type: 'publication', title: 'C', ranges: [[25, 29]] }
  ];
  const v = SIM.recompute(all, text);
  assert.deepStrictEqual(v.sources.map(x => [x.key, x.words]), [['a', 30], ['b', 20]]);
  assert.strictEqual(v.summary.similarity, 50);
  assert.strictEqual(v.summary.publications + v.summary.internet, v.summary.similarity, 'types add up');
  assert.strictEqual(v.document.map(d => d.t).join(''), text, 'highlighted text is the whole text');
  assert.ok(v.alsoMatched.some(x => x.key === 'c'), 'a source with every word credited to a larger one is listed as also matched');
  const vx = SIM.recompute(all, text, { excluded: ['a'] });
  assert.deepStrictEqual(vx.sources.map(x => [x.key, x.words]), [['b', 30]], 'excluding A: B gets its words back');
  assert.ok(vx.alsoMatched.find(x => x.key === 'a').excluded, 'A is marked excluded');
  const vm = SIM.recompute(all, text, { minWords: 15 });
  assert.deepStrictEqual(vm.sources.map(x => [x.key, x.words]), [['a', 30], ['b', 10]], 'matches under 15 words left out');
  ok('primary sources add up to the index; exclusion and minimum match length recompute it');

  // the server's applySettings gives the same numbers as the view
  const report = { kind: 'plagiarism', version: 3, summary: { ...v.summary }, sources: v.sources, alsoMatched: v.alsoMatched, document: v.document, filters: {} };
  const adj = await P.applySettings(report, { excluded: ['a'] });
  assert.strictEqual(adj.summary.similarity, vx.summary.similarity);
  assert.deepStrictEqual(adj.settings.excluded, ['a']);
  const back = await P.applySettings(adj, { excluded: [] });
  assert.strictEqual(back.summary.similarity, v.summary.similarity, 'including the source again restores the index');
  ok('applySettings (export) matches the view and is reversible');

  // ---- sections (iThenticate's "exclude abstract / methods") and the small-source filter (Turnitin's "under x %")
  const para = (tag, n) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ');
  const paper = `Title of the paper here\n\nAbstract: ${para('ab', 20)}\n\n1. INTRODUCTION\n${para('in', 20)}\n\nMaterials and Methods\n${para('me', 40)}\n\nResults and discussion\n${para('re', 20)}\n\nAcknowledgements\n${para('ak', 5)}`;
  const ptok = SIM.tokenize(paper);
  const secs = SIM.sectionsOf(paper, ptok);
  assert.deepStrictEqual(secs.map(x => x.key), ['front', 'abstract', 'introduction', 'methods', 'results', 'back'], 'headings found, inline "Abstract:" too');
  assert.strictEqual(secs.find(x => x.key === 'results').label, 'Results and discussion');
  assert.strictEqual(secs.reduce((a, x) => a + x.words, 0), ptok.length, 'sections cover every word once');
  assert.strictEqual(SIM.sectionsOf('Just some text\nwithout any headings at all').length, 1, 'no headings: one section');
  const meth = secs.find(x => x.key === 'methods').ranges[0];
  const intro = secs.find(x => x.key === 'introduction').ranges[0];
  const pall = [
    { key: 'm', type: 'publication', title: 'Methods source', ranges: [[meth[0] + 2, meth[0] + 32]] },
    { key: 'i', type: 'publication', title: 'Intro source', ranges: [[intro[0] + 2, intro[0] + 12]] }
  ];
  const pv = SIM.recompute(pall, paper, { tokens: ptok });
  assert.strictEqual(pv.summary.compared, ptok.length);
  assert.strictEqual(pv.sections.find(x => x.key === 'methods').matched, 30, 'section breakdown counts matched words');
  const pe = SIM.recompute(pall, paper, { tokens: ptok, excludeSections: ['methods'] });
  assert.deepStrictEqual(pe.sources.map(x => x.key), ['i'], 'a match inside an excluded section no longer counts');
  assert.strictEqual(pe.summary.compared, ptok.length - secs.find(x => x.key === 'methods').words, 'excluded words leave the total');
  assert.strictEqual(pe.summary.similarity, Math.round(10 / pe.summary.compared * 1000) / 10);
  assert.ok(pe.document.some(d => d.x) && pe.document.map(d => d.t).join('') === paper, 'excluded text marked, text intact');
  assert.ok(pe.sections.find(x => x.key === 'methods').excluded);
  const pp = SIM.recompute(pall, paper, { tokens: ptok, minPercent: 10 });
  assert.deepStrictEqual(pp.sources.map(x => x.key), ['m'], 'a source under 10 % is dropped');
  assert.ok(pp.alsoMatched.find(x => x.key === 'i').small, 'and listed as under the filter');
  const prep2 = { kind: 'plagiarism', version: 3, summary: { ...pv.summary }, sources: pv.sources, alsoMatched: pv.alsoMatched, document: pv.document, filters: {} };
  const s1 = await P.applySettings(prep2, { excludeSections: ['methods', 'nonsense'], minPercent: 0 });
  assert.deepStrictEqual(s1.settings.excludeSections, ['methods'], 'unknown section keys dropped');
  assert.strictEqual(s1.summary.similarity, pe.summary.similarity, 'export matches the view');
  assert.strictEqual(s1.summary.words, ptok.length, 'the full word count is kept, so filters never compound');
  assert.ok(/Materials and methods/.test(s1.filters.sections));
  const s2 = await P.applySettings(s1, { excludeSections: [] });
  assert.strictEqual(s2.summary.similarity, pv.summary.similarity, 'including the section again restores the index');
  assert.ok(!s2.filters.sections, 'the filter note goes with it');
  const csv = P.toCsv(s1);
  assert.ok(csv.charCodeAt(0) === 0xFEFF && csv.slice(1).startsWith('No.,Similarity %') && /Intro source/.test(csv) && /Methods source/.test(csv), 'sources CSV lists credited and other sources');
  ok('sections found and excluded, small sources dropped, section breakdown, CSV of the sources');

  // ---- privacy: a phrase search is cached under a hash with the records found only
  const phrase = 'zyxomirol permeation across excised goat skin was measured';
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ request: { queryString: decodeURIComponent(req.url) }, hitCount: 1, resultList: { result: [{ title: 'A public paper', pmcid: 'PMC1', abstractText: 'x' }] } }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/search?query=${encodeURIComponent(`"${phrase}"`)}`;
  const { getJson, cacheGet } = require('../src/http');
  const keep = d => ({ resultList: { result: (d?.resultList?.result || []).map(x => ({ title: x.title, pmcid: x.pmcid })) } });
  const r1 = await getJson(url, { ttl: 3600, private: keep });
  assert.ok(r1.ok && r1.data.resultList.result.length === 1);
  await new Promise(r => setTimeout(r, 300));
  const rows = await db.all('SELECT key, value FROM cache');
  const dump = JSON.stringify(rows);
  assert.ok(rows.length >= 1 && rows.every(x => /^p:[0-9a-f]{64}$/.test(x.key)), 'cache key is a hash');
  assert.ok(!/zyxomirol|goat/i.test(dump) && !dump.includes('127.0.0.1'), 'no manuscript words and no URL in the cache');
  const r2 = await getJson(url, { ttl: 3600, private: keep });
  assert.strictEqual(r2.data.resultList.result[0].title, 'A public paper', 'cached answer still usable');
  assert.ok(!(await cacheGet(`j:${url}`)), 'nothing under the plain URL');
  await getJson(`${url}&x=1`, { ttl: 3600, private: true });
  assert.strictEqual((await db.all('SELECT key FROM cache')).length, rows.length, 'private: true is not cached at all');
  server.close();
  ok('phrase searches cached under a hash, without the passage or the URL');

  console.log('similarity engine test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
