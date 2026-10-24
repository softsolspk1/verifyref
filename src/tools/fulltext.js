// tools/fulltext.js - source texts for claim checking: open-access full text (Europe PMC), abstracts (OpenAlex,
// Europe PMC), and uploaded PDFs split by page and linked to references by DOI or title.
const S = require('../sources');
const { getJson, getText } = require('../http');
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

/** Abstract for a record: OpenAlex first, Europe PMC second */
async function abstractOf(record) {
  if (record.abstract && record.abstract.length > 200) return { text: record.abstract, origin: 'Abstract' };
  if (record.doi) {
    const oa = await S.openalexDoi(record.doi);
    if (oa.record?.abstract?.length > 100) return { text: oa.record.abstract, origin: 'Abstract (OpenAlex)' };
  }
  const core = await europePmcCore(record);
  if (core?.abstractText) return { text: xmlText(core.abstractText), origin: 'Abstract (Europe PMC)' };
  return null;
}

/** Best available source text: uploaded file > open full text > abstract */
async function sourceTextFor(record, upload) {
  if (upload) return { pages: upload.pages, origin: `Uploaded file ${upload.name}`, fullText: true, uploaded: true };
  if (!record) return null;
  const ft = await openFullText(record).catch(() => null);
  if (ft) return { pages: [{ page: null, text: ft.text }], origin: ft.origin, url: ft.url, fullText: true };
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

module.exports = { openFullText, abstractOf, sourceTextFor, filePages, linkUploads, europePmcCore, xmlText, invertedIndexToText };
