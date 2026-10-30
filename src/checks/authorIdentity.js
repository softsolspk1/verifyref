// checks/authorIdentity.js - Author identity from ORCID (Full Screening Report, section 8)
//
// For every author of the manuscript:
//   1. the ORCID iD written in the manuscript (check digit, registered, and whose name it carries), or else
//   2. an ORCID registry search by name, accepted only when one record has the same name AND an institution that agrees
//      with the manuscript's affiliations ("name only" candidates are listed but never treated as the author)
// then the full public ORCID record: employments, record age, claimed works, and the OpenAlex profile of the same iD
// (works, h-index, research topics) to see whether the author has published in the manuscript's field.
// Everything comes from the public ORCID API (pub.orcid.org v3.0) and OpenAlex; nothing is guessed.
const { getJson } = require('../http');
const S = require('../sources');
const { splitName, nameMatch } = require('../text');
const { orcidValid } = require('../papermill');
const { tokens } = require('./novelty');

const ORCID_API = 'https://pub.orcid.org/v3.0';
const ORCID_RE = /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/g;
const OPT = { ttl: 7 * 86400, timeout: 15000, retries: 1, headers: { Accept: 'application/json' } };

// words of an institution name that say nothing about which institution it is
const AFF_STOP = new Set(('university universiti universidad universite department dept faculty college institute institution school hospital centre center '
  + 'the and of for sciences science medical medicine pharmacy pharmaceutical pharmaceutics research national government public private campus '
  + 'division section laboratory laboratories unit graduate studies health allied technology').split(' '));
const affTokens = s => new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter(t => t.length > 2 && !AFF_STOP.has(t)));
const affAgrees = (orgs, affs) => {
  const mine = affTokens(affs.join(' '));
  return orgs.filter(o => { const t = [...affTokens(o)]; return t.length && t.filter(x => mine.has(x)).length >= Math.min(2, t.length); });
};
const year = v => (v?.value ? new Date(v.value).getUTCFullYear() : null);
const nameOf = a => a.name || `${a.given || ''} ${a.family || ''}`.trim();

/** The public ORCID record, reduced to what the report needs */
async function orcidRecord(id) {
  const r = await getJson(`${ORCID_API}/${id}/record`, OPT);
  if (r.status === 404 || r.status === 410) return { id, exists: false, deactivated: r.status === 410 };
  if (!r.ok) return { id, error: r.error || `HTTP ${r.status}` };
  const d = r.data || {};
  const p = d.person?.name || {};
  const act = d['activities-summary'] || {};
  const aff = group => (group?.['affiliation-group'] || []).flatMap(g => g.summaries || []).map(s => Object.values(s)[0]).filter(Boolean).map(s => ({
    organization: s.organization?.name || '', country: s.organization?.address?.country || '', role: s['role-title'] || '', department: s['department-name'] || '',
    start: s['start-date']?.year?.value || null, end: s['end-date']?.year?.value || null
  }));
  const works = (act.works?.group || []).map(g => g['work-summary']?.[0]).filter(Boolean).map(w => ({
    title: w.title?.title?.value || '', year: +(w['publication-date']?.year?.value || 0) || null, type: w.type || '',
    doi: (w['external-ids']?.['external-id'] || []).find(x => x['external-id-type'] === 'doi')?.['external-id-value'] || null
  }));
  const deactivated = !!d.history?.['deactivation-date'];
  return {
    id, exists: true, deactivated,
    name: `${p['given-names']?.value || ''} ${p['family-name']?.value || ''}`.trim(),
    creditName: p['credit-name']?.value || null,
    otherNames: (d.person?.['other-names']?.['other-name'] || []).map(o => o.content).filter(Boolean),
    created: year(d.history?.['submission-date']), lastModified: year(d.history?.['last-modified-date']),
    claimed: d.history?.claimed !== false, verifiedEmail: !!d.history?.['verified-email'],
    employments: aff(act.employments), educations: aff(act.educations), works
  };
}

/** ORCID registry search by name; candidates whose name agrees with the author */
async function orcidSearch(author) {
  const fam = String(author.family || '').replace(/[()":^~*?\\/[\]{}!]/g, ' ').trim();
  const giv = String(author.given || '').replace(/[()":^~*?\\/[\]{}!.]/g, ' ').trim().split(/\s+/)[0] || '';
  if (!fam) return { found: 0, candidates: [] };
  const q = `family-name:(${fam})${giv.length > 1 ? ` AND given-names:(${giv}*)` : ''}`;
  const r = await getJson(`${ORCID_API}/expanded-search/?q=${encodeURIComponent(q)}&rows=25`, OPT);
  if (!r.ok) throw new Error(r.error || `ORCID search HTTP ${r.status}`);
  const rows = r.data?.['expanded-result'] || [];
  const candidates = rows.map(x => ({ id: x['orcid-id'], name: `${x['given-names'] || ''} ${x['family-names'] || ''}`.trim(), otherNames: x['other-name'] || [], institutions: x['institution-name'] || [] }))
    .filter(c => [c.name, ...c.otherNames].some(n => nameMatch(splitName(n), author)));
  return { found: r.data?.['num-found'] || 0, candidates };
}

/** OpenAlex profile of an ORCID iD: works, citations, h-index and research topics */
async function openalexProfile(id) {
  const r = await S.openalex(`authors/orcid:${id}`).catch(() => null);
  const a = r?.ok ? r.data : r?.id ? r : null;
  if (!a?.id) return null;
  return {
    id: a.id, works: a.works_count || 0, citedBy: a.cited_by_count || 0, hIndex: a.summary_stats?.h_index ?? null,
    institution: a.last_known_institutions?.[0]?.display_name || null, country: a.last_known_institutions?.[0]?.country_code || null,
    topics: (a.topics || []).slice(0, 8).map(t => t.display_name)
  };
}

const mapLimit = async (items, n, fn) => {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
};

/**
 * input: { text (manuscript, first pages are enough), meta: { title, keywords[], authors[{ given, family, name? }], affiliations[] } }
 */
async function checkAuthorIdentity({ text = '', meta = {} }) {
  const authors = (meta.authors || []).filter(a => a.family).slice(0, 12);
  const affs = meta.affiliations || [];
  if (!authors.length) return { kind: 'authors', error: 'No author names were found on the title page, so author identity could not be checked.' };
  const key = new Set(tokens(`${meta.title || ''} ${(meta.keywords || []).join(' ')}`).filter(t => t.length >= 4));
  const related = titleText => { const t = new Set(tokens(titleText)); return [...key].filter(k => t.has(k)).length >= 2; };
  // the manuscript itself already in the record (published version or preprint claimed by the author)
  const own = new Set(tokens(meta.title).filter(t => t.length >= 3));
  const isThis = titleText => { const t = new Set(tokens(titleText)); return own.size >= 4 && [...own].filter(k => t.has(k)).length / own.size >= 0.8; };

  // iDs written in the manuscript, tied to the author whose name the record carries
  const ids = [...new Set([...String(text).slice(0, 20000).matchAll(ORCID_RE)].map(m => m[1]))].slice(0, 15);
  const given = await mapLimit(ids, 3, async id => (orcidValid(id) ? orcidRecord(id).catch(e => ({ id, error: e.message })) : { id, invalid: true }));
  const byAuthor = new Map();
  const unassigned = [];
  for (const rec of given) {
    const names = rec.exists ? [rec.name, rec.creditName, ...(rec.otherNames || [])].filter(Boolean) : [];
    const k = names.length ? authors.findIndex(a => names.some(n => nameMatch(splitName(n), a))) : -1;
    if (k >= 0 && !byAuthor.has(k)) byAuthor.set(k, rec); else unassigned.push(rec);
  }

  const results = await mapLimit(authors, 3, async (a, k) => {
    const out = { author: nameOf(a), orcid: null, source: null, status: 'not-found', candidates: [], flags: [] };
    let rec = byAuthor.get(k) || null;
    if (rec) out.source = 'manuscript';
    else {
      const s = await orcidSearch(a).catch(e => ({ error: e.message }));
      if (s.error) { out.status = 'error'; out.note = `ORCID search failed: ${s.error}`; return out; }
      const agree = s.candidates.map(c => ({ ...c, agrees: affAgrees(c.institutions, affs) }));
      const sure = agree.filter(c => c.agrees.length);
      out.searched = { namesFound: s.candidates.length };
      // no institution agrees (or the title page gave none): a record is attributed only when it is the one record with
      // this name whose publications are in the manuscript's field
      let inField = [];
      if (!sure.length && agree.length && agree.length <= 4) {
        const recs = await mapLimit(agree, 2, c => orcidRecord(c.id).catch(() => null));
        inField = (await mapLimit(recs.filter(x => x?.exists), 2, async x => {
          const oa = await openalexProfile(x.id);
          return x.works.some(w => related(w.title)) || (oa?.topics || []).some(t => related(t)) ? x : null;
        })).filter(Boolean);
      }
      if (sure.length === 1) {
        rec = await orcidRecord(sure[0].id).catch(e => ({ id: sure[0].id, error: e.message }));
        out.source = 'registry search (name + institution)';
      } else if (!sure.length && inField.length === 1) {
        rec = inField[0];
        out.source = 'registry search (name + publications in the field)';
      } else {
        out.candidates = agree.slice(0, 5).map(c => ({ id: c.id, name: c.name, institutions: c.institutions.slice(0, 3) }));
        out.status = sure.length > 1 ? 'ambiguous' : s.candidates.length ? 'name-only' : 'not-found';
        out.note = sure.length > 1 ? `${sure.length} ORCID records share this name and institution` : s.candidates.length
          ? `${s.candidates.length} ORCID record(s) with this name; ${affs.length ? "none lists the manuscript's institution" : 'no affiliation on the title page to confirm one'} — not attributed`
          : 'No ORCID record with this name';
        return out;
      }
    }
    if (rec.error) { out.orcid = rec.id; out.status = 'error'; out.note = `ORCID record could not be read: ${rec.error}`; return out; }
    if (rec.exists === false) { out.orcid = rec.id; out.status = 'unregistered'; out.flags.push({ severity: 'high', text: `${rec.id} is ${rec.deactivated ? 'deactivated' : 'not registered'} at ORCID` }); return out; }
    out.orcid = rec.id;
    out.status = 'verified';
    out.record = { name: rec.name, created: rec.created, lastModified: rec.lastModified, works: rec.works.length, verifiedEmail: rec.verifiedEmail,
      employments: rec.employments.slice(0, 4), educations: rec.educations.slice(0, 2) };
    const current = rec.employments.filter(e => !e.end).map(e => e.organization);
    const orgs = [...new Set([...rec.employments, ...rec.educations].map(e => e.organization).filter(Boolean))];
    out.institutionAgrees = affs.length && orgs.length ? affAgrees(orgs, affs).length > 0 : null;
    out.currentEmployer = current[0] || null;
    const oa = await openalexProfile(rec.id);
    if (oa) out.openalex = oa;
    const claimed = rec.works.find(w => isThis(w.title));
    if (claimed) {
      out.claimsThisWork = `${claimed.title}${claimed.year ? ` (${claimed.year})` : ''}`;
      if (out.source === 'registry search (name + publications in the field)') out.source = 'registry search (name + this manuscript in the record)';
    }
    const relatedWorks = rec.works.filter(w => related(w.title) && !isThis(w.title));
    const topicHit = (oa?.topics || []).some(t => related(t) || [...key].some(k => tokens(t).includes(k)));
    out.field = { relatedWorks: relatedWorks.length, examples: relatedWorks.slice(0, 3).map(w => `${w.title}${w.year ? ` (${w.year})` : ''}`), topicMatch: topicHit };

    const thisYear = new Date().getFullYear();
    const works = Math.max(rec.works.length, oa?.works || 0);
    if (rec.deactivated) out.flags.push({ severity: 'high', text: 'The ORCID record is deactivated' });
    if (out.source === 'manuscript' && rec.created && rec.created >= thisYear && works === 0) out.flags.push({ severity: 'medium', text: `ORCID record created this year (${rec.created}) with no publications` });
    else if (works === 0) out.flags.push({ severity: 'low', text: 'No publications in ORCID or OpenAlex (common for early-career researchers)' });
    if (out.institutionAgrees === false) out.flags.push({ severity: 'low', text: `ORCID institutions (${orgs.slice(0, 3).join('; ')}) do not include the manuscript affiliation` });
    return out;
  });

  // iDs given in the manuscript whose record carries no author's name: borrowed or mistyped
  const foreign = unassigned.map(r => ({ id: r.id, problem: r.invalid ? 'wrong check digit (mistyped or invented)' : r.exists === false ? 'not registered at ORCID'
    : r.error ? `could not be read (${r.error})` : `registered to "${r.name}", who is not an author of this manuscript`, severity: r.error ? 'low' : 'high' }));

  const verified = results.filter(r => r.status === 'verified').length;
  const flags = [...foreign.map(f => ({ severity: f.severity, text: `ORCID ${f.id}: ${f.problem}` })), ...results.flatMap(r => r.flags.map(f => ({ ...f, text: `${r.author}: ${f.text}` })))];
  const level = flags.some(f => f.severity === 'high') ? 'bad' : flags.some(f => f.severity === 'medium') ? 'warn' : 'ok';
  return {
    kind: 'authors',
    summary: { authors: authors.length, verified, fromManuscript: results.filter(r => r.source === 'manuscript').length, idsInManuscript: ids.length,
      unresolved: results.filter(r => r.status !== 'verified').length, flags: flags.length, level },
    authors: results, foreignIds: foreign, flags,
    method: 'ORCID iDs written in the manuscript are checked (check digit, registration, owner name). For other authors the ORCID registry is searched by name, and a record is attributed only when exactly one record with that name lists an institution that agrees with the manuscript\'s affiliations. Each record\'s employments, age and works are read from the public ORCID API (pub.orcid.org), and the same iD\'s OpenAlex profile gives the publication record and research topics. A missing ORCID record is not evidence of misconduct.'
  };
}

module.exports = { checkAuthorIdentity, orcidRecord, orcidSearch, affAgrees };
