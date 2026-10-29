// scripts/download-ebsco.js - Download and compile EBSCO database title lists
// (CINAHL Complete, Academic Search Complete, Academic Search Premier, Business Source Complete)
// into data/lists/ebsco.csv and import into the database.
require('../src/config');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const D = require('../src/datasets');
const { getText } = require('../src/http');

const SOURCES = [
  { code: 'c8h', file: 'c8h-coverage.htm', name: 'CINAHL Complete' },
  { code: 'a9h', file: 'a9h-journals.htm', name: 'Academic Search Complete' },
  { code: 'aph', file: 'aph-journals.htm', name: 'Academic Search Premier' },
  { code: 'bth', file: 'bth-journals.htm', name: 'Business Source Complete' }
];

const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'lists', 'ebsco.csv');

function decodeHtml(html) {
  return String(html || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function cleanIssn(s) {
  const m = String(s || '').match(/\d{4}-?\d{3}[\dxX]/);
  return m ? m[0].replace('-', '').slice(0, 4) + '-' + m[0].replace('-', '').slice(4).toUpperCase() : '';
}

function escapeCsv(val) {
  const s = String(val == null ? '' : val).trim();
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function downloadAndCompileEbsco(log = console.log) {
  const journalsByIssn = new Map();
  const journalsByTitle = new Map();

  for (const src of SOURCES) {
    log(`Downloading title list for ${src.name}…`);
    const url = `https://www.ebsco.com/m/ee/Marketing/titleLists/${src.file}`;
    const r = await getText(url, { ttl: 0, timeout: 60000 });
    if (!r.ok || !r.text) {
      log(`Warning: Failed to fetch ${src.name} (${r.status || r.error})`);
      continue;
    }

    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trMatch;
    let headers = null;
    let count = 0;

    while ((trMatch = trRegex.exec(r.text)) !== null) {
      const trContent = trMatch[1];
      const cells = [...trContent.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map(m => decodeHtml(m[1]));
      if (!cells.length) continue;

      if (!headers) {
        headers = cells.map(h => h.toLowerCase());
        continue;
      }

      const row = {};
      headers.forEach((h, i) => { row[h] = cells[i] || ''; });

      const title = row['publication name'] || row['title'] || '';
      const rawIssn = row['issn / isbn'] || row['issn'] || '';
      const issn = cleanIssn(rawIssn);
      if (!title && !issn) continue;

      const key = issn || title.toLowerCase();
      const existing = journalsByIssn.get(key) || journalsByTitle.get(title.toLowerCase());

      const dbs = existing?.databases ? new Set(existing.databases) : new Set();
      dbs.add(src.name);

      const entry = {
        title: title || existing?.title,
        issn: issn || existing?.issn || '',
        databases: [...dbs],
        peerReviewed: row['peer-reviewed'] || existing?.peerReviewed || '',
        indexStart: row['indexing and abstracting start'] || existing?.indexStart || '',
        indexStop: row['indexing and abstracting stop'] || existing?.indexStop || '',
        fullTextStart: row['full text start'] || existing?.fullTextStart || '',
        fullTextStop: row['full text stop'] || existing?.fullTextStop || '',
        embargo: row['full text delay (months)'] || existing?.embargo || '',
        coverage: row['coverage policy'] || existing?.coverage || '',
        publisher: row['publisher'] || existing?.publisher || ''
      };

      if (issn) journalsByIssn.set(issn, entry);
      journalsByTitle.set(title.toLowerCase(), entry);
      count++;
    }
    log(`  ✓ Extracted ${count.toLocaleString()} rows from ${src.name}`);
  }

  const allEntries = [...new Set([...journalsByIssn.values(), ...journalsByTitle.values()])];
  log(`Total unique EBSCO journals compiled: ${allEntries.length.toLocaleString()}`);

  // Build CSV content
  const csvHeaders = [
    'Title', 'ISSN', 'Database', 'Peer-Reviewed',
    'Indexing and Abstracting Start', 'Indexing and Abstracting Stop',
    'Full Text Start', 'Full Text Stop', 'Full Text Delay (Months)',
    'Coverage Policy', 'Publisher'
  ];

  const lines = [csvHeaders.join(',')];
  for (const j of allEntries) {
    const row = [
      escapeCsv(j.title),
      escapeCsv(j.issn),
      escapeCsv(j.databases.join('; ')),
      escapeCsv(j.peerReviewed),
      escapeCsv(j.indexStart),
      escapeCsv(j.indexStop),
      escapeCsv(j.fullTextStart),
      escapeCsv(j.fullTextStop),
      escapeCsv(j.embargo),
      escapeCsv(j.coverage),
      escapeCsv(j.publisher)
    ];
    lines.push(row.join(','));
  }

  const csvContent = lines.join('\n');
  const dir = path.dirname(OUTPUT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, csvContent, 'utf8');
  log(`Saved CSV file: ${OUTPUT_FILE} (${(Buffer.byteLength(csvContent) / 1024 / 1024).toFixed(2)} MB)`);

  return { count: allEntries.length, csvContent };
}

(async () => {
  try {
    console.log('=== EBSCO Database Dataset Importer ===');
    await db.init();
    console.log('Database connected.');

    const start = Date.now();
    const { csvContent } = await downloadAndCompileEbsco(msg => console.log(`[EBSCO] ${msg}`));

    console.log('[EBSCO] Importing compiled title list into PostgreSQL…');
    const imported = await D.importJournalList('ebsco', 'ebsco.csv', csvContent);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`\nSuccess! ${imported.toLocaleString()} EBSCO journal records imported in ${elapsed}s.`);

    // Quick verification lookup
    const lookup = await D.listLookupAll(['0138-645X'], '16 de Abril');
    if (lookup.ebsco) {
      console.log('Sample lookup verified:');
      console.log(`  - Journal: ${lookup.ebsco.title} (${lookup.ebsco.issn})`);
      console.log(`  - EBSCO Data:`, lookup.ebsco.data);
    }

    process.exit(0);
  } catch (err) {
    console.error('EBSCO import failed:', err);
    process.exit(1);
  }
})();

module.exports = { downloadAndCompileEbsco };
