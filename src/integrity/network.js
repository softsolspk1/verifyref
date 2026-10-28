// integrity/network.js - Paper-mill patterns across submissions (the journal's own archive of screened manuscripts):
//   - coordinated submissions: the same e-mail address used by different author teams; bursts from one address
//   - author networks: one author on many recent submissions with changing co-authors
//   - reviewer rings: the same suggested-reviewer e-mail proposed by unrelated author teams
//   - templated titles: recent submissions whose titles follow the same pattern with different authors
//   - citation rings: the same papers cited by many unrelated submissions
// Also stores this submission's record (hashes, names, e-mails, cited DOIs) for later comparisons.
const db = require('../db');
const { splitName, nameMatch, titleSimilarity } = require('../text');
const { emailsOf } = require('../papermill');
const { dimension, finish, FREE_MAIL_RE } = require('./common');

const DAY = 86400000;
const nameKey = n => n.toLowerCase().replace(/[^a-z ]/g, '').trim();
const sameTeam = (a, b) => a.some(x => b.some(y => nameMatch(splitName(x), splitName(y)) === 'exact'));

function citedDois(referencesText) {
  return [...new Set((String(referencesText || '').match(/\b10\.\d{4,9}\/[^\s"<>,;]+/g) || []).map(x => x.replace(/[.)\]]+$/, '').toLowerCase()))].slice(0, 300);
}

function reviewerEmails(text) {
  return [...new Set((String(text || '').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(e => e.toLowerCase()))];
}

async function analyzeNetwork({ text, meta = {}, referencesText = '', suggestedReviewers = '' }) {
  const d = dimension('network', 'Submission network (paper-mill patterns)');
  const authors = (meta.authors || []).map(a => a.name || `${a.given} ${a.family}`.trim()).filter(Boolean);
  const emails = emailsOf(text);
  const revEmails = reviewerEmails(suggestedReviewers);
  const dois = citedDois(referencesText);
  const code = meta.manuscriptCode || null;
  const rows = (await db.all("SELECT id, check_id, manuscript_code, title, authors, emails, reviewer_emails, cited_dois, created_at FROM integrity_records WHERE created_at > now() - interval '2 years' ORDER BY created_at DESC LIMIT 4000"))
    .filter(r => !code || r.manuscript_code !== code);
  const others = rows.filter(r => !sameTeam(r.authors || [], authors));
  const ref = r => `${r.manuscript_code || 'check #' + r.check_id}${r.title ? `: “${r.title.slice(0, 90)}”` : ''}`;

  // Same e-mail address with a different author team
  const sharedMail = [];
  for (const e of emails) for (const r of others) if ((r.emails || []).includes(e)) sharedMail.push({ email: e, r });
  if (sharedMail.length) d.sig('shared-email', `E-mail address(es) also used on submissions by other author teams (${sharedMail.length})`, 'high', 4, sharedMail.slice(0, 8).map(x => ({ text: `${x.email} — ${ref(x.r)}`, checkId: x.r.check_id })), 'One contact address behind manuscripts of unrelated author groups is typical of a paper mill submitting for its customers.');

  // Reviewer suggested by unrelated teams
  const ring = [];
  for (const e of revEmails) {
    const hits = others.filter(r => (r.reviewer_emails || []).includes(e));
    if (hits.length) ring.push({ email: e, hits });
  }
  if (ring.length) d.sig('reviewer-ring', `Suggested reviewer(s) also proposed by other, unrelated author teams (${ring.length})`, 'high', 4, ring.map(x => ({ text: `${x.email} — also suggested on ${x.hits.length} other submission(s): ${x.hits.slice(0, 3).map(ref).join('; ')}` })), 'The same reviewer address suggested by unconnected teams points to a review ring or fake reviewer accounts.');

  // Prolific author with changing co-authors (last 180 days)
  const recent = rows.filter(r => Date.now() - new Date(r.created_at).getTime() < 180 * DAY);
  const prolific = [];
  for (const a of authors) {
    const hits = recent.filter(r => (r.authors || []).some(x => nameMatch(splitName(x), splitName(a)) === 'exact'));
    const coauthorSets = new Set(hits.map(r => (r.authors || []).map(nameKey).sort().join('|')));
    if (hits.length >= 3 && coauthorSets.size >= 3) prolific.push({ author: a, hits });
  }
  if (prolific.length) d.sig('prolific-author', `Author(s) on many recent submissions with changing co-authors (${prolific.length})`, prolific.some(p => p.hits.length >= 5) ? 'medium' : 'low', prolific.some(p => p.hits.length >= 5) ? 2 : 1,
    prolific.map(p => ({ text: `${p.author}: ${p.hits.length} other submission(s) in 6 months — ${p.hits.slice(0, 3).map(ref).join('; ')}` })), 'Authorship slots sold by paper mills show up as one name on many papers with different teams. Productive groups also do this; look at the topics.');

  // Burst from one institutional mail domain (7 days)
  const domains = [...new Set(emails.filter(e => !FREE_MAIL_RE.test(e)).map(e => e.split('@')[1]))];
  const burst = domains.map(dm => ({ dm, hits: rows.filter(r => Date.now() - new Date(r.created_at).getTime() < 7 * DAY && (r.emails || []).some(e => e.endsWith('@' + dm)) && !sameTeam(r.authors || [], authors)) })).filter(x => x.hits.length >= 3);
  if (burst.length) d.sig('burst', `Several submissions from the same institution's mail domain within a week (${burst.map(b => b.dm).join(', ')})`, 'low', 1, burst.flatMap(b => b.hits.slice(0, 4).map(r => ({ text: `${b.dm} — ${ref(r)}` }))));

  // Templated titles
  const tmpl = meta.title ? others.filter(r => r.title && Date.now() - new Date(r.created_at).getTime() < 365 * DAY).map(r => ({ r, sim: titleSimilarity(meta.title, r.title) })).filter(x => x.sim >= 0.6 && x.sim < 0.92) : [];
  if (tmpl.length >= 2) d.sig('title-template', `Titles following the same pattern as ${tmpl.length} recent submissions by other teams`, 'medium', 2, tmpl.slice(0, 6).map(x => ({ text: `${Math.round(x.sim * 100)}% similar — ${ref(x.r)}`, checkId: x.r.check_id })), 'Mills reuse a title template and swap the drug, plant or disease.');

  // Citation ring
  const ringDois = [];
  if (dois.length) {
    for (const doi of dois) {
      const teams = others.filter(r => (r.cited_dois || []).includes(doi));
      if (teams.length >= 3) ringDois.push({ doi, count: teams.length });
    }
  }
  if (ringDois.length >= 3) d.sig('citation-ring', `${ringDois.length} cited paper(s) also cited by many unrelated submissions`, ringDois.length >= 6 ? 'medium' : 'low', ringDois.length >= 6 ? 2.5 : 1,
    ringDois.sort((a, b) => b.count - a.count).slice(0, 10).map(x => ({ text: `${x.doi} — cited by ${x.count} other submissions`, link: `https://doi.org/${x.doi}` })), 'The same set of papers inserted into many manuscripts is how citation cartels and mills sell citations. Highly-cited classics are normal; look at who wrote the repeated papers.');

  d.details = { compared: rows.length, otherTeams: others.length, emails, reviewerEmails: revEmails, citedDois: dois.length, sharedEmails: sharedMail.length, reviewerRing: ring.map(x => ({ email: x.email, count: x.hits.length })), prolific: prolific.map(p => ({ author: p.author, count: p.hits.length })), templatedTitles: tmpl.length, citationRing: ringDois.slice(0, 20) };
  d.checked = true;
  d._record = { authors, emails, affiliations: meta.affiliations || [], reviewerEmails: revEmails, citedDois: dois };
  return finish(d);
}

async function storeRecord({ checkId, userId, meta, record, hashes }) {
  await db.query(`INSERT INTO integrity_records(check_id, user_id, manuscript_code, title, authors, emails, affiliations, reviewer_emails, cited_dois, sentence_hashes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [checkId || null, userId || null, meta.manuscriptCode || null, (meta.title || '').slice(0, 300),
    JSON.stringify(record.authors || []), JSON.stringify(record.emails || []), JSON.stringify(record.affiliations || []), JSON.stringify(record.reviewerEmails || []), JSON.stringify(record.citedDois || []), JSON.stringify(hashes || [])]);
}

module.exports = { analyzeNetwork, storeRecord, citedDois, reviewerEmails };
