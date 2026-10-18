// editor/reviewerReport.js - Reviewer report check: coercive citation requests
const { splitReferences, parseReferenceEntry, DOI_REGEX, extractAuthorYearCitations, repairText } = require('../parse');
const { checkReferences } = require('../checks/reference');
const { nameMatch, splitName, relevanceScores, normalizeJournal, cleanDoi } = require('../text');
const S = require('../sources');
const cfg = require('../config');

const REQUEST_RE = /\b(cit(e|ed|ing|ation|ations)|referenc(e|es|ing)|refer to|include|incorporat|consider|add(ing)?|discuss|mention|acknowledg|recommend|suggest|should (?:read|consult|look at)|relevant (?:work|stud|paper|article|literature)|missing (?:reference|literature|citation)|literature review|recent (?:work|stud|paper|article)s?)\b/i;
const COERCIVE_RE = [
  { re: /\b(my|our) (own )?(work|paper|article|stud(y|ies)|publication|research|group)s?\b/i, message: 'Reviewer refers to their own work' },
  { re: /\b(papers?|articles?|works?) (recently )?published in (this|the present|your target|the same) journal\b/i, message: 'Request to cite papers from this journal' },
  { re: /\b(must|have to|need to|required to|obliged to|mandatory)\b[^.]{0,60}\bcit/i, message: 'Citation request framed as mandatory' },
  { re: /\bacceptance\b[^.]{0,80}\bcit|\bcit[^.]{0,80}\b(acceptance|accept)\b/i, message: 'Citation request linked to acceptance' },
  { re: /\b(works?|papers?|articles?|stud(y|ies)) (of|by) (prof\.?|dr\.?)?\s*[A-Z][a-z]+/i, message: 'Request to cite works of a named researcher' }
];

/** Extract citation requests (sentences + embedded references) from the report */
function extractRequests(text) {
  const clean = repairText(text);
  const requests = [];
  const seen = new Set();
  const add = (req) => {
    const key = req.doi || req.raw.slice(0, 120).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    requests.push(req);
  };

  // 1. Full references written as lines / numbered lists
  const lines = clean.split('\n');
  const refLike = l => (/\b(1[6-9]|20)\d{2}\b/.test(l) && (DOI_REGEX.test(l) || /\b\d{1,4}\s*\(\d+\)|;\s*\d+\s*[:(]|vol\.|pp\.|et al\.|journal|j\.\s/i.test(l)) && l.length > 40) || (DOI_REGEX.test(l) && l.length > 15);
  const blocks = [];
  let cur = [];
  for (const l of lines) {
    if (refLike(l.trim())) cur.push(l.trim());
    else if (cur.length) { blocks.push(cur.join('\n')); cur = []; }
  }
  if (cur.length) blocks.push(cur.join('\n'));
  for (const b of blocks) {
    const { entries } = splitReferences(b);
    for (const e of entries) {
      const ctxIdx = clean.indexOf(e.slice(0, 40));
      add({ kind: 'reference', raw: e, doi: cleanDoi((e.match(DOI_REGEX) || [])[0]), context: clean.slice(Math.max(0, ctxIdx - 200), ctxIdx).split('\n').slice(-2).join(' ').trim() });
    }
  }

  // 2. Bare DOIs inside sentences
  for (const m of clean.matchAll(new RegExp(DOI_REGEX.source, 'gi'))) {
    const doi = cleanDoi(m[0]);
    if (doi && !requests.some(r => r.doi === doi)) {
      add({ kind: 'doi', raw: doi, doi, context: clean.slice(Math.max(0, m.index - 160), m.index + m[0].length + 40).replace(/\s+/g, ' ') });
    }
  }

  // 3. Author-year mentions in sentences that ask for citations
  const sentences = clean.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z0-9(])/);
  for (const s of sentences) {
    if (!REQUEST_RE.test(s)) continue;
    for (const c of extractAuthorYearCitations(s)) {
      const raw = `${c.authors.join(' & ')}${c.etAl ? ' et al.' : ''} (${c.year}${c.suffix})`;
      if (!requests.some(r => r.kind === 'reference' && r.raw.includes(c.authors[0]) && r.raw.includes(String(c.year)))) {
        add({ kind: 'mention', raw, authors: c.authors, year: c.year, context: s.trim().slice(0, 400) });
      }
    }
  }

  // 4. Request sentences with no specific source (generic "cite recent works...")
  const generic = sentences
    .filter(s => /\bcit(e|ing|ation)|\breferences?\b/i.test(s) && REQUEST_RE.test(s) && !DOI_REGEX.test(s) && !/\b(1[6-9]|20)\d{2}\b/.test(s))
    .map(s => s.trim()).filter(s => s.length > 20).slice(0, 20);

  const phrases = [];
  for (const { re, message } of COERCIVE_RE) {
    const m = clean.match(re);
    if (m) phrases.push({ message, quote: clean.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, ' ').trim() });
  }
  return { requests, generic, phrases };
}

/** Resolve an author-year mention to a record (Crossref author+year search) */
async function resolveMention(m, topicHint) {
  const q = encodeURIComponent(`${topicHint || ''}`.slice(0, 200));
  const url = `https://api.crossref.org/works?query.author=${encodeURIComponent(m.authors.join(' '))}${q ? `&query.bibliographic=${q}` : ''}&filter=from-pub-date:${m.year},until-pub-date:${m.year}&rows=3&mailto=${encodeURIComponent(cfg.CONTACT_EMAIL)}`;
  const r = await require('../http').getJson(url);
  if (!r.ok) return null;
  const items = r.data.message.items || [];
  const hit = items.find(it => (it.author || []).some(a => nameMatch({ family: a.family || '', given: a.given || '' }, { family: m.authors[0], given: '' })));
  return hit ? hit.DOI : null;
}

/**
 * input: { text, reviewer: { name, orcid }, manuscript: { title, abstract, keywords } }
 */
async function checkReviewerReport(input, { onProgress } = {}) {
  const { requests, generic, phrases } = extractRequests(input.text || '');
  const reviewer = input.reviewer?.name ? { ...splitName(input.reviewer.name), orcid: (input.reviewer.orcid || '').replace(/[^\dX-]/gi, '') || null, name: input.reviewer.name } : null;
  const ms = input.manuscript || {};
  const topic = [ms.title, ms.abstract, (ms.keywords || []).join(' ')].filter(Boolean).join('. ');

  // Turn each request into a parsed reference and verify
  for (const m of requests.filter(r => r.kind === 'mention')) {
    const doi = await resolveMention(m, ms.title);
    if (doi) { m.resolvedDoi = doi; m.raw += ` https://doi.org/${doi}`; }
  }
  const refs = requests.map((r, i) => {
    const p = parseReferenceEntry(r.kind === 'doi' ? `https://doi.org/${r.doi}` : r.raw, i + 1);
    if (r.kind === 'mention') {
      p.authors = r.authors.map(a => ({ family: a, given: '' }));
      p.year = r.year;
      if (r.resolvedDoi) p.doi = r.resolvedDoi;
      else p.title = '';
    }
    return p;
  });
  const checked = refs.length ? await checkReferences(refs, { onProgress, checkLinks: false }) : { results: [] };

  // Reviewer identity via ORCID -> OpenAlex author id
  let reviewerAuthorId = null;
  if (reviewer?.orcid) {
    const r = await S.openalex(`authors/orcid:${reviewer.orcid}`);
    if (r.ok) reviewerAuthorId = r.data.id?.replace('https://openalex.org/', '');
  }

  const rel = topic ? relevanceScores(topic, checked.results.map(r => [r.record?.title || r.parsed.title || '', ...(r.openalex?.topics || [])].join('. '))) : [];
  const items = checked.results.map((r, i) => {
    const req = requests[i];
    const authors = r.openalex?.authors?.length ? r.openalex.authors.map(a => ({ ...splitName(a.name), id: a.id, orcid: a.orcid })) : (r.record?.authors || r.parsed.authors || []);
    const flags = [];
    const own = reviewer && authors.find(a =>
      (reviewerAuthorId && a.id === reviewerAuthorId) ||
      (reviewer.orcid && a.orcid && a.orcid.endsWith(reviewer.orcid.slice(-8))) ||
      nameMatch(a, reviewer) === 'exact' || (nameMatch(a, reviewer) === 'likely' && !a.given));
    if (own) flags.push({ code: 'own-work', severity: 'high', message: `Requested work is co-authored by the reviewer (${`${own.given || ''} ${own.family}`.trim()})` });
    if (r.status === 'suspicious') flags.push({ code: 'unverifiable', severity: 'high', message: 'Requested reference could not be found in any database' });
    if (r.status === 'retracted') flags.push({ code: 'retracted', severity: 'high', message: 'Requested reference has been retracted' });
    const score = rel[i] ?? null;
    return {
      index: i + 1,
      kind: req.kind,
      requested: req.raw,
      context: req.context,
      status: r.status,
      statusLabel: r.statusLabel,
      record: r.record,
      journal: r.record?.journal || r.parsed.journal || null,
      relevance: score === null ? null : Math.round(score * 1000) / 1000,
      flags,
      authors: authors.slice(0, 8).map(a => `${a.given || ''} ${a.family}`.trim())
    };
  });

  // Weak relevance relative to the other requests and an absolute floor
  if (topic && items.length) {
    for (const it of items) {
      if (it.relevance !== null && it.relevance < 0.04) it.flags.push({ code: 'weak-relevance', severity: 'medium', message: 'Requested source appears weakly related to the manuscript topic' });
    }
  }

  // Journal concentration among requests
  const byJournal = new Map();
  for (const it of items) {
    if (!it.journal) continue;
    const k = normalizeJournal(it.journal);
    if (!byJournal.has(k)) byJournal.set(k, { journal: it.journal, items: [] });
    byJournal.get(k).items.push(it.index);
  }
  const journalGroups = [...byJournal.values()].filter(g => g.items.length >= 2 && g.items.length >= items.length * 0.4);
  for (const g of journalGroups) {
    for (const idx of g.items) items[idx - 1].flags.push({ code: 'single-journal', severity: 'medium', message: `${g.items.length} of ${items.length} requested works are from ${g.journal}` });
  }

  // Author concentration among requests (excluding the reviewer)
  const byAuthor = new Map();
  for (const it of items) {
    for (const a of new Set(it.authors)) {
      if (reviewer && nameMatch(a, reviewer)) continue;
      byAuthor.set(a, [...(byAuthor.get(a) || []), it.index]);
    }
  }
  const authorGroups = [...byAuthor.entries()].filter(([, ix]) => ix.length >= 3 && ix.length >= items.length * 0.5).map(([author, ix]) => ({ author, items: ix }));

  const flags = [];
  const ownCount = items.filter(i => i.flags.some(f => f.code === 'own-work')).length;
  if (ownCount) flags.push({ severity: 'high', message: `${ownCount} of ${items.length} requested works are the reviewer's own` });
  for (const g of journalGroups) flags.push({ severity: 'medium', message: `${g.items.length} requests point to a single journal: ${g.journal}` });
  for (const g of authorGroups) flags.push({ severity: 'medium', message: `${g.items.length} requests share the author ${g.author}` });
  const weak = items.filter(i => i.flags.some(f => f.code === 'weak-relevance')).length;
  if (weak) flags.push({ severity: 'medium', message: `${weak} requested work(s) are weakly related to the manuscript` });
  const unver = items.filter(i => i.flags.some(f => f.code === 'unverifiable')).length;
  if (unver) flags.push({ severity: 'high', message: `${unver} requested reference(s) could not be verified` });
  for (const p of phrases) flags.push({ severity: 'medium', message: p.message, quote: p.quote });
  if (items.length >= 6) flags.push({ severity: 'low', message: `Large number of citation requests (${items.length})` });

  const risk = flags.some(f => f.severity === 'high') ? 'high' : flags.filter(f => f.severity === 'medium').length >= 2 ? 'medium' : flags.length ? 'low' : 'none';
  const flaggedItems = items.filter(i => i.flags.length).map(i => i.index);
  const editorNote = risk === 'none' ? 'No coercive citation pattern detected in this report.'
    : `Dear Author, please note that citation request(s) ${flaggedItems.join(', ')} in Reviewer ${reviewer?.name ? `(${reviewer.name}) ` : ''}report are optional. Cite them only if they directly support statements in your manuscript; declining them will not affect the editorial decision.`;

  return {
    reviewer: reviewer ? { name: reviewer.name, orcid: reviewer.orcid, openalexId: reviewerAuthorId } : null,
    summary: { requests: items.length, ownWork: ownCount, singleJournal: journalGroups.length, weakRelevance: weak, unverifiable: unver, genericRequests: generic.length, risk },
    items,
    genericRequests: generic,
    phrases,
    journalGroups,
    authorGroups,
    flags,
    risk,
    editorNote
  };
}

module.exports = { checkReviewerReport, extractRequests };
