#!/usr/bin/env node
// scripts/benchmark-claims.js - Module 3.B claim support measured on SciFact (Wadden et al., EMNLP 2020; CC BY-NC 2.0):
// expert-written scientific claims, each paired with the abstract(s) it cites, labelled SUPPORT, CONTRADICT or
// NOT ENOUGH INFO by annotators. Every claim-abstract pair is run through the same matcher as the live tool
// (src/tools/match.js judge(), abstract only) and the verdict compared with the label. --words: word matcher alone,
// without the language model (tools/nli.js).
//
//   node scripts/benchmark-claims.js --dir D:/pjps-tmp/scifact/data [--split dev|train|all] [--words] [--json out.json]
// Download: https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz
const fs = require('fs');
const path = require('path');
const M = require('../src/tools/match');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const DIR = opt('dir', 'D:/pjps-tmp/scifact/data');
const SPLIT = opt('split', 'dev');
const readJsonl = f => fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const corpus = new Map(readJsonl('corpus.jsonl').map(d => [d.doc_id, d]));
const claims = (SPLIT === 'all' ? ['claims_train.jsonl', 'claims_dev.jsonl'] : [`claims_${SPLIT}.jsonl`]).flatMap(readJsonl);

// one test per claim and cited abstract: SUPPORT / CONTRADICT when annotated so, NEI when the abstract was cited but
// annotated with no evidence
const pairs = [];
for (const c of claims) for (const id of c.cited_doc_ids || []) {
  const doc = corpus.get(id);
  if (!doc) continue;
  const ev = c.evidence?.[String(id)];
  pairs.push({ claim: c.claim, doc, label: ev?.length ? ev[0].label : 'NEI' });
}

if (args.includes('--words')) process.env.PJPS_NLI = 'off';
const verdictClass = v => (v.verdict === 'full' ? 'SUPPORT' : v.verdict === 'partial' ? 'PARTIAL' : v.conflict ? 'CONTRADICT' : 'NEI');
const confusion = {};
(async () => {
const t0 = Date.now();
for (const p of pairs) {
  const passages = M.passagesOf(p.doc.abstract.join(' '), { title: p.doc.title });
  const got = verdictClass(await M.judge(p.claim, passages, { fullText: false }));
  confusion[p.label] = confusion[p.label] || {};
  confusion[p.label][got] = (confusion[p.label][got] || 0) + 1;
}
const row = l => confusion[l] || {};
const n = l => Object.values(row(l)).reduce((a, b) => a + b, 0);
const pct = (a, b) => (b ? `${Math.round(a / b * 100)}%` : '—');
const sup = row('SUPPORT'), con = row('CONTRADICT'), nei = row('NEI');
// what matters for an editor: a claim the source does not support must not pass as "Full support"
const out = {
  dataset: 'SciFact', split: SPLIT, languageModel: process.env.PJPS_NLI === 'off' ? null : require('../src/tools/nli').MODEL, pairs: pairs.length, seconds: Math.round((Date.now() - t0) / 100) / 10, confusion,
  supportedFound: { full: sup.SUPPORT || 0, fullOrPartial: (sup.SUPPORT || 0) + (sup.PARTIAL || 0), of: n('SUPPORT') },
  contradictedPassedAsFull: { n: con.SUPPORT || 0, of: n('CONTRADICT') },
  contradictedFlagged: { n: con.CONTRADICT || 0, of: n('CONTRADICT') },
  notEnoughInfoPassedAsFull: { n: nei.SUPPORT || 0, of: n('NEI') }
};
console.log(`SciFact ${SPLIT}: ${pairs.length} claim-abstract pairs (${out.seconds}s)`);
console.log('label \\ verdict     Full  Partial  Contradicts  Not supported');
for (const l of ['SUPPORT', 'CONTRADICT', 'NEI']) console.log(`${l.padEnd(18)} ${String(row(l).SUPPORT || 0).padStart(5)} ${String(row(l).PARTIAL || 0).padStart(8)} ${String(row(l).CONTRADICT || 0).padStart(12)} ${String(row(l).NEI || 0).padStart(14)}`);
console.log(`Supported claims judged Full: ${pct(out.supportedFound.full, n('SUPPORT'))}, Full or Partial: ${pct(out.supportedFound.fullOrPartial, n('SUPPORT'))}`);
console.log(`Contradicted claims passed as Full: ${pct(out.contradictedPassedAsFull.n, n('CONTRADICT'))}; flagged as contradicted: ${pct(out.contradictedFlagged.n, n('CONTRADICT'))}`);
console.log(`No-evidence claims passed as Full: ${pct(out.notEnoughInfoPassedAsFull.n, n('NEI'))}`);
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(out, null, 1));
})();
