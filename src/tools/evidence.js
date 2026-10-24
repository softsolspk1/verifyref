// tools/evidence.js - Find Evidence: published sources that support a sentence, with the verbatim evidence passage,
// evidence level (full text / abstract), a formatted citation and — when the claim says more than the source —
// a more cautious wording. Retracted papers are excluded.
const S = require('../sources');
const ST = require('../styles');
const M = require('./match');
const FT = require('./fulltext');
const { getJson } = require('../http');
const { cleanDoi, splitName } = require('../text');
const { retractionsFor } = require('../datasets');

const enc = encodeURIComponent;

/** Search query from a claim: the most distinctive content words, original spelling */
function queryOf(claim, context = '') {
  const words = (`${claim} ${context}`).replace(/\[[^\]]*\]|\([^)]*\d{4}[^)]*\)/g, ' ').match(/[\p{L}][\p{L}\-]{2,}/gu) || [];
  const seen = new Set();
  const stems = new Set(M.terms(claim));
  const picked = [];
  for (const w of words.sort((a, b) => b.length - a.length)) {
    const st = M.stem(w.toLowerCase());
    if (seen.has(st) || !stems.has(st) && !M.terms(context).includes(st)) continue;
    seen.add(st);
    picked.push(w);
    if (picked.length >= 8) break;
  }
  return picked.join(' ');
}

function fromEuropePmc(e) {
  return {
    source: 'Europe PMC',
    title: (e.title || '').replace(/\.$/, ''),
    authors: (e.authorList?.author || []).map(a => (a.lastName ? { given: a.firstName || a.initials || '', family: a.lastName } : { family: a.fullName || a.collectiveName || '', corporate: !!a.collectiveName })),
    year: parseInt(e.pubYear, 10) || null,
    journal: e.journalInfo?.journal?.title || '',
    journalAbbrev: e.journalInfo?.journal?.isoabbreviation || e.journalInfo?.journal?.medlineAbbreviation || '',
    volume: e.journalInfo?.volume || '', issue: e.journalInfo?.issue || '', pages: e.pageInfo || '',
    doi: cleanDoi(e.doi), pmid: e.pmid || null, pmcid: e.pmcid || null,
    abstract: FT.xmlText(e.abstractText || ''), openAccess: e.isOpenAccess === 'Y', type: 'journal-article',
    country: (e.affiliation || '').match(/pakistan/i) ? 'PK' : null
  };
}

async function searchOpenAlex(query, scope) {
  const filter = ['has_abstract:true', 'is_retracted:false', 'type:article|review'];
  if (scope === 'pakistan') filter.push('authorships.institutions.country_code:PK');
  const r = await S.openalex(`works?search=${enc(query)}&filter=${filter.join(',')}&per-page=40&select=id,doi,title,publication_year,authorships,primary_location,biblio,abstract_inverted_index,is_retracted,type,ids,cited_by_count,open_access`);
  if (!r.ok) return [];
  return (r.data.results || []).map(w => ({ ...S.fromOpenAlex(w), openAccess: !!w.open_access?.is_oa }));
}

async function searchEuropePmc(query, scope) {
  const q = `(${query.split(' ').join(' AND ')})${scope === 'pakistan' ? ' AND AFF:"Pakistan"' : ''} AND HAS_ABSTRACT:y`;
  const r = await getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${enc(q)}&resultType=core&format=json&pageSize=25`, { ttl: 7 * 86400 });
  if (!r.ok) return [];
  return (r.data.resultList?.result || []).map(fromEuropePmc);
}

/**
 * input: { claim, context, style, scope: 'any'|'international'|'pakistan', max }
 */
async function findEvidence(input, update = () => {}) {
  const claim = String(input.claim || '').trim();
  if (claim.length < 15) throw new Error('Enter the sentence that needs a source (a full sentence works best).');
  const style = ST.styleKey(input.style || 'apa7');
  let query = queryOf(claim, input.context);
  if (!query) query = claim.slice(0, 200);

  update('Searching scholarly indexes', 10);
  let [oa, ep] = await Promise.all([searchOpenAlex(query, input.scope), searchEuropePmc(query, input.scope)]);
  // Broaden if the AND query was too narrow
  if (oa.length + ep.length < 5) {
    const shorter = query.split(' ').slice(0, 4).join(' ');
    [oa, ep] = await Promise.all([searchOpenAlex(shorter, input.scope), searchEuropePmc(shorter, input.scope)]);
  }
  const byKey = new Map();
  for (const rec of [...oa, ...ep]) {
    if (!rec.title || !rec.abstract) continue;
    const key = rec.doi || rec.title.toLowerCase().slice(0, 80);
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, ...Object.fromEntries(Object.entries(rec).filter(([, v]) => v && (!Array.isArray(v) || v.length))), source: prev.source } : rec);
  }
  let works = [...byKey.values()];
  if (!works.length) return { claim, query, results: [], note: 'No sources with abstracts were found. Try a shorter or more specific sentence.' };

  // Exclude retracted works (OpenAlex flag + Retraction Watch)
  const rw = await retractionsFor(works.map(w => w.doi));
  works = works.filter(w => !w.retracted && !rw.get((w.doi || '').toLowerCase()));

  update(`Reading ${works.length} abstracts`, 40);
  const ranked = works.map(w => {
    const best = M.bestPassages(claim, M.passagesOf(w.abstract), 1)[0];
    return { w, best, level: 'abstract', origin: 'Abstract' };
  }).filter(x => x.best).sort((a, b) => b.best.score - a.best.score).slice(0, 10);

  // Open-access full texts for the strongest candidates: a better passage may be in the body
  let n = 0;
  for (const x of ranked.slice(0, 6)) {
    n++;
    update(`Checking open full texts (${n}/6)`, 45 + n * 7);
    const ft = await FT.openFullText(x.w).catch(() => null);
    if (!ft) continue;
    const best = M.bestPassages(claim, M.passagesOf(ft.text), 1)[0];
    if (best && best.score > x.best.score) Object.assign(x, { best, level: 'full text', origin: ft.origin, url: ft.url });
  }

  const results = ranked.sort((a, b) => b.best.score - a.best.score).slice(0, input.max || 6).filter(x => x.best.score >= 0.2).map(x => {
    const record = { ...x.w, abstract: undefined };
    const entry = ST.entry(record, style);
    const v = M.verdictOf(x.best, { fullText: x.level === 'full text' });
    return {
      record: { title: record.title, authors: (record.authors || []).slice(0, 20), year: record.year, journal: record.journal, journalAbbrev: record.journalAbbrev, volume: record.volume, issue: record.issue, pages: record.pages, doi: record.doi, pmid: record.pmid, type: record.type },
      citation: { text: ST.toText(entry), html: ST.toHtml(entry), inText: ST.toText(ST.inText(style, { nums: [1], records: [record] })) },
      quote: x.best.text, level: x.level, origin: x.origin, url: x.url || (record.doi ? `https://doi.org/${record.doi}` : null),
      support: v.verdict, notes: v.notes, score: Math.round(x.best.score * 100),
      wording: M.adjustWording(claim, x.best.text)
    };
  });
  return {
    kind: 'evidence', claim, context: input.context || '', query, style, scope: input.scope || 'any', results,
    screened: works.length,
    note: results.length ? null : 'Sources were found, but none states this claim closely. Consider rewording the sentence or citing a review.'
  };
}

module.exports = { findEvidence, queryOf, fromEuropePmc, searchOpenAlex, searchEuropePmc };
