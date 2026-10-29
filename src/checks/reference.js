// checks/reference.js - Reference Check: verify each reference against 12 academic databases
const S = require('../sources');
const { request, isOnline } = require('../http');
const { titleSimilarity, titleContains, nameMatch, journalSimilarity, normalize, normalizeJournal } = require('../text');
const { retractionsFor } = require('../datasets');
const { formatReference, detectStyle } = require('../format');
const { resolveJournal } = require('./journal');

const STATUS = {
  verified: { label: 'Verified', tone: 'good' },
  miscited: { label: 'Miscited', tone: 'warn' },
  retracted: { label: 'Retracted', tone: 'bad' },
  unverified: { label: 'Unverified', tone: 'neutral' },
  suspicious: { label: 'Suspicious', tone: 'bad' },
  pending: { label: 'Pending — online verification', tone: 'info' }
};

// ------------------------------------------------------------------ scoring

function firstPage(p) { return (String(p || '').match(/[A-Za-z]?\d+/) || [''])[0].replace(/^[A-Za-z]/, '').replace(/^0+(?=\d)/, ''); }
function lastPage(p) {
  const m = String(p || '').match(/[A-Za-z]?(\d+)\s*[-–—]\s*[A-Za-z]?(\d+)/);
  if (!m) return '';
  // "1563-70" -> 1570
  return m[2].length < m[1].length ? m[1].slice(0, m[1].length - m[2].length) + m[2] : m[2];
}

const TITLE_STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'for', 'to', 'with', 'by', 'at', 'from', 'as', 'is', 'are', 'its', 'their']);
/** Words of the cited title missing from the registered title; subtitles (after : or a dash) are not counted as invented */
function extraTitleWords(ref, rec) {
  const cited = String(ref.title || '');
  if (!cited || !rec?.title) return { invented: 0 };
  const tok = s => normalize(s).split(' ').filter(t => t && !TITLE_STOP.has(t));
  const reg = new Set(tok(rec.title));
  // a subtitle missing from the registered record is normal, unless the registered title already has its own subtitle
  const sub = /[:\u2013\u2014]/.test(rec.title) ? -1 : cited.search(/\s[:\u2013\u2014-]\s|:\s/);
  const main = sub > 0 ? cited.slice(0, sub) : cited;
  // symbols written out (Delta Delta C(T), alpha, beta) and single letters are not invented words
  const SYMBOL = new Set(['delta', 'alpha', 'beta', 'gamma', 'kappa', 'sigma', 'omega', 'mu', 'lambda']);
  const extras = tok(main).filter(t => !reg.has(t) && t.length > 2 && !SYMBOL.has(t));
  const regTok = tok(rec.title);
  const covered = regTok.filter(t => new Set(tok(cited)).has(t)).length;
  // only when the registered title is (almost) fully contained: the cited one then has words added to a real title
  return { invented: regTok.length && covered / regTok.length >= 0.9 ? extras.length : 0, extras };
}

/** Share of the registered title's words found in the reference as written (0 for titles under five words: too generic) */
function rawTitleCover(ref, rec) {
  const words = normalize(rec.title || '').split(' ').filter(w => w.length > 2);
  return words.length >= 5 ? titleContains(ref.raw || '', rec.title) : 0;
}

/** Score how well a database record matches the cited reference (0-100) */
function scoreCandidate(ref, rec) {
  if (!rec || !rec.title) return { score: 0 };
  let tSim = Math.max(
    titleSimilarity(ref.title || ref.raw, rec.title),
    // D7: a title with an inner full stop is cut early and the rest lands in the journal field - join them again
    ref.title && ref.journal ? titleSimilarity(`${ref.title}. ${ref.journal}`, rec.title) : 0,
    rec.shortTitle ? titleSimilarity(ref.title, rec.shortTitle) : 0,
    ref.title ? titleContains(ref.title, rec.title) * 0.95 : 0,
    ref.title ? 0 : titleContains(ref.raw, rec.title) * 0.9,
    // the whole registered title written in the reference: a match even when the fields were split wrongly
    rawTitleCover(ref, rec) * 0.92
  );
  // D10: words in the cited title that the registered title does not have (invented words) lower the match
  const extra = extraTitleWords(ref, rec);
  if (extra.invented >= 4) tSim = Math.min(tSim, 0.78);
  let authorScore = null;
  if (ref.authors?.length && rec.authors?.length) {
    const first = ref.authors[0];
    if (nameMatch(first, rec.authors[0])) authorScore = 1;
    else if (rec.authors.slice(0, 5).some(a => nameMatch(first, a))) authorScore = 0.7;
    else if (rec.authors.some(a => ref.authors.slice(0, 3).some(b => nameMatch(a, b)))) authorScore = 0.5;
    else authorScore = 0;
  }
  let yearScore = null;
  if (ref.year && rec.year) {
    const d = Math.abs(ref.year - rec.year);
    yearScore = d === 0 ? 1 : d === 1 ? 0.75 : d === 2 ? 0.3 : 0;
  }
  let journalScore = null;
  if (ref.journal && rec.journal && !ref.looksLikeBook) journalScore = journalSimilarity(ref.journal, rec.journal);
  // the "journal" is really the second half of the title (subtitle after a full stop)
  if (journalScore !== null && journalScore < 0.5 && ref.journal.includes('. ')) {
    const parts = ref.journal.split('. ');
    // the title continues up to some full stop; the journal is what follows it
    for (let k = 1; k < parts.length; k++) {
      const head = normalize(parts.slice(0, k).join(' ')), tail = parts.slice(k).join('. ');
      if (head.length > 8 && normalize(rec.title).includes(head)) { journalScore = Math.max(journalSimilarity(tail, rec.journal), rec.journalAbbrev ? journalSimilarity(tail, rec.journalAbbrev) : 0); break; }
    }
  }
  if (journalScore !== null && rec.journalAbbrev) journalScore = Math.max(journalScore, journalSimilarity(ref.journal, rec.journalAbbrev));

  const parts = [[tSim, 0.6], [authorScore, 0.2], [yearScore, 0.12], [journalScore, 0.08]].filter(([v]) => v !== null);
  const wsum = parts.reduce((a, [, w]) => a + w, 0);
  let score = parts.reduce((a, [v, w]) => a + v * w, 0) / wsum * 100;
  // A near-identical title with author agreement is decisive even if year/journal are off
  if (tSim >= 0.92 && authorScore !== 0) score = Math.max(score, 85);
  if (tSim < 0.45) score = Math.min(score, 45);
  return { score: Math.round(score), tSim, authorScore, yearScore, journalScore };
}

// ------------------------------------------------------------------ discrepancies

function compare(ref, rec, s) {
  const issues = [];
  const add = (code, severity, message, cited, registered) => issues.push({ code, severity, message, cited, registered });

  const extra = extraTitleWords(ref, rec);
  if (extra.invented >= 4) add('title-extra', 'medium', `The cited title has words that are not in the registered title (“${extra.extras.slice(0, 8).join(' ')}”)`, ref.title, rec.title);
  else if (s.tSim < 0.85 && ref.title) add('title', s.tSim < 0.65 ? 'medium' : 'low', 'Title differs from the registered record', ref.title, rec.title);
  if (s.authorScore === 0) add('author', 'medium', 'First author does not appear in the registered author list', ref.authors.map(a => a.family).join(', '), rec.authors.slice(0, 6).map(a => a.family).join(', '));
  else if (s.authorScore !== null && s.authorScore < 1) add('author-order', 'low', 'Author order differs from the registered record', ref.authors[0]?.family, rec.authors[0]?.family);
  if (ref.year && rec.year && ref.year !== rec.year) {
    const d = Math.abs(ref.year - rec.year);
    add('year', d === 1 ? 'low' : 'medium', d === 1 ? 'Year differs by one (often online-first vs print year)' : 'Publication year is wrong', ref.year, rec.year);
  }
  // a chapter matched to its book, or a book to a series, is not a wrong journal
  if (s.journalScore !== null && s.journalScore < 0.5 && !greyRef(ref) && !/book|chapter|monograph|reference-entry/i.test(rec.type || '')) {
    const preprint = rec.type === 'preprint' || /arxiv|biorxiv|medrxiv|chemrxiv|ssrn|preprint|research square|zenodo/i.test(`${rec.journal} ${rec.source}`);
    if (preprint) add('preprint', 'low', 'Matched the preprint version; the cited venue may be the published version — cite the published record', ref.journal, rec.journal);
    else add('journal', 'high', 'Real article attributed to the wrong journal', ref.journal, rec.journal);
  }
  // registries write "Volume 17" or "03"
  const vol = v => (String(v).match(/\d+/) || [''])[0].replace(/^0+(?=\d)/, '');
  if (ref.volume && rec.volume && vol(rec.volume) && vol(ref.volume) !== vol(rec.volume)) add('volume', 'medium', 'Volume number is wrong', ref.volume, rec.volume);
  if (ref.issue && rec.issue && normalize(ref.issue) !== normalize(rec.issue) && !String(rec.issue).includes(ref.issue)) add('issue', 'low', 'Issue number differs', ref.issue, rec.issue);
  if (ref.pages && rec.pages) {
    const fp = firstPage(ref.pages), rfp = firstPage(rec.pages);
    if (fp && rfp && fp !== rfp) add('pages', 'medium', 'First page is wrong', ref.pages, rec.pages);
    else {
      const lp = lastPage(ref.pages), rlp = lastPage(rec.pages);
      if (lp && rlp && lp !== rlp) add('last-page', 'low', 'Last page differs', ref.pages, rec.pages);
    }
  }
  return issues;
}

// a book, chapter, report or web page as cited ("Publisher; City, Country: 2017", "4th ed.", "accessed on", a URL)
const greyRef = ref => !!(ref.looksLikeWeb || ref.looksLikeBook || ref.type === 'book-chapter' || /\baccessed on\b|\bavailable online\b|\[internet\]|\b\d+(?:st|nd|rd|th) ed\b/i.test(ref.raw || '')
  || /;\s*[\p{Lu}][\p{L} .'&/-]+(?:,\s*[\p{L} .'/-]+)*:\s*(?:1[6-9]|20)\d{2}/u.test(ref.raw || ''));

/** A same- or similar-title record that disagrees on authors / year / journal / volume is another publication, not this one */
function differentWork(ref, rec, s) {
  if (s.authorScore === 1) return false;
  // a book or web page "matched" to a record by other authors is not that book or page
  if (greyRef(ref) && s.authorScore === 0) return true;
  const vol = v => (String(v || '').match(/\d+/) || [''])[0].replace(/^0+(?=\d)/, '');
  const off = [
    s.authorScore === 0,
    s.yearScore !== null && s.yearScore < 0.75,
    s.journalScore !== null && s.journalScore < 0.5,
    !!(vol(ref.volume) && vol(rec.volume) && vol(ref.volume) !== vol(rec.volume))
  ].filter(Boolean).length;
  // with no author list to compare, a looser title needs some other agreement (journal) to count as the same work
  if (s.tSim < 0.85 && s.authorScore === null && !(s.journalScore >= 0.8)) return true;
  return s.tSim < 0.85 ? off >= 1 : off >= (s.authorScore === null ? 2 : 3);
}

// ------------------------------------------------------------------ links

async function checkLink(url) {
  let r = await request(url, { method: 'HEAD', json: false, timeout: 10000, ttl: 86400, retries: 0 });
  if (!r.ok && [403, 405, 400, 501, 0].includes(r.status)) {
    r = await request(url, { method: 'GET', json: false, timeout: 12000, ttl: 86400, retries: 0 });
  }
  let status;
  if (r.ok || (r.status >= 300 && r.status < 400)) status = 'works';
  else if ([404, 410].includes(r.status) || /ENOTFOUND|getaddrinfo/i.test(r.error || '')) status = 'broken';
  else status = 'unchecked';
  const out = { url, status, httpStatus: r.status || null };
  if (status === 'broken') {
    const w = await request(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { timeout: 10000, ttl: 7 * 86400 });
    const snap = w.ok && w.data?.archived_snapshots?.closest;
    if (snap?.available) out.archived = snap.url;
  }
  return out;
}

// ------------------------------------------------------------------ verification of one reference

async function verifyReference(ref, opts = {}) {
  const checked = new Map(); // source -> outcome
  const mark = (name, outcome) => { if (!checked.has(name) || checked.get(name) !== 'found') checked.set(name, outcome); };
  const candidates = [];
  const issues = [];
  let idRecord = null;

  const take = (name, res) => {
    if (!res) return;
    if (res.error) { mark(name, 'error'); return; }
    const recs = res.record ? [res.record] : res.records || [];
    mark(name, recs.length ? 'found' : 'not-found');
    for (const rec of recs) candidates.push({ rec, ...scoreCandidate(ref, rec) });
  };

  // ---- 1. Identifier checks (DOI / PMID / arXiv)
  if (ref.doi) {
    const [handle, cr] = await Promise.all([S.doiHandle(ref.doi), S.crossrefDoi(ref.doi)]);
    mark('DOI Foundation (Handle)', handle.error ? 'error' : handle.exists ? 'found' : 'not-found');
    if (cr.record) { take('Crossref', cr); idRecord = cr.record; }
    else {
      mark('Crossref', cr.error ? 'error' : 'not-found');
      const dc = await S.dataciteDoi(ref.doi);
      if (dc.record) { take('DataCite', dc); idRecord = dc.record; }
      else {
        mark('DataCite', dc.error ? 'error' : 'not-found');
        if (handle.exists) {
          const oa = await S.openalexDoi(ref.doi);
          if (oa.record) { take('OpenAlex', oa); idRecord = oa.record; }
        }
      }
    }
    if (handle.exists === false && !idRecord) {
      issues.push({ code: 'doi-unregistered', severity: 'high', message: 'DOI does not exist in the global DOI registry', cited: ref.doiAsWritten });
    }
  }
  if (ref.pmid) {
    const pm = await S.pubmedPmid(ref.pmid);
    take('PubMed', pm);
    if (pm.notFound) issues.push({ code: 'pmid-invalid', severity: 'high', message: 'PMID does not exist in PubMed', cited: ref.pmid });
    if (pm.record && !idRecord) idRecord = pm.record;
  }
  if (ref.arxiv) {
    const ax = await S.arxivId(ref.arxiv);
    take('arXiv', ax);
    if (ax.notFound) issues.push({ code: 'arxiv-invalid', severity: 'high', message: 'arXiv identifier does not exist', cited: ref.arxiv });
    if (ax.record && !idRecord) idRecord = ax.record;
  }

  let idMatches = false;
  if (idRecord) {
    const s = scoreCandidate(ref, idRecord);
    idMatches = s.tSim >= 0.6 || (s.tSim >= 0.4 && s.authorScore === 1 && s.yearScore >= 0.75) || !ref.title || rawTitleCover(ref, idRecord) >= 0.9;
    if (!idMatches) {
      issues.push({ code: 'doi-mismatch', severity: 'high', message: 'The identifier belongs to a different publication', cited: ref.title, registered: idRecord.title });
    }
  }

  // Rank by score; near-ties go to the record agreeing on year/journal (avoids late duplicate deposits)
  const rank = c => c.score + (c.yearScore ?? 0.5) * 4 + (c.journalScore ?? 0.5) * 3 + (c.rec.doi ? 1 : 0);
  const best = () => candidates.filter(c => !(idRecord && c.rec === idRecord && !idMatches)).sort((a, b) => rank(b) - rank(a))[0];

  // ---- 2. Bibliographic search cascade (stop early once a confident match agreeing on the year exists)
  const confident = () => {
    if (idRecord && idMatches) return true;
    const b = best();
    return !!b && b.score >= 85 && (b.yearScore === null || b.yearScore >= 0.75);
  };
  if (!confident()) {
    const wave1 = [
      ['Crossref', S.crossrefSearch(ref)],
      ['OpenAlex', S.openalexSearch(ref)],
      ['Europe PMC', S.europepmcSearch(ref)],
      ['PubMed', S.pubmedSearch(ref)]
    ];
    if (ref.looksLikeBook) wave1.push(['Open Library', S.openLibrarySearch(ref)]);
    const r1 = await Promise.all(wave1.map(([, p]) => p));
    wave1.forEach(([n], i) => take(n, r1[i]));
  }
  if (!confident()) {
    const wave2 = [
      ['Semantic Scholar', S.s2Search(ref)],
      ['DataCite', S.dataciteSearch(ref)],
      ['DBLP', S.dblpSearch(ref)],
      ['arXiv', S.arxivSearch(ref)],
      ['ERIC', S.ericSearch(ref)],
      ['CORE', S.coreSearch(ref)]
    ];
    if (ref.looksLikeBook || !ref.journal) {
      if (!checked.has('Open Library')) wave2.push(['Open Library', S.openLibrarySearch(ref)]);
      wave2.push(['Google Books', S.googleBooksSearch(ref)]);
    }
    const r2 = await Promise.all(wave2.map(([, p]) => p));
    wave2.forEach(([n], i) => take(n, r2[i]));
  }

  let top = best();
  let record = idRecord && idMatches ? idRecord : top && top.score >= 50 ? top.rec : null;
  let confidence = idRecord && idMatches ? Math.max(scoreCandidate(ref, idRecord).score, 80) : top?.score || 0;

  // ---- 3. Enrich: authoritative Crossref record (retractions) + OpenAlex (topics, author IDs, abstract)
  let openalexRecord = record?.source === 'OpenAlex' ? record : null;
  if (record?.doi) {
    const [cr, oa] = await Promise.all([
      record.source === 'Crossref' ? null : S.crossrefDoi(record.doi),
      openalexRecord ? null : S.openalexDoi(record.doi)
    ]);
    if (cr?.record && scoreCandidate(ref, cr.record).tSim >= 0.6) {
      mark('Crossref', 'found');
      if (record.source !== 'Crossref') record = { ...cr.record, authors: cr.record.authors.length ? cr.record.authors : record.authors };
    }
    if (oa?.record) { openalexRecord = oa.record; mark('OpenAlex', 'found'); }
  }
  if (record && openalexRecord) {
    record.retracted = record.retracted || openalexRecord.retracted;
    if (openalexRecord.retracted && !record.notices.some(n => n.type === 'Retraction')) record.notices.push(...openalexRecord.notices);
  }

  // checked after enrichment, which can swap in the fuller Crossref record (with authors)
  let closest = null;
  if (record && !(idRecord && idMatches) && differentWork(ref, record, scoreCandidate(ref, record))) { closest = record; record = null; openalexRecord = null; }

  const matchedIn = [];
  for (const c of candidates) {
    if (c.score >= 75 && !matchedIn.includes(c.rec.source)) matchedIn.push(c.rec.source);
  }
  if (record && !matchedIn.includes(record.source)) matchedIn.unshift(record.source);

  // ---- 4. Compare
  if (record) {
    const s = scoreCandidate(ref, record);
    const found = compare(ref, record, s);
    // Crossref sometimes carries the deposit year: another database matching the same work with the cited year settles it
    // (and the odd wrong volume): another database matching the same work with the cited value settles it
    const same = c => c.rec !== record && c.tSim >= 0.9 && c.authorScore !== 0 && (!c.rec.doi || !record.doi || c.rec.doi.toLowerCase() === record.doi.toLowerCase());
    const num = v => (String(v || '').match(/\d+/) || [''])[0].replace(/^0+(?=\d)/, '');
    const yearOk = ref.year && candidates.some(c => same(c) && c.rec.year === ref.year);
    const volOk = ref.volume && candidates.some(c => same(c) && num(c.rec.volume) === num(ref.volume));
    issues.push(...found.filter(i => !(yearOk && i.code === 'year') && !(volOk && i.code === 'volume')));
    if (!ref.doi && record.doi) issues.push({ code: 'doi-missing', severity: 'info', message: 'DOI missing — verified DOI found', registered: record.doi });
    if (ref.doi && record.doi && ref.doi !== record.doi && !idMatches) {
      issues.push({ code: 'doi-wrong', severity: 'high', message: 'DOI is wrong — the correct DOI was found', cited: ref.doiAsWritten, registered: record.doi });
    }
  }

  // Offline (desktop): nothing reachable and nothing cached — verify later instead of calling it fabricated
  const outcomes = [...checked.values()];
  const offline = !record && !isOnline() && outcomes.length > 0 && outcomes.every(o => o === 'error');
  return { ref, record, closest, openalexRecord, confidence, issues, matchedIn: record ? matchedIn : [], checked: Object.fromEntries(checked), topScore: top?.score || 0, offline };
}

// ------------------------------------------------------------------ "well-indexed journal but article absent" check

async function journalProfile(name) {
  const j = await resolveJournal({ name });
  if (!j?.source) return null;
  const s = j.source;
  return { id: s.id, name: s.display_name, works: s.works_count, first: s.first_publication_year, last: s.last_publication_year, issn: s.issn || [] };
}

// ------------------------------------------------------------------ classification

/** Every word of the resolved journal name is in the cited one, allowing abbreviations ("Int J Pharm" = International Journal of Pharmaceutics) */
function sameJournalName(cited, resolved) {
  const stop = new Set(['and', 'of', 'the', 'for', 'in', 'on', '&']);
  const tok = x => normalizeJournal(x).split(' ').filter(t => t && !stop.has(t));
  const c = tok(cited);
  return journalSimilarity(cited, resolved) >= 0.95 && tok(resolved).every(t => c.some(w => t.startsWith(w)));
}

// Pakistani and other regional journals that are often missing from Crossref/PubMed/OpenAlex: "Not indexed", not fake
const REGIONAL = /\b(pak(istan)?|karachi|lahore|peshawar|islamabad|rawalpindi|sindh|punjab|khyber|balochistan|quetta|multan|faisalabad|hyderabad|ayub|jpma|jcpsp|liaquat|dow|isra|baqai|ziauddin|aga khan|nishtar|gomal|hamdard|bangladesh|nepal|sri lanka|iraq|iran|sudan|nigeria)\b/i;

async function classify(v, retraction) {
  const { ref, record, issues } = v;
  const high = issues.filter(i => i.severity === 'high');
  const medium = issues.filter(i => i.severity === 'medium');
  const errors = Object.values(v.checked).filter(o => o === 'error').length;
  const anyFound = !!record;
  let status, reason;

  if (!anyFound && v.offline) {
    status = retraction && /retraction/i.test(retraction.nature) ? 'retracted' : 'pending';
    reason = status === 'retracted' ? 'This work has been retracted (Retraction Watch, offline dataset)' : 'No internet connection — this reference will be verified automatically when the connection returns';
  } else if (anyFound && (record.retracted || (retraction && /retraction/i.test(retraction.nature)))) {
    status = 'retracted';
    reason = 'This work has been retracted';
  } else if (!anyFound && v.closest && (ref.looksLikeWeb || (ref.looksLikeBook && !ref.doi) || (!ref.journal && !ref.doi && !ref.pmid)) && scoreCandidate(ref, v.closest).tSim < 0.7) {
    // a web page, report or book whose "closest record" is some unrelated paper: say what it is, not the stray match
    status = 'unverified';
    reason = 'Book, report or web source — not found in scholarly databases; check manually';
  } else if (!anyFound && v.closest) {
    status = 'unverified';
    const about = [v.closest.authors?.[0]?.family, v.closest.year, v.closest.journal].filter(Boolean).join(', ');
    reason = `Not found — the closest record${about ? ` (${about})` : ''} is a different publication; check manually`;
  } else if (!anyFound) {
    const grey = ref.looksLikeWeb || (ref.looksLikeBook && !ref.doi) || (!ref.journal && !ref.doi && !ref.pmid);
    const idFailed = issues.some(i => ['doi-unregistered', 'pmid-invalid', 'arxiv-invalid'].includes(i.code));
    let journal = null;
    if (!grey && ref.journal) journal = await journalProfile(ref.journal);
    if (journal && !sameJournalName(ref.journal, journal.name)) journal = null; // resolved to a different journal
    // the resolved journal must really be the cited one ("World Journal of Pharmaceutical Sciences" is not "... and Life Sciences")
    const wellIndexed = journal && journal.works > 300 && (!ref.year || (ref.year >= (journal.first || 0) && ref.year <= (journal.last || 9999)));
    const regional = REGIONAL.test(ref.journal || '') && !idFailed;
    if (idFailed) { status = 'suspicious'; reason = 'Identifier does not exist and no matching record was found'; }
    else if (regional) { status = 'unverified'; reason = `Not indexed — ${ref.journal} is a regional journal that the scholarly databases do not cover fully; check manually (not a sign of fabrication)`; v.notIndexed = true; }
    else if (wellIndexed) {
      status = 'suspicious';
      reason = `Not found in any database although ${journal.name} is well indexed (${journal.works.toLocaleString()} articles)`;
      // the major publishers register every article with Crossref, so a missing article there weighs more
      const major = await require('../datasets').publisherJournal({ issns: journal.issn || [], name: journal.name }).catch(() => null);
      if (major && (!ref.year || ref.year >= 2002)) reason += `; it is a ${major.publisher} journal, and ${major.publisher} registers every article with Crossref`;
    }
    else if (errors >= 4) { status = 'unverified'; reason = 'Verification could not be completed (several databases did not respond)'; }
    else if (grey) { status = 'unverified'; reason = 'Book, report or web source — not found in scholarly databases; check manually'; }
    else {
      status = 'suspicious';
      reason = 'No match in any of the 13 scholarly databases';
      // Is the journal itself indexed? An article in a journal that no index covers cannot be checked online: unverified, not fabricated
      if (ref.journal && !journal) {
        const D = require('../datasets');
        const [nlm, cr] = await Promise.all([D.nlmJournal({ name: ref.journal }).catch(() => null), D.crossrefJournal({ name: ref.journal }).catch(() => null)]);
        if (nlm || cr) reason += `; the journal exists (${nlm ? 'NLM Catalog' : 'Crossref title list'}) but this article was not found in it`;
        else {
          status = 'unverified';
          reason = `Not indexed — ${ref.journal} is not covered by OpenAlex, the NLM Catalog or Crossref, so the article cannot be checked online; check manually`;
          v.notIndexed = true;
        }
      }
    }
    v.journalProfile = journal;
  } else if (high.some(i => ['doi-unregistered', 'pmid-invalid', 'arxiv-invalid'].includes(i.code)) && v.confidence < 85) {
    status = 'suspicious';
    reason = 'The identifier does not exist and no record matches this reference with confidence - it may be fabricated';
  } else if (high.length || medium.length) {
    status = v.confidence >= 65 ? 'miscited' : 'unverified';
    reason = (high[0] || medium[0]).message;
  } else if (v.confidence >= 75) {
    status = 'verified';
    const minor = issues.filter(i => ['year', 'last-page', 'issue', 'author-order'].includes(i.code)).map(i => i.message.toLowerCase());
    reason = minor.length ? `A record was found and the title and authors match; note: ${minor.join('; ')}` : 'A record was found and the title, authors and year match';
  } else if (REGIONAL.test(ref.journal || '')) {
    status = 'unverified';
    reason = `Not indexed — ${ref.journal} is a regional journal that the scholarly databases do not cover fully; the closest record is not a certain match, check manually (not a sign of fabrication)`;
    v.notIndexed = true;
  } else {
    status = 'unverified';
    reason = 'A similar record exists but the match is not certain — review manually';
  }
  return { status, reason };
}

// ------------------------------------------------------------------ public API

/**
 * Verify a list of parsed references.
 * opts: { concurrency, onProgress(done, total), checkLinks, style }
 */
async function checkReferences(refs, opts = {}) {
  const { concurrency = 4, onProgress, checkLinks = true } = opts;
  const style = opts.style || detectStyle(refs);
  const results = new Array(refs.length);
  let next = 0, done = 0;

  async function worker() {
    while (next < refs.length) {
      const i = next++;
      try {
        results[i] = await verifyReference(refs[i]);
      } catch (e) {
        results[i] = { ref: refs[i], record: null, confidence: 0, issues: [], matchedIn: [], checked: {}, error: e.message };
      }
      done++;
      if (onProgress) onProgress(done, refs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, refs.length) }, worker));

  // Retraction Watch (local dataset), batched
  const rw = await retractionsFor(results.map(r => r.record?.doi || r.ref.doi));

  const year = new Date().getFullYear();
  const out = [];
  for (const v of results) {
    const retraction = rw.get((v.record?.doi || v.ref.doi || '').toLowerCase()) || null;
    const { status, reason } = await classify(v, retraction);
    const rec = v.record;
    const notices = [...(rec?.notices || [])];
    if (retraction) {
      notices.unshift({ type: retraction.nature || 'Retraction', label: `Retraction Watch: ${retraction.nature}`, doi: retraction.retraction_doi, date: retraction.retraction_date, reason: retraction.reason });
    }
    out.push({
      index: v.ref.index,
      raw: v.ref.raw,
      parsed: { authors: v.ref.authors, title: v.ref.title, journal: v.ref.journal, year: v.ref.year, volume: v.ref.volume, issue: v.ref.issue, pages: v.ref.pages, doi: v.ref.doi, pmid: v.ref.pmid, arxiv: v.ref.arxiv, urls: v.ref.urls, yearSuffix: v.ref.yearSuffix },
      status,
      statusLabel: v.notIndexed ? 'Not indexed' : STATUS[status].label,
      tone: STATUS[status].tone,
      reason,
      confidence: v.record ? Math.min(100, v.confidence) : Math.min(v.topScore || 0, 40),
      issues: v.issues,
      notices,
      retraction: retraction ? { nature: retraction.nature, date: retraction.retraction_date, doi: retraction.retraction_doi, reason: retraction.reason } : (rec?.retracted ? { nature: 'Retraction', source: rec.source } : null),
      record: rec ? {
        source: rec.source, title: rec.title, authors: rec.authors.slice(0, 100), year: rec.year, journal: rec.journal, journalAbbrev: rec.journalAbbrev,
        issn: rec.issn, volume: rec.volume, issue: rec.issue, pages: rec.pages, doi: rec.doi, url: rec.url, type: rec.type, publisher: rec.publisher
      } : null,
      openalex: v.openalexRecord ? {
        id: v.openalexRecord.openalexId, journalId: v.openalexRecord.journalId, topics: v.openalexRecord.topics, keywords: v.openalexRecord.keywords,
        abstract: (v.openalexRecord.abstract || '').slice(0, 1500), authors: v.openalexRecord.authors.slice(0, 100).map(a => ({ name: `${a.given} ${a.family}`.trim(), id: a.openalexId, orcid: a.orcid, institutions: a.institutions }))
      } : null,
      closest: v.closest ? { source: v.closest.source, title: v.closest.title, year: v.closest.year, journal: v.closest.journal, doi: v.closest.doi, url: v.closest.url } : null,
      matchedIn: v.matchedIn,
      checked: v.checked,
      suggestion: !rec || status === 'retracted' ? null
        : status !== 'verified' || (!v.ref.doi && rec.doi) ? formatReference({ ...rec, title: rec.title.replace(/^(retracted|withdrawn)\s*:\s*/i, '') }, style) : null,
      age: (rec?.year || v.ref.year) ? year - (rec?.year || v.ref.year) : null,
      journalProfile: v.journalProfile || null,
      notIndexed: !!v.notIndexed,
      links: [],
      error: v.error
    });
  }

  // Link validation (web addresses + DOI links)
  if (checkLinks) {
    const jobs = [];
    for (const r of out) {
      for (const u of (r.parsed.urls || []).filter(u => !/doi\.org\//i.test(u)).slice(0, 3)) jobs.push([r, u]);
      if (r.parsed.doi) {
        const ok = r.checked['DOI Foundation (Handle)'];
        r.links.push({ url: `https://doi.org/${r.parsed.doi}`, status: ok === 'found' ? 'works' : ok === 'not-found' ? 'broken' : 'unchecked', kind: 'doi' });
      }
    }
    let k = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (k < jobs.length) {
        const [r, u] = jobs[k++];
        r.links.push({ ...(await checkLink(u)), kind: 'web' });
      }
    }));
  }

  return { results: out, summary: summarize(out), style };
}

function summarize(results) {
  const count = s => results.filter(r => r.status === s).length;
  const ages = { last5: 0, y6to10: 0, y11to20: 0, older: 0, unknown: 0 };
  for (const r of results) {
    if (r.age === null) ages.unknown++;
    else if (r.age <= 5) ages.last5++;
    else if (r.age <= 10) ages.y6to10++;
    else if (r.age <= 20) ages.y11to20++;
    else ages.older++;
  }
  const links = { works: 0, broken: 0, unchecked: 0 };
  for (const r of results) for (const l of r.links) links[l.status]++;
  const problemCounts = {};
  for (const r of results) for (const i of r.issues) if (i.severity !== 'info') problemCounts[i.message] = (problemCounts[i.message] || 0) + 1;
  return {
    total: results.length,
    verified: count('verified'),
    miscited: count('miscited'),
    retracted: count('retracted'),
    unverified: count('unverified'),
    suspicious: count('suspicious'),
    pending: count('pending'),
    withDoi: results.filter(r => r.parsed.doi).length,
    doiSuggested: results.filter(r => !r.parsed.doi && r.record?.doi).length,
    concerns: results.filter(r => r.notices.some(n => /concern/i.test(n.type))).length,
    notIndexed: results.filter(r => r.notIndexed).length,
    ages,
    olderThan10: results.filter(r => r.age !== null && r.age > 10).map(r => r.index),
    links,
    problemCounts,
    databases: S.DATABASES
  };
}

module.exports = { checkReferences, verifyReference, scoreCandidate, summarize, STATUS };
