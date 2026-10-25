// papermill/index.js - Module 4 Paper Mill Detection. Collects risk signals with evidence and weights:
//   text (tortured phrases, AI-text leftovers, template wording, vague methods), references (fabricated references,
//   citations to papers retracted for paper-mill reasons, predatory/hijacked journals, citation stacking), authors
//   (earlier retractions, free e-mail addresses, ORCID, affiliations, authorship changes, suggested reviewers) and data
//   (misidentified cell lines, duplicate submissions, image findings from Module 5).
// The result is a screening aid: LOW / MEDIUM / HIGH with the evidence for every signal. It never decides on its own.
const db = require('../db');
const D = require('../datasets');
const { getJson } = require('../http');
const { nameMatch, splitName, titleSimilarity, normalizeJournal } = require('../text');
const { TORTURED, AI_LEFTOVERS, TEMPLATES, CELL_LINES, FREE_MAIL } = require('./lists');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ctx = (text, i, len) => text.slice(Math.max(0, i - 70), i + len + 70).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ text signals

async function customPhrases() {
  try { return JSON.parse((await db.getMeta('tortured_custom')) || '[]'); } catch (e) { return []; }
}

function torturedPhrases(text, extra = []) {
  const hits = new Map();
  for (const t of [...TORTURED, ...extra]) {
    const re = new RegExp(`\\b${esc(t.phrase)}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      const k = t.phrase.toLowerCase();
      if (!hits.has(k)) hits.set(k, { phrase: t.phrase, correct: t.correct, count: 0, examples: [] });
      const h = hits.get(k);
      h.count++;
      if (h.examples.length < 2) h.examples.push(ctx(text, m.index, m[0].length));
    }
  }
  return [...hits.values()].sort((a, b) => b.count - a.count);
}

function aiLeftovers(text) {
  const out = [];
  for (const [re, label] of AI_LEFTOVERS) {
    const m = text.match(re);
    if (m) out.push({ label, found: m[0], example: ctx(text, m.index, m[0].length) });
  }
  return out;
}

function templateWording(text) {
  const out = [];
  for (const [re, label] of TEMPLATES) {
    const m = text.match(re);
    if (m) out.push({ label, found: m[0], example: ctx(text, m.index, m[0].length) });
  }
  return out;
}

/** Methods that cannot be repeated: no supplier, catalogue number, dose, sample size or ethics approval */
function methodsGaps(text) {
  const methods = (text.match(/(?:^|\n)\s*(?:\d+\.?\s*)?(?:materials? and methods|methods?|methodology|experimental(?: section| procedures)?)\s*\n([\s\S]{200,30000}?)(?:\n\s*(?:\d+\.?\s*)?(?:results|results and discussion|discussion)\s*\n|$)/i) || [])[1] || '';
  const scope = methods || text;
  const animals = /\b(rats?|mice|mouse|rabbits?|guinea pigs?|animals?)\b/i.test(scope);
  const humans = /\b(patients?|participants?|volunteers?|subjects? were|respondents?)\b/i.test(scope);
  const reagents = /\b(reagents?|chemicals?|antibod(?:y|ies)|kits?|cell lines?|media|serum)\b/i.test(scope);
  const gaps = [];
  if ((animals || humans) && !/\b(ethic(?:s|al)? (?:committee|board|approval|review)|institutional review board|IRB|IACUC|animal care|approval (?:no|number|letter|ref)|ERC|IREB|bioethics)\b/i.test(text)) {
    gaps.push({ code: 'ethics', message: `${animals ? 'Animal' : 'Human'} study with no ethics approval (committee or approval number) stated` });
  } else if ((animals || humans) && !/\b(?:approval|ref(?:erence)?|protocol|letter)\s*(?:no\.?|number|#|:)\s*[\w/.-]*\d/i.test(text)) {
    gaps.push({ code: 'ethics-number', message: 'Ethics approval mentioned without an approval / reference number' });
  }
  if (reagents && !/\b(purchased from|obtained from|supplied by|procured from|gift from|Sigma|Merck|Thermo|Invitrogen|Abcam|ATCC|Bio-?Rad|Santa Cruz|Cell Signaling|BDH|Fluka|Daejung|Scharlau)\b/i.test(scope)) {
    gaps.push({ code: 'supplier', message: 'Reagents, kits or cells used without naming the supplier' });
  }
  if (animals && !/\b\d+(?:\.\d+)?\s*(?:mg|µg|μg|g|ml|mL)\s*\/\s*kg\b/i.test(scope)) gaps.push({ code: 'dose', message: 'Animal study without doses in mg/kg' });
  if ((animals || humans) && !/\b(?:n\s*=\s*\d+|\d+\s+(?:rats|mice|animals|patients|participants|subjects|volunteers)|(?:groups?|each) of \d+|sample size)\b/i.test(scope)) gaps.push({ code: 'sample', message: 'No sample size (n = …) stated' });
  return { checked: !!methods || animals || humans, methodsFound: !!methods, gaps };
}

function cellLines(text) {
  const out = [];
  for (const c of CELL_LINES) {
    const re = new RegExp(`(?<![\\w-])${esc(c.name)}(?![\\w-])`, 'g');
    for (const m of text.matchAll(re)) {
      const around = text.slice(Math.max(0, m.index - 80), m.index + 80);
      if (!/\bcells?\b|\bcell lines?\b|\bline\b/i.test(around)) continue;
      out.push({ name: c.name, actual: c.actual, example: ctx(text, m.index, m[0].length) });
      break;
    }
  }
  return out;
}

/** Zero-width characters and look-alike letters from other alphabets: used to slip past plagiarism software */
function hiddenText(text) {
  const zero = (text.match(/[​-‍⁠﻿­]/g) || []).length;
  const mixed = [];
  for (const m of text.matchAll(/\p{L}{3,}/gu)) {
    const w = m[0];
    if (/\p{Script=Latin}/u.test(w) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(w)) { mixed.push(w); if (mixed.length >= 8) break; }
  }
  return { zero, mixed };
}

/** A paper with the same title is already published (duplicate / redundant publication) - Crossref */
async function publishedElsewhere(title) {
  if (!title || title.length < 25) return [];
  const r = await getJson('https://api.crossref.org/works?rows=4&select=DOI,title,container-title,issued&query.bibliographic=' + encodeURIComponent(title), { ttl: 7 * 86400, timeout: 12000, retries: 1 });
  if (!r.ok) return [];
  return (r.data?.message?.items || []).map(it => ({ title: (it.title || [])[0] || '', journal: (it['container-title'] || [])[0] || '', year: it.issued?.['date-parts']?.[0]?.[0] || null, doi: it.DOI, sim: titleSimilarity(title, (it.title || [])[0] || '') }))
    .filter(x => x.sim >= 0.92);
}

// ------------------------------------------------------------------ author signals

const ORCID_RE = /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/g;

function orcidValid(id) {
  const d = id.replace(/-/g, '');
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + parseInt(d[i], 10)) * 2;
  const r = (12 - (total % 11)) % 11;
  return (r === 10 ? 'X' : String(r)) === d[15];
}

async function orcidProfile(id) {
  const [works, rec] = await Promise.all([
    getJson(`https://pub.orcid.org/v3.0/${id}/works`, { ttl: 7 * 86400, timeout: 12000, retries: 1 }),
    getJson(`https://pub.orcid.org/v3.0/${id}/person`, { ttl: 7 * 86400, timeout: 12000, retries: 1 })
  ]);
  if (works.status === 404) return { id, exists: false };
  if (!works.ok) return { id, error: works.error || `HTTP ${works.status}` };
  const name = rec.ok ? `${rec.data?.name?.['given-names']?.value || ''} ${rec.data?.name?.['family-name']?.value || ''}`.trim() : '';
  const created = rec.ok ? rec.data?.['last-modified-date']?.value : null;
  return { id, exists: true, works: (works.data?.group || []).length, name, lastModified: created ? new Date(created).toISOString().slice(0, 10) : null };
}

function emailsOf(text) {
  return [...new Set((text.slice(0, 12000).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(e => e.toLowerCase().replace(/[.,;]+$/, '')))];
}

async function authorRetractions(authors) {
  const out = [];
  for (const a of authors.slice(0, 15)) {
    if (!a.family || a.family.length < 3) continue;
    const rows = await D.retractionsByAuthor(a.family).catch(() => []);
    for (const r of rows) {
      const names = String(r.authors || '').split(/\s*;\s*/).map(n => splitName(n.trim())).filter(n => n.family);
      if (!names.some(n => nameMatch(n, a) === 'exact' || (nameMatch(n, a) === 'likely' && n.given && a.given && n.given[0] === a.given[0]))) continue;
      out.push({ author: `${a.given} ${a.family}`.trim(), title: r.title, journal: r.journal, date: r.retraction_date, doi: r.doi, reason: r.reason, mill: /paper mill|fake peer review|peer review manipul|randomly generated|computer-aided content/i.test(r.reason || '') });
    }
  }
  return out;
}

const NON_BIOMED = /\b(?:mechanical|electrical|civil|chemical engineering|computer science|software|business|management sciences|economics|commerce|mathematics|physics|english|law|architecture|mass communication|islamic studies)\b/i;

// ------------------------------------------------------------------ duplicate submissions (text fingerprints)

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Sampled 6-word shingles of the manuscript text */
function shingles(text) {
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
  const out = new Set();
  for (let i = 0; i + 6 <= words.length; i++) {
    const h = fnv(words.slice(i, i + 6).join(' '));
    if (h % 8 === 0) out.add(h);
  }
  return [...out].slice(0, 6000);
}

async function duplicateSubmissions({ body, meta, excludeCode }) {
  const mine = new Set(shingles(body));
  const rows = await db.all("SELECT id, check_id, manuscript_code, title, data, created_at FROM fingerprints WHERE kind = 'text' ORDER BY created_at DESC LIMIT 3000");
  const out = [];
  for (const r of rows) {
    if (excludeCode && r.manuscript_code && r.manuscript_code === excludeCode) continue;
    const theirs = r.data?.shingles || [];
    let inter = 0;
    for (const h of theirs) if (mine.has(h)) inter++;
    const overlap = mine.size && theirs.length ? inter / Math.min(mine.size, theirs.length) : 0;
    const tsim = meta.title && r.title ? titleSimilarity(meta.title, r.title) : 0;
    if (overlap >= 0.2 || tsim >= 0.9) out.push({ manuscriptCode: r.manuscript_code, title: r.title, checkId: r.check_id, date: r.created_at, textOverlap: Math.round(overlap * 100), titleSimilarity: Math.round(tsim * 100) });
  }
  return { compared: rows.length, matches: out.sort((a, b) => b.textOverlap - a.textOverlap).slice(0, 10), shingles: [...mine] };
}

async function previousAuthors(code, version) {
  if (!code) return null;
  const row = await db.one("SELECT data FROM fingerprints WHERE kind = 'text' AND manuscript_code = $1 ORDER BY created_at DESC LIMIT 1", [code]);
  return row?.data?.authors || null;
}

/** Store the fingerprint of a screened manuscript (after the check is saved) */
async function storeFingerprint({ checkId, userId, meta, shingles: sh }) {
  if (!sh?.length) return;
  await db.query("INSERT INTO fingerprints(check_id, user_id, manuscript_code, kind, title, data) VALUES($1, $2, $3, 'text', $4, $5)",
    [checkId || null, userId || null, meta.manuscriptCode || null, (meta.title || '').slice(0, 300), JSON.stringify({ shingles: sh, authors: (meta.authors || []).map(a => `${a.given} ${a.family}`.trim()), abstract: (meta.abstract || '').slice(0, 1500) })]);
}

// ------------------------------------------------------------------ scoring

function riskLevel(signals) {
  const score = signals.reduce((a, s) => a + s.weight, 0);
  const highs = signals.filter(s => s.severity === 'high').length;
  let level = score >= 8 || highs >= 2 ? 'HIGH' : score >= 4 || highs === 1 ? 'MEDIUM' : 'LOW';
  return { level, score, highSignals: highs };
}

/**
 * input: { text (whole manuscript), body, meta, references: reference-check results, pattern?, suggestedReviewers?,
 *          images?: Module 5 summary { findings, level } }
 */
async function detectPaperMill(input, update = () => {}) {
  const text = input.text || input.body || '';
  const body = input.body || text;
  const meta = input.meta || {};
  const refs = input.references || [];
  const signals = [];
  const sig = (group, code, title, severity, weight, evidence = [], note = '') => signals.push({ group, code, title, severity, weight, evidence, note });

  update('Searching for tortured phrases and AI-text leftovers', 2);
  const tortured = torturedPhrases(body, await customPhrases());
  if (tortured.length) sig('text', 'tortured', `${tortured.length} tortured phrase(s): ${tortured.slice(0, 3).map(t => `“${t.phrase}” (= ${t.correct})`).join(', ')}`, tortured.length >= 3 ? 'high' : 'medium', tortured.length >= 3 ? 5 : 2,
    tortured.map(t => ({ text: `“${t.phrase}” → ${t.correct}${t.count > 1 ? ` (×${t.count})` : ''}`, quote: t.examples[0] })), 'Odd synonyms produced by paraphrasing tools to hide copied text (Problematic Paper Screener).');
  const ai = aiLeftovers(text);
  if (ai.length) sig('text', 'ai-leftover', `AI-generated text or template left in the manuscript (${ai.length})`, 'high', Math.min(6, 4 + ai.length - 1), ai.map(a => ({ text: a.label, quote: a.example })), 'Only definite traces are flagged; no AI-probability score is used.');
  const tmpl = templateWording(body);
  if (tmpl.length >= 3) sig('text', 'template', `Wording typical of paper-mill templates (${tmpl.length} features)`, 'medium', tmpl.length >= 5 ? 3 : 2, tmpl.map(t => ({ text: t.label, quote: t.example })), 'These methods are legitimate on their own; several together are typical of templated mill papers.');
  const methods = methodsGaps(body);
  if (methods.gaps.length) sig('text', 'methods', `Methods too vague to repeat (${methods.gaps.length})`, methods.gaps.some(g => g.code === 'ethics') ? 'medium' : 'low', Math.min(3, methods.gaps.length), methods.gaps.map(g => ({ text: g.message })));

  const hid = hiddenText(text);
  if (hid.zero >= 5 || hid.mixed.length) {
    const strongHid = hid.mixed.length >= 2 || hid.zero >= 20;
    sig('text', 'hidden-text', `Hidden characters or mixed-alphabet words (${hid.zero} invisible characters, ${hid.mixed.length} mixed-alphabet words)`, strongHid ? 'high' : 'medium', strongHid ? 4 : 2,
      [...(hid.zero ? [{ text: `${hid.zero} zero-width / soft-hyphen characters` }] : []), ...hid.mixed.map(w => ({ text: `Word mixing Latin and Cyrillic/Greek letters: “${w}”` }))], 'Used to defeat plagiarism-detection software; normal text contains neither.');
  }

  update('Checking whether the paper is already published', 15);
  const pub = await publishedElsewhere(meta.title).catch(() => []);
  if (pub.length) sig('data', 'published', `A paper with the same title is already published (${pub.length})`, 'medium', 3,
    pub.map(p => ({ text: `“${p.title}” — ${p.journal || 'journal unknown'}${p.year ? ', ' + p.year : ''}`, link: `https://doi.org/${p.doi}` })), "Possible duplicate publication or resubmission; it may also be the authors' own preprint or thesis - check before concluding.");

  update('Checking reference signals', 25);
  const fake = refs.filter(r => r.status === 'suspicious');
  if (fake.length) sig('references', 'fabricated', `${fake.length} reference(s) not found in any database (possibly fabricated)`, fake.length >= 3 ? 'high' : 'medium', fake.length >= 3 ? 4 : 2, fake.slice(0, 10).map(r => ({ text: `[${r.index}] ${r.raw.slice(0, 160)}`, note: r.reason })));
  const millRetracted = refs.filter(r => r.retraction && /paper mill|fake peer review|peer review manipul|randomly generated/i.test(r.retraction.reason || ''));
  if (millRetracted.length) sig('references', 'mill-retraction', `${millRetracted.length} cited paper(s) retracted for paper-mill reasons`, 'high', Math.min(8, 4 * millRetracted.length), millRetracted.map(r => ({ text: `[${r.index}] ${r.record?.title || r.raw.slice(0, 140)}`, note: r.retraction.reason?.split(';').slice(0, 3).join('; ') })));
  const otherRetracted = refs.filter(r => r.status === 'retracted' && !millRetracted.includes(r));
  if (otherRetracted.length) sig('references', 'retracted', `${otherRetracted.length} retracted paper(s) cited`, 'low', 1, otherRetracted.map(r => ({ text: `[${r.index}] ${r.record?.title || r.raw.slice(0, 140)}` })));

  const journals = new Map();
  for (const r of refs) { const j = r.record?.journal || r.parsed?.journal; if (j) { const k = normalizeJournal(j); if (!journals.has(k)) journals.set(k, { name: j, refs: [] }); journals.get(k).refs.push(r.index); } }
  const risky = [];
  for (const j of [...journals.values()].slice(0, 80)) {
    const m = await D.predatoryMatches({ journal: j.name }).catch(() => []);
    if (m.length) risky.push({ ...j, kind: m.some(x => x.kind === 'hijacked') ? 'hijacked' : 'predatory' });
  }
  const riskyRefs = risky.reduce((a, j) => a + j.refs.length, 0);
  if (riskyRefs) sig('references', 'predatory', `${riskyRefs} reference(s) to predatory or hijacked journals`, riskyRefs >= 3 ? 'medium' : 'low', riskyRefs >= 3 ? 3 : 1, risky.map(j => ({ text: `${j.name} (${j.kind}) — refs ${j.refs.map(i => `[${i}]`).join(' ')}` })));
  for (const f of (input.pattern?.flags || []).filter(f => ['citation-stacking', 'author-concentration', 'journal-concentration', 'irrelevant-self-citation', 'citation-blocks'].includes(f.code))) {
    sig('references', 'stacking', f.message, f.severity === 'high' ? 'medium' : 'low', f.severity === 'high' ? 2 : 1, [], f.guidance);
  }

  update('Checking authors (retractions, ORCID, e-mail addresses)', 40);
  const authors = (meta.authors || []).filter(a => a.family);
  const retr = await authorRetractions(authors);
  const millRetr = retr.filter(r => r.mill);
  if (millRetr.length) sig('authors', 'author-mill-retraction', `Author(s) with earlier retractions for paper-mill or fake-peer-review reasons (${millRetr.length})`, 'high', 5, millRetr.map(r => ({ text: `${r.author}: “${r.title}” (${r.journal}, retracted ${r.date})`, note: r.reason?.split(';').slice(0, 3).join('; '), link: r.doi ? `https://doi.org/${r.doi}` : null })), 'Matched by name in Retraction Watch — confirm it is the same person (affiliation, ORCID).');
  else if (retr.length) sig('authors', 'author-retraction', `Author(s) with earlier retractions (${retr.length})`, 'medium', 2, retr.map(r => ({ text: `${r.author}: “${r.title}” (${r.journal}, retracted ${r.date})`, note: r.reason?.split(';').slice(0, 2).join('; '), link: r.doi ? `https://doi.org/${r.doi}` : null })), 'Matched by name in Retraction Watch — confirm it is the same person.');

  const emails = emailsOf(text);
  const free = emails.filter(e => FREE_MAIL.test(e));
  if (emails.length && free.length === emails.length) sig('authors', 'free-mail', `All author e-mail addresses are free-mail accounts (${free.length})`, 'low', 1, free.map(e => ({ text: e })), 'Common and often legitimate in Pakistan; counts only together with other signals.');

  const orcids = [...new Set([...text.slice(0, 15000).matchAll(ORCID_RE)].map(m => m[1]))];
  const orcidResults = [];
  if (!orcids.length) sig('authors', 'no-orcid', 'No ORCID iD given for any author', 'low', 1);
  for (const id of orcids.slice(0, 10)) {
    if (!orcidValid(id)) { orcidResults.push({ id, valid: false }); continue; }
    const p = await orcidProfile(id).catch(e => ({ id, error: e.message }));
    orcidResults.push({ ...p, valid: true });
  }
  const badOrcid = orcidResults.filter(o => o.valid === false || o.exists === false);
  const emptyOrcid = orcidResults.filter(o => o.exists && o.works === 0);
  if (badOrcid.length) sig('authors', 'orcid-invalid', `${badOrcid.length} ORCID iD(s) invalid or not registered`, 'medium', 2, badOrcid.map(o => ({ text: o.id })));
  if (emptyOrcid.length) sig('authors', 'orcid-empty', `${emptyOrcid.length} ORCID record(s) with no publications`, 'low', 1, emptyOrcid.map(o => ({ text: `${o.id}${o.name ? ' — ' + o.name : ''}`, link: `https://orcid.org/${o.id}` })));

  const offTopicAff = (meta.affiliations || []).filter(a => NON_BIOMED.test(a));
  if (offTopicAff.length && (meta.affiliations || []).length) sig('authors', 'affiliation', 'Affiliation(s) unrelated to a pharmaceutical/biomedical topic', 'low', 1, offTopicAff.map(a => ({ text: a })), 'Interdisciplinary teams are common; check that each author\'s contribution is plausible.');

  const prev = await previousAuthors(meta.manuscriptCode, meta.version).catch(() => null);
  if (prev && authors.length) {
    const now = authors.map(a => `${a.given} ${a.family}`.trim());
    const same = (x, y) => !!nameMatch(splitName(x), splitName(y));
    const added = now.filter(n => !prev.some(p => same(p, n)));
    const removed = prev.filter(p => !now.some(n => same(p, n)));
    const reordered = !added.length && !removed.length && prev.join('|') !== now.join('|');
    if (added.length || removed.length || reordered) sig('authors', 'authorship-change', 'Authors changed since the earlier version', added.length ? 'medium' : 'low', added.length ? 2 : 1,
      [...added.map(n => ({ text: `Added: ${n}` })), ...removed.map(n => ({ text: `Removed: ${n}` })), ...(reordered ? [{ text: `Order changed: ${prev.join(', ')} → ${now.join(', ')}` }] : [])], 'Authorship sold by paper mills often appears as authors added during revision.');
  }

  const revText = String(input.suggestedReviewers || '');
  if (revText.trim()) {
    const revEmails = [...new Set((revText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(e => e.toLowerCase()))];
    const authorDomains = new Set(emails.map(e => e.split('@')[1]).filter(d => !FREE_MAIL.test('@' + d)));
    const issues = [];
    for (const e of revEmails) {
      if (FREE_MAIL.test(e)) issues.push({ text: `${e} — free-mail address for a suggested reviewer` });
      else if (authorDomains.has(e.split('@')[1])) issues.push({ text: `${e} — same institution e-mail domain as an author` });
    }
    for (const a of authors) if (new RegExp(`\\b${esc(a.family)}\\b`, 'i').test(revText) && a.family.length > 3) issues.push({ text: `A suggested reviewer shares the surname “${a.family}” with an author` });
    if (issues.length) sig('authors', 'reviewers', `Suggested reviewers raise concerns (${issues.length})`, issues.length >= 2 ? 'medium' : 'low', issues.length >= 2 ? 2 : 1, issues, 'Fake reviewer accounts with free-mail addresses are a known paper-mill technique.');
  }

  update('Checking cell lines and earlier submissions', 70);
  const cells = cellLines(body);
  if (cells.length) sig('data', 'cell-lines', `${cells.length} misidentified or contaminated cell line(s) named`, 'medium', Math.min(4, 2 * cells.length), cells.map(c => ({ text: `${c.name} is actually ${c.actual} (ICLAC register)`, quote: c.example })), 'Results attributed to the named tissue may be invalid; ask for authentication (STR profile).');

  const dup = await duplicateSubmissions({ body, meta, excludeCode: meta.manuscriptCode }).catch(e => ({ compared: 0, matches: [], shingles: [], error: e.message }));
  const strong = dup.matches.filter(m => m.textOverlap >= 50 || m.titleSimilarity >= 90);
  if (strong.length) sig('data', 'duplicate', `Matches an earlier PJPS submission (${strong.length})`, 'high', 5, strong.map(m => ({ text: `${m.manuscriptCode || 'check #' + m.checkId}: “${m.title || ''}” — ${m.textOverlap}% text overlap${m.titleSimilarity >= 90 ? `, title ${m.titleSimilarity}% similar` : ''}`, checkId: m.checkId })));
  else if (dup.matches.length) sig('data', 'duplicate-partial', `Partial text overlap with earlier PJPS submission(s) (${dup.matches.length})`, 'medium', 3, dup.matches.map(m => ({ text: `${m.manuscriptCode || 'check #' + m.checkId}: “${m.title || ''}” — ${m.textOverlap}% overlap`, checkId: m.checkId })));

  if (input.images?.findings) {
    const f = input.images.findings;
    const cat = input.images.categories || {};
    const catText = Object.entries({ duplication: 'duplicated', manipulation: 'manipulated', ai: 'AI-generated', chart: 'duplicated-chart' }).filter(([k]) => cat[k]).map(([k, l]) => `${cat[k]} ${l}`).join(', ');
    if (f.high) sig('data', 'images', `Image Integrity (Module 5): ${f.high} strong finding(s)${catText ? ` (${catText})` : ' of duplicated or edited figures'}`, 'high', 5);
    else if (f.medium) sig('data', 'images', `Image Integrity (Module 5): ${f.medium} finding(s) to check`, 'medium', 2);
  }

  const risk = riskLevel(signals);
  const groups = ['text', 'references', 'authors', 'data'];
  return {
    kind: 'papermill',
    module: 4,
    meta: { ...meta, authors: authors.map(a => ({ name: a.name || `${a.given} ${a.family}`.trim(), given: a.given, family: a.family })) },
    createdAt: new Date().toISOString(),
    risk,
    signals: signals.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || b.weight - a.weight),
    details: {
      tortured, aiLeftovers: ai, templates: tmpl, methods, cellLines: cells, emails, freeMail: free, orcids: orcidResults,
      authorRetractions: retr, duplicates: { compared: dup.compared, matches: dup.matches }, publishedElsewhere: pub, hiddenText: hid,
      references: { total: refs.length, fabricated: fake.length, retracted: refs.filter(r => r.status === 'retracted').length, millRetracted: millRetracted.length, riskyJournals: risky }
    },
    checked: {
      text: true, references: refs.length > 0, authors: authors.length > 0, orcid: orcids.length > 0, reviewers: !!revText.trim(),
      previousVersion: !!prev, images: !!input.images, earlierSubmissions: dup.compared
    },
    disclaimer: 'Screening aid only. The risk level shows where to look closer; it is not proof of misconduct and never rejects a paper by itself. The editor decides. Confidential — not for authors or reviewers.',
    _shingles: dup.shingles
  };
}

function papermillProblems(r) {
  return [`Paper mill risk ${r.risk.level} (score ${r.risk.score})`, ...r.signals.filter(s => s.severity !== 'low').slice(0, 5).map(s => s.title)];
}

module.exports = { detectPaperMill, storeFingerprint, papermillProblems, torturedPhrases, aiLeftovers, templateWording, methodsGaps, cellLines, orcidValid, shingles, riskLevel };
