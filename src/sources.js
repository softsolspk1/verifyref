// sources.js - adapters for the 12 academic databases.
// Every adapter returns normalized records:
// { source, sourceId, doi, title, authors:[{given,family,orcid}], year, journal, issn:[], volume, issue,
//   pages, type, url, publisher, retracted, notices:[], pmid, openalexId, abstract, topics:[] }

const { getJson, getText } = require('./http');
const { cleanDoi, splitName, invertedIndexToText, titleSimilarity } = require('./text');
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
const q = s => String(s || '').replace(/["():[\]{}^~*?\\/!]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

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

/** Crossref records of the title in the cited journal only (a work published in several journals, e.g. a reporting guideline) */
async function crossrefInJournal(ref) {
  if (!ref.title || !ref.journal) return { records: [] };
  const r = await getJson(`https://api.crossref.org/works?query.bibliographic=${enc(q(ref.title))}&query.container-title=${enc(ref.journal)}&rows=10&${mailto}`);
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

/**
 * NCBI citation matcher (ECitMatch): finds the PubMed record from journal, year, volume, first page and first author,
 * so a reference whose title is misspelled or garbled is still found. The hit is only a candidate: its record is scored
 * against the reference like every other match (the same journal page can hold a different paper).
 */
async function pubmedCitationMatch(ref) {
  const page = String(ref.pages || '').match(/^\s*([A-Za-z]?\d+)/)?.[1];
  if (!ref.journal || !ref.year || !ref.volume || !page) return { records: [] };
  const clean = s => String(s || '').replace(/[|\r\n]/g, ' ').trim();
  const a = ref.authors?.[0];
  const author = a?.family ? `${a.family} ${String(a.given || '').replace(/[^A-Za-z]/g, '').slice(0, 2)}`.trim() : '';
  const bdata = [clean(ref.journal), ref.year, clean(ref.volume), page, clean(author), 'ref', ''].join('|');
  const r = await getText(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/ecitmatch.cgi?db=pubmed&retmode=xml&bdata=${enc(bdata)}${ncbiKey()}`, { ttl: 30 * 86400, timeout: 20000, retries: 1 });
  if (!r.ok) return { error: r.error || `HTTP ${r.status}` };
  const pmid = (String(r.text || '').trim().split('|').pop() || '').match(/^\d{4,9}$/)?.[0];
  if (!pmid) return { records: [] };
  const recs = await pubmedIds([pmid]);
  return recs === null ? { error: 'PubMed unavailable' } : { records: recs };
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

// CORE's repository records sometimes carry another paper's DOI (a thesis that cites it, say), so when the expected
// title is known, a record only counts if its title matches too
async function coreDoi(doi, title) {
  const r = await coreQuery(`doi:"${String(doi).replace(/"/g, '')}"`, title ? 5 : 2);
  if (r.error) return r;
  const rec = r.records.find(x => x.doi === cleanDoi(doi) && (!title || titleSimilarity(title, x.title) >= 0.7));
  return rec ? { record: rec } : { notFound: true };
}

async function coreSearch(ref) {
  // an exact title phrase misses spelling variants ("antiinflammatory" / "Anti-Inflammatory"): require the title's six
  // most distinctive words instead
  const words = [...new Set(q(ref.title || ref.raw).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 5))].sort((a, b) => b.length - a.length).slice(0, 6);
  if (words.length < 2) return { records: [] };
  return coreQuery(words.map(w => `title:"${w}"`).join(' AND '), 4);
}

// ---------------------------------------------------------------- 14. Google Scholar (SerpApi, optional, paid)
// Google offers no Scholar API; SerpApi runs the search for us and returns the result list as JSON. Each search costs a
// credit, so it is asked last (only for references the free databases could not verify) and cached for 30 days.

// The desktop holds no SerpApi key: it asks the web platform, which runs the search with its key (see /api/sync/serpapi)
const scholarEnabled = () => !!cfg.SERPAPI_KEY || (cfg.DESKTOP && require('./desktop').serpViaPlatform());
let scholarBlockedUntil = 0;   // after "out of searches" / invalid key, Google Scholar and Google are skipped for an hour

/** One SerpApi search (engine google_scholar or google), cached 30 days; on the desktop through the web platform */
// a private search (words of an unpublished manuscript) is cached under a hash with the results' links and titles only
const keepOrganic = d => ({ organic_results: (d?.organic_results || []).slice(0, 10).map(o => ({ link: o.link || null, title: o.title || null })) });
async function serpSearch(engine, query, num = 5, { private: priv = false } = {}) {
  if (cfg.SERPAPI_KEY) return getJson(`https://serpapi.com/search.json?engine=${engine}&q=${enc(query)}&num=${num}&hl=en&api_key=${enc(cfg.SERPAPI_KEY)}`, { ttl: 30 * 86400, timeout: 30000, retries: 1, ...(priv ? { private: keepOrganic } : {}) });
  if (cfg.DESKTOP) return require('./desktop').remoteSerp(engine, query, num, { private: priv });
  return { ok: false, status: 0, data: { error: 'SerpApi is not configured' } };
}
const serpBlocked = r => r.status === 401 || r.status === 429 || /run out of searches|invalid api key/i.test(r.data?.error || '');

/**
 * "R Rahbari, L Francis, OJ Guy… - Pharmaceutics, 2023 - mdpi.com" -> authors, venue, year, host.
 * Google shortens long author lists and venues with "…".
 */
function parseScholarSummary(summary) {
  const parts = String(summary || '').replace(/\u2026|…/g, '...').split(/\s+-\s+/);
  const authorPart = parts.length >= 2 ? parts[0] : '';
  const venuePart = parts.length >= 3 ? parts.slice(1, -1).join(' - ') : parts.length === 2 ? parts[1] : '';
  const host = parts.length >= 3 ? parts[parts.length - 1].trim() : '';
  const year = parseInt((venuePart.match(/\b(1[89]\d{2}|20\d{2})\b/) || [])[1], 10) || null;
  const venue = venuePart.replace(/,?\s*\b(1[89]\d{2}|20\d{2})\b\s*$/, '').replace(/\.\.\.$/, '').trim();
  const authors = authorPart.split(/\s*,\s*/).map(a => a.replace(/\.\.\.$/, '').trim()).filter(a => a && !/^\.+$/.test(a))
    .map(a => { const w = a.split(/\s+/); return w.length >= 2 && /^[A-Z]{1,3}$/.test(w[0]) ? { given: w[0].split('').join('. ') + '.', family: w.slice(1).join(' ') } : splitName(a); });
  return { authors, venue: /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(venue) ? '' : venue, year, host, truncatedAuthors: /\.\.\./.test(authorPart) };
}

function fromScholar(o) {
  const info = parseScholarSummary(o.publication_info?.summary);
  const named = (o.publication_info?.authors || []).map(a => a.name).filter(Boolean);
  const kind = (String(o.title || '').match(/^\s*\[(BOOK|CITATION|PDF|HTML|B)\]\s*/i) || [])[1];
  const link = o.link || '';
  const doi = cleanDoi((link.match(/(?:doi\.org\/|\/doi\/(?:abs\/|full\/|pdf\/)?)(10\.\d{4,9}\/[^?#\s]+)/i) || [])[1] || '') || null;
  return {
    source: 'Google Scholar',
    sourceId: o.result_id || null,
    doi,
    title: String(o.title || '').replace(/^(?:\s*\[[A-Z]+\]\s*)+/i, '').trim(),
    authors: info.authors.length ? info.authors : named.map(splitName),
    authorsTruncated: info.truncatedAuthors,
    year: info.year,
    journal: kind && /book|b/i.test(kind) ? '' : info.venue,
    publisher: info.host,
    issn: [], volume: '', issue: '', pages: '',
    type: o.type === 'Book' || (kind && /^b/i.test(kind)) ? 'book' : kind && /citation/i.test(kind) ? 'citation' : 'article',
    url: link || (o.result_id ? `https://scholar.google.com/scholar?cluster=${enc(o.result_id)}` : ''),
    citedBy: o.inline_links?.cited_by?.total ?? null,
    // the full-text copy Google Scholar links beside the result ("[PDF] repository.edu"): opened when the record alone
    // cannot verify the reference
    pdfUrl: (o.resources || []).find(x => /pdf/i.test(x.file_format || '') && x.link)?.link || (/\.pdf(?:$|[?#])/i.test(link) ? link : null),
    snippet: o.snippet || '',
    retracted: false, notices: []
  };
}

// ---- Google Scholar read directly (no SerpApi key): the results page is fetched and its result list parsed. Google
// answers automated requests with a CAPTCHA after a while; Scholar is then left alone for an hour (the check goes on
// with the web search), and every answer is cached 30 days so a re-check does not ask again.
const scholarDirectEnabled = () => !cfg.DESKTOP && process.env.SCHOLAR_DIRECT !== 'off';
let scholarDirectBlockedUntil = 0;
const htmlText = h => String(h || '').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&hellip;/g, '…').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();

/** A Google Scholar results page -> the SerpApi shape of its results ({ title, link, result_id, publication_info, snippet, resources }) */
function parseScholarHtml(html) {
  const out = [];
  for (const chunk of String(html || '').split(/<div class="gs_r gs_or gs_scl/).slice(1)) {
    const ri = chunk.slice(chunk.indexOf('class="gs_ri"'));
    const h3 = (ri.match(/<h3[^>]*class="gs_rt"[^>]*>([\s\S]*?)<\/h3>/) || [])[1];
    if (!h3) continue;
    const kind = (h3.match(/class="gs_ct[12]"[^>]*>\s*\[([A-Z]+)\]/) || [])[1];
    const a = h3.match(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const title = htmlText(a ? a[2] : h3.replace(/<span class="gs_ct[\s\S]*?<\/span>\s*<\/span>/, ''));
    const pdf = (chunk.match(/class="gs_or_ggsm"[^>]*>\s*<a\s[^>]*href="([^"]+)"/) || [])[1];
    const pdfKind = (chunk.match(/class="gs_ctg2"[^>]*>\[([A-Z]+)\]/) || [])[1];
    out.push({
      title: `${kind ? `[${kind}] ` : ''}${title}`,
      link: a ? htmlText(a[1]) : '',
      result_id: (chunk.match(/^[^>]*data-cid="([^"]+)"/) || [])[1] || null,
      publication_info: { summary: htmlText((ri.match(/<div class="gs_a"[^>]*>([\s\S]*?)<\/div>/) || [])[1]) },
      snippet: htmlText((ri.match(/<div class="gs_rs"[^>]*>([\s\S]*?)<\/div>/) || [])[1]),
      resources: pdf ? [{ file_format: pdfKind || 'PDF', link: htmlText(pdf) }] : []
    });
  }
  return out;
}

/** One Google Scholar search read from scholar.google.com: { ok, results } | { ok: false, blocked?, error } */
async function scholarDirect(query) {
  const key = `gsd:${query}`;
  const http = require('./http');
  const cached = await http.cacheGet(key);
  if (cached) return cached;
  const r = await http.getText(`https://scholar.google.com/scholar?hl=en&as_sdt=0%2C5&q=${enc(query)}`, {
    ttl: 0, retries: 0, timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' }
  });
  const text = r.text || (typeof r.data === 'string' ? r.data : '');
  if (r.status === 429 || r.status === 403 || /gs_captcha|recaptcha|unusual traffic|\/sorry\/|<title>\s*Verifying/i.test(`${r.url || ''} ${text.slice(0, 20000)}`)) return { ok: false, blocked: true, error: 'Google Scholar asked for a CAPTCHA' };
  if (!r.ok) return { ok: false, error: r.error || `HTTP ${r.status}` };
  if (!/gs_res_ccl|gs_r gs_or|did not match any articles/i.test(text)) return { ok: false, error: 'Google Scholar page not recognised' };
  const res = { ok: true, results: parseScholarHtml(text) };
  http.cacheSet(key, res, Date.now() + 30 * 86400000);
  return res;
}

async function googleScholarDirect(ref) {
  // Google answers with a bot check (CAPTCHA, "Verifying..."): Scholar is left out for an hour, not counted as an error
  if (Date.now() < scholarDirectBlockedUntil) return { skipped: true };
  const title = q(ref.title || '').slice(0, 250);
  if (title.length < 12) return { records: [] };
  const fam = ref.authors?.[0]?.family ? ` author:"${q(ref.authors[0].family)}"` : '';
  let r = await scholarDirect(`"${title}"${fam}`);
  if (r.ok && !r.results.length && fam) r = await scholarDirect(title);
  if (r.blocked) { scholarDirectBlockedUntil = Date.now() + 3600000; return { skipped: true }; }
  if (!r.ok) return { error: r.error };
  return { records: r.results.slice(0, 5).map(fromScholar).filter(x => x.type !== 'citation') };
}

/** Google Scholar can be asked: through SerpApi, else directly */
const scholarAvailable = () => scholarEnabled() || scholarDirectEnabled();

async function googleScholarSearch(ref) {
  if (!scholarEnabled()) return scholarDirectEnabled() ? googleScholarDirect(ref) : { skipped: true };
  if (Date.now() < scholarBlockedUntil) return { error: 'Google Scholar paused (SerpApi searches used up or key rejected)' };
  const title = q(ref.title || '').slice(0, 250);
  if (title.length < 12) return { records: [] };
  const fam = ref.authors?.[0]?.family ? ` author:"${q(ref.authors[0].family)}"` : '';
  let r = await serpSearch('google_scholar', `"${title}"${fam}`);
  if (r.skipped) return { skipped: true };
  // an exact phrase plus the author can be too strict (title variants, author spelled differently): one looser search
  if (r.ok && !(r.data?.organic_results || []).length && fam) r = await serpSearch('google_scholar', title);
  if (serpBlocked(r)) {
    scholarBlockedUntil = Date.now() + 3600000;
    return { error: r.data?.error || `SerpApi HTTP ${r.status}` };
  }
  if (!r.ok) return { error: r.data?.error || r.error || r.status };
  if (r.data?.error && !/hasn't returned any results/i.test(r.data.error)) return { error: r.data.error };
  // "[CITATION]" entries are assembled from other papers' reference lists, not from the work itself: they cannot show
  // that a reference exists (a fabricated reference copied by several papers would have one), so they are left out
  return { records: (r.data?.organic_results || []).slice(0, 5).map(fromScholar).filter(x => x.type !== 'citation') };
}

/**
 * Google web search (SerpApi, engine "google") for a reference that no scholarly database or Google Scholar found:
 * pages whose title matches the cited title. This shows that the work exists somewhere on the web (journal site,
 * repository, report, thesis, web page); it does not confirm the bibliographic details. Returns { hits: [{ title, url, host, sim, snippet }] }.
 */
/** A web search can be made: SerpApi (Google), or the similarity report's web search (Brave Search, Google Programmable Search) */
const webSearchEnabled = () => scholarEnabled() || require('./webSearch').enabled();

async function googleWebSearch(ref) {
  const title = q(ref.title || '').slice(0, 250);
  if (!scholarEnabled()) {
    // no SerpApi key: the same exact-title search through the web search the similarity report uses
    if (!webSearchEnabled()) return { skipped: true };
    if (title.length < 15) return { hits: [] };
    const w = await require('./webSearch').phraseSearch(title, 8).catch(e => ({ ok: false, error: e.message }));
    if (!w.ok) return w.error === 'skipped' ? { skipped: true } : { error: w.error };
    const found = (w.results || []).map(o => ({ title: o.title, link: o.url, snippet: o.snippet }));
    const hits = webHits(ref, found);
    if (hits.length) return { hits };
    const read = await pageConfirm(ref, found.map(o => o.link).filter(Boolean).slice(0, 4));
    if (read.length) return { hits: read };
    // the full text as a PDF (a journal's or repository's copy, the "[PDF]" link Google Scholar shows): searched for
    // and read for the cited title and first author
    const p = await require('./webSearch').phraseSearch(title, 5, 'filetype:pdf').catch(() => ({ ok: false }));
    const pdfs = (p.ok ? p.results || [] : []).map(o => o.url).filter(u => u && !found.some(f => f.link === u));
    return { hits: pdfs.length ? await pageConfirm(ref, pdfs.slice(0, 3)) : [] };
  }
  if (Date.now() < scholarBlockedUntil) return { error: 'Google paused (SerpApi searches used up or key rejected)' };
  if (title.length < 15) return { hits: [] };
  const r = await serpSearch('google', `"${title}"`, 8);
  if (r.skipped) return { skipped: true };
  if (serpBlocked(r)) { scholarBlockedUntil = Date.now() + 3600000; return { error: r.data?.error || `SerpApi HTTP ${r.status}` }; }
  if (!r.ok) return { error: r.data?.error || r.error || r.status };
  if (r.data?.error && !/hasn't returned any results/i.test(r.data.error)) return { error: r.data.error };
  const hits = webHits(ref, r.data?.organic_results || []);
  return { hits: hits.length ? hits : await pageConfirm(ref, (r.data?.organic_results || []).map(o => o.link).filter(Boolean).slice(0, 4)) };
}

// ---------------------------------------------------------------- pages and PDFs read for a reference
// A search result whose title is not the article's ("(PDF) …", a file name, a repository page) or the web address a
// reference gives is opened, and its text (a PDF's first pages) is read for the cited title and first author.
const PAGE_MAX = 15e6;
const textNorm = t => ` ${String(t || '').toLowerCase().replace(/(\p{L})-\s+(\p{L})/gu, '$1$2').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
const stripPage = h => String(h || '').replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');

/** The text of a page or PDF at this address (PDF: first three pages), or null */
async function readPage(url) {
  if (!/^https?:\/\//i.test(url)) return null;
  const r = await require('./http').getBuffer(url, { timeout: 20000 });
  if (!r.ok || !r.buffer || r.buffer.length > PAGE_MAX) return null;
  if (r.buffer.slice(0, 1024).toString('latin1').includes('%PDF-')) {
    const pages = await require('./tools/fulltext').filePages(r.buffer, 'page.pdf').catch(() => null);
    return pages?.length ? { kind: 'PDF', text: pages.slice(0, 3).map(p => p.text).join(' ') } : null;
  }
  const html = r.buffer.toString('utf8');
  const head = [(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '', ...[...html.matchAll(/<meta[^>]+content="([^"]{0,600})"/gi)].map(m => m[1])].join(' ');
  return { kind: 'page', text: `${head} ${stripPage(html)}`.slice(0, 300000) };
}

/**
 * Whether a text names the reference: { title, author } when its whole title is there (and its first author), or
 * { words } for a cited web page whose page names most of the cited subject's distinctive words (a PubChem record
 * "Domperidone Maleate | CID 6604595"); null otherwise
 */
function namesReference(ref, text, { webPage = false } = {}) {
  const T = textNorm(text), title = textNorm(ref.title).trim();
  const fam = textNorm(ref.authors?.[0]?.family).trim();
  const author = fam.length >= 3 && T.includes(` ${fam} `);
  if (title.split(' ').length >= 4 && T.includes(` ${title} `)) return { title: true, author };
  if (webPage) {
    const words = [...new Set(title.split(' ').filter(w => w.length >= 4 || /\d/.test(w)))];
    if (words.length >= 2 && words.filter(w => T.includes(` ${w} `)).length >= Math.ceil(words.length * 0.7)) return { words: true, author };
  }
  return null;
}

/**
 * A PubChem compound cited by CID or by its page (PubChem answers pages with a browser check, so its PUG REST API is
 * asked): the record with that CID must carry the compound named in the reference. -> web hit or null
 */
async function pubchemConfirm(ref) {
  const raw = String(ref.raw || '');
  if (!/pubchem/i.test(raw)) return null;
  let cid = (raw.match(/\bCID[:\s#]*(\d{1,10})\b/i) || [])[1];
  const page = (raw.match(/pubchem\.ncbi\.nlm\.nih\.gov\/compound\/([^\s/?#]+)/i) || [])[1];
  if (!cid && page) {
    if (/^\d+$/.test(page)) cid = page;
    else {
      const r = await getJson(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${enc(decodeURIComponent(page).replace(/[-_]+/g, ' '))}/cids/JSON`, { ttl: 30 * 86400, timeout: 15000, retries: 1 });
      cid = r.ok ? String(r.data?.IdentifierList?.CID?.[0] || '') : '';
    }
  }
  if (!cid) return null;
  const r = await getJson(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${enc(cid)}/property/Title/JSON`, { ttl: 30 * 86400, timeout: 15000, retries: 1 });
  const name = r.ok ? r.data?.PropertyTable?.Properties?.[0]?.Title : null;
  if (!name) return null;
  const cited = textNorm(`${ref.title} ${page ? decodeURIComponent(page).replace(/[-_]+/g, ' ') : ''}`);
  const words = textNorm(name).trim().split(' ').filter(w => w.length >= 3);
  if (!words.length || !words.every(w => cited.includes(` ${w} `))) return null;
  return { title: `${name} (PubChem CID ${cid})`, url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`, host: 'pubchem.ncbi.nlm.nih.gov', sim: 0.95, kind: 'record', snippet: `The PubChem record CID ${cid} is ${name}, as cited` };
}

/** Pages / PDFs at these addresses that name the reference, as web hits: [{ title, url, host, sim, snippet, author, kind }] */
async function pageConfirm(ref, urls, { webPage = false } = {}) {
  const pc = webPage ? await pubchemConfirm(ref).catch(() => null) : null;
  if (pc) return [pc];
  // the pages are read at once; the first (in result order) that names the reference is taken
  const read = await Promise.all(urls.map(url => readPage(url).catch(() => null)));
  for (const [i, url] of urls.entries()) {
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { continue; }
    const p = read[i];
    const n = p ? namesReference(ref, p.text, { webPage }) : null;
    if (n) return [{ title: ref.title, url, host, sim: n.title ? 0.97 : 0.9, author: n.author, kind: p.kind,
      snippet: `${p.kind === 'PDF' ? 'The PDF' : 'The page'} ${n.title ? `contains the cited title${n.author ? ' and the first author' : ''}` : 'names the cited subject'}` }];
  }
  return [];
}

/** Web results whose page title is the reference's title (>= 0.9): [{ title, url, host, sim, snippet }] */
function webHits(ref, results) {
  // page titles carry the site name ("Title | Journal", "Title - ScienceDirect") and Google shortens long ones with "..."
  const pageTitle = t => String(t || '').replace(/^\s*(?:[([]\s*(?:PDF|HTML|DOC|DOCX)\s*[)\]]\s*)+/i, '').replace(/\s*(?:\||–|—|-\s)\s*[^|–—]{2,60}$/, '').replace(/(?:\.\.\.|…)\s*$/, '').trim();
  const hits = (results || []).map(o => {
    const t = pageTitle(o.title);
    const shortened = /(?:\.\.\.|…)\s*$/.test(String(o.title || ''));
    const full = String(ref.title || '');
    const sim = shortened && t.length >= 25 && full.toLowerCase().startsWith(t.toLowerCase().slice(0, -1)) ? 0.95 : Math.max(titleSimilarity(full, t), titleSimilarity(full, o.title || ''));
    let host = '';
    try { host = new URL(o.link).hostname.replace(/^www\./, ''); } catch (e) { /* no link */ }
    return { title: o.title || '', url: o.link || '', host, sim: Math.round(sim * 100) / 100, snippet: String(o.snippet || '').slice(0, 300) };
  }).filter(h => h.url && h.sim >= 0.9);
  return hits.slice(0, 3);
}

/** SerpApi account: plan and searches left this month (Admin > Data) */
async function scholarAccount() {
  if (!scholarEnabled()) return { configured: false };
  const r = await getJson(`https://serpapi.com/account.json?api_key=${enc(cfg.SERPAPI_KEY)}`, { ttl: 0, timeout: 15000, retries: 1 });
  if (!r.ok) return { configured: true, error: r.data?.error || r.error || `HTTP ${r.status}` };
  const a = r.data || {};
  return { configured: true, plan: a.plan_name || a.plan_id || null, searchesPerMonth: a.searches_per_month ?? null, used: a.this_month_usage ?? null,
    left: a.total_searches_left ?? a.plan_searches_left ?? null, hourlyLimit: a.account_rate_limit_per_hour ?? null };
}

const DATABASES = [
  'Crossref', 'DOI Foundation (Handle)', 'DataCite', 'OpenAlex', 'PubMed', 'Europe PMC',
  'Semantic Scholar', 'arXiv', 'DBLP', 'Open Library', 'Google Books', 'ERIC', 'CORE'
];
const databases = () => (scholarEnabled() ? [...DATABASES, 'Google Scholar (SerpApi)', 'Google (SerpApi)'] : DATABASES);

module.exports = {
  crossrefInJournal,
  DATABASES, databases, scholarEnabled, scholarAvailable, parseScholarHtml, webSearchEnabled, pageConfirm, pubchemConfirm, namesReference, googleScholarSearch, googleWebSearch, serpSearch, pubmedCitationMatch, scholarAccount, fromScholar, parseScholarSummary,
  crossrefDoi, crossrefSearch, doiHandle, dataciteDoi, dataciteSearch,
  openalexDoi, openalexSearch, openalex, fromOpenAlex,
  pubmedPmid, pubmedSearch, europepmcSearch, s2Doi, s2Search,
  arxivId, arxivSearch, dblpSearch, openLibrarySearch, googleBooksSearch, ericSearch, coreDoi, coreSearch, coreQuery, fromCore
};
