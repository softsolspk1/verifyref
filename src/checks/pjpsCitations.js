// checks/pjpsCitations.js - references to articles published by PJPS, found in the PJPS dataset (pjps_articles: every
// article on pjps.pk, src/imageRefs.js) by DOI, or by title and year. A reference found there carries the article
// (r.pjps): its full author list - a self-citation hidden behind "et al." or initials is then found - its volume / issue
// and its pjps.pk page. References naming the journal but not found in the dataset are still counted by the journal name
// (src/editor/pattern.js).
const db = require('../db');
const { titleSimilarity, tokens, cleanDoi, splitName } = require('../text');

const TTL_MS = 6 * 3600 * 1000;   // the dataset grows by a few articles a day (daily cron)
const RETRY_MS = 10 * 60 * 1000;  // an empty or unreadable dataset is read again sooner
const MIN_TITLE = 0.9;            // title similarity accepted (with a compatible year)
let cache = null;

async function dataset() {
  if (cache && Date.now() < cache.until) return cache;
  const rows = await db.all('SELECT article_id, title, authors, year, volume, issue, pages, in_press, doi, url FROM pjps_articles').catch(() => []);
  const byDoi = new Map(), byWord = new Map();
  rows.forEach((a, i) => {
    if (a.doi) byDoi.set(cleanDoi(a.doi), a);
    for (const w of new Set(tokens(a.title).filter(t => t.length >= 4))) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(i);
    }
  });
  cache = { until: Date.now() + (rows.length ? TTL_MS : RETRY_MS), rows, byDoi, byWord };
  return cache;
}

const trusted = r => !!r.record && (['verified', 'retracted'].includes(r.status) || (r.status === 'miscited' && (r.confidence || 0) >= 85));

/** The PJPS article with this title (and a year within one of it), or null */
function byTitle(ds, title, year) {
  const words = [...new Set(tokens(title).filter(t => t.length >= 4))];
  if (words.length < 3) return null;
  const shared = new Map();
  for (const w of words) for (const i of ds.byWord.get(w) || []) shared.set(i, (shared.get(i) || 0) + 1);
  const need = Math.max(3, Math.ceil(words.length * 0.6));
  let best = null, bestScore = 0;
  for (const [i, n] of shared) {
    if (n < need) continue;
    const a = ds.rows[i];
    const y = parseInt(a.year, 10);
    if (year && y && Math.abs(year - y) > 1) continue;
    const s = titleSimilarity(title, a.title);
    if (s >= MIN_TITLE && s > bestScore) { best = a; bestScore = s; }
  }
  return best;
}

/**
 * Mark each reference result that cites a PJPS article: r.pjps = { articleId, title, authors[], year, volume, issue,
 * pages, inPress, doi, url, by: 'DOI' | 'title' }. Never throws; a missing dataset marks nothing.
 */
async function markPjpsArticles(results) {
  try {
    const ds = await dataset();
    if (!ds.rows.length) return results;
    for (const r of results || []) {
      if (!r) continue;
      const dois = [r.parsed?.doi, trusted(r) ? r.record?.doi : null].map(d => cleanDoi(d || '')).filter(Boolean);
      let a = dois.map(d => ds.byDoi.get(d)).find(Boolean) || null;
      const by = a ? 'DOI' : 'title';
      if (!a) {
        const year = parseInt(r.parsed?.year || (trusted(r) ? r.record?.year : null), 10) || null;
        const titles = [...new Set([r.parsed?.title, trusted(r) ? r.record?.title : null].filter(t => t && t.length > 20))];
        for (const t of titles) if ((a = byTitle(ds, t, year))) break;
      }
      if (!a) continue;
      r.pjps = {
        articleId: a.article_id, title: a.title, authors: String(a.authors || '').split(/\s*;\s*/).filter(Boolean),
        year: parseInt(a.year, 10) || null, volume: a.volume || null, issue: a.issue || null, pages: a.pages || null,
        inPress: !!a.in_press, doi: a.doi || null, url: a.url || null, by
      };
    }
  } catch (e) { /* the references are reported without it */ }
  return results;
}

/** The PJPS article's authors as { given, family } */
const pjpsAuthors = r => (r.pjps?.authors || []).map(n => ({ name: n, ...splitName(n) })).filter(a => a.family);

/** Where the article appeared: "Vol. 36, No. 2" or "Article in Press" */
const pjpsWhere = p => (!p ? null : p.inPress || !Number(p.volume) ? 'Article in Press' : `Vol. ${p.volume}, No. ${p.issue}${p.pages ? `, pp. ${p.pages}` : ''}`);

module.exports = { markPjpsArticles, pjpsAuthors, pjpsWhere };
