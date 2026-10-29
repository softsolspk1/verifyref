// scripts/fetch-public-image-data.js - downloads the public metadata behind the Module 5 benchmark panel:
//  * Retraction Watch (Crossref) rows whose retraction reason names images/figures  -> data/public-images/retracted_image_cases.json
//  * Europe PMC open-access status (PMCID, licence) for those papers                  -> same file
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

(async () => {
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
  const cases = [...byDoi.values()];
  console.log(`${cases.length} papers with image-related retraction reasons`);

  // Europe PMC: which of them are open access (their figures can be downloaded from PMC)
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
  cases.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const summary = {
    fetchedAt: new Date().toISOString(), source: 'Retraction Watch database (Crossref) + Europe PMC', total: cases.length,
    openAccess: cases.filter(c => c.openAccess).length, byReason: {}, byYear: {}
  };
  for (const c of cases) { for (const r of c.reasons) summary.byReason[r] = (summary.byReason[r] || 0) + 1; const y = (c.date || '').slice(0, 4); if (y) summary.byYear[y] = (summary.byYear[y] || 0) + 1; }
  fs.writeFileSync(path.join(OUT, 'retracted_image_cases.json'), JSON.stringify({ summary, cases }));
  console.log(summary.total, 'cases;', summary.openAccess, 'open access with figures on PMC');
})().catch(e => { console.error(e); process.exit(1); });
