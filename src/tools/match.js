// tools/match.js - claim ↔ passage matching used by Verify Citations, Find Evidence and the Thesis/Paper Assistant.
// Runs locally (no external AI): stemmed term coverage weighted by rarity, figure (number) matching and
// direction-of-effect / negation conflicts. Scores are 0..1.
const { normalize, STOPWORDS } = require('../text');

const EXTRA_STOP = new Set(('also however although thus therefore moreover furthermore whereas which while may might can could would should ' +
  'shown show showed shows found reported report reports reported observed observe study studies research paper article present previous ' +
  'previously recent recently several various many much more most less least other others such well one two three significant significantly ' +
  'et al fig figure table data level levels high higher low lower patients participants').split(' '));

function stem(w) {
  let s = w.toLowerCase();
  if (s.length <= 4) return s;
  for (const suf of ['ational', 'ization', 'iveness', 'fulness', 'ousness', 'ically', 'ations', 'ation', 'ities', 'ments', 'ness', 'ment', 'ings', 'ing', 'ies', 'ied', 'ive', 'ize', 'ise', 'ed', 'es', 'ly', 'al', 's']) {
    if (s.endsWith(suf) && s.length - suf.length >= 4) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}

function terms(text) {
  return normalize(text).split(' ').filter(t => t.length >= 3 && !/^\d+$/.test(t) && !STOPWORDS.has(t) && !EXTRA_STOP.has(t)).map(stem);
}

/** Numbers that carry meaning (percentages, doses, counts) — not years, not citation numbers in brackets */
function numbersIn(text) {
  const t = String(text).replace(/\[[\d,\s–\-]+\]/g, ' ').replace(/\((?:[^()]*?(?:19|20)\d{2}[a-z]?)\)/g, ' ');
  const out = [];
  for (const m of t.matchAll(/(?<![\w.])(\d+(?:[.,]\d+)?)(\s?%|\s?(?:mg|g|kg|ml|mL|µg|ug|mmol|mM|µM|nM|h|hr|hours|days|weeks|months|years|fold))?(?![\w.]*\d)/g)) {
    const n = m[1].replace(',', '.');
    const v = parseFloat(n);
    if (!m[2] && v >= 1900 && v <= 2100 && !n.includes('.')) continue; // a year
    if (!m[2] && v < 10 && !n.includes('.')) continue;                  // small counts / list numbers
    out.push(n.replace(/\.0+$/, ''));
  }
  return [...new Set(out)];
}

const UP = /\b(increas|elevat|enhanc|improv|rais|higher|greater|more|promot|stimulat|upregulat|induc|augment|boost)/i;
const DOWN = /\b(decreas|reduc|lower|diminish|declin|inhibit|suppress|attenuat|downregulat|less|fewer|lowered|impair|prevent)/i;
const NEG = /\b(no|not|without|neither|nor|failed to|did not|does not|was not|were not|non-?significant|insignificant|no significant)\b/i;
const CAUSAL = /\b(causes?|caused|leads? to|led to|results? in|resulted in|proves?|proved|demonstrates? that|determin(?:es|ed)|is responsible for)\b/i;
const HEDGED = /\b(associated|association|correlat|linked|related|may|might|suggest|possibl|potential)/i;
const ABSOLUTE = /\b(all|always|never|every|completely|entirely|universally|undoubtedly|clearly|certainly)\b/i;

function polarity(text) {
  const up = UP.test(text), down = DOWN.test(text);
  return { up: up && !down, down: down && !up, neg: NEG.test(text) };
}

/** Split text into sentences with character offsets */
function sentenceSpans(text) {
  const spans = [];
  const s = String(text || '');
  let start = 0;
  const re = /([.!?])(["”’)\]]*)\s+(?=["“(\[]?[\p{Lu}\d])|\n+/gu;
  let m;
  while ((m = re.exec(s))) {
    const end = m.index + (m[0].startsWith('\n') ? 0 : m[1].length + m[2].length);
    const before = s.slice(start, m.index);
    const lastWord = (before.match(/(\S+)$/) || ['', ''])[1];
    if (!m[0].startsWith('\n') && (/^(?:[\p{Lu}]|al|vs|eds?|vol|no|pp|Fig|Figs|Eq|Dr|St|i\.e|e\.g|ca|approx|resp)$/iu.test(lastWord.replace(/\.$/, '')) || /^(?:[\p{Lu}]\.)+[\p{Lu}]?$/u.test(lastWord))) continue;
    const textPart = s.slice(start, end).trim();
    if (textPart) spans.push({ start, end, text: textPart });
    start = m.index + m[0].length;
  }
  const rest = s.slice(start).trim();
  if (rest) spans.push({ start, end: s.length, text: rest });
  return spans;
}

/** Passages: single sentences and pairs of adjacent sentences, from one source text */
function passagesOf(text, meta = {}) {
  const sents = sentenceSpans(text).map(x => x.text).filter(x => x.length > 25 && x.length < 1200);
  const out = [];
  sents.forEach((x, i) => {
    out.push({ ...meta, text: x });
    if (i + 1 < sents.length && x.length + sents[i + 1].length < 900) out.push({ ...meta, text: `${x} ${sents[i + 1]}`, pair: true });
  });
  return out;
}

/** Document frequencies over a set of passages */
function idfOf(passages) {
  const df = new Map();
  for (const p of passages) for (const t of new Set(terms(p.text))) df.set(t, (df.get(t) || 0) + 1);
  const N = passages.length + 1;
  return t => Math.log(1 + N / ((df.get(t) || 0) + 0.5));
}

/** Score one passage against a claim */
function scorePassage(claim, passage, idf) {
  const ct = [...new Set(terms(claim))];
  if (!ct.length) return { score: 0, coverage: 0 };
  const pt = new Set(terms(passage.text));
  let have = 0, total = 0;
  const missing = [];
  for (const t of ct) {
    const w = idf(t);
    total += w;
    if (pt.has(t)) have += w; else missing.push(t);
  }
  const coverage = total ? have / total : 0;
  // adjacent-term bonus: shared bigrams indicate the same statement rather than shared vocabulary
  const cb = new Set(); const ctl = terms(claim); for (let i = 0; i + 1 < ctl.length; i++) cb.add(`${ctl[i]} ${ctl[i + 1]}`);
  const ptl = terms(passage.text); let bi = 0; for (let i = 0; i + 1 < ptl.length; i++) if (cb.has(`${ptl[i]} ${ptl[i + 1]}`)) bi++;
  const bigram = cb.size ? Math.min(1, bi / Math.max(2, cb.size * 0.5)) : 0;
  const cn = numbersIn(claim), pn = numbersIn(passage.text);
  const numbersFound = cn.filter(n => pn.includes(n));
  const cp = polarity(claim), pp = polarity(passage.text);
  const conflict = (cp.up && pp.down) || (cp.down && pp.up) || (cp.neg !== pp.neg && /signific|effect|differ|associat|chang/i.test(claim) && coverage > 0.4);
  let score = coverage * 0.8 + bigram * 0.2;
  if (cn.length) score *= 0.75 + 0.25 * (numbersFound.length / cn.length);
  if (conflict) score *= 0.6;
  // A passage that itself cites other work is background (a secondary citation), not this source's finding
  if (/\[\d|\b(?:et al\.?|and [A-Z]\w+),?\s\(?(?:19|20)\d{2}|\([A-Z]\w+(?: et al\.)?,? (?:19|20)\d{2}|\[\s*,/.test(passage.text)) score *= 0.85;
  return { score, coverage, bigram, numbers: { claim: cn, found: numbersFound }, conflict, missing: missing.slice(0, 8), pair: !!passage.pair };
}

/** Best passages for a claim among passages [{ text, origin, page, ... }] */
function bestPassages(claim, passages, n = 3) {
  if (!passages.length) return [];
  const idf = idfOf(passages);
  return passages.map(p => ({ ...p, ...scorePassage(claim, p, idf) }))
    .sort((a, b) => b.score - a.score || (a.pair ? 1 : -1))
    .slice(0, n);
}

/** Verdict for a claim given its best passage and whether full text was available */
function verdictOf(best, { fullText }) {
  if (!best) return { verdict: 'could-not-verify', reason: 'The source text (full text or abstract) is not available', notes: ['The source text (full text or abstract) is not available — upload the PDF of the cited work to check this claim'] };
  const notes = [];
  if (best.numbers?.claim?.length && best.numbers.found.length < best.numbers.claim.length) notes.push(`Figures not found in the source: ${best.numbers.claim.filter(x => !best.numbers.found.includes(x)).join(', ')}`);
  if (best.conflict) notes.push('The source appears to state the opposite direction or a negative finding');
  if (!fullText) notes.push('Compared with the abstract only');
  let verdict;
  if (best.score >= 0.58 && !best.conflict && !(best.numbers?.claim?.length && !best.numbers.found.length)) verdict = 'full';
  else if (best.conflict && best.score >= 0.45) { verdict = 'unsupported'; notes.push('The source contradicts the claim: it reports the opposite direction or a negative finding'); }
  else if (best.score >= 0.33) verdict = 'partial';
  else verdict = fullText ? 'unsupported' : 'unsupported';
  if (verdict === 'unsupported' && !fullText) notes.push('Unsupported by the abstract — the full text may still support it; upload the PDF to check');
  return { verdict, notes };
}

/** Suggest more cautious wording when a claim says more than the source supports */
function adjustWording(claim, evidence) {
  let s = String(claim).trim();
  const changes = [];
  if (CAUSAL.test(s) && (!CAUSAL.test(evidence) || HEDGED.test(evidence))) {
    s = s.replace(CAUSAL, m => (/result|lead|led/i.test(m) ? 'is associated with' : /prove|demonstrat|determin/i.test(m) ? 'suggests' : 'is associated with'));
    changes.push('Causal wording replaced: the source reports an association, not a cause');
  }
  if (ABSOLUTE.test(s) && !ABSOLUTE.test(evidence)) {
    s = s.replace(/\b(all|every)\b/gi, 'many').replace(/\b(always)\b/gi, 'often').replace(/\b(never)\b/gi, 'rarely').replace(/\b(completely|entirely|universally|undoubtedly|clearly|certainly)\s+/gi, '');
    changes.push('Absolute terms softened');
  }
  const cn = numbersIn(s), en = numbersIn(evidence);
  const missing = cn.filter(n => !en.includes(n));
  if (missing.length) {
    for (const n of missing) s = s.replace(new RegExp(`\\s*(?:by|of|to|in)?\\s*${n.replace('.', '\\.')}\\s?%?`), '');
    changes.push(`Figures not found in the source removed (${missing.join(', ')})`);
  }
  if (/\b(significant(ly)?)\b/i.test(s) && !/signific|p\s*[<=]/i.test(evidence)) {
    s = s.replace(/\bsignificantly\s+/i, '').replace(/\bsignificant\s+/i, '');
    changes.push('"Significant" removed — the source does not report statistical significance');
  }
  return changes.length ? { wording: s.replace(/\s{2,}/g, ' '), changes } : null;
}

module.exports = { terms, stem, numbersIn, sentenceSpans, passagesOf, idfOf, scorePassage, bestPassages, verdictOf, adjustWording, polarity };
