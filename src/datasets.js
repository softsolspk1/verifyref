// datasets.js - local datasets: Retraction Watch, Beall's list (predatory + hijacked), uploaded journal lists
const db = require('./db');
const { getMeta, setMeta, transaction, bulkInsert } = db;
const { getText } = require('./http');
const { normalize, normalizeJournal, cleanIssn, cleanDoi } = require('./text');
const cfg = require('./config');

// ------------------------------------------------------------------ CSV

function detectDelimiter(headerLine) {
  const counts = [',', ';', '\t', '|'].map(d => [d, headerLine.split(d).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][0];
}

/** RFC-4180 CSV parser (quoted fields, embedded newlines). Returns array of row arrays. */
function parseCsv(text, delimiter) {
  text = String(text).replace(/^﻿/, '');
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
  const r = await getText(RW_URL, { ttl: 0, timeout: 180000, retries: 1 });
  if (!r.ok || !r.text) throw new Error(`Retraction Watch download failed (${r.status || r.error})`);
  const rows = csvToObjects(r.text);
  // One row per original DOI; a later notice (e.g. retraction after concern) wins
  const byDoi = new Map();
  for (const row of rows) {
    const doi = cleanDoi(row.OriginalPaperDOI);
    if (!doi) continue;
    const prev = byDoi.get(doi);
    if (prev && /retraction/i.test(prev[3]) && !/retraction/i.test(row.RetractionNature || '')) continue;
    byDoi.set(doi, [doi, cleanDoi(row.RetractionDOI) || '', (row.RetractionDate || '').split(' ')[0], row.RetractionNature || '',
      (row.Reason || '').replace(/;$/, '').replace(/^\+/, ''), row.Title || '', row.Journal || '', normalizeJournal(row.Journal || ''), (row.Author || '').slice(0, 2000)]);
  }
  const data = [...byDoi.values()];
  await transaction(async client => {
    await client.query('TRUNCATE retractions');
    await bulkInsert(client, 'retractions', ['doi', 'retraction_doi', 'retraction_date', 'nature', 'reason', 'title', 'journal', 'journal_norm', 'authors'].map(name => ({ name, type: 'text' })), data);
  });
  await setMeta('rw_loaded_at', new Date().toISOString());
  await setMeta('rw_count', data.length);
  await setMeta('rw_authors', '1');
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
  return db.all("SELECT doi, retraction_date, nature, reason, title, journal, authors FROM retractions WHERE authors ILIKE $1 AND nature ILIKE '%retraction%' LIMIT 200", [`%${family}%`]);
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
    const r = await getText(page.url, { ttl: 0, timeout: 60000 });
    if (!r.ok) throw new Error(`Beall's list download failed: ${page.url}`);
    const content = r.text.split(/<div class="entry-content/)[1] || r.text;
    for (const m of content.matchAll(/<li>\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)) {
      items.push({ kind: page.kind, name: decode(m[2]), url: m[1], genuine: null });
    }
  }
  const h = await getText('https://beallslist.net/hijacked-journals/', { ttl: 0, timeout: 60000 });
  if (h.ok) {
    for (const m of h.text.matchAll(/<tr><td><a href="([^"]+)"[^>]*>([^<]+)<\/a><\/td><td>(?:<a href="([^"]+)"[^>]*>)?([^<]*)/g)) {
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
async function predatoryMatches({ journal, publisher, homepage }) {
  const names = [journal, publisher].filter(Boolean).map(normalizeJournal);
  const dom = homepage ? domainOf(homepage) : null;
  if (!names.length && !dom) return [];
  const rows = await db.all('SELECT * FROM predatory WHERE name_norm = ANY($1::text[]) OR domain = $2', [names, dom]);
  const pubNorm = publisher ? normalizeJournal(publisher) : null;
  const jNorm = journal ? normalizeJournal(journal) : null;
  return rows
    .filter(r => r.domain === dom || r.name_norm === jNorm || (r.name_norm === pubNorm && r.kind === 'publisher'))
    .map(r => ({ ...r, matchedBy: r.domain && r.domain === dom ? 'website domain' : r.name_norm === jNorm ? 'journal name' : 'publisher name' }));
}

// ------------------------------------------------------------------ Uploaded journal lists

const LIST_TYPES = {
  sjr: 'SCImago Journal Rank (Scopus quartiles) — CSV export from scimagojr.com',
  scopus: 'Scopus Source List — CSV saved from Elsevier\'s source list workbook',
  wos_sjr: 'Web of Science-indexed journals — SCImago export with the "Only WoS Journals" filter (no index split)',
  wos_scie: 'Web of Science — Science Citation Index Expanded (SCIE) — MJL CSV',
  wos_ssci: 'Web of Science — Social Sciences Citation Index (SSCI) — MJL CSV',
  wos_ahci: 'Web of Science — Arts & Humanities Citation Index (AHCI) — MJL CSV',
  wos_esci: 'Web of Science — Emerging Sources Citation Index (ESCI) — MJL CSV',
  jcr: 'Journal Citation Reports (JIF quartiles) — CSV export',
  hjrs: 'HEC Journal Recognition System (HJRS) — W/X/Y categories CSV',
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
    `SELECT * FROM journal_list_entries WHERE issn = ANY($1::text[]) OR eissn = ANY($1::text[]) OR ($2::text IS NOT NULL AND title_norm = $2)`,
    [is, tn]);
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

async function listStatus() {
  const uploaded = Object.fromEntries((await db.all('SELECT * FROM journal_lists')).map(r => [r.list_type, r]));
  return {
    lists: Object.entries(LIST_TYPES).map(([type, label]) => ({ type, label, ...(uploaded[type] || {}) })),
    retractionWatch: { loadedAt: await getMeta('rw_loaded_at'), count: parseInt((await getMeta('rw_count')) || '0', 10) },
    beall: { loadedAt: await getMeta('beall_loaded_at'), count: parseInt((await getMeta('beall_count')) || '0', 10) }
  };
}

/** Load/refresh downloadable datasets when missing or older than maxAgeDays */
async function ensureDatasets({ force = false, maxAgeDays = 7, log = console.log } = {}) {
  const stale = async key => {
    const at = await getMeta(key);
    return force || !at || Date.now() - new Date(at).getTime() > maxAgeDays * 86400000;
  };
  const results = {};
  // v4 added author names: reload once if the stored copy predates that column
  const noAuthors = !force && (await getMeta('rw_authors')) !== '1';
  if (noAuthors || await stale('rw_loaded_at')) {
    try { results.retractionWatch = await loadRetractionWatch(); log(`Retraction Watch: ${results.retractionWatch} records loaded`); }
    catch (e) { results.retractionWatchError = e.message; log(`Retraction Watch load failed: ${e.message}`); }
  }
  if (await stale('beall_loaded_at')) {
    try { results.beall = await loadBeall(); log(`Beall's list: ${results.beall} entries loaded`); }
    catch (e) { results.beallError = e.message; log(`Beall's list load failed: ${e.message}`); }
  }
  return results;
}

module.exports = {
  parseCsv, csvToObjects, loadRetractionWatch, retractionFor, retractionsFor, retractionsByAuthor, journalRetractionCounts, loadBeall, predatoryMatches,
  importJournalList, listLookupAll, listEntries, listStatus, ensureDatasets, LIST_TYPES, domainOf
};
