// integrity/authors.js - Author & affiliation verification:
//   - ORCID iDs: check digit, registered, and the ORCID record's name is one of the manuscript's authors
//   - contributor roles (CRediT): a contributions statement exists and names every author
//   - affiliations matched to the Research Organization Registry (ROR): unknown or inactive institutions
//   - corresponding e-mail domain vs the institutions named
// Authorship changes between versions and earlier retractions are Module 4 signals and enter the risk score from there.
const { getJson, isOnline } = require('../http');
const { splitName, nameMatch } = require('../text');
const { orcidValid, orcidProfile, emailsOf } = require('../papermill');
const { dimension, finish, sections, FREE_MAIL_RE } = require('./common');

const CREDIT = ['conceptualization', 'conceptualisation', 'data curation', 'formal analysis', 'funding acquisition', 'investigation', 'methodology', 'project administration',
  'resources', 'software', 'supervision', 'validation', 'visualization', 'visualisation', 'writing'];

async function rorMatch(aff) {
  const r = await getJson(`https://api.ror.org/v2/organizations?affiliation=${encodeURIComponent(aff.slice(0, 250))}`, { ttl: 30 * 86400, timeout: 12000, retries: 1 });
  if (!r.ok) return { affiliation: aff, error: r.error || `HTTP ${r.status}` };
  const items = r.data?.items || [];
  const chosen = items.find(i => i.chosen) || null;
  const best = chosen || items[0] || null;
  const org = best?.organization || {};
  const name = (org.names || []).find(n => (n.types || []).includes('ror_display'))?.value || org.name || '';
  const domains = [...(org.domains || []), ...(org.links || []).map(l => String(l.value || l).replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, ''))];
  return { affiliation: aff, matched: !!chosen, score: best?.score ?? null, ror: org.id || null, name, status: org.status || null, country: org.locations?.[0]?.geonames_details?.country_name || null, domains };
}

function contributions(text, authors) {
  const sec = sections(text);
  const block = sec['author contributions'] || sec['author contribution'] || (String(text).match(/author(?:s'|'s)? contributions?\s*:?\s*([\s\S]{20,1500}?)(?:\n\s*\n|\n\s*(?:acknowledg|conflict|funding|references|data availability))/i) || [])[1] || '';
  if (!block) return { found: false };
  const lower = block.toLowerCase();
  const roles = CREDIT.filter(r => lower.includes(r));
  const named = a => {
    const fam = (a.family || '').toLowerCase();
    const ini = `${(a.given || '').split(/[\s.-]+/).filter(Boolean).map(x => x[0]).join('')}${(a.family || '')[0] || ''}`.toUpperCase();
    return (fam.length > 2 && lower.includes(fam)) || (ini.length >= 2 && new RegExp(`\\b${ini.split('').join('\\.?\\s?')}\\.?\\b`).test(block));
  };
  const all = /\ball authors\b/i.test(block);
  const unnamed = all ? [] : authors.filter(a => !named(a)).map(a => a.name || `${a.given} ${a.family}`.trim());
  return { found: true, credit: roles.length >= 2, roles, unnamed, allAuthors: all };
}

async function analyzeAuthors(text, meta = {}, { online = isOnline() } = {}) {
  const d = dimension('authors', 'Authors & affiliations');
  const authors = (meta.authors || []).filter(a => a.family);
  const head = String(text).slice(0, 15000);

  // ORCID
  const ids = [...new Set([...head.matchAll(/\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/g)].map(m => m[1]))].slice(0, 12);
  const orcids = [];
  for (const id of ids) {
    if (!orcidValid(id)) { orcids.push({ id, valid: false }); continue; }
    const p = online ? await orcidProfile(id).catch(e => ({ id, error: e.message })) : { id };
    const owner = p.name ? authors.find(a => nameMatch(splitName(p.name), a)) : null;
    orcids.push({ ...p, valid: true, author: owner ? (owner.name || `${owner.given} ${owner.family}`) : null, nameMatches: p.name ? !!owner : null });
  }
  const invalid = orcids.filter(o => o.valid === false || o.exists === false);
  if (invalid.length) d.sig('orcid-invalid', `${invalid.length} ORCID iD(s) invalid or not registered`, 'medium', 2, invalid.map(o => ({ text: `${o.id} — ${o.valid === false ? 'wrong check digit' : 'not registered at ORCID'}` })), 'An ORCID iD that does not exist is a typing error or an invented identity.');
  const foreign = orcids.filter(o => o.nameMatches === false);
  if (foreign.length) d.sig('orcid-name', `ORCID record(s) belonging to someone not in the author list (${foreign.length})`, 'medium', 2.5, foreign.map(o => ({ text: `${o.id} is registered to “${o.name}”`, link: `https://orcid.org/${o.id}` })), 'Borrowed ORCID iDs are used to make invented authors look real. Name spellings vary — check before concluding.');
  const empty = orcids.filter(o => o.exists && o.works === 0);
  if (empty.length) d.sig('orcid-empty', `${empty.length} ORCID record(s) with no publications`, 'low', 0.5, empty.map(o => ({ text: `${o.id}${o.name ? ' — ' + o.name : ''}`, link: `https://orcid.org/${o.id}` })), 'Common for early-career researchers; weak on its own.');
  if (!ids.length && authors.length) d.sig('no-orcid', 'No ORCID iD given for any author', 'low', 0.5, [], 'PJPS asks at least the corresponding author for an ORCID iD.');

  // Contributor roles
  const contrib = contributions(text, authors);
  if (!contrib.found && authors.length >= 2) d.sig('no-contributions', 'No author-contributions (CRediT) statement', 'low', 0.5, [], 'A CRediT statement makes gift and ghost authorship visible.');
  else if (contrib.found && contrib.unnamed.length && authors.length) d.sig('uncredited', `${contrib.unnamed.length} author(s) not named in the contributions statement`, contrib.unnamed.length >= 2 ? 'medium' : 'low', contrib.unnamed.length >= 2 ? 1.5 : 1, contrib.unnamed.map(n => ({ text: n })), 'An author with no stated contribution may be a gift or purchased authorship; ask what each person did.');

  // Affiliations (ROR) and e-mail domains
  const affs = (meta.affiliations || []).slice(0, 8);
  const ror = [];
  if (online) for (const a of affs) ror.push(await rorMatch(a).catch(e => ({ affiliation: a, error: e.message })));
  const unknown = ror.filter(r => !r.error && !r.matched && (r.score == null || r.score < 0.6));
  if (unknown.length) d.sig('affiliation-unknown', `${unknown.length} affiliation(s) not found in the Research Organization Registry (ROR)`, 'low', unknown.length >= 2 ? 1 : 0.5, unknown.map(r => ({ text: r.affiliation, note: r.name ? `closest: ${r.name}` : '' })), 'Small colleges and hospitals are often missing from ROR; an institution that cannot be found anywhere should be checked.');
  const inactive = ror.filter(r => r.matched && r.status && r.status !== 'active');
  if (inactive.length) d.sig('affiliation-inactive', 'Affiliation with an institution recorded as inactive or withdrawn', 'medium', 1.5, inactive.map(r => ({ text: `${r.affiliation} → ${r.name} (${r.status})`, link: r.ror })));
  const emails = emailsOf(text);
  const instDomains = emails.filter(e => !FREE_MAIL_RE.test(e)).map(e => e.split('@')[1]);
  const rorDomains = ror.flatMap(r => r.domains || []);
  const offDomain = rorDomains.length ? instDomains.filter(dm => !rorDomains.some(x => dm.endsWith(x) || x.endsWith(dm))) : [];
  if (offDomain.length && offDomain.length === instDomains.length) d.sig('email-domain', 'Institutional e-mail domains do not belong to the stated affiliations', 'low', 1, offDomain.map(x => ({ text: x })), 'Authors may have moved; a mismatch for every author is worth a question.');

  d.details = { authors: authors.map(a => a.name || `${a.given} ${a.family}`.trim()), orcids, contributions: contrib, ror, emails, online };
  d.checked = authors.length > 0 || ids.length > 0;
  return finish(d);
}

module.exports = { analyzeAuthors, rorMatch, contributions };
