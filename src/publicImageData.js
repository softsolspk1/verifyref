// publicImageData.js - Module 5 "Public reference data": the openly available datasets used for image-integrity
// research (PMC Open Access, RSIID, BINDER, BioFors, retraction collections, PubPeer, BBBC), what has been
// downloaded to this server, retracted papers with image problems (Retraction Watch + Europe PMC), and the engine
// benchmark made from the RSIID pristine images. Files are produced by scripts/fetch-public-image-data.js and
// scripts/benchmark-public-images.mjs and live in DATA_DIR/public-images.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { getText } = require('./http');

const DIR = path.join(cfg.DATA_DIR, 'public-images');
const file = (...p) => path.join(DIR, ...p);
const size = f => { try { return fs.statSync(f).size; } catch { return 0; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

let casesCache = null;
const loadCases = () => (casesCache ||= readJson(file('retracted_image_cases.json')) || { summary: null, cases: [] });

/** Verified sources (links checked October 2026). `local` = file that proves it has been downloaded here. */
function catalog() {
  const bench = readJson(file('benchmark_results.json'));
  const cases = loadCases();
  const rsiid = size(file('rsiid', 'artificial_forgery_src_data.zip'));
  return [
    { id: 'pmc_oa', name: 'PubMed Central Open Access subset', url: 'https://pmc.ncbi.nlm.nih.gov/tools/openftlist/', license: 'CC-BY / CC0 / CC-BY-NC (per article)', scale: 'Millions of full-text papers with their figures (the base of both ImageTwin and Proofig)',
      access: 'Europe PMC REST API (full-text XML with figure captions), NCBI E-utilities, bulk archives in the AWS bucket pmc-oa-opendata',
      status: cases.summary ? `Connected through Europe PMC: ${cases.summary.openAccess} open-access papers with image problems listed` : 'Not downloaded', use: 'Source of figures to compare against and of real-world positive cases (below). Figure files must be fetched through the bulk archives or the API; the full corpus is terabytes and is not stored here.' },
    { id: 'rsiid', name: 'RSIID — Recod.ai Scientific Image Integrity Dataset', url: 'https://zenodo.org/records/15095089', license: 'CC-BY 4.0', scale: '39,423 tampered figures made from 2,923 pristine CC images (train 26,496 / test 12,927)',
      access: 'Zenodo (train 37 GB + test 20 GB as 7z; pristine sources 430 MB; templates 86 MB). Generator code: github.com/phillipecardenuto/rsiil',
      status: rsiid ? `Pristine source images + templates downloaded (${Math.round((rsiid + size(file('rsiid', 'template.zip'))) / 1e6)} MB); the 57 GB tampered train/test sets are not stored` : 'Not downloaded', use: 'Pristine images are used to generate forgeries and measure the Module 5 engine (benchmark below).' },
    { id: 'binder', name: 'BINDER — Bio-Image Near-Duplicate Examples Repository', url: 'https://doi.org/10.7910/DVN/9YTD9Z', license: 'CC0 1.0', scale: '7,490 unique patches + 1,821 manipulated duplicates + 868 different-size pairs',
      access: 'Harvard Dataverse, 678 MB. Needs a guestbook form (name/e-mail) before download, so it cannot be fetched by script.', status: size(file('binder', 'BINDER_2020_7_9.zip')) > 1e6 ? 'Downloaded' : 'Manual download needed', use: 'Near-duplicate test set (rotation, translation, scale, perspective, contrast, compression). BINDER-style transforms are already tested in the benchmark below.' },
    { id: 'biofors', name: 'BioFors — biomedical image forensics', url: 'https://vimal.isi.edu/ekraam-2021-biofors', license: 'See authors (ICCV 2021)', scale: '47,805 panels from 1,031 papers: external duplication, internal duplication, cut/sharp transition',
      access: 'Request via the authors (USC ISI); no direct download link published.', status: 'Not downloaded', use: 'Real-world benchmark with expert ground truth, once obtained.' },
    { id: 'retractions', name: 'Retracted papers with image problems (SciInt-type collections)', url: 'https://api.labs.crossref.org/data/retractionwatch', license: 'Retraction Watch data via Crossref (CC0)', scale: cases.summary ? `${cases.summary.total} retractions, corrections and concerns that name images` : '—',
      access: 'Crossref Labs Retraction Watch download + Europe PMC open-access flags', status: cases.summary ? `Loaded ${cases.summary.fetchedAt.slice(0, 10)}` : 'Not downloaded', use: 'Real positive examples: look up a case, see its reasons and read the figure captions on Europe PMC.' },
    { id: 'pubpeer', name: 'PubPeer', url: 'https://pubpeer.com', license: 'Comments are user content', scale: 'Crowdsourced post-publication reports', access: 'No bulk download. Check single papers by DOI at pubpeer.com.', status: 'External check only', use: 'Independent validation of flagged papers.' },
    { id: 'bbbc', name: 'Broad Bioimage Benchmark Collection (BBBC) and other CC image repositories', url: 'https://bbbc.broadinstitute.org/', license: 'Mostly CC0 / CC-BY', scale: 'Dozens of annotated microscopy sets', access: 'Already inside the RSIID pristine set (e.g. BBBC038, CC0)', status: rsiid ? 'Included through RSIID' : 'Not downloaded', use: 'Pristine microscopy for forgery generation.' }
  ].map(d => ({ ...d, benchmarked: d.id === 'rsiid' ? !!bench : undefined }));
}

const text = (s, n) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function cases({ q = '', oa = false, reason = '', page = 1, per = 25 } = {}) {
  const { summary, cases: all } = loadCases();
  const k = String(q).toLowerCase().trim();
  const list = all.filter(c => (!oa || c.openAccess) && (!reason || c.reasons.includes(reason)) && (!k || `${c.title} ${c.journal} ${c.doi} ${c.country}`.toLowerCase().includes(k)));
  return { summary, total: list.length, page, per, cases: list.slice((page - 1) * per, page * per) };
}

/** Figure labels and captions of an open-access paper (Europe PMC full-text XML); images are viewed on the PMC page */
async function figures(pmcid) {
  if (!/^PMC\d{4,9}$/.test(pmcid)) throw new Error('Invalid PMCID');
  const r = await getText(`https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`, { ttl: 86400000, timeout: 30000, retries: 1 });
  if (!r.ok || !r.text) throw new Error('Full text not available from Europe PMC');
  const out = [];
  for (const m of r.text.matchAll(/<fig\b[^>]*>([\s\S]*?)<\/fig>/g)) {
    out.push({ label: text((m[1].match(/<label>([\s\S]*?)<\/label>/) || [])[1], 60), caption: text((m[1].match(/<caption>([\s\S]*?)<\/caption>/) || [])[1], 900), file: (m[1].match(/xlink:href="([^"]+)"/) || [])[1] || null });
  }
  return { pmcid, page: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`, figures: out };
}

const benchmark = () => readJson(file('benchmark_results.json'));

module.exports = { catalog, cases, figures, benchmark };
