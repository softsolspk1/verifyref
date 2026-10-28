// sources.js - adapters for the 12 academic databases.
// Every adapter returns normalized records:
// { source, sourceId, doi, title, authors:[{given,family,orcid}], year, journal, issn:[], volume, issue,
//   pages, type, url, publisher, retracted, notices:[], pmid, openalexId, abstract, topics:[] }

const { getJson, getText } = require('./http');
const { cleanDoi, splitName, invertedIndexToText } = require('./text');
const cfg = require('./config');

const enc = encodeURIComponent;
const mailto = `mailto=${enc(cfg.CONTACT_EMAIL)}`;

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
const stripTags = s => decodeXml(String(s || '').replace(/<[^>]+>/g, ' '));

// Search queries should use the cleaned title; strip characters that break API query syntax
const q = s => String(s || '').replace(/["():\[\]{}^~*?\\/!]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

// ---------------------------------------------------------------- 1. Crossref

function fromCrossref(m) {
  const notices = [];
  let retracted = false;
  for (const u of m['update-to'] || []) {
    const t = `${u.type || ''} ${u.label || ''}`.toLowerCase();
    if (t.includes('retract') || t.includes('withdraw')) {
      retracted = true;
      notices.push({ type: 'Retraction', label: u.label || 'Retraction', doi: u.DOI, date: u.updated?.['date-time'] });
    } else if (t.includes('concern')) {
      notices.push({ type: 'Expression of concern', label: u.label || 'Expression of concern', doi: u.DOI });
    } else if (t.includes('correct') || t.includes('erratum')) {
      notices.push({ type: 'Correction', label: u.label || 'Correction', doi: u.DOI });
    }
  }
  if (m.relation?.['is-retracted-by']) {
    retracted = true;
    notices.push({ type: 'Retraction', label: 'Retracted article', doi: m.relation['is-retracted-by'][0]?.id });
  }
  const title = stripTags((m.title || [])[0] || '');
  if (/^(retracted|withdrawn)\b[\s:.-]/i.test(title)) {
    retracted = true;
    if (!notices.some(n => n.type === 'Retraction')) notices.push({ type: 'Retraction', label: 'Title marked RETRACTED' });
  }
  const dp = (m['published-print'] || m['published-online'] || m.issued || m.created)?.['date-parts']?.[0];
  return {
    source: 'Crossref',
    sourceId: m.DOI,
    doi: cleanDoi(m.DOI),
    title: title + (m.subtitle?.[0] ? `: ${stripTags(m.subtitle[0])}` : ''),
    shortTitle: title,
    authors: (m.author || []).map(a => ({ given: a.given || '', family: a.family || a.name || '', orcid: a.ORCID ? a.ORCID.replace(/^https?:\/\/orcid.org\//, '') : null })),
    year: dp?.[0] || null,
    journal: stripTags((m['container-title'] || [])[0] || ''),
    journalAbbrev: (m['short-container-title'] || [])[0] || '',
    issn: m.ISSN || [],
    volume: m.volume || '',
    issue: m.issue || '',
    pages: m.page || m['article-number'] || '',
    type: m.type,
    publisher: m.publisher,
    url: m.URL,
    retracted,
    notices
  };
}

async function crossrefDoi(doi) {
  const r = await getJson(`https://api.crossref.org/works/${enc(doi)}?${mailto}`);
  if (r.status === 404) return { notFound: true };
  if (!r.ok) return { error: r.error || r.status };
  return { record: fromCrossref(r.data.message) };
}

async function crossrefSearch(ref) {
  const query = q(ref.title ? `${ref.title} ${ref.authors?.[0]?.family || ''} ${ref.year || ''} ${ref.journal || ''}` : ref.raw);
  const r = await getJson(`https://api.crossref.org/works?query.bibliographic=${enc(query)}&rows=4&${mailto}`);
  if (!r.ok) return { error: r.error || r.status };
  return { records: (r.data.message.items || []).map(fromCrossref) };
}

// ---------------------------------------------------------------- 2. DOI Foundation handle registry

async function doiHandle(doi) {
  const r = await getJson(`https://doi.org/api/handles/${enc(doi)}`, { timeout: 10000 });
  if (r.ok && r.data?.responseCode === 1) return { exists: true, url: r.data.values?.find(v => v.type === 'URL')?.data?.value };
  if (r.status === 404 || r.data?.responseCode === 100) return { exists: false };
  return { error: r.error || r.status };
}

// ---------------------------------------------------------------- 3. DataCite

function fromDatacite(d) {
  const a = d.attributes || {};
  return {
    source: 'DataCite',
    sourceId: a.doi,
    doi: cleanDoi(a.doi),
    title: a.titles?.[0]?.title || '',
    authors: (a.creators || []).map(c => {
      const orcid = (c.nameIdentifiers || []).find(n => /orcid/i.test(n.nameIdentifierScheme || ''))?.nameIdentifier;
      return c.familyName ? { given: c.givenName || '', family: c.familyName, orcid: orcid ? orcid.replace(/^https?:\/\/orcid.org\//, '') : null } : { ...splitName(c.name), orcid: null };
    }),
    year: a.publicationYear ? parseInt(a.publicationYear, 10) : null,
    journal: a.container?.title || '',
    issn: a.container?.identifierType === 'ISSN' ? [a.container.identifier] : [],
    volume: a.container?.volume || '',
    issue: a.container?.issue || '',
    pages: a.container?.firstPage ? `${a.container.firstPage}${a.container.lastPage ? '-' + a.container.lastPage : ''}` : '',
    type: a.types?.resourceTypeGeneral || 'dataset',
    publisher: typeof a.publisher === 'string' ? a.publisher : a.publisher?.name,
    url: a.url,
    retracted: false,
    notices: []
  };
}

async function dataciteDoi(doi) {
  const r = await getJson(`https://api.datacite.org/dois/${enc(doi)}`);
  if (r.status === 404) return { notFound: true };
  if (!r.ok) return { error: r.error || r.status };
  return { record: fromDatacite(r.data.data) };
}

async function dataciteSearch(ref) {
  if (!ref.title) return { records: [] };
  const r = await getJson(`https://api.datacite.org/dois?query=${enc(`titles.title:(${q(ref.title)})`)}&page[size]=3`);
  if (!r.ok) return { error: r.error || r.status };
  return { records: (r.data.data || []).map(fromDatacite) };
}

// ---------------------------------------------------------------- 4. OpenAlex

function openalexAuth() {
  return cfg.OPENALEX_API_KEY ? `api_key=${enc(cfg.OPENALEX_API_KEY)}` : mailto;
}

function fromOpenAlex(w) {
  const src = w.primary_location?.source || {};
  const b = w.biblio || {};
  return {
    source: 'OpenAlex',
    sourceId: w.id,
    openalexId: w.id?.replace('https://openalex.org/', ''),
    doi: cleanDoi(w.doi),
    title: w.title || w.display_name || '',
    authors: (w.authorships || []).map(a => ({
      ...splitName(a.author?.display_name || a.raw_author_name || ''),
      orcid: a.author?.orcid ? a.author.orcid.replace(/^https?:\/\/orcid.org\//, '') : null,
      openalexId: a.author?.id?.replace('https://openalex.org/', ''),
      institutions: (a.institutions || []).map(i => ({ id: i.id?.replace('https://openalex.org/', ''), name: i.display_name, country: i.country_code }))
    })),
    year: w.publication_year || null,
    journal: src.display_name || '',
    journalId: src.id?.replace('https://openalex.org/', ''),
    issn: src.issn || (src.issn_l ? [src.issn_l] : []),
    volume: b.volume || '',
    issue: b.issue || '',
    pages: b.first_page ? `${b.first_page}${b.last_page && b.last_page !== b.first_page ? '-' + b.last_page : ''}` : '',
    type: w.type,
    url: w.doi || w.id,
    pmid: w.ids?.pmid ? w.ids.pmid.replace(/\D/g, '') : null,
    retracted: !!w.is_retracted,
    notices: w.is_retracted ? [{ type: 'Retraction', label: 'Flagged as retracted in OpenAlex' }] : [],
    abstract: invertedIndexToText(w.abstract_inverted_index),
    topics: (w.topics || []).map(t => t.display_name),
    keywords: (w.keywords || []).map(k => k.display_name),
    citedBy: w.cited_by_count,
    // legal open-access copies (publisher or repository PDFs) - used for full-text claim checks and figure comparison
    isOa: !!w.open_access?.is_oa,
    pdfUrls: [...new Set([w.best_oa_location?.pdf_url, ...(w.locations || []).map(l => l.pdf_url)].filter(Boolean))].slice(0, 5),
    pmcid: /(\d{4,9})\/?$/.test(w.ids?.pmcid || '') ? `PMC${String(w.ids.pmcid).match(/(\d{4,9})\/?$/)[1]}` : null
  };
}

async function openalexDoi(doi) {
  const r = await getJson(`https://api.openalex.org/works/doi:${enc(doi)}?${openalexAuth()}`);
  if (r.status === 404) return { notFound: true };
  if (!r.ok) return { error: r.error || r.status };
  return { record: fromOpenAlex(r.data) };
}

async function openalexSearch(ref) {
  const term = q(ref.title || ref.raw);
  if (!term) return { records: [] };
  const r = await getJson(`https://api.openalex.org/works?search=${enc(term)}&per-page=4&${openalexAuth()}`);
  if (!r.ok) return { error: r.error || r.status };
  return { records: (r.data.results || []).map(fromOpenAlex) };
}

async function openalex(pathAndQuery, opts) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  return getJson(`https://api.openalex.org/${pathAndQuery}${sep}${openalexAuth()}`, opts);
}

// ---------------------------------------------------------------- 5. PubMed (NCBI E-utilities)

const ncbiKey = () => (cfg.NCBI_API_KEY ? `&api_key=${enc(cfg.NCBI_API_KEY)}` : '');

function fromPubmed(s) {
  const doi = (s.articleids || []).find(a => a.idtype === 'doi')?.value;
  const retracted = (s.pubtype || []).some(p => /retracted publication/i.test(p));
  return {
    source: 'PubMed',
    sourceId: s.uid,
    pmid: s.uid,
    doi: cleanDoi(doi),
    title: (s.title || '').replace(/\.$/, ''),
    authors: (s.authors || []).filter(a => a.authtype === 'Author').map(a => splitName(a.name)),
    year: parseInt((s.pubdate || s.epubdate || '').slice(0, 4), 10) || null,
    journal: s.fulljournalname || s.source || '',
    journalAbbrev: s.source || '',
    issn: [s.issn, s.essn].filter(Boolean),
    volume: s.volume || '',
    issue: s.issue || '',
    pages: s.pages || '',
    type: 'journal-article',
    url: `https://pubmed.ncbi.nlm.nih.gov/${s.uid}/`,
    retracted,
    notices: retracted ? [{ type: 'Retraction', label: 'PubMed: Retracted Publication' }] : []
  };
}

async function pubmedIds(ids) {
  if (!ids.length) return [];
  const r = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}${ncbiKey()}`);
  if (!r.ok) return null;
  return ids.map(id => r.data.result?.[id]).filter(s => s && !s.error).map(fromPubmed);
}

async function pubmedPmid(pmid) {
  const recs = await pubmedIds([pmid]);
  if (recs === null) return { error: 'PubMed unavailable' };
  return recs.length ? { record: recs[0] } : { notFound: true };
}

async function pubmedSearch(ref) {
  if (!ref.title) return { records: [] };
  const term = `${q(ref.title)}[ti]${ref.authors?.[0]?.family ? ` AND ${q(ref.authors[0].family)}[au]` : ''}`;
  let r = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=3&term=${enc(term)}${ncbiKey()}`);
  if (!r.ok) return { error: r.error || r.status };
  let ids = r.data.esearchresult?.idlist || [];
  if (!ids.length) {
    r = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=3&term=${enc(q(ref.title))}${ncbiKey()}`);
    ids = r.ok ? r.data.esearchresult?.idlist || [] : [];
  }
  const recs = await pubmedIds(ids);
  return { records: recs || [] };
}

// ---------------------------------------------------------------- 6. Europe PMC

function fromEuropePmc(e) {
  const authors = e.authorList?.author
    ? e.authorList.author.map(a => (a.lastName ? { given: a.firstName || a.initials || '', family: a.lastName } : splitName(a.fullName || a.collectiveName || '')))
    : (e.authorString || '').replace(/\.$/, '').split(/,\s*/).filter(Boolean).map(splitName);
  const retracted = (e.pubTypeList?.pubType || []).some(p => /retracted publication/i.test(p));
  return {
    source: 'Europe PMC',
    sourceId: `${e.source}:${e.id}`,
    pmid: e.pmid || null,
    doi: cleanDoi(e.doi),
    title: (e.title || '').replace(/\.$/, ''),
    authors,
    year: parseInt(e.pubYear, 10) || null,
    journal: e.journalInfo?.journal?.title || e.journalTitle || e.bookOrReportDetails?.publisher || '',
    issn: [e.journalInfo?.journal?.issn, e.journalInfo?.journal?.essn].filter(Boolean),
    volume: e.journalInfo?.volume || e.journalVolume || '',
    issue: e.journalInfo?.issue || e.issue || '',
    pages: e.pageInfo || '',
    type: e.pubType || 'journal-article',
    url: e.doi ? `https://doi.org/${e.doi}` : `https://europepmc.org/article/${e.source}/${e.id}`,
    retracted,
    notices: retracted ? [{ type: 'Retraction', label: 'Europe PMC: Retracted Publication' }] : []
  };
}

async function europepmcSearch(ref) {
  let query;
  if (ref.doi) query = `DOI:"${ref.doi}"`;
  else if (ref.title) query = `TITLE:"${q(ref.title).slice(0, 200)}"`;
  else return { records: [] };
  const r = await getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${enc(query)}&resultType=core&pageSize=3&format=json`);
  if (!r.ok) return { error: r.error || r.status };
  return { records: (r.data.resultList?.result || []).map(fromEuropePmc) };
}

// ---------------------------------------------------------------- 7. Semantic Scholar

const S2_FIELDS = 'title,authors,year,venue,externalIds,journal,publicationTypes,url';
const s2Headers = () => (cfg.S2_API_KEY ? { 'x-api-key': cfg.S2_API_KEY } : {});

function fromS2(p) {
  return {
    source: 'Semantic Scholar',
    sourceId: p.paperId,
    doi: cleanDoi(p.externalIds?.DOI),
    pmid: p.externalIds?.PubMed || null,
    title: p.title || '',
    authors: (p.authors || []).map(a => splitName(a.name)),
    year: p.year || null,
    journal: p.journal?.name || p.venue || '',
    issn: [],
    volume: p.journal?.volume || '',
    issue: '',
    pages: (p.journal?.pages || '').trim(),
    type: (p.publicationTypes || [])[0] || '',
    url: p.url,
    retracted: false,
    notices: []
  };
}

async function s2Doi(doi) {
  const r = await getJson(`https://api.semanticscholar.org/graph/v1/paper/DOI:${enc(doi)}?fields=${S2_FIELDS}`, { headers: s2Headers(), retries: 1 });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) return { error: r.error || r.status };
  return { record: fromS2(r.data) };
}

async function s2Search(ref) {
  if (!ref.title) return { records: [] };
  const r = await getJson(`https://api.semanticscholar.org/graph/v1/paper/search/match?query=${enc(q(ref.title))}&fields=${S2_FIELDS}`, { headers: s2Headers(), retries: 1 });
  if (r.status === 404) return { records: [] };
  if (!r.ok) return { error: r.error || r.status };
  return { records: (r.data.data || []).map(fromS2) };
}

// ---------------------------------------------------------------- 8. arXiv

function parseArxivFeed(xml) {
  const entries = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const get = tag => decodeXml((e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1] || '');
    const id = get('id');
    const title = get('title');
    if (!title || /^error$/i.test(title)) continue;
    const arxivId = id.replace(/^https?:\/\/arxiv.org\/abs\//, '').replace(/v\d+$/, '');
    const doi = (e.match(/<arxiv:doi[^>]*>([^<]+)</) || [])[1];
    entries.push({
      source: 'arXiv',
      sourceId: arxivId,
      arxivId,
      doi: cleanDoi(doi) || `10.48550/arxiv.${arxivId.toLowerCase()}`,
      title,
      authors: [...e.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map(a => splitName(decodeXml(a[1]))),
      year: parseInt(get('published').slice(0, 4), 10) || null,
      journal: decodeXml((e.match(/<arxiv:journal_ref[^>]*>([^<]+)</) || [])[1] || '') || 'arXiv',
      issn: [],
      volume: '', issue: '', pages: '',
      type: 'preprint',
      url: `https://arxiv.org/abs/${arxivId}`,
      retracted: /withdrawn/i.test(get('summary').slice(0, 200)),
      notices: []
    });
  }
  return entries;
}

async function arxivId(id) {
  const r = await getText(`https://export.arxiv.org/api/query?id_list=${enc(id)}`, { timeout: 20000 });
  if (!r.ok) return { error: r.error || r.status };
  const recs = parseArxivFeed(r.text || '');
  return recs.length ? { record: recs[0] } : { notFound: true };
}

async function arxivSearch(ref) {
  if (!ref.title) return { records: [] };
  const r = await getText(`https://export.arxiv.org/api/query?search_query=${enc(`ti:"${q(ref.title).slice(0, 200)}"`)}&max_results=3`, { timeout: 20000 });
  if (!r.ok) return { error: r.error || r.status };
  return { records: parseArxivFeed(r.text || '') };
}

// ---------------------------------------------------------------- 9. DBLP

async function dblpSearch(ref) {
  if (!ref.title) return { records: [] };
  const r = await getJson(`https://dblp.org/search/publ/api?q=${enc(q(ref.title))}&format=json&h=3`);
  if (!r.ok) return { error: r.error || r.status };
  const hits = r.data.result?.hits?.hit || [];
  return {
    records: hits.map(h => {
      const i = h.info || {};
      const au = i.authors?.author ? (Array.isArray(i.authors.author) ? i.authors.author : [i.authors.author]) : [];
      return {
        source: 'DBLP',
        sourceId: i.key,
        doi: cleanDoi(i.doi),
        title: decodeXml(i.title || '').replace(/\.$/, ''),
        authors: au.map(a => splitName(String(a.text || a).replace(/\s\d{4}$/, ''))),
        year: parseInt(i.year, 10) || null,
        journal: i.venue || '',
        issn: [], volume: i.volume || '', issue: i.number || '', pages: i.pages || '',
        type: i.type, url: i.ee || i.url, retracted: false, notices: []
      };
    })
  };
}

// ---------------------------------------------------------------- 10. Open Library (books)

async function openLibrarySearch(ref) {
  if (!ref.title && !ref.isbn) return { records: [] };
  const url = ref.isbn
    ? `https://openlibrary.org/search.json?isbn=${enc(ref.isbn)}&limit=3`
    : `https://openlibrary.org/search.json?title=${enc(q(ref.title))}${ref.authors?.[0]?.family ? `&author=${enc(ref.authors[0].family)}` : ''}&limit=3`;
  const r = await getJson(url);
  if (!r.ok) return { error: r.error || r.status };
  return {
    records: (r.data.docs || []).map(d => ({
      source: 'Open Library',
      sourceId: d.key,
      doi: null,
      title: d.title + (d.subtitle ? `: ${d.subtitle}` : ''),
      authors: (d.author_name || []).map(splitName),
      year: d.first_publish_year || null,
      years: d.publish_year || [],
      journal: '',
      publisher: (d.publisher || [])[0] || '',
      issn: [], volume: '', issue: '', pages: '',
      isbn: (d.isbn || []).slice(0, 5),
      type: 'book',
      url: `https://openlibrary.org${d.key}`,
      retracted: false, notices: []
    }))
  };
}

// ---------------------------------------------------------------- 11. Google Books

async function googleBooksSearch(ref) {
  if (!ref.title && !ref.isbn) return { records: [] };
  const term = ref.isbn ? `isbn:${ref.isbn}` : `intitle:${q(ref.title)}${ref.authors?.[0]?.family ? `+inauthor:${q(ref.authors[0].family)}` : ''}`;
  const key = cfg.GOOGLE_BOOKS_API_KEY ? `&key=${enc(cfg.GOOGLE_BOOKS_API_KEY)}` : '';
  const r = await getJson(`https://www.googleapis.com/books/v1/volumes?q=${enc(term)}&maxResults=3${key}`, { retries: 1 });
  if (!r.ok) return { error: r.error || r.status };
  return {
    records: (r.data.items || []).map(it => {
      const v = it.volumeInfo || {};
      return {
        source: 'Google Books',
        sourceId: it.id,
        doi: null,
        title: v.title + (v.subtitle ? `: ${v.subtitle}` : ''),
        authors: (v.authors || []).map(splitName),
        year: parseInt((v.publishedDate || '').slice(0, 4), 10) || null,
        journal: '',
        publisher: v.publisher || '',
        issn: [], volume: '', issue: '', pages: '',
        isbn: (v.industryIdentifiers || []).map(i => i.identifier),
        type: 'book',
        url: v.infoLink,
        retracted: false, notices: []
      };
    })
  };
}

// ---------------------------------------------------------------- 12. ERIC (education research)

async function ericSearch(ref) {
  if (!ref.title) return { records: [] };
  const r = await getJson(`https://api.ies.ed.gov/eric/?search=${enc(`title:"${q(ref.title).slice(0, 200)}"`)}&format=json&rows=3&fields=id,title,author,publicationdateyear,source,publisher,url,issn`);
  if (!r.ok) return { error: r.error || r.status };
  return {
    records: (r.data.response?.docs || []).map(d => ({
      source: 'ERIC',
      sourceId: d.id,
      doi: null,
      title: d.title || '',
      authors: (d.author || []).map(splitName),
      year: d.publicationdateyear || null,
      journal: d.source || '',
      publisher: d.publisher || '',
      issn: (d.issn || []).map(s => s.replace(/^ISSN-/, '')),
      volume: '', issue: '', pages: '',
      type: 'article',
      url: d.url || `https://eric.ed.gov/?id=${d.id}`,
      retracted: false, notices: []
    }))
  };
}

// ---------------------------------------------------------------- 13. CORE (core.ac.uk) - open-access research outputs
// 300+ million records from repositories and journals, with links to the open-access full text (PDF). Free; an API key
// (core.ac.uk/services/api) raises the rate limit and unlocks the full-text field.

const coreHeaders = () => (cfg.CORE_API_KEY ? { Authorization: `Bearer ${cfg.CORE_API_KEY}` } : {});
const coreOpts = () => ({ headers: coreHeaders(), timeout: 20000, retries: cfg.CORE_API_KEY ? 2 : 0, ttl: 30 * 86400 });

function fromCore(w) {
  const j = (w.journals || [])[0] || {};
  const issn = [...(j.identifiers || []), ...(w.identifiers || []).map(i => (i.type === 'issn' ? i.identifier : ''))]
    .map(s => String(s).replace(/^issn:/i, '')).filter(s => /^\d{4}-?\d{3}[\dXx]$/.test(s));
  return {
    source: 'CORE',
    sourceId: String(w.id),
    coreId: w.id,
    doi: cleanDoi(w.doi),
    title: stripTags(w.title || ''),
    authors: (w.authors || []).map(a => splitName(a.name || '')).filter(a => a.family),
    year: w.yearPublished || (w.publishedDate ? parseInt(w.publishedDate, 10) : null),
    journal: j.title || '',
    publisher: w.publisher || '',
    issn: [...new Set(issn)],
    volume: '', issue: '', pages: '',
    type: w.documentType === 'thesis' ? 'thesis' : 'article',
    url: (w.links || []).find(l => l.type === 'display')?.url || (w.doi ? `https://doi.org/${w.doi}` : `https://core.ac.uk/works/${w.id}`),
    pdfUrl: w.downloadUrl || (w.sourceFulltextUrls || [])[0] || null,
    fullText: typeof w.fullText === 'string' && w.fullText.length > 500 && !/^Not available/i.test(w.fullText) ? w.fullText : null,
    pmid: w.pubmedId || null,
    abstract: stripTags(w.abstract || ''),
    retracted: false, notices: []
  };
}

let coreBlockedUntil = 0;   // after a 429 (10 requests / minute without a key), CORE is skipped until the window resets
async function coreQuery(query, limit = 4) {
  if (Date.now() < coreBlockedUntil) return { error: 'rate-limited' };
  const r = await getJson(`https://api.core.ac.uk/v3/search/works/?q=${enc(query)}&limit=${limit}`, coreOpts());
  if (r.status === 429) {
    const at = Date.parse(r.headers?.['x-ratelimit-retry-after'] || '');
    coreBlockedUntil = Number.isFinite(at) && at > Date.now() ? Math.min(at, Date.now() + 600000) : Date.now() + 60000;
  }
  if (!r.ok) return { error: r.error || r.status };
  return { records: (r.data?.results || []).map(fromCore) };
}

async function coreDoi(doi) {
  const r = await coreQuery(`doi:"${String(doi).replace(/"/g, '')}"`, 2);
  if (r.error) return r;
  const rec = r.records.find(x => x.doi === cleanDoi(doi));
  return rec ? { record: rec } : { notFound: true };
}

async function coreSearch(ref) {
  // an exact title phrase misses spelling variants ("antiinflammatory" / "Anti-Inflammatory"): require the title's six
  // most distinctive words instead
  const words = [...new Set(q(ref.title || ref.raw).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 5))].sort((a, b) => b.length - a.length).slice(0, 6);
  if (words.length < 2) return { records: [] };
  return coreQuery(words.map(w => `title:"${w}"`).join(' AND '), 4);
}

const DATABASES = [
  'Crossref', 'DOI Foundation (Handle)', 'DataCite', 'OpenAlex', 'PubMed', 'Europe PMC',
  'Semantic Scholar', 'arXiv', 'DBLP', 'Open Library', 'Google Books', 'ERIC', 'CORE'
];

module.exports = {
  DATABASES,
  crossrefDoi, crossrefSearch, doiHandle, dataciteDoi, dataciteSearch,
  openalexDoi, openalexSearch, openalex, fromOpenAlex,
  pubmedPmid, pubmedSearch, europepmcSearch, s2Doi, s2Search,
  arxivId, arxivSearch, dblpSearch, openLibrarySearch, googleBooksSearch, ericSearch, coreDoi, coreSearch, coreQuery, fromCore
};
