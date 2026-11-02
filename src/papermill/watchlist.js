// papermill/watchlist.js - the editorial office's watchlist (as the STM Integrity Hub's shared watchlists of fake
// e-mail addresses, domains and identities): e-mail addresses, e-mail domains, person names, ORCID iDs, institutions,
// phone numbers and phrases seen in earlier paper-mill submissions. Kept by the editors (Admin › Settings or the
// Module 4 page) in the meta table; every manuscript is matched against it.
const db = require('../db');

const KEY = 'papermill_watchlist';
const TYPES = { email: 'E-mail address', domain: 'E-mail domain', name: 'Person name', orcid: 'ORCID iD', institution: 'Institution', phone: 'Phone number', phrase: 'Phrase' };
const SEVERITIES = ['low', 'medium', 'high'];

const clean = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}@.\-+ ]/gu, ' ').replace(/\s+/g, ' ').trim();
const digits = s => String(s || '').replace(/\D/g, '');
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Validated entry, or null */
function entryOf(x, by = null) {
  const type = TYPES[x?.type] ? x.type : null;
  let value = String(x?.value || '').trim();
  if (!type || !value) return null;
  if (type === 'email') { value = value.toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(value)) return null; }
  if (type === 'domain') { value = value.toLowerCase().replace(/^.*@/, '').replace(/^www\./, ''); if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return null; }
  if (type === 'orcid') { value = (value.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/i) || [])[0]?.toUpperCase(); if (!value) return null; }
  if (type === 'phone' && digits(value).length < 7) return null;
  if ((type === 'name' || type === 'institution' || type === 'phrase') && clean(value).length < 5) return null;
  return { type, value: value.slice(0, 200), severity: SEVERITIES.includes(x.severity) ? x.severity : 'medium', note: String(x.note || '').slice(0, 300), by: x.by || by, at: x.at || new Date().toISOString() };
}

async function load() {
  try { return JSON.parse((await db.getMeta(KEY)) || '[]'); } catch (e) { return []; }
}

async function save(list, by) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const e = entryOf(x, by);
    const k = e && `${e.type}|${e.value.toLowerCase()}`;
    if (e && !seen.has(k)) { seen.add(k); out.push(e); }
  }
  await db.setMeta(KEY, JSON.stringify(out.slice(0, 5000)));
  return out.slice(0, 5000);
}

/**
 * Entries found in a manuscript: [{ entry, found, where }]. text: the whole manuscript; emails, orcids: as read from
 * it; authors: [{ name }]; affiliations: [string]. Names and institutions are matched as whole words on the title page
 * (first 6,000 characters) and in the author / affiliation lists, phrases anywhere.
 */
function match(list, { text = '', emails = [], orcids = [], authors = [], affiliations = [] } = {}) {
  if (!list.length) return [];
  const head = clean(text.slice(0, 6000));
  const all = clean(text);
  const mails = emails.map(e => e.toLowerCase());
  const names = authors.map(a => clean(a.name || `${a.given || ''} ${a.family || ''}`));
  const affs = affiliations.map(clean);
  const phoneDigits = [...text.matchAll(/\+?\d[\d\s()./-]{6,}\d/g)].map(m => digits(m[0]));
  const out = [];
  for (const e of list) {
    const v = e.value, cv = clean(v);
    const word = new RegExp(`(^| )${escRe(cv)}( |$)`);
    let found = null, where = '';
    if (e.type === 'email') { found = mails.find(m => m === v.toLowerCase()) || null; where = 'author e-mail'; }
    else if (e.type === 'domain') { found = mails.find(m => m.endsWith('@' + v) || m.endsWith('.' + v)) || null; where = 'author e-mail'; }
    else if (e.type === 'orcid') { found = orcids.find(o => o.toUpperCase() === v) || null; where = 'ORCID iD in the manuscript'; }
    else if (e.type === 'name') { found = names.find(n => n === cv || word.test(n)) ? v : head && word.test(head) ? v : null; where = 'author list / title page'; }
    else if (e.type === 'institution') { found = affs.find(a => word.test(a)) ? v : head && word.test(head) ? v : null; where = 'affiliations / title page'; }
    else if (e.type === 'phone') { const d = digits(v); found = phoneDigits.find(p => p.endsWith(d.slice(-9)) && p.length >= 7) ? v : null; where = 'phone number'; }
    else if (e.type === 'phrase') { found = word.test(all) ? v : null; where = 'manuscript text'; }
    if (found) out.push({ entry: e, found, where });
  }
  return out;
}

module.exports = { TYPES, SEVERITIES, load, save, match, entryOf };
