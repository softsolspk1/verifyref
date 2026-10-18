// editor/pattern.js - Citation pattern: self-citation, author/journal concentration, citation stacking, off-topic sources
const { nameMatch, relevanceScores, normalizeJournal, cleanIssn, splitName, surnameKey, initials } = require('../text');
const cfg = require('../config');

function refAuthors(r) {
  if (r.openalex?.authors?.length) return r.openalex.authors.map(a => ({ ...splitName(a.name), orcid: a.orcid, id: a.id }));
  if (r.record?.authors?.length) return r.record.authors;
  return r.parsed?.authors || [];
}

function refDoc(r) {
  return [
    r.record?.title || r.parsed?.title || r.raw,
    (r.openalex?.topics || []).join('. '),
    (r.openalex?.keywords || []).join('. '),
    (r.openalex?.abstract || '').slice(0, 800)
  ].join('. ');
}

function isManuscriptAuthor(a, msAuthors) {
  for (const m of msAuthors) {
    if (m.orcid && a.orcid && m.orcid.replace(/\D/g, '') === a.orcid.replace(/\D/g, '')) return { author: m, by: 'ORCID' };
    const nm = nameMatch(a, m);
    if (nm === 'exact') return { author: m, by: 'name' };
    if (nm === 'likely' && (!a.given || !m.given)) return { author: m, by: 'surname' };
  }
  return null;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * meta: { title, abstract, keywords[], authors:[{name, given, family, orcid}] }
 * results: Reference Check results
 * opts: { homeJournal: { name, issn[] } }
 */
function analyzeCitationPattern(meta, results, opts = {}) {
  const home = opts.homeJournal || cfg.HOME_JOURNAL;
  const msAuthors = (meta.authors || []).map(a => (a.family ? a : { ...splitName(a.name || a), orcid: a.orcid })).filter(a => a.family);
  const total = results.length;
  const query = [meta.title, meta.title, meta.abstract, (meta.keywords || []).join(' '), (meta.keywords || []).join(' ')].filter(Boolean).join('. ');
  const basis = meta.abstract ? 'title, abstract and keywords' : meta.title ? 'title only (add the abstract for better accuracy)' : null;

  // ---- relevance
  const scores = basis ? relevanceScores(query, results.map(refDoc)) : results.map(() => null);
  const med = median(scores.filter(s => s !== null));
  const lowCut = Math.max(0.03, med * 0.25);
  const relevance = results.map((r, i) => ({
    index: r.index,
    score: scores[i] === null ? null : Math.round(scores[i] * 1000) / 1000,
    level: scores[i] === null ? 'unknown' : scores[i] < lowCut ? 'weak' : scores[i] < med * 0.6 ? 'moderate' : 'strong'
  }));
  const relOf = idx => relevance.find(x => x.index === idx);

  // ---- self-citation
  const selfRefs = [];
  const byMsAuthor = new Map();
  for (const r of results) {
    const hits = [];
    for (const a of refAuthors(r)) {
      const m = isManuscriptAuthor(a, msAuthors);
      if (m && !hits.some(h => h.author === m.author)) hits.push(m);
    }
    if (hits.length) {
      selfRefs.push({ index: r.index, title: r.record?.title || r.parsed?.title, year: r.record?.year || r.parsed?.year, authors: hits.map(h => `${h.author.given} ${h.author.family}`.trim()), matchedBy: hits.map(h => h.by), relevance: relOf(r.index) });
      for (const h of hits) {
        const k = `${h.author.given} ${h.author.family}`.trim();
        byMsAuthor.set(k, (byMsAuthor.get(k) || 0) + 1);
      }
    }
  }
  const selfRate = total ? selfRefs.length / total : 0;
  const irrelevantSelf = selfRefs.filter(s => s.relevance?.level === 'weak');

  // ---- author concentration (excluding manuscript authors)
  const authorCounts = new Map();
  for (const r of results) {
    const seen = new Set();
    for (const a of refAuthors(r).slice(0, 25)) {
      if (!a.family || a.corporate) continue;
      if (isManuscriptAuthor(a, msAuthors)) continue;
      const k = a.id || `${surnameKey(a.family)}|${initials(a.given)[0] || ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!authorCounts.has(k)) authorCounts.set(k, { name: `${a.given || ''} ${a.family}`.trim(), orcid: a.orcid || null, refs: [] });
      authorCounts.get(k).refs.push(r.index);
    }
  }
  const authorThreshold = Math.max(4, Math.ceil(total * 0.1));
  const authorConcentration = [...authorCounts.values()]
    .filter(a => a.refs.length >= authorThreshold)
    .sort((a, b) => b.refs.length - a.refs.length)
    .map(a => ({ ...a, share: a.refs.length / total, weakRelevance: a.refs.filter(i => relOf(i)?.level === 'weak').length }));

  // ---- journal concentration + citation stacking toward the home journal
  const journalCounts = new Map();
  const homeIssns = (home.issn || []).map(cleanIssn);
  const homeNorm = normalizeJournal(home.name);
  const thisYear = new Date().getFullYear();
  const homeRefs = [];
  for (const r of results) {
    const name = r.record?.journal || r.parsed?.journal;
    if (!name) continue;
    const issns = (r.record?.issn || []).map(cleanIssn);
    const isHome = issns.some(i => homeIssns.includes(i)) || normalizeJournal(name) === homeNorm || /pak(istan)?\.?\s*j(ournal)?\.?\s*(of\s*)?pharm(aceutical)?\.?\s*sci/i.test(name);
    const k = isHome ? 'HOME' : issns[0] || normalizeJournal(name);
    if (!journalCounts.has(k)) journalCounts.set(k, { journal: isHome ? home.name : name, isHome, refs: [] });
    journalCounts.get(k).refs.push(r.index);
    if (isHome) homeRefs.push({ index: r.index, year: r.record?.year || r.parsed?.year });
  }
  const journalThreshold = Math.max(4, Math.ceil(total * 0.15));
  const journalConcentration = [...journalCounts.values()]
    .filter(j => j.refs.length >= journalThreshold)
    .sort((a, b) => b.refs.length - a.refs.length)
    .map(j => ({ ...j, share: j.refs.length / total, weakRelevance: j.refs.filter(i => relOf(i)?.level === 'weak').length }));
  // Impact-factor window: citations to the previous two years count toward the JIF
  const homeRecent = homeRefs.filter(h => h.year && h.year >= thisYear - 2);

  const offTopic = relevance.filter(x => x.level === 'weak').map(x => {
    const r = results.find(y => y.index === x.index);
    return { index: x.index, title: r.record?.title || r.parsed?.title || r.raw.slice(0, 160), score: x.score, isSelf: selfRefs.some(s => s.index === x.index) };
  });

  // ---- flags with guidance
  const flags = [];
  if (selfRate >= 0.25) flags.push({ severity: 'high', code: 'self-citation', message: `High self-citation: ${selfRefs.length} of ${total} references (${Math.round(selfRate * 100)}%) include a manuscript author`, guidance: 'Typical self-citation is below 10–15%. It can be legitimate when the authors lead a narrow field or the paper extends their own series of studies — check that each self-citation is actually used in the argument.' });
  else if (selfRate >= 0.15) flags.push({ severity: 'medium', code: 'self-citation', message: `Elevated self-citation: ${selfRefs.length} of ${total} references (${Math.round(selfRate * 100)}%)`, guidance: 'Look at the self-citations that are only weakly related to the topic; those are the ones to question.' });
  if (irrelevantSelf.length) flags.push({ severity: irrelevantSelf.length >= 3 ? 'high' : 'medium', code: 'irrelevant-self-citation', message: `${irrelevantSelf.length} self-citation(s) appear weakly related to the manuscript topic`, guidance: 'Ask the authors to justify or remove self-citations that do not support a specific statement in the text.' });
  for (const a of authorConcentration) flags.push({ severity: a.share >= 0.2 ? 'high' : 'medium', code: 'author-concentration', message: `${a.refs.length} references (${Math.round(a.share * 100)}%) are by ${a.name}`, guidance: 'Legitimate when this author is the main contributor to a niche topic. If the author is a reviewer or editor of this manuscript, treat it as possible coercive citation.' });
  for (const j of journalConcentration) flags.push({ severity: j.share >= 0.3 ? 'high' : 'medium', code: j.isHome ? 'citation-stacking' : 'journal-concentration', message: `${j.refs.length} references (${Math.round(j.share * 100)}%) are from ${j.journal}`, guidance: j.isHome ? 'Citations to the journal the paper is submitted to inflate its impact factor; legitimate only when those papers are directly relevant.' : 'Legitimate for specialist journals in a narrow field; otherwise it can indicate a citation cartel or stacking.' });
  if (homeRecent.length >= 3 && !journalConcentration.some(j => j.isHome)) flags.push({ severity: 'medium', code: 'jif-window', message: `${homeRecent.length} citations to ${home.name} from the last two years (the impact-factor window)`, guidance: 'Check whether these recent home-journal citations are relevant to the manuscript.' });
  if (offTopic.length >= Math.max(3, total * 0.2) && basis) flags.push({ severity: 'medium', code: 'off-topic', message: `${offTopic.length} references look unrelated to the manuscript topic`, guidance: 'Weak relevance is estimated from titles and topics only; a methods or statistics reference can be legitimately “off-topic”.' });

  return {
    basis,
    manuscriptAuthors: msAuthors.map(a => `${a.given} ${a.family}`.trim()),
    summary: {
      total,
      selfCitations: selfRefs.length,
      selfCitationRate: Math.round(selfRate * 1000) / 10,
      irrelevantSelfCitations: irrelevantSelf.length,
      authorConcentration: authorConcentration.length,
      journalConcentration: journalConcentration.length,
      homeJournalCitations: homeRefs.length,
      homeJournalRecent: homeRecent.length,
      offTopic: offTopic.length,
      flags: flags.length
    },
    selfCitation: { rate: selfRate, refs: selfRefs, byAuthor: Object.fromEntries(byMsAuthor) },
    authorConcentration,
    journalConcentration,
    homeJournal: { name: home.name, refs: homeRefs, recent: homeRecent },
    offTopic,
    relevance,
    flags
  };
}

module.exports = { analyzeCitationPattern };
