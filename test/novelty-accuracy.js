// test/novelty-accuracy.js - the novelty assessment on cases whose answer is clear (live OpenAlex and Europe PMC):
//   A. a near-duplicate of a published paper (its real abstract, a reworded title): the paper must be found as the closest
//      work and novelty rated low
//   B. an invented, genuinely new study: a clearly higher score and a much lower closest-work similarity
// Run: node test/novelty-accuracy.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
const assert = require('assert');
const db = require('../src/db');
const { getJson } = require('../src/http');
const { checkNovelty } = require('../src/checks/novelty');

(async () => {
  await db.init();
  const r = await getJson('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&query=PMCID:PMC7906618', { ttl: 0, timeout: 30000, retries: 2 });
  const paper = r.data?.resultList?.result?.[0];
  assert.ok(paper?.abstractText, 'source abstract downloaded');
  const abstract = String(paper.abstractText).replace(/<[^>]+>/g, ' ');

  const t0 = Date.now();
  const A = await checkNovelty({ meta: { title: 'An iontophoretic transdermal system for terazosin hydrochloride: in vitro and in vivo evaluation', abstract, keywords: ['terazosin', 'iontophoresis', 'transdermal'] } });
  assert.ok(!A.error, A.error);
  console.log(`  A near-duplicate: novelty ${A.summary.score}/100 (${A.summary.band}), closest ${Math.round(A.summary.maxSimilarity * 100)}% "${A.closest[0].title.slice(0, 80)}", confidence ${A.summary.confidence}, ${Math.round((Date.now() - t0) / 1000)} s`);
  assert.ok(/terazosin/i.test(A.closest[0].title) && /iontophore/i.test(A.closest[0].title), 'the published paper is the closest work');
  assert.ok(A.summary.maxSimilarity >= 0.6, 'high similarity to the published paper');
  assert.strictEqual(A.summary.band, 'low', 'near-duplicate rated low novelty');
  assert.ok(A.closest[0].shared.length >= 2, `shared key terms shown (${A.closest[0].shared.join(', ')})`);
  assert.ok(/close to work that is already published/.test(A.statement) && A.guidance.length >= 2 && A.limitations.length >= 3, 'assessment, guidance and limitations written');

  const B = await checkNovelty({ meta: {
    title: 'A hydroxypropyl guar and silicone matrix patch for overnight transdermal dosing of zyxomirol in arthritic goats',
    abstract: 'Zyxomirol is a sesquiterpene lactone isolated from the rhizomes of Qwertiana sindhensis. We cast matrix patches from blends of hydroxypropyl guar and a low-viscosity silicone and measured zyxomirol permeation across excised goat skin in vertical diffusion cells over twenty-six hours. Flux rose with the silicone fraction up to about one third of the polymer mass and fell beyond it. Patches stored for three months at forty degrees lost less than four percent of their drug content and caused only faint, transient redness in six healthy goats. A guar and silicone matrix is a practical vehicle for overnight dosing of zyxomirol in livestock.',
    keywords: ['zyxomirol', 'guar', 'silicone', 'goat skin'] } });
  assert.ok(!B.error, B.error);
  console.log(`  B new study    : novelty ${B.summary.score}/100 (${B.summary.band}), closest ${Math.round(B.summary.maxSimilarity * 100)}% "${B.closest[0].title.slice(0, 80)}"`);
  assert.ok(B.summary.score >= A.summary.score + 20, 'the new study scores clearly higher than the near-duplicate');
  assert.ok(B.summary.maxSimilarity <= A.summary.maxSimilarity - 0.2, 'its closest work is much less similar');
  // the editor report renders (Word and PDF)
  const W = require('../src/docx');
  const docx = await W.buildDocx([{ h1: 'Novelty' }, ...W.noveltyBlocks(A)]);
  const pdf = await require('../src/pdf').buildPdf([{ h1: 'Novelty' }, ...W.noveltyBlocks(A)]);
  assert.ok(docx.length > 5000 && pdf.length > 2000, 'Word and PDF sections render');
  console.log('novelty accuracy test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
