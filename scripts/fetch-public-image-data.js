// scripts/fetch-public-image-data.js - downloads the public metadata behind the Module 5 benchmark panel:
//  * Retraction Watch (Crossref) rows whose retraction reason names images/figures  -> data/public-images/retracted_image_cases.json
//  * papers with image problems in published integrity audits (Bioengineered audit, Zenodo 15671466) -> same file
//  * Europe PMC open-access status (PMCID, licence) for those papers                  -> same file
// --flagged-only adds the audit papers to the existing file without reading Retraction Watch again.
// Large image archives (BINDER, RSIID) are downloaded separately with curl; see data/new/benchmarks/public_datasets.json.
const fs = require('fs');
const path = require('path');
const https = require('https');
const cfg = require('../src/config');
const { csvToObjects } = require('../src/datasets');

const OUT = path.join(cfg.DATA_DIR, 'public-images');
fs.mkdirSync(OUT, { recursive: true });

const get = (url, timeout = 600000) => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': `PJPS-ReferenceChecker (mailto:${cfg.CONTACT_EMAIL})` }, timeout }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(get(new URL(res.headers.location, url).toString(), timeout));
    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
    const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout ' + url)); });
});

const IMAGE_REASON = /image|photo|figure|western blot|gel|micrograph/i;
// Crossref gives M/D/YYYY
const isoDate = d => { const m = String(d || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : ''; };
const cleanDoi = d => String(d || '').trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '');

const getBuf = (url, timeout = 120000) => new Promise((resolve, reject) => {
  https.get(url, { headers: { 'User-Agent': `PJPS-ReferenceChecker (mailto:${cfg.CONTACT_EMAIL})` }, timeout }, res => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(getBuf(new URL(res.headers.location, url).toString(), timeout));
    if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
    const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c)));
  }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout ' + url)); });
});

const BIOENG_URL = 'https://zenodo.org/api/records/15671466/files/Bioengineered%20Supplementary%20Data.xlsx/content';
const AUDIT_IMAGE = /image|blot|panel|micrograph|photo|transwell|wound|colony|histolog|flow cytometr|dot plot|splic|duplicat|overlap/i;

/** Bioengineered audit papers with an image problem, not retracted: cases in the same shape as the Retraction Watch ones */
async function auditCases() {
  const X = require('../src/xlsx');
  const wb = await X.openWorkbook(await getBuf(BIOENG_URL));
  const yes = v => /^y(es)?$/i.test(String(v || '').trim());
  const overlap = ['Image overlap - within figure', 'Image overlap - between figure (within paper)', 'Image overlap - between papers'];
  return X.rowsToObjects(await wb.rows('Data'), r => r[0] === 'DOI')
    .filter(o => cleanDoi(o.DOI) && yes(o['Any major problem found? (y/n)']) && (yes(o['Any Image related issue?']) || overlap.some(k => String(o[k] || '').trim()) || AUDIT_IMAGE.test(o['Issue?'] || '')))
    .map(o => ({
      doi: cleanDoi(o.DOI), title: o.Title, journal: 'Bioengineered', subject: '', nature: 'Flagged in an integrity audit (not retracted)',
      date: String(o['Publication Year'] || '').slice(0, 4), reasons: [`Image problem found in the Bioengineered paper-mill audit: ${String(o['Issue?'] || 'image overlap').trim()}`], country: ''
    }));
}

/** Europe PMC: which papers are open access (their figures can be downloaded from PMC) */
async function addOpenAccess(cases) {
  const doiList = cases.map(c => c.doi);
  const oa = new Map();
  for (let i = 0; i < doiList.length; i += 20) {
    const q = doiList.slice(i, i + 20).map(d => `DOI:"${d}"`).join(' OR ');
    try {
      const j = JSON.parse(await get(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&pageSize=100&resultType=lite`, 60000));
      for (const r of j.resultList?.result || []) if (r.doi) oa.set(r.doi.toLowerCase(), { pmcid: r.pmcid || null, openAccess: r.isOpenAccess === 'Y' });
    } catch (e) { console.log('batch', i, e.message); }
    if (i % 400 === 0) console.log(`  Europe PMC ${Math.min(i + 20, doiList.length)}/${doiList.length}`);
  }
  for (const c of cases) Object.assign(c, oa.get(c.doi) || { pmcid: null, openAccess: false });
}

function save(cases) {
  cases.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const summary = {
    fetchedAt: new Date().toISOString(), source: 'Retraction Watch database (Crossref) + Bioengineered integrity audit (Zenodo 15671466) + Europe PMC', total: cases.length,
    openAccess: cases.filter(c => c.openAccess).length, byReason: {}, byYear: {}
  };
  for (const c of cases) { for (const r of c.reasons) summary.byReason[r] = (summary.byReason[r] || 0) + 1; const y = (c.date || '').slice(0, 4); if (y) summary.byYear[y] = (summary.byYear[y] || 0) + 1; }
  fs.writeFileSync(path.join(OUT, 'retracted_image_cases.json'), JSON.stringify({ summary, cases }));
  console.log(summary.total, 'cases;', summary.openAccess, 'open access with figures on PMC');
}

(async () => {
  const audit = await auditCases().catch(e => { console.log(`Bioengineered audit not read: ${e.message}`); return []; });
  console.log(`${audit.length} papers with image problems in the Bioengineered audit`);
  if (process.argv.includes('--flagged-only')) {
    const file = path.join(OUT, 'retracted_image_cases.json');
    const cases = JSON.parse(fs.readFileSync(file, 'utf8')).cases;
    const have = new Set(cases.map(c => c.doi));
    const add = audit.filter(c => !have.has(c.doi));
    await addOpenAccess(add);
    return save([...cases, ...add]);
  }
  const rwFile = path.join(OUT, 'retractionwatch.csv');
  let text;
  if (fs.existsSync(rwFile)) text = fs.readFileSync(rwFile, 'utf8');
  else { console.log('downloading Retraction Watch …'); text = await get(`https://api.labs.crossref.org/data/retractionwatch?mailto=${encodeURIComponent(cfg.CONTACT_EMAIL)}`); fs.writeFileSync(rwFile, text); }
  const rows = csvToObjects(text).filter(r => /retraction|correction|concern/i.test(r.RetractionNature || '') && IMAGE_REASON.test(r.Reason || '') && cleanDoi(r.OriginalPaperDOI));
  const byDoi = new Map();
  for (const r of rows) byDoi.set(cleanDoi(r.OriginalPaperDOI), {
    doi: cleanDoi(r.OriginalPaperDOI), title: r.Title, journal: r.Journal, subject: r.Subject, nature: r.RetractionNature,
    date: isoDate(r.RetractionDate), reasons: (r.Reason || '').split(';').map(x => x.replace(/^\+/, '').trim()).filter(x => IMAGE_REASON.test(x)), country: r.Country
  });
  console.log(`${byDoi.size} papers with image-related retraction reasons`);
  for (const c of audit) if (!byDoi.has(c.doi)) byDoi.set(c.doi, c);
  const cases = [...byDoi.values()];
  await addOpenAccess(cases);
  save(cases);
})().catch(e => { console.error(e); process.exit(1); });

