// checks/journal.js - Journal Check: Scopus/WoS indexing, quartiles, HEC HJRS, MEDLINE, DOAJ, predatory & hijacked checks
const S = require('../sources');
const { getJson, getText, isOnline } = require('../http');
const { journalSimilarity, cleanIssn, issnChecksumValid, normalizeJournal } = require('../text');
const D = require('../datasets');
const cfg = require('../config');

const enc = encodeURIComponent;

// ------------------------------------------------------------------ resolution (name / abbreviation / ISSN -> OpenAlex source)

// Offline, or when OpenAlex does not answer, the local copy of the OpenAlex journal list stands in for the live record
// (without topics and listed-in data; output by year is kept for the last eight years)
async function openalexSourceByIssn(issn) {
  if (isOnline()) {
    const r = await S.openalex(`sources?filter=issn:${enc(issn)}&per-page=1`);
    if (r.ok) return r.data.results?.[0] || null;
  }
  return D.openalexJournal({ issns: [issn] }).catch(() => null);
}

async function nlmCatalog(name, issn) {
  // Local NLM Catalog copy first: titles, abbreviations and ISSNs without two E-utilities calls per journal.
  // The live record is still fetched when online because only it carries the current MEDLINE indexing status.
  const local = await D.nlmJournal({ issns: issn ? [issn] : [], name }).catch(() => null);
  if (local && !isOnline()) return { ...local, medline: null };
  const live = await nlmCatalogLive(name, issn || local?.issns?.[0]).catch(() => null);
  if (live) return { ...live, isoAbbrev: local?.isoAbbrev || '', pubmed: local?.pubmed ?? null };
  return local ? { ...local, medline: null } : null;
}

async function nlmCatalogLive(name, issn) {
  const term = issn ? `${issn}[issn]` : `"${name.replace(/\./g, '')}"[ta]`;
  const s = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=nlmcatalog&retmode=json&retmax=1&term=${enc(term)}`);
  const id = s.ok && s.data.esearchresult?.idlist?.[0];
  if (!id) return null;
  const d = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=nlmcatalog&retmode=json&id=${id}`);
  const rec = d.ok && d.data.result?.[id];
  if (!rec) return null;
  return {
    id,
    title: (rec.titlemainlist?.[0]?.title || '').replace(/\.$/, ''),
    abbrev: rec.medlineta || '',
    issns: (rec.issnlist || []).map(i => cleanIssn(i.issn)).filter(Boolean),
    medline: rec.currentindexingstatus === 'Y',
    country: rec.country
  };
}

const resolveCache = new Map();

/** Resolve a journal by ISSN or (possibly abbreviated) name. Returns { source, nlm, issns, name } or null. */
function resolveJournal({ name = '', issn = '' }) {
  const key = `${cleanIssn(issn) || ''}|${normalizeJournal(name)}`;
  if (resolveCache.has(key)) return resolveCache.get(key);
  const p = (async () => {
    let source = null, nlm = null;
    const is = cleanIssn(issn);
    if (is) source = await openalexSourceByIssn(is);
    if (!source && name) {
      const r = await S.openalex(`sources?search=${enc(name.slice(0, 150))}&per-page=5`);
      if (r.ok) {
        const ranked = (r.data.results || []).map(s => ({
          s, sim: Math.max(journalSimilarity(name, s.display_name), ...(s.alternate_titles || []).map(t => journalSimilarity(name, t)), ...(s.abbreviated_title ? [journalSimilarity(name, s.abbreviated_title)] : []))
        })).sort((a, b) => b.sim - a.sim || b.s.works_count - a.s.works_count);
        if (ranked[0]?.sim >= 0.85) source = ranked[0].s;
      } else source = await D.openalexJournal({ name }).catch(() => null);
    }
    if (!source || is) nlm = await nlmCatalog(name, is);
    if (!source && nlm?.issns?.length) {
      for (const i of nlm.issns) { source = await openalexSourceByIssn(i); if (source) break; }
    }
    if (!source && name && !nlm) {
      // Crossref journal registry as a last resort: the local title list first, then the live API
      const local = await D.crossrefJournal({ name }).catch(() => null);
      if (local) {
        for (const i of [local.issn, local.eissn].filter(Boolean)) { source = await openalexSourceByIssn(i); if (source) break; }
        if (!source) return { source: null, nlm: null, crossref: { title: local.title, publisher: local.publisher, source: 'Crossref title list (local copy)' }, issns: [local.issn, local.eissn].filter(Boolean), name: local.title, publisher: local.publisher };
      }
      const c = local ? { ok: false } : await getJson(`https://api.crossref.org/journals?query=${enc(name.slice(0, 150))}&rows=3&mailto=${enc(cfg.CONTACT_EMAIL)}`);
      const hit = c.ok && (c.data.message?.items || []).find(j => journalSimilarity(name, j.title) >= 0.85);
      if (hit) {
        for (const i of hit.ISSN || []) { source = await openalexSourceByIssn(i); if (source) break; }
        if (!source) return { source: null, nlm: null, crossref: hit, issns: (hit.ISSN || []).map(cleanIssn), name: hit.title, publisher: hit.publisher };
      }
    }
    if (!source && !nlm) return null;
    const issns = [...new Set([...(source?.issn || []), ...(nlm?.issns || []), ...(is ? [is] : [])].map(cleanIssn).filter(Boolean))];
    return { source, nlm, issns, name: source?.display_name || nlm?.title || name, publisher: source?.host_organization_name || null };
  })();
  resolveCache.set(key, p);
  // A miss while offline is not an answer: allow a fresh lookup later
  p.then(v => { if (!v && !isOnline()) resolveCache.delete(key); }, () => resolveCache.delete(key));
  return p;
}

// ------------------------------------------------------------------ external checks

async function wikidataScopus(issns) {
  if (!issns.length) return null;
  const values = issns.map(i => `"${i}"`).join(' ');
  const query = `SELECT ?j ?scopus WHERE { VALUES ?issn { ${values} } ?j wdt:P236 ?issn . OPTIONAL { ?j wdt:P1156 ?scopus } } LIMIT 5`;
  const r = await getJson(`https://query.wikidata.org/sparql?query=${enc(query)}`, { headers: { Accept: 'application/sparql-results+json' }, ttl: 30 * 86400 });
  if (!r.ok) return null;
  const b = r.data.results?.bindings || [];
  const scopus = b.find(x => x.scopus)?.scopus?.value || null;
  return { wikidata: b[0]?.j?.value || null, scopusId: scopus };
}

async function doajLookup(issns) {
  const local = await D.doajLocal(issns).catch(() => null);
  if (local) return local;
  for (const i of issns) {
    const r = await getJson(`https://doaj.org/api/search/journals/issn%3A${enc(i)}`, { ttl: 7 * 86400 });
    const j = r.ok && r.data.results?.[0];
    if (j) {
      const b = j.bibjson || {};
      return {
        inDoaj: true,
        title: b.title,
        seal: !!j.admin?.seal,
        apc: b.apc?.has_apc ? (b.apc.max || []).map(m => `${m.price} ${m.currency}`).join(', ') || 'Yes' : 'No',
        review: (b.editorial?.review_process || []).join(', '),
        weeksToPublication: b.publication_time_weeks || null,
        license: (b.license || []).map(l => l.type).join(', '),
        url: b.ref?.journal || null,
        since: j.created_date?.slice(0, 10)
      };
    }
  }
  return { inDoaj: false };
}

async function issnPortal(issn) {
  const r = await getText(`https://portal.issn.org/resource/ISSN/${issn}`, { ttl: 30 * 86400, timeout: 15000, retries: 0 });
  if (r.status === 404) return { registered: false };
  if (!r.ok) return { registered: null };
  const title = (r.text.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  const notFound = /not found|no record|aucun/i.test(title) || !/ISSN/i.test(r.text.slice(0, 20000));
  return { registered: !notFound, title: title.replace(/\s*\|.*$/, '').trim() };
}

// ------------------------------------------------------------------ uploaded-list interpretation

function pick(data, patterns) {
  if (!data) return null;
  for (const p of patterns) {
    const k = Object.keys(data).find(h => p.test(h));
    if (k && data[k] !== '' && data[k] != null) return data[k];
  }
  return null;
}

function interpretLists(hits) {
  const out = {};
  if (hits.sjr) {
    const d = hits.sjr.data;
    out.sjr = {
      quartile: pick(d, [/best quartile/i, /quartile/i]),
      sjr: pick(d, [/^sjr$/i, /^sjr\b/i]),
      hIndex: pick(d, [/h\s*index/i]),
      categories: pick(d, [/categor/i]),
      coverage: pick(d, [/coverage/i]),
      matchedBy: hits.sjr.matchedBy
    };
  }
  if (hits.scopus) {
    const d = hits.scopus.data;
    out.scopus = {
      active: pick(d, [/active/i, /status/i]),
      coverage: pick(d, [/coverage/i]),
      // Elsevier's list: "Active or Inactive" and "Titles Discontinued by Scopus" (the latter is set only for quality-related removals)
      discontinued: /discontinued by scopus/i.test(pick(d, [/discontinued by scopus/i]) || ''),
      inactive: /^inactive$/i.test(String(pick(d, [/^active or inactive$/i]) || '').trim()),
      citeScore: pick(d, [/citescore/i]),
      matchedBy: hits.scopus.matchedBy
    };
  }
  const wos = [];
  // SCImago's WoS filter confirms Core Collection coverage but not which index
  if (hits.wos_sjr) wos.push({ index: 'Web of Science (index not specified)', categories: pick(hits.wos_sjr.data, [/categor/i]), matchedBy: hits.wos_sjr.matchedBy });
  if (wos.length) out.wos = wos;
  if (hits.jcr) {
    const d = hits.jcr.data;
    out.jcr = { quartile: pick(d, [/quartile/i]), jif: pick(d, [/^jif$|impact factor|^jif\b/i]), category: pick(d, [/categor/i]), matchedBy: hits.jcr.matchedBy };
  }
  if (hits.hjrs) {
    const d = hits.hjrs.data;
    out.hjrs = { category: pick(d, [/^category$/i, /hjrs.*cat/i, /categor/i, /^cat/i]), subject: pick(d, [/subject|discipline|area/i]), matchedBy: hits.hjrs.matchedBy };
  }
  if (hits.ebsco) {
    const d = hits.ebsco.data;
    const yes = v => v == null ? null : /^(y|yes|true|1)$/i.test(String(v).trim());
    out.ebsco = {
      database: pick(d, [/^database/i, /^product/i, /^collection/i]),
      peerReviewed: yes(pick(d, [/peer.?review/i])),
      indexStart: pick(d, [/index.*start/i, /abstract.*start/i]),
      indexStop: pick(d, [/index.*stop/i, /abstract.*stop/i]),
      fullTextStart: pick(d, [/full.?text.*start/i]),
      fullTextStop: pick(d, [/full.?text.*stop/i]),
      embargoMonths: pick(d, [/delay|embargo/i]),
      coverage: pick(d, [/coverage policy/i, /coverage/i]),
      matchedBy: hits.ebsco.matchedBy
    };
  }
  if (hits.hec_blacklist) out.hecBlacklist = { matchedBy: hits.hec_blacklist.matchedBy, data: hits.hec_blacklist.data };
  if (hits.doaj_removed) out.doajRemoved = { reason: pick(hits.doaj_removed.data, [/reason/i]), date: pick(hits.doaj_removed.data, [/date/i]) };
  return out;
}

// ------------------------------------------------------------------ main journal report

/**
 * Build the full journal report.
 * input: { name, issn } — or a pre-resolved object from resolveJournal
 */
async function checkJournal(input) {
  const resolved = input.source !== undefined ? input : await resolveJournal(input);
  const name = resolved?.name || input.name || '';
  const issns = resolved?.issns || (cleanIssn(input.issn) ? [cleanIssn(input.issn)] : []);
  const src = resolved?.source || null;
  const offline = !isOnline();

  const [listHits, wd, doaj, rw, predatory, portal] = await Promise.all([
    D.listLookupAll(issns, name),
    wikidataScopus(issns),
    issns.length ? (offline ? D.doajLocal(issns).then(r => r || { inDoaj: null }) : doajLookup(issns)) : { inDoaj: offline ? null : !!src?.is_in_doaj },
    name ? D.journalRetractionCounts(name) : { retractions: 0, concerns: 0, corrections: 0 },
    D.predatoryMatches({ journal: name, publisher: resolved?.publisher, homepage: src?.homepage_url }),
    issns[0] ? issnPortal(issns[0]) : { registered: null }
  ]);
  const lists = interpretLists(listHits);

  const listedIn = src?.listed_in || [];
  const medline = resolved?.nlm?.medline || listedIn.includes('medline');
  const scopusIndexed = lists.sjr || lists.scopus ? !(lists.scopus?.discontinued) : wd?.scopusId ? true : null;
  const scopusSource = lists.scopus || lists.sjr ? 'Uploaded Scopus/SJR list' : wd?.scopusId ? 'Wikidata (Scopus source ID)' : null;
  const counts = (src?.counts_by_year || []).slice().sort((a, b) => a.year - b.year);

  // Output growth: a sudden multi-fold jump is a common paper-mill / mega-journal signal
  let growth = null;
  const thisYear = new Date().getFullYear();
  const recent = counts.filter(c => c.year >= thisYear - 6 && c.year < thisYear);
  if (recent.length >= 4) {
    const early = recent.slice(0, 2).reduce((a, c) => a + c.works_count, 0) / 2;
    const late = recent.slice(-2).reduce((a, c) => a + c.works_count, 0) / 2;
    if (early > 20) growth = late / early;
  }

  const flags = [];
  const flag = (severity, message) => flags.push({ severity, message });
  for (const p of predatory) {
    if (p.kind === 'hijacked') {
      if (p.matchedBy === 'website domain') flag('high', `Website is a known HIJACKED clone of “${p.name}” (genuine site: ${p.genuine_url || 'see list'})`);
      else flag('medium', `A hijacked clone of “${p.name}” exists (${p.domain}) — make sure the cited article is from the genuine journal${p.genuine_url ? ` (${p.genuine_url})` : ''}`);
    } else {
      flag('high', `Listed on Beall's list of potential predatory ${p.kind === 'publisher' ? 'publishers' : 'journals'} (matched by ${p.matchedBy})`);
    }
  }
  if (lists.hecBlacklist) flag('high', 'Listed on the uploaded HEC / institutional blacklist');
  if (lists.doajRemoved) flag('medium', `Removed from DOAJ${lists.doajRemoved.reason ? `: ${lists.doajRemoved.reason}` : ''}`);
  if (lists.scopus?.discontinued) flag('high', 'Coverage discontinued by Scopus');
  else if (lists.scopus?.inactive) flag('low', 'Marked inactive in the Scopus source list (no longer receiving new content)');
  if (issns.length && issns.some(i => !issnChecksumValid(i))) flag('high', 'ISSN has an invalid check digit');
  if (portal.registered === false) flag('high', 'ISSN not found in the official ISSN registry');
  if (!resolved && !offline) flag('medium', 'Journal not found in OpenAlex, NLM Catalog or Crossref');
  const isJournal = !src || src.type === 'journal';
  const indexed = [];
  if (scopusIndexed) indexed.push('Scopus');
  if (lists.wos) indexed.push(...lists.wos.map(w => `WoS ${w.index}`));
  if (medline) indexed.push('MEDLINE');
  if (doaj.inDoaj) indexed.push('DOAJ');
  if (lists.hjrs?.category) indexed.push(`HJRS ${lists.hjrs.category}`);
  if (lists.ebsco) indexed.push('EBSCO');

  // Retractions relative to output — large journals naturally accumulate more in absolute terms
  const works = src?.works_count || 0;
  const retractionRate = works ? rw.retractions / works : 0;
  if (rw.retractions >= 5 && retractionRate >= 0.005) {
    flag(retractionRate >= 0.02 ? 'medium' : 'low', `${rw.retractions} retracted articles (${(retractionRate * 100).toFixed(1)}% of its output) recorded by Retraction Watch`);
  }
  if (isJournal && growth && growth >= 3) flag(indexed.length ? 'low' : 'medium', `Output grew ${growth.toFixed(1)}× in recent years — check editorial standards`);
  if (src && src.last_publication_year && src.last_publication_year < thisYear - 2) flag('low', `No publications indexed since ${src.last_publication_year} (possibly ceased)`);

  let verdict = 'ok';
  if (flags.some(f => f.severity === 'high')) verdict = 'high-risk';
  else if (flags.some(f => f.severity === 'medium') || (isJournal && !indexed.length && resolved)) verdict = 'caution';
  else if (offline && !indexed.length) verdict = 'unknown';

  return {
    query: { name: input.name || '', issn: input.issn || '' },
    found: !!resolved || (offline && (Object.keys(listHits).length > 0 || predatory.length > 0)),
    offline,
    title: name,
    type: src?.type || 'journal',
    publisher: resolved?.publisher || doaj.publisher || null,
    country: src?.country_code || resolved?.nlm?.country || null,
    homepage: src?.homepage_url || doaj.url || null,
    issns,
    issnRegistry: portal,
    openalex: src ? {
      id: src.id?.replace('https://openalex.org/', ''),
      works: src.works_count,
      citedBy: src.cited_by_count,
      hIndex: src.summary_stats?.h_index,
      twoYearMeanCitedness: src.summary_stats?.['2yr_mean_citedness'],
      firstYear: src.first_publication_year,
      lastYear: src.last_publication_year,
      localCopy: !!src.localCopy,
      isOa: src.is_oa,
      apcUsd: src.apc_usd,
      listedIn,
      topics: (src.topics || []).slice(0, 5).map(t => t.display_name),
      worksByYear: counts.slice(-8).map(c => ({ year: c.year, works: c.works_count }))
    } : null,
    nlm: resolved?.nlm || null,
    indexing: {
      scopus: { indexed: scopusIndexed, source: scopusSource, scopusId: wd?.scopusId || null, quartile: lists.sjr?.quartile || null, sjr: lists.sjr?.sjr || null, categories: lists.sjr?.categories || null, citeScore: lists.scopus?.citeScore || null },
      wos: { collections: lists.wos || [], listUploaded: null, jcrQuartile: lists.jcr?.quartile || null, jif: lists.jcr?.jif || null, jcrCategory: lists.jcr?.category || null },
      medline,
      doaj,
      hjrs: lists.hjrs || null,
      ebsco: lists.ebsco || null
    },
    retractions: rw,
    predatory,
    flags,
    indexed,
    verdict,
    growth
  };
}

/**
 * Journal Check for a reference list: groups verified references by journal and checks each journal once.
 */
async function checkCitedJournals(referenceResults, { onProgress, max = 80 } = {}) {
  const groups = new Map();
  for (const r of referenceResults) {
    const rec = r.record;
    const name = rec?.journal || r.parsed.journal;
    if (!name || rec?.type === 'book' || /^arxiv$/i.test(name)) continue;
    const issn = (rec?.issn || [])[0] || '';
    const key = cleanIssn(issn) || normalizeJournal(name);
    if (!groups.has(key)) groups.set(key, { name, issn, refs: [] });
    groups.get(key).refs.push(r.index);
  }
  const entries = [...groups.values()].sort((a, b) => b.refs.length - a.refs.length).slice(0, max);
  let done = 0;
  const out = [];
  let k = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (k < entries.length) {
      const g = entries[k++];
      try {
        const rep = await checkJournal({ name: g.name, issn: g.issn });
        out.push({ ...rep, citedName: g.name, refs: g.refs });
      } catch (e) {
        out.push({ citedName: g.name, refs: g.refs, error: e.message, flags: [], indexed: [], verdict: 'unknown' });
      }
      if (onProgress) onProgress(++done, entries.length);
    }
  }));
  out.sort((a, b) => b.refs.length - a.refs.length);
  const summary = {
    journals: out.length,
    highRisk: out.filter(j => j.verdict === 'high-risk').length,
    caution: out.filter(j => j.verdict === 'caution').length,
    scopus: out.filter(j => j.indexing?.scopus?.indexed).length,
    wos: out.filter(j => j.indexing?.wos?.collections?.length).length,
    medline: out.filter(j => j.indexing?.medline).length,
    predatory: out.filter(j => j.predatory?.some(p => p.kind !== 'hijacked' || p.matchedBy === 'website domain')).length,
    refsInHighRisk: out.filter(j => j.verdict === 'high-risk').reduce((a, j) => a + j.refs.length, 0)
  };
  return { journals: out, summary };
}

module.exports = { resolveJournal, checkJournal, checkCitedJournals, interpretLists, doajLookup, nlmCatalog, pick };
