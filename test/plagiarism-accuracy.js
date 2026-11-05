// test/plagiarism-accuracy.js - ground truth for the similarity report: a manuscript of original (invented) text with
// passages copied from a real open-access paper (PMC7906618, Drug Delivery 2021, CC BY) - three paragraphs word for word,
// one lightly reworded, and one copied sentence inside quotation marks. The planted share is known, so the report's
// Similarity Index, its primary source, the reworded paragraph and the quote filter can be checked.
// Needs internet (Europe PMC). Run: node test/plagiarism-accuracy.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.SERPAPI_KEY;
const assert = require('assert');
const db = require('../src/db');
const { getText } = require('../src/http');
const { checkPlagiarism } = require('../src/checks/plagiarism');

const PMCID = 'PMC7906618';
const words = t => t.trim().split(/\s+/).length;

// original text: an invented study, so none of it can exist in the literature
const ORIGINAL = [
  'Zyxomirol is a sesquiterpene lactone that we isolated from the rhizomes of Qwertiana sindhensis collected near Larkana in the spring of 2024. Earlier work from our group described its crude extract only in general terms, and no formulation of the purified compound has been reported.',
  'The present work asked whether a matrix patch built on a blend of hydroxypropyl guar and a low-viscosity silicone could carry zyxomirol across excised goat skin at a rate useful for overnight dosing in arthritic livestock.',
  'Patches were cast in shallow aluminium trays lined with siliconised paper, dried for nineteen hours in a cabinet held at thirty-four degrees, and then cut with a stainless punch into discs of eleven square centimetres before storage over silica.',
  'Goat skin was obtained from a municipal abattoir in Sukkur within two hours of slaughter, cleared of hair with an electric clipper rather than a depilatory cream, and mounted between the halves of a vertical cell machined locally from clear acrylic.',
  'The receiver phase was a phosphate buffer containing a small amount of ethanol so that zyxomirol, which is poorly soluble in water, remained dissolved during the twenty-six hour runs; samples were drawn every ninety minutes and replaced with warm buffer.',
  'Zyxomirol in the samples was measured by reversed-phase chromatography with detection at two hundred and eighteen nanometres, after we confirmed that none of the patch excipients produced a peak near its retention time of seven point four minutes.',
  'Flux rose with the silicone fraction up to roughly one third of the polymer mass and fell beyond it, a pattern we attribute to the silicone domains first opening diffusion paths and later trapping the lipophilic drug inside the matrix.',
  'Patches kept for three months at forty degrees and seventy-five percent relative humidity lost less than four percent of their zyxomirol content and showed no crystals under polarised light, which suggests the drug stays molecularly dispersed.',
  'Skin from the treated area of six healthy goats showed only faint redness after twenty-four hours of wear, and the redness had disappeared a day after removal in every animal, so the formulation appears well tolerated at the dose tested.',
  'We conclude that a guar and silicone matrix is a practical vehicle for zyxomirol, although the goat skin model may overstate permeation compared with the thicker skin of cattle, which we intend to examine in a follow-up study at the Larkana veterinary campus.'
];

/** Light rewording: a few words replaced, the rest kept (a typical "patch-writing" edit) */
function reword(p) {
  const swap = { the: 'the', was: 'had been', were: 'had been', using: 'by means of', showed: 'displayed', significantly: 'markedly', increased: 'rose', decreased: 'fell', obtained: 'gained', used: 'employed' };
  let n = 0;
  return p.split(' ').map(w => { const k = w.toLowerCase(); if (swap[k] && swap[k] !== k && ++n % 2) return swap[k]; return w; }).join(' ');
}

(async () => {
  await db.init();
  const r = await getText(`https://www.ebi.ac.uk/europepmc/webservices/rest/${PMCID}/fullTextXML`, { ttl: 0, timeout: 60000, retries: 2 });
  assert.ok(r.ok, `full text of ${PMCID} downloaded`);
  const body = (String(r.text).match(/<body>[\s\S]*<\/body>/) || [''])[0];
  const paras = [...body.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => m[1].replace(/<xref[^>]*>[\s\S]*?<\/xref>/g, '').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim())
    .filter(p => words(p) >= 60 && words(p) <= 160 && !/[“”"]/.test(p));
  assert.ok(paras.length >= 6, 'enough paragraphs in the source');
  // the second copied paragraph gets an in-text citation of its own after its first sentence (a copier's usual edit)
  const cited = paras[3].replace(/^(.{40,}?[a-z])\. (?=[A-Z])/, '$1 (Khan et al., 2021). ');
  const copied = [paras[1], cited, paras[5]];
  const edited = reword(paras[4]);
  const quoteSentence = paras[2].split(/(?<=\.)\s+/).find(s => words(s) >= 15 && words(s) <= 40) || paras[2].split(' ').slice(0, 25).join(' ');

  const manuscript = ['Introduction', ORIGINAL[0], ORIGINAL[1], copied[0],
    `As the authors of an earlier transdermal study put it, "${quoteSentence}"`,
    'Materials and methods', ORIGINAL[2], ORIGINAL[3], copied[1], ORIGINAL[4], ORIGINAL[5],
    'Results', ORIGINAL[6], edited, ORIGINAL[7], copied[2], ORIGINAL[8],
    'Conclusion', ORIGINAL[9],
    'References', '1. Smith A (2020). A reference that must not be compared. J Test, 1: 1-2.'].join('\n\n');

  const bodyWords = words(manuscript.split(/\nReferences\n/)[0]);
  const plantedVerbatim = copied.reduce((a, p) => a + words(p), 0);
  const plantedEdited = words(edited);
  const plantedShare = (plantedVerbatim + plantedEdited) / bodyWords * 100;

  const t0 = Date.now();
  const rep = await checkPlagiarism({ body: manuscript, meta: { title: 'A guar and silicone matrix patch for zyxomirol: permeation across goat skin' } });
  const secs = Math.round((Date.now() - t0) / 1000);
  assert.ok(!rep.error, rep.error);
  const s = rep.summary;
  const top = rep.sources[0];
  console.log(`  planted: ${plantedVerbatim} words verbatim + ${plantedEdited} reworded of ${bodyWords} = ${plantedShare.toFixed(1)}%`);
  console.log(`  report : Similarity Index ${s.similarity}% (publications ${s.publications}%, internet ${s.internet}%), ${s.sources} source(s), ${secs} s`);
  console.log(`  primary source 1: ${top?.percent}% ${top?.title?.slice(0, 80)} (${top?.via}, ${top?.compared})`);

  assert.ok(top && /terazosin|iontophoresis/i.test(top.title), 'the copied paper is primary source 1');
  assert.ok(Math.abs(s.similarity - plantedShare) <= 6, `Similarity Index ${s.similarity}% within 6 points of the planted ${plantedShare.toFixed(1)}%`);
  assert.strictEqual(Math.round(rep.sources.reduce((a, x) => a + x.percent, 0) * 10) / 10, s.similarity, 'source percentages add up to the index');
  const highlighted = rep.document.filter(d => d.s).map(d => d.t).join(' ');
  for (const [i, p] of copied.entries()) {
    const probe = p.split(' ').slice(10, 22).join(' ');
    assert.ok(highlighted.includes(probe), `verbatim paragraph ${i + 1} highlighted`);
  }
  if (cited !== paras[3]) {
    const seg = rep.document.find(d => d.s && d.t.includes('(Khan et al., 2021)'));
    assert.ok(seg, 'the added citation sits inside one highlighted match (citation markers ignored)');
    console.log('  copied paragraph with an added citation: one match across the citation');
  }
  // share of the reworded paragraph's words inside highlighted text
  const hw = new Set(highlighted.toLowerCase().split(/s+/));
  const ew = edited.toLowerCase().split(/s+/);
  const editedShare = ew.filter(w => hw.has(w)).length / ew.length;
  console.log(`  reworded paragraph: ${Math.round(editedShare * 100)}% of its words highlighted`);
  assert.ok(editedShare >= 0.7, 'reworded paragraph still matched');
  // Turnitin's filters: quotations and the bibliography are compared by default, the editor excludes them
  assert.ok(rep.sections.some(x => x.key === 'references'), 'the reference list is a section of its own');
  const filtered = await require('../src/checks/plagiarism').applySettings(rep, { includeQuotes: false, excludeSections: ['references'] });
  const hiFiltered = filtered.document.filter(d => d.s).map(d => d.t).join(' ');
  assert.ok(!hiFiltered.includes(quoteSentence.split(' ').slice(3, 12).join(' ')), 'quoted sentence excluded by the filter');
  assert.ok(!hiFiltered.includes('must not be compared'), 'bibliography excluded by the filter');
  assert.strictEqual(filtered.filters.bibliography, 'excluded by the editor');
  for (const o of ORIGINAL) assert.ok(!highlighted.includes(o.split(' ').slice(5, 15).join(' ')), 'original text not highlighted');

  // false alarms: the original text alone must score (close to) zero
  const clean = await checkPlagiarism({ body: ['Introduction', ...ORIGINAL.slice(0, 5), 'Results', ...ORIGINAL.slice(5)].join('\n\n'), meta: { title: 'Zyxomirol patch' } });
  console.log(`  original-only manuscript: Similarity Index ${clean.summary.similarity}% (${clean.summary.sources} source(s))`);
  assert.ok(clean.summary.similarity <= 2, 'original text scores at most 2%');

  // no repository (Turnitin's setting for unpublished work): a screened manuscript is never stored, and earlier
  // unpublished PJPS submissions are not compared - checking the same text again finds nothing new
  const { shingles, storeFingerprint } = require('../src/papermill');
  const earlier = ['Introduction', ...ORIGINAL.slice(0, 5), 'Results', ...ORIGINAL.slice(5)].join('\n\n');
  const u = await db.one("INSERT INTO users(email, name, password_hash, role, status) VALUES('ed@test.local', 'Ed', 'x', 'editor', 'active') RETURNING id");
  const ck = await db.one("INSERT INTO checks(user_id, kind, title, result) VALUES($1, 'manuscript', 'Zyxomirol patch (first submission)', '{}') RETURNING id", [u.id]);
  await storeFingerprint({ checkId: ck.id, userId: u.id, meta: { title: 'Zyxomirol patch (first submission)', manuscriptCode: 'PJPS-2026-0001', abstract: 'Zyxomirol patch abstract' }, shingles: shingles(earlier), text: earlier });
  const corpus = require('../src/corpus');
  const st = await corpus.stats();
  assert.ok(!st.submission, 'the manuscript text is not stored in the repository');
  const fp = await db.one("SELECT data FROM fingerprints WHERE manuscript_code = 'PJPS-2026-0001'");
  assert.ok(fp && !fp.data.abstract && !JSON.stringify(fp.data).includes('Zyxomirol'), 'only hashes are kept for Module 4, no readable text');
  const again = await checkPlagiarism({ body: earlier, meta: { title: 'Zyxomirol patch', manuscriptCode: 'PJPS-2026-0999' } });
  console.log(`  same text checked again: Similarity Index ${again.summary.similarity}% (${again.sources.length} source(s)); repository: ${again.repository}`);
  assert.ok(again.summary.similarity <= 2 && !again.sources.some(x => x.type === 'submission'), 'an earlier unpublished submission is not compared');
  console.log(`  repository after the runs: ${JSON.stringify(st)}`);
  assert.ok(st.publication?.docs >= 1, 'downloaded published source text kept in the repository');
  const again2 = await checkPlagiarism({ body: manuscript, meta: { title: 'A guar and silicone matrix patch for zyxomirol: permeation across goat skin' } });
  // the copied paper now comes from the repository (no search needed) with the same matched text; the original text, now a
  // stored submission, is credited to that submission
  const pub = again2.sources.find(x => x.type === 'publication');
  console.log(`  second run: paper found via ${pub?.via}, ${pub?.matchedWords} matched words (first run ${top.matchedWords})`);
  assert.ok(pub && /PJPS repository/.test(pub.via) && Math.abs(pub.matchedWords - top.matchedWords) <= 5, 'second run finds the paper in the repository with the same matched text');
  console.log('plagiarism accuracy test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
