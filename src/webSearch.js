// webSearch.js - exact-phrase web search for the similarity report (Turnitin's "Internet sources"). Uses the first
// provider configured: SerpApi (Google results; SERPAPI_KEY), Brave Search API (BRAVE_API_KEY, Search plan: USD 5 per 1,000 searches, USD 5 free credit a
// month) or Google Programmable Search (GOOGLE_CSE_KEY + GOOGLE_CSE_CX; 100 searches a day free). Only the phrase is
// sent, never the manuscript, and it is cached only under a hash with the links found (http.js "private").
const cfg = require('./config');
const { getJson } = require('./http');
const S = require('./sources');

// what is kept in the cache of a phrase search: the links and titles found, nothing of the query
const keepLinks = (list, url, title) => d => ({ results: (list(d) || []).slice(0, 10).map(o => ({ url: o[url] || null, title: o[title] || null })) });

const provider = () => (S.scholarEnabled() ? 'SerpApi (Google)' : cfg.BRAVE_API_KEY ? 'Brave Search' : cfg.GOOGLE_CSE_KEY && cfg.GOOGLE_CSE_CX ? 'Google Programmable Search' : null);
const enabled = () => !!provider();

/** Results for an exact phrase: { ok, results: [{ url, title }], error? } */
async function phraseSearch(phrase, n = 5) {
  const q = `"${String(phrase).replace(/"/g, '')}"`;
  if (S.scholarEnabled()) {
    const r = await S.serpSearch('google', q, n, { private: true }).catch(e => ({ ok: false, error: e.message }));
    if (r.skipped) return { ok: false, error: 'skipped' };
    return r.ok ? { ok: true, results: (r.data?.organic_results || []).map(o => ({ url: o.link, title: o.title })) } : { ok: false, error: r.error };
  }
  if (cfg.BRAVE_API_KEY) {
    const r = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, { headers: { 'X-Subscription-Token': cfg.BRAVE_API_KEY, Accept: 'application/json' }, ttl: 30 * 86400, timeout: 20000, retries: 1, private: keepLinks(d => d?.web?.results, 'url', 'title') });
    return r.ok ? { ok: true, results: r.data?.results || [] } : { ok: false, error: r.error || `HTTP ${r.status}` };
  }
  if (cfg.GOOGLE_CSE_KEY && cfg.GOOGLE_CSE_CX) {
    const r = await getJson(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(cfg.GOOGLE_CSE_KEY)}&cx=${encodeURIComponent(cfg.GOOGLE_CSE_CX)}&num=${Math.min(10, n)}&q=${encodeURIComponent(q)}`, { ttl: 30 * 86400, timeout: 20000, retries: 1, private: keepLinks(d => d?.items, 'link', 'title') });
    return r.ok ? { ok: true, results: r.data?.results || [] } : { ok: false, error: r.error || `HTTP ${r.status}` };
  }
  return { ok: false, error: 'no web search provider configured' };
}

module.exports = { phraseSearch, enabled, provider };
