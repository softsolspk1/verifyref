// tools/journalFinder.js - Find a Journal: venues ranked by how many papers like yours they actually published in the
// last three years, enriched with indexing (Scopus/SJR, Web of Science, JCR, HEC HJRS, MEDLINE, DOAJ), access and APC,
// time to publication and risk signals. Filtering (the decision bar) happens in the browser on the returned attributes.
const S = require('../sources');
const D = require('../datasets');
const { relevanceScores } = require('../text');
const { interpretLists, doajLookup, nlmCatalog } = require('../checks/journal');

const enc = encodeURIComponent;
const short = id => String(id || '').replace('https://openalex.org/', '');

function quartileNum(q) {
  const m = String(q || '').match(/Q([1-4])/i);
  return m ? parseInt(m[1], 10) : null;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

/**
 * input: { title, abstract, yearsBack=3, scope: 'any'|'pakistan' }
 */
async function findJournals(input, update = () => {}) {
  const title = String(input.title || '').trim();
  if (title.length < 10) throw new Error('Enter the paper title (the abstract improves the match).');
  const abstract = String(input.abstract || '').trim();
  const since = new Date().getFullYear() - (input.yearsBack || 3);
  // Search by title (broad recall); the abstract is used to rank the hits, not to narrow the search
  const query = title.slice(0, 300);

  update('Finding papers similar to yours', 8);
  const select = 'id,title,publication_year,primary_location,doi,abstract_inverted_index,authorships';
  const filter = `from_publication_date:${since}-01-01,type:article|review,primary_location.source.type:journal`;
  const pages = await Promise.all([1, 2, 3].map(page => S.openalex(`works?search=${enc(query)}&filter=${filter}&per-page=200&page=${page}&select=${select}`)));
  if (!pages[0].ok) throw new Error(`OpenAlex search failed (${pages[0].status || pages[0].error})${pages[0].status === 429 ? ' — daily limit reached; add an OPENALEX_API_KEY' : ''}`);
  const works = pages.flatMap(p => (p.ok ? p.data.results || [] : [])).filter(w => w.primary_location?.source?.id);
  if (!works.length) return { kind: 'journal-finder', title, journals: [], screened: 0, note: 'No similar recent papers were found. Try a broader title.' };

  const { invertedIndexToText } = require('../text');
  const docs = works.map(w => `${w.title || ''} ${invertedIndexToText(w.abstract_inverted_index).slice(0, 1500)}`);
  const rel = relevanceScores(`${title} ${title} ${abstract}`, docs);

  // Group similar papers by journal
  const bySource = new Map();
  works.forEach((w, i) => {
    if (rel[i] < 0.08) return;
    const src = w.primary_location.source;
    const id = short(src.id);
    if (!bySource.has(id)) bySource.set(id, { id, name: src.display_name, papers: [], relSum: 0, pk: 0 });
    const g = bySource.get(id);
    g.papers.push({ title: w.title, year: w.publication_year, doi: w.doi ? w.doi.replace('https://doi.org/', '') : null, rel: rel[i] });
    g.relSum += rel[i];
    if ((w.authorships || []).some(a => (a.institutions || []).some(x => x.country_code === 'PK'))) g.pk++;
  });
  const groups = [...bySource.values()].sort((a, b) => b.relSum - a.relSum).slice(0, 40);
  if (!groups.length) return { kind: 'journal-finder', title, journals: [], screened: works.length, note: 'Recent papers were found but none is close enough to your title. Add the abstract or broaden the title.' };

  update(`Profiling ${groups.length} journals`, 30);
  const profiles = new Map();
  for (let i = 0; i < groups.length; i += 50) {
    const ids = groups.slice(i, i + 50).map(g => g.id).join('|');
    const r = await S.openalex(`sources?filter=openalex:${ids}&per-page=50`);
    if (r.ok) for (const s of r.data.results || []) profiles.set(short(s.id), s);
  }

  const thisYear = new Date().getFullYear();
  const journals = [];
  await pool(groups, 4, async g => {
    const s = profiles.get(g.id) || {};
    const issns = s.issn || (s.issn_l ? [s.issn_l] : []);
    const lists = interpretLists(await D.listLookupAll(issns, s.display_name || g.name).catch(() => ({})));
    const pred = await D.predatoryMatches({ journal: s.display_name || g.name, publisher: s.host_organization_name, homepage: s.homepage_url }).catch(() => []);
    const byYear = Object.fromEntries((s.counts_by_year || []).map(c => [c.year, c.works_count]));
    const lastFull = byYear[thisYear - 1] || 0;
    const base = Math.max(1, ((byYear[thisYear - 3] || 0) + (byYear[thisYear - 4] || 0)) / 2);
    const flags = [];
    if (pred.some(p => p.kind === 'hijacked' && p.matchedBy === 'website domain')) flags.push({ severity: 'high', message: 'This website is a known hijacked clone of the journal (it may be collecting fees)' });
    else if (pred.some(p => p.kind === 'hijacked')) flags.push({ severity: 'medium', message: `A hijacked clone of this journal exists${pred.find(p => p.domain)?.domain ? ` (${pred.find(p => p.domain).domain})` : ''} — submit only through the genuine journal site` });
    if (pred.some(p => p.kind !== 'hijacked')) flags.push({ severity: 'high', message: `Matches Beall's list (${pred.filter(p => p.kind !== 'hijacked').map(p => p.kind).join(', ')})` });
    if (lists.hecBlacklist) flags.push({ severity: 'high', message: 'On the uploaded HEC / institutional blacklist' });
    if (lists.scopus?.discontinued) flags.push({ severity: 'high', message: 'Discontinued in Scopus — the quartile may no longer hold' });
    if (s.apc_usd > 1500 && !s.is_in_doaj) flags.push({ severity: 'medium', message: `High APC ($${s.apc_usd}) without DOAJ listing` });
    if (lastFull > 400 && lastFull > base * 2.5) flags.push({ severity: 'medium', message: `Output grew sharply (${base.toFixed(0)} → ${lastFull} articles a year)` });
    const sjrQ = quartileNum(lists.sjr?.quartile), jcrQ = quartileNum(lists.jcr?.quartile);
    const avgRel = g.relSum / g.papers.length;
    journals.push({
      id: g.id, name: s.display_name || g.name, publisher: s.host_organization_name || null, issns, homepage: s.homepage_url || null, country: s.country_code || null,
      similar: g.papers.length, relevance: Math.round(g.relSum * 100) / 100, pakistaniPapers: g.pk,
      samples: g.papers.sort((a, b) => b.rel - a.rel).slice(0, 3).map(({ rel: _r, ...p }) => p),
      scopeMatch: g.papers.length >= 3 && avgRel >= 0.12 ? 'strong' : 'weak',
      oa: !!s.is_oa, doaj: !!s.is_in_doaj, apcUsd: s.apc_usd ?? null, diamond: !!s.is_oa && !!s.is_in_doaj && (s.apc_usd === 0),
      worksLastYear: lastFull, citedness: s.summary_stats?.['2yr_mean_citedness'] ?? null, hIndex: s.summary_stats?.h_index ?? null,
      indexing: {
        scopus: lists.sjr || lists.scopus ? !lists.scopus?.discontinued : null,
        sjrQuartile: sjrQ, citeScore: lists.scopus?.citeScore || null,
        wos: (lists.wos || []).map(w => w.index), jcrQuartile: jcrQ, jif: lists.jcr?.jif || null,
        hjrs: lists.hjrs?.category ? String(lists.hjrs.category).trim().toUpperCase().slice(0, 1) : null,
        ebsco: !!lists.ebsco,
        medline: null
      },
      quartile: [sjrQ, jcrQ].filter(Boolean).sort()[0] || null,
      weeksToPublication: null,
      flags
    });
  });

  // MEDLINE status and declared time to publication (DOAJ) for the strongest candidates
  journals.sort((a, b) => b.relevance - a.relevance);
  update('Checking MEDLINE and publication times', 70);
  let n = 0;
  await pool(journals.slice(0, 25), 2, async j => {
    const [nlm, doaj] = await Promise.all([
      nlmCatalog(j.name, j.issns[0] || '').catch(() => null),
      j.doaj ? doajLookup(j.issns).catch(() => null) : null
    ]);
    j.indexing.medline = nlm ? !!nlm.medline : false;
    if (doaj?.weeksToPublication) j.weeksToPublication = doaj.weeksToPublication;
    if (doaj?.apc) j.apcDeclared = doaj.apc;
    n++;
    update(`Checking MEDLINE and publication times (${n}/25)`, 70 + n);
  });

  const listsLoaded = (await D.listStatus().catch(() => ({ lists: [] }))).lists.filter(l => l.row_count).map(l => l.type);
  return {
    kind: 'journal-finder', title, abstract: abstract.slice(0, 3000), since, screened: works.length, journals,
    listsLoaded,
    note: listsLoaded.length ? null : 'Scopus, Web of Science, JCR and HEC HJRS columns need the journal lists uploaded by the Super Admin.'
  };
}

module.exports = { findJournals };
