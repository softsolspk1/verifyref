// csl.js - Module 2 journal styles from Citation Style Language (CSL) files, the format used by Zotero, Mendeley and
// most publishers: an uploaded .csl file, or any of the ~10,900 journal styles in the Zotero Style Repository found by
// typing the journal name. Formatting is done by citeproc-js (the reference CSL processor), so the output follows the
// style file exactly. Installed styles live in the meta table and are offered next to the built-in styles.
const fs = require('fs');
const path = require('path');
const CSL = require('citeproc');
const db = require('./db');

const KEY = 'csl_styles';
const LOCALES = Object.fromEntries(['en-US', 'en-GB'].map(l => [l, fs.readFileSync(path.join(__dirname, 'csl', `locales-${l}.xml`), 'utf8')]));
const REPO_INDEX = 'https://www.zotero.org/styles-files/styles.json';

// ------------------------------------------------------------------ style file

const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const unxml = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#38;|&amp;/g, '&').trim();

/** What the converter needs to know about a style file (and whether it is a usable one) */
function describe(xml) {
  const s = String(xml || '');
  if (!/<style\b[^>]*xmlns="http:\/\/purl\.org\/net\/xbiblio\/csl"/.test(s)) throw new Error('This is not a CSL style file (a .csl file starts with <style xmlns="http://purl.org/net/xbiblio/csl" …>).');
  const info = (s.match(/<info>([\s\S]*?)<\/info>/) || [])[1] || '';
  const title = unxml((info.match(/<title>([\s\S]*?)<\/title>/) || [])[1]) || 'Custom style';
  const id = unxml((info.match(/<id>([\s\S]*?)<\/id>/) || [])[1]);
  const parent = (info.match(/<link[^>]*rel="independent-parent"[^>]*>/) || [])[0];
  const format = attr((info.match(/<category[^>]*citation-format="[^"]*"[^>]*>/) || [''])[0], 'citation-format') || '';
  const kind = /numeric|label/.test(format) ? 'numeric' : format === 'note' ? 'note' : 'author-date';
  const citation = (s.match(/<citation\b[^>]*>[\s\S]*?<\/citation>/) || [''])[0];
  const layout = (citation.match(/<layout\b[^>]*>/) || [''])[0];
  return {
    title, id, kind, format, dependent: !!parent, parent: parent ? attr(parent, 'href') : null,
    hasBibliography: /<bibliography\b/.test(s),
    cite: {
      sup: attr(layout, 'vertical-align') === 'sup' || /vertical-align="sup"/.test((citation.match(/<text[^>]*variable="citation-number"[^>]*>/) || [''])[0]),
      open: unxml(attr(layout, 'prefix') ?? ''), close: unxml(attr(layout, 'suffix') ?? ''),
      and: /\band="symbol"/.test(citation) ? ' & ' : ' and ',
      etalFrom: parseInt(attr((citation.match(/<citation\b[^>]*>/) || [''])[0], 'et-al-min'), 10) || 3
    }
  };
}

// ------------------------------------------------------------------ records -> CSL-JSON

const TYPE = { 'journal-article': 'article-journal', article: 'article-journal', review: 'article-journal', book: 'book', monograph: 'book', 'edited-book': 'book', 'reference-book': 'book', 'book-chapter': 'chapter', chapter: 'chapter', 'book-section': 'chapter', report: 'report', thesis: 'thesis', dissertation: 'thesis', 'proceedings-article': 'paper-conference', preprint: 'article', 'posted-content': 'article', web: 'webpage', webpage: 'webpage', website: 'webpage', online: 'webpage', dataset: 'dataset' };

function toCsl(r, id) {
  const type = TYPE[String(r.type || '').toLowerCase()] || (r.journal ? 'article-journal' : r.publisher ? 'book' : 'article-journal');
  const out = {
    id, type, title: String(r.title || '').replace(/^(retracted|withdrawn)\s*:\s*/i, ''),
    // Vancouver-style initials written together ("SB") are two initials, as in the built-in styles
    author: (r.authors || []).filter(a => a && (a.family || a.name)).map(a => (a.corporate || !a.given ? { literal: a.family || a.name } : { family: a.family, given: /^[A-Z]{2,4}$/.test(a.given.trim()) ? a.given.trim().split('').join('. ') + '.' : a.given })),
    'container-title': r.journal || r.bookTitle || '', 'container-title-short': r.journalAbbrev || '', 'journalAbbreviation': r.journalAbbrev || '',
    volume: r.volume || '', issue: r.issue || '', page: String(r.pages || '').replace(/\s*[–—]\s*/g, '-'),
    DOI: r.doi || '', URL: r.url && !r.doi ? r.url : '', publisher: r.publisher || '', 'publisher-place': r.place || '', edition: r.edition || ''
  };
  // a/b letters set by orderBibliography (2020a, 2020b) are kept as written
  if (r.year) out.issued = r.yearSuffix ? { literal: `${r.year}${r.yearSuffix}` } : { 'date-parts': [[parseInt(r.year, 10) || r.year]] };
  for (const k of Object.keys(out)) if (out[k] === '') delete out[k];
  return out;
}

// ------------------------------------------------------------------ citeproc output -> segments

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#38;': '&', '&#60;': '<', '&#62;': '>', '&nbsp;': ' ', '&#160;': ' ' };
const decode = s => s.replace(/&(?:amp|lt|gt|quot|nbsp|#38|#60|#62|#160);/g, m => ENT[m]).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));

/** citeproc HTML -> [{ t, i?, b?, sup? }] (italic, bold, superscript kept; links, divs and spans dropped) */
function segments(html) {
  const s = String(html || '').replace(/<div class="csl-left-margin">[\s\S]*?<\/div>/g, '').replace(/<\/?div[^>]*>/g, '').trim();
  const out = [];
  let i = 0, b = 0, sup = 0;
  for (const part of s.split(/(<[^>]+>)/)) {
    if (!part) continue;
    if (part[0] === '<') {
      const close = part[1] === '/';
      const tag = (part.match(/^<\/?\s*([a-z]+)/i) || [])[1]?.toLowerCase();
      const style = part.match(/font-style:\s*italic|font-weight:\s*bold|vertical-align:\s*sup/);
      if (tag === 'i' || tag === 'em' || (tag === 'span' && /italic/.test(style?.[0] || ''))) i += close ? -1 : 1;
      else if (tag === 'b' || tag === 'strong') b += close ? -1 : 1;
      else if (tag === 'sup') sup += close ? -1 : 1;
      continue;
    }
    const t = decode(part);
    if (t) out.push({ t, ...(i > 0 ? { i: true } : {}), ...(b > 0 ? { b: true } : {}), ...(sup > 0 ? { sup: true } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------ a style object the converter can use

/** Built from the style file (and, for a dependent journal style, its parent's file) */
function makeStyle(entry) {
  const xml = entry.parentXml || entry.xml;
  const d = describe(entry.xml);
  const base = entry.parentXml ? describe(entry.parentXml) : d;
  const items = new Map();
  let seq = 0; // citeproc caches items by id: every render gets new ids
  const engine = new CSL.Engine({ retrieveLocale: lang => LOCALES[lang] || LOCALES['en-US'], retrieveItem: id => items.get(id) }, xml, 'en-US');
  const bib = r => {
    items.clear();
    const id = `r${++seq}`;
    items.set(id, toCsl(r, id));
    engine.updateItems([id]);
    const [, entries] = engine.makeBibliography() || [null, []];
    return segments(entries[0] || '');
  };
  const style = {
    label: entry.title || d.title, kind: d.kind === 'numeric' || base.kind === 'numeric' ? 'numeric' : d.kind === 'note' || base.kind === 'note' ? 'note' : 'author-date',
    csl: true, source: entry.source || 'uploaded',
    cite: { sup: base.cite.sup, open: base.cite.open || '[', close: base.cite.close || ']', and: base.cite.and, etalFrom: base.cite.etalFrom, yearSep: ', ' },
    article: bib, book: bib, chapter: bib, web: bib,
    /** author-date in-text citation from the style file itself */
    citation(records) {
      items.clear();
      const ids = records.map(r => { const id = `c${++seq}`; items.set(id, toCsl(r, id)); return id; });
      engine.updateItems(ids);
      return segments(engine.makeCitationCluster(ids.map(id => ({ id }))));
    }
  };
  if (style.kind === 'numeric' && !base.cite.open && !base.cite.sup) { style.cite.open = '['; style.cite.close = ']'; }
  return style;
}

// ------------------------------------------------------------------ installed styles

let cache = { at: 0, entries: {} };
const built = new Map();

/** Installed styles, re-read from the database at most once a minute (several server instances on Vercel) */
async function ensure(force = false) {
  if (!force && Date.now() - cache.at < 60000) return cache.entries;
  let entries = {};
  try { entries = JSON.parse((await db.getMeta(KEY)) || '{}'); } catch (e) { entries = cache.entries; }
  for (const k of built.keys()) if (!entries[k] || entries[k].at !== built.get(k).at) built.delete(k);
  cache = { at: Date.now(), entries };
  return entries;
}

/** The style object for an installed style key ("csl:<name>"), or null */
function get(key) {
  if (!String(key || '').startsWith('csl:')) return null;
  const e = cache.entries[key];
  if (!e) return null;
  if (!built.has(key)) {
    try { built.set(key, { at: e.at, style: makeStyle(e) }); } catch (err) { return null; }
  }
  return built.get(key).style;
}

const list = () => Object.entries(cache.entries).map(([key, e]) => ({ key, label: `${e.title} (CSL)`, kind: e.kind, custom: true, source: e.source, by: e.by, at: e.at }));

const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'style';

/** Install a style file. Dependent styles need their parent; fetchParent(url) returns its XML. */
async function install(xml, { by = null, source = 'uploaded', fetchParent = null, name = null } = {}) {
  const d = describe(xml);
  let parentXml = null;
  if (d.dependent) {
    if (!fetchParent) throw new Error(`“${d.title}” is a journal alias of another style (${d.parent}); upload that style file instead, or find the journal by name.`);
    parentXml = await fetchParent(d.parent);
    describe(parentXml);
  } else if (!d.hasBibliography) throw new Error('This style has no bibliography layout.');
  const entry = { title: d.title, kind: d.kind, xml, parentXml, source, by, at: new Date().toISOString(), id: d.id };
  makeStyle(entry).article({ authors: [{ family: 'Khan', given: 'Ahmad' }], title: 'Test', journal: 'Pak J Pharm Sci', year: 2024, volume: '37', issue: '1', pages: '1-5' }); // fails here on a broken file
  const entries = await ensure(true);
  const key = `csl:${slug(name || (d.id ? d.id.split('/').pop() : d.title))}`;
  entries[key] = entry;
  await db.setMeta(KEY, JSON.stringify(entries));
  cache.at = 0;
  await ensure(true);
  return { key, title: d.title, kind: d.kind };
}

async function remove(key) {
  const entries = await ensure(true);
  delete entries[key];
  await db.setMeta(KEY, JSON.stringify(entries));
  built.delete(key);
  cache.at = 0;
  await ensure(true);
}

// ------------------------------------------------------------------ Zotero Style Repository

let repo = null;
async function repository() {
  if (repo && Date.now() - repo.at < 24 * 3600e3) return repo.list;
  const r = await fetch(REPO_INDEX, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`The Zotero Style Repository did not answer (HTTP ${r.status}).`);
  const list = (await r.json()).map(s => ({ name: s.name, title: s.title, short: s.titleShort || '', format: s.categories?.format || '', fields: s.categories?.fields || [], dependent: !!s.dependent }));
  repo = { at: Date.now(), list };
  return list;
}

/** Journal styles whose title (or short title) matches the words typed, best first */
async function find(q, limit = 20) {
  const words = String(q || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);
  if (!words.length) return [];
  const list = await repository();
  const norm = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ');
  const scored = [];
  for (const s of list) {
    const t = norm(`${s.title} ${s.short}`);
    if (!words.every(w => t.includes(w))) continue;
    const exact = norm(s.title).trim() === words.join(' ') || norm(s.short).trim() === words.join(' ');
    scored.push({ ...s, score: (exact ? 100 : 0) + (t.startsWith(words[0]) ? 10 : 0) - s.title.length / 100 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

async function fetchStyle(urlOrName) {
  const name = String(urlOrName).replace(/^https?:\/\/www\.zotero\.org\/styles\//, '').replace(/[^a-z0-9-]/gi, '');
  const r = await fetch(`https://www.zotero.org/styles/${name}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`The style “${name}” could not be downloaded (HTTP ${r.status}).`);
  return r.text();
}

/** Install a repository style by name (a dependent journal style brings its parent) */
async function installFromRepository(name, by) {
  return install(await fetchStyle(name), { by, source: 'Zotero Style Repository', fetchParent: fetchStyle, name });
}

module.exports = { describe, toCsl, segments, makeStyle, ensure, get, list, install, remove, find, installFromRepository, fetchStyleXml: fetchStyle, LOCALES };
