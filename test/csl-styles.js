// test/csl-styles.js - Module 2 journal styles from CSL files (offline: real style files from the Zotero Style
// Repository are kept in test/fixtures). Run: node test/csl-styles.js
process.env.PGLITE_DIR = 'memory://';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const db = require('../src/db');
const CSL = require('../src/csl');
const ST = require('../src/styles');
const fx = n => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

const rec = { authors: [{ family: 'Khan', given: 'Ahmad' }, { family: 'Ali', given: 'Sara B.' }, { family: 'Shah', given: 'C' }], title: 'Antibacterial activity of medicinal plants', journal: 'Pakistan Journal of Pharmaceutical Sciences', journalAbbrev: 'Pak J Pharm Sci', year: 2019, volume: '32', issue: '1', pages: '1-5', doi: '10.1234/abc', type: 'journal-article' };

(async () => {
  await db.init();
  // what a style file says about itself
  const apa = CSL.describe(fx('apa.csl'));
  assert.ok(apa.kind === 'author-date' && !apa.dependent && apa.hasBibliography, JSON.stringify(apa));
  const aps = CSL.describe(fx('acta-pharmacologica-sinica.csl'));
  assert.ok(aps.dependent && /nature$/.test(aps.parent) && aps.kind === 'numeric');
  assert.throws(() => CSL.describe('<html><body>not a style</body></html>'), /not a CSL style/);
  console.log('  ✓ style files described (independent / dependent, numeric / author-date); other files refused');

  // install: an independent style, and a dependent journal style with its parent
  const a = await CSL.install(fx('apa.csl'), { by: 'test', name: 'apa' });
  await assert.rejects(CSL.install(fx('acta-pharmacologica-sinica.csl'), { by: 'test' }), /journal alias/);
  const n = await CSL.install(fx('acta-pharmacologica-sinica.csl'), { by: 'test', name: 'acta-pharmacologica-sinica', fetchParent: async () => fx('nature.csl') });
  assert.deepStrictEqual([a.key, n.key], ['csl:apa', 'csl:acta-pharmacologica-sinica']);
  assert.ok(ST.styleList().some(s => s.key === 'csl:apa' && s.custom), 'offered next to the built-in styles');
  console.log('  ✓ installed; a journal alias needs its parent style');

  // formatting follows the style file; APA from the repository equals the built-in APA 7
  assert.strictEqual(ST.toText(ST.entry(rec, 'csl:apa')), ST.formatText(rec, 'apa7'));
  const segs = ST.entry(rec, 'csl:apa');
  assert.ok(segs.some(s => s.i && /Pakistan Journal of Pharmaceutical Sciences/.test(s.t)), 'journal name in italics');
  assert.strictEqual(ST.toText(ST.inText('csl:apa', { records: [rec] })), '(Khan et al., 2019)');
  assert.strictEqual(ST.toText(ST.entry(rec, 'csl:acta-pharmacologica-sinica')), 'Khan, A., Ali, S. B. & Shah, C. Antibacterial activity of medicinal plants. Pak J Pharm Sci 32, 1–5 (2019).');
  const sup = ST.inText('csl:acta-pharmacologica-sinica', { nums: [3, 1, 2, 7] });
  assert.ok(sup[0].sup && sup[0].t === '1–3,7', JSON.stringify(sup));
  assert.strictEqual(ST.toText(ST.entry({ ...rec, yearSuffix: 'b' }, 'csl:apa')).includes('(2019b)'), true, 'a/b letters kept');
  // one style used for several different references in a row (citeproc caches items by id)
  const other = { authors: [{ family: 'LeCun', given: 'Yann' }, { family: 'Bengio', given: 'Y' }], title: 'Deep learning', journal: 'Nature', year: 2015, volume: '521', issue: '7553', pages: '436-444', type: 'journal-article' };
  assert.match(ST.toText(ST.entry(other, 'csl:apa')), /^LeCun, Y\., & Bengio, Y\. \(2015\)\. Deep learning/);
  assert.match(ST.toText(ST.entry(rec, 'csl:apa')), /^Khan, A\./);
  assert.strictEqual(ST.toText(ST.inText('csl:apa', { records: [other] })), '(LeCun & Bengio, 2015)');
  console.log('  ✓ entries and in-text citations follow the style files (APA = built-in APA 7; Nature family superscript)');

  // whole list through the Module 2 converter (no online lookup)
  const { restyleList } = require('../src/tools/restyle');
  const out = await restyleList('Khan A, Ali SB, Shah C (2019). Antibacterial activity of medicinal plants. Pak J Pharm Sci 32(1): 1-5.', 'csl:apa', { lookup: false });
  assert.strictEqual(out.style, 'csl:apa');
  assert.match(out.entries?.[0]?.text || JSON.stringify(out).slice(0, 400), /Khan, A\., Ali, S\. B\., & Shah, C\. \(2019\)/);
  console.log('  ✓ Module 2 converts a list to an installed journal style');

  await CSL.remove('csl:apa');
  assert.ok(!ST.styleList().some(s => s.key === 'csl:apa'), 'removed');
  assert.strictEqual(ST.styleKey('csl:apa'), 'pjps', 'a removed style falls back to PJPS');
  console.log('csl styles test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
