// integrity/common.js - helpers shared by the Integrity Suite analysers. Every analyser returns a "dimension":
//   { key, label, checked, signals: [{ code, title, severity: high|medium|low, weight, evidence: [{ text, quote?, link?, note? }], note }], details }
// The same signal shape as Module 4, so the risk engine, the screen and the reports treat all evidence alike.

const ctx = (text, i, len, pad = 70) => text.slice(Math.max(0, i - pad), i + len + pad).replace(/\s+/g, ' ').trim();

function dimension(key, label) {
  const signals = [];
  return {
    key, label, checked: true, signals, details: {},
    sig(code, title, severity, weight, evidence = [], note = '') { signals.push({ group: key, code, title, severity, weight, evidence, note }); }
  };
}

/** Strip the helper before the dimension is stored */
const finish = d => { const { sig, ...rest } = d; return rest; };

const words = text => String(text || '').toLowerCase().match(/\p{L}[\p{L}'-]*/gu) || [];

/** Sentences of running text (headings, table rows and reference lines are skipped) */
function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(“"])/)
    .map(s => s.trim())
    .filter(s => s.split(' ').length >= 5 && /[a-z]/.test(s));
}

const SECTION_RE = /(?:^|\n)\s*(?:\d+\.?\s*)?(abstract|introduction|background|materials? and methods|methods?|methodology|experimental(?: section)?|results and discussion|results|discussion|conclusions?|acknowledge?ments?|declarations?|conflicts? of interest|funding|author contributions?|ethics(?: statement| approval)?|data availability(?: statement)?|references|bibliography)\s*:?\s*\n/gi;

/** Split a manuscript into named sections by its headings; unnamed text before the first heading is "front" */
function sections(text) {
  const t = String(text || '');
  const marks = [...t.matchAll(SECTION_RE)].map(m => ({ name: m[1].toLowerCase().replace(/^materials? and /, '').replace(/^methodology$|^experimental.*$/, 'methods').replace(/^method$/, 'methods'), at: m.index, end: m.index + m[0].length }));
  const out = { front: t.slice(0, marks[0]?.at ?? t.length) };
  marks.forEach((m, i) => {
    const body = t.slice(m.end, marks[i + 1]?.at ?? t.length);
    out[m.name] = out[m.name] ? out[m.name] + '\n' + body : body;
  });
  return out;
}

const FREE_MAIL_RE = require('../papermill/lists').FREE_MAIL;

const levelOf = s => ({ high: 3, medium: 2, low: 1 }[s] || 0);

module.exports = { ctx, dimension, finish, words, sentences, sections, FREE_MAIL_RE, levelOf };
