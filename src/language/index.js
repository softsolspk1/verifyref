// language/index.js - Module 6 Language Editing: checks paragraphs with the in-house rules, LanguageTool when configured and
// Claude when switched on, merges what they find (one suggestion per place), and adds the whole-document checks, the
// statistics, the tone and the overall score.
const R = require('./rules');
const DOC = require('./document');
const S = require('./spell');
const LT = require('./languagetool');
const AI = require('./ai');

const PRIORITY = { 'ai-suggestion': 0 };
const overlaps = (a, b) => a.offset < b.offset + b.length && b.offset < a.offset + a.length;

/** One suggestion per place: the first found wins (LanguageTool, then in-house rules); whole-sentence notes never block */
function merge(lists) {
  const kept = [];
  for (const list of lists) {
    for (const i of list) {
      if (i.whole || i.ai) { kept.push(i); continue; }
      if (kept.some(k => !k.whole && !k.ai && overlaps(k, i))) continue;
      kept.push(i);
    }
  }
  return kept.sort((a, b) => a.offset - b.offset || (PRIORITY[a.rule] ?? 1) - (PRIORITY[b.rule] ?? 1));
}

/**
 * paragraphs: [text]; opts: { variant, goals, personal: [words], disabled: [rule ids], docText, ai: bool, userId }
 * -> { paragraphs: [[issue]], engines }
 */
async function checkParagraphs(paragraphs, opts = {}) {
  const variant = opts.variant === 'en-GB' ? 'en-GB' : 'en-US';
  const personal = new Set((opts.personal || []).map(w => String(w).toLowerCase()));
  const docWords = DOC.wordCounts(opts.docText || paragraphs.join('\n'));
  S.resetBudget(8);
  const own = paragraphs.map(p => R.checkParagraph(p, opts.goals, { variant, personal, docWords, disabled: opts.disabled }));
  const lt = await LT.check(paragraphs, variant);
  // LanguageTool's spelling knows no pharmacology: keep its spelling notes only where ours agrees, or its word is not exempt
  const ltKept = lt ? lt.map(list => list.filter(i => !i.spelling || !S.check(i.text, { variant, personal, ctx: { midSentence: true, repeated: (docWords.get(i.text.toLowerCase()) || 0) >= 3 } }))) : null;
  let ai = paragraphs.map(() => []), aiError = null;
  if (opts.ai && AI.enabled()) {
    try {
      ai = await Promise.all(paragraphs.map(p => AI.suggest(opts.userId, p, { goals: opts.goals, variant })));
    } catch (e) { aiError = e.message; }
  }
  const out = paragraphs.map((p, k) => merge([ltKept ? ltKept[k] : [], own[k], ai[k]]).filter(i => !personal.has(i.text.toLowerCase()) || !i.spelling));
  return { paragraphs: out, engines: { rules: true, languagetool: LT.enabled() ? (lt ? 'ok' : 'unavailable') : 'off', ai: AI.enabled() ? (aiError ? 'limit' : 'on') : 'off', aiError } };
}

/** Whole document: positioned issues, statistics, tone and the score (counts: the paragraph suggestions open per area) */
function checkDocument(text, { goals = {}, disabled = [], counts = {} } = {}) {
  const { issues: docIssues, structure } = DOC.checkDocument(text, goals, { disabled });
  const st = DOC.stats(text);
  const all = { ...counts };
  for (const i of docIssues) all[i.category] = (all[i.category] || 0) + 1;
  return { issues: docIssues, structure, stats: st, tone: DOC.tone(text), score: DOC.score(all, st, goals) };
}

module.exports = { checkParagraphs, checkDocument, merge, AI, LT };
