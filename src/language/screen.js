// language/screen.js - Module 6 in the Full Screening Report: PJPS Scribe reads the whole manuscript as the editor would
// in the module (research-article goals, the research vocabulary, the grammar server when configured; not the AI, which
// is paid per paragraph) and gives the writing score, the suggestions per area, the spelling and grammar examples the
// editor reads first, and a copy of the text the editor can open in PJPS Scribe to correct it.
const db = require('../db');
const L = require('./index');
const T = require('./text');

const GOALS = { domain: 'academic', formality: 'formal', audience: 'expert', intent: 'inform', passive: 'allow', abstractWords: 250 };
const AREAS = ['correctness', 'clarity', 'engagement', 'delivery', 'style'];
const MAX_TEXT = 400000;

// the same limits as the module's page (public/js/views/language.js): no writing checks in the reference list, and the
// names, departments and cities of the title block above the abstract are not spelling mistakes
const refStart = t => { const m = t.match(/(^|\n)\s*(?:\d+\.?\s*)?(?:references?|bibliography|literature cited|works cited)\s*:?\s*(?=\n|$)/i); return m ? m.index + m[1].length : Infinity; };
const frontEnd = t => { const m = t.slice(0, 4000).match(/(^|\n)\s*abstract\b/i); return m ? m.index + m[1].length : 0; };

// what the text extraction makes, not the writer: the spaces of tables and tabs, straight quotes and dashes from Word / PDF
const LAYOUT = new Set(['lt:WHITESPACE_RULE', 'lt:CONSECUTIVE_SPACES', 'double-space', 'lt:DASH_RULE', 'lt:EN_QUOTES', 'lt:EN_UNPAIRED_QUOTES']);
// in a heading, a table cell or a caption (a short line without a full stop) the sentence rules do not apply
const SENTENCE = new Set(['lt:UPPERCASE_SENTENCE_START', 'lt:PUNCTUATION_PARAGRAPH_END', 'sentence-capital', 'long-sentence', 'lt:TOO_LONG_SENTENCE', 'lt:SERIAL_COMMA_ON']);
const ENDS = /[.!?:]["')\]]?\s*$/;
const fragment = p => !ENDS.test(p) && p.trim().split(/\s+/).length < 25;

/**
 * The text as the writer wrote it: the lines of a PDF page joined into their paragraphs (a line that does not end a
 * sentence, followed by one starting in lower case) and the line numbers of a line-numbered manuscript taken out
 */
function reflow(text) {
  if ((text.match(/(?<=[a-z,]) {2,}\d{1,4} (?=[a-z(])/g) || []).length >= 20) text = text.replace(/(?<=\S) {2,}\d{1,4} (?=\S)/g, ' ');
  const out = [];
  for (const line of text.split('\n')) {
    const prev = out.length ? out[out.length - 1] : null;
    if (prev && prev.trim() && /^[a-z(]/.test(line.trimStart()) && !ENDS.test(prev) && !/^\s*(?:\d+\.?\s*)?(?:references?|bibliography)\s*$/i.test(prev)) {
      out[out.length - 1] = /[a-z]-$/.test(prev.trimEnd()) ? prev.trimEnd() + line.trimStart() : `${prev.trimEnd()} ${line.trimStart()}`;
    } else out.push(line);
  }
  return out.join('\n');
}

// spellings that differ between American and British English (the research vocabulary has both, so the dictionaries
// cannot tell them apart): the forms the manuscript uses decide
const US = /\b(?:\w+(?:iz(?:e|es|ed|ing|ation|ations)|yz(?:e|ed|es|ing))|color\w*|behavior\w*|tumor\w*|favor\w*|labor(?:s|ed|ing)?|center(?:s|ed)?|fiber\w*|liter(?:s)?|an(?:e)mi\w*|edema\w*|hem(?:oglobin|atolog\w*|orrhag\w*)|esophag\w*|fetal|fetus\w*|estrogen\w*|pediatric\w*|leukemi\w*|ischemi\w*|diarrhea\w*|gray|modeling|labeled|signaling|catalog)\b/gi;
const GB = /\b(?:\w+(?:is(?:ation|ations)|ys(?:e|ed|es|ing))|colour\w*|behaviour\w*|tumour\w*|favour\w*|labour(?:s|ed|ing)?|centre(?:s|d)?|fibre\w*|litre(?:s)?|anaemi\w*|oedema\w*|haem\w*|oesophag\w*|foetal|foetus\w*|oestrogen\w*|paediatric\w*|leukaemi\w*|ischaemi\w*|diarrhoea\w*|grey|modelling|labelled|signalling|catalogue)\b/gi;
const NOT_GB = /^(?:analys[ei]s|paralys[ei]s|dialys[ei]s|hydrolys[ei]s|electrolys[ei]s|catalys[ei]s|haemo?)$/i;
const NOT_US = /^(?:\w*siz(?:e|es|ed|ing)|priz\w*|seiz\w*)$/i;
function variantOf(text) {
  const u = (text.match(US) || []).filter(w => !NOT_US.test(w)).length;
  const g = (text.match(GB) || []).filter(w => !NOT_GB.test(w)).length;
  return g > u ? 'en-GB' : 'en-US';
}

const sentenceAt = (text, off) => {
  const a = Math.max(text.lastIndexOf('. ', off) + 2, text.lastIndexOf('\n', off) + 1, off - 160);
  let b = text.slice(off).search(/[.!?](\s|$)|\n/);
  b = b < 0 ? text.length : Math.min(off + b + 1, off + 220);
  return text.slice(a, b).trim();
};

/**
 * text: the manuscript; opts: { userId, title, save (a copy for PJPS Scribe) } ->
 * { kind: 'language', summary: { score, level, total, byArea, spelling, grammar, variant, words, flesch }, areas, spelling, examples, structure, tone, engines, docId }
 */
async function screenLanguage(text, { userId = null, title = '', save = true } = {}) {
  text = reflow(String(text || '').replace(/\r\n?/g, '\n')).slice(0, MAX_TEXT);
  if (text.split(/\s+/).length < 150) return { kind: 'language', error: 'Upload the full manuscript text for the language review (only a reference list was provided).' };
  const refs = refStart(text), front = frontEnd(text);
  const prose = Number.isFinite(refs) ? text.slice(0, refs) : text;
  const variant = variantOf(prose);
  const paras = [];
  let pos = 0;
  for (const p of text.split('\n')) { if (p.trim() && pos < refs) paras.push({ text: p, start: pos }); pos += p.length + 1; }
  const r = await L.checkParagraphs(paras.map(p => p.text), { variant, goals: GOALS, docText: prose, ai: false });
  const issues = [];
  paras.forEach((p, k) => {
    for (const i of r.paragraphs[k] || []) {
      const off = p.start + i.offset;
      if (off >= refs || (off < front && i.spelling && /^[A-Z]/.test(i.text) && p.start > 0)) continue;
      if (LAYOUT.has(i.rule) || (SENTENCE.has(i.rule) && fragment(p.text))) continue;
      issues.push({ ...i, offset: off });
    }
  });
  const counts = {};
  for (const i of issues) counts[i.category] = (counts[i.category] || 0) + 1;
  const d = L.checkDocument(text, { goals: GOALS, counts });
  const all = [...issues, ...d.issues.filter(i => i.offset < refs)];
  const byArea = Object.fromEntries(AREAS.map(a => [a, all.filter(i => i.category === a).length]));

  // spelling: each word once, with how often it occurs and the suggested spelling
  const words = new Map();
  for (const i of all.filter(x => x.spelling)) {
    const k = i.text.toLowerCase();
    const w = words.get(k) || { word: i.text, count: 0, suggestions: (i.replacements || []).slice(0, 3), context: sentenceAt(text, i.offset), otherVariant: /British|American|US spelling|UK spelling/i.test(i.message || '') };
    w.count++;
    words.set(k, w);
  }
  const spelling = [...words.values()].sort((a, b) => b.count - a.count).slice(0, 40);
  const grammar = all.filter(i => !i.spelling && i.category === 'correctness');
  // examples per area: the most frequent kinds of suggestion first, two of each
  const examples = {};
  for (const a of AREAS) {
    const list = all.filter(i => i.category === a && !i.spelling);
    const kinds = new Map();
    for (const i of list) { const k = i.rule || i.title; if (!kinds.has(k)) kinds.set(k, []); kinds.get(k).push(i); }
    examples[a] = [...kinds.values()].sort((x, y) => y.length - x.length).slice(0, 8).flatMap(g => g.slice(0, 2).map(i => ({
      rule: i.rule, title: i.title, message: i.message, text: i.text.slice(0, 120), replacement: (i.replacements || [])[0] ?? null, context: i.whole ? null : sentenceAt(text, i.offset), count: g.length, engine: i.engine || 'rules'
    }))).slice(0, 12);
  }
  const score = d.score.overall;
  const st = T.stats(prose);
  const level = score >= 85 ? 'ok' : score >= 70 ? 'warn' : 'bad';
  let docId = null;
  if (save && userId) {
    try {
      const row = await db.one('INSERT INTO language_docs(user_id, title, body, original, settings, words, score) VALUES($1, $2, $3, $3, $4, $5, $6) RETURNING id',
        [userId, String(title || 'Manuscript').slice(0, 180) + ' (Full Screening)', text, JSON.stringify({ variant, preset: 'research', goals: GOALS, dismissed: [], disabled: [] }), (text.match(/\S+/g) || []).length, score]);
      docId = row?.id || null;
    } catch (e) { console.warn(`[language screen] copy not saved: ${e.message}`); }
  }
  return {
    kind: 'language', docId, variant, engines: r.engines,
    summary: { score, level, total: all.length, byArea, spelling: words.size, spellingTotal: all.filter(x => x.spelling).length, grammar: grammar.length, variant, words: st.words, flesch: st.readability.flesch, longSentences: st.longSentences },
    areas: d.score.areas, spelling, examples, structure: d.structure || null, tone: d.tone || null,
    method: `PJPS Scribe read the manuscript text above the reference list with research-article goals (formal, expert readers) and ${variant === 'en-GB' ? 'British' : 'American'} spelling, as the manuscript is written: spelling against the general English dictionaries and a research vocabulary of 213,335 medical, pharmaceutical and statistical terms learned from 64,921 published papers (all PJPS articles and PubMed Central open-access papers) and the FDA Orange Book drug names; grammar${r.engines.languagetool === 'ok' ? ' with the grammar server (LanguageTool, about 5,000 rules) and' : ''} with the in-house rules; clarity, wordiness, tone, academic style, P values in PJPS form, Methods tense, abstract length, abbreviations at first use and figure order. The score counts the open suggestions per word. Open the copy in PJPS Scribe to see each suggestion in the text and correct it.`
  };
}

module.exports = { screenLanguage, variantOf, reflow };
