// text.js - normalization, similarity, names and relevance helpers

const STOPWORDS = new Set(('a an and are as at be by for from has have in into is it its of on or that the their this to was were with ' +
  'we our study studies using use used based between effect effects analysis new via among during after than within ' +
  'toward towards versus vs role evaluation assessment approach results result case review').split(' '));

function stripDiacritics(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function normalize(s) {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function tokens(s, { keepStop = false } = {}) {
  return normalize(s).split(' ').filter(t => t && (keepStop || !STOPWORDS.has(t)));
}

/** Dice coefficient on word bigrams + unigrams; robust to small edits and word order */
function titleSimilarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length > 25 && nb.length > 25 && (na.includes(nb) || nb.includes(na))) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length) * 0.15 + 0.85;
  }
  const grams = s => {
    const out = new Map();
    const t = s.replace(/ /g, '');
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2);
      out.set(g, (out.get(g) || 0) + 1);
    }
    return out;
  };
  const ga = grams(na), gb = grams(nb);
  let inter = 0, total = 0;
  for (const [g, c] of ga) { inter += Math.min(c, gb.get(g) || 0); total += c; }
  for (const c of gb.values()) total += c;
  const charDice = total ? (2 * inter) / total : 0;

  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  let wi = 0;
  for (const t of ta) if (tb.has(t)) wi++;
  const wordDice = ta.size + tb.size ? (2 * wi) / (ta.size + tb.size) : 0;
  return Math.max(charDice * 0.6 + wordDice * 0.4, wordDice);
}

/** Does the cited title contain (most of) the registered title, accounting for subtitle omission? */
function titleContains(cited, registered) {
  const tr = tokens(registered), tc = new Set(tokens(cited));
  if (tr.length === 0) return 0;
  let hit = 0;
  for (const t of tr) if (tc.has(t)) hit++;
  return hit / tr.length;
}

function surnameKey(s) {
  return normalize(s).replace(/\s+/g, '');
}

/** Split a display name ("J. A. Smith", "Smith, John A.", "Muhammad Ali Khan") into {given, family} */
function splitName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return { given: '', family: '' };
  if (n.includes(',')) {
    const [family, given] = n.split(',', 2).map(x => x.trim());
    return { given, family };
  }
  const parts = n.split(' ');
  // "Smith JA" (Vancouver) — trailing token is initials
  if (parts.length >= 2 && /^[A-Z]{1,3}$/.test(parts[parts.length - 1])) {
    return { family: parts.slice(0, -1).join(' '), given: parts[parts.length - 1].split('').join('. ') + '.' };
  }
  const particles = new Set(['van', 'von', 'de', 'der', 'da', 'del', 'di', 'la', 'le', 'al', 'el', 'bin', 'ibn', 'ul', 'ur']);
  let i = parts.length - 1;
  while (i > 1 && particles.has(parts[i - 1].toLowerCase())) i--;
  return { given: parts.slice(0, i).join(' '), family: parts.slice(i).join(' ') };
}

// Initials written together, as in Vancouver / PJPS style ("Hewlings SJ"): two to four capitals, not a short name
const joinedInitials = g => /^[A-Z]{2,4}$/.test(String(g || '').trim());

function initials(given) {
  if (joinedInitials(given)) return String(given).trim();
  return stripDiacritics(given || '').split(/[\s.\-]+/).filter(Boolean).map(p => p[0].toUpperCase()).join('');
}

/**
 * Compare two person names. Returns 'exact' (family + first initial match, compatible given),
 * 'likely' (family + first initial), or null.
 */
function nameMatch(a, b) {
  const A = typeof a === 'string' ? splitName(a) : a;
  const B = typeof b === 'string' ? splitName(b) : b;
  const fa = surnameKey(A.family), fb = surnameKey(B.family);
  if (!fa || !fb) return null;
  // Allow swapped order for South-Asian names written either way ("Khan Muhammad" vs "Muhammad Khan")
  const famMatch = fa === fb;
  const swapped = !famMatch && surnameKey(A.given) === fb && surnameKey(B.given) === fa;
  // East-Asian order mix-ups: "Shi Z" cited, registry has given "Shi", family "Zhaoran"
  const swappedInitial = !famMatch && !swapped && (
    (fa === surnameKey(B.given) && initials(A.given)[0] && initials(A.given)[0] === initials(B.family)[0]) ||
    (fb === surnameKey(A.given) && initials(B.given)[0] && initials(B.given)[0] === initials(A.family)[0]));
  if (swappedInitial) return 'likely';
  if (!famMatch && !swapped) return null;
  if (swapped) return 'likely';
  const ia = initials(A.given), ib = initials(B.given);
  if (!ia || !ib) return 'likely';
  if (ia[0] !== ib[0]) return null;
  const ga = joinedInitials(A.given) ? ia[0].toLowerCase() : normalize(A.given).split(' ')[0];
  const gb = joinedInitials(B.given) ? ib[0].toLowerCase() : normalize(B.given).split(' ')[0];
  if (ga.length > 1 && gb.length > 1) return ga === gb ? 'exact' : null;
  return ia === ib || ia.startsWith(ib) || ib.startsWith(ia) ? 'exact' : 'likely';
}

function normalizeJournal(name) {
  return normalize(name)
    .replace(/\bthe\b/g, '')
    .replace(/\bj\b/g, 'journal')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Journal names: handles ISO abbreviations ("Pak J Pharm Sci" vs "Pakistan Journal of Pharmaceutical Sciences") */
function journalSimilarity(a, b) {
  const ta = normalize(a).split(' ').filter(t => t && !['of', 'the', 'and', 'for', 'in', 'on'].includes(t));
  const tb = normalize(b).split(' ').filter(t => t && !['of', 'the', 'and', 'for', 'in', 'on'].includes(t));
  if (!ta.length || !tb.length) return 0;
  if (ta.join(' ') === tb.join(' ')) return 1;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  // Each abbreviated token must prefix a token of the long name, in order
  let j = 0, matched = 0;
  for (const s of short) {
    while (j < long.length && !long[j].startsWith(s) && !(s.length > 3 && long[j].startsWith(s.slice(0, 4)))) j++;
    if (j < long.length) { matched++; j++; }
  }
  const prefixScore = matched / short.length * (short.length / long.length > 0.5 ? 1 : 0.85);
  return Math.max(prefixScore, titleSimilarity(a, b));
}

function cleanDoi(doi) {
  if (!doi) return null;
  let d = String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  while (d && '.,;:)}]>'.includes(d[d.length - 1])) d = d.slice(0, -1);
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d.toLowerCase() : null;
}

function cleanIssn(s) {
  const m = String(s || '').toUpperCase().match(/(\d{4})-?(\d{3}[\dX])/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function issnChecksumValid(issn) {
  const c = cleanIssn(issn);
  if (!c) return false;
  const digits = c.replace('-', '');
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += parseInt(digits[i], 10) * (8 - i);
  const check = (11 - (sum % 11)) % 11;
  return (check === 10 ? 'X' : String(check)) === digits[7];
}

// ---- Relevance (TF-IDF cosine over a small corpus) ----

function termFreq(text) {
  const tf = new Map();
  for (const t of tokens(text)) {
    if (t.length < 3 || /^\d+$/.test(t)) continue;
    const stem = t.replace(/(ies|es|s|ing|ed|al|ity)$/, '') || t;
    tf.set(stem, (tf.get(stem) || 0) + 1);
  }
  return tf;
}

/**
 * Score each document's relevance to the query text, 0..1.
 * docs: array of strings. Returns array of scores aligned with docs.
 */
function relevanceScores(query, docs) {
  const q = termFreq(query);
  const docTfs = docs.map(termFreq);
  const df = new Map();
  for (const tf of [q, ...docTfs]) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docTfs.length + 1;
  const vec = tf => {
    const v = new Map();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * Math.log(1 + N / (df.get(t) || 1));
      v.set(t, w);
      norm += w * w;
    }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const qv = vec(q);
  return docTfs.map(tf => {
    const dv = vec(tf);
    let dot = 0;
    for (const [t, w] of dv.v) if (qv.v.has(t)) dot += w * qv.v.get(t);
    return dot / (qv.norm * dv.norm);
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Rebuild an abstract from OpenAlex's inverted index */
function invertedIndexToText(idx) {
  if (!idx) return '';
  const words = [];
  for (const [w, positions] of Object.entries(idx)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(' ');
}

module.exports = {
  normalize, tokens, titleSimilarity, titleContains, splitName, initials, nameMatch, surnameKey,
  normalizeJournal, journalSimilarity, cleanDoi, cleanIssn, issnChecksumValid, relevanceScores,
  stripDiacritics, escapeHtml, invertedIndexToText, STOPWORDS
};
