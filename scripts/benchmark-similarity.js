#!/usr/bin/env node
// scripts/benchmark-similarity.js - how well the Similarity Report's matching finds copied text that was disguised, and
// how often it matches text that was not copied. Matching only (the source is given), so the search services do not
// enter the figures.
//
//   paraphrase recall - real paraphrasing-tool output: arXiv paragraphs and their SpinBot / SpinnerChief versions from the
//                       Machine-Paraphrase Corpus (Wahle et al., JCDL 2022; huggingface.co/datasets/jpwahle/
//                       machine-paraphrase-dataset, test split, paired by scripts in D:\pjps-tmp\mpc). Each spun paragraph
//                       is planted among invented paragraphs; the source is the original paragraph inside four other
//                       arXiv paragraphs. Recall = share of the spun paragraph's words matched.
//   false matches     - the invented paragraphs (must never match), and real open-access pharmacy papers compared with
//                       other papers on the same subject (Europe PMC): words matched only by the paraphrase pass.
//
//   node scripts/benchmark-similarity.js [--n 100] [--pairs D:\pjps-tmp\mpc] [--topics 8] [--exact] [--heldout] [--json out.json]
process.env.PGLITE_DIR = process.env.PGLITE_DIR || 'memory://';
delete process.env.DATABASE_URL;
const fs = require('fs');
const path = require('path');
const P = require('../src/checks/plagiarism');
const { getJson, getText } = require('../src/http');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const N = parseInt(opt('n', '100'), 10);
const DIR = opt('pairs', 'D:\\pjps-tmp\\mpc');
const TOPICS = parseInt(opt('topics', '8'), 10);
const EXACT = args.includes('--exact'); // exact matching only (the engine before the paraphrase pass)
if (opt('para')) Object.assign(P.PARA, JSON.parse(opt('para'))); // thresholds of the reworded-sentence pass, for tuning
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
// --heldout: another sample of pairs (offset by half a step) and other subjects than the thresholds were fitted on
const HELDOUT = args.includes('--heldout');

// invented text (test/plagiarism-accuracy.js): none of it exists in the literature
const ORIGINAL = [
  'Zyxomirol is a sesquiterpene lactone that we isolated from the rhizomes of Qwertiana sindhensis collected near Larkana in the spring of 2024. Earlier work from our group described its crude extract only in general terms, and no formulation of the purified compound has been reported.',
  'The present work asked whether a matrix patch built on a blend of hydroxypropyl guar and a low-viscosity silicone could carry zyxomirol across excised goat skin at a rate useful for overnight dosing in arthritic livestock.',
  'Patches were cast in shallow aluminium trays lined with siliconised paper, dried for nineteen hours in a cabinet held at thirty-four degrees, and then cut with a stainless punch into discs of eleven square centimetres before storage over silica.',
  'Goat skin was obtained from a municipal abattoir in Sukkur within two hours of slaughter, cleared of hair with an electric clipper rather than a depilatory cream, and mounted between the halves of a vertical cell machined locally from clear acrylic.',
  'Flux rose with the silicone fraction up to roughly one third of the polymer mass and fell beyond it, a pattern we attribute to the silicone domains first opening diffusion paths and later trapping the lipophilic drug inside the matrix.',
  'We conclude that a guar and silicone matrix is a practical vehicle for zyxomirol, although the goat skin model may overstate permeation compared with the thicker skin of cattle, which we intend to examine in a follow-up study at the Larkana veterinary campus.'
];
const words = t => String(t).trim().split(/\s+/).length;
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

async function match(prep, text) {
  return EXACT ? P.overlap(prep, text) : P.match(prep, text);
}

/** Matched words of the manuscript inside [from, to) character offsets */
const matchedIn = (prep, hit, from, to) => prep.words.reduce((a, w, k) => a + (hit[k] && w.start >= from && w.end <= to ? 1 : 0), 0);
const wordsIn = (prep, from, to) => prep.words.filter(w => w.start >= from && w.end <= to).length;

async function paraphraseRecall(method, file) {
  const pairs = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')).filter(p => words(p.original) >= 60 && words(p.paraphrased) >= 60);
  // a fixed sample, spread over the file
  const sample = Array.from({ length: Math.min(N, pairs.length) }, (_, i) => pairs[Math.floor((i + (HELDOUT ? 0.5 : 0)) * pairs.length / Math.min(N, pairs.length))]);
  let planted = 0, found = 0, falseW = 0, invented = 0, detected = 0;
  const per = [];
  for (const [i, p] of sample.entries()) {
    const others = [1, 2, 3, 4].map(k => pairs[(pairs.indexOf(p) + k * 37) % pairs.length].original);
    const source = [others[0], others[1], p.original, others[2], others[3]].join('\n\n');
    const head = ['Introduction', ORIGINAL[0], ORIGINAL[1], ORIGINAL[2], ''].join('\n\n');
    const manuscript = `${head}${p.paraphrased.trim()}\n\n${['Results', ORIGINAL[3], ORIGINAL[4], ORIGINAL[5]].join('\n\n')}`;
    const prep = P.prepare(manuscript);
    const o = await match(prep, source);
    const from = head.length, to = head.length + p.paraphrased.trim().length;
    const n = wordsIn(prep, from, to), m = matchedIn(prep, o.hit, from, to);
    const all = o.hit.reduce((a, h) => a + h, 0);
    planted += n; found += m; falseW += all - m; invented += prep.words.length - n;
    if (m / n >= 0.5) detected++;
    per.push(Math.round(m / n * 100));
    if ((i + 1) % 25 === 0) process.stdout.write(`  ${method}: ${i + 1}/${sample.length}\r`);
  }
  per.sort((a, b) => a - b);
  return { method, pairs: sample.length, recall: Math.round(found / planted * 1000) / 10, paragraphsHalfFound: `${detected}/${sample.length}`, medianParagraph: per[per.length >> 1],
    inventedWordsMatched: falseW, inventedWords: invented };
}

/** Body text of an open-access paper (Europe PMC full text, without references, tables and figures) */
async function body(pmcid) {
  const r = await getText(`${EPMC}/${pmcid}/fullTextXML`, { ttl: 90 * 86400, timeout: 60000, retries: 2 });
  if (!r.ok) return '';
  const b = (String(r.text).match(/<body>[\s\S]*<\/body>/) || [''])[0];
  return [...b.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => m[1].replace(/<(table-wrap|fig)\b[\s\S]*?<\/\1>/g, ' ').replace(/<xref[^>]*>[\s\S]*?<\/xref>/g, '').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()).filter(p => words(p) >= 25).join('\n\n');
}

async function sameTopic() {
  const subjects = ['transdermal patch permeation', 'solid lipid nanoparticles', 'antibacterial activity plant extract', 'hepatoprotective activity rats',
    'dissolution enhancement solid dispersion', 'antidiabetic activity streptozotocin', 'HPLC method validation tablets', 'antioxidant activity flavonoids', 'mucoadhesive buccal tablets', 'microsponges topical gel'];
  if (HELDOUT) subjects.splice(0, subjects.length, 'ophthalmic in situ gel', 'nanoemulsion oral bioavailability', 'anti-inflammatory carrageenan paw edema', 'antimicrobial resistance hospital isolates',
    'floating gastroretentive tablets', 'niosomes topical delivery', 'wound healing activity ointment', 'anticancer activity MCF-7 extract');
  const rows = [];
  for (const q of subjects.slice(0, TOPICS)) {
    const r = await getJson(`${EPMC}/search?format=json&resultType=lite&pageSize=12&query=${encodeURIComponent(`(${q}) AND OPEN_ACCESS:y AND HAS_FT:y AND PUB_YEAR:[2015 TO 2024]`)}`, { ttl: 90 * 86400, timeout: 30000, retries: 2 });
    const ids = (r.ok ? r.data.resultList?.result || [] : []).map(x => x.pmcid).filter(Boolean).slice(0, 6);
    const texts = (await Promise.all(ids.map(body))).map((t, i) => ({ id: ids[i], t })).filter(x => words(x.t) >= 1500);
    if (texts.length < 3) continue;
    const [a, ...rest] = texts;
    const prep = P.prepare(a.t);
    for (const b of rest) {
      const ex = P.overlap(prep, b.t);
      const o = await match(prep, b.t);
      const exact = ex.hit.reduce((s, h) => s + h, 0), all = o.hit.reduce((s, h) => s + h, 0);
      const extra = o.passages.filter(p => p.paraphrased).map(p => ({ words: p.words, text: p.text.slice(0, 200), source: (p.source || '').slice(0, 200) }));
      rows.push({ subject: q, a: a.id, b: b.id, words: prep.words.length, exact, added: all - exact, extra });
    }
    process.stdout.write(`  same subject: ${rows.length} pairs\r`);
  }
  const W = rows.reduce((s, r) => s + r.words, 0);
  return { pairs: rows.length, words: W, exactMatched: rows.reduce((s, r) => s + r.exact, 0), addedByParaphrase: rows.reduce((s, r) => s + r.added, 0),
    pairsWithAdded: rows.filter(r => r.added > 0).length, addedPercent: Math.round(rows.reduce((s, r) => s + r.added, 0) / W * 10000) / 100, rows };
}

(async () => {
  await P.shared();
  const t0 = Date.now();
  console.log(`Similarity matching benchmark (${EXACT ? 'exact matching only' : 'exact + paraphrase'})`);
  const recall = [];
  for (const [m, f] of [['SpinBot', 'mpc-arxiv-spinbot.json'], ['SpinnerChief', 'mpc-arxiv-pairs.json']]) {
    if (!fs.existsSync(path.join(DIR, f))) { console.log(`  ${m}: ${f} not found in ${DIR}`); continue; }
    const r = await paraphraseRecall(m, f);
    recall.push(r);
    console.log(`  ${m.padEnd(13)} recall ${r.recall}% of spun words | paragraphs >= half found ${r.paragraphsHalfFound} | median paragraph ${r.medianParagraph}% | invented words matched ${r.inventedWordsMatched}/${r.inventedWords}`);
  }
  const neg = TOPICS ? await sameTopic() : null;
  if (neg) console.log(`  same subject, not copied: ${neg.pairs} paper pairs, ${neg.words} words | exact matches ${neg.exactMatched} | added by the paraphrase pass ${neg.addedByParaphrase} (${neg.addedPercent}%) in ${neg.pairsWithAdded} pair(s)`);
  if (neg) for (const r of neg.rows.filter(x => x.extra.length)) for (const e of r.extra.slice(0, 3)) console.log(`    ${r.a}~${r.b} ${e.words}w\n      M: ${e.text}\n      S: ${e.source}`);
  console.log(`  ${Math.round((Date.now() - t0) / 1000)} s`);
  if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify({ exact: EXACT, recall, sameSubject: neg }, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
