#!/usr/bin/env node
// scripts/benchmark-claims.js - Module 3.B claim support measured on SciFact (Wadden et al., EMNLP 2020; CC BY-NC 2.0):
// expert-written scientific claims, each paired with the abstract(s) it cites, labelled SUPPORT, CONTRADICT or
// NOT ENOUGH INFO by annotators. Every claim-abstract pair is run through the same matcher as the live tool
// (src/tools/match.js judge(), abstract only) and the verdict compared with the label. --words: word matcher alone,
// without the language model (tools/nli.js).
//
//   node scripts/benchmark-claims.js --dir D:/pjps-tmp/scifact/data [--split dev|train|all] [--words] [--json out.json]
//     [--llm [--limit N] [--budget USD]]: the Claude judge (tools/claimJudge.js) on a fixed sample of N pairs balanced over
//     the three labels; stops before the estimated spend passes --budget (default 3)
// Download: https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz
require('../src/config');
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
const LLM = args.includes('--llm');
if (LLM) process.env.PJPS_CLAIM_LLM = 'on';
{
  // a fixed sample, the same three labels in equal shares where there are enough
  const limit = +opt('limit', 0);
  if (limit) {
    const byLabel = l => pairs.filter(p => p.label === l);
    const pick = [];
    for (const l of ['SUPPORT', 'CONTRADICT', 'NEI']) pick.push(...byLabel(l).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / Math.ceil(limit / 3))) === 0).slice(0, Math.ceil(limit / 3)));
    pairs.splice(0, pairs.length, ...pick.slice(0, limit));
  }
}
const BUDGET = +opt('budget', 3);
const CJ = require('../src/tools/claimJudge');
// USD per million tokens (input, output) of the judge model
const PRICE = { 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-4-5': [1, 5] }[CJ.MODEL] || [5, 25];
const spent = () => (CJ.totals.input * PRICE[0] + CJ.totals.output * PRICE[1]) / 1e6;
const verdictClass = v => (v.verdict === 'full' ? 'SUPPORT' : v.verdict === 'partial' ? 'PARTIAL' : v.conflict ? 'CONTRADICT' : 'NEI');
const confusion = {};
let byLlm = 0;
(async () => {
const t0 = Date.now();
for (const p of pairs) {
  if (LLM && CJ.totals.calls && spent() / CJ.totals.calls * (CJ.totals.calls + 1) > BUDGET) { console.log(`Budget of USD ${BUDGET} reached after ${CJ.totals.calls} pairs`); break; }
  const passages = M.passagesOf(p.doc.abstract.join(' '), { title: p.doc.title });
  const j = await M.judge(p.claim, passages, { fullText: false });
  if (j.model?.judge) byLlm++;
  const got = verdictClass(j);
  if (args.includes('--show') && got !== p.label && !(p.label === 'NEI' && got === 'NEI')) console.log(`MISS ${p.label} -> ${got}: ${p.claim}
   ${(j.notes || []).filter(n => /language model/.test(n)).join(' ')}
   evidence: ${String(j.best?.text || '').slice(0, 220)}`);
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
if (LLM) console.log(`Claude judge (${CJ.MODEL}): decided ${byLlm} of ${pairs.length} pairs (the rest fell back to the local model); ${CJ.totals.calls} calls, ${CJ.totals.input} input + ${CJ.totals.output} output tokens, about USD ${spent().toFixed(2)}`);
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify({ ...out, llm: LLM ? { model: CJ.MODEL, decided: byLlm, ...CJ.totals, usd: spent() } : null }, null, 1));
})();
