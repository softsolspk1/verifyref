// webSearch.js - exact-phrase web search for the similarity report (Turnitin's "Internet sources"). Uses the first
// provider configured: Brave Search API (BRAVE_API_KEY, Search plan: USD 5 per 1,000 searches, USD 5 free credit a
// month), Google Programmable Search (GOOGLE_CSE_KEY + GOOGLE_CSE_CX; 100 searches a day free) or SerpApi (Google
// results; SERPAPI_KEY). SerpApi comes last: its searches are few (250 a month on the free plan) and kept for Google Scholar. Only the phrase is
// sent, never the manuscript, and it is cached only under a hash with the links found (http.js "private").
const cfg = require('./config');
const { getJson } = require('./http');
const S = require('./sources');

// what is kept in the cache of a phrase search: the links and titles found, nothing of the query
const keepLinks = (list, url, title, snippet) => d => ({ results: (list(d) || []).slice(0, 10).map(o => ({ url: o[url] || null, title: o[title] || null, snippet: String(o[snippet] || '').replace(/<[^>]+>/g, '').slice(0, 300) })) });

const provider = () => (cfg.BRAVE_API_KEY ? 'Brave Search' : cfg.GOOGLE_CSE_KEY && cfg.GOOGLE_CSE_CX ? 'Google Programmable Search' : S.scholarEnabled() ? 'SerpApi (Google)' : null);
const enabled = () => !!provider();

/** Results for an exact phrase: { ok, results: [{ url, title }], error? } */
// extra: search operators after the phrase ("filetype:pdf")
async function phraseSearch(phrase, n = 5, extra = '') {
  const q = `"${String(phrase).replace(/"/g, '')}"${extra ? ` ${extra}` : ''}`;
  if (provider() === 'SerpApi (Google)') {
    const r = await S.serpSearch('google', q, n, { private: true }).catch(e => ({ ok: false, error: e.message }));
    if (r.skipped) return { ok: false, error: 'skipped' };
    return r.ok ? { ok: true, results: (r.data?.organic_results || []).map(o => ({ url: o.link, title: o.title })) } : { ok: false, error: r.error };
  }
  // a fresh answer comes back as the provider sent it, a cached one as keepLinks kept it: both read the same way (fresh
  // answers were read as empty before 6 Nov 2026, so a passage was only found when it was searched a second time)
  const linksOf = (r, keep) => (Array.isArray(r.data?.results) ? r.data.results : keep(r.data).results);
  if (cfg.BRAVE_API_KEY) {
    const keep = keepLinks(d => d?.web?.results, 'url', 'title', 'description');
    const r = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, { headers: { 'X-Subscription-Token': cfg.BRAVE_API_KEY, Accept: 'application/json' }, ttl: 30 * 86400, timeout: 20000, retries: 1, private: keep });
    return r.ok ? { ok: true, results: linksOf(r, keep) } : { ok: false, error: r.error || `HTTP ${r.status}` };
  }
  if (cfg.GOOGLE_CSE_KEY && cfg.GOOGLE_CSE_CX) {
    const keep = keepLinks(d => d?.items, 'link', 'title', 'snippet');
    const r = await getJson(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(cfg.GOOGLE_CSE_KEY)}&cx=${encodeURIComponent(cfg.GOOGLE_CSE_CX)}&num=${Math.min(10, n)}&q=${encodeURIComponent(q)}`, { ttl: 30 * 86400, timeout: 20000, retries: 1, private: keep });
    return r.ok ? { ok: true, results: linksOf(r, keep) } : { ok: false, error: r.error || `HTTP ${r.status}` };
  }
  return { ok: false, error: 'no web search provider configured' };
}

module.exports = { phraseSearch, enabled, provider };
