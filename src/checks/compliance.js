// checks/compliance.js - Module 2 PJPS style compliance: every reference (and in-text citation) is checked rule by rule
// against the PJPS house style, and each deviation is reported with the expected form.
//   In text:  (Khan, 2019)  (Khan and Ali, 2019)  (Khan et al., 2019)  (Ali, 2018; Khan, 2019)
//   List:     Khan A, Ali B and Shah C (2019). Title of article. Pak. J. Pharm. Sci., 32(1): 1-5.
//   Book:     Khan A and Ali B (2019). Title. Publisher, Place.
//   Chapter:  Rall TW and Schleifer LS (1985). Title. In: Gilman AG, Murad F (eds.), Book, 7th ed., Publisher, Place, pp. 446-472.
//   Website:  World Health Organization (2020). Title. Available at: URL (Accessed 15 June 2020).
//   All authors are listed (no et al. in the list); source: pjps.pk/instructions/instructions-for-authors
//   Order:    alphabetical by first author, then year; 2019a / 2019b for the same author and year
const ST = require('../styles');
const { surnameKey, stripDiacritics, normalizeJournal } = require('../text');


const { ISO4, abbreviateJournal } = require('../abbrev');

const UNABBREVIATED = new RegExp(`\\b(${Object.entries(ISO4).filter(([k, v]) => v.endsWith('.') && v.toLowerCase() !== k).map(([k]) => k).join('|')})\\b`, 'i');

const stripNumber = raw => String(raw).replace(/^\s*(?:\[\d+\]|\(\d+\)|\d+[.)])\s*/, '').trim();
const famKey = s => surnameKey(stripDiacritics(s || ''));

/** Words of a title that look like ordinary words written with a capital (Title Case) */
function titleCaseRatio(title) {
  const words = String(title).split(/\s+/).slice(1).filter(w => /^[A-Za-z][a-z]{3,}[,:;]?$/.test(w) || /^[A-Z][a-z]{3,}[,:;]?$/.test(w));
  if (words.length < 3) return 0;
  return words.filter(w => /^[A-Z]/.test(w)).length / words.length;
}

/** Split a PJPS-like entry: authors (year). title. source */
function parts(text) {
  const m = text.match(/^(.*?)\s*\((\d{4}[a-z]?|n\.d\.)\)\s*\.?\s*(.*)$/);
  if (!m) return null;
  const rest = m[3];
  // Title ends at the first ". " followed by a capital letter (journal or publisher)
  const tm = rest.match(/^(.+?[.?!])\s+(?=[A-Z])(.*)$/);
  return { authors: m[1].trim(), year: m[2], title: tm ? tm[1].trim() : rest.trim(), source: tm ? tm[2].trim() : '' };
}

/**
 * Check one reference. ref: parsed entry; record: matched/merged record (optional) for the expected form.
 * Returns { index, original, expected, deviations: [{ rule, message, found, expected, severity }] }
 */
/** Journal name as written in the reference (PJPS layout first, then the general parser) */
function journalNameOf(ref, p = parts(stripNumber(ref.raw))) {
  return ((p?.source || '').split(/,|\s(?=\d)|\s(?=(?:vol|volume|no))/i)[0] || '').replace(/[,.\s]+$/, '').trim() || ref.journal || '';
}

function checkEntry(ref, record, nlm = null) {
  const text = stripNumber(ref.raw);
  const dev = [];
  const add = (rule, message, found = null, expected = null, severity = 'medium') => dev.push({ rule, message, found, expected, severity });
  const book = ref.looksLikeBook || (record && ST.isBook(record));
  const web = ref.type === 'webpage'; // organisation + URL: no journal, initials or volume rules
  const p = parts(text);

  // ---- authors
  const authorSeg = p ? p.authors : (text.split(/\(\d{4}|\.\s/)[0] || '');
  // PJPS instructions: "names and initials of all authors" - the reference list is never shortened with et al.
  if (/\bet\s+al\b/i.test(authorSeg)) add('authors', 'List all authors (names and initials); PJPS does not use “et al.” in the reference list', authorSeg);
  if (/&/.test(authorSeg)) add('authors', 'Use “and” before the last author, not “&”', '&', 'and', 'low');
  if (/,\s*and\s/.test(authorSeg)) add('authors', 'No comma before “and”', ', and', ' and', 'low');
  if (/\b[A-Z]\.\s?[A-Z]?\.?(?=,|\s+and\b|\s*$)/.test(authorSeg) || /\b[A-Z]\.[A-Z]\./.test(authorSeg)) add('authors', 'Initials without full stops (Khan MA, not Khan M.A.)', authorSeg.match(/\b[A-Z]\.(?:\s?[A-Z]\.)*/)?.[0] || null, null, 'low');
  if (/^[A-Z][\w'’-]+,\s+[A-Z]/.test(authorSeg)) add('authors', 'No comma between surname and initials (Khan A, not Khan, A)', authorSeg.split(/\s+/).slice(0, 2).join(' '), null, 'low');
  if (/^(?:[A-Z]\.\s*)+[A-Z][a-z]/.test(authorSeg)) add('authors', 'Surname first, then initials (Khan A, not A. Khan)', authorSeg.split(',')[0]);
  if (!web && /^[A-Z][a-z]+\s+[A-Z][a-z]{2,}\b/.test(authorSeg) && !/^(?:van|von|de|del|al|el)\b/i.test(authorSeg.split(/\s+/)[1] || '')) add('authors', 'Use initials for first names (Khan A, not Ahmed Khan / Khan Ahmed)', authorSeg.split(/[,]/)[0], null, 'low');

  // ---- year
  if (!p) {
    const vanc = text.match(/\.\s*((?:19|20)\d{2})\s*[;:]/);
    add('year', 'Year in parentheses directly after the authors: Khan A (2019). Title…', vanc ? vanc[1] : (text.match(/\b(?:19|20)\d{2}\b/) || ['missing'])[0], '(Year)', 'high');
  }

  // ---- title
  const title = p?.title || ref.title || '';
  if (title) {
    if (titleCaseRatio(title) > 0.6) add('title', 'Title in sentence case (only the first word and proper nouns capitalised)', title.slice(0, 90), null);
    if (p && !/[.?!]$/.test(title)) add('title', 'Title ends with a full stop', title.slice(-20), null, 'low');
    if (/^[“"']|[”"']\.?$/.test(title)) add('title', 'Article titles are not put in quotation marks', null, null, 'low');
  } else add('missing', 'Title missing', null, null, 'high');

  // ---- source (journal / publisher)
  const source = p?.source || '';
  if (!book && !web) {
    const jname = journalNameOf(ref, p);
    // NLM Catalog abbreviation when the journal is in it (authoritative); otherwise the record's or the ISO 4 word table
    const fullNlmTitle = nlm && normalizeJournal(jname) === normalizeJournal(nlm.title) && normalizeJournal(nlm.isoAbbrev) !== normalizeJournal(nlm.title);
    if (jname && jname.split(/\s+/).length > 1 && (fullNlmTitle || UNABBREVIATED.test(jname))) {
      const exp = nlm?.isoAbbrev || record?.journalAbbrev || abbreviateJournal(jname);
      add('journal', `Journal name abbreviated (ISO / NLM abbreviation${nlm ? ', from the NLM Catalog' : ''})`, jname, exp);
    }
    if (/\bpp?\.\s*\d/i.test(source)) add('pages', 'No “pp.” before page numbers', 'pp.', null, 'low');
    if (/\b(?:vol|volume|no|issue)\.?\s*\d/i.test(source)) add('volume', 'Write volume and issue as 32(1), without “Vol.” or “No.”', source.match(/\b(?:vol|volume|no|issue)\.?\s*\d+/i)[0], null, 'low');
    if (/\d\s*[–—]\s*\d/.test(source)) add('pages', 'Page range with a hyphen (1-5), not a dash', source.match(/\d+\s*[–—]\s*\d+/)[0], null, 'low');
    if (/\d+\s*\(\s*[\w-]+\s*\)\s*[,;]\s*\d/.test(source) || /\d+\s*\(\s*[\w-]+\s*\)\s+\d/.test(source)) add('volume', 'Colon between issue and pages: 32(1): 1-5', source.match(/\d+\s*\(\s*[\w-]+\s*\)\s*[,;]?\s*\d+/)[0], null, 'low');
    if (/;\s*\d+\s*\(/.test(text)) add('volume', 'Vancouver punctuation found (Year;Vol(Issue):pages) — use the PJPS order', text.match(/\d{4}\s*;\s*\d+\s*\([^)]*\)/)?.[0] || null);
    if (!ref.volume && !record?.volume) add('missing', 'Volume missing', null, record?.volume || null, 'medium');
    if (!ref.pages && !record?.pages) add('missing', 'Page numbers (or article number) missing', null, record?.pages || null, 'medium');
    else if (!ref.pages && record?.pages) add('missing', 'Page numbers missing', null, record.pages, 'medium');
    if (!ref.issue && record?.issue) add('missing', 'Issue number missing', null, record.issue, 'low');
  } else if (!web && !/[A-Z][\w&.\s]+,\s*[A-Z]/.test(source) && !record?.publisher) {
    add('missing', 'Book: publisher and place (Publisher, Place.)', source || null, null, 'medium');
  }
  if (!ref.year) add('missing', 'Year missing', null, record?.year || null, 'high');
  // edited-book chapter: In: Editors (eds.), Book, ed., Publisher, Place, pp. x-y.
  if (ref.type === 'book-chapter' || /\.\s+In:\s/.test(text)) {
    if (!/\(\s*eds?\.?\s*\)/i.test(text)) add('chapter', 'Edited book: In: Editors (eds.), Book title, Publisher, Place, pp. x-y.', null, null, 'medium');
    if (!/\bpp\.\s*\d/.test(text)) add('pages', 'Book chapter pages are written “pp. 446-472”', null, null, 'low');
  }
  // website: Organisation (Year). Title. Available at: URL (Accessed day month year).
  if (ref.type === 'webpage') {
    if (!/Available at:/i.test(text)) add('web', 'Website: end with “Available at: URL (Accessed 15 June 2020).”', null, null, 'medium');
    else if (!/\(\s*Accessed\s+[^)]*\d{4}\s*\)/i.test(text)) add('web', 'Website: add the access date: (Accessed 15 June 2020)', null, null, 'medium');
  }

  const expected = record ? ST.formatText(record, 'pjps') : null;
  const scored = dev.filter(d => d.severity !== 'info');
  return { index: ref.index, original: text, expected, deviations: dev, compliant: scored.length === 0 };
}

/** Alphabetical order and a/b suffixes across the list */
function listRules(refs) {
  const issues = [];
  const keyed = refs.map(r => ({ r, fam: famKey(r.authors?.[0]?.family || ''), year: r.year, suffix: r.yearSuffix || '' }));
  for (let i = 1; i < keyed.length; i++) {
    const a = keyed[i - 1], b = keyed[i];
    if (a.fam && b.fam && a.fam.localeCompare(b.fam) > 0) issues.push({ rule: 'order', index: b.r.index, message: `“${b.r.authors[0].family}” should come before “${a.r.authors[0].family}” (alphabetical order)` });
    else if (a.fam && a.fam === b.fam && a.year && b.year && a.year > b.year && (a.r.authors || []).length === (b.r.authors || []).length) issues.push({ rule: 'order', index: b.r.index, message: `Same first author: ${b.year} should come before ${a.year}` });
  }
  const groups = new Map();
  for (const k of keyed) {
    if (!k.fam || !k.year) continue;
    const g = `${k.fam}|${k.year}|${(k.r.authors || []).length >= 3 ? 'etal' : (k.r.authors || []).map(x => famKey(x.family)).join('+')}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(k);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const suffixes = list.map(k => k.suffix);
    if (suffixes.some(s => !s)) issues.push({ rule: 'suffix', index: list[0].r.index, message: `${list[0].r.authors[0].family} ${list[0].year}: ${list.length} works with the same author and year need 2019a / 2019b letters`, refs: list.map(k => k.r.index) });
    else if (new Set(suffixes).size < suffixes.length) issues.push({ rule: 'suffix', index: list[0].r.index, message: `${list[0].r.authors[0].family} ${list[0].year}: the same letter is used twice`, refs: list.map(k => k.r.index) });
  }
  return issues;
}

/** In-text citation format in the manuscript body */
function inTextRules(body, refs) {
  const issues = [];
  if (!body || body.length < 50) return { system: null, issues };
  const numeric = (body.match(/\[\d{1,3}(?:\s*[-–,]\s*\d{1,3})*\]/g) || []).length;
  const ay = (body.match(/\([^()]*?(?:19|20)\d{2}[a-z]?\)/g) || []).length;
  const system = numeric > ay ? 'numeric' : 'author-year';
  if (system === 'numeric') {
    issues.push({ rule: 'system', message: `The manuscript uses numbered citations (${numeric} found). PJPS uses author–year citations, e.g. (Khan, 2019) — use the converter.`, severity: 'high' });
    return { system, issues };
  }
  const ctx = i => body.slice(Math.max(0, i - 60), i + 80).replace(/\s+/g, ' ');
  const authorCount = new Map(refs.map(r => [`${famKey(r.authors?.[0]?.family || '')}|${r.year}`, (r.authors || []).length]));
  for (const m of body.matchAll(/\(([^()]{3,400}?(?:19|20)\d{2}[a-z]?)\)/g)) {
    const inner = m[1];
    if (!/[A-Z][a-z]/.test(inner)) continue;
    const add = (message, severity = 'low') => issues.push({ rule: 'in-text', citation: m[0].slice(0, 120), message, context: ctx(m.index), severity });
    if (/[A-Z][\w'’-]+\s+(?:19|20)\d{2}/.test(inner) && !/et al\.?\s+(?:19|20)\d{2}/.test(inner)) add('Comma between author and year: (Khan, 2019)');
    if (/&/.test(inner)) add('Use “and” in citations: (Khan and Ali, 2019)');
    if (/et\.?\s?al(?!\.)/.test(inner) || /et al\.\s*(?:19|20)/.test(inner)) add('Write “et al.,” with a full stop and a comma: (Khan et al., 2019)');
    if (/(?:19|20)\d{2}[a-z]?\s*,\s*[A-Z][a-z]/.test(inner)) add('Separate several citations with semicolons: (Ali, 2018; Khan, 2019)');
    const years = [...inner.matchAll(/(?:^|;\s*)[^;]*?((?:19|20)\d{2})/g)].map(x => parseInt(x[1], 10));
    if (years.length > 1 && years.some((y, i) => i && y < years[i - 1])) add('Several citations in one bracket in chronological order (oldest first)');
    for (const part of inner.split(/\s*;\s*/)) {
      const pm = part.match(/^([A-Z][\w'’-]+)(\s+et\s+al\.?|\s+(?:and|&)\s+[A-Z][\w'’-]+)?,?\s+((?:19|20)\d{2})/);
      if (!pm) continue;
      const n = authorCount.get(`${famKey(pm[1])}|${pm[3]}`);
      if (!n) continue;
      if (/et\s+al/.test(pm[2] || '') && n <= 2) add(`“et al.” is used but ${pm[1]} ${pm[3]} has ${n} author(s) — ${n === 2 ? 'name both authors' : 'name the author'}`, 'medium');
      if (!pm[2] && n >= 3) add(`${pm[1]} ${pm[3]} has ${n} authors — cite as (${pm[1]} et al., ${pm[3]})`, 'medium');
      if (pm[2] && /and|&/.test(pm[2]) && n >= 3) add(`${pm[1]} ${pm[3]} has ${n} authors — cite as (${pm[1]} et al., ${pm[3]})`, 'medium');
    }
  }
  return { system, issues: dedupe(issues) };
}

function dedupe(list) {
  const seen = new Map();
  for (const x of list) {
    const k = x.message + '|' + (x.citation || '');
    if (seen.has(k)) seen.get(k).count++;
    else seen.set(k, { ...x, count: 1 });
  }
  return [...seen.values()];
}

/**
 * refs: parsed reference entries (original text); records: Map/array of matched records by position (optional);
 * body: manuscript text (optional) for the in-text rules.
 */
/** NLM Catalog record of each reference's journal (local copy), for the abbreviation rule; null entries when unknown */
async function nlmForRefs(refs, records = []) {
  const D = require('../datasets');
  return Promise.all(refs.map((r, i) => {
    const rec = records[i];
    const name = journalNameOf(r) || rec?.journal || '';
    if (!name && !(rec?.issn || []).length) return null;
    return D.nlmJournal({ issns: rec?.issn || [], name }).catch(() => null);
  }));
}

function checkCompliance(refs, { records = [], body = '', nlm = [] } = {}) {
  const entries = refs.map((r, i) => checkEntry(r, records[i] || null, nlm[i] || null));
  const list = listRules(refs);
  const inText = inTextRules(body, refs);
  for (const l of list) {
    const e = entries.find(x => x.index === l.index);
    if (e) { e.deviations.push({ rule: l.rule, message: l.message, severity: 'medium' }); e.compliant = false; }
  }
  const byRule = {};
  for (const e of entries) for (const d of e.deviations) if (d.severity !== 'info') byRule[d.rule] = (byRule[d.rule] || 0) + 1;
  const compliant = entries.filter(e => e.compliant).length;
  return {
    style: 'pjps',
    entries,
    listIssues: list,
    inText,
    summary: {
      total: entries.length, compliant, nonCompliant: entries.length - compliant,
      score: entries.length ? Math.round(compliant / entries.length * 100) : 0,
      deviations: entries.reduce((a, e) => a + e.deviations.filter(d => d.severity !== 'info').length, 0),
      byRule, inTextIssues: inText.issues.length, citationSystem: inText.system
    }
  };
}

module.exports = { checkCompliance, nlmForRefs, checkEntry, abbreviateJournal, listRules, inTextRules };
