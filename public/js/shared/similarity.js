// shared/similarity.js - how the similarity report counts words and credits them to primary sources. Used by the server
// (src/checks/plagiarism.js, which builds the report, and the Word / PDF export) and by the report view in the browser
// (excluding a source or raising the minimum match length, as in Turnitin's viewer), so the Similarity Index on screen,
// after any change, and in the exported report are always computed the same way.

export const MIN_MATCH = 8; // matches shorter than this many words are not counted (Turnitin's small-match filter)

/** A word as compared: Unicode-normalised (ligatures, full-width forms), lower case, letters and digits, plural "s" off */
export function norm(w) {
  const x = String(w).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return x.length > 4 && x.endsWith('s') && !x.endsWith('ss') ? x.slice(0, -1) : x;
}

/** The words of a text as the report counts them: [{ raw, n, start, end }] (a "word" holds at least one letter or digit) */
export function tokenize(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\S+/g)) {
    const n = norm(m[0]);
    if (n) out.push({ raw: m[0], n, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Number of words in ranges [[from, to), ...] */
const sizeOf = ranges => ranges.reduce((a, [p, q]) => a + q - p, 0);

/**
 * Primary sources: every matched word is credited to one source only, the source with the most matched text first, so
 * the source percentages add up to the Similarity Index. A source left with fewer than minWords words of its own hands
 * them to a larger source that also contains them; words no larger source has stay with it, so no matched text is lost.
 * sources: [{ key, ranges: [[from, to), ...] }] - everything the source matches, in word positions of tokenize(text)
 * -> { owner: Int32Array (source index per word, -1 = not matched), credited: words credited per source }
 */
export function attribute(sources, total, { excluded = [], minWords = MIN_MATCH } = {}) {
  const ex = new Set(excluded);
  const active = sources.map((s, i) => {
    const ranges = ex.has(s.key) ? [] : (s.ranges || []).filter(([p, q]) => q - p >= minWords).map(([p, q]) => [p, Math.min(q, total)]);
    return { i, ranges, size: sizeOf(ranges) };
  });
  const order = active.filter(a => a.size > 0).sort((a, b) => b.size - a.size || a.i - b.i);
  const owner = new Int32Array(total).fill(-1);
  for (const a of order) for (const [p, q] of a.ranges) for (let k = p; k < q; k++) if (owner[k] < 0) owner[k] = a.i;
  const count = () => { const c = new Array(sources.length).fill(0); for (const o of owner) if (o >= 0) c[o]++; return c; };
  const credited = count();
  const covers = (a, k) => a.ranges.some(([p, q]) => k >= p && k < q);
  for (let k = 0; k < total; k++) {
    const o = owner[k];
    if (o < 0 || credited[o] >= minWords) continue;
    const better = order.find(a => a.i !== o && credited[a.i] >= minWords && covers(a, k));
    if (better) owner[k] = better.i;
  }
  return { owner, credited: count() };
}

const pct = (n, total) => (total ? Math.round(n / total * 1000) / 10 : 0);

/** Similarity level: ok below 10 % (largest source below 5 %), bad from 25 % (or one source of 15 %), warn between */
export const levelOf = (similarity, largest) => (similarity >= 25 || largest >= 15 ? 'bad' : similarity >= 10 || largest >= 5 ? 'warn' : 'ok');

/**
 * The report's numbers and highlighted text for a choice of filters.
 * all: every matched source ([...report.sources, ...report.alsoMatched]); text: the compared manuscript text;
 * tokens: tokenize(text) (passed in when already made); total: words compared (the report's summary.words).
 * -> { sources (credited, numbered by share), alsoMatched (matched, but every word credited to a larger source),
 *      summary: { similarity, internet, publications, submissions, largestSource, sources, level, words },
 *      document: [{ t, s }] (text in runs of one source number, 0 = not matched) }
 */
export function recompute(all, text, { tokens = null, total = null, excluded = [], minWords = MIN_MATCH, maxText = Infinity } = {}) {
  const words = tokens || tokenize(text);
  const n = total ?? words.length;
  const { owner, credited } = attribute(all, n, { excluded, minWords });
  const ranked = all.map((s, i) => ({ s, i, words: credited[i] })).filter(x => x.words > 0).sort((a, b) => b.words - a.words || a.i - b.i);
  const number = new Map(ranked.map((x, j) => [x.i, j + 1]));
  const ex = new Set(excluded);
  const sources = ranked.map((x, j) => ({ ...x.s, no: j + 1, percent: pct(x.words, n), similarity: pct(x.words, n), words: x.words }));
  const alsoMatched = all.filter((_, i) => !number.has(i)).map(s => ({ ...s, no: null, percent: 0, similarity: 0, words: 0, excluded: ex.has(s.key) }));
  const byType = type => pct(sources.filter(x => x.type === type).reduce((a, x) => a + x.words, 0), n);
  const similarity = pct(sources.reduce((a, x) => a + x.words, 0), n);
  const largestSource = sources.reduce((m, x) => Math.max(m, x.percent), 0);
  // the text in runs of one source (or none), for the highlighted view
  const document = [];
  const s = text.length;
  const noAt = k => (owner[k] >= 0 ? number.get(owner[k]) || 0 : 0);
  if (words.length && words[0].start > 0) document.push({ t: text.slice(0, Math.min(words[0].start, maxText)), s: 0 });
  for (let k = 0; k < words.length && words[k].start < maxText;) {
    const no = k < n ? noAt(k) : 0;
    let e = k;
    while (e < words.length && (e < n ? noAt(e) : 0) === no) e++;
    const end = e < words.length ? words[e].start : s;
    document.push({ t: text.slice(words[k].start, Math.min(end, maxText)), s: no });
    k = e;
  }
  if (!words.length && text) document.push({ t: text.slice(0, maxText), s: 0 });
  return {
    sources, alsoMatched, document,
    summary: { similarity, internet: byType('internet'), publications: byType('publication'), submissions: byType('submission'), largestSource, sources: sources.length, level: levelOf(similarity, largestSource), words: n }
  };
}
