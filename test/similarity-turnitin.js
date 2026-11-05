// test/similarity-turnitin.js - the similarity report's Turnitin features (version 5): small matches not excluded by
// default (matches from 5 words kept), replaced and hidden characters read through and flagged, sources excluded by word
// count, matches per source, the exclusion settings in the export. node test/similarity-turnitin.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const SIM = await import(pathToFileURL(path.join(__dirname, '../public/js/shared/similarity.js')).href);
  const P = require('../src/checks/plagiarism');
  await P.shared();
  const W = require('../src/docx');

  // 1. look-alike letters: a word with a Cyrillic "е" / "о" compares as the Latin word; Greek words of science untouched
  const plain = SIM.tokenize('The results of the dissolution study were reproducible').map(w => w.n);
  const masked = SIM.tokenize('Thе rеsults оf the dissоlution study wеre reprоducible').map(w => w.n);
  assert.deepStrictEqual(masked, plain, 'Cyrillic look-alikes are read as Latin');
  assert.strictEqual(SIM.norm('TNF-α'), 'tnfα');
  assert.strictEqual(SIM.norm('ΔΔCt'), 'δδct');
  assert.strictEqual(SIM.norm('Ζwitter'), 'zwitter', 'Greek capital look-alike in a Latin word');
  assert.strictEqual(SIM.norm('dis\u200Bsolution'), 'dissolution', 'zero-width character inside a word ignored');
  console.log('  ✓ look-alike letters and zero-width characters read through');

  // 2. flags: replaced characters and hidden characters; science text raises none
  assert.deepStrictEqual(SIM.textFlags('TNF-α and NF-κB rose; ΔΔCt was computed; Ζ-average 120 nm; 5 μg/mL; β-cyclodextrin and α-tocopherol.'), [], 'no flags on Greek letters of science');
  const flagged = SIM.textFlags('Thе rеsults оf this study show\u200B that the\u200B drug\u200B was stable.');
  assert.deepStrictEqual(flagged.map(f => [f.key, f.count]), [['replaced', 3], ['hidden', 3]]);
  assert.deepStrictEqual(flagged[0].examples.map(e => e.word), ['Thе', 'rеsults', 'оf']);
  console.log('  ✓ flags: replaced characters and hidden characters; none on TNF-α, ΔΔCt, β-cyclodextrin');

  // 3. matching keeps 5-word matches (small matches not excluded by default) and reads through look-alike letters
  const filler = Array.from({ length: 240 }, (_, i) => `word${i}`).join(' ');
  const body = `${filler} the tablets were stored at room temperature for later use. ${filler.replace(/word/g, 'item')}`;
  const prep = P.prepare(body);
  const o = P.overlap(prep, 'In our work the tablets were stored at room temperature before testing.');
  assert.ok(o.passages.some(p => p.words >= 5 && p.words < 8 && /tablets were stored/.test(p.text)), `a 5-7 word match is kept: ${JSON.stringify(o.passages.map(p => p.text))}`);
  const masked2 = P.prepare(body.replace('tablets were stored at room', 'tаblets wеre stоred at rооm'));
  assert.ok(P.overlap(masked2, 'the tablets were stored at room temperature for later use').passages.length, 'disguised words still match');
  console.log('  ✓ matches from 5 words kept; disguised text still matched');

  // 4. recompute: matches per source, sources excluded by word count
  const text = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');
  const all = [
    { key: 'a', type: 'publication', title: 'A', ranges: [[0, 40], [100, 130]] },
    { key: 'b', type: 'internet', title: 'B', ranges: [[200, 212]] }
  ];
  let v = SIM.recompute(all, text, { minWords: 5 });
  assert.deepStrictEqual(v.sources.map(x => [x.key, x.matches, x.words]), [['a', 2, 70], ['b', 1, 12]]);
  v = SIM.recompute(all, text, { minWords: 5, minSourceWords: 20 });
  assert.deepStrictEqual(v.sources.map(x => x.key), ['a'], 'a source under 20 words is left out');
  assert.ok(v.alsoMatched.find(x => x.key === 'b').small);
  console.log('  ✓ matches per source; sources excluded by word count');

  // 5. a version 5 report: default small-match filter off; settings saved and printed as Turnitin's On / Off table
  const doc = [{ t: `Introduction\n${text}\nMethods\n${text}\nReferences\n1. Khan A. A paper. J Pharm 2020.\n`, s: 0 }];
  const pl = { kind: 'plagiarism', version: 5, floor: 5, summary: { words: SIM.tokenize(doc[0].t).length, similarity: 0, level: 'ok' }, sources: all, alsoMatched: [], document: doc, quoted: [[3, 9]],
    settings: { excluded: [], minWords: 5, excludeSections: [], minPercent: 0, minSourceWords: 0, includeQuotes: true }, filters: { bibliography: 'included', quotes: 'included', smallMatches: 'not excluded' },
    flags: flagged, checked: {}, method: '', coverage: '' };
  let a = await P.applySettings(pl, {});
  assert.strictEqual(a.settings.minWords, 5, 'default: small matches not excluded');
  assert.match(a.filters.smallMatches, /not excluded/);
  a = await P.applySettings(pl, { minWords: 12, excludeSections: ['references', 'methods'], minSourceWords: 20, includeQuotes: false });
  assert.deepStrictEqual([a.settings.minWords, a.settings.minSourceWords, a.settings.excludeSections.sort().join()], [12, 20, 'methods,references']);
  const old = await P.applySettings({ ...pl, version: 4, floor: undefined }, { minWords: 5 });
  assert.strictEqual(old.settings.minWords, 8, 'a version 4 report cannot go below its 8-word minimum');
  const blocks = W.similarityReportBlocks({ plagiarism: a, meta: { title: 'T', fileName: 'ms.docx' }, id: 7, createdAt: '2026-11-05T10:00:00Z' });
  const settings = blocks.find(b => b.table?.headers?.[0] === 'Filter').table.rows;
  assert.deepStrictEqual(settings.slice(0, 4), [['Exclude bibliography', 'On'], ['Exclude quotes', 'On'], ['Exclude matches', '< 12 words'], ['Exclude small sources', '< 20 words']]);
  assert.deepStrictEqual(settings[5], ['Exclude methods and materials', 'On']);
  assert.ok(blocks.some(b => b.kv?.some(([k, v2]) => k === 'File' && v2 === 'ms.docx')), 'document details');
  assert.ok(blocks.some(b => b.h2 === 'Flags'));
  console.log('  ✓ version 5 defaults; filters saved; export prints document details, exclusion settings and flags');

  // 6. Word / PDF in Turnitin's layout: cover page, Integrity Overview (filters on, match groups, databases, flags),
  // top sources, the highlighted submission
  const X = require('../src/similarityExport');
  const r = { plagiarism: a, meta: { title: 'T', fileName: 'ms.docx', authors: [{ name: 'Ali Khan' }] }, id: 7, createdAt: '2026-11-05T10:00:00Z' };
  const m = X.model(r);
  assert.deepStrictEqual(m.filtered, ['Bibliography', 'Quoted Text', 'Small Matches (less than 12 words)', 'Small Sources (less than 20 words)', 'Methods and Materials']);
  assert.strictEqual(m.author, 'Ali Khan');
  assert.ok(m.details.some(([k, v2]) => k === 'File Name' && v2 === 'ms.docx'));
  assert.strictEqual(m.groups.length, 4, "Turnitin's four match groups");
  const pub = X.model({ ...r, plagiarism: { ...a, sources: [{ no: 1, type: 'publication', title: 'Leaves of &lt;i&gt;R. stricta&lt;/i&gt;.', journal: 'Molecules', year: 2020, percent: 0 }] } });
  assert.strictEqual(pub.sources[0].name, 'Leaves of R. stricta, Molecules, 2020', 'publication named by title, journal and year, markup removed');
  const pdf = await X.buildSimilarityPdf(r);
  assert.strictEqual(pdf.slice(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 3000, 'PDF written');
  const docx = await X.buildSimilarityDocx(r);
  assert.strictEqual(docx.slice(0, 2).toString(), 'PK');
  const xml = await (await require('jszip').loadAsync(docx)).file('word/document.xml').async('string');
  for (const s of ['Document Details', 'Overall Similarity', 'Filtered from the Report', 'Match Groups', 'Top Sources', 'Integrity Flags']) assert.ok(xml.includes(s), `Word export has "${s}"`);
  console.log("  ✓ Word / PDF export in Turnitin's layout: cover page, Integrity Overview, top sources, highlighted submission");

  // 7. the reference list matched entry by entry: the same work in another citation style (JATS reference list) is found,
  // another work with words of the same title is not
  const { parseReferenceEntry } = require('../src/parse');
  const apa = 'Ahmad, Y., Fatima, K., Le Quesne, P. W., & Atta-ur-Rahman. (1983). Further alkaloidal constituents of the leaves of Rhazya stricta. Phytochemistry, 22(2), 419-422.';
  const bodyText = Array.from({ length: 30 }, (_, i) => `Sentence ${i} of the manuscript body describes the extraction of leaves in methanol.`).join(' ');
  const prepRef = P.prepare(bodyText, `${apa}\nKhan, R. (2016). Antibacterial activities of Rhazya stricta leaf extracts. Journal of Plant Studies, 4, 1-9.`);
  const entries = P.referenceEntries(prepRef);
  assert.strictEqual(entries.length, 2, 'two entries in the reference list');
  assert.strictEqual(prepRef.words.slice(entries[0].from, entries[0].to).map(w => w.raw).join(' '), apa.replace(' &', ''), 'an entry spans its whole line ("&" is not a word)');
  const norm = t => ` ${SIM.tokenize(t).map(w => w.n).join(' ')} `;
  const ref = parseReferenceEntry(apa, 1);
  assert.ok(P.citesWork(norm('Ahmad Y Fatima K Le Quesne PW Atta-ur-Rahman Further alkaloidal constituents of the leaves of Rhazya stricta Phytochemistry 1983 22 419 422'), ref), 'same work, other style');
  assert.ok(!P.citesWork(norm('Smith J Further alkaloidal constituents of the leaves of Rhazya stricta Planta Med 2001'), ref), 'same title words, other first author');
  assert.ok(!P.citesWork(norm('Ahmad Y Alkaloidal constituents of Rhazya stricta roots 1990'), ref), 'other title');
  console.log('  ✓ reference list matched entry by entry, whatever the citation style');
  console.log('similarity Turnitin features test passed');
})().catch(e => { console.error(e); process.exit(1); });
