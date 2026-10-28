// integrity/aiWriting.js - AI-written content screening. Two kinds of evidence:
//   definite traces  - chatbot leftovers ("As an AI language model", "Regenerate response", "[insert citation]") (Module 4 list)
//   writing patterns - vocabulary favoured by large language models, unusually uniform sentence length (low "burstiness"),
//                      stacked transition openers and stock phrases, measured per section.
// Patterns are indicators only: grammar tools, translation and careful non-native writing produce some of them too.
// No text leaves the server and no external "AI probability" service is used.
const { aiLeftovers } = require('../papermill');
const { dimension, finish, words, sentences, sections, ctx } = require('./common');

// Words and phrases that are far more frequent in LLM-written scientific prose than in pre-2023 papers
// (Liang et al. 2024; Kobak et al. 2024 "excess vocabulary"). Single words are matched as whole words.
const LLM_WORDS = ['delve', 'delves', 'delving', 'intricate', 'intricacies', 'pivotal', 'underscore', 'underscores', 'underscoring', 'meticulous', 'meticulously',
  'showcase', 'showcases', 'showcasing', 'commendable', 'realm', 'tapestry', 'multifaceted', 'nuanced', 'paramount', 'groundbreaking', 'leverage', 'leveraging',
  'foster', 'fostering', 'seamless', 'seamlessly', 'holistic', 'endeavor', 'endeavour', 'garner', 'garnered', 'bolster', 'bolstering', 'elucidate', 'elucidating',
  'invaluable', 'noteworthy', 'unwavering', 'testament', 'harnessing', 'unveil', 'unveils', 'unveiling', 'unravel', 'unraveling', 'burgeoning', 'transformative',
  'navigating', 'interplay', 'crucially', 'notably', 'additionally', 'comprehensive', 'profound', 'remarkable', 'synergistic', 'robust'];
const LLM_PHRASES = [/\bplays? an? (?:crucial|pivotal|vital|key|significant) role\b/gi, /\bit is (?:important|worth|crucial) (?:to note|noting)\b/gi, /\bin the realm of\b/gi,
  /\b(?:a|an) (?:deeper|comprehensive|holistic) understanding\b/gi, /\bvaluable insights?\b/gi, /\bpav(?:e|es|ing) the way\b/gi, /\bshed(?:s|ding)? (?:new )?light on\b/gi,
  /\bever[- ]evolving\b/gi, /\bin today's (?:fast-paced|rapidly)\b/gi, /\bnavigat(?:e|ing) the complexities\b/gi, /\bstands? as a testament\b/gi, /\ba myriad of\b/gi,
  /\bholds? (?:great|immense|significant) (?:promise|potential)\b/gi, /\bdelve[sd]? (?:deeper )?into\b/gi, /\bthe (?:intricate|complex) interplay\b/gi];
const OPENERS = /^(?:furthermore|moreover|additionally|in addition|notably|overall|importantly|consequently|thus|hence|in conclusion|in summary|ultimately)\b/i;

const WORD_SET = new Set(LLM_WORDS);

function vocabulary(text) {
  const w = words(text);
  const hits = new Map();
  for (const x of w) if (WORD_SET.has(x)) hits.set(x, (hits.get(x) || 0) + 1);
  const phrases = [];
  for (const re of LLM_PHRASES) for (const m of String(text).matchAll(re)) phrases.push({ found: m[0], quote: ctx(text, m.index, m[0].length, 50) });
  const count = [...hits.values()].reduce((a, b) => a + b, 0) + phrases.length;
  return { words: w.length, count, per1000: w.length ? +(count / w.length * 1000).toFixed(1) : 0, top: [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12), phrases };
}

/** Moving-average type-token ratio over windows of 100 words (length-independent lexical diversity) */
function mattr(w, size = 100) {
  if (w.length < size) return w.length ? new Set(w).size / w.length : 0;
  let sum = 0, n = 0;
  for (let i = 0; i + size <= w.length; i += 25) { sum += new Set(w.slice(i, i + size)).size / size; n++; }
  return +(sum / n).toFixed(3);
}

function rhythm(text) {
  const s = sentences(text);
  const lens = s.map(x => x.split(/\s+/).length);
  const mean = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / (lens.length || 1));
  const openers = s.filter(x => OPENERS.test(x));
  return { sentences: s.length, meanLength: +mean.toFixed(1), cv: lens.length ? +(sd / mean).toFixed(2) : 0, openers: openers.length, openerShare: s.length ? +(openers.length / s.length).toFixed(2) : 0, openerExamples: openers.slice(0, 4) };
}

function analyzeAiWriting(text) {
  const d = dimension('ai', 'AI-written content');
  const sec = sections(text);
  const prose = Object.entries(sec).filter(([k]) => !['references', 'bibliography'].includes(k)).map(([, v]) => v).join('\n');
  const vocab = vocabulary(prose);
  const r = rhythm(prose);
  const lex = mattr(words(prose));
  const bySection = Object.entries(sec).filter(([k, v]) => !['references', 'bibliography', 'front'].includes(k) && words(v).length >= 150)
    .map(([k, v]) => { const x = vocabulary(v); return { section: k, words: x.words, per1000: x.per1000 }; });

  const leftovers = aiLeftovers(text);
  if (leftovers.length) d.sig('leftover', `Chatbot / AI-tool text left in the manuscript (${leftovers.length})`, 'high', 5, leftovers.map(a => ({ text: a.label, quote: a.example })), 'A definite trace: text that only an AI assistant produces. Ask the authors to disclose AI use (ICMJE / COPE policy).');

  // Indicator score 0-100 from the three patterns; each part explained in the evidence
  const parts = [];
  const vScore = Math.min(45, Math.max(0, (vocab.per1000 - 2) * 6));
  if (vScore > 0) parts.push(`LLM-favoured vocabulary ${vocab.per1000}/1,000 words (typical human papers: under 2) → +${Math.round(vScore)}`);
  const cvScore = r.sentences >= 25 && r.cv < 0.42 ? Math.min(30, (0.42 - r.cv) * 150) : 0;
  if (cvScore > 0) parts.push(`Uniform sentence length (variation ${r.cv}; human scientific text usually 0.45-0.65) → +${Math.round(cvScore)}`);
  const oScore = r.sentences >= 20 && r.openerShare > 0.08 ? Math.min(25, (r.openerShare - 0.08) * 200) : 0;
  if (oScore > 0) parts.push(`${Math.round(r.openerShare * 100)}% of sentences start with a stock transition (Furthermore, Moreover, Notably…) → +${Math.round(oScore)}`);
  const score = Math.round(vScore + cvScore + oScore);

  if (score >= 25) {
    const sev = score >= 55 ? 'medium' : 'low';
    d.sig('patterns', `Writing pattern typical of AI-generated text (indicator ${score}/100)`, sev, sev === 'medium' ? 2 : 1,
      [...parts.map(p => ({ text: p })), ...vocab.top.slice(0, 6).map(([w, n]) => ({ text: `“${w}” ×${n}` })), ...vocab.phrases.slice(0, 5).map(p => ({ text: `Stock phrase “${p.found}”`, quote: p.quote }))],
      'Indicators, not proof: grammar and translation tools and careful non-native writing show some of these patterns. Use it to ask the authors about AI assistance, never as the only reason for a decision.');
  }
  const hot = bySection.filter(s => s.per1000 >= 8);
  if (hot.length && score < 25) d.sig('section', `AI-favoured vocabulary concentrated in ${hot.map(s => s.section).join(', ')}`, 'low', 0.5, hot.map(s => ({ text: `${s.section}: ${s.per1000} per 1,000 words` })), 'Sections written in a different style from the rest are sometimes produced with an AI tool.');

  d.details = { score, parts, vocabulary: { per1000: vocab.per1000, count: vocab.count, words: vocab.words, top: vocab.top, phrases: vocab.phrases.slice(0, 10) }, rhythm: r, lexicalDiversity: lex, bySection, leftovers };
  d.checked = vocab.words >= 300;
  return finish(d);
}

module.exports = { analyzeAiWriting, vocabulary, rhythm, mattr };
