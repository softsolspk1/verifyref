// papermill/submission.js - Module 4 submission checks from docs (papermill.txt section 6): the cover letter (addressed to
// another journal, template placeholders, another manuscript's title, correspondence through an address the manuscript
// does not give) and the journal scope (a manuscript with nothing pharmaceutical or biomedical in it, sent to PJPS).
const cfg = require('../config');
const { titleSimilarity } = require('../text');
const { SUBJECTS } = require('../subjects');

const HOME = [cfg.HOME_JOURNAL.name, 'Pak J Pharm Sci', 'Pak. J. Pharm. Sci.', 'PJPS', 'Pakistan J Pharm Sci'];
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isHome = name => {
  const n = norm(name);
  return HOME.some(h => { const k = norm(h); return n === k || n.includes(k) || (k.length > 10 && k.includes(n) && n.length > 10); });
};

// "for publication in the Journal of X", "submit ... to Molecules", "Dear Editor of X"
const JOURNAL_RE = /\b(?:publication|consideration|submit(?:ted|ting)?|submission)(?:\s+(?!in\b|to\b|for\b|by\b)[\w-]+){0,6}?\s+(?:in|to|for|by)\s+(?:the\s+|your\s+(?:esteemed\s+|prestigious\s+|reputed\s+)?(?:journal\s*,?\s*)?)?((?:[A-Z][\w&'.-]*|of|and|for|in|the|&)(?:\s+(?:[A-Z][\w&'.-]*|of|and|for|in|the|&)){0,9})/g;
const EDITOR_RE = /\b(?:Editor(?:-in-Chief)?|Editorial Office)\s+(?:of|at)\s+(?:the\s+)?((?:[A-Z][\w&'.-]*|of|and|for|in|the|&)(?:\s+(?:[A-Z][\w&'.-]*|of|and|for|in|the|&)){0,9})/g;
const PLACEHOLDER_RE = /\[(?:journal(?: name| title)?|name of (?:the )?journal|editor(?:'s)? name|editor|title|manuscript title|date|author(?:s)?(?:'s)?(?: name)?|corresponding author|your name|insert[^\]]*)\]|<\s*(?:journal|editor|title|name)[^>]*>|\{\{[^}]+\}\}|\bXXX+\b|\bJOURNAL NAME\b/gi;
const JOURNAL_WORD = /\b(journal|letters|reports|reviews|annals|archives|bulletin|acta|research|sciences?|medicine|pharmac\w*|molecules|cells|cancers|nutrients|biomed\w*|plos|frontiers|scientific|international|chemistry|biology)\b/i;

/** Cover-letter findings: [{ code, title, severity, weight, evidence, note }] */
function coverLetterSignals(letter, { title = '', emails = [] } = {}) {
  const text = String(letter || '').replace(/\s+/g, ' ').trim();
  if (text.length < 40) return [];
  const out = [];
  const named = new Map();
  for (const re of [JOURNAL_RE, EDITOR_RE]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const name = m[1].split(/\.\s/)[0].replace(/\s+(?:of|and|for|in|the|&)$/i, '').replace(/[.,;:]+$/, '').trim();
      if (name.split(/\s+/).length < 1 || name.length < 5 || !JOURNAL_WORD.test(name) || isHome(name)) continue;
      if (/^(?:the\s+)?(?:Editor|Editorial|Board|Journal|Your|This|Our|Original Research|Research Article|Review)$/i.test(name)) continue;
      named.set(norm(name), { name, quote: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20) });
    }
  }
  if (named.size) out.push({ code: 'cover-other-journal', title: `The cover letter is addressed to another journal (${[...named.values()].map(n => n.name).slice(0, 3).join('; ')})`, severity: 'medium', weight: 2,
    evidence: [...named.values()].slice(0, 4).map(n => ({ text: n.name, quote: `…${n.quote}…` })),
    note: 'A letter written for another journal points to a manuscript sent to several journals at once, or to a template letter from a third party (paper mills submit in bulk). It can also be an honest re-use after a rejection: ask the authors.' });
  const ph = [...new Set((text.match(PLACEHOLDER_RE) || []).map(x => x.trim()))];
  if (ph.length) out.push({ code: 'cover-placeholder', title: `Template placeholders left in the cover letter (${ph.length})`, severity: 'medium', weight: 2, evidence: ph.slice(0, 5).map(p => ({ text: p })),
    note: 'Unfilled fields such as "[Journal Name]" show a letter produced from a template, as mills do for batches of submissions.' });
  // a quoted title in the letter that is not this manuscript's title
  if (title && title.length > 20) {
    const quoted = [...text.matchAll(/[“"']([^“”"']{25,300})[”"']/g)].map(m => m[1].trim()).filter(q => q.split(/\s+/).length >= 5);
    const other = quoted.filter(q => titleSimilarity(q, title) < 0.5 && !/[.!?]\s+[A-Z]/.test(q));
    if (quoted.length && other.length === quoted.length) out.push({ code: 'cover-title', title: 'The cover letter names a manuscript title that differs from this manuscript', severity: 'low', weight: 1,
      evidence: other.slice(0, 2).map(q => ({ text: `Letter: “${q}”`, note: `Manuscript: “${title.slice(0, 200)}”` })), note: 'Often an earlier working title; a letter for a different paper suggests a template or bulk submission.' });
  }
  // correspondence through an address the manuscript does not give
  const mine = new Set(emails.map(e => e.toLowerCase()));
  const letterMail = [...new Set((text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(e => e.toLowerCase()))];
  const foreign = mine.size ? letterMail.filter(e => !mine.has(e)) : [];
  if (foreign.length) out.push({ code: 'cover-email', title: `The cover letter gives e-mail address(es) not found in the manuscript (${foreign.length})`, severity: 'low', weight: 1, evidence: foreign.map(e => ({ text: e })),
    note: 'Brokers sometimes correspond for the authors through their own mailbox. Check that the corresponding address belongs to an author.' });
  return out;
}

const PHARMA_RE = /\b(pharma\w*|drugs?|medicin\w*|clinical|patients?|therap\w*|disease\w*|cells?|rats?|mice|tissue\w*|extracts?|formulation\w*|tablets?|capsules?|dos(?:e|es|age|ing)|toxic\w*|antibacterial|antimicrobial|antioxidant\w*|inflammat\w*|cancer\w*|tumou?r\w*|plasma|serum|blood|enzym\w*|protein\w*|genes?|bacteri\w*|fung\w*|vir(?:us|al)|infect\w*|health|hospital\w*|nurs\w*|chromatograph\w*|hplc|assays?|in vitro|in vivo|bioavailab\w*|pharmacokinetic\w*|synthes\w*|compounds?|molecul\w*|nanoparticles?|polymer\w*|plants?|herbal|phytochemical\w*|diabet\w*|hypertens\w*|liver|kidney|cardi\w*|neuro\w*|immun\w*|vaccin\w*|biolog\w*|biochem\w*|chemi\w*)\b/gi;

/** Fit with the journal's subject areas: { subjects: [names], pharmaWords, inScope } from the title, keywords and abstract */
function scopeFit({ title = '', abstract = '', keywords = [] } = {}) {
  const text = `${title} ${(keywords || []).join(' ')} ${abstract}`;
  const pharmaWords = new Set((text.match(PHARMA_RE) || []).map(w => w.toLowerCase())).size;
  const subjects = SUBJECTS.filter(s => s.terms.some(t => {
    const parts = t.replace(/"/g, '').split(/\s+AND\s+/i);
    return parts.every(p => new RegExp(`\\b${p.replace(/\*/g, '\\w*').replace(/[-]/g, '[- ]?')}`, 'i').test(text));
  })).map(s => s.name);
  return { subjects, pharmaWords, inScope: subjects.length > 0 || pharmaWords >= 2, words: text.split(/\s+/).filter(Boolean).length };
}

module.exports = { coverLetterSignals, scopeFit, isHome };
