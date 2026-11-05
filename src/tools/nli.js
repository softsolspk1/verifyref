// tools/nli.js - Module 3.B: a small language-understanding model (DeBERTa-v3 trained for natural-language inference on
// SNLI / MultiNLI; ONNX, 8-bit) reads a claim and a source passage and says whether the passage states it (entailment),
// states the opposite (contradiction) or neither. It corrects the word matcher's verdict: reworded support is found and
// contradictions written in other words are flagged. Runs on this server - no manuscript text leaves it; the model files
// (about 85 MB) are downloaded once from Hugging Face into DATA_DIR/models.
// PJPS_NLI=off turns it off; when the library or the model cannot be loaded the word matcher's verdict stands.
const path = require('path');
const cfg = require('../config');

const MODEL = process.env.PJPS_NLI_MODEL || 'Xenova/nli-deberta-v3-xsmall';
const OFF = /^(off|0|false|no)$/i.test(process.env.PJPS_NLI || '');
const RETRY_MS = 10 * 60 * 1000;

let loading = null, failedAt = 0;
function load() {
  if (OFF) return Promise.resolve(null);
  if (!loading && Date.now() - failedAt > RETRY_MS) {
    loading = (async () => {
      const T = await import('@huggingface/transformers');
      T.env.cacheDir = path.join(cfg.DATA_DIR, 'models');
      const tok = await T.AutoTokenizer.from_pretrained(MODEL);
      const net = await T.AutoModelForSequenceClassification.from_pretrained(MODEL, { dtype: 'q8' });
      const labels = Object.values(net.config.id2label).map(l => String(l).toLowerCase());
      return { tok, net, labels };
    })().catch(err => {
      console.warn(`[nli] model unavailable, word matching only: ${err.message}`);
      failedAt = Date.now(); loading = null;
      return null;
    });
  }
  return loading || Promise.resolve(null);
}

/** { entailment, contradiction, neutral } probabilities that the passage (premise) states the claim (hypothesis) */
async function infer(m, premise, hypothesis) {
  const inputs = await m.tok(premise, { text_pair: hypothesis, truncation: true, max_length: 320 });
  const { logits } = await m.net(inputs);
  const l = Array.from(logits.data), mx = Math.max(...l), e = l.map(x => Math.exp(x - mx)), s = e.reduce((a, b) => a + b, 0);
  const out = {};
  m.labels.forEach((name, i) => { out[name] = e[i] / s; });
  return out;
}

/**
 * Decision rule over the matcher's top passages (at most 3), fitted on the SciFact train split under limits on false
 * alarms (no-evidence claims passed as Full <= 2%, contradicted claims passed as Full <= 2.5%, supported claims called
 * contradicted <= 7%) and checked on the held-out dev split (scripts/benchmark-claims.js); refitted 5 Nov 2026:
 *   contradiction  - a passage sharing at least 20% of the claim's terms contradicts it (contradiction - entailment >= 0.98)
 *   matcher contradiction overruled when a passage entails the claim (>= 0.5) - reported as partial
 *   full           - a passage entails the claim (>= 0.98), or (>= 0.8) when it shares at least half of the claim's terms
 *   partial        - entailment (>= 0.3) where the matcher found nothing
 *   full -> partial when no passage entails the claim (< 0.2)
 */
const RULE = { covC: 0.2, tc: 0.98, keepE: 0.5, te: 0.98, covF: 0.5, te2: 0.8, tp: 0.3, demote: 0.2 };

/**
 * Model-corrected decision for a claim and its top passages (from match.bestPassages(claim, passages, 3)).
 * base: the matcher's verdict for top[0] ({ verdict }). Returns null when the model is not available, otherwise
 * { decision: 'full'|'partial'|'contradicts'|'unsupported', passage, entailment, contradiction }.
 */
async function decide(claim, top, base, { deadline } = {}) {
  if (!top?.length || (deadline && Date.now() > deadline)) return null;
  const m = await load();
  if (!m) return null;
  const scored = [];
  for (const p of top.slice(0, 3)) scored.push({ p, ...(await infer(m, p.modelText || p.text, claim)) });
  const byE = scored.reduce((a, b) => (b.entailment > a.entailment ? b : a));
  const byC = scored.filter(s => s.p.coverage >= RULE.covC)
    .reduce((a, b) => (!a || b.contradiction - b.entailment > a.contradiction - a.entailment ? b : a), null);
  const E = byE.entailment, C = byC ? byC.contradiction - byC.entailment : 0;
  const wordConflict = base.verdict === 'unsupported' && !!top[0].conflict;
  const out = (decision, s) => ({ decision, passage: s.p, entailment: s.entailment, contradiction: s.contradiction });
  if (C >= RULE.tc) return out('contradicts', byC);
  if (wordConflict) return E >= RULE.keepE ? out('partial', byE) : out('contradicts', scored[0]);
  if (E >= RULE.te || (E >= RULE.te2 && byE.p.coverage >= RULE.covF)) return out('full', byE);
  if (E >= RULE.tp && base.verdict === 'unsupported') return out('partial', byE);
  if (base.verdict === 'full' && E < RULE.demote) return out('partial', scored[0]);
  // the matcher's verdict stands; the evidence shown is the passage the model reads as stating the claim, if any
  return out(base.verdict, E >= RULE.demote && byE.entailment > scored[0].entailment ? byE : scored[0]);
}

module.exports = { decide, load, MODEL, RULE };
