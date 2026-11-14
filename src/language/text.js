// language/text.js - Module 6 text helpers: sentences and words with their positions, syllables, readability.

const ABBR = /(?:\b(?:e\.g|i\.e|et al|etc|vs|approx|ca|cf|Fig|Figs|Eq|Eqs|Ref|Refs|No|Nos|Vol|pp|Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|Inc|Ltd|Co|Corp|Dept|Univ|resp|viz|al|min|max|sp|spp|var|subsp|cv)|\b[A-Z])\.$/;

/** Sentences of a paragraph: [{ start, end, text }] (end exclusive, trailing spaces excluded) */
function sentences(p) {
  const out = [];
  let start = 0;
  const re = /[.!?]+["'”’)\]]*(?=\s+|$)/g;
  let m;
  while ((m = re.exec(p))) {
    const end = m.index + m[0].length;
    const before = p.slice(start, end);
    // an abbreviation or a decimal is not the end of a sentence; nor is a full stop followed by a lower-case word
    if (m[0] === '.' && ABBR.test(before)) continue;
    const next = p.slice(end).match(/^\s+(\S)/);
    if (next && /[a-z0-9(]/.test(next[1]) && m[0] === '.') continue;
    pushSentence(p, start, end, out);
    start = end;
  }
  pushSentence(p, start, p.length, out);
  return out;
}

function pushSentence(p, start, end, out) {
  while (start < end && /\s/.test(p[start])) start++;
  while (end > start && /\s/.test(p[end - 1])) end--;
  if (end > start) out.push({ start, end, text: p.slice(start, end) });
}

/** Words with positions: [{ w, start, end }] */
function words(s, offset = 0) {
  const out = [];
  for (const m of s.matchAll(/[A-Za-zÀ-ɏͰ-Ͽ][A-Za-z0-9À-ɏͰ-Ͽ'’-]*/g)) {
    let w = m[0].replace(/['’-]+$/, '');
    if (/['’]s$/i.test(w)) w = w.slice(0, -2);
    out.push({ w, start: offset + m.index, end: offset + m.index + w.length });
  }
  return out;
}

function syllables(word) {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}

/** Readability and performance statistics for the whole text */
function stats(text) {
  const paras = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const sents = paras.flatMap(p => sentences(p));
  const w = words(text).map(x => x.w);
  const nW = w.length, nS = Math.max(1, sents.length);
  const syl = w.reduce((a, x) => a + syllables(x), 0);
  const complex = w.filter(x => syllables(x) >= 3 && !/^[A-Z]/.test(x)).length;
  const letters = w.reduce((a, x) => a + x.replace(/[^A-Za-z]/g, '').length, 0);
  const chars = text.length, charsNoSpace = text.replace(/\s/g, '').length;
  const unique = new Set(w.map(x => x.toLowerCase())).size;
  const r1 = n => Math.round(n * 10) / 10;
  const flesch = nW ? r1(206.835 - 1.015 * (nW / nS) - 84.6 * (syl / nW)) : 0;
  const grade = nW ? r1(0.39 * (nW / nS) + 11.8 * (syl / nW) - 15.59) : 0;
  const fog = nW ? r1(0.4 * (nW / nS + 100 * complex / nW)) : 0;
  const smog = nW ? r1(1.043 * Math.sqrt(complex * (30 / nS)) + 3.1291) : 0;
  const coleman = nW ? r1(0.0588 * (letters / nW * 100) - 0.296 * (nS / nW * 100) - 15.8) : 0;
  const longSentences = sents.filter(s => words(s.text).length > 30).length;
  return {
    words: nW, characters: chars, charactersNoSpaces: charsNoSpace, sentences: sents.length, paragraphs: paras.length,
    readingTime: Math.max(nW ? 1 : 0, Math.round(nW / 238 * 60)), speakingTime: Math.max(nW ? 1 : 0, Math.round(nW / 183 * 60)), // seconds
    avgWordLength: nW ? r1(letters / nW) : 0, avgSentenceLength: nW ? r1(nW / nS) : 0, longSentences,
    uniqueWords: unique, uniqueWordsPct: nW ? Math.round(unique / nW * 100) : 0, complexWordsPct: nW ? Math.round(complex / nW * 100) : 0,
    readability: { flesch, grade, fog, smog, coleman, label: fleschLabel(flesch) }
  };
}

function fleschLabel(f) {
  if (f >= 80) return 'Very easy to read';
  if (f >= 70) return 'Easy to read';
  if (f >= 60) return 'Plain English';
  if (f >= 50) return 'Fairly difficult';
  if (f >= 30) return 'Difficult (typical of academic writing)';
  return 'Very difficult';
}

module.exports = { sentences, words, syllables, stats };
