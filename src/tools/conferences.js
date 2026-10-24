// tools/conferences.js - Find a Conference (proceedings where similar papers were actually published) and
// Check a Conference (year-by-year index coverage by name, acronym or ISBN). Scopus indexes proceedings *sources*,
// not events, so coverage is reported per year. Dates, venues and deadlines are not provided — see the conference site.
const S = require('../sources');
const D = require('../datasets');
const db = require('../db');
const { getJson } = require('../http');
const { relevanceScores, normalize, invertedIndexToText } = require('../text');
const { keyTerms } = require('../editor/reviewers');
const { interpretLists } = require('../checks/journal');
const cfg = require('../config');

const enc = encodeURIComponent;
const short = id => String(id || '').replace('https://openalex.org/', '');
const GENERAL_SERIES = /lecture notes|communications in computer|advances in intelligent systems|aip conference|journal of physics: conference|iop conference series|matec web|e3s web|shs web|procedia|ceur workshop|advances in (?:social|economics|engineering)|atlantis|smart innovation, systems/i;

/** Parse a coverage string like "2010-2013, 2015, 2018-ongoing" into a set of years */
function coverageYears(text) {
  const years = new Set();
  const now = new Date().getFullYear();
  for (const m of String(text || '').matchAll(/((?:19|20)\d{2})\s*(?:[-–]\s*((?:19|20)\d{2}|present|ongoing|current))?/gi)) {
    const a = parseInt(m[1], 10);
    const b = m[2] ? (/\d/.test(m[2]) ? parseInt(m[2], 10) : now) : a;
    for (let y = a; y <= b && y - a < 80; y++) years.add(y);
  }
  return [...years].sort();
}

async function scopusCoverage(issns, name) {
  const lists = interpretLists(await D.listLookupAll(issns, name).catch(() => ({})));
  if (!lists.scopus && !lists.sjr) return { known: false, indexed: null, years: [] };
  const years = coverageYears(lists.scopus?.coverage || lists.sjr?.coverage);
  return { known: true, indexed: !lists.scopus?.discontinued, years, coverage: lists.scopus?.coverage || lists.sjr?.coverage || null };
}

function profileOf(s, extra = {}) {
  const thisYear = new Date().getFullYear();
  const byYear = (s.counts_by_year || []).filter(c => c.works_count > 0).map(c => ({ year: c.year, works: c.works_count })).sort((a, b) => a.year - b.year);
  const recentYears = byYear.filter(c => c.year >= thisYear - 6).map(c => c.year);
  return {
    id: short(s.id), name: s.display_name, acronym: s.abbreviated_title || null, publisher: s.host_organization_name || null,
    issns: s.issn || (s.issn_l ? [s.issn_l] : []), homepage: s.homepage_url || null, works: s.works_count,
    years: byYear, lastYear: byYear.length ? byYear[byYear.length - 1].year : null,
    regularity: `${recentYears.length} of the last 7 years`, annual: recentYears.length >= 5,
    generalSeries: GENERAL_SERIES.test(s.display_name || ''), ...extra
  };
}

/** input: { title, abstract, yearsBack=6 } */
async function findConferences(input, update = () => {}) {
  const title = String(input.title || '').trim();
  if (title.length < 10) throw new Error('Enter the paper title.');
  const abstract = String(input.abstract || '').trim();
  const since = new Date().getFullYear() - (input.yearsBack || 6);
  const query = title.slice(0, 300);
  update('Finding conference papers similar to yours', 10);
  const r = await S.openalex(`works?search=${enc(query)}&filter=from_publication_date:${since}-01-01,primary_location.source.type:conference&per-page=200&select=id,title,publication_year,primary_location,doi,authorships,abstract_inverted_index`);
  if (!r.ok) throw new Error(`OpenAlex search failed (${r.status || r.error})`);
  const works = (r.data.results || []).filter(w => w.primary_location?.source?.id);
  const rel = relevanceScores(`${title} ${title} ${abstract}`, works.map(w => `${w.title || ''} ${invertedIndexToText(w.abstract_inverted_index).slice(0, 1200)}`));
  const groups = new Map();
  works.forEach((w, i) => {
    if (rel[i] < 0.08) return;
    const id = short(w.primary_location.source.id);
    if (!groups.has(id)) groups.set(id, { id, papers: [], relSum: 0, pk: 0 });
    const g = groups.get(id);
    g.papers.push({ title: w.title, year: w.publication_year, doi: w.doi ? w.doi.replace('https://doi.org/', '') : null, rel: rel[i] });
    g.relSum += rel[i];
    if ((w.authorships || []).some(a => (a.institutions || []).some(x => x.country_code === 'PK'))) g.pk++;
  });
  const top = [...groups.values()].sort((a, b) => b.relSum - a.relSum).slice(0, 30);
  update(`Checking coverage of ${top.length} proceedings`, 50);
  const profiles = new Map();
  if (top.length) {
    const p = await S.openalex(`sources?filter=openalex:${top.map(g => g.id).join('|')}&per-page=50`);
    if (p.ok) for (const s of p.data.results || []) profiles.set(short(s.id), s);
  }
  const conferences = [];
  for (const g of top) {
    const s = profiles.get(g.id);
    if (!s) continue;
    const prof = profileOf(s);
    const scopus = await scopusCoverage(prof.issns, prof.name);
    const nextYear = new Date().getFullYear() + 1;
    conferences.push({
      ...prof, similar: g.papers.length, pakistaniPapers: g.pk,
      samples: g.papers.sort((a, b) => b.rel - a.rel).slice(0, 3).map(({ rel: _r, ...x }) => x),
      scopus, upcomingRegistered: scopus.years.includes(nextYear) || scopus.years.includes(nextYear - 1)
    });
  }
  // Community-contributed regional conferences matching the topic
  const kw = keyTerms(`${title} ${abstract}`, 6);
  const community = kw.length ? await db.all(`SELECT id, name, acronym, country, url, topics, indexed_in, note, created_at FROM community_conferences
    WHERE ${kw.map((_, i) => `(topics ILIKE $${i + 1} OR name ILIKE $${i + 1})`).join(' OR ')} ORDER BY created_at DESC LIMIT 20`, kw.map(k => `%${k}%`)) : [];
  return { kind: 'conferences', mode: 'find', title, since, screened: works.length, conferences, community, note: 'Dates, venues and submission deadlines are not provided — open the conference website.' };
}

/** input: { query } — name, acronym or ISBN */
async function checkConference(input) {
  const q = String(input.query || '').trim();
  if (q.length < 2) throw new Error('Enter a conference name, acronym or ISBN.');
  let name = q;
  const isbn = q.replace(/[\s-]/g, '').match(/^(97[89])?\d{9}[\dX]$/i);
  let isbnTitle = null;
  if (isbn) {
    const c = await getJson(`https://api.crossref.org/works?filter=isbn:${enc(q.replace(/[\s-]/g, ''))}&rows=1&mailto=${enc(cfg.CONTACT_EMAIL)}`);
    isbnTitle = c.ok && (c.data.message?.items?.[0]?.['container-title'] || [])[0];
    if (!isbnTitle) {
      const b = await getJson(`https://api.crossref.org/works?query.bibliographic=${enc(q)}&filter=type:proceedings&rows=1&mailto=${enc(cfg.CONTACT_EMAIL)}`);
      isbnTitle = b.ok && (b.data.message?.items?.[0]?.title || [])[0];
    }
    if (!isbnTitle) return { kind: 'conferences', mode: 'check', query: q, candidates: [], note: 'No proceedings with this ISBN were found in Crossref.' };
    name = isbnTitle;
  }
  const r = await S.openalex(`sources?search=${enc(name.slice(0, 200))}&filter=type:conference&per-page=10`);
  const results = r.ok ? r.data.results || [] : [];
  const acr = normalize(q).replace(/\s+/g, '');
  results.sort((a, b) => (normalize(b.abbreviated_title || '').replace(/\s+/g, '') === acr) - (normalize(a.abbreviated_title || '').replace(/\s+/g, '') === acr) || b.works_count - a.works_count);
  const candidates = [];
  for (const s of results.slice(0, 6)) {
    const prof = profileOf(s);
    const scopus = await scopusCoverage(prof.issns, prof.name);
    const allYears = [...new Set([...prof.years.map(y => y.year), ...scopus.years])].sort();
    prof.yearByYear = allYears.slice(-15).map(y => ({ year: y, works: prof.years.find(x => x.year === y)?.works || 0, scopus: scopus.known ? scopus.years.includes(y) : null }));
    candidates.push({ ...prof, scopus });
  }
  const community = await db.all(`SELECT id, name, acronym, country, url, topics, indexed_in, note FROM community_conferences WHERE name ILIKE $1 OR acronym ILIKE $2 LIMIT 10`, [`%${q}%`, q]);
  return {
    kind: 'conferences', mode: 'check', query: q, isbnTitle, candidates, community,
    note: 'Scopus indexes proceedings sources, not conference events: one edition can be covered while another is not. Coverage years come from the uploaded Scopus source list; publication counts come from OpenAlex.'
  };
}

module.exports = { findConferences, checkConference, coverageYears };
