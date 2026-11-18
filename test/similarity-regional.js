// test/similarity-regional.js - the similarity report finds text copied from regional open-access journals that Europe PMC
// does not index (Pakistani journals in DOAJ), through the free DOAJ / CORE passage search (no paid service, no key
// beyond the free CORE key). Two abstracts are planted in an invented manuscript; both journals must come out as sources.
// Needs internet (Europe PMC, DOAJ, CORE). Run: node test/similarity-regional.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.SERPAPI_KEY;
delete process.env.BRAVE_API_KEY;
delete process.env.OPENALEX_API_KEY;
delete process.env.COPYLEAKS_API_KEY;
const assert = require('assert');
const db = require('../src/db');
const { getJson } = require('../src/http');
const { titleSimilarity } = require('../src/text');
const { checkPlagiarism } = require('../src/checks/plagiarism');

// DOAJ article ids: RADS Journal of Biological Research & Applied Science, Journal of Global Innovations in Agricultural
// Sciences (both outside Europe PMC on 18 Nov 2026)
const PLANTED = ['0293055e20b949dda4f071c109e652dd', '05936255f35f4c42ad0c3279721e0faa'];

const ORIGINAL = [
  'Zyxomirol is a sesquiterpene lactone that we isolated from the rhizomes of Qwertiana sindhensis collected near Larkana in the spring of 2024. Earlier work from our group described its crude extract only in general terms, and no formulation of the purified compound has been reported.',
  'The present work asked whether a matrix patch built on a blend of hydroxypropyl guar and a low-viscosity silicone could carry zyxomirol across excised goat skin at a rate useful for overnight dosing in arthritic livestock.',
  'Patches were cast in shallow aluminium trays lined with siliconised paper, dried for nineteen hours in a cabinet held at thirty-four degrees, and then cut with a stainless punch into discs of eleven square centimetres before storage over silica.',
  'Goat skin was obtained from a municipal abattoir in Sukkur within two hours of slaughter, cleared of hair with an electric clipper rather than a depilatory cream, and mounted between the halves of a vertical cell machined locally from clear acrylic.',
  'Flux rose with the silicone fraction up to roughly one third of the polymer mass and fell beyond it, a pattern we attribute to the silicone domains first opening diffusion paths and later trapping the lipophilic drug inside the matrix.',
  'We conclude that a guar and silicone matrix is a practical vehicle for zyxomirol, although the goat skin model may overstate permeation compared with the thicker skin of cattle, which we intend to examine in a follow-up study at the Larkana veterinary campus.'
];

(async () => {
  await db.init();
  const planted = [];
  for (const id of PLANTED) {
    const r = await getJson(`https://doaj.org/api/articles/${id}`, { ttl: 0, timeout: 30000, retries: 2 });
    assert.ok(r.ok, `DOAJ article ${id} could not be read`);
    planted.push({ journal: r.data.bibjson.journal.title, title: r.data.bibjson.title, abstract: r.data.bibjson.abstract.replace(/\s+/g, ' ').trim() });
  }
  const body = ['Introduction', ORIGINAL[0], planted[0].abstract, ORIGINAL[1], 'Methods', ORIGINAL[2], ORIGINAL[3], planted[1].abstract, 'Results', ORIGINAL[4], ORIGINAL[5]].join('\n\n');
  const t0 = Date.now();
  const rep = await checkPlagiarism({ body, meta: { title: 'A guar and silicone matrix patch for zyxomirol' } });
  const plantedWords = planted.reduce((n, p) => n + p.abstract.split(' ').length, 0);
  const total = body.split(/\s+/).length;
  console.log(`  Similarity Index ${rep.summary?.similarity}% (planted ${Math.round(plantedWords / total * 100)}%), ${Math.round((Date.now() - t0) / 1000)} s`);
  for (const s of (rep.sources || []).slice(0, 6)) console.log(`   - ${s.percent}%  ${s.title?.slice(0, 70)} | ${s.journal || ''} | ${s.via}`);
  assert.ok(rep.summary.similarity >= 45, 'the two planted abstracts are counted');
  for (const p of planted) {
    const hit = (rep.sources || []).find(s => s.title && titleSimilarity(s.title, p.title) >= 0.8 && s.percent >= 10);
    assert.ok(hit, `planted abstract from ${p.journal} not found`);
    console.log(`  ✓ found: ${p.journal}`);
  }
  console.log('similarity regional test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
