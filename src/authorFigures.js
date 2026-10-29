// authorFigures.js - Module 5.6: figures from the authors' own open-access papers (Europe PMC) compared with the figures of
// the manuscript. Self-plagiarism and re-use of a figure from an earlier paper by the same authors is the commonest
// image-integrity problem that a comparison inside one manuscript cannot see.
//   1. Europe PMC search for open-access papers of each author (ORCID when given, otherwise "Surname Initial")
//   2. figures taken from the full-text XML, downloaded, split into panels and fingerprinted (same hash as the browser)
//   3. each panel hash compared with the manuscript's panel hashes in all 8 orientations
const { getJson, USER_AGENT } = require('./http');

const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const MAX_ARTICLES = 10;          // in total, newest first
const PER_AUTHOR = 5;
const MAX_FIGS_PER_ARTICLE = 8;
const MATCH_DISTANCE = 6;         // of 64 bits, as for earlier PJPS manuscripts

/** Plain download (no database cache: full texts and figures are large). Returns { ok, status, buffer } */
async function download(url, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } });
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, buffer };
  } catch (e) {
    return { ok: false, status: 0, buffer: null, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(timer); }
}

let engine = null;
async function loadEngine() {
  if (!engine) engine = await import('../public/js/images/engine.js');
  return engine;
}

const popcnt = v => { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
const parse = hex => [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0];
const dist = (a, b) => popcnt(a[0] ^ b[0]) + popcnt(a[1] ^ b[1]);

function authorQuery(a) {
  const orcid = String(a.orcid || '').match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/)?.[0];
  if (orcid) return `AUTHORID:"${orcid}" AND OPEN_ACCESS:y`;
  const family = String(a.family || '').replace(/["()]/g, '').trim();
  const initial = String(a.given || '').trim()[0];
  if (!family) return null;
  return `AUTH:"${family}${initial ? ' ' + initial.toUpperCase() : ''}" AND OPEN_ACCESS:y AND HAS_FT:y`;
}

async function articlesOf(author) {
  const q = authorQuery(author);
  if (!q) return [];
  const r = await getJson(`${EPMC}/search?query=${encodeURIComponent(q)}&format=json&resultType=lite&pageSize=${PER_AUTHOR}&sort=P_PDATE_D%20desc`, { ttl: 7 * 86400, timeout: 20000, retries: 1 });
  if (!r.ok) return [];
  return (r.data?.resultList?.result || []).filter(x => x.pmcid).map(x => ({ pmcid: x.pmcid, title: x.title, year: x.pubYear, doi: x.doi, journal: x.journalTitle || '', author: `${author.given || ''} ${author.family || ''}`.trim() }));
}

/** Figure list of an open-access article, from its PMC page: [{ label, caption, url }] */
async function figuresOf(pmcid) {
  const r = await download(`https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`);
  if (!r.ok || !r.buffer) return [];
  const html = r.buffer.toString('utf8');
  const figs = [];
  const seen = new Set();
  for (const m of html.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/g)) {
    const url = (m[1].match(/<img\b[^>]*\bsrc="(https:\/\/cdn\.ncbi\.nlm\.nih\.gov\/pmc\/blobs\/[^"]+)"/) || [])[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const label = (m[1].match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/) || [])[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || `Figure ${figs.length + 1}`;
    const caption = (m[1].match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/) || [])[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || '';
    figs.push({ label: label.slice(0, 60), caption, url });
    if (figs.length >= MAX_FIGS_PER_ARTICLE) break;
  }
  return figs;
}

/** Download a figure and decode it to { width, height, data(RGBA) } (PNG, JPEG, and WebP as PMC now serves) */
async function fetchImage(url) {
  const r = await download(url);
  if (!r.ok || !r.buffer || r.buffer.length < 2000) return null;
  const img = await require('./figureFiles').decodeAny(r.buffer);
  return img ? { ...img, url } : null;
}

/**
 * Open-access works of an author in OpenAlex (by ORCID, else by name): papers outside PubMed Central are compared
 * through their open-access PDF (publisher / repository copy, or CORE). [{ key, pmcid, pdfUrls, title, ... }]
 */
async function openalexArticlesOf(author) {
  const S = require('./sources');
  const orcid = String(author.orcid || '').match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/)?.[0];
  const name = `${author.given || ''} ${author.family || ''}`.trim();
  if (!orcid && !author.family) return [];
  const filter = orcid ? `authorships.author.orcid:${orcid}` : `raw_author_name.search:${name.replace(/[,|:]/g, ' ')}`;
  const r = await S.openalex(`works?filter=${encodeURIComponent(filter)},open_access.is_oa:true&sort=publication_date:desc&per-page=${PER_AUTHOR}`, { ttl: 7 * 86400, timeout: 20000, retries: 1 });
  if (!r.ok) return [];
  return (r.data?.results || []).map(S.fromOpenAlex).map(w => ({ key: w.pmcid || w.doi || w.openalexId, pmcid: w.pmcid, pdfUrls: w.pdfUrls, title: w.title, year: w.year, doi: w.doi, journal: w.journal, author: name, url: w.url, via: 'OpenAlex' }));
}

/** Figures of a paper that is not in PMC, taken from its open-access PDF (OpenAlex locations, then CORE) */
async function pdfFiguresOf(art) {
  const urls = [...(art.pdfUrls || [])];
  if (!urls.length && art.doi) {
    const c = await require('./sources').coreDoi(art.doi, art.title).catch(() => null);
    if (c?.record?.pdfUrl) { urls.push(c.record.pdfUrl); art.via = `${art.via} + CORE`; }
  }
  for (const url of urls.slice(0, 2)) {
    const r = await download(url, 60000);
    if (!r.ok || !r.buffer || r.buffer.length > 60e6 || r.buffer.slice(0, 5).toString() !== '%PDF-') continue;
    const { images } = require('./figureFiles').pdfImages(r.buffer, { max: MAX_FIGS_PER_ARTICLE * 3 });
    if (images.length) return images.slice(0, MAX_FIGS_PER_ARTICLE).map(im => ({ label: im.label, caption: '', img: { ...im, url } }));
  }
  return [];
}

/**
 * input: { authors: [{ given, family, orcid? }], panels: [{ id, label, hashes: [8 hex] }] }
 * Returns { checked: { authors, articles, figures, panels }, matches: [...], articles: [...] }
 */
async function checkAuthorFigures(input, update = () => {}) {
  const E = await loadEngine();
  const authors = (input.authors || []).filter(a => a.family || a.orcid).slice(0, 8);
  const mine = (input.panels || []).filter(p => Array.isArray(p.hashes) && p.hashes.length === 8 && p.hashes.every(h => /^[0-9a-f]{16}$/.test(h))).slice(0, 300)
    .map(p => ({ id: p.id, label: p.label, hv: p.hashes.map(parse) }));
  const out = { checked: { authors: authors.length, articles: 0, figures: 0, panels: 0, noFullText: 0 }, matches: [], articles: [], note: '' };
  if (!authors.length) { out.note = 'No author names were given, so no earlier papers were searched.'; return out; }
  if (!mine.length) { out.note = 'The manuscript has no figure panels to compare.'; return out; }

  update('Searching Europe PMC and OpenAlex for open-access papers of the authors', 5);
  const seen = new Set(), articles = [];
  const add = art => { const k = String(art.pmcid || art.doi || art.key || '').toLowerCase(); if (!k || seen.has(k) || (art.doi && seen.has(String(art.doi).toLowerCase()))) return; seen.add(k); if (art.doi) seen.add(String(art.doi).toLowerCase()); articles.push(art); };
  for (const a of authors) {
    const [epmc, oalex] = await Promise.all([articlesOf(a).catch(() => []), openalexArticlesOf(a).catch(() => [])]);
    epmc.forEach(x => add({ ...x, via: 'Europe PMC' }));
    oalex.forEach(add);
  }
  // newest first, PMC papers (figure files) before PDF-only papers
  const list = articles.sort((x, y) => (Number(y.year) || 0) - (Number(x.year) || 0) || (x.pmcid ? 0 : 1) - (y.pmcid ? 0 : 1)).slice(0, MAX_ARTICLES);
  out.checked.articles = list.length;
  if (!list.length) { out.note = 'No open-access papers of these authors were found in Europe PMC, OpenAlex or CORE (their earlier figures could not be compared).'; return out; }

  let done = 0;
  for (const art of list) {
    update(`Comparing figures of ${art.pmcid || art.doi || art.title} (${++done}/${list.length})`, 10 + done / list.length * 85);
    const figs = art.pmcid ? await figuresOf(art.pmcid).catch(() => []) : await pdfFiguresOf(art).catch(() => []);
    if (!figs.length) { out.checked.noFullText++; out.articles.push({ ...art, figures: 0, matched: 0 }); continue; }
    let matched = 0, nFig = 0;
    for (const f of figs) {
      const img = f.img || await fetchImage(f.url).catch(() => null);
      if (!img || img.width < 80 || img.height < 80) continue;
      nFig++;
      const gray = E.toGray(img);
      const boxes = E.splitPanels(img);
      for (const b of (boxes.length ? boxes : [{ x: 0, y: 0, w: img.width, h: img.height }])) {
        if (b.w < 48 || b.h < 48) continue;
        const theirs = E.hashPanel(img, b, gray);
        if (theirs.blank) continue;
        out.checked.panels++;
        const h0 = parse(theirs.hashes[0]);
        for (const m of mine) {
          const d = Math.min(...m.hv.map(x => dist(x, h0)));
          if (d <= MATCH_DISTANCE) {
            matched++;
            out.matches.push({ panel: m.id, panelLabel: m.label, pmcid: art.pmcid, article: art.title, year: art.year, journal: art.journal, doi: art.doi, author: art.author, figure: f.label, caption: f.caption, distance: d, url: art.pmcid ? `https://pmc.ncbi.nlm.nih.gov/articles/${art.pmcid}/` : art.url, imageUrl: img.url, via: art.via });
          }
        }
      }
    }
    out.checked.figures += nFig;
    out.articles.push({ ...art, figures: nFig, matched });
  }
  out.matches.sort((a, b) => a.distance - b.distance);
  out.matches = out.matches.slice(0, 40);
  return out;
}

module.exports = { checkAuthorFigures, articlesOf, openalexArticlesOf, figuresOf, pdfFiguresOf, fetchImage, authorQuery };
