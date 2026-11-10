// tools/claimJudge.js - Module 3B: a Claude model reads the claim and the cited source's best passages (or a whole
// abstract) and decides whether the source supports, partly supports, contradicts or does not address the claim, naming
// the passage it relied on. Used by tools/match.js judge() before the local language model (tools/nli.js); any error,
// timeout or refusal returns null and the local model decides as before. On only with ANTHROPIC_API_KEY set and
// PJPS_CLAIM_LLM=on (adopted after the SciFact benchmark, scripts/benchmark-claims.js --llm).
const cfg = require('../config');

const MODEL = process.env.PJPS_CLAIM_LLM_MODEL || 'claude-opus-5-5';
const enabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.PJPS_CLAIM_LLM === 'on' && !cfg.DESKTOP;

let client = null;
const clientOf = () => {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    client = new Anthropic({ maxRetries: 1 });
  }
  return client;
};

const SYSTEM = `You check citations in scientific manuscripts submitted to a pharmaceutical sciences journal.
You are given a claim from a manuscript and numbered passages from the source the manuscript cites for it.
Decide what the source says about the claim:
- SUPPORTS: the passages state the claim, or something that directly implies it (same direction, same finding; numbers, if the claim gives any, agree).
- PARTLY_SUPPORTS: the passages support part of the claim, a weaker or more limited version, or the same finding in a different population, dose or setting.
- CONTRADICTS: the passages report the opposite direction, no effect where the claim says there is one, or a negative finding about what the claim asserts.
- NOT_ADDRESSED: the passages do not speak to the claim.
Judge only from the text given, not from your own knowledge. When the whole abstract is given, it counts as evidence
just as the numbered passages do. Paraphrase is fine; a claim does not need the same words.
Return the number of the passage your decision rests on most (0 if the evidence is only in the whole abstract, or if
there is none) and one short sentence of reasons.`;

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['SUPPORTS', 'PARTLY_SUPPORTS', 'CONTRADICTS', 'NOT_ADDRESSED'] },
    passage: { type: 'integer' },
    reason: { type: 'string' }
  },
  required: ['verdict', 'passage', 'reason'],
  additionalProperties: false
};

// tokens used in this process (benchmark cost meter)
const totals = { calls: 0, input: 0, output: 0 };
const warned = new Set();

const DECISION = { SUPPORTS: 'full', PARTLY_SUPPORTS: 'partial', CONTRADICTS: 'contradicts', NOT_ADDRESSED: 'unsupported' };

/**
 * claim, passages [{ text, modelText? }] (best first), whole: the whole abstract or '' -> { decision, passage, reason }
 * or null. decision is full / partial / contradicts / unsupported, as tools/nli.js decide() returns.
 */
async function decide(claim, passages, { whole = '', deadline } = {}) {
  if (!enabled() || !passages?.length) return null;
  const left = deadline ? deadline - Date.now() : 45000;
  if (left < 8000) return null;
  const list = passages.map((p, i) => `[${i + 1}] ${p.modelText || p.text}`).join('\n\n');
  const content = `Claim: ${claim}\n\nPassages from the cited source:\n${list}${whole ? `\n\nThe whole abstract of the source:\n${whole}` : ''}`;
  try {
    const r = await clientOf().messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { effort: process.env.PJPS_CLAIM_LLM_EFFORT || 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }]
    }, { timeout: Math.min(left - 2000, 45000) });
    totals.calls++; totals.input += r.usage?.input_tokens || 0; totals.output += r.usage?.output_tokens || 0;
    if (r.stop_reason !== 'end_turn') return null;
    const text = r.content.find(b => b.type === 'text')?.text;
    const out = text ? JSON.parse(text) : null;
    if (!out || !DECISION[out.verdict]) return null;
    const k = out.passage >= 1 && out.passage <= passages.length ? out.passage - 1 : 0;
    return { decision: DECISION[out.verdict], passage: passages[k], reason: String(out.reason || '').slice(0, 300), usage: r.usage };
  } catch (e) {
    // one line per kind of failure (no credit, bad key, rate limit), then the local model decides
    const why = `${e.status || ''} ${String(e.message || e).slice(0, 160)}`;
    if (!warned.has(why)) { warned.add(why); console.warn(`[claimJudge] ${why}`); }
    return null;
  }
}

module.exports = { decide, enabled, MODEL, totals };
