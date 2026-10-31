// xlsx.js - minimal reader for .xlsx workbooks (Elsevier's Scopus source list, the Retraction Watch hijacked journal
// checker export): sheet names and the cell values of one sheet as rows of strings. Formulas give their cached value.
const JSZip = require('jszip');

const unescape = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&');
// text of <t> runs, skipping phonetic hints (<rPh>)
const runs = xml => [...String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => unescape(m[1])).join('');
const colIndex = ref => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

async function openWorkbook(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const read = async name => (zip.file(name) ? zip.file(name).async('string') : '');
  const wb = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const target = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => [m[0].match(/Id="([^"]+)"/)?.[1], m[0].match(/Target="([^"]+)"/)?.[1]]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => {
    const t = target[m[0].match(/r:id="([^"]+)"/)?.[1]] || '';
    return { name: unescape(m[0].match(/name="([^"]*)"/)?.[1] || ''), path: t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.?\//, '')}` };
  });
  const strings = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => runs(m[1]));

  /** Rows of a sheet (by name, RegExp or index) as arrays of trimmed strings; empty trailing cells are dropped */
  async function rows(which) {
    const sheet = typeof which === 'number' ? sheets[which] : sheets.find(s => (which instanceof RegExp ? which.test(s.name) : s.name === which));
    if (!sheet) throw new Error(`Sheet not found: ${which}`);
    const xml = await read(sheet.path);
    const out = [];
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const row = [];
      for (const c of (r[1] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/\br="([A-Z]+\d+)"/)?.[1];
        const type = c[1].match(/\bt="([^"]+)"/)?.[1];
        const v = (c[2] || '').match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const value = type === 's' ? strings[+v] ?? '' : type === 'inlineStr' ? runs(c[2]) : v != null ? unescape(v) : '';
        row[ref ? colIndex(ref) : row.length] = String(value).trim();
      }
      out.push(Array.from(row, x => x ?? ''));
    }
    return out;
  }
  return { sheets: sheets.map(s => s.name), rows };
}

/** Rows below the first row that matches isHeader, as objects keyed by that row's headers */
function rowsToObjects(rows, isHeader) {
  const h = rows.findIndex(r => isHeader(r));
  if (h < 0) return [];
  const headers = rows[h].map((x, i) => x.replace(/\s+/g, ' ').trim() || `col${i + 1}`);
  return rows.slice(h + 1).filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((k, i) => [k, r[i] ?? ''])));
}

module.exports = { openWorkbook, rowsToObjects };
