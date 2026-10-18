// format.js - render a matched record as a reference string (APA 7, Vancouver, PJPS) and export formats

function initialsOf(given, { dots = true, space = true } = {}) {
  const parts = String(given || '').split(/[\s.\-]+/).filter(Boolean).map(p => p[0].toUpperCase());
  if (!dots) return parts.join('');
  return parts.map(p => `${p}.`).join(space ? ' ' : '');
}

function pages(p) { return String(p || '').replace(/--?/g, '–'); }

function apa(r) {
  const au = r.authors || [];
  let names;
  const fmt = a => (a.corporate || !a.given ? a.family : `${a.family}, ${initialsOf(a.given)}`);
  if (au.length === 0) names = '';
  else if (au.length === 1) names = fmt(au[0]);
  else if (au.length <= 20) names = au.slice(0, -1).map(fmt).join(', ') + ', & ' + fmt(au[au.length - 1]);
  else names = au.slice(0, 19).map(fmt).join(', ') + ', ... ' + fmt(au[au.length - 1]);
  const year = r.year ? `(${r.year})` : '(n.d.)';
  const title = (r.title || '').replace(/\.$/, '');
  let src = '';
  if (r.journal) {
    src = r.journal;
    if (r.volume) src += `, ${r.volume}`;
    if (r.issue) src += `(${r.issue})`;
    if (r.pages) src += `, ${pages(r.pages)}`;
    src += '.';
  } else if (r.publisher) src = `${r.publisher}.`;
  const doi = r.doi ? ` https://doi.org/${r.doi}` : '';
  return `${names ? names + ' ' : ''}${year}. ${title}. ${src}${doi}`.replace(/\s+/g, ' ').trim();
}

function vancouver(r) {
  const au = r.authors || [];
  const fmt = a => (a.corporate || !a.given ? a.family : `${a.family} ${initialsOf(a.given, { dots: false })}`);
  let names = au.slice(0, 6).map(fmt).join(', ');
  if (au.length > 6) names += ', et al';
  const j = r.journalAbbrev || r.journal || r.publisher || '';
  let tail = r.year ? `${r.year}` : '';
  if (r.volume) tail += `;${r.volume}`;
  if (r.issue) tail += `(${r.issue})`;
  if (r.pages) tail += `:${String(r.pages).replace(/–/g, '-')}`;
  const doi = r.doi ? ` doi:${r.doi}` : '';
  return `${names ? names + '. ' : ''}${(r.title || '').replace(/\.$/, '')}. ${j ? j + '. ' : ''}${tail}.${doi}`.replace(/\s+/g, ' ').trim();
}

/** PJPS house style: Surname A, Surname B and Surname C (Year). Title. Journal, Vol(Issue): pages. */
function pjps(r) {
  const au = r.authors || [];
  const fmt = a => (a.corporate || !a.given ? a.family : `${a.family} ${initialsOf(a.given, { dots: false })}`);
  let names = '';
  if (au.length === 1) names = fmt(au[0]);
  else if (au.length > 6) names = au.slice(0, 6).map(fmt).join(', ') + ' et al.';
  else if (au.length > 1) names = au.slice(0, -1).map(fmt).join(', ') + ' and ' + fmt(au[au.length - 1]);
  let src = r.journalAbbrev || r.journal || r.publisher || '';
  if (r.volume) src += `, ${r.volume}`;
  if (r.issue) src += `(${r.issue})`;
  if (r.pages) src += `: ${String(r.pages).replace(/–/g, '-')}`;
  const doi = r.doi ? ` https://doi.org/${r.doi}` : '';
  return `${names} (${r.year || 'n.d.'}). ${(r.title || '').replace(/\.$/, '')}. ${src}.${doi}`.replace(/\s+/g, ' ').trim();
}

const STYLES = { apa, vancouver, pjps };

function formatReference(record, style = 'pjps') {
  return (STYLES[style] || pjps)(record);
}

/** Guess the style of the input list so suggestions look like the author's own entries */
function detectStyle(refs) {
  let v = 0, a = 0;
  for (const r of refs.slice(0, 30)) {
    if (/;\s*\d{1,4}\s*(\(|:)/.test(r.raw) || /^\s*\[?\d+[.\]]/.test(r.raw)) v++;
    if (/\(\s*(1[6-9]|20)\d{2}[a-z]?\s*\)/.test(r.raw)) a++;
  }
  if (v > a) return 'vancouver';
  return 'pjps';
}

// ------------------------------------------------------------------ export formats

function bibtexKey(r, i) {
  const fam = (r.authors?.[0]?.family || 'ref').normalize('NFKD').replace(/[^A-Za-z]/g, '');
  return `${fam}${r.year || ''}_${i + 1}`;
}

function toBibtex(records) {
  return records.map((r, i) => {
    const type = r.journal ? 'article' : r.type === 'book' ? 'book' : 'misc';
    const f = {
      author: (r.authors || []).map(a => (a.given ? `${a.family}, ${a.given}` : `{${a.family}}`)).join(' and '),
      title: `{${r.title || ''}}`, journal: r.journal, year: r.year, volume: r.volume, number: r.issue,
      pages: r.pages ? String(r.pages).replace(/[–-]/, '--') : '', publisher: r.publisher, doi: r.doi
    };
    const body = Object.entries(f).filter(([, v]) => v).map(([k, v]) => `  ${k} = {${String(v).replace(/^\{(.*)\}$/, '$1')}}`).join(',\n');
    return `@${type}{${bibtexKey(r, i)},\n${body}\n}`;
  }).join('\n\n');
}

function toRis(records) {
  return records.map(r => {
    const lines = [`TY  - ${r.journal ? 'JOUR' : r.type === 'book' ? 'BOOK' : 'GEN'}`];
    for (const a of r.authors || []) lines.push(`AU  - ${a.given ? `${a.family}, ${a.given}` : a.family}`);
    if (r.title) lines.push(`TI  - ${r.title}`);
    if (r.journal) lines.push(`JO  - ${r.journal}`);
    if (r.year) lines.push(`PY  - ${r.year}`);
    if (r.volume) lines.push(`VL  - ${r.volume}`);
    if (r.issue) lines.push(`IS  - ${r.issue}`);
    const [sp, ep] = String(r.pages || '').split(/[–-]/);
    if (sp) lines.push(`SP  - ${sp}`);
    if (ep) lines.push(`EP  - ${ep}`);
    if (r.doi) lines.push(`DO  - ${r.doi}`);
    if (r.publisher) lines.push(`PB  - ${r.publisher}`);
    lines.push('ER  - ');
    return lines.join('\n');
  }).join('\n\n');
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers, rows) {
  return '﻿' + [headers, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
}

module.exports = { formatReference, detectStyle, apa, vancouver, pjps, toBibtex, toRis, toCsv, STYLES };
