// language/ai.js - Module 6 AI writing features on Claude: sentence-level suggestions (clarity, fluency, tone rewrites),
// rewriting a selection (improve, shorten, simplify, formal, academic, ...), writing from a prompt and tone detection.
// On only with ANTHROPIC_API_KEY on the web platform (LANGUAGE_AI=off turns it off); the desktop asks the web platform.
// Every call is counted per user per day (LANGUAGE_AI_DAILY_LIMIT) and identical requests are answered from the cache, so
// the same text is never paid for twice. Any error returns null and the in-house checks stand on their own.
const crypto = require('crypto');
const cfg = require('../config');
const db = require('../db');

const MODEL = process.env.LANGUAGE_AI_MODEL || 'claude-opus-5-5';
const EFFORT = process.env.LANGUAGE_AI_EFFORT || 'low';
const DAILY = parseInt(process.env.LANGUAGE_AI_DAILY_LIMIT || '300', 10);
const enabled = () => !!process.env.ANTHROPIC_API_KEY && process.env.LANGUAGE_AI !== 'off' && !cfg.DESKTOP;

let client = null;
const clientOf = () => {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
    client = new Anthropic({ maxRetries: 1 });
  }
  return client;
};

const VARIANT = { 'en-US': 'American English', 'en-GB': 'British English' };
function context(goals = {}, variant = 'en-US') {
  return `Write in ${VARIANT[variant] || 'American English'}. Writing goals: domain ${goals.domain || 'academic'}, formality ${goals.formality || 'formal'}, audience ${goals.audience || 'expert'}, intent ${goals.intent || 'inform'}.`;
}

const BASE = `You are the writing assistant of a manuscript-screening platform used by a pharmaceutical sciences journal.
Keep the author's meaning, facts, numbers, units, citations (e.g. "(Khan et al., 2020)" or "[12]"), abbreviations and technical terms exactly as they are.
Never add claims, data or references that are not in the text.`;

// ------------------------------------------------------------------ usage and cache

async function allowance(userId) {
  if (!userId) return true;
  const r = await db.one("SELECT calls FROM language_usage WHERE user_id = $1 AND day = CURRENT_DATE", [userId]).catch(() => null);
  return (r?.calls || 0) < DAILY;
}

async function count(userId, usage) {
  if (!userId) return;
  await db.query(`INSERT INTO language_usage(user_id, day, calls, input_tokens, output_tokens) VALUES($1, CURRENT_DATE, 1, $2, $3)
    ON CONFLICT (user_id, day) DO UPDATE SET calls = language_usage.calls + 1, input_tokens = language_usage.input_tokens + $2, output_tokens = language_usage.output_tokens + $3`,
  [userId, usage?.input_tokens || 0, usage?.output_tokens || 0]).catch(() => {});
}

const keyOf = parts => crypto.createHash('sha256').update(JSON.stringify([MODEL, ...parts])).digest('hex');
async function cached(key) {
  const r = await db.one('SELECT value FROM language_ai_cache WHERE key = $1', [key]).catch(() => null);
  return r ? (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) : null;
}
const remember = (key, value) => db.query('INSERT INTO language_ai_cache(key, value) VALUES($1, $2) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]).catch(() => {});

const warned = new Set();
class LimitError extends Error { constructor() { super(`The daily limit of ${DAILY} AI writing requests has been reached. It resets tomorrow; the grammar and style checks keep working.`); this.status = 429; } }

/** One structured call: { system, content, schema, maxTokens } -> parsed JSON or null */
async function call(userId, cacheParts, { system, content, schema, maxTokens = 4000, timeout = 40000 }) {
  if (!enabled()) return null;
  const key = keyOf(cacheParts);
  const hit = await cached(key);
  if (hit) return hit;
  if (!(await allowance(userId))) throw new LimitError();
  try {
    const r = await clientOf().beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: EFFORT, format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content }]
    }, { timeout });
    await count(userId, r.usage);
    if (r.stop_reason !== 'end_turn') return null;
    const text = r.content.find(b => b.type === 'text')?.text;
    const out = text ? JSON.parse(text) : null;
    if (out) await remember(key, out);
    return out;
  } catch (e) {
    const why = `${e.status || ''} ${String(e.message || e).slice(0, 160)}`;
    if (!warned.has(why)) { warned.add(why); console.warn(`[language ai] ${why}`); }
    return null;
  }
}

// ------------------------------------------------------------------ sentence suggestions for a paragraph

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          original: { type: 'string' },
          replacement: { type: 'string' },
          category: { type: 'string', enum: ['correctness', 'clarity', 'engagement', 'delivery'] },
          title: { type: 'string' },
          explanation: { type: 'string' }
        },
        required: ['original', 'replacement', 'category', 'title', 'explanation'],
        additionalProperties: false
      }
    }
  },
  required: ['suggestions'],
  additionalProperties: false
};

const SUGGEST_SYSTEM = `${BASE}
Review one paragraph the way a professional language editor would and return only the changes worth making:
grammar and usage errors a rule-based checker misses, unclear or awkward sentences (fluency), wordy sentences that can be
made concise, and tone that does not suit the goals. Each suggestion quotes the exact text to replace ("original", copied
character for character from the paragraph, as short as possible but at least a few words) and gives the replacement.
"title" is 2-4 words (e.g. "Unclear sentence", "Rewrite for clarity", "Awkward phrasing", "Wrong preposition").
"explanation" is one short sentence for the writer. Do not report spelling of technical terms. Return at most 6
suggestions, none if the paragraph is already well written.`;

/** AI suggestions for a paragraph, positioned in it: [{ offset, length, text, rule, category, title, message, replacements, ai: true }] */
async function suggest(userId, paragraph, { goals, variant } = {}) {
  if (!enabled() || paragraph.trim().split(/\s+/).length < 6) return [];
  const out = await call(userId, ['suggest', paragraph, goals, variant], { system: SUGGEST_SYSTEM, content: `${context(goals, variant)}\n\nParagraph:\n${paragraph}`, schema: SUGGEST_SCHEMA, maxTokens: 3000 });
  if (!out) return [];
  const res = [];
  for (const s of out.suggestions || []) {
    if (!s.original || s.original === s.replacement) continue;
    const at = paragraph.indexOf(s.original);
    if (at < 0) continue;
    res.push({ rule: 'ai-suggestion', category: s.category, title: s.title || 'Suggested rewrite', offset: at, length: s.original.length, text: s.original,
      message: s.explanation, replacements: [s.replacement], ai: true });
  }
  return res;
}

// ------------------------------------------------------------------ rewrite a selection

const MODES = {
  improve: 'Improve the writing: fix every error and make it clear, fluent and well structured.',
  fix: 'Correct grammar, spelling and punctuation only. Change nothing else.',
  shorten: 'Make it more concise: remove redundancy and wordiness, keep every fact.',
  simplify: 'Make it simpler to read: shorter sentences and plainer words, keep technical terms that are needed.',
  formal: 'Make it more formal.',
  academic: 'Rewrite it in the style of a well-edited scientific journal article.',
  friendly: 'Make it friendlier and warmer, still professional.',
  confident: 'Make it sound more confident: remove needless hedging, keep scientific caution where the evidence requires it.',
  expand: 'Expand it with more explanation and better transitions, without adding facts or claims that are not implied by the text.',
  paraphrase: 'Paraphrase it: say the same thing in clearly different words and sentence structure.',
  clarity: 'Rewrite it for clarity: one idea per sentence, logical order, precise words.',
  custom: ''
};
const REWRITE_SCHEMA = {
  type: 'object',
  properties: { options: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
  required: ['options', 'note'],
  additionalProperties: false
};

/** -> { options: [text, ...], note } or null */
async function rewrite(userId, text, { mode = 'improve', instruction = '', goals, variant } = {}) {
  if (!MODES[mode] && mode !== 'custom') mode = 'improve';
  const task = mode === 'custom' ? String(instruction).slice(0, 500) : MODES[mode];
  if (!task) return null;
  return call(userId, ['rewrite', text, mode, instruction, goals, variant], {
    system: `${BASE}\nRewrite the text you are given as instructed. Return two alternative versions in "options" (the best first), each a complete replacement for the whole text, keeping its paragraph breaks. "note" is one short sentence on what was changed.`,
    content: `${context(goals, variant)}\nInstruction: ${task}\n\nText:\n${text}`,
    schema: REWRITE_SCHEMA, maxTokens: 6000, timeout: 60000
  });
}

/** Write new text from a prompt, using the document so far as context -> { options: [text], note } */
async function generate(userId, prompt, { documentText = '', selection = '', goals, variant } = {}) {
  return call(userId, ['generate', prompt, selection, documentText.slice(0, 12000), goals, variant], {
    system: `${BASE}\nYou write text for the author on request (an outline, a paragraph, an abstract draft, a reply, a summary of their text). Use only information in the document or the prompt; where facts are missing, leave a clear placeholder in square brackets rather than inventing them. Return one version in "options"; "note" is one short sentence.`,
    content: `${context(goals, variant)}\n\nRequest: ${String(prompt).slice(0, 1000)}${selection ? `\n\nSelected text:\n${selection}` : ''}${documentText ? `\n\nThe document so far:\n${documentText.slice(0, 12000)}` : ''}`,
    schema: REWRITE_SCHEMA, maxTokens: 6000, timeout: 60000
  });
}

// ------------------------------------------------------------------ tone

const TONE_SCHEMA = {
  type: 'object',
  properties: {
    tones: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, score: { type: 'integer' }, good: { type: 'boolean' } }, required: ['label', 'score', 'good'], additionalProperties: false } },
    formality: { type: 'string', enum: ['informal', 'neutral', 'formal'] },
    summary: { type: 'string' }
  },
  required: ['tones', 'formality', 'summary'],
  additionalProperties: false
};

async function tone(userId, text, { goals, variant } = {}) {
  const out = await call(userId, ['tone', text.slice(0, 20000), goals], {
    system: `${BASE}\nDescribe how the text sounds to a reader. Give up to 5 tones (single words such as Formal, Confident, Analytical, Tentative, Friendly, Concerned, Optimistic, Neutral, Assertive, Critical), each with a 0-100 strength and whether it suits the writing goals. "summary" is one sentence on how a reader will perceive it.`,
    content: `${context(goals, variant)}\n\nText:\n${text.slice(0, 20000)}`,
    schema: TONE_SCHEMA, maxTokens: 1500
  });
  return out ? { ...out, source: 'ai' } : null;
}

// ------------------------------------------------------------------ expert (peer-reviewer) feedback on the manuscript

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    scores: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'string' }, score: { type: 'integer' }, comment: { type: 'string' } }, required: ['criterion', 'score', 'comment'], additionalProperties: false } },
    strengths: { type: 'array', items: { type: 'string' } },
    comments: { type: 'array', items: { type: 'object', properties: { section: { type: 'string' }, quote: { type: 'string' }, comment: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor'] } }, required: ['section', 'quote', 'comment', 'severity'], additionalProperties: false } },
    questions: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary', 'scores', 'strengths', 'comments', 'questions'],
  additionalProperties: false
};

/** Reviewer-style feedback on the writing and presentation of a manuscript (not a verdict on the science) */
async function review(userId, text, { goals, variant, focus = '' } = {}) {
  return call(userId, ['review', text.slice(0, 60000), goals, focus], {
    system: `${BASE}
Act as an experienced peer reviewer and academic language editor. Give feedback the author can act on before submission:
how clearly the research question, methods, results and conclusions are presented; whether claims match the evidence
shown; structure and flow; academic tone; and what reviewers are likely to question. Score 1-5 for: Clarity, Structure,
Academic tone, Evidence and claims, Language quality. Each comment quotes a short exact passage ("quote", or "" for a
general point) and names its section. Up to 12 comments, the most important first; up to 5 questions a reviewer would
ask. Do not judge whether the science is correct and do not invent missing information.`,
    content: `${context(goals, variant)}${focus ? `\nThe author asks you to focus on: ${String(focus).slice(0, 300)}` : ''}\n\nManuscript:\n${text.slice(0, 60000)}`,
    schema: REVIEW_SCHEMA, maxTokens: 8000, timeout: 90000
  });
}

async function usageToday(userId) {
  const r = await db.one("SELECT calls FROM language_usage WHERE user_id = $1 AND day = CURRENT_DATE", [userId]).catch(() => null);
  return { used: r?.calls || 0, limit: DAILY };
}

module.exports = { enabled, suggest, rewrite, generate, tone, review, usageToday, MODES, MODEL, LimitError };
