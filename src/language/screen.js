// language/screen.js - Module 6 in the Full Screening Report: PJPS Scribe reads the whole manuscript as the editor would
// in the module (research-article goals, the research vocabulary, the grammar server when configured; not the AI, which
// is paid per paragraph) and gives the writing score, the suggestions per area, the spelling and grammar examples the
// editor reads first, and a copy of the text the editor can open in PJPS Scribe to correct it.
const db = require('../db');
const L = require('./index');
const T = require('./text');
const S = require('./spell');

const GOALS = { domain: 'academic', formality: 'formal', audience: 'expert', intent: 'inform', passive: 'allow', abstractWords: 300 }; // PJPS: a structured abstract of at most 300 words
const AREAS = ['correctness', 'clarity', 'engagement', 'delivery', 'style'];
const MAX_TEXT = 400000;

// the same limits as the module's page (public/js/views/language.js): no writing checks in the reference list, and the
// names, departments and cities of the title block above the abstract are not spelling mistakes
const refStart = t => { const m = t.match(/(^|\n)\s*(?:\d+\.?\s*)?(?:references?|bibliography|literature cited|works cited)\s*:?\s*(?=\n|$)/i); return m ? m.index + m[1].length : Infinity; };
const frontEnd = (t, from = 0) => { const m = t.slice(from, from + 4000).match(/(^|\n)\s*abstract\b/i); return m ? from + m.index + m[1].length : from; };

// a reference list without its heading (lost in the Word / PDF text): entries "Liu J, Sun C, Wang Y (2022)",
// "Liu, J., Sun, C." or "Del Rio D, Stewart AJ" with a year; three in a row in the second half of the text start the list
const REF_LINE = /^\s*(?:\[?\d{1,3}[.\])]\s*)?(?:[A-Z][A-Za-z'’-]+(?:\s[A-Z][a-z'’-]+)?,?\s+(?:[A-Z]{1,3}\.?\s?){1,3}(?:[,;(&]|\s+and\b)|[A-Z][A-Za-z'’-]+,\s+(?:[A-Z]\.\s?){1,3})/;
const isRef = p => REF_LINE.test(p) && /\b(?:19|20)\d{2}[a-z]?\b/.test(p);
const refEntry = p => isRef(p) && (p.match(/[A-Z][a-z'’-]+,?\s+[A-Z]{1,3}\.?[,;&]/g) || []).length >= 2;
function refListStart(t) {
  const lines = t.split('\n');
  let pos = 0;
  for (let k = 0; k < lines.length; k++) {
    if (pos > t.length * 0.4 && isRef(lines[k])) {
      const next = lines.slice(k + 1).filter(l => l.trim()).slice(0, 2);
      if (next.length === 2 && next.every(isRef)) return pos;
    }
    pos += lines[k].length + 1;
  }
  return Infinity;
}

// a cover letter before the manuscript ("Dear Editor, ... Sincerely, name"): a letter to the editor, not the article;
// its "you" and "your" and the abbreviations it uses before the abstract defines them are not the manuscript's
function coverEnd(t) {
  if (!/(?:^|\n)\s*(?:cover(?:ing)?\s+letter|dear\s+(?:editors?|sirs?|madam|prof(?:essor)?|dr|reviewers?)\b)/i.test(t.slice(0, 600))) return 0;
  const m = t.slice(0, 15000).match(/(?:^|\n)\s*(?:(?:yours\s+)?(?:sincerely|faithfully|truly)(?:\s+yours)?|(?:with\s+)?(?:best|kind|warm(?:est)?)?\s*regards|respectfully(?:\s+yours)?)\s*[,.]?\s*(?=\n)/i);
  if (!m) return 0;
  let end = m.index + m[0].length + 1;
  const nl = t.indexOf('\n', end);
  const sig = t.slice(end, nl < 0 ? t.length : nl);
  if (sig.trim() && sig.trim().split(/\s+/).length <= 5 && !/[.:]\s*$/.test(sig)) end = nl < 0 ? t.length : nl + 1; // the signature
  return end;
}
const blank = s => s.replace(/[^\n]/g, ' ');

// the same word in the manuscript's spelling (sulphate -> sulfate, analysed -> analyzed, favoured -> favored), if the
// dictionary knows it
const TO_US = [[/ph(?=at|id|ur|on)/, 'f'], [/is(?=e|es|ed|ing|ation|ations)$/, 'iz'], [/ys(?=e|ed|es|ing)$/, 'yz'], [/our/, 'or'], [/tre(?=s?)$/, 'ter'], [/tres$/, 'ters'],
  [/ae/, 'e'], [/oe/, 'e'], [/ll(?=ed|ing)$/, 'l'], [/ogue$/, 'og'], [/ence$/, 'ense']];
function toVariant(word, variant) {
  if (variant === 'en-GB') return null; // British text: the dictionary's own suggestion
  const w = word.toLowerCase();
  const ok = TO_US.map(([re, us]) => w.replace(re, us)).find(t => t !== w && S.check(t, { variant }) && !S.otherVariant(t, variant));
  return ok ? (/^[A-Z]/.test(word) ? ok[0].toUpperCase() + ok.slice(1) : ok) : null;
}

// the surnames of the manuscript's own authors and references (Liu J, Xia and Fang, 2007): names, not misspellings
function namesIn(t) {
  const out = new Set();
  for (const m of t.matchAll(/(?:^|[,;&]\s*|\n\s*(?:\d+\.?\s*)?|\band\s+)([A-Z][a-z'’]+(?:-[A-Z][a-z'’]+)?)(?:\s+[A-Z]{1,3}(?=[,.;(\s])|,\s+(?:[A-Z]\.\s?){1,3}|(?=\s+et\s+al\b|,?\s+(?:19|20)\d\d))/gm)) {
    for (const p of m[1].split('-')) if (p.length >= 2) out.add(p.toLowerCase().replace(/’/g, "'"));
  }
  return out;
}

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
  const original = reflow(String(text || '').replace(/\r\n?/g, '\n')).slice(0, MAX_TEXT);
  if (original.split(/\s+/).length < 150) return { kind: 'language', error: 'Upload the full manuscript text for the language review (only a reference list was provided).' };
  const cover = coverEnd(original);
  text = blank(original.slice(0, cover)) + original.slice(cover);
  const headed = refStart(text);
  const refs = Number.isFinite(headed) ? headed : refListStart(text), front = frontEnd(text, cover);
  const prose = Number.isFinite(refs) ? text.slice(0, refs) : text;
  // the surnames the manuscript cites and its own authors' names are accepted as written
  const personal = namesIn(text.slice(cover));
  const variant = variantOf(prose);
  const paras = [];
  let pos = 0;
  for (const p of text.split('\n')) { if (p.trim() && pos < refs && !refEntry(p)) paras.push({ text: p, start: pos }); pos += p.length + 1; }
  const r = await L.checkParagraphs(paras.map(p => p.text), { variant, goals: GOALS, docText: prose, ai: false, personal: [...personal] });
  const issues = [];
  paras.forEach((p, k) => {
    for (const i of r.paragraphs[k] || []) {
      const off = p.start + i.offset;
      if (off >= refs || (off < front && i.spelling && /^[A-Z]/.test(i.text) && p.start > 0)) continue;
      if (LAYOUT.has(i.rule) || (SENTENCE.has(i.rule) && fragment(p.text))) continue;
      // "analysed" in an American text is correct English (PJPS accepts both): a consistency note, not a misspelling
      if (i.spelling && S.otherVariant(i.text, variant)) {
        const other = variant === 'en-GB' ? 'American' : 'British';
        const same = toVariant(i.text, variant);
        issues.push({ ...i, offset: off, spelling: false, rule: 'variant-mix', replacements: same ? [same] : i.replacements, category: 'style', title: 'British and American spelling mixed',
          message: `"${i.text}" is the ${other} spelling; the manuscript is otherwise written in ${other === 'British' ? 'American' : 'British'} English. Use one spelling throughout.` });
        continue;
      }
      issues.push({ ...i, offset: off });
    }
  });
  const counts = {};
  for (const i of issues) counts[i.category] = (counts[i.category] || 0) + 1;
  // the document checks see where the reference list starts even when its heading was lost
  const d = L.checkDocument(Number.isFinite(refs) && !Number.isFinite(headed) ? `${prose}References\n${text.slice(refs)}` : text, { goals: GOALS, counts });
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
        [userId, String(title || 'Manuscript').slice(0, 180) + ' (Full Screening)', original, JSON.stringify({ variant, preset: 'research', goals: GOALS, dismissed: [], disabled: [] }), (original.match(/\S+/g) || []).length, score]);
      docId = row?.id || null;
    } catch (e) { console.warn(`[language screen] copy not saved: ${e.message}`); }
  }
  return {
    kind: 'language', docId, variant, engines: r.engines,
    summary: { score, level, total: all.length, byArea, spelling: words.size, spellingTotal: all.filter(x => x.spelling).length, grammar: grammar.length, variant, words: st.words, flesch: st.readability.flesch, longSentences: st.longSentences },
    areas: d.score.areas, spelling, examples, structure: d.structure || null, tone: d.tone || null,
    method: `PJPS Scribe read the manuscript text above the reference list (not a cover letter) with research-article goals (formal, expert readers) and ${variant === 'en-GB' ? 'British' : 'American'} spelling, as the manuscript is written: spelling against the general English dictionaries and a research vocabulary of 368,744 medical, pharmaceutical and statistical terms learned from 64,921 published papers (all PJPS articles and PubMed Central open-access papers), the NLM Medical Subject Headings, the FDA Orange Book drug names and the author names of PJPS and the published literature (with the names the manuscript cites); grammar${r.engines.languagetool === 'ok' ? ' with the grammar server (LanguageTool, about 11,200 rules including 5,000 for medical and pharmaceutical writing) and' : ''} with the in-house rules; clarity, wordiness, tone, academic style, P values in PJPS form, Methods tense, abstract length, abbreviations at first use and figure order. The score counts the open suggestions per word. Open the copy in PJPS Scribe to see each suggestion in the text and correct it.`
  };
}

module.exports = { screenLanguage, variantOf, reflow, coverEnd, refListStart, namesIn };
