// tools/restyle.js - Reference Style converter: restyles the reference list and in-text citations of a Word document
// (or a pasted list) into any supported style. Entries are matched to their registered records first so missing DOIs,
// issues and pages are filled in; entries without a reliable match are formatted from the text as written and flagged.
const P = require('../parse');
const ST = require('../styles');
const { Docx } = require('../ooxml');
const { verifyReference } = require('../checks/reference');
const { isOnline } = require('../http');
const { surnameKey, stripDiacritics } = require('../text');
const { checkCompliance } = require('../checks/compliance');

const REF_HEADING = /^\s*(?:\d+\.?\s*)?(references?|bibliography|literature cited|works cited|reference list|cited literature)\s*:?\s*$/i;
const END_HEADING = /^\s*(?:appendix|appendices|tables?|figure legends|figure captions|supplementary (?:material|information)|author contributions|conflicts? of interest|acknowledge?ments?)\b/i;

const famKey = s => surnameKey(stripDiacritics(s || ''));

function recordFromParsed(ref) {
  return {
    authors: (ref.authors || []).map(a => ({ given: a.given || '', family: a.family || '' })),
    title: ref.title, journal: ref.journal, year: ref.year, yearSuffix: ref.yearSuffix || '', volume: ref.volume, issue: ref.issue,
    pages: ref.pages, doi: ref.doi, type: ref.looksLikeBook ? 'book' : 'journal-article', url: (ref.urls || [])[0]
  };
}

/** Prefer registered values, keep what only the author supplied; list the fields that were filled in */
function mergeRecord(rec, ref) {
  const filled = [];
  for (const [k, label] of [['doi', 'DOI'], ['issue', 'issue'], ['pages', 'pages'], ['volume', 'volume']]) if (!ref[k] && rec[k]) filled.push(label);
  const corrected = [];
  if (ref.year && rec.year && Number(ref.year) !== Number(rec.year)) corrected.push('year');
  if (ref.pages && rec.pages && String(ref.pages).split(/[-–]/)[0] !== String(rec.pages).split(/[-–]/)[0]) corrected.push('pages');
  // Never change the author list silently: report it when the registered record has a different number of authors
  if (ref.authors?.length && rec.authors?.length && ref.authors.length !== rec.authors.length && !/\bet al/i.test(ref.raw || '')) corrected.push(`author list (${ref.authors.length} as written, ${rec.authors.length} in the record)`);
  return {
    record: {
      authors: rec.authors?.length ? rec.authors : ref.authors, title: rec.title || ref.title, journal: rec.journal || ref.journal, journalAbbrev: rec.journalAbbrev,
      year: rec.year || ref.year, yearSuffix: ref.yearSuffix || '', volume: rec.volume || ref.volume, issue: rec.issue || ref.issue, pages: rec.pages || ref.pages,
      doi: rec.doi || ref.doi, publisher: rec.publisher, type: rec.type, url: rec.url
    },
    filled, corrected
  };
}

/** Resolve every reference to a record for formatting. lookup=false (or offline) formats from the text as written. */
async function resolveRecords(refs, { lookup = true, onProgress } = {}) {
  const out = new Array(refs.length);
  const useLookup = lookup && isOnline();
  let next = 0, done = 0;
  async function worker() {
    while (next < refs.length) {
      const i = next++;
      const ref = refs[i];
      let item;
      if (useLookup) {
        try {
          const v = await verifyReference(ref);
          const ok = v.record && v.confidence >= 75 && !v.issues.some(x => ['doi-mismatch', 'doi-unregistered'].includes(x.code));
          if (ok) {
            const m = mergeRecord(v.record, ref);
            item = { record: m.record, status: 'matched', filled: m.filled, corrected: m.corrected, source: v.record.source };
          }
        } catch (e) { /* fall back to the parsed text */ }
      }
      if (!item) {
        const usable = (ref.authors || []).length && ref.title && ref.title.length > 8 && ref.year;
        item = usable ? { record: recordFromParsed(ref), status: 'parsed', filled: [], corrected: [] } : { record: null, status: 'kept', filled: [], corrected: [] };
      }
      item.ref = ref;
      out[i] = item;
      done++;
      if (onProgress) onProgress(done, refs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, refs.length) }, worker));
  return { items: out, lookedUp: useLookup };
}

function refNumber(raw, fallback) {
  const m = String(raw).match(/^\s*(?:\[(\d+)\]|(\d+)[.)])/);
  return m ? parseInt(m[1] || m[2], 10) : fallback;
}

function numberPrefix(style, n) {
  if (style === 'ieee') return `[${n}]\t`;
  if (style === 'acs') return `(${n}) `;
  return `${n}. `;
}

const stripNumber = raw => String(raw).replace(/^\s*(?:\[\d+\]|\(\d+\)|\d+[.)])\s*/, '');

/** Bibliography entries (in final order) for a style */
function buildBibliography(items, style) {
  const st = ST.getStyle(style);
  const ordered = ST.orderBibliography(items.map((it, i) => ({ ...it, pos: i })), style);
  return ordered.map((it, k) => {
    const segs = it.record ? ST.entry(it.record, style) : [{ t: stripNumber(it.ref.raw) }];
    const prefix = st.kind === 'numeric' ? numberPrefix(ST.styleKey(style), k + 1) : '';
    return { ...it, number: k + 1, segs, prefix, text: prefix + ST.toText(segs), html: (prefix ? ST.toHtml([{ t: prefix }]) : '') + ST.toHtml(segs) };
  });
}

// ------------------------------------------------------------------ pasted list

async function restyleList(text, style, opts = {}) {
  const { entries } = P.splitReferences(text);
  const refs = entries.map((e, i) => P.parseReferenceEntry(e, i + 1));
  if (!refs.length) throw new Error('No references found in the text.');
  const { items, lookedUp } = await resolveRecords(refs.slice(0, opts.max || 250), opts);
  items.forEach((it, i) => { it.firstCited = i; });
  const bib = buildBibliography(items, style);
  return summary(bib, style, lookedUp, { citationsConverted: 0, compliance: complianceOf(refs.slice(0, items.length), items, opts.body || '') });
}

/** Module 2: PJPS compliance of the references as submitted (expected form from the matched record) */
function complianceOf(refs, items, body) {
  return checkCompliance(refs, { records: items.map(it => it.record), body });
}

function summary(bib, style, lookedUp, extra) {
  return {
    style: ST.styleKey(style), styleLabel: ST.getStyle(style).label, lookedUp,
    entries: bib.map(b => ({ number: b.number, originalIndex: b.ref.index, original: b.ref.raw, text: b.text, html: b.html, status: b.status, filled: b.filled, corrected: b.corrected, source: b.source || null })),
    counts: { total: bib.length, matched: bib.filter(b => b.status === 'matched').length, parsed: bib.filter(b => b.status === 'parsed').length, kept: bib.filter(b => b.status === 'kept').length },
    ...extra
  };
}

// ------------------------------------------------------------------ Word document

/** Locate the reference list paragraphs: last "References" heading up to the next back-matter heading */
function locateReferences(docx) {
  const paras = docx.paragraphs();
  const texts = paras.map(p => docx.text(p));
  let h = -1;
  for (let i = texts.length - 1; i >= 0; i--) if (REF_HEADING.test(texts[i]) && texts[i].trim().length < 40) { h = i; break; }
  if (h < 0) return null;
  const refParas = [];
  for (let i = h + 1; i < paras.length; i++) {
    if (END_HEADING.test(texts[i]) && texts[i].trim().length < 60) break;
    if (texts[i].trim()) refParas.push({ p: paras[i], text: texts[i].trim() });
  }
  return { headingIndex: h, bodyParas: paras.slice(0, h), refParas };
}

/** Find citations in one paragraph of text. Returns [{ start, end, kind, nums?, parts?, narrative? }] */
function findCitations(text, system, maxRef, superscripts = []) {
  const found = [];
  const overlaps = (s, e) => found.some(f => s < f.end && e > f.start);
  if (system === 'numeric') {
    for (const m of text.matchAll(/\[(\s*\d{1,4}(?:\s*[-–—,]\s*\d{1,4})*\s*)\]/g)) {
      found.push({ start: m.index, end: m.index + m[0].length, kind: 'numeric', nums: P.expandRange(m[1].replace(/[–—]/g, '-')) });
    }
    for (const m of text.matchAll(/\((\s*\d{1,3}(?:\s*[-–—,]\s*\d{1,3})*\s*)\)/g)) {
      const nums = P.expandRange(m[1].replace(/[–—]/g, '-'));
      if (nums.length && nums.every(n => n >= 1 && n <= maxRef) && !overlaps(m.index, m.index + m[0].length)) found.push({ start: m.index, end: m.index + m[0].length, kind: 'numeric', nums });
    }
    for (const s of superscripts) {
      if (!/^[\d,\s–\-]+$/.test(s.text)) continue;
      const nums = P.expandRange(s.text.replace(/\s+/g, '').replace(/[–—]/g, '-'));
      if (nums.length && nums.every(n => n >= 1 && n <= maxRef) && !overlaps(s.start, s.end)) found.push({ start: s.start, end: s.end, kind: 'numeric', nums });
    }
    return found.sort((a, b) => a.start - b.start);
  }
  const NAME = "[\\p{Lu}][\\p{L}'’\\-]+(?:\\s(?:van|von|de|der|da|del|di|al|el|ul|ur)\\s[\\p{Lu}][\\p{L}'’\\-]+)?";
  const AUTH = `(${NAME}(?:\\s+et\\s+al\\.?|\\s*(?:,\\s*${NAME})*,?\\s*(?:&|and)\\s*${NAME})?)`;
  const YEARS = '((?:1[6-9]\\d{2}|20\\d{2})[a-z]?(?:\\s*,\\s*(?:1[6-9]\\d{2}|20\\d{2})[a-z]?)*)';
  const partRe = new RegExp(`^(?:(e\\.g\\.,?|see(?: also)?|cf\\.|i\\.e\\.,?)\\s+)?${AUTH},?\\s+${YEARS}$`, 'u');
  for (const m of text.matchAll(/\(([^()]{4,500}?(?:1[6-9]\d{2}|20\d{2})[a-z]?)\)/g)) {
    const parts = m[1].split(/\s*;\s*/).map(x => x.trim());
    const parsed = parts.map(x => x.match(partRe));
    if (!parsed.every(Boolean)) continue;
    found.push({
      start: m.index, end: m.index + m[0].length, kind: 'paren',
      prefix: parsed[0][1] ? parsed[0][1] + ' ' : '',
      parts: parsed.flatMap(pm => pm[3].split(/\s*,\s*/).map(y => ({ author: pm[2], year: y })))
    });
  }
  for (const m of text.matchAll(new RegExp(`${AUTH}\\s+\\(${YEARS}\\)`, 'gu'))) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    if (/^(?:In|The|This|These|Table|Figure|Fig|Since|From|During|Between|After|Before)$/i.test(m[1].split(/\s/)[0])) continue;
    found.push({ start: m.index, end: m.index + m[0].length, kind: 'narrative', parts: m[2].split(/\s*,\s*/).map(y => ({ author: m[1], year: y })) });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Match an author-year mention to a reference index */
function matchAuthorYear(part, refs) {
  const fam = famKey(part.author.replace(/\s+et\s+al\.?/i, '').split(/\s*(?:,|&|\band\b)\s*/)[0]);
  const ym = part.year.match(/^(\d{4})([a-z]?)$/);
  if (!ym) return -1;
  const cands = refs.map((r, i) => ({ r, i })).filter(({ r }) => famKey(r.authors?.[0]?.family) === fam && Number(r.year) === Number(ym[1]));
  if (!cands.length) return -1;
  if (cands.length === 1 || !ym[2]) return cands[0].i;
  return (cands.find(c => (c.r.yearSuffix || '') === ym[2]) || cands[ym[2].charCodeAt(0) - 97] || cands[0]).i;
}

async function restyleDocx(buffer, style, opts = {}) {
  const docx = await Docx.load(buffer);
  if (opts.track) docx.trackChanges(opts.trackAuthor);
  const loc = locateReferences(docx);
  if (!loc || !loc.refParas.length) throw new Error('No "References" heading with entries below it was found in the document.');
  const sKey = ST.styleKey(style);
  const st = ST.getStyle(sKey);
  const refs = loc.refParas.slice(0, opts.max || 250).map((rp, i) => P.parseReferenceEntry(rp.text, i + 1));
  const { items, lookedUp } = await resolveRecords(refs, opts);
  const origNumbers = refs.map((r, i) => refNumber(r.raw, i + 1));
  const byOrigNumber = new Map(origNumbers.map((n, i) => [n, i]));
  const bodyText = loc.bodyParas.map(p => docx.text(p)).join('\n');
  const { detectSystem } = require('../checks/citation');
  const system = detectSystem(bodyText, refs);

  // Pass 1: find citations and the order of first citation
  const perPara = [];
  const firstCited = new Array(refs.length).fill(null);
  let order = 0;
  for (const p of loc.bodyParas) {
    const text = docx.text(p);
    if (!text.trim()) continue;
    const cites = findCitations(text, system, refs.length, system === 'numeric' ? docx.superscriptRanges(p) : []);
    if (!cites.length) continue;
    for (const c of cites) {
      c.targets = c.kind === 'numeric'
        ? c.nums.map(n => byOrigNumber.get(n)).filter(i => i !== undefined)
        : c.parts.map(pt => matchAuthorYear(pt, refs));
      for (const i of c.targets) if (i >= 0 && firstCited[i] === null) firstCited[i] = order++;
    }
    perPara.push({ p, cites });
  }
  items.forEach((it, i) => { it.firstCited = firstCited[i] ?? (1e6 + i); });
  const bib = buildBibliography(items, sKey);
  const newNumber = new Map(bib.map(b => [b.ref.index - 1, b.number]));
  const recordOf = i => bib.find(b => b.ref.index - 1 === i)?.record || items[i].record || { authors: refs[i].authors, year: refs[i].year, title: refs[i].title };

  // Pass 2: rewrite citations
  let converted = 0, unresolved = 0;
  const noteNo = new Map(); // reference -> number of the footnote with its first (full) note
  let noteCounter = 0;
  if (st.kind === 'note') await docx.ensureFootnotes();
  for (const { p, cites } of perPara) {
    const edits = [];
    for (const c of cites) {
      const good = c.targets.filter(i => i >= 0);
      if (!good.length) { unresolved++; continue; }
      if (good.length < c.targets.length) unresolved += c.targets.length - good.length;
      let segs;
      if (st.kind === 'note') {
        noteCounter++;
        const notes = good.map(i => {
          const rec = recordOf(i);
          const full = !noteNo.has(i) || !st.shortNote;
          if (!noteNo.has(i)) noteNo.set(i, noteCounter);
          return ST.tidy([(full ? st.note : st.shortNote)(rec)]).map(sg => ({ ...sg, t: sg.t.replace('#', String(noteNo.get(i))) }));
        });
        // Several works in one note: "…: 92; A Siddiqui, …" — drop the closing full stop of all but the last
        const noteSegs = notes.flatMap((n, k) => {
          const segsK = n.map(x => ({ ...x }));
          if (k < notes.length - 1 && segsK.length) segsK[segsK.length - 1].t = segsK[segsK.length - 1].t.replace(/\.\s*$/, '');
          return k ? [{ t: '; ' }, ...segsK] : segsK;
        });
        const ref = docx.addFootnote(noteSegs);
        segs = c.kind === 'narrative' ? [{ t: ST.authorLabel(recordOf(good[0]), st.cite) }, ref] : [ref];
      } else if (st.kind === 'numeric') {
        const nums = good.map(i => newNumber.get(i)).filter(Boolean);
        const cite = ST.inText(sKey, { nums });
        segs = c.kind === 'narrative' ? [{ t: `${ST.authorLabel(recordOf(good[0]), { and: ' and ', etalFrom: 3 })} ` }, ...cite] : c.prefix ? [{ t: c.prefix }, ...cite] : cite;
      } else {
        const recs = good.map(recordOf);
        if (c.kind === 'narrative') {
          const ysep = st.cite.yearSep === null ? '' : ` (${recs.map(r => `${r.year || 'n.d.'}${r.yearSuffix || ''}`).join(', ')})`;
          segs = [{ t: `${ST.authorLabel(recs[0], st.cite)}${ysep}` }];
        } else {
          segs = ST.inText(sKey, { records: recs });
          if (c.prefix) segs = [{ t: `(${c.prefix}${ST.toText(segs).slice(1)}` }];
        }
      }
      // A space before a superscript / footnote mark is dropped: "text [3]." -> "text³."
      let start = c.start;
      const t = docx.text(p);
      if ((segs[0]?.sup || segs[0]?.node) && t[start - 1] === ' ') start--;
      edits.push({ start, end: c.end, segs });
      converted++;
    }
    if (edits.length) docx.replaceRanges(p, edits);
  }

  // Pass 3: rewrite the reference list in its new order, reusing the original paragraphs
  const refPs = loc.refParas.map(r => r.p);
  const autoNumbered = refPs.filter(p => docx.hasNumbering(p)).length > refPs.length / 2;
  bib.forEach((b, k) => {
    let p = refPs[k];
    if (!p) { p = docx.cloneParagraphAfter(refPs[refPs.length - 1], refPs[refPs.length - 1]); refPs.push(p); }
    const prefix = autoNumbered && st.kind === 'numeric' ? '' : b.prefix;
    docx.setParagraph(p, prefix ? [{ t: prefix }, ...b.segs] : b.segs);
    if (st.kind !== 'numeric') docx.removeNumbering(p);
  });
  for (let k = bib.length; k < loc.refParas.length; k++) docx.removeParagraph(refPs[k]);
  if (st.kind === 'note') {
    // Chicago notes-bibliography / OSCOLA keep an alphabetical bibliography; rename the heading accordingly
    const heading = docx.paragraphs()[loc.headingIndex];
    if (heading && /references?/i.test(docx.text(heading))) docx.setParagraph(heading, [{ t: 'Bibliography' }]);
  }

  const out = await docx.save();
  return {
    buffer: out,
    result: summary(bib, sKey, lookedUp, {
      citationSystem: system, citationsConverted: converted, unresolvedCitations: unresolved,
      uncited: items.filter((it, i) => firstCited[i] === null).map(it => it.ref.index),
      trackChanges: !!opts.track,
      compliance: complianceOf(refs, items, bodyText)
    })
  };
}

module.exports = { restyleList, restyleDocx, resolveRecords, buildBibliography, findCitations, locateReferences, recordFromParsed };
