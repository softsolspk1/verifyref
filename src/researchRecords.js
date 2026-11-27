// researchRecords.js - research-record datasets beside the journal and integrity lists: theses, preprints, clinical
// trials, regulatory dossiers, chemical & biological records, grant records and patents, and the bibliographic databases
// Royal Society of Chemistry, ProQuest Dissertations & Theses, Cochrane, JSTOR, CINAHL, BIOSIS and SPORTDiscus. Each is
// loaded from a free public source (no API key) in the PJPS subject areas - the subscription databases have no free API,
// so their records come from the free indexes that hold the same content (Crossref, DataCite, PubMed, Europe PMC) - or from
// a CSV file the Super Admin uploads (an export from the subscription database, the HEC thesis repository, DRAP dossiers).
// A manuscript is checked against all of them (Admin > Data and the Full Screening): the identifiers written in it (trial
// registration, patent, grant and application numbers, preprint, RSC, Cochrane and JSTOR DOIs, InChIKeys) and its title.
const db = require('./db');
const { getMeta, setMeta } = db;
const { getJson, request } = require('./http');
const { normalize } = require('./text');
const cfg = require('./config');

// the PJPS subject areas, for the sources that are searched by words
const PHARMA_WORDS = ['pharmaceutical', 'pharmacology', 'pharmacy', 'drug', 'pharmacokinetics', 'phytochemical', 'medicinal plant', 'antimicrobial', 'formulation', 'toxicology'];
// more subject words, after the PJPS ones, for the sources that hold fewer than SOURCE_MAX records on those alone
const WIDE_WORDS = [...PHARMA_WORDS, 'medicine', 'clinical', 'cancer', 'antioxidant', 'plant', 'health', 'disease', 'medical', 'biology', 'physiology', 'infection', 'diabetes', 'chemistry', 'toxicity', 'nanoparticles'];
const EPMC_SUBJECT = `(${PHARMA_WORDS.map(w => (w.includes(' ') ? `"${w}"` : w)).join(' OR ')})`;
// rows kept per dataset from a free source (the database stays small: titles and identifiers only); uploads up to UPLOAD_MAX
const SOURCE_MAX = 20000;
const UPLOAD_MAX = 50000;
const PAGE = 500;

const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// ------------------------------------------------------------------ the sources

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
/** One page of Europe PMC (theses: SRC:ETH, preprints: SRC:PPR, patents: SRC:PAT) */
async function epmcPage(src, cursor, kind, { query = `SRC:${src} AND ${EPMC_SUBJECT}`, size = PAGE } = {}) {
  const r = await getJson(`${EPMC}?query=${encodeURIComponent(query)}&format=json&resultType=lite&pageSize=${size}&cursorMark=${encodeURIComponent(cursor || '*')}`, { ttl: 0, timeout: 60000, retries: 2 });
  if (!r.ok) throw new Error(`Europe PMC: ${r.error || `HTTP ${r.status}`}`);
  const list = r.data?.resultList?.result || [];
  const rows = list.filter(x => x.title).map(x => ({
    kind, record_id: `${x.source}:${x.id}`, source: 'Europe PMC',
    title: x.title, authors: x.authorString, year: x.pubYear,
    identifier: kind === 'patent' ? x.id : x.doi || x.id,
    url: x.doi && kind !== 'patent' ? `https://doi.org/${x.doi}` : `https://europepmc.org/article/${x.source}/${x.id}`,
    details: [x.journalTitle, x.bookOrReportDetails?.publisher, kind === 'thesis' ? 'Doctoral thesis (EThOS)' : null, x.firstPublicationDate].filter(Boolean).join(' · ')
  }));
  const next = r.data?.nextCursorMark;
  return { rows, next: list.length && next && next !== cursor ? next : null, total: r.data?.hitCount ?? null };
}

const CTGOV = 'https://clinicaltrials.gov/api/v2/studies';
const CT_FIELDS = 'NCTId,BriefTitle,OfficialTitle,OverallStatus,StartDate,StudyFirstSubmitDate,LeadSponsorName,Condition,InterventionName';
function trialRow(s) {
  const p = s.protocolSection || {}, id = p.identificationModule || {}, st = p.statusModule || {};
  const interventions = (p.armsInterventionsModule?.interventions || []).map(i => i.name).filter(Boolean);
  return {
    kind: 'clinical_trial', record_id: id.nctId, source: 'ClinicalTrials.gov', title: id.officialTitle || id.briefTitle || id.nctId,
    authors: p.sponsorCollaboratorsModule?.leadSponsor?.name || null, year: (st.studyFirstSubmitDate || st.startDateStruct?.date || '').slice(0, 4) || null,
    identifier: id.nctId, url: `https://clinicaltrials.gov/study/${id.nctId}`,
    details: [st.overallStatus, st.studyFirstSubmitDate ? `registered ${st.studyFirstSubmitDate}` : null, (p.conditionsModule?.conditions || []).slice(0, 3).join(', '), interventions.slice(0, 3).join(', ')].filter(Boolean).join(' · ')
  };
}
/** Trials with a site in Pakistan (the journal's own country), then trials of drugs in the subject areas */
async function trialsPage(cursor) {
  const [phase, token] = String(cursor || 'pk:').split(/:(.*)/s);
  const filter = phase === 'pk' ? 'query.locn=Pakistan' : `query.intr=${encodeURIComponent('drug')}&filter.overallStatus=COMPLETED`;
  const r = await getJson(`${CTGOV}?${filter}&pageSize=${PAGE}&countTotal=true&fields=${CT_FIELDS}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { ttl: 0, timeout: 60000, retries: 2 });
  if (!r.ok) throw new Error(`ClinicalTrials.gov: ${r.error || `HTTP ${r.status}`}`);
  const rows = (r.data?.studies || []).map(trialRow).filter(x => x.record_id);
  const next = r.data?.nextPageToken ? `${phase}:${r.data.nextPageToken}` : phase === 'pk' ? 'drug:' : null;
  return { rows, next, total: r.data?.totalCount ?? null };
}

/** Drugs@FDA (openFDA): every FDA application (NDA, ANDA, BLA) with its products and submissions - the regulatory dossiers */
async function fdaPage(cursor) {
  const skip = parseInt(cursor || '0', 10) || 0;
  const r = await getJson(`https://api.fda.gov/drug/drugsfda.json?limit=${PAGE}&skip=${skip}`, { ttl: 0, timeout: 60000, retries: 2 });
  if (r.status === 404) return { rows: [], next: null, total: null };
  if (!r.ok) throw new Error(`openFDA: ${r.error || `HTTP ${r.status}`}`);
  const rows = fdaRows(r.data?.results || []);
  const total = r.data?.meta?.results?.total ?? null;
  // openFDA pages no further than 25,000 records
  const next = rows.length === PAGE && skip + PAGE < Math.min(total || Infinity, 25000) ? String(skip + PAGE) : null;
  return { rows, next, total };
}
function fdaRows(results) {
  return results.map(a => {
    const products = a.products || [];
    const brands = [...new Set(products.map(p => p.brand_name).filter(Boolean))];
    const ingredients = [...new Set(products.flatMap(p => (p.active_ingredients || []).map(i => i.name)).filter(Boolean))];
    const subs = a.submissions || [];
    const approved = subs.filter(s => s.submission_status === 'AP' && s.submission_status_date).map(s => s.submission_status_date).sort();
    return {
      kind: 'regulatory', record_id: a.application_number, source: 'Drugs@FDA (openFDA)',
      title: `${brands.slice(0, 3).join(', ') || ingredients.slice(0, 3).join(', ') || a.application_number}${ingredients.length && brands.length ? ` (${ingredients.slice(0, 3).join(', ')})` : ''}`,
      authors: a.sponsor_name || null, year: approved[0] ? approved[0].slice(0, 4) : null, identifier: a.application_number,
      url: `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${String(a.application_number).replace(/\D/g, '')}`,
      details: [[...new Set(products.map(p => [p.dosage_form, p.route].filter(Boolean).join(', ')))].slice(0, 2).join('; '), `${subs.length} submission(s)`, approved[0] ? `first approval ${approved[0].replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}` : null].filter(Boolean).join(' · ')
    };
  });
}

/** ChEMBL (EMBL-EBI): approved drugs (max phase 4) with their structure keys - the chemical and biological records */
/** ChEMBL (EMBL-EBI): approved drugs (max phase 4), then the clinical-stage compounds (phase 3, 2, 1); cursor "<phase>:<offset>" */
async function chemblPage(cursor) {
  const [ph, o] = String(cursor || '4:0').split(':');
  const phase = parseInt(ph, 10) || 4, offset = parseInt(o, 10) || 0;
  const r = await getJson(`https://www.ebi.ac.uk/chembl/api/data/molecule.json?max_phase=${phase}&limit=${PAGE}&offset=${offset}&only=molecule_chembl_id,pref_name,molecule_type,max_phase,first_approval,molecule_structures,molecule_properties,therapeutic_flag`, { ttl: 0, timeout: 90000, retries: 2 });
  if (!r.ok) throw new Error(`ChEMBL: ${r.error || `HTTP ${r.status}`}`);
  const rows = (r.data?.molecules || []).filter(m => m.pref_name || m.molecule_chembl_id).map(m => ({
    kind: 'chem_bio', record_id: m.molecule_chembl_id, source: 'ChEMBL',
    title: m.pref_name || m.molecule_chembl_id, authors: null, year: m.first_approval ? String(m.first_approval) : null,
    identifier: m.molecule_structures?.standard_inchi_key || m.molecule_chembl_id,
    url: `https://www.ebi.ac.uk/chembl/compound_report_card/${m.molecule_chembl_id}/`,
    details: [m.molecule_type, m.max_phase != null ? (Number(m.max_phase) >= 4 ? 'approved' : `clinical phase ${Math.floor(m.max_phase)}`) : null, m.molecule_properties?.full_molformula, m.molecule_properties?.full_mwt ? `MW ${m.molecule_properties.full_mwt}` : null, m.molecule_chembl_id].filter(Boolean).join(' · ')
  }));
  const meta = r.data?.page_meta || {};
  return { rows, next: meta.next ? `${phase}:${offset + PAGE}` : phase > 1 ? `${phase - 1}:0` : null, total: null };
}

/** NIH RePORTER: funded research projects in the subject areas - the grant records */
const NIH_FIELDS = ['ApplId', 'ProjectNum', 'ProjectTitle', 'FiscalYear', 'Organization', 'ContactPiName', 'AwardAmount', 'ProjectDetailUrl', 'AgencyIcAdmin'];
async function nihSearch(criteria, offset = 0, limit = PAGE) {
  const r = await request('https://api.reporter.nih.gov/v2/projects/search', {
    method: 'POST', json: true, ttl: 0, timeout: 60000, retries: 2, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ criteria, include_fields: NIH_FIELDS, offset, limit, sort_field: 'fiscal_year', sort_order: 'desc' })
  });
  if (!r.ok) throw new Error(`NIH RePORTER: ${r.error || `HTTP ${r.status}`}`);
  return r.data || {};
}
const grantRow = p => ({
  kind: 'grant', record_id: String(p.appl_id), source: 'NIH RePORTER', title: p.project_title || p.project_num,
  authors: p.contact_pi_name || null, year: p.fiscal_year ? String(p.fiscal_year) : null, identifier: p.project_num || String(p.appl_id),
  url: p.project_detail_url || `https://reporter.nih.gov/project-details/${p.appl_id}`,
  details: [p.organization?.org_name, p.organization?.org_country, p.agency_ic_admin?.abbreviation, p.award_amount ? `US$ ${Number(p.award_amount).toLocaleString('en-US')}` : null].filter(Boolean).join(' · ')
});
// RePORTER pages no further than 15,000 records of a search: one fiscal year at a time, newest first (cursor "<year>:<offset>")
const FIRST_YEAR = 1990;
async function grantsPage(cursor) {
  const [y, o] = String(cursor || '').split(':');
  const year = parseInt(y, 10) || new Date().getFullYear() + 1, offset = parseInt(o, 10) || 0;
  const d = await nihSearch({ fiscal_years: [year], advanced_text_search: { operator: 'or', search_field: 'projecttitle,terms', search_text: PHARMA_WORDS.filter(w => !w.includes(' ')).join(' ') } }, offset);
  const rows = (d.results || []).map(grantRow);
  const inYear = d.meta?.total ?? 0;
  const more = rows.length === PAGE && offset + PAGE < Math.min(inYear, 15000);
  return { rows, next: more ? `${year}:${offset + PAGE}` : year > FIRST_YEAR ? `${year - 1}:0` : null, total: null };
}

/** Crossref works (RSC: member 292, Cochrane Database of Systematic Reviews: ISSN 1465-1858, JSTOR: prefix 10.2307, dissertations) */
const CROSSREF_SELECT = 'DOI,title,author,issued,container-title,type,publisher';
function crossrefRow(kind, w, source) {
  const doi = String(w.DOI || '').toLowerCase();
  const authors = (w.author || []).slice(0, 6).map(a => [a.family, a.given ? a.given.split(/[\s.-]+/).filter(Boolean).map(x => x[0]).join('') : ''].filter(Boolean).join(' ') || a.name).filter(Boolean);
  return {
    kind, record_id: doi, source, title: (w.title || [])[0] || null,
    authors: authors.length ? `${authors.join(', ')}${(w.author || []).length > 6 ? ' et al.' : ''}` : null,
    year: w.issued?.['date-parts']?.[0]?.[0] ? String(w.issued['date-parts'][0][0]) : null, identifier: doi, url: doi ? `https://doi.org/${doi}` : null,
    details: [(w['container-title'] || [])[0], w.type === 'dissertation' ? 'Dissertation / thesis' : null, w.publisher].filter(Boolean).join(' · ')
  };
}
async function crossrefPage(kind, cursor, { filter, query = null, source }) {
  const r = await getJson(`https://api.crossref.org/works?filter=${encodeURIComponent(filter)}${query ? `&query=${encodeURIComponent(query)}` : ''}&rows=${PAGE}&select=${CROSSREF_SELECT}&cursor=${encodeURIComponent(cursor || '*')}&mailto=${encodeURIComponent(cfg.CONTACT_EMAIL)}`, { ttl: 0, timeout: 90000, retries: 2 });
  if (!r.ok) throw new Error(`Crossref: ${r.error || `HTTP ${r.status}`}`);
  const m = r.data?.message || {};
  const items = m.items || [];
  const rows = items.map(w => crossrefRow(kind, w, source)).filter(x => x.record_id && x.title);
  const next = m['next-cursor'];
  return { rows, next: items.length && next && next !== cursor ? next : null, total: m['total-results'] ?? null };
}
// Crossref finds few records for a query of many words: one subject word at a time (cursor "<word index>|<Crossref cursor>")
async function crossrefByWords(kind, cursor, { filter, source }) {
  const [i, token] = String(cursor || '0|').split(/\|(.*)/s);
  const n = parseInt(i, 10) || 0;
  const p = await crossrefPage(kind, token || null, { filter, query: WIDE_WORDS[n], source });
  return { ...p, next: p.next ? `${n}|${p.next}` : n + 1 < WIDE_WORDS.length ? `${n + 1}|` : null, total: null };
}

/** DataCite dissertations (university repositories) in the subject areas; url: the next page DataCite gave */
async function dataciteThesesPage(url) {
  const q = PHARMA_WORDS.map(w => (w.includes(' ') ? `"${w}"` : w)).join(' OR ');
  const r = await getJson(url || `https://api.datacite.org/dois?resource-type-id=dissertation&query=${encodeURIComponent(q)}&page%5Bsize%5D=${PAGE}&page%5Bcursor%5D=1`, { ttl: 0, timeout: 90000, retries: 2 });
  if (!r.ok) throw new Error(`DataCite: ${r.error || `HTTP ${r.status}`}`);
  const rows = (r.data?.data || []).map(d => {
    const a = d.attributes || {}, doi = String(a.doi || d.id || '').toLowerCase();
    const publisher = typeof a.publisher === 'string' ? a.publisher : a.publisher?.name;
    return { kind: 'proquest', record_id: doi, source: 'DataCite (university repositories)', title: a.titles?.[0]?.title || null,
      authors: (a.creators || []).slice(0, 4).map(c => c.name).filter(Boolean).join('; ') || null,
      year: a.publicationYear ? String(a.publicationYear) : null, identifier: doi, url: `https://doi.org/${doi}`, details: ['Dissertation / thesis', publisher].filter(Boolean).join(' · ') };
  }).filter(x => x.record_id && x.title);
  return { rows, next: rows.length && r.data?.links?.next ? r.data.links.next : null, total: r.data?.meta?.total ?? null };
}
/** Dissertations and theses: Crossref's dissertation records, then DataCite's (ProQuest itself has no free API) */
async function dissertationsPage(cursor) {
  const [phase, token] = String(cursor || 'cr:').split(/:(.*)/s);
  if (phase === 'cr') {
    const p = await crossrefByWords('proquest', token || null, { filter: 'type:dissertation', source: 'Crossref (dissertations)' });
    return { ...p, next: p.next ? `cr:${p.next}` : 'dc:' };
  }
  const p = await dataciteThesesPage(token || null);
  return { ...p, next: p.next ? `dc:${p.next}` : null };
}

/** PubMed (NCBI E-utilities): the records of a search, newest first, as dataset `kind` */
const ncbiKey = () => (cfg.NCBI_API_KEY ? `&api_key=${encodeURIComponent(cfg.NCBI_API_KEY)}` : '');
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
// E-utilities page no further than 10,000 records of a search: one publication year at a time, newest first
// (cursor "<year>:<start>"; the whole search is counted once, on its first page)
async function pubmedPage(kind, term, cursor, source) {
  const [y, st] = String(cursor || '').split(':');
  const year = parseInt(y, 10) || new Date().getFullYear(), start = parseInt(st, 10) || 0;
  let total = null;
  if (!cursor) {
    const c = await getJson(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=0&term=${encodeURIComponent(term)}${ncbiKey()}`, { ttl: 0, timeout: 60000, retries: 2 });
    total = parseInt(c.data?.esearchresult?.count || '0', 10) || null;
  }
  const s = await getJson(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=pub_date&retstart=${start}&retmax=${PAGE}&term=${encodeURIComponent(`(${term}) AND ${year}[dp]`)}${ncbiKey()}`, { ttl: 0, timeout: 60000, retries: 2 });
  if (!s.ok) throw new Error(`PubMed: ${s.error || `HTTP ${s.status}`}`);
  const ids = s.data?.esearchresult?.idlist || [];
  const inYear = parseInt(s.data?.esearchresult?.count || '0', 10) || 0;
  const nextYear = year > FIRST_YEAR ? `${year - 1}:0` : null;
  if (!ids.length) return { rows: [], next: nextYear, total };
  const r = await request(`${EUTILS}/esummary.fcgi`, { method: 'POST', json: true, ttl: 0, timeout: 90000, retries: 2, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `db=pubmed&retmode=json&id=${ids.join(',')}${ncbiKey()}` });
  if (!r.ok) throw new Error(`PubMed: ${r.error || `HTTP ${r.status}`}`);
  const res = r.data?.result || {};
  const rows = ids.map(id => res[id]).filter(x => x?.title).map(x => {
    const doi = (x.articleids || []).find(a => a.idtype === 'doi')?.value || null;
    const authors = (x.authors || []).slice(0, 6).map(a => a.name);
    return { kind, record_id: `PMID:${x.uid}`, source, title: x.title.replace(/\.$/, ''), authors: authors.length ? `${authors.join(', ')}${(x.authors || []).length > 6 ? ' et al.' : ''}` : null,
      year: (String(x.pubdate || '').match(/(?:19|20)\d{2}/) || [])[0] || null, identifier: doi || `PMID ${x.uid}`, url: `https://pubmed.ncbi.nlm.nih.gov/${x.uid}/`,
      details: [x.fulljournalname || x.source, x.pubdate, `PMID ${x.uid}`].filter(Boolean).join(' · ') };
  });
  return { rows, next: ids.length === PAGE && start + PAGE < Math.min(inYear, 9999) ? `${year}:${start + PAGE}` : nextYear, total };
}

// the subscription databases: their records come from the free index named as the source
const SUBSCRIPTION_NOTE = 'The subscription database itself has no free API: these records come from the free index named as the source; export records from your subscription as CSV and upload them to add its own.';

const KINDS = {
  thesis: { label: 'Thesis Dataset', short: 'Theses', source: 'Europe PMC (EThOS doctoral theses)', page: c => epmcPage('ETH', c, 'thesis', { query: `SRC:ETH AND (${WIDE_WORDS.map(w => (w.includes(' ') ? `"${w}"` : w)).join(' OR ')})` }),
    about: 'Doctoral theses in pharmacy, pharmacology and the drug sciences (EThOS via Europe PMC), plus uploaded thesis lists (e.g. the HEC Pakistan research repository). A manuscript that is a thesis already deposited, or copies one, is named.' },
  preprint: { label: 'Preprint Dataset', short: 'Preprints', source: 'Europe PMC (bioRxiv, medRxiv, Research Square, SSRN, Preprints.org …)', page: c => epmcPage('PPR', c, 'preprint'),
    about: 'Preprints in the PJPS subject areas from the preprint servers indexed by Europe PMC. A manuscript posted as a preprint first (its DOI or the same title) is named, so the editor can check the preprint policy and prior publication.' },
  clinical_trial: { label: 'Clinical Trial Dataset', short: 'Clinical trials', source: 'ClinicalTrials.gov (trials with a site in Pakistan, then completed drug trials)', page: trialsPage,
    about: 'Registered clinical trials: title, registration number and date, status, sponsor, conditions and interventions. The trial registration numbers in a manuscript are looked up (here and live in ClinicalTrials.gov) and its title compared with the registered trials.' },
  regulatory: { label: 'Regulatory Dossier Dataset', short: 'Regulatory dossiers', source: 'Drugs@FDA (openFDA): NDA, ANDA and BLA applications', page: fdaPage,
    about: 'Drug applications (regulatory dossiers): application number, sponsor, products, dosage forms and approval history; uploaded national dossiers (e.g. DRAP registrations) beside them. NDA / ANDA / BLA numbers and the products named in a manuscript are matched.' },
  chem_bio: { label: 'Chemical and Biological Database', short: 'Chemical & biological', source: 'ChEMBL approved and clinical-stage drugs (with live PubChem look-ups)', page: chemblPage,
    about: 'Approved and clinical-stage (phase 1-3) small molecules and biologics with their type, formula and InChIKey (ChEMBL); InChIKeys in a manuscript are matched here and live in PubChem, and the compounds in its title are identified.' },
  grant: { label: 'Grant Record Dataset', short: 'Grant records', source: 'NIH RePORTER (funded projects in the subject areas)', page: grantsPage,
    about: 'Funded research projects: grant number, title, principal investigator, organisation and amount; uploaded funder lists (e.g. HEC NRPU grants) beside them. Grant numbers in the funding statement are matched and the title compared with funded projects.' },
  patent: { label: 'Patent Dataset', short: 'Patents', source: 'Europe PMC patents (European Patent Office)', // over 4 million patents: the subject words in the title only (the whole-record search times out at Europe PMC)
    page: c => epmcPage('PAT', c, 'patent', { query: 'SRC:PAT AND TITLE:(pharmaceutical OR "pharmaceutical composition" OR formulation OR "herbal" OR "plant extract" OR antimicrobial)' }),
    about: 'Patents in the drug and pharmaceutical sciences (EPO via Europe PMC). Patent numbers in a manuscript are matched, and a manuscript that reports work already patented (same title) is named.' },
  rsc: { label: 'Royal Society of Chemistry', short: 'Royal Society of Chemistry', literature: true, source: 'Crossref (RSC journals, member 292, DOI 10.1039)',
    page: c => crossrefByWords('rsc', c, { filter: 'member:292,type:journal-article', source: 'Crossref (RSC)' }),
    about: 'Articles in the Royal Society of Chemistry journals (RSC Advances, Analyst, RSC Medicinal Chemistry, Food & Function …) in the PJPS subject areas, from the DOIs RSC registers with Crossref. RSC DOIs written in the manuscript are matched, and a manuscript already published by RSC (same title) is named.' },
  proquest: { label: 'ProQuest Dissertations and Theses', short: 'Dissertations & theses', literature: true, source: 'Crossref and DataCite dissertation records (university repositories)',
    page: dissertationsPage,
    about: `Doctoral and master's dissertations in the PJPS subject areas that universities register with DOIs (Crossref, DataCite). A manuscript that is a thesis already deposited, or copies one, is named. ${SUBSCRIPTION_NOTE}` },
  cochrane: { label: 'Cochrane Library', short: 'Cochrane', literature: true, source: 'Crossref (Cochrane Database of Systematic Reviews, ISSN 1465-1858)',
    page: c => crossrefPage('cochrane', c, { filter: 'issn:1465-1858', source: 'Crossref (Cochrane Database of Systematic Reviews)' }),
    about: 'Every Cochrane systematic review and protocol (each version). Cochrane DOIs (10.1002/14651858.CD…) written in the manuscript are matched, and a review whose question Cochrane has already answered (same title) is named.' },
  jstor: { label: 'JSTOR', short: 'JSTOR', literature: true, source: 'Crossref (JSTOR, prefix 10.2307)',
    page: c => crossrefByWords('jstor', c, { filter: 'prefix:10.2307,type:journal-article', source: 'Crossref (JSTOR)' }),
    about: 'Journal articles in the PJPS subject areas that JSTOR registers with Crossref (DOI 10.2307). JSTOR DOIs and stable links in the manuscript are matched, and a manuscript already in JSTOR (same title) is named.' },
  cinahl: { label: 'CINAHL', short: 'CINAHL', literature: true, source: 'PubMed (nursing and allied-health records on medicines and pharmacology)',
    page: c => pubmedPage('cinahl', '(nursing[mh] OR nursing[sh] OR nurses[mh] OR nursing care[mh] OR allied health personnel[mh]) AND (medication*[tiab] OR drug*[tiab] OR pharmac*[tiab] OR prescrib*[tiab])', c, 'PubMed (nursing & allied health)'),
    about: `Nursing and allied-health research on medicines, medication safety and pharmaceutical care (the CINAHL subject area). A manuscript already published there (same title) is named. ${SUBSCRIPTION_NOTE}` },
  biosis: { label: 'BIOSIS', short: 'BIOSIS', literature: true, source: 'Europe PMC (AGRICOLA life-science records)',
    page: c => epmcPage('AGR', c, 'biosis', { query: 'SRC:AGR AND ("medicinal plant" OR phytochemical OR antimicrobial OR pharmacology OR "plant extract" OR antioxidant OR toxicity OR ethnobotany)', size: 250 }),
    about: `Life-science research (botany, microbiology, plant extracts, pharmacology, toxicology; the BIOSIS Previews subject area) from the AGRICOLA records in Europe PMC. A manuscript already published there (same title) is named. ${SUBSCRIPTION_NOTE}` },
  sportdiscus: { label: 'SPORTDiscus', short: 'SPORTDiscus', literature: true, source: 'PubMed (sports and exercise records on drugs, supplements and doping)',
    page: c => pubmedPage('sportdiscus', '(sports[mh] OR sports medicine[mh] OR athletic performance[mh] OR athletes[mh] OR doping in sports[mh] OR performance-enhancing substances[mh] OR exercise[mh] OR physical fitness[mh]) AND (drug*[tiab] OR supplement*[tiab] OR doping[tiab] OR pharmac*[tiab] OR ergogenic[tiab])', c, 'PubMed (sports & exercise)'),
    about: `Sports and exercise science on drugs, dietary supplements, doping and pharmacology (the SPORTDiscus subject area). A manuscript already published there (same title) is named. ${SUBSCRIPTION_NOTE}` }
};

// ------------------------------------------------------------------ storing

const COLS = ['kind', 'record_id', 'source', 'title', 'title_norm', 'authors', 'year', 'identifier', 'url', 'details'];
const idKey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function upsert(rows) {
  const clean = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.record_id || !r.title) continue;
    const key = `${r.kind}|${r.record_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ ...r, record_id: clip(r.record_id, 200), title: clip(r.title, 500), title_norm: normalize(r.title).slice(0, 500), authors: r.authors ? clip(r.authors, 300) : null,
      year: r.year ? String(r.year).slice(0, 10) : null, identifier: r.identifier ? clip(r.identifier, 200) : null, url: r.url ? clip(r.url, 500) : null, details: r.details ? clip(r.details, 400) : null });
  }
  for (let i = 0; i < clean.length; i += 200) {
    const part = clean.slice(i, i + 200);
    const args = [];
    const values = part.map(r => `(${COLS.map(c => { args.push(r[c] ?? null); return `$${args.length}`; }).join(', ')}, now())`).join(', ');
    await db.query(`INSERT INTO research_records(${COLS.join(', ')}, loaded_at) VALUES ${values}
      ON CONFLICT (kind, record_id) DO UPDATE SET ${COLS.slice(2).map(c => `${c} = EXCLUDED.${c}`).join(', ')}, loaded_at = now()`, args);
  }
  return clean.length;
}

async function countOf(kind) { return (await db.one('SELECT COUNT(*)::int AS n FROM research_records WHERE kind = $1', [kind])).n; }

/** After a load or an upload: the counts and dates (the desktop copies the table when rrec_loaded_at changes) */
async function stamp(kind) {
  const n = await countOf(kind);
  const now = new Date().toISOString();
  await setMeta(`rrec_${kind}_count`, n);
  await setMeta(`rrec_${kind}_loaded_at`, now);
  await setMeta('rrec_count', (await db.one('SELECT COUNT(*)::int AS n FROM research_records')).n);
  await setMeta('rrec_loaded_at', now);
  return n;
}

/**
 * Load one dataset from its free source, continuing where the last load stopped, until SOURCE_MAX rows or the time
 * budget. -> { kind, added, count, total, done }
 */
async function loadKind(kind, { budgetMs = Infinity, restart = false, log = () => {} } = {}) {
  const k = KINDS[kind];
  if (!k) throw new Error('Unknown dataset.');
  const start = Date.now();
  // a reload (restart) reads the source again from the start: SOURCE_MAX records fetched afresh, then the records it
  // did not bring back again are removed (uploads kept), so the dataset stays current and no larger (it used to stop at
  // once: the dataset was already full)
  if (restart) { await setMeta(`rrec_${kind}_since`, new Date().toISOString()); await setMeta(`rrec_${kind}_fetched`, 0); await setMeta(`rrec_${kind}_next`, ''); }
  const since = await getMeta(`rrec_${kind}_since`) || null;
  let fetched = parseInt((await getMeta(`rrec_${kind}_fetched`)) || '0', 10) || 0;
  let cursor = await getMeta(`rrec_${kind}_next`) || null;
  if (cursor === 'done') cursor = null;
  let added = 0, total = null, done = false;
  let count = await countOf(kind);
  while (Date.now() - start < budgetMs - 20000) {
    if ((since ? fetched : count) >= SOURCE_MAX) { done = true; break; }
    const page = await k.page(cursor);
    total = page.total ?? total;
    added += await upsert(page.rows);
    count = await countOf(kind);
    // a reload counts the records it brought back (a record found again under another subject word counts once)
    if (since) fetched = (await db.one("SELECT COUNT(*)::int AS n FROM research_records WHERE kind = $1 AND source NOT LIKE 'Upload:%' AND loaded_at >= $2", [kind, since])).n;
    const shown = since ? fetched : count;
    log(`${k.label}: ${shown.toLocaleString('en-US')} records${since ? ' refreshed' : ''}${total ? ` (the source has ${Number(total).toLocaleString('en-US')})` : ''}`, Math.min(95, Math.round(shown / SOURCE_MAX * 100)));
    cursor = page.next;
    await setMeta(`rrec_${kind}_next`, cursor || 'done');
    if (since) await setMeta(`rrec_${kind}_fetched`, fetched);
    if (!cursor) { done = true; break; }
  }
  if (done && since) {
    await db.query("DELETE FROM research_records WHERE kind = $1 AND source NOT LIKE 'Upload:%' AND loaded_at < $2", [kind, since]);
    await setMeta(`rrec_${kind}_since`, '');
    await setMeta(`rrec_${kind}_next`, 'done');
  }
  if (total != null) await setMeta(`rrec_${kind}_total`, total);
  count = await stamp(kind);
  return { kind, label: k.label, added, count, total, done };
}

// columns of an uploaded file, found by their names
const UPLOAD_COLS = {
  title: [/^title$/i, /title/i, /^name$/i, /thesis|project|invention|compound|product|drug/i],
  record_id: [/^(?:id|record.?id|accession)$/i, /registration.?(?:no|number)|application.?(?:no|number)|patent.?(?:no|number)|grant.?(?:no|number)|project.?(?:no|number)|reg.?no/i, /\bid\b|number|\bno\b/i],
  authors: [/author|scholar|student|investigator|\bpi\b|sponsor|applicant|inventor|assignee|holder|company|manufacturer/i],
  year: [/^year$/i, /year|date/i],
  identifier: [/doi|nct|inchi|cas|isbn|registration|application|patent|grant|identifier/i],
  url: [/url|link|website/i],
  details: [/university|institution|supervisor|status|abstract|description|summary|degree|department|funder|agency|strength|dosage|formula|country/i]
};
function pickCol(headers, pats, used) {
  for (const p of pats) { const h = headers.find(x => !used.has(x) && p.test(x)); if (h) { used.add(h); return h; } }
  return null;
}

/** An uploaded CSV of one dataset (columns found by name): its rows are added to the records of that dataset */
async function importCsv(kind, filename, csvText) {
  if (!KINDS[kind]) throw new Error('Unknown dataset.');
  const objs = require('./datasets').csvToObjects(csvText);
  if (!objs.length) throw new Error('The file has no rows. Upload a CSV file (UTF-8) with a header row.');
  const headers = Object.keys(objs[0]);
  const used = new Set();
  const map = {};
  for (const c of ['title', 'record_id', 'authors', 'year', 'identifier', 'url', 'details']) map[c] = pickCol(headers, UPLOAD_COLS[c], used);
  if (!map.title) throw new Error(`No title column was found (columns: ${headers.slice(0, 12).join(', ')}). Name the title column “Title”.`);
  const extra = headers.filter(h => !used.has(h)).slice(0, 4);
  const src = `Upload: ${clip(filename || 'file', 80)}`;
  const rows = objs.slice(0, UPLOAD_MAX).map((o, i) => {
    const year = map.year ? (String(o[map.year]).match(/(?:19|20)\d{2}/) || [])[0] : null;
    const id = map.record_id && o[map.record_id] ? o[map.record_id] : map.identifier && o[map.identifier] ? o[map.identifier] : `${idKey(filename).slice(0, 30)}-${normalize(o[map.title]).slice(0, 80)}-${i}`;
    return {
      kind, record_id: `upload:${id}`, source: src, title: o[map.title], authors: map.authors ? o[map.authors] : null, year,
      identifier: (map.identifier && o[map.identifier]) || (map.record_id && o[map.record_id]) || null, url: map.url && /^https?:\/\//.test(o[map.url]) ? o[map.url] : null,
      details: [map.details ? o[map.details] : null, ...extra.map(h => (o[h] ? `${h}: ${o[h]}` : null))].filter(Boolean).join(' · ')
    };
  });
  const added = await upsert(rows);
  return { kind, label: KINDS[kind].label, added, skipped: objs.length - added, columns: map, count: await stamp(kind) };
}

/** Remove the rows of one upload, or all the rows of a dataset */
async function clearKind(kind, { source = null } = {}) {
  if (!KINDS[kind]) throw new Error('Unknown dataset.');
  const r = source ? await db.query('DELETE FROM research_records WHERE kind = $1 AND source = $2', [kind, source]) : await db.query('DELETE FROM research_records WHERE kind = $1', [kind]);
  if (!source) await setMeta(`rrec_${kind}_next`, '');
  await stamp(kind);
  return { removed: r.rowCount ?? null };
}

async function status() {
  const counts = Object.fromEntries((await db.all('SELECT kind, source, COUNT(*)::int AS n FROM research_records GROUP BY kind, source').catch(() => []))
    .reduce((m, r) => { (m.get(r.kind) || m.set(r.kind, []).get(r.kind)).push({ source: r.source, count: r.n }); return m; }, new Map()));
  const out = {};
  for (const [key, k] of Object.entries(KINDS)) {
    const next = await getMeta(`rrec_${key}_next`);
    out[key] = { key, label: k.label, short: k.short, source: k.source, about: k.about, count: parseInt((await getMeta(`rrec_${key}_count`)) || '0', 10),
      loadedAt: await getMeta(`rrec_${key}_loaded_at`), sourceTotal: parseInt((await getMeta(`rrec_${key}_total`)) || '0', 10) || null,
      complete: next === 'done', max: SOURCE_MAX, sources: counts[key] || [] };
  }
  return { kinds: out, loadedAt: await getMeta('rrec_loaded_at'), count: parseInt((await getMeta('rrec_count')) || '0', 10) };
}

// ------------------------------------------------------------------ checking a manuscript against every dataset

const LIVE_MS = 45000;
const STOP = new Set('the and for with from into among between through using based study effect effects evaluation analysis role patients their its this that are was were which have has after during against versus under over than other new novel potential activity activities assessment comparative clinical'.split(' '));
const words = t => [...new Set(normalize(t).split(' ').filter(w => w.length > 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
/** How much of the manuscript title the record's title holds, and the other way round (0-1) */
function titleScore(a, b) {
  const A = words(a), B = new Set(words(b));
  if (A.length < 3 || B.size < 3) return 0;
  const shared = A.filter(w => B.has(w)).length;
  return Math.round(Math.min(shared / A.length, shared / B.size) * 100) / 100 * 0.5 + Math.round(shared / Math.min(A.length, B.size) * 100) / 100 * 0.5;
}

// identifiers written in a manuscript, by dataset
const IDS = {
  clinical_trial: [/\bNCT\s?\d{8}\b/gi, /\bISRCTN\d{6,}\b/gi, /\bChiCTR[-\w]{6,}\b/g, /\bCTRI\/\d{4}\/\d{2,3}\/\d+\b/g, /\bIRCT\w{8,}\b/g, /\bACTRN\d{10,}\b/g, /\bPACTR\d{10,}\b/g, /\bDRKS\d{6,}\b/g, /\bEudraCT\s*(?:No\.?|number)?\s*:?\s*\d{4}-\d{6}-\d{2}\b/gi],
  patent: [/\b(?:US|EP|WO|CN|JP|KR|IN|PK|GB|DE|CA|AU)\s?-?(?:\d{4}\/\d{6}|\d{6,11})\s?[A-C]?\d?\b/g],
  preprint: [/\b10\.(?:1101|21203|20944|31219|26434|22541|2139\/ssrn|14293|36227|31234|32942|1002\/essoar)\/[^\s"<>)\]]+/gi],
  grant: [/\b[RKUPFTDS]\d{2}\s?[A-Z]{2}\d{6}(?:-\d{2})?\b/g, /\b(?:NRPU|TDF|SRGP|LCF)[-\s/]?(?:No\.?\s*)?\d[\w/-]{2,}\b/g],
  regulatory: [/\b(?:NDA|ANDA|BLA)\s?#?-?\s?\d{5,6}\b/g, /\bReg(?:istration)?\.?\s?No\.?\s?\d{5,6}\b/g],
  chem_bio: [/\b[A-Z]{14}-[A-Z]{10}-[A-Z]\b/g, /\bCHEMBL\d+\b/g],
  rsc: [/\b10\.1039\/[A-Za-z0-9.]+/g],
  cochrane: [/\b10\.1002\/14651858\.[A-Za-z0-9.]+/gi],
  jstor: [/\b10\.2307\/[A-Za-z0-9.]+/g, /\bjstor\.org\/stable\/\d+/gi]
};
function identifiersIn(text) {
  const out = {};
  for (const [kind, res] of Object.entries(IDS)) {
    const found = new Set();
    for (const re of res) for (const m of String(text).matchAll(re)) found.add(m[0].replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim());
    if (found.size) out[kind] = [...found].slice(0, 20);
  }
  return out;
}
// the form the sources store an identifier in
const canon = (kind, id) => {
  if (kind === 'clinical_trial') return id.replace(/^EudraCT\s*(?:No\.?|number)?\s*:?\s*/i, '').replace(/\s+/g, '').toUpperCase();
  if (kind === 'regulatory') { const m = id.match(/(NDA|ANDA|BLA)\D*(\d{5,6})/i); return m ? `${m[1].toUpperCase()}${m[2].padStart(6, '0')}` : id; }
  if (kind === 'patent') return idKey(id);
  if (kind === 'grant') return id.replace(/\s+/g, '').toUpperCase();
  if (kind === 'jstor') { const m = id.match(/stable\/(\d+)/i); return m ? `10.2307/${m[1]}` : id.toLowerCase(); }
  if (kind === 'rsc' || kind === 'cochrane') return id.toLowerCase();
  return id;
};

async function localById(kind, ids) {
  if (!ids.length) return [];
  const keys = ids.map(i => idKey(canon(kind, i)));
  return db.all(`SELECT kind, record_id, source, title, authors, year, identifier, url, details FROM research_records
    WHERE kind = $1 AND (upper(regexp_replace(coalesce(identifier, ''), '[^A-Za-z0-9]', '', 'g')) = ANY($2::text[]) OR upper(regexp_replace(record_id, '[^A-Za-z0-9]', '', 'g')) = ANY($2::text[])) LIMIT 50`, [kind, keys]).catch(() => []);
}

/** Stored records whose title shares words with the manuscript title, scored */
async function localByTitle(title) {
  const w = words(title).sort((a, b) => b.length - a.length).slice(0, 6);
  if (w.length < 3) return [];
  const args = w.map(x => `%${x}%`);
  const hits = w.map((_, i) => `(CASE WHEN title_norm LIKE $${i + 1} THEN 1 ELSE 0 END)`).join(' + ');
  const rows = await db.all(`SELECT kind, record_id, source, title, authors, year, identifier, url, details FROM research_records
    WHERE ${hits} >= ${Math.min(3, w.length)} LIMIT 400`, args).catch(() => []);
  return rows.map(r => ({ ...r, score: titleScore(title, r.title) })).filter(r => r.score >= 0.5);
}

/** Live: Europe PMC theses, preprints and patents with the title's words; ClinicalTrials.gov trials with them */
async function liveByTitle(title) {
  const w = words(title).sort((a, b) => b.length - a.length).slice(0, 5);
  if (w.length < 3) return [];
  const out = [];
  const tasks = [
    (async () => {
      const p = await epmcPage(null, '*', null, { query: `(SRC:ETH OR SRC:PPR OR SRC:PAT) AND TITLE:(${w.join(' AND ')})`, size: 50 });
      for (const r of p.rows) { const src = r.record_id.split(':')[0]; out.push({ ...r, kind: { ETH: 'thesis', PPR: 'preprint', PAT: 'patent' }[src], identifier: src === 'PAT' ? r.record_id.split(':')[1] : r.identifier }); }
    })(),
    // one Crossref search, sorted into the datasets by DOI prefix (RSC, Cochrane, JSTOR) or type (dissertations)
    (async () => {
      const r = await getJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title.slice(0, 300))}&rows=20&select=${CROSSREF_SELECT}&mailto=${encodeURIComponent(cfg.CONTACT_EMAIL)}`, { ttl: 7 * 86400, timeout: 20000, retries: 1 });
      for (const w of (r.ok ? r.data?.message?.items : null) || []) {
        const doi = String(w.DOI || '').toLowerCase();
        const kind = doi.startsWith('10.1039/') ? 'rsc' : doi.startsWith('10.1002/14651858') ? 'cochrane' : doi.startsWith('10.2307/') ? 'jstor' : w.type === 'dissertation' ? 'proquest' : null;
        if (kind) out.push(crossrefRow(kind, w, 'Crossref'));
      }
    })(),
    (async () => {
      const r = await getJson(`${CTGOV}?query.titles=${encodeURIComponent(w.join(' AND '))}&pageSize=20&fields=${CT_FIELDS}`, { ttl: 7 * 86400, timeout: 20000, retries: 1 });
      if (r.ok) out.push(...(r.data?.studies || []).map(trialRow));
    })()
  ];
  await Promise.all(tasks.map(t => t.catch(() => null)));
  return out.filter(r => r.kind).map(r => ({ ...r, live: true, score: titleScore(title, r.title) })).filter(r => r.score >= 0.5);
}

/** Live look-ups of identifiers that are not in the stored records: trial registrations, preprint DOIs, InChIKeys, grants */
async function liveById(kind, ids) {
  const out = [];
  if (kind === 'clinical_trial') {
    for (const id of ids.filter(x => /^NCT/i.test(x)).slice(0, 5)) {
      const nct = canon(kind, id);
      const r = await getJson(`${CTGOV}/${nct}`, { ttl: 14 * 86400, timeout: 15000, retries: 1 });
      if (r.status === 404) out.push({ kind, identifier: nct, missing: true, note: `${nct} is not registered in ClinicalTrials.gov — a typing error or an invented registration` });
      else if (r.ok) out.push({ ...trialRow(r.data), live: true });
    }
  } else if (kind === 'preprint') {
    for (const doi of ids.slice(0, 5)) {
      const p = await epmcPage(null, '*', 'preprint', { query: `DOI:"${doi}"`, size: 5 }).catch(() => null);
      if (p?.rows.length) out.push(...p.rows.map(r => ({ ...r, live: true })));
    }
  } else if (kind === 'patent') {
    for (const id of ids.slice(0, 5)) {
      const p = await epmcPage(null, '*', 'patent', { query: `SRC:PAT AND EXT_ID:${idKey(id)}`, size: 5 }).catch(() => null);
      if (p?.rows.length) out.push(...p.rows.map(r => ({ ...r, live: true })));
    }
  } else if (kind === 'chem_bio') {
    for (const key of ids.filter(x => /^[A-Z]{14}-/.test(x)).slice(0, 5)) {
      const r = await getJson(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/inchikey/${key}/property/Title,MolecularFormula/JSON`, { ttl: 30 * 86400, timeout: 15000, retries: 1 });
      const p = r.ok ? r.data?.PropertyTable?.Properties?.[0] : null;
      if (p) out.push({ kind, record_id: `CID${p.CID}`, source: 'PubChem', title: p.Title || key, identifier: key, url: `https://pubchem.ncbi.nlm.nih.gov/compound/${p.CID}`, details: p.MolecularFormula, live: true });
      else if (r.status === 404) out.push({ kind, identifier: key, missing: true, note: `InChIKey ${key} is not in PubChem` });
    }
  } else if (kind === 'grant') {
    const nih = ids.filter(x => /^[RKUPFTDS]\d{2}/.test(x)).slice(0, 5);
    if (nih.length) {
      const d = await nihSearch({ project_nums: nih.map(x => `*${x.replace(/\s+/g, '')}*`) }, 0, 20).catch(() => null);
      if (d?.results) out.push(...d.results.map(p => ({ ...grantRow(p), live: true })));
    }
  } else if (kind === 'rsc' || kind === 'cochrane' || kind === 'jstor') {
    for (const id of ids.slice(0, 5)) {
      const doi = canon(kind, id);
      const r = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(cfg.CONTACT_EMAIL)}`, { ttl: 30 * 86400, timeout: 15000, retries: 1 });
      if (r.ok && r.data?.message) out.push({ ...crossrefRow(kind, r.data.message, 'Crossref'), live: true });
      else if (r.status === 404) out.push({ kind, identifier: doi, missing: true, note: `DOI ${doi} is not registered (Crossref): a typing error or an invented DOI` });
    }
  } else if (kind === 'regulatory') {
    for (const id of ids.slice(0, 5)) {
      const c = canon(kind, id);
      if (!/^(?:NDA|ANDA|BLA)\d{6}$/.test(c)) continue;
      const r = await getJson(`https://api.fda.gov/drug/drugsfda.json?search=application_number:"${c}"&limit=1`, { ttl: 14 * 86400, timeout: 15000, retries: 1 });
      if (r.ok && r.data?.results?.length) {
        out.push(...fdaRows(r.data.results).map(x => ({ ...x, live: true })));
      } else if (r.status === 404) out.push({ kind, identifier: c, missing: true, note: `${c} is not an FDA application number` });
    }
  }
  return out;
}
/**
 * A manuscript checked against every research-record dataset: { title, text } -> { identifiers, datasets: [{ key, label, matches }],
 * summary }. Stored records first, then the live sources (when online) for what the stored ones do not hold.
 */
async function check({ title = '', text = '' } = {}, { online = true } = {}) {
  const ids = identifiersIn(`${title}\n${text}`);
  const byKind = Object.fromEntries(Object.keys(KINDS).map(k => [k, []]));
  const add = r => { if (!byKind[r.kind]) return; const key = `${r.record_id || r.identifier}`; if (!byKind[r.kind].some(x => `${x.record_id || x.identifier}` === key)) byKind[r.kind].push(r); };
  for (const [kind, list] of Object.entries(ids)) for (const r of await localById(kind, list)) add({ ...r, basis: 'identifier', score: 1 });
  if (title) for (const r of await localByTitle(title)) add({ ...r, basis: 'title' });
  if (online) {
    // a slow source is left out rather than holding up the screening (LIVE_MS for all the live look-ups together)
    const within = p => Promise.race([p.catch(() => []), new Promise(r => setTimeout(() => r([]), LIVE_MS).unref?.())]);
    const byId = Object.entries(ids).map(async ([kind, list]) => {
      const have = new Set(byKind[kind].filter(r => r.basis === 'identifier').map(r => idKey(r.identifier)));
      const rest = list.filter(i => !have.has(idKey(canon(kind, i))));
      return rest.length ? (await within(liveById(kind, rest))).map(r => ({ ...r, basis: 'identifier', score: r.missing ? 0 : 1 })) : [];
    });
    const [idRows, titleRows] = await Promise.all([Promise.all(byId), title ? within(liveByTitle(title)) : []]);
    for (const r of idRows.flat()) add(r);
    for (const r of titleRows) add({ ...r, basis: 'title' });
  }
  const datasets = Object.entries(KINDS).map(([key, k]) => ({
    key, label: k.label, identifiers: ids[key] || [],
    matches: byKind[key].sort((a, b) => (b.basis === 'identifier') - (a.basis === 'identifier') || (b.score || 0) - (a.score || 0)).slice(0, 15)
  }));
  const found = datasets.filter(d => d.matches.some(m => !m.missing));
  const missing = datasets.flatMap(d => d.matches.filter(m => m.missing).map(m => m.note));
  // what the editor should look at: a work already published, deposited or patented under nearly the same title (a
  // registered trial or a funded grant with the manuscript's title is expected; a preprint is a prior posting), and
  // identifiers their source does not know
  const flags = [];
  for (const d of datasets) {
    const k = KINDS[d.key];
    const prior = k.literature || d.key === 'thesis' || d.key === 'patent' ? d.matches.filter(m => !m.missing && title && titleScore(title, m.title) >= 0.9) : [];
    if (prior.length) flags.push({ severity: 'high', dataset: d.key, text: `${k.short}: a record with nearly the same title, “${clip(prior[0].title, 140)}”${prior[0].year ? ` (${prior[0].year})` : ''}; check for prior publication` });
    const pre = d.key === 'preprint' ? d.matches.filter(m => !m.missing && (m.basis === 'identifier' || m.score >= 0.9)) : [];
    if (pre.length) flags.push({ severity: 'low', dataset: d.key, text: `Posted as a preprint: “${clip(pre[0].title, 140)}”; check the preprint policy` });
  }
  for (const note of missing) flags.push({ severity: 'high', text: note });
  const n = Object.keys(KINDS).length;
  return {
    kind: 'research-records', title, identifiers: ids, datasets, online, flags, searched: n,
    level: flags.some(f => f.severity === 'high') ? 'bad' : flags.length ? 'warn' : 'ok',
    summary: `${found.length ? `Found in ${found.map(d => `${KINDS[d.key].short} (${d.matches.filter(m => !m.missing).length})`).join(', ')}` : `No matching record in the ${n} datasets`}${missing.length ? `; ${missing.length} identifier(s) not found at the source` : ''}.`
  };
}

module.exports = { KINDS, SOURCE_MAX, loadKind, importCsv, clearKind, status, check, identifiersIn, titleScore };
