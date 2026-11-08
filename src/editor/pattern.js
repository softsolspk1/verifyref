// editor/pattern.js - Citation pattern: self-citation, author/journal concentration, citation stacking, off-topic sources
const { nameMatch, relevanceScores, normalizeJournal, cleanIssn, splitName, surnameKey, initials, tokens } = require('../text');
const cfg = require('../config');

// surnames shared by very many authors: a reference author written with the surname alone ("Khan", "Wang") is not taken
// as a manuscript author by surname - a full or initialled name, or the ORCID, is needed
const COMMON_SURNAMES = new Set(('khan ali ahmad ahmed hussain hussein shah iqbal akhtar malik butt raza rehman rahman siddiqui qureshi ' +
  'hassan hasan mahmood mehmood mohammad muhammad abbas aslam bibi begum yousaf yousuf zaman haider anwar javed nawaz saeed sheikh ' +
  'wang li zhang liu chen yang zhao huang zhou wu xu sun ma zhu hu guo he lin luo gao zheng liang xie song tang han feng deng cao ' +
  'peng zeng xiao tian dong pan yuan cai jiang yu du ye cheng wei su lu ding ren shen yao lu jin kim lee park choi jung kang cho ' +
  'singh kumar sharma patel gupta das shah reddy rao nguyen tran le pham smith jones brown johnson williams miller davis wilson ' +
  'taylor anderson thomas garcia martinez rodriguez lopez gonzalez hernandez perez silva santos oliveira souza costa pereira').split(' '));

// "authors" that are words of a title or heading taken from the first page ("META-ANALYSIS", "Systematic Review")
const NOT_A_NAME = /\b(?:analysis|analyses|meta|review|study|studies|trial|effects?|efficacy|evidence|systematic|randomi[sz]ed|clinical|abstract|introduction|methods?|results?|keywords?|original|article|research|journal|department|university|correspondence)\b/i;

// a word of a reference title, cut to its first 6 letters so "osteoarthritis" / "osteoarthritic", "tablets" / "tableting" agree
const stem = t => (t.length > 6 ? t.slice(0, 6) : t);
const contentTerms = s => tokens(s).filter(t => t.length >= 3 && !/^\d+$/.test(t)).map(stem);

/** A matched record is trusted only when the reference was verified (or is the same work, miscited with a high match); otherwise the nearest neighbour may be a different paper */
const trusted = r => !!r.record && (['verified', 'retracted'].includes(r.status) || (r.status === 'miscited' && (r.confidence || 0) >= 85));

function refAuthors(r) {
  const written = r.parsed?.authors || [];
  if (!trusted(r)) return written;
  if (r.openalex?.authors?.length) return r.openalex.authors.map(a => ({ ...splitName(a.name), orcid: a.orcid, id: a.id }));
  if (r.record?.authors?.length) return r.record.authors;
  return written;
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
  const digits = o => String(o || '').replace(/[^\dX]/gi, '').toUpperCase();
  for (const m of msAuthors) {
    if (m.orcid && a.orcid) {
      if (digits(m.orcid) === digits(a.orcid)) return { author: m, by: 'ORCID' };
      continue; // two different ORCID iDs are two different people, whatever their names
    }
    const nm = nameMatch(a, m);
    if (nm === 'exact') return { author: m, by: 'name' };
    if (nm === 'likely' && (!a.given || !m.given) && !COMMON_SURNAMES.has(surnameKey(m.family || ''))) return { author: m, by: 'surname' };
  }
  return null;
}

/** Research groups: authors whose cited papers are (nearly) the same set are one group, flagged once */
function groupAuthors(list) {
  const groups = [];
  for (const a of list) {
    const set = new Set(a.refs);
    const g = groups.find(x => { const inter = x.refs.filter(i => set.has(i)).length; return inter / (x.refs.length + set.size - inter) >= 0.6; });
    if (g) g.members.push(a); else groups.push({ refs: a.refs, members: [a] });
  }
  return groups;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * meta: { title, abstract, keywords[], authors:[{name, given, family, orcid}] }
 * results: Reference Check results
 * opts: { homeJournal: { name, issn[] }, body: the manuscript text (relevance is then judged against the whole paper) }
 */
function analyzeCitationPattern(meta, results, opts = {}) {
  const home = opts.homeJournal || cfg.HOME_JOURNAL;
  const msAuthors = (meta.authors || []).map(a => (a.family ? a : { ...splitName(a.name || a), orcid: a.orcid }))
    .filter(a => a.family && !NOT_A_NAME.test(`${a.given || ''} ${a.family}`));
  const total = results.length;
  const query = [meta.title, meta.title, meta.abstract, (meta.keywords || []).join(' '), (meta.keywords || []).join(' ')].filter(Boolean).join('. ');
  const body = String(opts.body || '');
  const hasBody = body.split(/\s+/).length >= 300;
  const basis = hasBody ? 'the whole manuscript text' : meta.abstract ? 'title, abstract and keywords' : meta.title ? 'title only (add the abstract for better accuracy)' : null;

  // ---- relevance
  // 1. share of the reference title's words used anywhere in the manuscript (a methods source - "SwissADME", the ICH
  //    guideline - is named in the methods; a source on another subject shares few words with the whole paper)
  // 2. word-weighted similarity to the title, abstract and keywords. The weights come from the reference list itself, so
  //    the topic words that most references share weigh little: this alone called 54% of real PJPS manuscripts
  //    "off-topic" (8 Nov 2026), so it now decides only where the manuscript text is not available.
  // A title too short to judge ("Mol", "Gaussian 09", a figure caption taken for a reference) is not judged at all.
  const msTerms = new Set(contentTerms([meta.title, meta.abstract, (meta.keywords || []).join(' '), body].filter(Boolean).join(' ')));
  // the subject words: title, abstract and keywords (or the opening of the text, where they are). A long methods title
  // ("High-speed countercurrent chromatography isolation of active components from Evodia rutaecarpa") shares few of
  // its words with a clinical paper on Evodia rutaecarpa, but it shares the subject
  const topicText = [meta.title, meta.abstract, (meta.keywords || []).join(' ')].filter(Boolean).join(' ');
  const topicTerms = new Set(contentTerms(topicText.split(/\s+/).length >= 40 ? topicText : `${topicText} ${body.split(/\s+/).slice(0, 400).join(' ')}`));
  const scores = basis ? relevanceScores(query || body.slice(0, 20000), results.map(refDoc)) : results.map(() => null);
  const med = median(scores.filter(s => s !== null));
  const lowCut = Math.max(0.03, med * 0.25);
  const relevance = results.map((r, i) => {
    // the found record's title only when it is that paper (an unverified reference's nearest record is another paper)
    const title = String((trusted(r) && r.record?.title) || r.parsed?.title || '');
    const terms = [...new Set(contentTerms(title))];
    // a "title" that is a run of author names ("Papa E, Pierleoni A, Pignatelli M") or page furniture is a reference
    // the list splitter cut badly - not judged
    const words = title.split(/\s+/).filter(Boolean);
    const initialsShare = words.length ? words.filter(w => /^[A-Z]{1,3}[,.;]?$/.test(w)).length / words.length : 0;
    // ... or a book chapter's publisher details ("InLiposomes; Humana Press: New York, NY, USA, 2010; pp. 29-50")
    const judgeable = terms.length >= 3 && initialsShare < 0.25 && !/^\(?[A-H]\)\s|scale bar|for peer review|^\[?crossref\]?$/i.test(title)
      && !/\b(?:Press|Publishers?|Springer|Elsevier|Wiley)\b[^.]*[:;,]|\bEds?\.\s*[;:,]|\bpp\.\s*\d/.test(title);
    const coverage = terms.length ? terms.filter(t => msTerms.has(t)).length / terms.length : 0;
    const topicHits = terms.filter(t => topicTerms.has(t)).length;
    const level = scores[i] === null || !judgeable ? 'unknown'
      : hasBody ? (coverage < 0.25 && !topicHits ? 'weak' : coverage < 0.5 && topicHits < 2 ? 'moderate' : 'strong')
        : scores[i] < lowCut && coverage < 0.25 && !topicHits ? 'weak' : scores[i] < med * 0.6 && coverage < 0.5 ? 'moderate' : 'strong';
    return { index: r.index, score: scores[i] === null ? null : Math.round(scores[i] * 1000) / 1000, coverage: Math.round(coverage * 100) / 100, level };
  });
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
    const name = (trusted(r) && r.record?.journal) || r.parsed?.journal || r.record?.journal;
    if (!name) continue;
    const issns = (trusted(r) ? r.record?.issn || [] : []).map(cleanIssn);
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
  // co-authors of the same papers are one research group and one flag (a case report citing one trial group's 5 papers
  // used to get three flags, one per co-author)
  const authorGroups = groupAuthors(authorConcentration);
  for (const g of authorGroups) {
    const share = g.refs.length / total;
    const names = g.members.slice(0, 4).map(a => a.name);
    const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}${g.members.length > 4 ? ` (+${g.members.length - 4} co-authors)` : ''} - one research group` : names[0];
    flags.push({ severity: share >= 0.2 ? 'high' : 'medium', code: 'author-concentration', message: `${g.refs.length} references (${Math.round(share * 100)}%) are by ${who}`, guidance: 'Legitimate when this author or group is the main contributor to a niche topic. If one of them is a reviewer or editor of this manuscript, treat it as possible coercive citation.' });
  }
  for (const j of journalConcentration) flags.push({ severity: j.share >= 0.3 ? 'high' : 'medium', code: j.isHome ? 'citation-stacking' : 'journal-concentration', message: `${j.refs.length} references (${Math.round(j.share * 100)}%) are from ${j.journal}`, guidance: j.isHome ? 'Citations to the journal the paper is submitted to inflate its impact factor; legitimate only when those papers are directly relevant.' : 'Legitimate for specialist journals in a narrow field; otherwise it can indicate a citation cartel or stacking.' });
  if (homeRecent.length >= 3 && !journalConcentration.some(j => j.isHome)) flags.push({ severity: 'medium', code: 'jif-window', message: `${homeRecent.length} citations to ${home.name} from the last two years (the impact-factor window)`, guidance: 'Check whether these recent home-journal citations are relevant to the manuscript.' });
  // with the manuscript text: 2 or more (no real PJPS manuscript of 25 had more than 1; 3 sources on other subjects
  // added to them were flagged in 23 of 25, 5 in 25 of 25 - 8 Nov 2026). From the title / abstract alone: 20% as before
  const offTopicFlag = hasBody ? offTopic.length >= 2 : offTopic.length >= Math.max(3, total * 0.2);
  if (offTopicFlag && basis) flags.push({ severity: hasBody && offTopic.length >= Math.max(5, total * 0.15) ? 'high' : 'medium', code: 'off-topic', message: `${offTopic.length} references look unrelated to the manuscript topic: ${offTopic.slice(0, 6).map(o => `[${o.index}]`).join(', ')}${offTopic.length > 6 ? ' ...' : ''}`, guidance: hasBody ? 'Fewer than a quarter of the words of these reference titles occur anywhere in the manuscript. Ask the authors what each one supports; a source that supports no statement pads the reference list.' : 'Weak relevance is estimated from the title, abstract and keywords only (the manuscript text was not available); a methods or statistics reference can be legitimately “off-topic”.' });

  return {
    basis,
    manuscriptAuthors: msAuthors.map(a => `${a.given} ${a.family}`.trim()),
    summary: {
      total,
      selfCitations: selfRefs.length,
      selfCitationRate: Math.round(selfRate * 1000) / 10,
      irrelevantSelfCitations: irrelevantSelf.length,
      authorConcentration: authorConcentration.length,
      authorGroups: authorGroups.length,
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
