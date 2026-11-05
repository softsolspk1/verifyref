// tools/match.js - claim ↔ passage matching used by Verify Citations, Find Evidence and the Thesis/Paper Assistant.
// Runs locally (no external AI): stemmed term coverage weighted by rarity, figure (number) matching and
// direction-of-effect / negation conflicts. Scores are 0..1. judge() then lets a small language model on this server
// (tools/nli.js) read the top passages for meaning.
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
  // proportions and amounts written in words: "one in five" = 1/5, "half" = 1/2, "$5 billion" = 5e9
  const WORD_N = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, hundred: 100, thousand: 1000 };
  for (const m of t.matchAll(/\b(one|two|three|\d+) (?:in|out of) (two|three|four|five|six|seven|eight|nine|ten|twenty|hundred|thousand|\d+)\b/gi)) {
    const a = WORD_N[m[1].toLowerCase()] ?? +m[1], b = WORD_N[m[2].toLowerCase()] ?? +m[2];
    if (a && b) out.push(`${a}/${b}`);
  }
  for (const m of t.matchAll(/(\d+(?:[.,]\d+)?)\s*(million|billion|trillion)\b/gi)) out.push(`${m[1].replace(',', '.')} ${m[2].toLowerCase()}`);
  return [...new Set(out)];
}

const UP = /\b(increas|elevat|enhanc|improv|rais|higher|greater|more|promot|stimulat|upregulat|induc|augment|boost)/i;
const DOWN = /\b(decreas|reduc|lower|diminish|declin|inhibit|suppress|attenuat|downregulat|less|fewer|lowered|impair|prevent)/i;
const NEG = /\b(no|not|without|neither|nor|failed to|did not|does not|was not|were not|non-?significant|insignificant|no significant)\b/i;
const CAUSAL = /\b(causes?|caused|leads? to|led to|results? in|resulted in|proves?|proved|demonstrates? that|determin(?:es|ed)|is responsible for)\b/i;
const HEDGED = /\b(associated|association|correlat|linked|related|may|might|suggest|possibl|potential)/i;
const ABSOLUTE = /\b(all|always|never|every|completely|entirely|universally|undoubtedly|clearly|certainly)\b/i;

/**
 * A claim term that the passage negates: "no activity was observed against E. coli" for a claim that the extract "was active
 * against E. coli". A negation word followed within three words by a term of the claim (same 5-letter stem).
 */
const NEG_WORD = new Set(['no', 'not', 'without', 'never', 'neither', 'nor', 'none', 'lack', 'lacked', 'lacks', 'absence', 'failed', 'fail', 'fails']);
function negatedClaimTerm(passageText, claimTerms) {
  const keys = new Set(claimTerms.filter(t => t.length >= 5).map(t => t.slice(0, 5)));
  const words = normalize(passageText).split(' ');
  for (let i = 0; i < words.length; i++) {
    if (!NEG_WORD.has(words[i])) continue;
    for (const w of words.slice(i + 1, i + 4)) if (w.length >= 5 && keys.has(stem(w).slice(0, 5))) return w;
  }
  return null;
}

/**
 * The claim says its subject relies on / is based on / uses a thing, and the passage says the subject does without it:
 * "the Transformer relies on recurrent networks" / "the Transformer ... dispensing with recurrence". A word of doing
 * without, followed within three words by a claim term, in a passage that also names another claim term (the subject).
 * Unambiguous words only: "without" and "free of" also describe groups ("women without cancer"), and "depends on" states
 * a condition, not a component (both gave false contradictions on SciFact).
 */
const RELY = /\b(?:rel(?:y|ies|ied|ying) (?:up)?on|(?:is |are |was |were )?(?:based|built|centred|centered) on|(?:uses?|using|employs?|requires?)\b)/i;
const DO_WITHOUT = new Set(['dispensing', 'dispenses', 'dispensed', 'eschewing', 'eschews', 'eschewed', 'instead', 'abandoning', 'abandons', 'replacing', 'replaces', 'avoiding', 'avoids']);
function doneWithout(claim, passageText, claimTerms) {
  // a claim that itself does without something ("uses attention without recurrence") agrees with such a passage
  if (!RELY.test(claim) || normalize(claim).split(' ').some(w => DO_WITHOUT.has(w) || NEG_WORD.has(w))) return null;
  const keys = new Set(claimTerms.filter(t => t.length >= 5).map(t => t.slice(0, 5)));
  const words = normalize(passageText).split(' ');
  for (let i = 0; i < words.length; i++) {
    if (!DO_WITHOUT.has(words[i])) continue;
    const hit = words.slice(i + 1, i + 4).find(w => w.length >= 5 && keys.has(stem(w).slice(0, 5)));
    if (!hit) continue;
    // the subject: another claim term, compared on six letters ("transformer" is not "transduction")
    const keys6 = new Set(claimTerms.filter(t => t.length >= 6).map(t => t.slice(0, 6)));
    const other = words.find((w, j) => (j < i || j > i + 3) && w.length >= 6 && keys6.has(stem(w).slice(0, 6)) && stem(w).slice(0, 5) !== stem(hit).slice(0, 5));
    if (other) return { term: hit, subject: stem(other).slice(0, 6) };
  }
  return null;
}

// direction of an effect, word by word (stems as written in text, lower case)
const DIR_UP = /^(increas|elevat|enhanc|improv|rais|higher|greater|promot|stimulat|upregulat|up-regulat|induc|augment|boost|activat|accelerat|facilitat|potentiat|amplif|exacerbat|worsen|gain|overexpress)/;
const DIR_DOWN = /^(decreas|reduc|lower|diminish|declin|inhibit|suppress|attenuat|downregulat|down-regulat|impair|imped|prevent|block|abolish|abrogat|delay|deactivat|antagoni|loss|lose|lost|ameliorat|alleviat|protect)/;
const dirOf = w => (DIR_UP.test(w) ? 1 : DIR_DOWN.test(w) ? -1 : 0);

/**
 * Direction of the effect stated about the terms a claim and a passage share: the direction words within four words of
 * each shared term (left out: terms that are themselves direction words). 1 up, -1 down, 0 none or mixed.
 */
function directionAround(text, shared) {
  const words = normalize(text).split(' ');
  let up = 0, down = 0;
  words.forEach((w, i) => {
    if (!shared.has(stem(w)) || dirOf(w)) return;
    for (const x of words.slice(Math.max(0, i - 4), i + 5)) { const d = dirOf(x); if (d > 0) up++; else if (d < 0) down++; }
  });
  return up > down ? 1 : down > up ? -1 : 0;
}

/**
 * Word pairs of opposite meaning: the claim uses one side and the passage only the other ("UCP1-dependent" / "UCP1-
 * independent", "scarce" / "expanded", "ineffective" / "effective"). Curated; a pair is used only when the passage does
 * not also use the claim's own word. Set on the SciFact train split, checked on the held-out dev split.
 */
const OPPOSITES = [
  [/\b\w+-dependent\b|\bdependent on\b/, /\b\w+-independent\b|\bindependent of\b/],
  [/\bineffective\b|\bnot effective\b|\bno benefit\b/, /\b(effective|efficacious|improved outcomes?|improvements?|beneficial)\b/],
  [/\binaccurate\b|\bunreliable\b/, /\b(more |highly )?(accurate|reliable)\b/],
  [/\bincapable\b|\bunable\b|\bcannot\b/, /\b(elicit\w*|produc\w*|capable|able to|induc\w*|generat\w*)\b/],
  [/\bscarce\b|\brare\b|\babsent\b|\bdepleted\b/, /\b(expanded|abundant|enriched|accumulat\w*|prevalent|frequent)\b/],
  [/\bimmune to\b|\bresistant to\b|\bprotected (from|against)\b/, /\b(hypersensitive|susceptib\w*|vulnerab\w*|prone to|sensiti[sz]ed)\b/],
  [/\b(vulnerab\w*|susceptib\w*|prone to)\b/, /\b(protected|resistant|immune)\b/],
  [/\bunrelated\b|\bnot (associated|related|linked)\b|\bno (association|relationship)\b/, /\b(increased odds|associated with (a |an )?(higher|increased|greater|lower|reduced|decreased))\b/],
  [/\b(dispensable|nonessential|non-essential|not required)\b/, /\b(required|essential|necessary|indispensable)\b/],
  [/\b(required|essential|necessary|indispensable)\b/, /\b(dispensable|nonessential|non-essential|not required)\b/],
  [/\bdeactivat\w*\b/, /\bactivat\w*\b/],
  [/\b(harmful|detrimental|damag\w*|impairs?)\b/, /\b(beneficial|protect\w*|leads to (early )?control|improv\w*)\b/],
  [/\bslows?\b|\bdelays?\b|\bretards?\b/, /\b(promot\w*|accelerat\w*|speed\w* up|hasten\w*)\b/],
  [/\bincreases? (the )?(risk|incidence|odds)\b/, /\b(lower|reduced|decreased) (risk|incidence|odds)\b|\brisk ratio[^.]{0,20}\b0\.\d/],
  [/\bdecreases? (the )?(risk|incidence|odds)\b/, /\b(higher|increased|greater) (risk|incidence|odds)\b/]
];
function oppositeWording(claim, passage) {
  const c = claim.toLowerCase(), p = passage.toLowerCase();
  for (const [a, b] of OPPOSITES) {
    const ma = c.match(a);
    if (!ma || !b.test(p)) continue;
    if (p.includes(ma[0])) continue;                         // the source uses the claim's own word as well
    if (b.test(c)) continue;                                   // the claim itself carries both sides
    return { claim: ma[0], source: p.match(b)[0] };
  }
  return null;
}

function polarity(text) {
  const up = UP.test(text), down = DOWN.test(text);
  return { up: up && !down, down: down && !up, neg: NEG.test(text) };
}

/** Split text into sentences with character offsets */
function sentenceSpans(text) {
  const spans = [];
  const s = String(text || '');
  let start = 0;
  const re = /([.!?])(["”’)\]]*)\s+(?=["“([]?[\p{Lu}\d])|\n+/gu;
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

// Terms of the whole source (title + text) kept on each passage; a Symbol key so it is never serialised into results
const DOC = Symbol('docTerms');

/** Passages: single sentences and pairs of adjacent sentences, from one source text */
function passagesOf(text, meta = {}) {
  const sents = sentenceSpans(text).map(x => x.text).filter(x => x.length > 25 && x.length < 1200);
  const doc = new Set(terms(`${meta.title || ''} ${text}`));
  const out = [];
  const add = p => { p[DOC] = doc; out.push(p); };
  sents.forEach((x, i) => {
    add({ ...meta, text: x });
    if (i + 1 < sents.length && x.length + sents[i + 1].length < 900) add({ ...meta, text: `${x} ${sents[i + 1]}`, pair: true });
  });
  return out;
}

/** "N. sativa" in a source means "Nigella sativa" when the claim names the full binomial (and the other way round) */
function expandBinomials(claim, text) {
  let out = String(text);
  for (const m of String(claim).matchAll(/\b([A-Z][a-z]{3,})\s+([a-z]{4,})\b/g)) {
    out = out.replace(new RegExp(String.raw`\b${m[1][0]}\.\s*${m[2]}\b`, 'g'), `${m[1]} ${m[2]}`);
  }
  return out;
}

/** The claim without its citations: author names and years in "(Khan et al., 2021)" or "[3]" are not claim content */
const withoutCitations = claim => String(claim).replace(/\([^()]*\b(?:19|20)\d{2}[a-z]?[^()]*\)/g, ' ').replace(/\[[\d,\s–-]+\]/g, ' ');

/**
 * The claim as the language model reads it: no citations and no narrative attribution. A citation in the hypothesis
 * makes the model reject a passage that states the claim word for word ("… task (Vaswani et al., 2017)." entailment 0.00,
 * the same sentence without it 0.99), and "Khan et al. (2019) showed that X" is checked as "X".
 */
const VERB = '(?:showed|shown|reported|found|demonstrated|observed|suggested|noted|stated|concluded|confirmed|revealed|indicated|described|proposed)';
function claimForModel(claim) {
  return String(claim)
    .replace(new RegExp(`^\\s*(?:As\\s+${VERB}\\s+by\\s+|According\\s+to\\s+)?[\\p{Lu}][\\p{L}'’-]+(?:\\s+(?:et\\s+al\\.?|(?:and|&)\\s+[\\p{Lu}][\\p{L}'’-]+))?\\s*\\(\\s*(?:19|20)\\d{2}[a-z]?\\s*\\)\\s*(?:(?:have|has|had)\\s+)?(?:${VERB}\\s+(?:that\\s+)?|,\\s*)?`, 'u'), '')
    .replace(/\([^()]*\b(?:19|20)\d{2}[a-z]?[^()]*\)/g, ' ').replace(/\[[\d,\s–-]+\]/g, ' ')
    .replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim()
    .replace(/^\p{Ll}/u, c => c.toUpperCase());
}

/** Document frequencies over a set of passages */
function idfOf(passages) {
  const df = new Map();
  for (const p of passages) for (const t of new Set(terms(p.text))) df.set(t, (df.get(t) || 0) + 1);
  const N = passages.length + 1;
  return t => Math.log(1 + N / ((df.get(t) || 0) + 0.5));
}

/** Score one passage against a claim */
function scorePassage(rawClaim, passage, idf) {
  const claim = withoutCitations(rawClaim);
  const ct = [...new Set(terms(claim))];
  if (!ct.length) return { score: 0, coverage: 0 };
  const ptext = expandBinomials(claim, passage.text);
  const pt = new Set(terms(ptext));
  // Abbreviations in the claim ("N. sativa") expanded from the source as well
  const doc = passage[DOC] ? new Set([...passage[DOC], ...terms(expandBinomials(claim, [...passage[DOC]].join(' ')))]) : null;
  let have = 0, total = 0;
  const missing = [];
  for (const t of ct) {
    const w = idf(t);
    total += w;
    if (pt.has(t)) have += w;
    else {
      missing.push(t);
      // A term the source discusses elsewhere (title, another sentence of the abstract) gives part of the credit
      if (doc?.has(t)) have += w * 0.5;
    }
  }
  const coverage = total ? have / total : 0;
  // adjacent-term bonus: shared bigrams indicate the same statement rather than shared vocabulary
  const cb = new Set(); const ctl = terms(claim); for (let i = 0; i + 1 < ctl.length; i++) cb.add(`${ctl[i]} ${ctl[i + 1]}`);
  const ptl = terms(ptext); let bi = 0; for (let i = 0; i + 1 < ptl.length; i++) if (cb.has(`${ptl[i]} ${ptl[i + 1]}`)) bi++;
  const bigram = cb.size ? Math.min(1, bi / Math.max(2, cb.size * 0.5)) : 0;
  const cn = numbersIn(claim), pn = numbersIn(passage.text);
  const numbersFound = cn.filter(n => pn.includes(n));
  const cp = polarity(claim), pp = polarity(passage.text);
  // the effect around the shared terms points the other way ("X impedes Y" / "X promotes Y")
  const shared = new Set(ct.filter(t => pt.has(t)));
  const dc = coverage > 0.5 ? directionAround(claim, shared) : 0, dp = dc ? directionAround(ptext, shared) : 0;
  const conflict = (cp.up && pp.down) || (cp.down && pp.up) || (cp.neg !== pp.neg && /signific|effect|differ|associat|chang/i.test(claim) && coverage > 0.4)
    || (!cp.neg && coverage > 0.4 && !!negatedClaimTerm(passage.text, ctl))
    || (dc && dp && dc !== dp)
    || (coverage > 0.45 && !!oppositeWording(claim, passage.text));
  // a narrower contradiction, decided at a low coverage only (a passage restating the claim is not one): the source does
  // without what the claim says is relied on
  const without = !conflict && coverage >= 0.2 && coverage <= 0.5 ? doneWithout(claim, passage.text, ctl) : null;
  const exclusion = !!without;
  let score = coverage * 0.8 + bigram * 0.2;
  if (cn.length) score *= 0.75 + 0.25 * (numbersFound.length / cn.length);
  if (conflict || exclusion) score *= 0.6;
  // A passage that itself cites other work is background (a secondary citation), not this source's finding
  if (/\[\d|\b(?:et al\.?|and [A-Z]\w+),?\s\(?(?:19|20)\d{2}|\([A-Z]\w+(?: et al\.)?,? (?:19|20)\d{2}|\[\s*,/.test(passage.text)) score *= 0.85;
  return { score, coverage, bigram, numbers: { claim: cn, found: numbersFound }, conflict: conflict || exclusion, exclusion, subject: without?.subject || null, missing: missing.slice(0, 8), pair: !!passage.pair };
}

/** Best passages for a claim among passages [{ text, origin, page, ... }] */
function bestPassages(claim, passages, n = 3) {
  if (!passages.length) return [];
  const idf = idfOf(passages);
  const ranked = passages.map(p => ({ ...p, ...scorePassage(claim, p, idf) }))
    .sort((a, b) => b.score - a.score || (a.pair ? 1 : -1));
  // a passage that covers the claim at least as well as the best one and contradicts it decides the verdict: the source
  // speaks to this claim and says the opposite (its score was lowered by the conflict, so it would otherwise rank below)
  const top = ranked[0];
  const against = ranked.filter(p => p.conflict && (p.coverage > 0.5 || p.exclusion) && p.coverage >= top.coverage).sort((a, b) => b.coverage - a.coverage)[0];
  // or a passage that does without what the claim relies on and is the one naming the claim's subject ("the Transformer")
  // while the best-scored passage does not (background on the thing relied on: "recurrent networks are established")
  const hasSubject = (p, sub) => normalize(p.text).split(' ').some(w => stem(w).slice(0, 6) === sub);
  const without = against ? null : ranked.find(p => p.exclusion && p.subject && !hasSubject(top, p.subject));
  const lead = against || without;
  if (lead && lead !== top) ranked.splice(ranked.indexOf(lead), 1), ranked.unshift(lead);
  return ranked.slice(0, n);
}

/** Verdict for a claim given its best passage and whether full text was available */
function verdictOf(best, { fullText, decided } = {}) {
  if (!best) return { verdict: 'could-not-verify', reason: 'The source text (full text or abstract) is not available', notes: ['The source text (full text or abstract) is not available — upload the PDF of the cited work to check this claim'] };
  const notes = [];
  if (best.numbers?.claim?.length && best.numbers.found.length < best.numbers.claim.length) notes.push(`Figures not found in the source: ${best.numbers.claim.filter(x => !best.numbers.found.includes(x)).join(', ')}`);
  if (decided ? decided === 'contradicts' : best.conflict) notes.push('The source appears to state the opposite direction or a negative finding');
  if (!fullText) notes.push('Compared with the abstract only');
  let verdict;
  // decided by the language model (tools/nli.js): its reading of meaning replaces the word thresholds
  if (decided) {
    verdict = decided === 'contradicts' ? 'unsupported' : decided;
    if (decided === 'contradicts') notes.push('The source contradicts the claim: it reports the opposite direction or a negative finding');
  } else if (best.score >= 0.58 && !best.conflict && !(best.numbers?.claim?.length && !best.numbers.found.length)) verdict = 'full';
  else if (best.conflict && (best.score >= 0.45 || best.coverage > 0.5 || best.exclusion)) { verdict = 'unsupported'; notes.push('The source contradicts the claim: it reports the opposite direction or a negative finding'); }
  else if (best.score >= 0.33) verdict = 'partial';
  else verdict = fullText ? 'unsupported' : 'unsupported';
  if (verdict === 'unsupported' && !fullText) notes.push('Unsupported by the abstract — the full text may still support it; upload the PDF to check');
  return { verdict, notes };
}

/**
 * A source names its subject once ("we propose … the Transformer") and then writes "our model achieves 28.4 BLEU": the
 * model, reading one passage, cannot know they are the same. When the claim's subject (a capitalised name in the claim)
 * is named elsewhere in the source but not in the passage, the model reads that name in place of "our model / the
 * proposed method / this extract". Only the model's input (modelText) changes; the editor sees the passage as written.
 */
const SELF_REF = /\b(?:our|the\s+proposed|this|the\s+present)\s+(?:new\s+)?(model|method|approach|system|network|architecture|algorithm|framework|technique|formulation|compound|extract|drug|assay|device|tool|scheme)\b/i;
function withSubject(claim, top, passages) {
  // a capitalised name the source itself writes mid-sentence (so not an ordinary word that starts a sentence)
  const doc = passages.map(p => p.text).join(' ');
  const subject = [...claim.matchAll(/(?:^|\s)(?:[Tt]he\s+)?([\p{Lu}][\p{L}\d-]{2,}(?:\s+[\p{Lu}][\p{L}\d-]{2,}){0,2})/gu)].map(m => m[1]).find(n => doc.includes(` ${n}`));
  if (!subject) return top;
  return top.map(p => (!p.text.includes(subject) && SELF_REF.test(p.text) ? { ...p, modelText: p.text.replace(SELF_REF, `the ${subject}`) } : p));
}

/**
 * Verdict for a claim against one source's passages, corrected by the language model when it is available (tools/nli.js):
 * { best, verdict, notes, conflict }. best is the evidence passage shown to the editor - the one the model judged on.
 * deadline (ms timestamp): after it the word matcher alone decides (long manuscripts on a time-limited server).
 */
async function judge(claim, passages, { fullText, deadline } = {}) {
  const top = passages?.length ? bestPassages(claim, passages, 3) : [];
  const base = verdictOf(top[0], { fullText });
  if (!top.length) return { best: null, ...base, conflict: false };
  const modelClaim = claimForModel(claim);
  const d = await require('./nli').decide(modelClaim, withSubject(modelClaim, top, passages), base, { deadline }).catch(() => null);
  if (!d) return { best: top[0], ...base, conflict: base.verdict === 'unsupported' && !!top[0].conflict };
  const v = verdictOf(d.passage, { fullText, decided: d.decision });
  const [reading, prob] = [['states the claim', d.entailment], ['contradicts the claim', d.contradiction], ['neither states nor contradicts the claim', 1 - d.entailment - d.contradiction]].reduce((a, b) => (b[1] > a[1] ? b : a));
  v.notes.push(`Meaning checked by the language model: the passage ${reading} (${Math.round(prob * 100)}%)`);
  return { best: d.passage, ...v, conflict: d.decision === 'contradicts', model: { entailment: d.entailment, contradiction: d.contradiction } };
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

module.exports = { terms, stem, numbersIn, sentenceSpans, passagesOf, idfOf, scorePassage, bestPassages, verdictOf, judge, adjustWording, polarity, claimForModel };
