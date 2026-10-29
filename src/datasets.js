// datasets.js - local datasets: Retraction Watch, Beall's list, FDA Orange Book, uploaded journal lists
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const db = require('./db');
const { getMeta, setMeta, transaction, bulkInsert } = db;
const { getText, getBuffer, getJson } = require('./http');
const { normalize, normalizeJournal, cleanIssn, cleanDoi } = require('./text');
const cfg = require('./config');
const store = require('./datasetStore');

// ------------------------------------------------------------------ CSV

function detectDelimiter(headerLine) {
  const counts = [',', ';', '\t', '|'].map(d => [d, headerLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

/** RFC-4180 CSV parser (quoted fields, embedded newlines). Returns array of row arrays. */
function parseCsv(text, delimiter) {
  text = String(text).replace(/^\uFEFF/, '');
  const firstLine = text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : text.length);
  const d = delimiter || detectDelimiter(firstLine);
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === d) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim()));
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, (r[i] || '').trim()])));
}

// ------------------------------------------------------------------ Retraction Watch

const RW_URL = `https://api.labs.crossref.org/data/retractionwatch?mailto=${encodeURIComponent(cfg.CONTACT_EMAIL)}`;

async function loadRetractionWatch() {
  const rows = csvToObjects(await store.sourceText('retractionwatch.csv', () => getText(RW_URL, { ttl: 0, timeout: 600000, retries: 2 })));
  // One row per original DOI; a later notice (e.g. retraction after concern) wins
  const byDoi = new Map();
  for (const row of rows) {
    const doi = cleanDoi(row.OriginalPaperDOI);
    if (!doi) continue;
    const prev = byDoi.get(doi);
    if (prev && /retraction/i.test(prev[3]) && !/retraction/i.test(row.RetractionNature || '')) continue;
    byDoi.set(doi, [doi, cleanDoi(row.RetractionDOI) || '', (row.RetractionDate || '').split(' ')[0], row.RetractionNature || '',
      (row.Reason || '').replace(/;$/, '').replace(/^\+/, ''), row.Title || '', row.Journal || '', normalizeJournal(row.Journal || ''), (row.Author || '').slice(0, 2000), (row.Institution || '').slice(0, 1200), (row.Country || '').slice(0, 300)]);
  }
  const data = [...byDoi.values()];
  await transaction(async client => {
    await client.query('TRUNCATE retractions');
    await bulkInsert(client, 'retractions', ['doi', 'retraction_doi', 'retraction_date', 'nature', 'reason', 'title', 'journal', 'journal_norm', 'authors', 'institution', 'country'].map(name => ({ name, type: 'text' })), data);
  });
  await setMeta('rw_loaded_at', new Date().toISOString());
  await setMeta('rw_count', data.length);
  await setMeta('rw_authors', '2');
  return data.length;
}

async function retractionFor(doi) {
  if (!doi) return null;
  return db.one('SELECT * FROM retractions WHERE doi = $1', [doi.toLowerCase()]);
}

/** Batch lookup: returns Map(doi -> retraction row) */
async function retractionsFor(dois) {
  const list = [...new Set(dois.filter(Boolean).map(d => d.toLowerCase()))];
  if (!list.length) return new Map();
  const rows = await db.all('SELECT * FROM retractions WHERE doi = ANY($1::text[])', [list]);
  return new Map(rows.map(r => [r.doi, r]));
}

/** Retracted papers listing an author with this surname (candidates; exact matching is done by the caller) */
async function retractionsByAuthor(family) {
  if (!family || family.length < 3) return [];
  return db.all("SELECT doi, retraction_date, nature, reason, title, journal, authors, institution, country FROM retractions WHERE authors ILIKE $1 AND nature ILIKE '%retraction%' LIMIT 200", [`%${family}%`]);
}

async function journalRetractionCounts(journalName) {
  const rows = await db.all('SELECT nature, COUNT(*)::int AS n FROM retractions WHERE journal_norm = $1 GROUP BY nature', [normalizeJournal(journalName)]);
  const out = { retractions: 0, concerns: 0, corrections: 0 };
  for (const r of rows) {
    if (/retraction/i.test(r.nature)) out.retractions += r.n;
    else if (/concern/i.test(r.nature)) out.concerns += r.n;
    else out.corrections += r.n;
  }
  return out;
}

// ------------------------------------------------------------------ Problematic Paper Screener fingerprints

const PPS_URL = kind => `https://dbrech.irit.fr/pls/apex/f?p=9999:5::IR%5B${kind}%5D_CSV::::`;

/** '"a" AND "b"' -> ['a', 'b']; null when the expression uses OR / has no quoted term */
function ppsTerms(expr) {
  const rest = String(expr).replace(/"((?:[^"\\]|\\.)*)"/g, '');
  if (/\bOR\b/.test(rest)) return null;
  const terms = [...String(expr).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1').toLowerCase().replace(/\s+/g, ' ').trim()).filter(Boolean);
  return terms.length ? terms : null;
}

async function loadProblematicScreener() {
  const rows = [];
  for (const kind of ['tortured', 'scigen', 'suspect']) {
    const text = await store.sourceText(`pps-${kind}.csv`, () => getText(PPS_URL(kind), { ttl: 0, timeout: 120000, retries: 1 }));
    for (const row of parseCsv(text).slice(1)) {
      const terms = ppsTerms(row[0]);
      if (!terms) continue;
      rows.push([kind, JSON.stringify(terms), kind === 'scigen' ? '' : (row[1] || ''), parseInt(String(row[kind === 'scigen' ? 1 : 2] || '0').replace(/,/g, ''), 10) || 0]);
    }
  }
  if (rows.length < 1000) throw new Error('Problematic Paper Screener parse returned too few fingerprints');
  await transaction(async client => {
    await client.query('TRUNCATE pps_fingerprints');
    await bulkInsert(client, 'pps_fingerprints', [{ name: 'kind', type: 'text' }, { name: 'terms', type: 'text' }, { name: 'expected', type: 'text' }, { name: 'papers', type: 'int' }], rows);
  });
  ppsCache = null;
  await setMeta('pps_loaded_at', new Date().toISOString());
  await setMeta('pps_count', rows.length);
  return rows.length;
}

let ppsCache = null;
async function ppsFingerprints() {
  if (!ppsCache || Date.now() - ppsCache.at > 600000) {
    const rows = await db.all('SELECT kind, terms, expected, papers FROM pps_fingerprints');
    ppsCache = { at: Date.now(), list: rows.map(r => ({ kind: r.kind, terms: JSON.parse(r.terms), expected: r.expected, papers: r.papers })) };
  }
  return ppsCache.list;
}

// ------------------------------------------------------------------ Beall's list

const BEALL_PAGES = [
  { url: 'https://beallslist.net/', kind: 'publisher' },
  { url: 'https://beallslist.net/standalone-journals/', kind: 'journal' }
];

function domainOf(url) {
  try { return new URL(url.startsWith('http') ? url : `http://${url}`).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return null; }
}

const decode = s => String(s).replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’').replace(/&#8211;/g, '–').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();

async function loadBeall() {
  const items = [];
  for (const page of BEALL_PAGES) {
    const text = await store.sourceText(`beall-${page.kind}.html`, () => getText(page.url, { ttl: 0, timeout: 60000 }));
    const content = text.split(/<div class="entry-content/)[1] || text;
    for (const m of content.matchAll(/<li>\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
      items.push({ kind: page.kind, name: decode(m[2]), url: m[1], genuine: null });
    }
  }
  const hijacked = await store.sourceText('beall-hijacked.html', () => getText('https://beallslist.net/hijacked-journals/', { ttl: 0, timeout: 60000 })).catch(() => '');
  if (hijacked) {
    for (const m of hijacked.matchAll(/<tr><td><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/td><td>(?:<a href="([^"]+)"[^>]*>)?([^<]*)/g)) {
      items.push({ kind: 'hijacked', name: decode(m[2]), url: m[1], genuine: m[3] || null, genuineName: decode(m[4] || '') });
    }
  }
  if (items.length < 100) throw new Error('Beall\'s list parse returned too few entries');
  const rows = items.map(it => [it.kind, it.name, normalizeJournal(it.name), it.url, domainOf(it.url), it.genuine, 'beallslist.net']);
  await transaction(async client => {
    await client.query("DELETE FROM predatory WHERE source = 'beallslist.net'");
    await bulkInsert(client, 'predatory', ['kind', 'name', 'name_norm', 'url', 'domain', 'genuine_url', 'source'].map(name => ({ name, type: 'text' })), rows);
  });
  await setMeta('beall_loaded_at', new Date().toISOString());
  await setMeta('beall_count', items.length);
  return items.length;
}

/** Match a journal/publisher name or homepage against predatory & hijacked lists */
async function predatoryMatches({ journal, publisher, homepage, issns = [] }) {
  // a "journal" that normalises to nothing ("[(" from a web citation) must not match the list's empty names
  const names = [journal, publisher].filter(Boolean).map(normalizeJournal).filter(Boolean);
  const dom = homepage ? domainOf(homepage) : null;
  if (!names.length && !dom) return [];
  const rows = await db.all('SELECT * FROM predatory WHERE name_norm = ANY($1::text[]) OR domain = $2', [names, dom]);
  const pubNorm = publisher ? normalizeJournal(publisher) || null : null;
  const jNorm = journal ? normalizeJournal(journal) || null : null;
  const hits = rows
    .filter(r => r.domain === dom || r.name_norm === jNorm || (r.name_norm === pubNorm && r.kind === 'publisher'))
    .map(r => ({ ...r, matchedBy: r.domain && r.domain === dom ? 'website domain' : r.name_norm === jNorm ? 'journal name' : 'publisher name' }));
  // The Beall archive still names publishers and journals later cleared or now owned by the large publishers (MDPI was
  // removed in 2015; Dove Medical Press journals such as the International Journal of Nanomedicine are Taylor & Francis,
  // indexed in Scopus, Web of Science and MEDLINE): a journal on the major-publisher lists is not called predatory.
  // A hijacked clone of it still counts.
  if (hits.some(h => h.kind !== 'hijacked')) {
    const major = await publisherJournal({ issns, name: journal || '' }).catch(() => null);
    if (major) return hits.filter(h => h.kind === 'hijacked');
  }
  return hits;
}

// ------------------------------------------------------------------ Uploaded journal lists

const LIST_TYPES = {
  sjr: 'SCImago Journal Rank (Scopus quartiles) — CSV export from scimagojr.com',
  scopus: 'Scopus Source List — CSV saved from Elsevier\'s source list workbook',
  wos_sjr: 'Web of Science-indexed journals — SCImago export with the "Only WoS Journals" filter (no index split)',
  jcr: 'Journal Citation Reports (JIF quartiles) — CSV export',
  hjrs: 'HEC Journal Recognition System (HJRS) — W/X/Y categories CSV',
  ebsco: 'EBSCO database coverage (title lists, e.g. Academic Search Complete, CINAHL, Business Source) — CSV; combine several databases in one file with a "Database" column',
  hec_blacklist: 'HEC / institutional list of predatory or blacklisted journals — CSV',
  doaj_removed: 'Journals removed from DOAJ — CSV (optional)'
};

function findCol(headers, patterns) {
  for (const p of patterns) {
    const h = headers.find(x => p.test(x));
    if (h) return h;
  }
  return null;
}

async function importJournalList(listType, filename, csvText) {
  if (!LIST_TYPES[listType]) throw new Error('Unknown list type');
  const rows = csvToObjects(csvText);
  if (!rows.length) throw new Error('The CSV file has no rows');
  const headers = Object.keys(rows[0]);
  const titleCol = findCol(headers, [/^(journal|source)\s*title$/i, /^title$/i, /journal name/i, /title/i, /journal/i, /name/i]);
  const issnCol = findCol(headers, [/^(print\s*)?issn$/i, /^p-?issn/i, /^issn/i, /issn/i]);
  const eissnCol = findCol(headers, [/^e-?issn/i, /electronic/i, /online issn/i]);
  if (!titleCol && !issnCol) throw new Error(`Could not find a title or ISSN column. Columns: ${headers.join(', ')}`);

  const data = [];
  for (const row of rows) {
    // SJR packs both ISSNs into one field: "15424863, 00079235"
    const issnRaw = issnCol ? row[issnCol] : '';
    const issns = (issnRaw.match(/\d{4}-?\d{3}[\dxX]/g) || []).map(cleanIssn);
    const eissn = eissnCol && eissnCol !== issnCol ? cleanIssn(row[eissnCol]) : issns[1] || null;
    const title = titleCol ? row[titleCol] : '';
    if (!title && !issns.length && !eissn) continue;
    data.push([listType, issns[0] || null, eissn, title, normalizeJournal(title), JSON.stringify(row)]);
  }
  await store.put(`lists/${listType}.csv`, csvText, { source: `uploaded: ${filename}` }).catch(e => console.warn(`R2 copy of the ${listType} list failed: ${e.message}`));
  await transaction(async client => {
    await client.query('DELETE FROM journal_list_entries WHERE list_type = $1', [listType]);
    await bulkInsert(client, 'journal_list_entries', [
      { name: 'list_type', type: 'text' }, { name: 'issn', type: 'text' }, { name: 'eissn', type: 'text' },
      { name: 'title', type: 'text' }, { name: 'title_norm', type: 'text' }, { name: 'data', type: 'jsonb' }
    ], data, 2000);
    await client.query(`INSERT INTO journal_lists(list_type, filename, row_count, uploaded_at) VALUES($1, $2, $3, now())
      ON CONFLICT(list_type) DO UPDATE SET filename = EXCLUDED.filename, row_count = EXCLUDED.row_count, uploaded_at = EXCLUDED.uploaded_at`, [listType, filename, data.length]);
  });
  return data.length;
}

/**
 * Look a journal up in all uploaded lists at once (by any ISSN, then exact normalized title).
 * Returns { [list_type]: { ...row, matchedBy } }
 */
async function listLookupAll(issns = [], title = '') {
  const is = issns.map(cleanIssn).filter(Boolean);
  const tn = title ? normalizeJournal(title) : null;
  if (!is.length && !tn) return {};
  const rows = await db.all(
    `SELECT * FROM journal_list_entries WHERE list_type = ANY($3::text[]) AND (issn = ANY($1::text[]) OR eissn = ANY($1::text[]) OR ($2::text IS NOT NULL AND title_norm = $2))`,
    [is, tn, Object.keys(LIST_TYPES)]);
  const out = {};
  for (const r of rows) {
    const byIssn = is.includes(r.issn) || is.includes(r.eissn);
    const prev = out[r.list_type];
    if (!prev || (byIssn && prev.matchedBy !== 'ISSN')) out[r.list_type] = { ...r, matchedBy: byIssn ? 'ISSN' : 'title' };
  }
  return out;
}

/** Page through the rows of an uploaded list, optionally filtered by title or ISSN */
async function listEntries(listType, { q = '', page = 1, size = 50 } = {}) {
  size = Math.min(Math.max(parseInt(size, 10) || 50, 1), 200);
  page = Math.max(parseInt(page, 10) || 1, 1);
  const term = String(q).trim();
  const where = term ? 'AND (title_norm LIKE $2 OR title ILIKE $3 OR issn = $4 OR eissn = $4)' : '';
  const args = term ? [listType, `%${normalizeJournal(term)}%`, `%${term}%`, cleanIssn(term) || term] : [listType];
  const total = (await db.one(`SELECT COUNT(*)::int AS n FROM journal_list_entries WHERE list_type = $1 ${where}`, args)).n;
  const rows = await db.all(
    `SELECT title, issn, eissn, data FROM journal_list_entries WHERE list_type = $1 ${where} ORDER BY title_norm, issn LIMIT ${size} OFFSET ${(page - 1) * size}`, args);
  return { total, page, size, rows };
}

// ------------------------------------------------------------------ FDA Orange Book (Approved Drug Products)

const FDA_ORANGE_BOOK_URL = 'https://www.fda.gov/media/76860/download?attachment';
const LOCAL_ORANGE_BOOK = path.join(__dirname, '..', 'data', 'lists', 'orange_book.zip');

async function loadFdaOrangeBook({ buffer, filepath, log = console.log } = {}) {
  let zipBuf = buffer;
  if (!zipBuf && filepath && fs.existsSync(filepath)) {
    zipBuf = fs.readFileSync(filepath);
  }
  if (!zipBuf) {
    log('Downloading FDA Orange Book dataset from FDA…');
    zipBuf = await store.sourceBuffer('orange_book.zip', () => getBuffer(FDA_ORANGE_BOOK_URL, { timeout: 120000 }), { log });
    try {
      const dir = path.dirname(LOCAL_ORANGE_BOOK);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(LOCAL_ORANGE_BOOK, zipBuf);
    } catch (e) { /* non-fatal local cache write */ }
  }

  const zip = await JSZip.loadAsync(zipBuf);
  const pFile = zip.files['products.txt'] || zip.files['Products.txt'];
  if (!pFile) throw new Error('products.txt not found in FDA Orange Book archive');
  const text = await pFile.async('text');
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 100) throw new Error('FDA Orange Book products.txt has too few rows');

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('~');
    if (cols.length < 5) continue;
    const [
      ingredient = '',
      dfRoute = '',
      tradeName = '',
      applicant = '',
      strength = '',
      applType = '',
      applNo = '',
      productNo = '',
      teCode = '',
      approvalDate = '',
      rld = '',
      rs = '',
      type = '',
      applicantFullName = ''
    ] = cols;
    const ing = ingredient.trim();
    const trade = tradeName.trim();
    if (!ing && !trade) continue;
    rows.push([
      ing,
      normalize(ing),
      dfRoute.trim(),
      trade,
      normalize(trade),
      applicant.trim(),
      strength.trim(),
      applType.trim(),
      applNo.trim(),
      productNo.trim(),
      teCode.trim(),
      approvalDate.trim(),
      rld.trim(),
      rs.trim(),
      type.trim(),
      (applicantFullName || applicant).trim()
    ]);
  }

  await transaction(async client => {
    await client.query('TRUNCATE fda_orange_book');
    await bulkInsert(client, 'fda_orange_book', [
      { name: 'ingredient', type: 'text' },
      { name: 'ingredient_norm', type: 'text' },
      { name: 'dosage_form_route', type: 'text' },
      { name: 'trade_name', type: 'text' },
      { name: 'trade_name_norm', type: 'text' },
      { name: 'applicant', type: 'text' },
      { name: 'strength', type: 'text' },
      { name: 'appl_type', type: 'text' },
      { name: 'appl_no', type: 'text' },
      { name: 'product_no', type: 'text' },
      { name: 'te_code', type: 'text' },
      { name: 'approval_date', type: 'text' },
      { name: 'rld', type: 'text' },
      { name: 'rs', type: 'text' },
      { name: 'type', type: 'text' },
      { name: 'applicant_full_name', type: 'text' }
    ], rows, 2000);
  });

  await setMeta('fda_ob_loaded_at', new Date().toISOString());
  await setMeta('fda_ob_count', rows.length);
  return rows.length;
}

/** Search FDA Orange Book by ingredient, trade name, or application number */
async function fdaDrugLookup(term, { limit = 25 } = {}) {
  if (!term || typeof term !== 'string') return [];
  const clean = term.trim();
  if (clean.length < 2) return [];
  const norm = normalize(clean);
  const applMatch = clean.match(/\b(?:NDA|ANDA)?\s*(\d{5,7})\b/i);
  const applNo = applMatch ? applMatch[1] : null;

  const rows = await db.all(
    `SELECT * FROM fda_orange_book
     WHERE ingredient_norm = $1 OR trade_name_norm = $1
        OR ingredient_norm LIKE $2 OR trade_name_norm LIKE $2
        OR ($3::text IS NOT NULL AND appl_no = $3)
     ORDER BY (trade_name_norm = $1 OR ingredient_norm = $1) DESC,
              (trade_name_norm LIKE $4 OR ingredient_norm LIKE $4) DESC,
              approval_date DESC
     LIMIT $5`,
    [norm, `%${norm}%`, applNo, `${norm}%`, Math.min(limit, 100)]
  );
  return rows;
}

/** Validate whether a cited drug or pharmaceutical product matches an approved FDA record */
async function fdaValidateDrug({ name, ingredient, applNo }) {
  const normName = name ? normalize(name) : null;
  const normIng = ingredient ? normalize(ingredient) : null;
  const cleanAppl = applNo ? String(applNo).replace(/\D/g, '') : null;

  if (!normName && !normIng && !cleanAppl) return { verified: false, reason: 'No drug name, ingredient or application number provided' };

  const matches = await db.all(
    `SELECT * FROM fda_orange_book
     WHERE ($1::text IS NOT NULL AND (trade_name_norm = $1 OR ingredient_norm = $1))
        OR ($2::text IS NOT NULL AND (ingredient_norm = $2 OR trade_name_norm = $2))
        OR ($3::text IS NOT NULL AND appl_no = $3)
     LIMIT 10`,
    [normName, normIng, cleanAppl]
  );

  if (!matches.length) {
    return { verified: false, matches: [] };
  }

  const primary = matches[0];
  return {
    verified: true,
    matchedBy: cleanAppl && primary.appl_no === cleanAppl ? 'application_number' : (normName && (primary.trade_name_norm === normName || primary.ingredient_norm === normName)) ? 'brand_or_ingredient_name' : 'active_ingredient',
    product: {
      tradeName: primary.trade_name,
      ingredient: primary.ingredient,
      dosageFormRoute: primary.dosage_form_route,
      strength: primary.strength,
      applicant: primary.applicant_full_name || primary.applicant,
      applicationType: primary.appl_type === 'N' ? 'NDA (New Drug Application)' : 'ANDA (Abbreviated New Drug Application / Generic)',
      applicationNo: `${primary.appl_type === 'N' ? 'NDA' : 'ANDA'} ${primary.appl_no}`,
      approvalDate: primary.approval_date,
      teCode: primary.te_code || 'N/A',
      type: primary.type === 'RX' ? 'Prescription (Rx)' : primary.type === 'OTC' ? 'Over-the-Counter (OTC)' : primary.type,
      referenceListedDrug: primary.rld === 'Yes',
      referenceStandard: primary.rs === 'Yes'
    },
    totalMatches: matches.length,
    matches: matches.map(m => ({
      tradeName: m.trade_name,
      ingredient: m.ingredient,
      dosageFormRoute: m.dosage_form_route,
      strength: m.strength,
      applNo: `${m.appl_type} ${m.appl_no}`,
      approvalDate: m.approval_date,
      applicant: m.applicant
    }))
  };
}

// ------------------------------------------------------------------ NLM Catalog journal list (NCBI)

const NLM_ENTREZ_URL = 'https://ftp.ncbi.nlm.nih.gov/pubmed/J_Entrez.txt';
const NLM_PUBMED_URL = 'https://ftp.ncbi.nlm.nih.gov/pubmed/J_Medline.txt';

/** J_Entrez.txt / J_Medline.txt: "Field: value" records separated by dashed lines */
function parseNlmJournals(text) {
  const out = [];
  for (const block of String(text).split(/^-{10,}\s*$/m)) {
    const rec = {};
    for (const m of block.matchAll(/^([A-Za-z() ]+):[ \t]*(.*)$/gm)) rec[m[1].trim()] = m[2].trim();
    if (rec.NlmId && rec.JournalTitle) out.push(rec);
  }
  return out;
}

async function loadNlmCatalog() {
  const [all, pm] = await Promise.all([
    store.sourceText('nlm-J_Entrez.txt', () => getText(NLM_ENTREZ_URL, { ttl: 0, timeout: 300000, retries: 2 })),
    store.sourceText('nlm-J_Medline.txt', () => getText(NLM_PUBMED_URL, { ttl: 0, timeout: 300000, retries: 2 })).catch(() => '')
  ]);
  const pubmed = new Set(pm ? parseNlmJournals(pm).map(r => r.NlmId) : []);
  const byId = new Map();
  for (const r of parseNlmJournals(all)) {
    const abbr = r.IsoAbbr || r.MedAbbr || '';
    byId.set(r.NlmId, [r.NlmId, r.JournalTitle, normalizeJournal(r.JournalTitle), r.MedAbbr || '', r.IsoAbbr || '', abbr ? normalizeJournal(abbr) : '',
      cleanIssn(r['ISSN (Print)']) || null, cleanIssn(r['ISSN (Online)']) || null, pubmed.has(r.NlmId)]);
  }
  const rows = [...byId.values()];
  if (rows.length < 10000) throw new Error('NLM Catalog parse returned too few journals');
  await transaction(async client => {
    await client.query('TRUNCATE nlm_journals');
    await bulkInsert(client, 'nlm_journals', [...['nlm_id', 'title', 'title_norm', 'med_abbr', 'iso_abbr', 'abbr_norm', 'issn', 'eissn'].map(name => ({ name, type: 'text' })), { name: 'pubmed', type: 'boolean' }], rows);
  });
  nlmCache.clear();
  await setMeta('nlm_loaded_at', new Date().toISOString());
  await setMeta('nlm_count', rows.length);
  return rows.length;
}

/** ISO 4 abbreviation with full stops, as PJPS prints it: NLM's "Pak J Pharm Sci" + title -> "Pak. J. Pharm. Sci." */
function dottedAbbrev(abbr, title) {
  if (!abbr) return '';
  const full = new Set(normalize(title).split(' '));
  return abbr.split(/\s+/).map(w => /[.:,]$/.test(w) || full.has(normalize(w)) || !/^[A-Za-z]/.test(w) ? w : `${w}.`).join(' ');
}

const nlmCache = new Map();

/** Local NLM Catalog record for a journal, by ISSN first, then full title or abbreviation. null when not found */
async function nlmJournal({ issns = [], name = '' } = {}) {
  const is = issns.map(cleanIssn).filter(Boolean);
  const n = name ? normalizeJournal(name) : '';
  if (!is.length && !n) return null;
  const key = `${is.join(',')}|${n}`;
  if (nlmCache.has(key)) return nlmCache.get(key);
  let row = is.length ? await db.one('SELECT * FROM nlm_journals WHERE issn = ANY($1::text[]) OR eissn = ANY($1::text[]) LIMIT 1', [is]) : null;
  if (!row && n) {
    // several journals can share an abbreviation or title: only accept an unambiguous match
    const rows = await db.all('SELECT * FROM nlm_journals WHERE title_norm = $1 OR abbr_norm = $1 LIMIT 3', [n]);
    const exact = rows.filter(r => r.title_norm === n);
    row = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
  }
  const out = row ? {
    id: row.nlm_id, title: row.title, abbrev: row.med_abbr, isoAbbrev: dottedAbbrev(row.iso_abbr || row.med_abbr, row.title),
    issns: [row.issn, row.eissn].filter(Boolean), pubmed: row.pubmed, source: 'NLM Catalog (local copy)'
  } : null;
  if (nlmCache.size > 5000) nlmCache.delete(nlmCache.keys().next().value);
  nlmCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------ DOAJ journal list

const DOAJ_CSV_URL = 'https://doaj.org/csv';

async function loadDoaj() {
  const rows = csvToObjects(await store.sourceText('doaj.csv', () => getText(DOAJ_CSV_URL, { ttl: 0, timeout: 300000, retries: 2 })));
  const col = (row, re) => { const k = Object.keys(row).find(h => re.test(h)); return k ? row[k] : ''; };
  const data = [];
  for (const row of rows) {
    const title = col(row, /^journal title$/i);
    const issn = cleanIssn(col(row, /issn \(print/i)) || null;
    const eissn = cleanIssn(col(row, /eissn/i)) || null;
    if (!title || (!issn && !eissn)) continue;
    const apc = /^yes/i.test(col(row, /^apc$/i)) ? (col(row, /^apc amount$/i) || 'Yes') : 'No';
    data.push([issn, eissn, title, normalizeJournal(title), col(row, /^publisher$/i), col(row, /^country of publisher$/i), col(row, /^journal url$/i),
      apc, col(row, /^journal license$/i), col(row, /^review process$/i), parseInt(col(row, /average number of weeks/i), 10) || null, col(row, /^added on date$/i).slice(0, 10)]);
  }
  if (data.length < 5000) throw new Error('DOAJ parse returned too few journals');
  await transaction(async client => {
    await client.query('TRUNCATE doaj_journals');
    await bulkInsert(client, 'doaj_journals', [...['issn', 'eissn', 'title', 'title_norm', 'publisher', 'country', 'url', 'apc', 'license', 'review'].map(name => ({ name, type: 'text' })),
      { name: 'weeks', type: 'int' }, { name: 'added', type: 'text' }], data, 2000);
  });
  await setMeta('doaj_loaded_at', new Date().toISOString());
  await setMeta('doaj_count', data.length);
  return data.length;
}

/** Local DOAJ lookup by ISSN, same shape as journal.js doajLookup(); null when the local copy is not loaded */
async function doajLocal(issns = []) {
  if (!parseInt((await getMeta('doaj_count')) || '0', 10)) return null;
  const is = issns.map(cleanIssn).filter(Boolean);
  if (!is.length) return { inDoaj: false, source: 'DOAJ (local copy)' };
  const j = await db.one('SELECT * FROM doaj_journals WHERE issn = ANY($1::text[]) OR eissn = ANY($1::text[]) LIMIT 1', [is]);
  if (!j) return { inDoaj: false, source: 'DOAJ (local copy)' };
  return {
    inDoaj: true, title: j.title, publisher: j.publisher, country: j.country, apc: j.apc, review: j.review, weeksToPublication: j.weeks,
    license: j.license, url: j.url || null, since: j.added || null, source: 'DOAJ (local copy)'
  };
}

// ------------------------------------------------------------------ ISSN LTWA (ISO 4 title word abbreviations)

const LTWA_URL = 'https://www.issn.org/wp-content/uploads/2021/07/ltwa_20210702.csv';
const LTWA_LANGS = /\b(eng|mul|lat|und)\b/;
const plain = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');

async function loadLtwa() {
  const text = await store.sourceText('ltwa.csv', () => getText(LTWA_URL, { ttl: 0, timeout: 120000, retries: 2 }));
  const rows = [];
  for (const [word, abbr, langs = ''] of parseCsv(text, ';').slice(1)) {
    if (!word || !LTWA_LANGS.test(langs)) continue;
    const w = plain(word.trim().toLowerCase());
    const prefix = w.endsWith('-');
    rows.push([prefix ? w.slice(0, -1) : w, prefix, /^n\.\s*a\.?$/i.test(abbr.trim()) ? null : abbr.trim(), langs]);
  }
  if (rows.length < 5000) throw new Error('LTWA parse returned too few words');
  await transaction(async client => {
    await client.query('TRUNCATE ltwa_words');
    await bulkInsert(client, 'ltwa_words', [{ name: 'word', type: 'text' }, { name: 'prefix', type: 'boolean' }, { name: 'abbrev', type: 'text' }, { name: 'langs', type: 'text' }], rows);
  });
  ltwaCache = null;
  await setMeta('ltwa_loaded_at', new Date().toISOString());
  await setMeta('ltwa_count', rows.length);
  return rows.length;
}

let ltwaCache = null;
async function ltwaTable() {
  if (!ltwaCache) {
    const rows = await db.all('SELECT word, prefix, abbrev, langs FROM ltwa_words');
    const exact = new Map(), prefixes = new Map();
    const better = (a, b) => !a || (/eng/.test(b.langs) && !/eng/.test(a.langs));
    for (const r of rows) {
      const m = r.prefix ? prefixes : exact;
      if (better(m.get(r.word), r)) m.set(r.word, r);
    }
    ltwaCache = { exact, prefixes, size: rows.length };
  }
  return ltwaCache;
}

const LTWA_DROP = new Set(['of', 'the', 'and', '&', 'for', 'in', 'on', 'a', 'an', 'at', 'to', 'de', 'la', 'et', 'des', 'du', 'der', 'und']);

/** ISO 4 abbreviation of a full journal title from the ISSN LTWA; null when the list is not loaded or nothing changes */
async function ltwaAbbreviate(title) {
  const words = String(title || '').replace(/[,:;]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.some(w => /\.$/.test(w))) return null;   // single words are not abbreviated; already abbreviated
  const t = await ltwaTable();
  if (!t.size) return null;
  const out = [];
  for (const w of words) {
    const lw = plain(w.toLowerCase());
    if (LTWA_DROP.has(lw)) continue;
    let e = t.exact.get(lw);
    if (!e) for (let n = lw.length; n >= 3 && !e; n--) e = t.prefixes.get(lw.slice(0, n));
    let a = e?.abbrev || w;
    if (e?.abbrev && plain(a) !== a && plain(w) === w) a = plain(a);   // English word, French abbreviation row (méd. -> med.)
    out.push(a.charAt(0).toUpperCase() + a.slice(1));
  }
  const res = out.join(' ');
  return normalizeJournal(res) === normalizeJournal(title) ? null : res;
}

// ------------------------------------------------------------------ Crossref journal title list

const CROSSREF_TITLES_URL = 'http://ftp.crossref.org/titlelist/titleFile.csv';

async function loadCrossrefJournals() {
  const text = await store.sourceText('crossref-titleFile.csv', () => getText(CROSSREF_TITLES_URL, { ttl: 0, timeout: 600000, retries: 2 }));
  const rows = [];
  for (const o of csvToObjects(text)) {
    const title = (o.JournalTitle || '').replace(/[‎‏]/g, '').trim();
    if (!title) continue;
    rows.push([o.JournalID || null, title, normalizeJournal(title), o.Publisher || null, cleanIssn(o.pissn) || null, cleanIssn(o.eissn) || null, o.doi || null]);
  }
  if (rows.length < 50000) throw new Error('Crossref title list parse returned too few journals');
  await transaction(async client => {
    await client.query('TRUNCATE crossref_journals');
    await bulkInsert(client, 'crossref_journals', ['crossref_id', 'title', 'title_norm', 'publisher', 'issn', 'eissn', 'doi'].map(name => ({ name, type: 'text' })), rows);
  });
  await setMeta('crj_loaded_at', new Date().toISOString());
  await setMeta('crj_count', rows.length);
  return rows.length;
}

/** Crossref-registered journal by ISSN or exact (normalised) title; null when unknown or the list is not loaded */
async function crossrefJournal({ issns = [], name = '' } = {}) {
  const is = issns.map(cleanIssn).filter(Boolean);
  const n = name ? normalizeJournal(name) : '';
  if (!is.length && !n) return null;
  if (is.length) {
    const row = await db.one('SELECT * FROM crossref_journals WHERE issn = ANY($1::text[]) OR eissn = ANY($1::text[]) LIMIT 1', [is]);
    if (row) return row;
  }
  if (!n) return null;
  const rows = await db.all('SELECT * FROM crossref_journals WHERE title_norm = $1 LIMIT 2', [n]);
  return rows.length === 1 ? rows[0] : null;
}

// ------------------------------------------------------------------ OpenAlex journal list (Sources)

// ~220,000 journals at 200 per request. Paging past the first page needs a (free) OpenAlex API key. The list is fetched in
// six size bands at once, each with its own cursor; every page is stored in openalex_journals_stage together with its
// band's cursor, so a run that stops (time budget, timeout, error) resumes where it left off. Only a complete download
// replaces openalex_journals, so the previous copy stays in use meanwhile.
const OAJ_SELECT = 'id,issn_l,issn,display_name,host_organization_name,homepage_url,country_code,is_oa,is_in_doaj,apc_usd,works_count,cited_by_count,summary_stats,first_publication_year,last_publication_year,counts_by_year';
const OAJ_BANDS = ['works_count:0', 'works_count:1-20', 'works_count:21-100', 'works_count:101-400', 'works_count:401-1500', 'works_count:>1500'];
const OAJ_COLS = [
  ...['openalex_id', 'title', 'title_norm', 'issn_l', 'issns', 'publisher', 'homepage', 'country'].map(name => ({ name, type: 'text' })),
  { name: 'is_oa', type: 'boolean' }, { name: 'in_doaj', type: 'boolean' }, { name: 'apc_usd', type: 'int' }, { name: 'works', type: 'int' },
  { name: 'cited_by', type: 'bigint' }, { name: 'h_index', type: 'int' }, { name: 'mean_citedness', type: 'float8' },
  { name: 'first_year', type: 'int' }, { name: 'last_year', type: 'int' }, { name: 'works_by_year', type: 'jsonb' }
];

function openalexJournalRow(s) {
  const title = (s.display_name || '').trim();
  if (!s.id || !title) return null;
  const issns = [...new Set([s.issn_l, ...(s.issn || [])].map(cleanIssn).filter(Boolean))];
  const years = (s.counts_by_year || []).map(c => [c.year, c.works_count]).sort((a, b) => b[0] - a[0]).slice(0, 8);
  const st = s.summary_stats || {};
  return [s.id.replace('https://openalex.org/', ''), title, normalizeJournal(title), cleanIssn(s.issn_l) || null, issns.join(' ') || null,
    s.host_organization_name || null, s.homepage_url || null, s.country_code || null, s.is_oa ?? null, s.is_in_doaj ?? null,
    Number.isFinite(s.apc_usd) ? Math.round(s.apc_usd) : null, s.works_count ?? null, s.cited_by_count ?? null, st.h_index ?? null,
    Number.isFinite(st['2yr_mean_citedness']) ? st['2yr_mean_citedness'] : null, s.first_publication_year ?? null, s.last_publication_year ?? null,
    JSON.stringify(years)];
}

async function loadOpenAlexJournals({ budgetMs = Infinity, log = console.log } = {}) {
  if (!cfg.OPENALEX_API_KEY) throw new Error('an OpenAlex API key is needed to download the whole journal list - set OPENALEX_API_KEY (free at openalex.org/settings/api)');
  const started = Date.now();
  if (!(await getMeta('oaj_harvest'))) {
    await db.query('TRUNCATE openalex_journals_stage');
    for (let i = 0; i < OAJ_BANDS.length; i++) await setMeta(`oaj_band_${i}`, JSON.stringify({ cursor: '*', done: false }));
    await setMeta('oaj_harvest', new Date().toISOString());
  }
  const bands = await Promise.all(OAJ_BANDS.map(async (filter, i) => ({ i, filter, ...JSON.parse((await getMeta(`oaj_band_${i}`)) || '{"cursor":"*","done":false}') })));
  // pages are fetched in parallel, written one at a time (the embedded database has a single connection)
  let writes = Promise.resolve();
  const write = fn => (writes = writes.then(fn));
  await Promise.all(bands.map(async band => {
    while (!band.done && Date.now() - started < budgetMs) {
      const url = `https://api.openalex.org/sources?filter=type:journal,${band.filter}&per-page=200&select=${OAJ_SELECT}&cursor=${encodeURIComponent(band.cursor)}&api_key=${encodeURIComponent(cfg.OPENALEX_API_KEY)}`;
      const r = await getJson(url, { ttl: 0, timeout: 60000, retries: 3 });
      if (!r.ok) throw new Error(`OpenAlex answered ${r.status || r.error}${r.data?.message ? `: ${r.data.message}` : ''}`);
      const rows = (r.data.results || []).map(openalexJournalRow).filter(Boolean);
      const next = r.data.meta?.next_cursor || null;
      await write(() => transaction(async client => {
        if (rows.length) await bulkInsert(client, 'openalex_journals_stage', OAJ_COLS, rows);
        await client.query('INSERT INTO meta(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value',
          [`oaj_band_${band.i}`, JSON.stringify({ cursor: next, done: !next || !rows.length })]);
      }));
      band.cursor = next;
      band.done = !next || !rows.length;
    }
  }));
  await writes;
  const staged = (await db.one('SELECT COUNT(*)::int AS n FROM openalex_journals_stage')).n;
  if (!bands.every(b => b.done)) {
    log(`OpenAlex journal list: ${staged.toLocaleString()} journals downloaded so far, continuing on the next run`);
    return `${staged} so far (in progress)`;
  }
  if (staged < 100000) throw new Error(`OpenAlex journal list download returned too few journals (${staged})`);
  // a journal whose size changed during the download can appear in two bands: keep one row per journal
  await transaction(async client => {
    await client.query('TRUNCATE openalex_journals');
    await client.query('INSERT INTO openalex_journals SELECT DISTINCT ON (openalex_id) * FROM openalex_journals_stage ORDER BY openalex_id, works DESC NULLS LAST');
    await client.query('TRUNCATE openalex_journals_stage');
    await client.query("DELETE FROM meta WHERE key = 'oaj_harvest' OR key LIKE 'oaj_band_%'");
  });
  const count = (await db.one('SELECT COUNT(*)::int AS n FROM openalex_journals')).n;
  await setMeta('oaj_loaded_at', new Date().toISOString());
  await setMeta('oaj_count', count);
  return count;
}

/** Dataset status, with the progress of a download that is still running */
async function openalexJournalStatus() {
  const harvest = await getMeta('oaj_harvest');
  return {
    loadedAt: await getMeta('oaj_loaded_at'), count: parseInt((await getMeta('oaj_count')) || '0', 10), keyConfigured: !!cfg.OPENALEX_API_KEY,
    downloading: harvest ? { since: harvest, journals: (await db.one('SELECT COUNT(*)::int AS n FROM openalex_journals_stage')).n } : null
  };
}

/** A stored journal in the shape of an OpenAlex source record, so callers can use it in place of a live one */
function asOpenAlexSource(r) {
  return {
    id: `https://openalex.org/${r.openalex_id}`, display_name: r.title, type: 'journal', issn_l: r.issn_l, issn: (r.issns || '').split(' ').filter(Boolean),
    host_organization_name: r.publisher, homepage_url: r.homepage, country_code: r.country, is_oa: r.is_oa, is_in_doaj: r.in_doaj, apc_usd: r.apc_usd,
    works_count: r.works, cited_by_count: r.cited_by == null ? null : Number(r.cited_by), summary_stats: { h_index: r.h_index, '2yr_mean_citedness': r.mean_citedness },
    first_publication_year: r.first_year, last_publication_year: r.last_year,
    counts_by_year: (typeof r.works_by_year === 'string' ? JSON.parse(r.works_by_year) : r.works_by_year || []).map(([year, works]) => ({ year, works_count: works })),
    localCopy: true
  };
}

/** Journal from the local OpenAlex list by any ISSN or exact (normalised) title; null when unknown or not loaded */
async function openalexJournal({ issns = [], name = '' } = {}) {
  const is = issns.map(cleanIssn).filter(Boolean);
  if (is.length) {
    const row = await db.one("SELECT * FROM openalex_journals WHERE issn_l = ANY($1::text[]) OR string_to_array(issns, ' ') && $1::text[] ORDER BY works DESC NULLS LAST LIMIT 1", [is]);
    if (row) return asOpenAlexSource(row);
  }
  if (!name) return null;
  const rows = await db.all('SELECT * FROM openalex_journals WHERE title_norm = $1 ORDER BY works DESC NULLS LAST LIMIT 2', [normalizeJournal(name)]);
  return rows.length === 1 ? asOpenAlexSource(rows[0]) : null;
}

// ------------------------------------------------------------------ journal lists of the major publishers

// OpenAlex publisher ids (the hierarchy includes imprints: Cell Press under Elsevier, Routledge under Taylor & Francis,
// Lippincott and Medknow under Wolters Kluwer Health) and the Crossref publisher names that complete the list
const PUBLISHERS = [
  { key: 'elsevier', name: 'Elsevier', ids: ['P4310320990'], crossref: /elsevier|cell press|academic press|pergamon|w\.?b\.? saunders|mosby|churchill livingstone/i },
  { key: 'springer', name: 'Springer Nature', ids: ['P4310319965'], crossref: /springer|nature publishing|nature portfolio|biomed central|\bbmc\b|palgrave|\badis\b/i },
  { key: 'wiley', name: 'Wiley (John Wiley & Sons)', ids: ['P4310320595'], crossref: /wiley|blackwell|hindawi/i },
  { key: 'tandf', name: 'Taylor & Francis', ids: ['P4310320547'], crossref: /taylor\s*(?:&|and)\s*francis|informa|routledge|crc press|dove medical/i },
  { key: 'sage', name: 'SAGE Publications', ids: ['P4310320017'], crossref: /\bsage\b/i },
  { key: 'mdpi', name: 'MDPI AG', ids: ['P4310310987'], crossref: /\bmdpi\b|multidisciplinary digital publishing/i },
  { key: 'oup', name: 'Oxford University Press', ids: ['P4310311648'], crossref: /oxford university press/i },
  { key: 'cup', name: 'Cambridge University Press', ids: ['P4310311721'], crossref: /cambridge university press/i },
  { key: 'wkh', name: 'Wolters Kluwer Health', ids: ['P4310315860', 'P4310315671', 'P4310320448'], crossref: /wolters kluwer|lippincott|ovid technologies|medknow/i },
  { key: 'acs', name: 'American Chemical Society (ACS) Publications', ids: ['P4310320006'], crossref: /american chemical society/i },
  { key: 'ieee', name: 'Institute of Electrical and Electronics Engineers (IEEE)', ids: ['P4310319808', 'P4322697011'], crossref: /\bieee\b|institute of electrical and electronics engineers/i }
];
const PUBJ_COLS = ['publisher_key', 'publisher', 'imprint', 'title', 'title_norm', 'issns', 'openalex_id', 'homepage', 'works', 'source']
  .map(name => ({ name, type: name === 'works' ? 'int' : 'text' }));

/** About 21,000 journals from OpenAlex (~110 requests) plus the Crossref title-list rows not already covered (from the stored copy) */
async function loadPublisherJournals({ log = console.log } = {}) {
  const key = cfg.OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(cfg.OPENALEX_API_KEY)}` : '';
  const rows = [];
  const seen = new Set(); // every ISSN already listed
  for (const p of PUBLISHERS) {
    let cursor = '*', n = 0;
    while (cursor) {
      const url = `https://api.openalex.org/sources?filter=type:journal,host_organization_lineage:${p.ids.join('|')}&per-page=200&select=id,display_name,issn_l,issn,host_organization_name,homepage_url,works_count&cursor=${encodeURIComponent(cursor)}${key}`;
      const r = await getJson(url, { ttl: 0, timeout: 60000, retries: 3 });
      if (!r.ok) throw new Error(`OpenAlex answered ${r.status || r.error} for ${p.name}`);
      for (const s of r.data.results || []) {
        const title = (s.display_name || '').trim();
        if (!title) continue;
        const issns = [...new Set([s.issn_l, ...(s.issn || [])].map(cleanIssn).filter(Boolean))];
        issns.forEach(i => seen.add(i));
        rows.push([p.key, p.name, s.host_organization_name || null, title, normalizeJournal(title), issns.join(' ') || null, s.id.replace('https://openalex.org/', ''), s.homepage_url || null, s.works_count ?? null, 'openalex']);
        n++;
      }
      cursor = (r.data.results || []).length ? r.data.meta?.next_cursor || null : null;
    }
    log(`${p.name}: ${n} journals in OpenAlex`);
  }
  if (rows.length < 10000) throw new Error(`publisher journal lists returned too few journals (${rows.length})`);
  // Crossref title list: journals of the same publishers that OpenAlex files elsewhere or does not have
  const cr = await db.all('SELECT title, title_norm, publisher, issn, eissn FROM crossref_journals WHERE publisher IS NOT NULL');
  let added = 0;
  for (const c of cr) {
    const p = PUBLISHERS.find(x => x.crossref.test(c.publisher));
    if (!p) continue;
    const issns = [c.issn, c.eissn].map(cleanIssn).filter(Boolean);
    if (!issns.length || issns.some(i => seen.has(i))) continue;
    issns.forEach(i => seen.add(i));
    rows.push([p.key, p.name, c.publisher, c.title, c.title_norm, issns.join(' '), null, null, null, 'crossref']);
    added++;
  }
  log(`Crossref title list: ${added} more journals`);
  await transaction(async client => {
    await client.query('TRUNCATE publisher_journals');
    await bulkInsert(client, 'publisher_journals', PUBJ_COLS, rows);
  });
  const byPublisher = Object.fromEntries(PUBLISHERS.map(p => [p.key, rows.filter(r => r[0] === p.key).length]));
  await setMeta('pubj_loaded_at', new Date().toISOString());
  await setMeta('pubj_count', rows.length);
  await setMeta('pubj_by_publisher', JSON.stringify(byPublisher));
  return rows.length;
}

/** The major publisher of a journal by any ISSN or exact (normalised) title: { key, publisher, imprint, title, issns } or null */
async function publisherJournal({ issns = [], name = '' } = {}) {
  const is = issns.map(cleanIssn).filter(Boolean);
  const shape = r => r && { key: r.publisher_key, publisher: r.publisher, imprint: r.imprint, title: r.title, issns: (r.issns || '').split(' ').filter(Boolean), homepage: r.homepage, source: r.source };
  if (is.length) {
    const row = await db.one("SELECT * FROM publisher_journals WHERE string_to_array(issns, ' ') && $1::text[] ORDER BY works DESC NULLS LAST LIMIT 1", [is]);
    if (row) return shape(row);
  }
  if (name) {
    const rows = await db.all('SELECT * FROM publisher_journals WHERE title_norm = $1 ORDER BY works DESC NULLS LAST LIMIT 3', [normalizeJournal(name)]);
    // one title can exist at two publishers (a journal that moved): answer only when they agree
    if (rows.length && rows.every(r => r.publisher_key === rows[0].publisher_key)) return shape(rows[0]);
  }
  // not in the lists (or the lists are not loaded yet): the publisher recorded in the OpenAlex journal list
  const oa = await openalexJournal({ issns: is, name }).catch(() => null);
  const p = oa?.host_organization_name ? PUBLISHERS.find(x => x.crossref.test(oa.host_organization_name)) : null;
  return p ? { key: p.key, publisher: p.name, imprint: oa.host_organization_name, title: oa.display_name, issns: oa.issn || [], homepage: oa.homepage_url || null, source: 'openalex-journal-list' } : null;
}

async function publisherJournalStatus() {
  const by = JSON.parse((await getMeta('pubj_by_publisher')) || '{}');
  return {
    loadedAt: await getMeta('pubj_loaded_at'), count: parseInt((await getMeta('pubj_count')) || '0', 10),
    publishers: PUBLISHERS.map(p => ({ key: p.key, name: p.name, count: by[p.key] || 0 }))
  };
}

// ------------------------------------------------------------------ read-only browsing of the stored datasets (Admin > Data, View)

// Columns shown and searched for each dataset table (fixed lists: table and column names never come from the request)
const DATASET_VIEWS = {
  retractions: { label: 'Retraction Watch', cols: ['doi', 'title', 'journal', 'nature', 'retraction_date', 'reason', 'country'], search: ['title', 'journal', 'doi', 'authors'], order: 'retraction_date DESC NULLS LAST' },
  predatory: { label: "Beall's list", cols: ['kind', 'name', 'url', 'genuine_url', 'source'], search: ['name', 'url', 'domain'], order: 'kind, name_norm' },
  pps_fingerprints: { label: 'Problematic Paper Screener', cols: ['kind', 'terms', 'expected', 'papers'], search: ['terms', 'expected'], order: 'papers DESC NULLS LAST' },
  fda_orange_book: { label: 'FDA Orange Book', cols: ['ingredient', 'trade_name', 'dosage_form_route', 'strength', 'applicant', 'appl_type', 'appl_no', 'approval_date', 'te_code'], search: ['ingredient', 'trade_name', 'applicant', 'appl_no'], order: 'ingredient_norm, trade_name_norm' },
  nlm_journals: { label: 'NLM Catalog', cols: ['title', 'med_abbr', 'iso_abbr', 'issn', 'eissn', 'nlm_id', 'pubmed'], search: ['title', 'med_abbr', 'iso_abbr', 'issn', 'eissn'], order: 'title_norm' },
  doaj_journals: { label: 'DOAJ', cols: ['title', 'publisher', 'country', 'issn', 'eissn', 'apc', 'license', 'review'], search: ['title', 'publisher', 'issn', 'eissn'], order: 'title_norm' },
  ltwa_words: { label: 'ISSN LTWA', cols: ['word', 'abbrev', 'langs', 'prefix'], search: ['word', 'abbrev'], order: 'word' },
  crossref_journals: { label: 'Crossref journal title list', cols: ['title', 'publisher', 'issn', 'eissn', 'doi'], search: ['title', 'publisher', 'issn', 'eissn'], order: 'title_norm' },
  openalex_journals: { label: 'OpenAlex journal list', cols: ['title', 'publisher', 'issns', 'country', 'works', 'h_index', 'is_oa', 'in_doaj', 'first_year', 'last_year'], search: ['title', 'publisher', 'issns'], order: 'works DESC NULLS LAST' },
  publisher_journals: { label: 'Major publisher journal lists', cols: ['title', 'publisher', 'imprint', 'issns', 'works', 'source', 'homepage'], search: ['title', 'imprint', 'issns'], order: 'works DESC NULLS LAST, title_norm' },
  email_domains: { label: 'E-mail domain lists', cols: ['domain', 'kind'], search: ['domain'], order: 'kind, domain' }
};

/** One page of a dataset table: { label, cols, rows, total, page, size }; publisher_journals can be narrowed to one publisher */
async function datasetRows(name, { q = '', page = 1, size = 50, publisher = '' } = {}) {
  const v = DATASET_VIEWS[name];
  if (!v) return null;
  size = Math.min(Math.max(parseInt(size, 10) || 50, 1), 200);
  page = Math.max(parseInt(page, 10) || 1, 1);
  const args = [], where = [];
  if (name === 'publisher_journals' && publisher) { args.push(publisher); where.push(`publisher_key = $${args.length}`); }
  const term = String(q || '').trim().slice(0, 200);
  if (term) { args.push(`%${term}%`); where.push(`(${v.search.map(c => `${c}::text ILIKE $${args.length}`).join(' OR ')})`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.one(`SELECT COUNT(*)::int AS n FROM ${name} ${w}`, args)).n;
  const rows = await db.all(`SELECT ${v.cols.join(', ')} FROM ${name} ${w} ORDER BY ${v.order} LIMIT ${size} OFFSET ${(page - 1) * size}`, args);
  const pub = name === 'publisher_journals' && publisher ? PUBLISHERS.find(p => p.key === publisher) : null;
  return { label: pub ? pub.name : v.label, cols: v.cols, rows, total, page, size };
}

// ------------------------------------------------------------------ free-mail and disposable e-mail domains

const FREEMAIL_URL = 'https://raw.githubusercontent.com/Kikobeats/free-email-domains/master/domains.json';
const DISPOSABLE_URL = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';
// Never treat academic or government domains as free-mail, whatever a third-party list says
const INSTITUTIONAL = /(?:^|\.)(?:edu|ac|gov|gob|govt|mil|nhs|res)(?:\.[a-z]{2})?$|\.edu\.[a-z]{2}$/;

async function loadEmailDomains() {
  const [f, d] = await Promise.all([
    store.sourceText('email-freemail.json', () => getText(FREEMAIL_URL, { ttl: 0, timeout: 120000, retries: 2 })).catch(() => ''),
    store.sourceText('email-disposable.conf', () => getText(DISPOSABLE_URL, { ttl: 0, timeout: 120000, retries: 2 })).catch(() => '')
  ]);
  if (!f && !d) throw new Error('E-mail domain lists download failed');
  const kind = new Map();
  if (f) { try { for (const x of JSON.parse(f)) kind.set(String(x).trim().toLowerCase(), 'freemail'); } catch (e) { /* fall through to the size check */ } }
  if (d) for (const x of d.split(/\r?\n/)) { const dom = x.trim().toLowerCase(); if (dom && !dom.startsWith('#')) kind.set(dom, 'disposable'); }
  const rows = [...kind].filter(([dom]) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom) && !INSTITUTIONAL.test(dom));
  if (rows.length < 1000) throw new Error('E-mail domain lists parse returned too few domains');
  await transaction(async client => {
    await client.query('TRUNCATE email_domains');
    await bulkInsert(client, 'email_domains', [{ name: 'domain', type: 'text' }, { name: 'kind', type: 'text' }], rows);
  });
  emailDomainCache = null;
  await setMeta('maildom_loaded_at', new Date().toISOString());
  await setMeta('maildom_count', rows.length);
  return rows.length;
}

let emailDomainCache = null;
/** Load the domain lists into memory so the synchronous checks (isFreeMail / isDisposableMail) can use them */
async function warmEmailDomains() {
  if (emailDomainCache && Date.now() - emailDomainCache.at < 3600000) return emailDomainCache;
  try {
    const rows = await db.all('SELECT domain, kind FROM email_domains');
    emailDomainCache = { at: Date.now(), map: new Map(rows.map(r => [r.domain, r.kind])) };
  } catch (e) { emailDomainCache = { at: Date.now(), map: new Map() }; }
  return emailDomainCache;
}
/** 'freemail' | 'disposable' | null for an address or domain, from the loaded lists (call warmEmailDomains first) */
function emailDomainKind(emailOrDomain) {
  const dom = String(emailOrDomain || '').toLowerCase().split('@').pop().trim();
  if (!dom || !emailDomainCache) return null;
  return emailDomainCache.map.get(dom) || null;
}

// ------------------------------------------------------------------ Cellosaurus (live, cached)

const CELLO_ROWS = 100;

/**
 * Cellosaurus record for a cell-line name: { found, accession, name, category, problematic }. found:false only when
 * both searches returned every candidate and none is named exactly; null when offline or the answer is uncertain.
 */
async function cellosaurusLookup(name) {
  const n = String(name || '').trim().replace(/"/g, '');
  if (n.length < 2) return null;
  // Derivatives list their parent as a synonym (dozens of "MCF-7 …" sublines) and spellings vary ("HepG2" is stored as
  // "Hep-G2"), so search identifiers, then synonyms, and accept only a name equal apart from case, spaces and hyphens
  const key = s => String(s || '').toLowerCase().replace(/[\s-]/g, '');
  const names = c => (c['name-list'] || []);
  let complete = true, c = null;
  for (const [field, exact] of [['id', nm => nm.type === 'identifier'], ['sy', () => true]]) {
    const r = await require('./http').getJson(`https://api.cellosaurus.org/search/cell-line?q=${encodeURIComponent(`${field}:"${n}"`)}&fields=id,sy,ac,ca,cc&format=json&rows=${CELLO_ROWS}`, { ttl: 30 * 86400, timeout: 20000, retries: 1 });
    if (!r.ok) return null;
    const list = r.data?.Cellosaurus?.['cell-line-list'] || [];
    if (list.length >= CELLO_ROWS) complete = false;
    c = list.find(x => names(x).some(nm => exact(nm) && key(nm.value) === key(n)));
    if (c) break;
  }
  if (!c) return complete ? { found: false, name: n } : null;
  const problem = (c['comment-list'] || []).find(x => x.category === 'Problematic cell line');
  return {
    found: true,
    name: (c['name-list'] || []).find(x => x.type === 'identifier')?.value || n,
    accession: (c['accession-list'] || []).find(x => x.type === 'primary')?.value || null,
    category: c.category || null,
    problematic: problem ? problem.value : null
  };
}

async function listStatus() {
  const allUploaded = await db.all('SELECT * FROM journal_lists');
  const uploaded = Object.fromEntries(allUploaded.map(r => [r.list_type, r]));
  return {
    lists: Object.entries(LIST_TYPES).map(([type, label]) => ({ type, label, ...(uploaded[type] || {}) })),
    retractionWatch: { loadedAt: await getMeta('rw_loaded_at'), count: parseInt((await getMeta('rw_count')) || '0', 10) },
    beall: { loadedAt: await getMeta('beall_loaded_at'), count: parseInt((await getMeta('beall_count')) || '0', 10) },
    screener: { loadedAt: await getMeta('pps_loaded_at'), count: parseInt((await getMeta('pps_count')) || '0', 10) },
    fdaOrangeBook: { loadedAt: await getMeta('fda_ob_loaded_at'), count: parseInt((await getMeta('fda_ob_count')) || '0', 10) },
    nlm: { loadedAt: await getMeta('nlm_loaded_at'), count: parseInt((await getMeta('nlm_count')) || '0', 10) },
    doaj: { loadedAt: await getMeta('doaj_loaded_at'), count: parseInt((await getMeta('doaj_count')) || '0', 10) },
    ltwa: { loadedAt: await getMeta('ltwa_loaded_at'), count: parseInt((await getMeta('ltwa_count')) || '0', 10) },
    crossrefJournals: { loadedAt: await getMeta('crj_loaded_at'), count: parseInt((await getMeta('crj_count')) || '0', 10) },
    openalexJournals: await openalexJournalStatus(),
    publisherJournals: await publisherJournalStatus(),
    emailDomains: { loadedAt: await getMeta('maildom_loaded_at'), count: parseInt((await getMeta('maildom_count')) || '0', 10) },
    iclac: { loadedAt: null, count: 581, builtIn: true }
  };
}

/** D20: state of the reference datasets, written into every report so an empty list never passes silently */
async function datasetHealth() {
  const rw = parseInt((await getMeta('rw_count')) || '0', 10);
  const beall = parseInt((await getMeta('beall_count')) || '0', 10);
  const pps = parseInt((await getMeta('pps_count')) || '0', 10);
  const fda = parseInt((await getMeta('fda_ob_count')) || '0', 10);
  const missing = [];
  if (!rw) missing.push('Retraction Watch (retracted papers are not being detected)');
  if (!beall) missing.push("Beall's predatory/hijacked list (predatory journals are not being detected)");
  if (!pps) missing.push('Problematic Paper Screener (tortured phrases are not being detected)');
  return {
    retractionWatch: { count: rw, loadedAt: await getMeta('rw_loaded_at') },
    beall: { count: beall, loadedAt: await getMeta('beall_loaded_at') },
    screener: { count: pps, loadedAt: await getMeta('pps_loaded_at') },
    fdaOrangeBook: { count: fda, loadedAt: await getMeta('fda_ob_loaded_at') },
    nlm: { count: parseInt((await getMeta('nlm_count')) || '0', 10), loadedAt: await getMeta('nlm_loaded_at') },
    doaj: { count: parseInt((await getMeta('doaj_count')) || '0', 10), loadedAt: await getMeta('doaj_loaded_at') },
    ltwa: { count: parseInt((await getMeta('ltwa_count')) || '0', 10), loadedAt: await getMeta('ltwa_loaded_at') },
    crossrefJournals: { count: parseInt((await getMeta('crj_count')) || '0', 10), loadedAt: await getMeta('crj_loaded_at') },
    openalexJournals: { count: parseInt((await getMeta('oaj_count')) || '0', 10), loadedAt: await getMeta('oaj_loaded_at') },
    publisherJournals: { count: parseInt((await getMeta('pubj_count')) || '0', 10), loadedAt: await getMeta('pubj_loaded_at') },
    emailDomains: { count: parseInt((await getMeta('maildom_count')) || '0', 10), loadedAt: await getMeta('maildom_loaded_at') },
    complete: !missing.length,
    warning: missing.length ? 'Reference datasets are still loading or failed to load: ' + missing.join('; ') + '. Results that depend on them may be incomplete - run the check again after the datasets have loaded (Admin > Data).' : null
  };
}

/**
 * Load/refresh downloadable datasets when missing or older than maxAgeDays. The stalest go first (by last load or last
 * attempt), and with budgetMs no new download starts once the budget is used: the Vercel cron refreshes a few per day
 * instead of timing out halfway through the list, and a source that keeps failing does not block the others.
 */
async function ensureDatasets({ force = false, maxAgeDays = 7, budgetMs = Infinity, log = console.log } = {}) {
  const started = Date.now();
  const time = async key => { const at = await getMeta(key); return at ? new Date(at).getTime() : 0; };
  const all = [
    ['rw', 'retractionWatch', 'Retraction Watch', loadRetractionWatch],
    ['pps', 'screener', 'Problematic Paper Screener', loadProblematicScreener],
    ['beall', 'beall', "Beall's list", loadBeall],
    ['fda_ob', 'fdaOrangeBook', 'FDA Orange Book', () => loadFdaOrangeBook({ log })],
    ['nlm', 'nlm', 'NLM Catalog', loadNlmCatalog],
    ['doaj', 'doaj', 'DOAJ', loadDoaj],
    ['ltwa', 'ltwa', 'ISSN LTWA', loadLtwa],
    ['crj', 'crj', 'Crossref journal list', loadCrossrefJournals],
    ['maildom', 'maildom', 'E-mail domain lists', loadEmailDomains],
    ['pubj', 'publisherJournals', 'Major publisher journal lists', () => loadPublisherJournals({ log }), 30],
    // monthly; a download in progress continues on every run with whatever time is left
    // (on Vercel at most 3 minutes per run, so a request never outlives the function time limit)
    ['oaj', 'openalexJournals', 'OpenAlex journal list', () => loadOpenAlexJournals({ budgetMs: Math.min(budgetMs - (Date.now() - started), process.env.VERCEL ? 180000 : Infinity), log }), 30]
  ];
  // v4 added author names: reload Retraction Watch once if the stored copy predates that column
  const noAuthors = !force && (await getMeta('rw_authors')) !== '2';
  const todo = [];
  for (const d of all) {
    const loaded = await time(`${d[0]}_loaded_at`);
    const inProgress = d[0] === 'oaj' && !!(await getMeta('oaj_harvest'));
    if (force || inProgress || !loaded || Date.now() - loaded > (d[4] || maxAgeDays) * 86400000 || (d[0] === 'rw' && noAuthors)) todo.push({ d, order: Math.max(loaded, await time(`${d[0]}_tried_at`)) });
  }
  todo.sort((a, b) => a.order - b.order);
  const results = {};
  for (const { d: [key, name, label, fn] } of todo) {
    if (Date.now() - started > budgetMs) { (results.deferred = results.deferred || []).push(label); continue; }
    await setMeta(`${key}_tried_at`, new Date().toISOString());
    try { results[name] = await fn(); log(`${label}: ${results[name]} rows loaded`); }
    catch (e) { results[`${name}Error`] = e.message; log(`${label} load failed: ${e.message}`); }
  }
  return results;
}

module.exports = {
  parseCsv, csvToObjects, loadRetractionWatch, retractionFor, retractionsFor, retractionsByAuthor, journalRetractionCounts, loadBeall, loadProblematicScreener, ppsFingerprints, predatoryMatches,
  loadFdaOrangeBook, fdaDrugLookup, fdaValidateDrug, loadNlmCatalog, parseNlmJournals, nlmJournal, dottedAbbrev, loadDoaj, doajLocal,
  loadLtwa, ltwaAbbreviate, loadCrossrefJournals, crossrefJournal, loadOpenAlexJournals, openalexJournal, loadPublisherJournals, publisherJournal, PUBLISHERS, datasetRows, DATASET_VIEWS, loadEmailDomains, warmEmailDomains, emailDomainKind, cellosaurusLookup,
  importJournalList, listLookupAll, listEntries, listStatus, ensureDatasets, datasetHealth, LIST_TYPES, domainOf
};
