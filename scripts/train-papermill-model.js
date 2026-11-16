// train-papermill-model.js - trains Module 4's paper-mill classifier (src/papermill/millModel.json): a logistic model on the
// meaning of a manuscript's title + abstract (the all-MiniLM-L6-v2 sentence embedding the look-alike signal already uses),
// learned from papers retracted for paper-mill reasons (Retraction Watch, ~13,400 abstracts in mill-embeddings.bin) against
// ordinary papers OF THE SAME JOURNALS AND YEARS (Europe PMC, free), balanced journal by journal, so the model learns
// what mill papers have in common, not which journals or topics they come from.
// Measured two ways: 5-fold cross-validation BY JOURNAL (the test journals are never seen in training), and on the
// separate Module 4 benchmark (150 mill / 126 ordinary full texts, data/benchmark/results.json), whose papers are removed
// from the training data, combined with the live tool's other signals exactly as Module 4 adds them up.
// Phases (each resumable):
//   node scripts/train-papermill-model.js controls   - ordinary papers from Europe PMC -> data/papermill/controls.jsonl
//   node scripts/train-papermill-model.js embed      - their embeddings -> data/papermill/controls-emb.bin
//   node scripts/train-papermill-model.js train      - cross-validation, benchmark, writes src/papermill/millModel.json
require('../src/config');
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const db = require('../src/db');
const D = require('../src/datasets');

const DIR = path.join(cfg.DATA_DIR, 'papermill');
const CTL = path.join(DIR, 'controls.jsonl'), CTL_EMB = path.join(DIR, 'controls-emb.bin');
const BENCH = path.join(__dirname, '..', 'data', 'benchmark');
const OUT = path.join(__dirname, '..', 'src', 'papermill', 'millModel.json');
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const PER_JOURNAL = 150, DIM = 384, FOLDS = 5;
const NOTE = 0.65;   // below the limit a 1-point note from here (at 0.5 it was on 12% of 600 published PJPS articles, at 0.65 on fewer)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const textOf = (title, abs) => `${title}. ${abs}`.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600);   // as build-mill-embeddings.js
const jkey = j => String(j || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const phase = process.argv[2];

async function millByJournal() {
  const info = JSON.parse(fs.readFileSync(path.join(DIR, 'mill-embeddings.json'), 'utf8'));
  const rows = await db.all(`SELECT doi, journal, retraction_date FROM retractions WHERE nature ILIKE '%retraction%' AND reason ~* $1`, [D.MILL_REASON]);
  const meta = new Map(rows.map(r => [String(r.doi || '').toLowerCase().trim(), r]));
  const by = new Map();
  info.dois.forEach((doi, i) => {
    const r = meta.get(doi);
    if (!r || !r.journal) return;
    const k = jkey(r.journal);
    if (!by.has(k)) by.set(k, { journal: r.journal, items: [] });
    by.get(k).items.push({ i, doi, year: parseInt((String(r.retraction_date || '').match(/\b(19|20)\d\d\b/) || [])[0], 10) || null });
  });
  return { by, info };
}

async function controls() {
  const { by } = await millByJournal();
  const have = new Map();
  if (fs.existsSync(CTL)) for (const l of fs.readFileSync(CTL, 'utf8').split('\n')) if (l) { try { const r = JSON.parse(l); have.set(r.journalKey, (have.get(r.journalKey) || 0) + (r.doi ? 1 : 0)); } catch { /* torn line */ } }
  const retracted = new Set((await db.all('SELECT doi FROM retractions WHERE doi IS NOT NULL')).map(r => String(r.doi).toLowerCase().trim()));
  const fd = fs.openSync(CTL, 'a');
  const list = [...by.entries()].filter(([, v]) => v.items.length >= 5).sort((a, b) => b[1].items.length - a[1].items.length);
  let n = 0;
  for (const [k, v] of list) {
    if (have.has(k)) continue;
    const years = v.items.map(x => x.year).filter(Boolean).sort((a, b) => a - b);
    const y0 = (years[0] || 2018) - 3, y1 = years[years.length - 1] || 2025;
    const want = Math.min(PER_JOURNAL, v.items.length);
    const q = `JOURNAL:"${v.journal.replace(/"/g, '')}" AND PUB_YEAR:[${y0} TO ${y1}] AND HAS_ABSTRACT:y`;
    let got = 0;
    try {
      const r = await fetch(`${EPMC}?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${Math.min(1000, want * 3)}`, { headers: { 'user-agent': 'PJPS-papermill-training' }, signal: AbortSignal.timeout(90000) });
      const res = r.ok ? ((await r.json()).resultList?.result || []) : [];
      const pool = res.filter(x => x.doi && x.abstractText && x.title && !retracted.has(x.doi.toLowerCase()) && String(x.abstractText).length > 200);
      // spread over the result list (not the first page of one year)
      const step = Math.max(1, pool.length / want);
      for (let i = 0; i < pool.length && got < want; i += step, got++) {
        const x = pool[Math.floor(i)];
        fs.writeSync(fd, JSON.stringify({ journalKey: k, journal: v.journal, doi: x.doi.toLowerCase(), year: +x.pubYear || null, text: textOf(x.title, x.abstractText) }) + '\n');
      }
    } catch (e) { console.warn(`\n${v.journal}: ${e.message}`); continue; }
    if (!got) fs.writeSync(fd, JSON.stringify({ journalKey: k, journal: v.journal, doi: null }) + '\n');   // nothing in Europe PMC: not asked again
    process.stdout.write(`\r${++n}/${list.length} journals, ${v.journal.slice(0, 40).padEnd(40)} ${got} controls   `);
    await sleep(250);
  }
  fs.closeSync(fd);
  console.log('\ncontrols done');
}

// Crossref (free) for the journals Europe PMC holds few papers of (engineering and computing titles of the mass special
// issues): random papers with an abstract, journal found by its exact title, same years, retracted papers left out
async function crossrefControls() {
  const { by } = await millByJournal();
  const have = new Map();
  for (const r of readControls()) have.set(r.journalKey, (have.get(r.journalKey) || 0) + 1);
  const asked = new Set();
  for (const l of fs.readFileSync(CTL, 'utf8').split('\n')) if (l.includes('"crossref":true')) { try { asked.add(JSON.parse(l).journalKey); } catch { /* torn line */ } }
  const retracted = new Set((await db.all('SELECT doi FROM retractions WHERE doi IS NOT NULL')).map(r => String(r.doi).toLowerCase().trim()));
  const fd = fs.openSync(CTL, 'a');
  const get = async url => { const r = await fetch(url, { headers: { 'user-agent': 'PJPS-papermill-training (Softsols)' }, signal: AbortSignal.timeout(60000) }); return r.ok ? r.json() : null; };
  const list = [...by.entries()].filter(([k, v]) => v.items.length >= 5 && (have.get(k) || 0) < Math.min(PER_JOURNAL, v.items.length) && !asked.has(k)).sort((a, b) => b[1].items.length - a[1].items.length);
  let n = 0;
  for (const [k, v] of list) {
    let got = 0;
    try {
      const j = await get(`https://api.crossref.org/journals?query=${encodeURIComponent(v.journal)}&rows=5`);
      const hit = (j?.message?.items || []).find(x => jkey(x.title) === k);
      if (hit?.ISSN?.length) {
        const years = v.items.map(x => x.year).filter(Boolean).sort((a, b) => a - b);
        const y0 = (years[0] || 2018) - 3, y1 = years[years.length - 1] || 2025;
        const want = Math.min(PER_JOURNAL, v.items.length) - (have.get(k) || 0);
        const seen = new Set();
        for (let round = 0; round < 3 && got < want; round++) {
          const w = await get(`https://api.crossref.org/journals/${hit.ISSN[0]}/works?filter=has-abstract:true,type:journal-article,from-pub-date:${y0},until-pub-date:${y1}&sample=100&select=DOI,title,abstract,issued`);
          for (const x of w?.message?.items || []) {
            const doi = String(x.DOI || '').toLowerCase(), abs = String(x.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (!doi || seen.has(doi) || retracted.has(doi) || abs.length < 200 || !x.title?.[0] || got >= want) continue;
            seen.add(doi);
            fs.writeSync(fd, JSON.stringify({ journalKey: k, journal: v.journal, doi, year: x.issued?.['date-parts']?.[0]?.[0] || null, text: textOf(x.title[0], abs), via: 'crossref' }) + '\n');
            got++;
          }
          await sleep(300);
        }
      }
    } catch (e) { console.warn(`\n${v.journal}: ${e.message}`); }
    fs.writeSync(fd, JSON.stringify({ journalKey: k, journal: v.journal, doi: null, crossref: true }) + '\n');
    process.stdout.write(`\r${++n}/${list.length} journals, ${v.journal.slice(0, 40).padEnd(40)} ${got} from Crossref   `);
  }
  fs.closeSync(fd);
  console.log('\ncrossref controls done');
}

const readControls = () => {
  const seen = new Set(), out = [];
  for (const l of fs.readFileSync(CTL, 'utf8').split('\n')) {
    if (!l) continue;
    try { const r = JSON.parse(l); if (r.doi && !seen.has(r.doi)) { seen.add(r.doi); out.push(r); } } catch { /* torn line */ }
  }
  return out;
};

async function embed() {
  const E = require('../src/tools/embed');
  const ctl = readControls();
  const done = fs.existsSync(CTL_EMB) ? fs.statSync(CTL_EMB).size / DIM : 0;
  const t0 = Date.now();
  for (let i = done; i < ctl.length; i += 128) {
    const part = ctl.slice(i, i + 128);
    const vecs = await E.embed(part.map(x => x.text), { batch: 16 });
    if (!vecs) throw new Error('the language model could not be loaded');
    const buf = new Int8Array(part.length * DIM);
    vecs.forEach((v, k) => { for (let d = 0; d < DIM; d++) buf[k * DIM + d] = Math.max(-127, Math.min(127, Math.round(v[d] * 127))); });
    fs.appendFileSync(CTL_EMB, Buffer.from(buf.buffer));
    process.stdout.write(`\r${Math.min(i + 128, ctl.length)}/${ctl.length}  ${Math.round((Date.now() - t0) / 1000)} s   `);
  }
  console.log('\nembeddings done');
}

// ------------------------------------------------------------------ logistic regression (L2, full-batch gradient descent with Adam)
function fitLogistic(X, y, w8, { epochs = 300, lr = 0.05, l2 = 1e-3 } = {}) {
  const d = X[0].length, n = X.length;
  const w = new Float64Array(d + 1), m = new Float64Array(d + 1), v = new Float64Array(d + 1);
  const W = w8 || new Float64Array(n).fill(1), sw = W.reduce((a, b) => a + b, 0);
  for (let e = 1; e <= epochs; e++) {
    const g = new Float64Array(d + 1);
    for (let i = 0; i < n; i++) {
      let z = w[d];
      const x = X[i];
      for (let k = 0; k < d; k++) z += w[k] * x[k];
      const r = (1 / (1 + Math.exp(-z)) - y[i]) * W[i];
      for (let k = 0; k < d; k++) g[k] += r * x[k];
      g[d] += r;
    }
    for (let k = 0; k <= d; k++) {
      const gk = g[k] / sw + (k < d ? l2 * w[k] : 0);
      m[k] = 0.9 * m[k] + 0.1 * gk; v[k] = 0.999 * v[k] + 0.001 * gk * gk;
      w[k] -= lr * (m[k] / (1 - 0.9 ** e)) / (Math.sqrt(v[k] / (1 - 0.999 ** e)) + 1e-8);
    }
  }
  return w;
}
const prob = (w, x) => { let z = w[x.length]; for (let k = 0; k < x.length; k++) z += w[k] * x[k]; return 1 / (1 + Math.exp(-z)); };

async function trainPhase() {
  const { by, info } = await millByJournal();
  const millVec = fs.readFileSync(path.join(DIR, 'mill-embeddings.bin'));
  const ctl = readControls();
  const ctlVec = fs.readFileSync(CTL_EMB);
  const nCtl = Math.min(ctl.length, ctlVec.length / DIM);
  const vec = (buf, i) => { const x = new Float64Array(DIM); for (let d = 0; d < DIM; d++) x[d] = (buf[i * DIM + d] << 24 >> 24) / 127; return x; };
  // the benchmark's papers never enter the training data
  const bench = JSON.parse(fs.readFileSync(path.join(BENCH, 'results.json'), 'utf8'));
  const benchDoi = new Set(bench.map(b => String(b.doi).toLowerCase()));
  // balanced per journal: as many mill papers as controls (at most PER_JOURNAL each)
  const ctlBy = new Map();
  for (let i = 0; i < nCtl; i++) { if (benchDoi.has(ctl[i].doi)) continue; if (!ctlBy.has(ctl[i].journalKey)) ctlBy.set(ctl[i].journalKey, []); ctlBy.get(ctl[i].journalKey).push(i); }
  const rows = [];
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (const [k, c] of ctlBy) {
    const mill = (by.get(k)?.items || []).filter(x => !benchDoi.has(x.doi)).sort(() => rnd() - 0.5);
    const n = Math.min(c.length, mill.length, PER_JOURNAL);
    if (n < 5) continue;
    for (const x of mill.slice(0, n)) rows.push({ x: vec(millVec, x.i), y: 1, j: k });
    for (const i of c.slice(0, n)) rows.push({ x: vec(ctlVec, i), y: 0, j: k });
  }
  const journals = [...new Set(rows.map(r => r.j))];
  const foldOf = new Map(journals.sort(() => rnd() - 0.5).map((j, i) => [j, i % FOLDS]));
  console.log(`training rows: ${rows.length} (${rows.filter(r => r.y).length} mill, ${rows.filter(r => !r.y).length} ordinary) from ${journals.length} journals`);
  // cross-validation by journal
  const oof = [];
  for (let f = 0; f < FOLDS; f++) {
    const tr = rows.filter(r => foldOf.get(r.j) !== f), te = rows.filter(r => foldOf.get(r.j) === f);
    const w = fitLogistic(tr.map(r => r.x), tr.map(r => r.y));
    for (const r of te) oof.push({ p: prob(w, r.x), y: r.y });
    process.stdout.write(`\rfold ${f + 1}/${FOLDS}   `);
  }
  console.log();
  const auc = list => { const P = list.filter(r => r.y).map(r => r.p), N = list.filter(r => !r.y).map(r => r.p); let a = 0; for (const p of P) for (const q of N) a += p > q ? 1 : p === q ? 0.5 : 0; return a / (P.length * N.length); };
  const at = (list, t) => ({ t, recall: list.filter(r => r.y && r.p >= t).length / list.filter(r => r.y).length, fpr: list.filter(r => !r.y && r.p >= t).length / list.filter(r => !r.y).length });
  const cv = { auc: auc(oof), points: [0.5, 0.7, 0.8, 0.9, 0.95].map(t => at(oof, t)) };
  console.log('cross-validation by journal: AUC', cv.auc.toFixed(3), cv.points.map(p => `p>=${p.t}: mill ${(100 * p.recall).toFixed(0)}% / ordinary ${(100 * p.fpr).toFixed(0)}%`).join('; '));

  const w = fitLogistic(rows.map(r => r.x), rows.map(r => r.y));
  // ---------------------------------------------------------------- the separate benchmark, with the live tool's other signals
  const E = require('../src/tools/embed');
  const clean = x => String(x || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  const combinedRows = fs.existsSync(path.join(BENCH, 'papermill-combined.json')) ? JSON.parse(fs.readFileSync(path.join(BENCH, 'papermill-combined.json'), 'utf8')) : null;
  const scoreOf = new Map((combinedRows || []).map(r => [r.pmcid, r]));
  const B = [];
  for (const b of bench) {
    const f = path.join(BENCH, 'xml', `${b.pmcid}.xml`);
    if (!fs.existsSync(f)) continue;
    const front = (fs.readFileSync(f, 'utf8').match(/<front>[\s\S]*?<\/front>/) || [''])[0];
    const title = clean((front.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/) || [])[1]);
    const abs = clean((front.match(/<abstract[\s\S]*?<\/abstract>/) || [''])[0]);
    if (abs.split(/\s+/).length < 30) continue;
    const v = (await E.embed([textOf(title, abs)]))[0];
    const x = Float64Array.from(v, a => Math.round(a * 127) / 127);
    const c = scoreOf.get(b.pmcid);
    B.push({ pmcid: b.pmcid, y: b.group === 'mill' ? 1 : 0, p: prob(w, x), level: c ? c.level : b.level, score: c ? c.score : b.score });
  }
  const benchAuc = auc(B);
  const rate = (list, fn) => list.filter(fn).length;
  const M = B.filter(r => r.y), C = B.filter(r => !r.y);
  const rules = { mill: rate(M, r => r.level !== 'LOW'), ordinary: rate(C, r => r.level !== 'LOW') };
  // the model as one more signal: weight added to the live score; the limits chosen so ordinary papers are not flagged more
  // often than by the rules alone (on the benchmark this is a measured choice: reported, not tuned per paper)
  const results = [];
  for (const [tm, wm] of [[0.9, 4], [0.8, 4], [0.7, 4], [0.9, 3], [0.8, 3], [0.8, 2], [0.7, 2], [0.6, 2]]) {
    const lvl = r => { const s = r.score + (r.p >= tm ? wm : r.p >= NOTE ? Math.min(1, wm - 1) : 0); return r.level === 'HIGH' || s >= 8 ? 'HIGH' : s >= 4 || r.level === 'MEDIUM' ? 'MEDIUM' : 'LOW'; };
    results.push({ tm, wm, mill: rate(M, r => lvl(r) !== 'LOW'), ordinary: rate(C, r => lvl(r) !== 'LOW'), millHigh: rate(M, r => lvl(r) === 'HIGH'), ordinaryHigh: rate(C, r => lvl(r) === 'HIGH') });
  }
  console.log(`benchmark (${M.length} mill / ${C.length} ordinary, never trained on): AUC of the model alone ${benchAuc.toFixed(3)}`);
  console.log(`  rules alone            : mill flagged ${rules.mill}/${M.length}, ordinary flagged ${rules.ordinary}/${C.length}${combinedRows ? '' : ' (text signals only: run benchmark-papermill-combined.js --json data/benchmark/papermill-combined.json for all signals)'}`);
  for (const r of results) console.log(`  + model >= ${r.tm} weight ${r.wm}: mill ${r.mill}/${M.length}, ordinary ${r.ordinary}/${C.length} (HIGH: ${r.millHigh} / ${r.ordinaryHigh})`);
  const pick = results.filter(r => r.ordinary <= Math.max(rules.ordinary, Math.round(C.length * 0.05))).sort((a, b) => b.mill - a.mill || a.ordinary - b.ordinary)[0];
  console.log('chosen:', JSON.stringify(pick));
  const model = { model: info.model, dim: DIM, kind: 'logistic', trained: new Date().toISOString().slice(0, 10), rows: rows.length, journals: journals.length,
    threshold: pick.tm, weight: pick.wm, note: NOTE, cv: { auc: Math.round(cv.auc * 1000) / 1000, points: cv.points },
    benchmark: { mill: M.length, ordinary: C.length, auc: Math.round(benchAuc * 1000) / 1000, rules, withModel: pick, all: results },
    w: Array.from(w, x => Math.round(x * 1e5) / 1e5) };
  fs.writeFileSync(OUT, JSON.stringify(model));
  console.log('written', OUT);
}

(async () => {
  await db.init();
  if (phase === 'controls') await controls();
  else if (phase === 'crossref') await crossrefControls();
  else if (phase === 'embed') await embed();
  else if (phase === 'train') await trainPhase();
  else console.log('usage: controls | embed | train');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
