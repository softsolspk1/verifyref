// imageRefs.js - Module 5 image reference databases. Every figure panel of
//   pjps       published PJPS papers (PDFs from pjps.pk, found through the article pages' citation tags)
//   retracted  open-access papers retracted / corrected / given an expression of concern for image problems
//              (Retraction Watch reasons + Europe PMC; figures from PubMed Central)
//   pmc        open-access papers in pharmacy / pharmacology / medicinal plants from PubMed Central
//   reference  figures uploaded by the Super Admin (PJPS archive PDFs, known problem figures from other sources)
// is fingerprinted the same way as in the editor's browser (64-bit DCT hash, also of five 75% crop windows, chart data)
// and its thumbnail kept on Cloudflare R2. A new manuscript's panels are compared with all of them in every orientation
// (rotated, mirrored), as crops and as enlargements; each candidate is then verified pixel by pixel on the thumbnails.
const crypto = require('crypto');
const db = require('./db');
const R2 = require('./uploads');
const { USER_AGENT, getJson } = require('./http');
const { figuresOfFile, decodeImage, decodeAny } = require('./figureFiles');

const SOURCES = {
  pjps: { name: 'Published PJPS papers', short: 'PJPS published' },
  retracted: { name: 'Papers retracted, corrected or flagged in integrity audits for image problems (open access)', short: 'Retracted / flagged' },
  pmc: { name: 'PubMed Central open-access papers (pharmacy, pharmacology, medicinal plants; blots, histology, microscopy)', short: 'PubMed Central' },
  publisher: { name: 'Open-access papers of the major publishers (MDPI, Elsevier, Springer Nature / BMC, Wiley, Frontiers, PLOS, Taylor & Francis, SAGE, OUP, CUP, Wolters Kluwer, ACS, Dove, Hindawi)', short: 'Publisher open access' },
  rsiid: { name: 'RSIID — pristine scientific figures (Recod.ai, CC-BY; includes BBBC microscopy)', short: 'RSIID' },
  biofors: { name: 'BioFors — biomedical figure panels with expert duplication annotations (ICCV 2021)', short: 'BioFors' },
  binder: { name: 'BINDER — bio-image near-duplicate examples (Harvard Dataverse, CC0)', short: 'BINDER' },
  reference: { name: 'Reference figures uploaded by the editorial office', short: 'Reference library' }
};
const PJPS = 'https://pjps.pk';
const MAX_FIGURE = 1600;     // longest side, as in the browser
const THUMB = 240;
const WHOLE = 6;             // max differing bits (of 64) for the whole panel
const WINDOW = 5;            // ... for a crop window (stricter: windows are smaller and match more easily by chance)
const VERIFY = 0.8;          // pixel correlation of the aligned thumbnails needed to report a match

let engine = null, forensics = null;
async function lib() {
  if (!engine) { engine = await import('../public/js/images/engine.js'); forensics = await import('../public/js/images/forensics.js'); }
  return { E: engine, F: forensics };
}

// ------------------------------------------------------------------ hashing helpers

const popcnt = v => { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
const isHex = h => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h);
const hi = h => parseInt(h.slice(0, 8), 16) >>> 0, lo = h => parseInt(h.slice(8, 16), 16) >>> 0;

// ------------------------------------------------------------------ chart data (shared with images.js)

function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
/** Same rule as public/js/images/forensics.js compareSeries: correlation or null */
function sameSeries(a, b) {
  if (a.kind !== b.kind) return null;
  if (a.kind === 'bars') {
    if (a.n !== b.n || a.n < 4 || a.spread < 0.12 || b.spread < 0.12) return null;
    const c = Math.max(pearson(a.v, b.v), pearson(a.v, [...b.v].reverse()));
    return c >= (a.n >= 6 ? 0.995 : 0.998) ? c : null;
  }
  if ((a.wiggle || 0) < 0.06 || (b.wiggle || 0) < 0.06) return null;
  const c = pearson(a.v, b.v);
  return c >= 0.996 ? c : null;
}
const cleanSeries = list => (Array.isArray(list) ? list : []).slice(0, 60).filter(c => c && Array.isArray(c.v) && c.v.length >= 4 && c.v.length <= 64 && c.v.every(Number.isFinite))
  .map(c => ({ label: String(c.label || '').slice(0, 120), kind: c.kind === 'line' ? 'line' : 'bars', n: c.v.length, v: c.v, spread: Number(c.spread) || 0, wiggle: Number(c.wiggle) || 0 }));

// ------------------------------------------------------------------ fingerprinting figures

function encodeThumb(E, img, box) {
  const k = Math.min(1, THUMB / Math.max(box.w, box.h));
  const t = E.resizeRGBA(img, box.w * k, box.h * k, box);
  return require('jpeg-js').encode({ width: t.width, height: t.height, data: Buffer.from(t.data.buffer, t.data.byteOffset, t.data.length) }, 80).data;
}

/** images: [{ width, height, data, label }] -> panels [{ figure, panel, type, blank, hashes[6], series, thumb(Buffer), w, h }] */
async function fingerprintFigures(images, { single = false } = {}) {
  const { E, F } = await lib();
  const out = [];
  for (const raw of images) {
    const k = Math.min(1, MAX_FIGURE / Math.max(raw.width, raw.height));
    const img = k < 1 ? E.resizeRGBA(raw, raw.width * k, raw.height * k) : raw;
    const gray = E.toGray(img);
    // single: the image is already one panel (BioFors, BINDER patches), so it is not split again
    const boxes = single ? [{ x: 0, y: 0, w: img.width, h: img.height }] : E.splitPanels(img);
    boxes.forEach((b, i) => {
      if (b.w < 48 || b.h < 48) return;
      const type = raw.type || E.classify(img, b);
      const h = E.hashPanel(img, b, gray);
      if (h.blank) return;
      const series = type === 'chart' ? F.chartSeries(img, b).map(s => ({ kind: s.kind, n: s.n, v: s.values.map(v => Math.round(v)), spread: Math.round(s.spread * 100) / 100, wiggle: s.wiggle ? Math.round(s.wiggle * 100) / 100 : 0 })) : [];
      out.push({ figure: raw.label, panel: boxes.length > 1 ? `${raw.label}, panel ${i + 1}` : raw.label, type, hashes: [h.hashes[0], ...E.windowHashes(gray, b)], series: series.length ? series : null, thumb: encodeThumb(E, img, b), w: b.w, h: b.h });
    });
  }
  return out;
}

/**
 * Store one paper and its panels (replacing an earlier indexing of the same paper). meta: { doi, title, journal, year,
 * url, pdfUrl, note }. Returns the document row.
 */
async function storeDoc(source, key, meta, images, { status = null, error = null, single = false } = {}) {
  const panels = images.length ? await fingerprintFigures(images, { single }) : [];
  const st = status || (panels.length ? 'done' : 'no-figures');
  const doc = await db.one(`INSERT INTO image_ref_docs(source, source_key, doi, title, journal, year, url, pdf_url, note, status, figures, panels, error, indexed_at)
    VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
    ON CONFLICT(source, source_key) DO UPDATE SET doi = EXCLUDED.doi, title = EXCLUDED.title, journal = EXCLUDED.journal, year = EXCLUDED.year, url = EXCLUDED.url, pdf_url = EXCLUDED.pdf_url,
      note = EXCLUDED.note, status = EXCLUDED.status, figures = EXCLUDED.figures, panels = EXCLUDED.panels, error = EXCLUDED.error, indexed_at = now() RETURNING *`,
  [source, String(key), meta.doi || null, meta.title ? String(meta.title).slice(0, 600) : null, meta.journal || null, meta.year ? String(meta.year) : null, meta.url || null, meta.pdfUrl || null,
    meta.note ? String(meta.note).slice(0, 1000) : null, st, images.length, panels.length, error]);
  const old = await db.all('SELECT thumb_key FROM image_refs WHERE doc_id = $1 AND thumb_key IS NOT NULL', [doc.id]);
  await db.query('DELETE FROM image_refs WHERE doc_id = $1', [doc.id]);
  for (const o of old) await R2.deleteObject(o.thumb_key);
  if (panels.length) {
    const thumbs = R2.enabled();
    const keys = panels.map((p, i) => (thumbs ? `image-refs/${source}/${doc.id}/${i + 1}-${crypto.randomBytes(4).toString('hex')}.jpg` : null));
    for (let i = 0; i < panels.length; i += 8) {   // thumbnails to R2, 8 at a time
      await Promise.all(panels.slice(i, i + 8).map((p, k) => keys[i + k] && R2.putObject(keys[i + k], p.thumb, 'image/jpeg').catch(() => { keys[i + k] = null; })));
    }
    const rows = panels.map((p, i) => [doc.id, source, p.figure, p.panel, p.type, p.hashes.join(','), p.series ? JSON.stringify(p.series) : null, keys[i], p.w, p.h]);
    await db.transaction(client => db.bulkInsert(client, 'image_refs', [
      { name: 'doc_id', type: 'int' }, { name: 'source', type: 'text' }, { name: 'figure', type: 'text' }, { name: 'panel', type: 'text' }, { name: 'type', type: 'text' },
      { name: 'hashes', type: 'text' }, { name: 'series', type: 'jsonb' }, { name: 'thumb_key', type: 'text' }, { name: 'w', type: 'int' }, { name: 'h', type: 'int' }], rows, 500));
  }
  await bumpVersion();
  return { ...doc, panels: panels.length };
}

async function markDoc(source, key, status, meta = {}, error = null) {
  await db.query(`INSERT INTO image_ref_docs(source, source_key, title, url, status, error, indexed_at) VALUES($1, $2, $3, $4, $5, $6, now())
    ON CONFLICT(source, source_key) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, indexed_at = now()`, [source, String(key), meta.title || null, meta.url || null, status, error ? String(error).slice(0, 500) : null]);
}

async function deleteDoc(id) {
  const thumbs = await db.all('SELECT thumb_key FROM image_refs WHERE doc_id = $1 AND thumb_key IS NOT NULL', [id]);
  for (const t of thumbs) await R2.deleteObject(t.thumb_key);
  await db.query('DELETE FROM image_ref_docs WHERE id = $1', [id]);
  await bumpVersion();
}

const bumpVersion = () => db.setMeta('imgref_version', `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);

// ------------------------------------------------------------------ downloads

async function download(url, { timeout = 60000, max = 80e6 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, redirect: 'follow' });
    if (!res.ok) return { ok: false, status: res.status };
    if (Number(res.headers.get('content-length') || 0) > max) return { ok: false, status: 413 };
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, buffer, type: res.headers.get('content-type') || '' };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(timer); }
}

// ------------------------------------------------------------------ source 1: published PJPS papers (pjps.pk)

const metaTag = (html, name) => [...html.matchAll(new RegExp(`<meta[^>]+name="${name}"[^>]+content="([^"]*)"`, 'g'))].map(m => m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim());

/** Article page -> { id, title, doi, year, volume, issue, pages, pdfUrl, url } or null when there is no article with this id */
async function pjpsArticle(id) {
  const url = `${PJPS}/single-article?id=${id}`;
  const r = await download(url, { timeout: 30000, max: 5e6 });
  if (!r.ok) throw new Error(`pjps.pk article page ${id}: HTTP ${r.status || r.error}`);
  const html = r.buffer.toString('utf8');
  const title = metaTag(html, 'citation_title')[0];
  if (!title) return null;
  let pdfUrl = metaTag(html, 'citation_pdf_url')[0] || (html.match(/https:\/\/pjps\.pk\/uploads\/[^"\\\s]+?\.pdf/) || [])[0] || null;
  if (pdfUrl && !/^https?:/.test(pdfUrl)) pdfUrl = `${PJPS}/${pdfUrl.replace(/^\//, '')}`;
  return {
    id, url, title, doi: metaTag(html, 'citation_doi')[0] || null, year: (metaTag(html, 'citation_publication_date')[0] || metaTag(html, 'citation_date')[0] || '').slice(0, 4) || null,
    volume: metaTag(html, 'citation_volume')[0] || null, issue: metaTag(html, 'citation_issue')[0] || null, pages: [metaTag(html, 'citation_firstpage')[0], metaTag(html, 'citation_lastpage')[0]].filter(Boolean).join('-'), pdfUrl
  };
}

/** Highest article id linked from the pjps.pk home page and latest-articles page */
async function latestPjpsId() {
  let max = 0;
  for (const u of [`${PJPS}/`, `${PJPS}/articles/latest-articles`]) {
    const r = await download(u, { timeout: 30000, max: 10e6 });
    if (r.ok) for (const m of r.buffer.toString('utf8').matchAll(/single-article\?id=(\d+)/g)) max = Math.max(max, parseInt(m[1], 10));
  }
  if (!max) throw new Error('Could not read the latest article number from pjps.pk');
  return max;
}

async function indexPjpsArticle(id) {
  const a = await pjpsArticle(id);
  if (!a) { await markDoc('pjps', id, 'missing', { url: `${PJPS}/single-article?id=${id}` }); return { id, status: 'missing' }; }
  const meta = { doi: a.doi, title: a.title, journal: 'Pakistan Journal of Pharmaceutical Sciences', year: a.year, url: a.url, pdfUrl: a.pdfUrl, note: [a.volume && `Vol. ${a.volume}`, a.issue && `No. ${a.issue}`, a.pages && `pp. ${a.pages}`].filter(Boolean).join(', ') };
  if (!a.pdfUrl) { await storeDoc('pjps', id, meta, [], { status: 'no-figures', error: 'No PDF on the article page' }); return { id, status: 'no-pdf' }; }
  const pdf = await download(a.pdfUrl, { timeout: 120000 });
  if (!pdf.ok) { await storeDoc('pjps', id, meta, [], { status: 'error', error: `PDF download failed (${pdf.status || pdf.error})` }); return { id, status: 'error' }; }
  const { images } = await figuresOfFile('article.pdf', pdf.buffer);
  const doc = await storeDoc('pjps', id, meta, images);
  return { id, status: doc.status, figures: images.length, panels: doc.panels };
}

/**
 * Index PJPS articles: ids from..to (default: everything newer than the newest indexed id, up to the latest on
 * pjps.pk). Articles already indexed are skipped unless force. Stops after `limit` articles or `budgetMs`.
 */
async function indexPjps({ from = null, to = null, limit = 200, force = false, budgetMs = Infinity, concurrency = 3 } = {}, update = () => {}) {
  const started = Date.now();
  const top = to || await latestPjpsId();
  let start = from;
  if (!start) {
    const r = await db.one("SELECT MAX(source_key::int) AS m FROM image_ref_docs WHERE source = 'pjps' AND source_key ~ '^[0-9]+$'");
    start = r?.m ? r.m + 1 : Math.max(1, top - limit + 1);
  }
  const done = new Set(force ? [] : (await db.all("SELECT source_key FROM image_ref_docs WHERE source = 'pjps' AND status IN ('done', 'no-figures', 'missing')")).map(r => r.source_key));
  const ids = [];
  for (let id = top; id >= start && ids.length < limit; id--) if (!done.has(String(id))) ids.push(id);   // newest first
  const out = { from: start, to: top, queued: ids.length, articles: 0, missing: 0, figures: 0, panels: 0, errors: [], stoppedEarly: false };
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      if (Date.now() - started > budgetMs) { out.stoppedEarly = true; return; }
      const id = ids[next++];
      try {
        const r = await indexPjpsArticle(id);
        if (r.status === 'missing') out.missing++; else { out.articles++; out.figures += r.figures || 0; out.panels += r.panels || 0; }
      } catch (e) {
        out.errors.push(`${id}: ${e.message}`);
        await markDoc('pjps', id, 'error', { url: `${PJPS}/single-article?id=${id}` }, e.message).catch(() => {});
      }
      update(`PJPS article ${id}: ${out.articles} papers, ${out.panels} panels indexed (${next}/${ids.length})`, 5 + next / Math.max(1, ids.length) * 93);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length || 1) }, worker));
  out.errors = out.errors.slice(0, 30);
  return out;
}

// ------------------------------------------------------------------ source 2: retracted / corrected papers with image problems

const IMAGE_REASONS = /image/i;

async function indexRetracted({ limit = 100, force = false, budgetMs = Infinity, concurrency = 3 } = {}, update = () => {}) {
  const started = Date.now();
  await require('./datasetStore').ensureLocal('public-images/');
  const PUB = require('./publicImageData');
  const all = PUB.cases({ oa: true, per: 1e6 }).cases.filter(c => c.pmcid && c.reasons.some(r => IMAGE_REASONS.test(r)));
  if (!all.length) throw new Error('The list of retracted papers with image problems is not available (data/public-images/retracted_image_cases.json - run scripts/fetch-public-image-data.js or sync the data folder to R2).');
  // strongest cases first: duplication / manipulation / fabrication, retractions before corrections, newest first
  const rank = c => (c.reasons.some(r => /Duplication|Manipulation|Falsification|Plagiarism of Image/.test(r)) ? 0 : 1) * 2 + (/Retraction/i.test(c.nature) ? 0 : 1);
  all.sort((a, b) => rank(a) - rank(b) || String(b.date).localeCompare(String(a.date)));
  // done, or confirmed without figures; failures and pre-fallback "no figures" are retried once a day at most
  const rows = force ? [] : await db.all("SELECT source_key, status, error, indexed_at > now() - interval '1 day' AS recent FROM image_ref_docs WHERE source = 'retracted'");
  const done = new Set(rows.filter(r => r.status === 'done' || (r.status === 'no-figures' && r.error === NO_FIGURES) || r.recent).map(r => r.source_key));
  const list = all.filter(c => !done.has(c.pmcid)).slice(0, limit);
  const out = { available: all.length, indexedBefore: done.size, queued: list.length, papers: 0, figures: 0, panels: 0, errors: [], stoppedEarly: false };
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      if (Date.now() - started > budgetMs) { out.stoppedEarly = true; return; }
      const c = list[next++];
      const meta = { doi: c.doi, title: c.title, journal: c.journal, year: String(c.date || '').slice(0, 4), url: `https://pmc.ncbi.nlm.nih.gov/articles/${c.pmcid}/`, note: `${c.nature} (${c.date}): ${c.reasons.join('; ')}` };
      await indexPmcPaper('retracted', c.pmcid, meta, out);
      update(`${c.pmcid}: ${out.papers} papers, ${out.panels} panels indexed (${next}/${list.length})`, 5 + next / Math.max(1, list.length) * 93);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  out.errors = out.errors.slice(0, 30);
  return out;
}

// ------------------------------------------------------------------ source 4: PubMed Central open-access papers in PJPS's field

const PMC_QUERY = '(pharmacology[MeSH Terms] OR pharmaceutical[tiab] OR pharmaceutics[tiab] OR "medicinal plants"[tiab] OR phytochemical[tiab] OR "drug delivery"[tiab]) AND open access[filter]';
// biomedical papers with the figure types where duplication is found most (blots, histology, microscopy, flow cytometry)
const PMC_BIOMED_QUERY = '("western blot"[tiab] OR "western blotting"[tiab] OR immunohistochemistry[tiab] OR histopathology[tiab] OR immunofluorescence[tiab] OR "flow cytometry"[tiab] OR "electrophoretic mobility"[tiab]) AND open access[filter]';
const PMC_BANDS = [
  { id: 'pharmacy', query: PMC_QUERY, offsetKey: 'imgref_pmc_offset' },
  { id: 'biomedical', query: PMC_BIOMED_QUERY, offsetKey: 'imgref_pmc_offset_biomed' }
];
const eutils = (tool, params) => {
  const key = require('./config').NCBI_API_KEY;
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/${tool}.fcgi?${new URLSearchParams({ ...params, retmode: 'json', tool: 'pjps-integrity', ...(key ? { api_key: key } : {}) })}`;
};

/**
 * Open-access figures of PubMed Central papers in pharmacy, pharmacology and medicinal plants (newest first), the
 * openly available part of the corpus ImageTwin / Proofig compare against. Continues where the last run stopped.
 */
async function indexPmc({ limit = 100, band = null, force = false, budgetMs = Infinity, concurrency = 3, restart = false } = {}, update = () => {}) {
  const started = Date.now();
  // the two search bands take turns (pharmacy first); each keeps its own position in the result list
  const turn = parseInt((await db.getMeta('imgref_pmc_turn')) || '0', 10);
  const b = PMC_BANDS.find(x => x.id === band) || PMC_BANDS[turn % PMC_BANDS.length];
  if (!band) await db.setMeta('imgref_pmc_turn', turn + 1);
  const query = b.query;
  let offset = restart ? 0 : parseInt((await db.getMeta(b.offsetKey)) || '0', 10);
  const done = new Set(force ? [] : (await db.all("SELECT source_key FROM image_ref_docs WHERE source = 'pmc' AND status IN ('done', 'no-figures', 'error')")).map(r => r.source_key));
  const out = { band: b.id, query, papers: 0, figures: 0, panels: 0, skipped: 0, retried: 0, errors: [], stoppedEarly: false, total: null };
  // earlier failures and pre-fallback "no figures" first
  const retries = await retryList('pmc', Math.floor(limit / 4));
  out.retried = retries.length;
  for (const r of retries) {
    if (Date.now() - started > budgetMs) { out.stoppedEarly = true; break; }
    await indexPmcPaper('pmc', r.source_key, r, out);
  }
  limit -= retries.length;
  const list = [];
  while (list.length < limit) {
    const r = await download(eutils('esearch', { db: 'pmc', term: query, retstart: offset, retmax: 200, sort: 'pub_date' }), { timeout: 30000 });
    if (!r.ok) throw new Error(`PubMed Central search failed (${r.status || r.error})`);
    const res = JSON.parse(r.buffer.toString('utf8')).esearchresult || {};
    out.total = parseInt(res.count, 10) || 0;
    const ids = res.idlist || [];
    if (!ids.length) break;
    for (const id of ids) { offset++; if (done.has(`PMC${id}`)) out.skipped++; else if (list.length < limit) list.push(id); else { offset--; break; } }
    if (list.length >= limit) break;
  }
  // titles, journals, DOIs of the batch
  const meta = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const r = await download(eutils('esummary', { db: 'pmc', id: list.slice(i, i + 100).join(',') }), { timeout: 30000 });
    if (!r.ok) continue;
    const res = JSON.parse(r.buffer.toString('utf8')).result || {};
    for (const id of list.slice(i, i + 100)) {
      const s = res[id];
      if (s) meta.set(id, { title: String(s.title || '').replace(/<[^>]+>/g, ''), journal: s.fulljournalname || s.source, year: String(s.pubdate || '').slice(0, 4), doi: (s.articleids || []).find(a => a.idtype === 'doi')?.value || null });
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      if (Date.now() - started > budgetMs) { out.stoppedEarly = true; return; }
      const id = list[next++], pmcid = `PMC${id}`;
      const m = { ...(meta.get(id) || {}), url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`, note: 'PubMed Central open-access subset' };
      await indexPmcPaper('pmc', pmcid, m, out);
      update(`${pmcid}: ${out.papers} papers, ${out.panels} panels indexed (${next}/${list.length})`, 5 + next / Math.max(1, list.length) * 93);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  // papers not reached because of the time budget are picked up next time
  await db.setMeta(b.offsetKey, Math.max(0, offset - (list.length - next)));
  out.errors = out.errors.slice(0, 30);
  return out;
}

// ------------------------------------------------------------------ public image-integrity research datasets (local archives)
// The archives live in the data folder (mirrored on R2); they are read file by file (src/archiveReader.js).

const path = require('path');
const AR = require('./archiveReader');
const dataFile = (...p) => path.join(require('./config').DATA_DIR, ...p);
const fsExists = f => { try { return require('fs').statSync(f).size > 0; } catch { return false; } };

async function decodeNamed(name, buf) {
  try { return await decodeAny(buf); } catch { return null; }
}

/**
 * RSIID (Recod.ai Scientific Image Integrity Dataset, zenodo.org/records/15095089): the pristine CC-licensed scientific
 * figures the forgeries were made from (PNG / TIFF, incl. BBBC microscopy) and the figure templates. One entry per figure.
 */
async function indexRsiid({ limit = Infinity, force = false, budgetMs = Infinity } = {}, update = () => {}) {
  const started = Date.now();
  const files = [[dataFile('public-images', 'rsiid', 'artificial_forgery_src_data.zip'), /^srcDataset\/\d+\.(png|tif)$/i, 'pristine figure'],
    [dataFile('public-images', 'rsiid', 'template.zip'), /^template_figures\/\d+\.(jpe?g|png)$/i, 'figure template']].filter(([f]) => fsExists(f));
  if (!files.length) throw new Error('The RSIID archives are not in the data folder (public-images/rsiid). Download them from zenodo.org/records/15095089 or run npm run datasets:pull.');
  const done = new Set(force ? [] : (await db.all("SELECT source_key FROM image_ref_docs WHERE source = 'rsiid' AND status <> 'error'")).map(r => r.source_key));
  const todo = files.flatMap(([zip, re, kind]) => AR.zipEntries(zip).filter(e => re.test(e.name) && !done.has(e.name)).map(e => ({ zip, e, kind })));
  const list = todo.slice(0, limit);
  const out = { available: todo.length + done.size, indexedBefore: done.size, queued: list.length, figures: 0, panels: 0, errors: [], stoppedEarly: false };
  for (const [i, { zip, e, kind }] of list.entries()) {
    if (Date.now() - started > budgetMs) { out.stoppedEarly = true; break; }
    try {
      const img = await decodeNamed(e.name, AR.zipRead(zip, e));
      const label = `RSIID ${kind} ${path.basename(e.name).replace(/\.[a-z]+$/i, '')}`;
      const doc = await storeDoc('rsiid', e.name, { title: label, journal: 'RSIID (Recod.ai), CC-BY 4.0', url: 'https://zenodo.org/records/15095089', note: 'Pristine open-licence scientific figure used to build the RSIID forgery benchmark' },
        img && img.width >= 48 && img.height >= 48 ? [{ ...img, label }] : [], img ? {} : { status: 'error', error: 'Could not decode the image' });
      out.figures++; out.panels += doc.panels;
    } catch (err) { out.errors.push(`${e.name}: ${err.message}`); }
    if (i % 10 === 0) update(`RSIID: ${out.figures} figures, ${out.panels} panels (${i + 1}/${list.length})`, 5 + (i + 1) / list.length * 93);
  }
  out.errors = out.errors.slice(0, 30);
  return out;
}

const BIOFORS_TYPES = { 'Blot/Gel': 'blot', Microscopy: 'fluorescence', 'Flow-cytometry': 'chart', FACS: 'chart', Macroscopy: 'photo' };

/**
 * BioFors (Sabir et al., ICCV 2021): 47,805 figure panels from 1,031 biomedical papers with expert annotations of
 * external duplication (EDD), internal duplication (IDD) and cut / sharp transitions (CSTD). One entry per paper; panels
 * named in the annotations are labelled, so a match says whether the experts marked that panel as duplicated.
 */
async function indexBiofors({ limit = Infinity, force = false, budgetMs = Infinity } = {}, update = () => {}) {
  const started = Date.now();
  const dir = dataFile('benchmark', 'biofors');
  const tar = path.join(dir, 'biofors.tar');
  if (!fsExists(tar)) throw new Error('The BioFors archive is not in the data folder (benchmark/biofors/biofors.tar). Request it from the authors (vimal.isi.edu/ekraam-2021-biofors) or run npm run datasets:pull.');
  const readJson = f => { try { return JSON.parse(require('fs').readFileSync(path.join(dir, 'ann', f), 'utf8')); } catch { return {}; } };
  const cls = readJson('classification.json'), edd = readJson('edd_gt.json'), idd = readJson('idd_gt.json'), cstd = readJson('cstd_gt.json');
  const marked = id => {
    const m = new Map();
    const add = (f, what) => m.set(f, [...new Set([...(m.get(f) || []), what])]);
    for (const pair of Object.keys(edd[id] || {})) pair.split(' ').forEach(f => add(f, 'duplicated in another panel'));
    for (const f of Object.keys(idd[id] || {})) add(f, 'duplicated area inside the panel');
    for (const f of Object.keys(cstd[id] || {})) add(f, 'cut / sharp transition');
    return m;
  };
  const done = new Set(force ? [] : (await db.all("SELECT source_key FROM image_ref_docs WHERE source = 'biofors' AND status <> 'error'")).map(r => r.source_key));
  const out = { papers: 0, panels: 0, annotatedPapers: 0, skippedDone: 0, errors: [], stoppedEarly: false };
  let cur = null, files = [];
  const flush = async () => {
    if (!cur || !files.length) return;
    const id = cur, list = files;
    cur = null; files = [];
    if (done.has(id)) { out.skippedDone++; return; }
    const ann = marked(id);
    const images = [];
    for (const { name, data } of list) {
      const img = await decodeNamed(name, data);
      if (!img || img.width < 48 || img.height < 48) continue;
      const flags = ann.get(name);
      images.push({ ...img, label: `Panel ${name.replace(/\.png$/, '')}${flags ? ` [BioFors annotation: ${flags.join(', ')}]` : ''}`, type: BIOFORS_TYPES[cls[id]?.[name]] || null });
    }
    const counts = [Object.keys(edd[id] || {}).length && `${Object.keys(edd[id]).length} duplicated panel pair(s)`, Object.keys(idd[id] || {}).length && `${Object.keys(idd[id]).length} panel(s) with internal duplication`, Object.keys(cstd[id] || {}).length && `${Object.keys(cstd[id]).length} panel(s) with cut / sharp transitions`].filter(Boolean);
    if (counts.length) out.annotatedPapers++;
    const doc = await storeDoc('biofors', id, { title: `BioFors paper ${id}`, journal: 'BioFors (ICCV 2021) — biomedical papers', url: 'https://vimal.isi.edu/ekraam-2021-biofors', note: counts.length ? `Expert annotations: ${counts.join('; ')}` : 'No manipulation annotated by the BioFors experts' }, images, { single: true });
    out.papers++; out.panels += doc.panels;
    update(`BioFors paper ${id}: ${out.papers} papers, ${out.panels} panels indexed`, Math.min(98, 5 + out.papers / 1031 * 93));
  };
  try {
    await AR.tarEach(tar, n => /^biofors_images\/\d+\/[^/]+\.png$/i.test(n), async (name, data) => {
      const [, id, file] = name.match(/^biofors_images\/(\d+)\/([^/]+)$/);
      if (id !== cur) {
        await flush();
        if (out.papers >= limit || Date.now() - started > budgetMs) { out.stoppedEarly = out.papers >= limit ? false : true; throw Object.assign(new Error('stop'), { stop: true }); }
        cur = id;
      }
      if (!done.has(id)) files.push({ name: file, data });
    });
    await flush();
  } catch (e) { if (!e.stop) throw e; }
  out.errors = out.errors.slice(0, 30);
  return out;
}

/**
 * BINDER (Bio-Image Near-Duplicate Examples Repository, doi:10.7910/DVN/9YTD9Z): image patches and their manipulated
 * near-duplicates. The zip must be downloaded by hand (Harvard Dataverse guestbook) into public-images/binder/.
 */
async function indexBinder({ limit = Infinity, force = false, budgetMs = Infinity } = {}, update = () => {}) {
  const started = Date.now();
  const dir = dataFile('public-images', 'binder');
  const zip = (() => { try { return require('fs').readdirSync(dir).filter(f => /\.zip$/i.test(f)).map(f => path.join(dir, f))[0]; } catch { return null; } })();
  if (!zip) throw new Error('BINDER is not in the data folder. Download BINDER_2020_7_9.zip from https://doi.org/10.7910/DVN/9YTD9Z (the site asks for a name and e-mail) into data/public-images/binder/, then run this again.');
  const groups = new Map();
  for (const e of AR.zipEntries(zip)) {
    if (!/\.(png|jpe?g|tiff?|bmp)$/i.test(e.name) || /__MACOSX|\/\./.test(e.name)) continue;
    const g = path.posix.dirname(e.name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  }
  const done = new Set(force ? [] : (await db.all("SELECT source_key FROM image_ref_docs WHERE source = 'binder' AND status <> 'error'")).map(r => r.source_key));
  const list = [...groups].filter(([g]) => !done.has(g)).slice(0, limit);
  const out = { folders: groups.size, queued: list.length, patches: 0, panels: 0, errors: [], stoppedEarly: false };
  for (const [i, [g, entries]] of list.entries()) {
    if (Date.now() - started > budgetMs) { out.stoppedEarly = true; break; }
    // large folders are stored in parts of 400 patches
    for (let k = 0; k < entries.length; k += 400) {
      const images = [];
      for (const e of entries.slice(k, k + 400)) {
        const img = await decodeNamed(e.name, AR.zipRead(zip, e)).catch(() => null);
        if (img && img.width >= 32 && img.height >= 32) images.push({ ...img, label: path.posix.basename(e.name) });
      }
      const key = entries.length > 400 ? `${g}#${k / 400 + 1}` : g;
      const doc = await storeDoc('binder', key, { title: `BINDER ${g}`, journal: 'BINDER (Harvard Dataverse, CC0)', url: 'https://doi.org/10.7910/DVN/9YTD9Z', note: 'Bio-image near-duplicate examples (rotation, scale, crop, contrast, compression)' }, images, { single: true });
      out.patches += images.length; out.panels += doc.panels;
    }
    update(`BINDER ${g}: ${out.patches} patches indexed (${i + 1}/${list.length})`, 5 + (i + 1) / list.length * 93);
  }
  return out;
}

// ------------------------------------------------------------------ source 3: reference figures uploaded by the Super Admin

/** files: [{ name, buffer }], meta: { title, doi, journal, year, note, url } */
async function indexUpload(files, meta = {}) {
  const images = [], skipped = [];
  for (const f of files) {
    const r = await figuresOfFile(f.name, f.buffer);
    images.push(...r.images.map((im, i) => ({ ...im, label: files.length > 1 ? `${f.name.replace(/\.[a-z]+$/i, '')} – ${im.label}` : im.label || `Image ${i + 1}` })));
    skipped.push(...r.skipped.map(s => ({ ...s, name: `${f.name}: ${s.name}` })));
  }
  const key = `upload-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const doc = await storeDoc('reference', key, { ...meta, title: meta.title || files.map(f => f.name).join(', ') }, images);
  return { doc, figures: images.length, panels: doc.panels, skipped: skipped.slice(0, 50) };
}

// ------------------------------------------------------------------ matching

let index = null;   // { version, n, ids: Int32Array, h: Uint32Array(n*12), loadedAt }
let charts = null;  // { version, list: [{ id, series }] }

async function loadIndex() {
  const version = (await db.getMeta('imgref_version')) || '0';
  if (index && index.version === version) return index;
  const rows = await db.all("SELECT id, hashes FROM image_refs WHERE type IS DISTINCT FROM 'chart'");
  const ids = new Int32Array(rows.length), h = new Uint32Array(rows.length * 12);
  let n = 0;
  for (const r of rows) {
    const hs = String(r.hashes).split(',');
    if (hs.length !== 6 || !hs.every(isHex)) continue;
    ids[n] = r.id;
    hs.forEach((x, j) => { h[n * 12 + j * 2] = hi(x); h[n * 12 + j * 2 + 1] = lo(x); });
    n++;
  }
  index = { version, n, ids, h, loadedAt: Date.now() };
  charts = null;
  return index;
}

async function loadCharts() {
  const idx = await loadIndex();
  if (charts && charts.version === idx.version) return charts;
  const rows = await db.all('SELECT id, series FROM image_refs WHERE series IS NOT NULL');
  charts = { version: idx.version, list: rows.map(r => ({ id: r.id, series: cleanSeries(r.series) })) };
  return charts;
}

/**
 * Candidate matches for the manuscript panels: [{ panel, ref, how: whole|crop|contains, k (orientation 0-7), window, distance }].
 * panels: [{ id, hashes: [8 hex], windows: [5 hex] }]
 */
function candidates(idx, panels, limitPerPanel = 8) {
  const out = [];
  for (const p of panels) {
    if (!Array.isArray(p.hashes) || p.hashes.length !== 8 || !p.hashes.every(isHex)) continue;
    const Q = p.hashes.flatMap(x => [hi(x), lo(x)]);
    const W = (Array.isArray(p.windows) && p.windows.length === 5 && p.windows.every(isHex)) ? p.windows.flatMap(x => [hi(x), lo(x)]) : null;
    const found = [];
    for (let r = 0; r < idx.n; r++) {
      const o = r * 12;
      let best = null;
      // whole panel, any orientation
      for (let k = 0; k < 8; k++) {
        const d = popcnt(Q[k * 2] ^ idx.h[o]) + popcnt(Q[k * 2 + 1] ^ idx.h[o + 1]);
        if (d <= WHOLE && (!best || d < best.distance)) best = { how: 'whole', k, window: null, distance: d };
      }
      if (!best || best.distance > 2) {
        // the manuscript panel is a crop of the published one (any orientation)
        for (let j = 1; j < 6; j++) for (let k = 0; k < 8; k++) {
          const d = popcnt(Q[k * 2] ^ idx.h[o + j * 2]) + popcnt(Q[k * 2 + 1] ^ idx.h[o + j * 2 + 1]);
          if (d <= WINDOW && (!best || d < best.distance)) best = { how: 'crop', k, window: j - 1, distance: d };
        }
        // the published panel is a crop of the manuscript panel
        if (W) for (let j = 0; j < 5; j++) {
          const d = popcnt(W[j * 2] ^ idx.h[o]) + popcnt(W[j * 2 + 1] ^ idx.h[o + 1]);
          if (d <= WINDOW && (!best || d < best.distance)) best = { how: 'contains', k: 0, window: j, distance: d };
        }
      }
      if (best) found.push({ panel: p.id, ref: idx.ids[r], ...best });
    }
    found.sort((a, b) => a.distance - b.distance);
    out.push(...found.slice(0, limitPerPanel));
  }
  return out;
}

// --- pixel verification on the thumbnails

const WIN_BOX = (w, h, j, f = 0.75) => { const cw = Math.round(w * f), ch = Math.round(h * f), dx = w - cw, dy = h - ch; const [x, y] = [[dx / 2, dy / 2], [0, 0], [dx, 0], [0, dy], [dx, dy]][j]; return { x: Math.round(x), y: Math.round(y), w: cw, h: ch }; };

function ncc64(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa > 1 && sbb > 1 ? sab / Math.sqrt(saa * sbb) : 0;
}

const fromDataUrl = s => { const m = /^data:image\/(?:jpeg|png);base64,(.+)$/.exec(String(s || '')); return m ? Buffer.from(m[1], 'base64') : null; };

async function verify(E, qThumb, rThumb, c) {
  try {
    const q = decodeImage(qThumb), r = decodeImage(rThumb);
    if (!q || !r) return null;
    const gq = E.toGray(q), gr = E.toGray(r);
    const qBox = c.how === 'contains' ? WIN_BOX(gq.w, gq.h, c.window) : { x: 0, y: 0, w: gq.w, h: gq.h };
    const rBox = c.how === 'crop' ? WIN_BOX(gr.w, gr.h, c.window) : { x: 0, y: 0, w: gr.w, h: gr.h };
    const a = E.orient(E.resizeGray(gq, 48, 48, qBox), c.k % 4, c.k >= 4).g;
    const b = E.resizeGray(gr, 48, 48, rBox).g;
    return ncc64(a, b);
  } catch { return null; }
}

async function refThumb(key) {
  if (!key || !R2.enabled()) return null;
  const res = await fetch(R2.presign('GET', key)).catch(() => null);
  return res && res.ok ? Buffer.from(await res.arrayBuffer()) : null;
}

const describe = c => {
  const rot = (c.k % 4) * 90, parts = [];
  if (c.k >= 4) parts.push('mirrored');
  if (rot) parts.push(`rotated ${rot > 180 ? rot - 360 : rot}°`);
  if (c.how === 'crop') parts.push('cropped from the published figure');
  if (c.how === 'contains') parts.push('the published figure is a crop of this panel');
  return parts.length ? parts.join(', ') : 'same orientation';
};

/**
 * Compare manuscript panels (and chart data) with all reference databases.
 * panels: [{ id, label, hashes[8], windows[5], thumb (data URL) }]; charts: browser seriesFingerprints.
 * Returns { matches: [...], charts: [...], searched: { panels, refs, bySource } }
 */
async function matchManuscript(panels, chartList = []) {
  const idx = await loadIndex();
  const { E } = await lib();
  const searched = { panels: panels.length, refs: idx.n, bySource: await sourceCounts() };
  const cands = idx.n ? candidates(idx, panels) : [];
  const matches = [];
  if (cands.length) {
    const refIds = [...new Set(cands.map(c => c.ref))].slice(0, 400);
    const rows = await db.all(`SELECT r.id, r.source, r.figure, r.panel, r.type, r.thumb_key, r.w, r.h, d.id AS doc_id, d.doi, d.title, d.journal, d.year, d.url, d.note
      FROM image_refs r JOIN image_ref_docs d ON d.id = r.doc_id WHERE r.id = ANY($1::int[])`, [refIds]);
    const byId = new Map(rows.map(r => [r.id, r]));
    const panelById = new Map(panels.map(p => [p.id, p]));
    const thumbs = new Map();
    for (const c of cands) {
      const ref = byId.get(c.ref);
      if (!ref) continue;
      const p = panelById.get(c.panel);
      const q = fromDataUrl(p?.thumb);
      if (!thumbs.has(ref.id)) thumbs.set(ref.id, await refThumb(ref.thumb_key));
      const rt = thumbs.get(ref.id);
      const corr = q && rt ? await verify(E, q, rt, c) : null;
      // without thumbnails only near-identical fingerprints are reported
      if (corr === null ? c.distance > 3 || c.how !== 'whole' : corr < VERIFY) continue;
      matches.push({
        panel: c.panel, panelLabel: p?.label || c.panel, refId: ref.id, source: ref.source, sourceName: SOURCES[ref.source]?.short || ref.source,
        figure: ref.panel || ref.figure, doi: ref.doi, title: ref.title, journal: ref.journal, year: ref.year, url: ref.url, note: ref.note, how: c.how, distance: c.distance,
        correlation: corr === null ? null : Math.round(corr * 100) / 100, transform: { rotation: (c.k % 4) * Math.PI / 2, flip: c.k >= 4, scale: 1 }, description: describe(c),
        level: (corr ?? (c.distance <= 2 ? 1 : 0)) >= 0.9 && c.distance <= 4 ? 'high' : 'medium', hasThumb: !!rt
      });
    }
  }
  // one row per (panel, paper): keep the closest
  const best = new Map();
  for (const m of matches.sort((a, b) => (b.correlation ?? 0) - (a.correlation ?? 0) || a.distance - b.distance)) {
    const k = `${m.panel}|${m.doi || m.title}`;
    if (!best.has(k)) best.set(k, m);
  }
  const chartOut = [];
  const mine = cleanSeries(chartList);
  if (mine.length) {
    const cs = await loadCharts();
    const hits = [];
    for (const r of cs.list) for (const s of r.series) for (const m of mine) { const c = sameSeries(m, s); if (c) hits.push({ chart: m.label, refId: r.id, correlation: Math.round(c * 1000) / 1000 }); }
    if (hits.length) {
      const rows = await db.all(`SELECT r.id, r.source, r.panel, d.doi, d.title, d.journal, d.year, d.url, d.note FROM image_refs r JOIN image_ref_docs d ON d.id = r.doc_id WHERE r.id = ANY($1::int[])`, [[...new Set(hits.map(h => h.refId))]]);
      const byId = new Map(rows.map(r => [r.id, r]));
      const seen = new Set();
      for (const h of hits.sort((a, b) => b.correlation - a.correlation)) {
        const r = byId.get(h.refId);
        if (!r || seen.has(`${h.chart}|${r.id}`)) continue;
        seen.add(`${h.chart}|${r.id}`);
        chartOut.push({ ...h, source: r.source, sourceName: SOURCES[r.source]?.short || r.source, figure: r.panel, doi: r.doi, title: r.title, journal: r.journal, year: r.year, url: r.url, note: r.note });
      }
    }
  }
  return { matches: [...best.values()].slice(0, 60), charts: chartOut.slice(0, 30), searched };
}

// ------------------------------------------------------------------ status / browsing

async function sourceCounts() {
  const rows = await db.all(`SELECT source, COUNT(*) FILTER (WHERE status = 'done')::int AS papers, COALESCE(SUM(panels), 0)::int AS panels, COALESCE(SUM(figures), 0)::int AS figures,
      COUNT(*) FILTER (WHERE status = 'error')::int AS errors, COUNT(*) FILTER (WHERE status IN ('missing', 'no-figures'))::int AS empty, MAX(indexed_at) AS updated
    FROM image_ref_docs GROUP BY source`);
  return Object.fromEntries(Object.keys(SOURCES).map(s => { const r = rows.find(x => x.source === s) || {}; return [s, { name: SOURCES[s].name, papers: r.papers || 0, figures: r.figures || 0, panels: r.panels || 0, errors: r.errors || 0, empty: r.empty || 0, updated: r.updated || null }]; }));
}

async function status() {
  const bySource = await sourceCounts();
  const maxPjps = await db.one("SELECT MAX(source_key::int) AS m FROM image_ref_docs WHERE source = 'pjps' AND source_key ~ '^[0-9]+$' AND status <> 'error'");
  return { bySource, newestPjpsId: maxPjps?.m || null, thumbnails: R2.enabled() ? 'Cloudflare R2' : 'not stored (R2 not configured)', thresholds: { whole: WHOLE, window: WINDOW, verify: VERIFY } };
}

async function listDocs({ source = '', q = '', status: st = '', page = 1, per = 25 } = {}) {
  per = Math.min(Math.max(parseInt(per, 10) || 25, 1), 100);
  page = Math.max(parseInt(page, 10) || 1, 1);
  const args = [], where = [];
  if (SOURCES[source]) { args.push(source); where.push(`source = $${args.length}`); }
  if (st) { args.push(st); where.push(`status = $${args.length}`); }
  if (q) { args.push(`%${q}%`); where.push(`(title ILIKE $${args.length} OR doi ILIKE $${args.length} OR source_key ILIKE $${args.length})`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.one(`SELECT COUNT(*)::int AS n FROM image_ref_docs ${w}`, args)).n;
  const docs = await db.all(`SELECT id, source, source_key, doi, title, journal, year, url, note, status, figures, panels, error, indexed_at FROM image_ref_docs ${w} ORDER BY indexed_at DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, args);
  return { total, page, per, docs };
}

// ------------------------------------------------------------------ source 7: open-access papers of the major publishers

/** Figures of one open-access PMC paper into the database (shared by the PubMed Central and publisher sources) */
async function indexPmcPaper(source, pmcid, meta, out) {
  const AF = require('./authorFigures');
  try {
    const figs = await AF.figuresOf(pmcid);   // retries PMC, falls back to Europe PMC; throws when neither answered
    const images = [];
    for (const f of figs) {
      const r = await download(f.url, { timeout: 45000, max: 30e6 });
      const img = r.ok ? await decodeAny(r.buffer) : null;
      if (img && img.width >= 80 && img.height >= 80) images.push({ ...img, label: f.label });
    }
    const doc = await storeDoc(source, pmcid, meta, images, figs.length ? {} : { status: 'no-figures', error: NO_FIGURES });
    out.papers++; out.figures += images.length; out.panels += doc.panels;
  } catch (e) {
    out.errors.push(`${pmcid}: ${e.message}`);
    await markDoc(source, pmcid, 'error', meta, e.message).catch(() => {});
  }
}
// recorded when PMC and Europe PMC both answered and the paper really has no figures (not retried)
const NO_FIGURES = 'No figures in the article (PMC and Europe PMC)';

/**
 * Papers recorded as failed, or as figure-less before figure fetching retried and fell back to Europe PMC (PMC throttling
 * made many look empty). At most `limit`, oldest attempt first; a paper retried today is left for later.
 */
async function retryList(source, limit) {
  if (limit <= 0) return [];
  return db.all(`SELECT source_key, doi, title, journal, year, url, note FROM image_ref_docs
    WHERE source = $1 AND (status = 'error' OR (status = 'no-figures' AND error IS DISTINCT FROM $2)) AND indexed_at < now() - interval '1 day'
    ORDER BY indexed_at LIMIT $3`, [source, NO_FIGURES, limit]);
}

// Europe PMC PUBLISHER field; IEEE has almost no papers in PMC and is checked through Crossref only
const OA_PUBLISHERS = ['MDPI', 'Elsevier', 'Springer', 'Nature', 'BioMed Central', 'Wiley', 'Frontiers Media', 'Public Library of Science', 'Taylor & Francis',
  'SAGE', 'Oxford University Press', 'Cambridge University Press', 'Wolters Kluwer', 'American Chemical Society', 'Dove Medical Press', 'Hindawi'];
const OA_TOPICS = '(pharmacology OR pharmaceutical OR pharmaceutics OR "drug delivery" OR "medicinal plant" OR phytochemical OR "western blot" OR immunohistochemistry OR histopathology OR "flow cytometry")';

/**
 * Open-access figures from the journals of the major publishers (MDPI, Elsevier, Springer Nature / BMC, Wiley, Frontiers,
 * PLOS, Taylor & Francis, SAGE, OUP, CUP, Wolters Kluwer, ACS, Dove, Hindawi) in pharmacy and biomedicine, newest first.
 * The publishers take turns; each keeps its own Europe PMC cursor, so a run continues where the last one stopped.
 */
async function indexPublisherOa({ limit = 100, publishers = OA_PUBLISHERS, budgetMs = Infinity, concurrency = 3, restart = false } = {}, update = () => {}) {
  const started = Date.now();
  const state = restart ? {} : JSON.parse((await db.getMeta('imgref_pub_cursors')) || '{}');
  const done = new Set((await db.all("SELECT source_key FROM image_ref_docs WHERE source = 'publisher' AND status IN ('done', 'no-figures')")).map(r => r.source_key));
  const out = { papers: 0, figures: 0, panels: 0, skipped: 0, retried: 0, errors: [], stoppedEarly: false, byPublisher: {} };
  const list = (await retryList('publisher', Math.floor(limit / 4))).map(r => ({ pmcid: r.source_key, meta: r }));
  out.retried = list.length;
  const perPublisher = Math.max(1, Math.ceil((limit - list.length) / publishers.length));
  for (const p of publishers) {
    const st = state[p] || { cursor: '*', done: false, total: null };
    let taken = 0;
    while (!st.done && taken < perPublisher && list.length < limit && Date.now() - started < budgetMs) {
      const q = `PUBLISHER:"${p}" AND OPEN_ACCESS:y AND IN_PMC:y AND HAS_FT:y AND ${OA_TOPICS}`;
      const r = await getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=100&sort=P_PDATE_D%20desc&cursorMark=${encodeURIComponent(st.cursor)}&query=${encodeURIComponent(q)}`, { ttl: 0, timeout: 45000, retries: 2 });
      if (!r.ok) { out.errors.push(`${p}: Europe PMC search failed (${r.status || r.error})`); break; }
      st.total = r.data?.hitCount ?? st.total;
      const results = r.data?.resultList?.result || [];
      const nextCursor = r.data?.nextCursorMark;
      let used = 0;
      for (const x of results) {
        used++;
        if (!x.pmcid || done.has(x.pmcid) || list.some(l => l.pmcid === x.pmcid)) { out.skipped++; continue; }
        list.push({ pmcid: x.pmcid, meta: { doi: x.doi || null, title: x.title, journal: x.journalInfo?.journal?.title || x.journalTitle || null, year: x.pubYear || null, url: `https://pmc.ncbi.nlm.nih.gov/articles/${x.pmcid}/`, note: `Open access, ${p} (${x.license || 'licence on the article page'})` } });
        if (++taken >= perPublisher || list.length >= limit) break;
      }
      // the cursor moves on only when the whole page was used, so nothing on it is skipped
      if (used >= results.length) {
        const end = !results.length || !nextCursor || nextCursor === st.cursor;
        st.cursor = nextCursor || st.cursor;
        st.done = end;
      } else break;
    }
    state[p] = st;
    out.byPublisher[p] = taken;
  }
  await db.setMeta('imgref_pub_cursors', JSON.stringify(state));
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      if (Date.now() - started > budgetMs) { out.stoppedEarly = true; return; }
      const { pmcid, meta } = list[next++];
      await indexPmcPaper('publisher', pmcid, meta, out);
      update(`${pmcid}: ${out.papers} papers, ${out.panels} panels indexed (${next}/${list.length})`, 5 + next / Math.max(1, list.length) * 93);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  out.available = Object.fromEntries(publishers.map(p => [p, state[p]?.total ?? null]));
  out.errors = out.errors.slice(0, 30);
  return out;
}

/**
 * Daily growth of the image databases on the web platform (second cron): retracted cases first (until all are in),
 * then the publishers' open-access papers, then PubMed Central, each with part of the time budget.
 */
async function growImageDatabases({ budgetMs = 240000 } = {}) {
  const started = Date.now();
  const left = share => Math.max(0, Math.min(share, budgetMs - (Date.now() - started)));
  const out = {};
  out.retracted = await indexRetracted({ limit: 60, budgetMs: left(budgetMs * 0.4) }).catch(e => ({ error: e.message }));
  out.publisher = await indexPublisherOa({ limit: 50, budgetMs: left(budgetMs * 0.3) }).catch(e => ({ error: e.message }));
  out.pmc = await indexPmc({ limit: 40, budgetMs: left(budgetMs) }).catch(e => ({ error: e.message }));
  const brief = o => (o && !o.error ? { papers: o.papers, panels: o.panels, errors: (o.errors || []).length } : o);
  return { retracted: brief(out.retracted), publisher: brief(out.publisher), pmc: brief(out.pmc), seconds: Math.round((Date.now() - started) / 1000) };
}

const panelsOf = docId => db.all('SELECT id, figure, panel, type, w, h, (thumb_key IS NOT NULL) AS has_thumb FROM image_refs WHERE doc_id = $1 ORDER BY id', [docId]);
const thumbKey = async id => (await db.one('SELECT thumb_key FROM image_refs WHERE id = $1', [id]))?.thumb_key || null;

module.exports = {
  SOURCES, indexRsiid, indexBiofors, indexBinder, fingerprintFigures, storeDoc, deleteDoc, indexPjps, indexPjpsArticle, pjpsArticle, latestPjpsId, indexRetracted, indexPmc, indexPublisherOa, growImageDatabases, indexUpload,
  matchManuscript, candidates, loadIndex, status, sourceCounts, listDocs, panelsOf, thumbKey, refThumb, pearson, sameSeries, cleanSeries
};
