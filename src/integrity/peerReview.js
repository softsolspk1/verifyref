// integrity/peerReview.js - Peer-review integrity. For one manuscript and its reviewers (and, optionally, their reports):
//   identity   - free-mail address, ORCID check digit / registration / name, reviewer suggested by the authors
//   conflicts  - same institution or e-mail domain as an author, shared surname, co-authorship with an author (OpenAlex)
//   the report - generic text with nothing specific to this manuscript, requests to cite particular papers (coercive
//                citation, especially the reviewer's own), AI-writing traces, the same report text reused for another
//                manuscript, a report returned implausibly fast
//   rings      - the same reviewer e-mail suggested by unrelated author teams (from the Integrity Screening archive)
const db = require('../db');
const cfg = require('../config');
const { getJson, isOnline } = require('../http');
const { splitName, nameMatch, STOPWORDS } = require('../text');
const { orcidValid, orcidProfile, aiLeftovers } = require('../papermill');
const { analyzeAiWriting } = require('./aiWriting');
const { sentenceHashes } = require('./similarity');
const { dimension, finish, FREE_MAIL_RE, words } = require('./common');

const GENERIC = [/\bthe (?:paper|manuscript) is (?:well|nicely) written\b/i, /\bthe (?:authors|author) (?:should|must) (?:improve|revise) the english\b/i, /\bthe (?:introduction|discussion) (?:should|needs to) be (?:improved|expanded|strengthened)\b/i,
  /\b(?:more|recent) references (?:should|must|need to) be (?:added|included|cited)\b/i, /\bthe novelty (?:should|must|needs to) be (?:highlighted|clarified)\b/i, /\baccept(?:ed)? (?:as it is|in (?:its )?present form)\b/i, /\bminor (?:revision|corrections?)\b/i];
const COERCE = /\b(?:please|kindly|authors? (?:should|must|are (?:advised|requested|encouraged) to))\s+(?:also\s+)?(?:cite|include|refer to|add (?:the )?(?:following|these) (?:references|papers|studies|works)|consider citing)\b/i;

async function openalexAuthor(name, orcid) {
  const key = cfg.OPENALEX_API_KEY ? `&api_key=${cfg.OPENALEX_API_KEY}` : '';
  const url = orcid ? `https://api.openalex.org/authors/orcid:${orcid}` : `https://api.openalex.org/authors?search=${encodeURIComponent(name)}&per-page=1${key}`;
  const r = await getJson(url, { ttl: 14 * 86400, timeout: 12000, retries: 1 });
  if (!r.ok) return null;
  return orcid ? r.data : r.data?.results?.[0] || null;
}

/** Works the reviewer co-authored with any manuscript author (OpenAlex, last 10 years) */
async function coauthorships(reviewer, authors) {
  const a = await openalexAuthor(reviewer.name, reviewer.orcid);
  if (!a?.id) return { checked: false, items: [] };
  const id = a.id.replace('https://openalex.org/', '');
  const key = cfg.OPENALEX_API_KEY ? `&api_key=${cfg.OPENALEX_API_KEY}` : '';
  const since = new Date().getFullYear() - 10;
  const r = await getJson(`https://api.openalex.org/works?filter=author.id:${id},from_publication_date:${since}-01-01&per-page=100&select=id,doi,title,publication_year,authorships${key}`, { ttl: 7 * 86400, timeout: 15000, retries: 1 });
  if (!r.ok) return { checked: false, items: [] };
  const items = [];
  for (const w of r.data?.results || []) {
    const names = (w.authorships || []).map(x => x.author?.display_name || '');
    const shared = authors.filter(au => names.some(n => nameMatch(splitName(n), au) === 'exact'));
    if (shared.length) items.push({ title: w.title, year: w.publication_year, link: w.doi || w.id, with: shared.map(s => s.name || `${s.given} ${s.family}`) });
  }
  return { checked: true, openalexId: id, displayName: a.display_name, institution: a.last_known_institutions?.[0]?.display_name || a.last_known_institution?.display_name || '', items };
}

/** Words of the review that are specific to this manuscript (appear in the manuscript text, not common words) */
function specificity(review, manuscript) {
  if (!manuscript) return null;
  const ms = new Set(words(manuscript).filter(w => w.length > 5 && !STOPWORDS.has(w)));
  const rv = [...new Set(words(review).filter(w => w.length > 5 && !STOPWORDS.has(w)))];
  return { specific: rv.filter(w => ms.has(w)).length, total: rv.length };
}

/**
 * input: { manuscriptCode, title, authors: [{name, given, family}], affiliations: [], authorEmails: [], manuscriptText?,
 *          suggestedReviewers?: text, reviewers: [{ name, email, orcid, institution, report, invitedAt, returnedAt }] }
 */
async function analyzePeerReview(input, { online = isOnline() } = {}) {
  const d = dimension('peer', 'Peer-review integrity');
  const authors = (input.authors || []).filter(a => a.family);
  const authorDomains = new Set((input.authorEmails || []).filter(e => !FREE_MAIL_RE.test(e)).map(e => e.split('@')[1]));
  const affText = (input.affiliations || []).join(' ').toLowerCase();
  const suggested = String(input.suggestedReviewers || '').toLowerCase();
  const reviewers = [];

  for (const rv of (input.reviewers || []).slice(0, 10)) {
    const r = { ...rv, name: String(rv.name || '').trim(), email: String(rv.email || '').trim().toLowerCase(), orcid: (String(rv.orcid || '').match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/) || [])[0] || null, findings: [] };
    const label = r.name || r.email || 'Reviewer';
    const add = (code, text, severity, weight, note = '', link = null) => r.findings.push({ code, text, severity, weight, note, link });
    const split = splitName(r.name);

    // identity
    if (r.email && FREE_MAIL_RE.test(r.email)) add('free-mail', `${label}: free-mail address (${r.email})`, 'low', 1, 'Fake reviewer accounts are usually free-mail addresses; ask for an institutional address or confirm through ORCID / the institution\'s website.');
    if (r.email && suggested.includes(r.email)) add('suggested', `${label}: suggested by the authors`, 'low', 0.5, 'Author-suggested reviewers are allowed but need independent verification.');
    if (r.orcid && !orcidValid(r.orcid)) add('orcid-invalid', `${label}: ORCID ${r.orcid} has a wrong check digit`, 'medium', 2);
    else if (r.orcid && online) {
      const p = await orcidProfile(r.orcid).catch(() => null);
      if (p?.exists === false) add('orcid-missing', `${label}: ORCID ${r.orcid} is not registered`, 'high', 4);
      else if (p?.name && r.name && !nameMatch(splitName(p.name), split)) add('orcid-name', `${label}: ORCID ${r.orcid} belongs to “${p.name}”`, 'high', 4, 'The reviewer identity does not match the ORCID record — a typical fake-reviewer technique.', `https://orcid.org/${r.orcid}`);
      r.orcidRecord = p;
    }
    // conflicts of interest
    if (r.email && authorDomains.has(r.email.split('@')[1])) add('same-domain', `${label}: same institutional e-mail domain as an author (${r.email.split('@')[1]})`, 'medium', 2, 'Reviewers from the authors\' own institution have a conflict of interest.');
    if (r.institution && affText && r.institution.length > 6 && affText.includes(r.institution.toLowerCase().slice(0, 25))) add('same-institution', `${label}: same institution as an author (${r.institution})`, 'medium', 2);
    const fam = authors.find(a => split.family && a.family.toLowerCase() === split.family.toLowerCase() && split.family.length > 3);
    if (fam) add('same-surname', `${label}: shares the surname “${fam.family}” with an author`, 'low', 1, 'May be a relative; ask about the relationship.');
    if (authors.some(a => nameMatch(a, split) === 'exact')) add('is-author', `${label} is one of the manuscript's authors`, 'high', 5);
    if (online && r.name && authors.length) {
      const co = await coauthorships(r, authors).catch(() => ({ checked: false, items: [] }));
      r.coauthorship = co;
      if (co.items.length) add('coauthor', `${label}: co-authored ${co.items.length} paper(s) with the authors in the last 10 years`, co.items.length >= 2 ? 'high' : 'medium', co.items.length >= 2 ? 4 : 2, `With ${[...new Set(co.items.flatMap(i => i.with))].join(', ')}. ICMJE / COPE: recent co-authors should not review.`, co.items[0].link);
    }
    // the report
    const rep = String(r.report || '').trim();
    if (rep) {
      const generic = GENERIC.filter(re => re.test(rep)).length;
      const spec = specificity(rep, input.manuscriptText);
      const wc = words(rep).length;
      r.reportStats = { words: wc, generic, specificity: spec };
      if (wc < 80) add('short', `${label}: very short report (${wc} words)`, 'low', 1);
      if ((generic >= 2 && spec && spec.specific < 5) || (spec && spec.total >= 30 && spec.specific / spec.total < 0.1)) add('generic', `${label}: generic report with little that refers to this manuscript`, 'medium', 2, 'Template reports that could fit any paper are a sign of a fake or careless review.');
      const coerce = rep.match(COERCE);
      const cited = (rep.match(/\b10\.\d{4,9}\/[^\s"<>,;]+/g) || []).length + (rep.match(/\(\s*[A-Z][a-z]+(?: et al\.?)?,? \d{4}\s*\)/g) || []).length;
      if (coerce && cited >= 2) add('coercive-citation', `${label}: asks the authors to cite ${cited} specific paper(s)`, cited >= 4 ? 'high' : 'medium', cited >= 4 ? 4 : 2, 'Check whether the requested papers are the reviewer\'s own or from one group (citation coercion, COPE).');
      const lo = aiLeftovers(rep);
      const ai = wc >= 300 ? analyzeAiWriting(rep) : null;
      if (lo.length) add('ai-report', `${label}: chatbot text left in the report`, 'high', 3, 'Uploading a confidential manuscript into a public AI tool breaches reviewer confidentiality.');
      else if (ai && ai.details.score >= 45) add('ai-report', `${label}: report written in a style typical of AI tools (indicator ${ai.details.score}/100)`, 'low', 1);
      const hashes = [...sentenceHashes(rep).keys()];
      r._hashes = hashes;
      if (hashes.length) {
        const rows = await db.all('SELECT manuscript_code, reviewer_name, sentence_hashes FROM review_records ORDER BY created_at DESC LIMIT 3000');
        const reused = rows.filter(x => x.manuscript_code !== (input.manuscriptCode || null)).map(x => ({ x, n: (x.sentence_hashes || []).filter(h => hashes.includes(h)).length })).filter(y => y.n >= 3);
        if (reused.length) add('review-recycled', `${label}: report text reused from review(s) of other manuscripts (${reused.length})`, 'high', 4, reused.slice(0, 4).map(y => `${y.x.manuscript_code || 'another manuscript'} (${y.n} identical sentences${y.x.reviewer_name ? `, reviewer ${y.x.reviewer_name}` : ''})`).join('; '));
      }
    }
    if (r.invitedAt && r.returnedAt) {
      const hours = (new Date(r.returnedAt) - new Date(r.invitedAt)) / 3600000;
      if (hours >= 0 && hours < 24) add('fast', `${label}: report returned ${Math.round(hours)} hour(s) after the invitation`, 'medium', 2, 'Very fast returns are typical of reviewer accounts controlled by the authors.');
    }
    // rings: this reviewer suggested by other teams
    if (r.email) {
      const rows = await db.all("SELECT manuscript_code, authors FROM integrity_records WHERE reviewer_emails @> $1::jsonb AND created_at > now() - interval '2 years'", [JSON.stringify([r.email])]).catch(() => []);
      const other = rows.filter(x => x.manuscript_code !== (input.manuscriptCode || null) && !(x.authors || []).some(n => authors.some(a => nameMatch(splitName(n), a) === 'exact')));
      if (other.length) add('ring', `${label}: also suggested by ${other.length} unrelated author team(s)`, other.length >= 2 ? 'high' : 'medium', other.length >= 2 ? 4 : 2, other.slice(0, 4).map(x => x.manuscript_code || '—').join(', '));
    }
    reviewers.push(r);
  }

  for (const r of reviewers) for (const f of r.findings) d.sig(f.code, f.text, f.severity, f.weight, f.link ? [{ text: f.note || f.text, link: f.link }] : f.note ? [{ text: f.note }] : [], '');
  d.details = { reviewers: reviewers.map(({ _hashes, report, ...r }) => ({ ...r, reportPreview: report ? String(report).slice(0, 400) : '' })), online };
  d.checked = reviewers.length > 0;
  d._reviews = reviewers.filter(r => r._hashes?.length).map(r => ({ name: r.name, email: r.email, hashes: r._hashes }));
  return finish(d);
}

async function storeReviews(checkId, code, reviews) {
  for (const r of reviews || []) await db.query('INSERT INTO review_records(check_id, manuscript_code, reviewer_name, reviewer_email, sentence_hashes) VALUES($1,$2,$3,$4,$5)', [checkId || null, code || null, r.name || null, r.email || null, JSON.stringify(r.hashes)]);
}

module.exports = { analyzePeerReview, storeReviews, specificity };
