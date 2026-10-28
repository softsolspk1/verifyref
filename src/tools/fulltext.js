// tools/fulltext.js - source texts for claim checking: open-access full text (Europe PMC), abstracts (OpenAlex,
// Europe PMC), and uploaded PDFs split by page and linked to references by DOI or title.
const S = require('../sources');
const { getJson, getText, getBuffer } = require('../http');
const { cleanDoi, titleContains, invertedIndexToText } = require('../text');

const enc = encodeURIComponent;

function xmlText(xml) {
  return String(xml || '')
    .replace(/<(table-wrap|fig|ref-list|back|front|xref)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<\/(p|title|sec)>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    // brackets left empty by removed cross-references: "[ , , ]", "( ; )"
    .replace(/\[[\s,;–\-]*\]|\([\s,;–\-]*\)/g, '')
    .replace(/[ \t]+/g, ' ').replace(/ ([.,;:])/g, '$1').replace(/,(?=[,.;])/g, '').replace(/\n\s+/g, '\n').trim();
}

/** Europe PMC core record for a DOI / PMID (abstract, OA status, PMCID) */
async function europePmcCore({ doi, pmid }) {
  const q = doi ? `DOI:"${doi}"` : pmid ? `EXT_ID:${pmid} AND SRC:MED` : null;
  if (!q) return null;
  const r = await getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${enc(q)}&resultType=core&format=json&pageSize=1`, { ttl: 30 * 86400 });
  return (r.ok && r.data.resultList?.result?.[0]) || null;
}

/** Open-access full text for a record, or null */
async function openFullText(record) {
  const core = await europePmcCore(record);
  if (!core?.pmcid || core.isOpenAccess !== 'Y') return null;
  const r = await getText(`https://www.ebi.ac.uk/europepmc/webservices/rest/${core.pmcid}/fullTextXML`, { ttl: 30 * 86400, timeout: 30000 });
  if (!r.ok || !r.text) return null;
  const body = (r.text.match(/<body>([\s\S]*?)<\/body>/) || [])[1] || r.text;
  const text = xmlText(body);
  return text.length > 500 ? { text, origin: 'Open-access full text (Europe PMC)', url: `https://europepmc.org/article/PMC/${core.pmcid}` } : null;
}

/** Legal open-access PDF found through Unpaywall (publisher or repository copy) -> [{ page, text }], or null */
async function unpaywallFullText(record) {
  if (!record?.doi) return null;
  const cfg = require('../config');
  const r = await getJson(`https://api.unpaywall.org/v2/${enc(record.doi)}?email=${enc(cfg.CONTACT_EMAIL)}`, { ttl: 30 * 86400, timeout: 15000, retries: 1 });
  // url_for_pdf, or a repository link that is itself a PDF; publishers often refuse automated downloads, so try up to 3
  const pdfUrl = l => l?.url_for_pdf || (/\.pdf(?:$|[?#])/i.test(l?.url || '') ? l.url : null);
  const urls = r.ok && r.data?.is_oa ? [...new Set([r.data.best_oa_location, ...(r.data.oa_locations || [])].map(pdfUrl).filter(Boolean))] : [];
  for (const url of urls.slice(0, 3)) {
    const loc = (r.data.oa_locations || []).find(l => pdfUrl(l) === url) || r.data.best_oa_location;
    const pdf = await getBuffer(url, { timeout: 30000 });
    if (!pdf.ok || pdf.buffer.length > 30 * 1024 * 1024 || pdf.buffer.slice(0, 5).toString() !== '%PDF-') continue;
    const pages = await filePages(pdf.buffer, 'source.pdf').catch(() => null);
    if (pages && pages.reduce((n, p) => n + p.text.length, 0) > 1500) {
      return { pages, origin: `Open-access full text (Unpaywall: ${loc.host_type === 'repository' ? 'repository copy' : 'publisher'})`, url };
    }
  }
  return null;
}

/** A downloaded PDF -> pages when it reads as a real paper, else null */
async function pdfPages(url) {
  const pdf = await getBuffer(url, { timeout: 30000 });
  if (!pdf.ok || pdf.buffer.length > 30 * 1024 * 1024 || pdf.buffer.slice(0, 5).toString() !== '%PDF-') return null;
  const pages = await filePages(pdf.buffer, 'source.pdf').catch(() => null);
  return pages && pages.reduce((n, p) => n + p.text.length, 0) > 1500 ? pages : null;
}

/** Open-access PDF locations listed by OpenAlex (publisher and repository copies) */
async function openalexFullText(record) {
  if (!record?.doi) return null;
  const oa = record.pdfUrls ? { record } : await S.openalexDoi(record.doi);
  for (const url of (oa.record?.pdfUrls || []).slice(0, 3)) {
    const pages = await pdfPages(url).catch(() => null);
    if (pages) return { pages, origin: 'Open-access full text (OpenAlex location)', url };
  }
  return null;
}

/** CORE (core.ac.uk): the full text itself with an API key, otherwise its open-access PDF */
async function coreFullText(record) {
  if (!record?.doi && !record?.title) return null;
  const c = record.source === 'CORE' ? { record } : record.doi ? await S.coreDoi(record.doi) : null;
  const rec = c?.record;
  if (!rec) return null;
  if (rec.fullText) return { pages: [{ page: null, text: rec.fullText }], origin: 'Open-access full text (CORE)', url: rec.url };
  if (rec.pdfUrl) {
    const pages = await pdfPages(rec.pdfUrl).catch(() => null);
    if (pages) return { pages, origin: 'Open-access full text (CORE)', url: rec.pdfUrl };
  }
  return null;
}

/** Abstract for a record: OpenAlex first, Europe PMC second, CORE third */
async function abstractOf(record) {
  if (record.abstract && record.abstract.length > 200) return { text: record.abstract, origin: 'Abstract' };
  if (record.doi) {
    const oa = await S.openalexDoi(record.doi);
    if (oa.record?.abstract?.length > 100) return { text: oa.record.abstract, origin: 'Abstract (OpenAlex)' };
  }
  const core = await europePmcCore(record);
  if (core?.abstractText) return { text: xmlText(core.abstractText), origin: 'Abstract (Europe PMC)' };
  if (record.doi) {
    const c = await S.coreDoi(record.doi).catch(() => null);
    if (c?.record?.abstract?.length > 100) return { text: c.record.abstract, origin: 'Abstract (CORE)' };
  }
  return null;
}

/** Best available source text: uploaded file > open full text > abstract */
async function sourceTextFor(record, upload) {
  if (upload) return { pages: upload.pages, origin: `Uploaded file ${upload.name}`, fullText: true, uploaded: true };
  if (!record) return null;
  const ft = await openFullText(record).catch(() => null);
  if (ft) return { pages: [{ page: null, text: ft.text }], origin: ft.origin, url: ft.url, fullText: true };
  const up = await unpaywallFullText(record).catch(() => null);
  if (up) return { pages: up.pages, origin: up.origin, url: up.url, fullText: true };
  for (const fn of [openalexFullText, coreFullText]) {
    const r = await fn(record).catch(() => null);
    if (r) return { pages: r.pages, origin: r.origin, url: r.url, fullText: true };
  }
  const ab = await abstractOf(record).catch(() => null);
  if (ab) return { pages: [{ page: null, text: ab.text }], origin: ab.origin, fullText: false };
  return null;
}

/** PDF / text upload -> [{ page, text }] */
async function filePages(buffer, name) {
  if (/\.pdf$/i.test(name)) {
    const pdfParse = require('pdf-parse');
    const pages = [];
    await pdfParse(buffer, {
      pagerender: pageData => pageData.getTextContent({ normalizeWhitespace: true }).then(tc => {
        let last, text = '';
        for (const item of tc.items) {
          text += (last !== undefined && last !== item.transform[5] ? '\n' : ' ') + item.str;
          last = item.transform[5];
        }
        pages.push({ page: pageData.pageIndex + 1, text: text.replace(/([a-z])-\n([a-z])/g, '$1$2').replace(/\n(?=[a-z])/g, ' ') });
        return text;
      })
    });
    return pages.sort((a, b) => a.page - b.page);
  }
  if (/\.docx$/i.test(name)) {
    const { value } = await require('mammoth').extractRawText({ buffer });
    return [{ page: null, text: value }];
  }
  return [{ page: null, text: buffer.toString('utf8') }];
}

/**
 * Link uploaded files to references. files: [{ name, pages }]; refs: [{ index, record, parsed }]
 * Returns Map(refIndex -> file) and the list of files that could not be linked.
 */
function linkUploads(files, refs, manual = {}) {
  const map = new Map();
  const unlinked = [];
  for (const f of files) {
    if (manual[f.name]) { map.set(Number(manual[f.name]), f); continue; }
    const head = f.pages.slice(0, 2).map(p => p.text).join('\n').slice(0, 6000);
    const doi = cleanDoi((head.match(/10\.\d{4,9}\/[^\s"<>]+/) || [])[0]);
    let hit = doi ? refs.find(r => (r.record?.doi || r.parsed?.doi) === doi) : null;
    if (!hit) {
      const scored = refs.map(r => ({ r, s: titleContains(head, r.record?.title || r.parsed?.title || '') })).sort((a, b) => b.s - a.s);
      if (scored[0]?.s >= 0.8) hit = scored[0].r;
    }
    if (hit && !map.has(hit.index)) map.set(hit.index, f);
    else unlinked.push(f.name);
  }
  return { map, unlinked };
}

module.exports = { openFullText, unpaywallFullText, openalexFullText, coreFullText, abstractOf, sourceTextFor, filePages, linkUploads, europePmcCore, xmlText, invertedIndexToText };
