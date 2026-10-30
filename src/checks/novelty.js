// checks/novelty.js - Novelty & citation outlook of a manuscript, a data model on the OpenAlex scholarly graph
// (no generative AI: every number comes from published works and can be traced in the report).
//
// Novelty (0-100) combines
//   - distance: 1 - cosine similarity (TF-IDF over title + abstract + keywords) to the closest published works
//   - crowding: how many close works (similarity >= 0.30) appeared in the last five years
//   - rarity:   how often the manuscript's key concepts were combined before (OpenAlex title/abstract counts)
// (crowding counts works with similarity >= 0.35; similarity = max(TF-IDF cosine, 0.85 x share of the manuscript's 20
// most specific terms that a work contains)) and reports the momentum of the main research topic (works per year).
//
// Citation outlook: the citation curves of the most similar published works (OpenAlex counts by year), aligned on their
// publication year and weighted by similarity, give the median and interquartile range of citations 1, 3 and 5 years
// after publication; they are scaled by the target journal's 2-year mean citedness relative to the similar works' journals.
const S = require('../sources');
const D = require('../datasets');
const { invertedIndexToText, titleSimilarity } = require('../text');

const THIS_YEAR = new Date().getFullYear();
const STOP = new Set(('a an the and or of in on at to for from by with without as is are was were be been this that these those it its their which who '
  + 'than then into over under between among within during after before about also such may can could should would will not no but if so more most less '
  + 'all any each both other some same we our us they them using used use based study studies present results result showed shown show new novel effect '
  + 'effects evaluation development developed analysis role vitro vivo patients method methods approach').split(' '));
// title words too general to stand for a research concept
const GENERIC = new Set(('assisted mediated loaded induced enhanced improved improvement potential application applications system systems delivery drug '
  + 'drugs therapy treatment activity activities properties property characterization characterisation formulation formulations preparation prepared '
  + 'comparative comparison physical chemical technique techniques review current recent advance advances strategy strategies model models design '
  + 'designed optimization optimisation assessment investigation performance efficacy clinical experimental').split(' '));
const tokens = t => String(t || '').toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/[\s-]+/)
  .filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)).map(w => w.replace(/(ies)$/, 'y').replace(/(?<=[a-z]{4})s$/, ''));

/** Words plus adjacent word pairs ("transdermal_delivery"): phrases separate related work from shared vocabulary */
const terms = t => { const w = tokens(t); return [...w, ...w.slice(1).map((x, i) => `${w[i]}_${x}`)]; };

function tfidf(docs) {
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const n = docs.length;
  return docs.map(d => {
    const tf = new Map();
    for (const w of d) tf.set(w, (tf.get(w) || 0) + 1);
    const v = new Map();
    let norm = 0;
    for (const [w, c] of tf) { const x = (1 + Math.log(c)) * Math.log(1 + n / (df.get(w) || 1)); v.set(w, x); norm += x * x; }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  });
}
const cosine = (a, b) => { let s = 0; for (const [w, x] of a) { const y = b.get(w); if (y) s += x * y; } return s; };

const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
};
/** weighted quantile: values [{v, w}] */
function wq(values, q) {
  const s = values.filter(x => Number.isFinite(x.v)).sort((a, b) => a.v - b.v);
  const total = s.reduce((a, x) => a + x.w, 0);
  if (!total) return null;
  let acc = 0;
  for (const x of s) { acc += x.w; if (acc >= q * total) return x.v; }
  return s[s.length - 1].v;
}

/** Key concepts: the manuscript's keywords, else its most specific title words (by how rare they are in the related works) */
function keyConcepts(meta, corpusDocs) {
  const kw = (meta.keywords || []).map(k => String(k).trim()).filter(k => k && k.length < 60).slice(0, 6);
  if (kw.length >= 2) return kw.slice(0, 4);
  const df = new Map();
  for (const d of corpusDocs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const words = [...new Set(tokens(meta.title))].filter(w => w.length >= 4 && !GENERIC.has(w));
  return words.sort((a, b) => (df.get(a) || 0) - (df.get(b) || 0)).slice(0, 4);
}

async function countWorks(filter) {
  const r = await S.openalex(`works?filter=${encodeURIComponent(filter)}&per-page=1&select=id`, { ttl: 30 * 86400, timeout: 20000, retries: 1 });
  return r.ok ? r.data?.meta?.count ?? null : null;
}

/**
 * input: { meta: { title, abstract, keywords }, journal: { name, issn } }  ->  novelty report
 */
async function checkNovelty({ meta = {}, journal = {} }, update = () => {}) {
  const title = String(meta.title || '').trim();
  const abstract = String(meta.abstract || '').trim();
  if (title.length < 15) return { kind: 'novelty', error: 'The manuscript title was not found, so novelty could not be assessed.' };
  // several short searches find the related literature far better than one long query: the title's specific words, and
  // every pair of key concepts (keywords, else the rarest title words)
  const titleTerms = [...new Set(tokens(title))];
  const seeds = keyConcepts(meta, [titleTerms]).map(c => String(c).replace(/[,|:"]/g, ' ').trim()).filter(Boolean);
  const queries = [titleTerms.slice(0, 7).join(' ')];
  for (let i = 0; i < seeds.length; i++) for (let j = i + 1; j < seeds.length; j++) queries.push(`${seeds[i]} ${seeds[j]}`);
  // the abstract's most specific words (not in the title) as one more search
  const absTerms = [...new Set(tokens(abstract))].filter(w => w.length >= 6 && !GENERIC.has(w) && !titleTerms.includes(w)).slice(0, 6);
  if (absTerms.length >= 3) queries.push([...titleTerms.slice(0, 3), ...absTerms.slice(0, 4)].join(' '));
  const query = queries.join(' | ');
  update('Finding the closest published works (OpenAlex)');
  const select = 'id,doi,title,publication_year,cited_by_count,counts_by_year,abstract_inverted_index,primary_location,primary_topic';
  const pages = await Promise.all(queries.slice(0, 8).map(q => S.openalex(`works?search=${encodeURIComponent(q)}&filter=type:article|review,has_abstract:true&per-page=30&select=${select}`, { ttl: 7 * 86400, timeout: 30000, retries: 1 })));
  // Europe PMC (biomedical and pharmacy literature, the abstracts of all PubMed papers) for the first searches
  const epmc = await Promise.all(queries.slice(0, 4).map(q => require('../http').getJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=core&pageSize=25&query=${encodeURIComponent(q)}`, { ttl: 7 * 86400, timeout: 30000, retries: 1 }).catch(() => ({ ok: false }))));
  if (pages.every(r => !r.ok) && epmc.every(r => !r.ok)) return { kind: 'novelty', error: 'OpenAlex and Europe PMC did not answer; novelty could not be assessed now (run the check again later).' };
  const seen = new Set();
  const works = pages.flatMap(r => (r.ok ? r.data.results || [] : [])).filter(w => w.title && !seen.has(w.id) && seen.add(w.id)).map(w => ({
    id: w.id.replace('https://openalex.org/', ''), doi: w.doi ? w.doi.replace('https://doi.org/', '') : null, title: w.title, year: w.publication_year,
    citedBy: w.cited_by_count || 0, counts: w.counts_by_year || [], abstract: invertedIndexToText(w.abstract_inverted_index || {}),
    journal: w.primary_location?.source?.display_name || null, sourceId: w.primary_location?.source?.id?.replace('https://openalex.org/', '') || null,
    topic: w.primary_topic ? { id: w.primary_topic.id.replace('https://openalex.org/', ''), name: w.primary_topic.display_name } : null
  }));
  const haveDoi = new Set(works.map(w => (w.doi || '').toLowerCase()).filter(Boolean));
  const haveTitle = new Set(works.map(w => String(w.title).toLowerCase().replace(/[^a-z0-9]/g, '')));
  for (const r of epmc) {
    for (const x of (r.ok ? r.data?.resultList?.result || [] : [])) {
      const t = String(x.title || '').replace(/<[^>]+>/g, '').replace(/\.$/, '');
      const key = t.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!t || !x.abstractText || (x.doi && haveDoi.has(x.doi.toLowerCase())) || haveTitle.has(key)) continue;
      haveTitle.add(key);
      if (x.doi) haveDoi.add(x.doi.toLowerCase());
      works.push({ id: x.pmcid || x.pmid || x.id, doi: x.doi || null, title: t, year: parseInt(x.pubYear, 10) || null, citedBy: x.citedByCount || 0, counts: [],
        abstract: String(x.abstractText).replace(/<[^>]+>/g, ' '), journal: x.journalInfo?.journal?.title || x.journalTitle || null, sourceId: null, topic: null, via: 'Europe PMC',
        url: x.doi ? `https://doi.org/${x.doi}` : x.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${x.pmid}/` : null });
    }
  }
  // the manuscript itself (already published, or a preprint) is not prior work: same DOI, or a near-identical title
  const ownDoi = String(meta.doi || '').toLowerCase();
  const prior = works.filter(w => !(ownDoi && w.doi && w.doi.toLowerCase() === ownDoi) && titleSimilarity(w.title, title) < 0.95);
  const selfMatches = works.filter(w => !prior.includes(w)).map(w => ({ title: w.title, year: w.year, journal: w.journal, doi: w.doi }));
  if (prior.length < 5) return { kind: 'novelty', error: 'Too few related works were found in OpenAlex to assess novelty.' };

  const mineDoc = terms(`${title} ${title} ${abstract} ${(meta.keywords || []).join(' ')}`);
  const docs = [mineDoc, ...prior.map(w => terms(`${w.title} ${w.title} ${w.abstract}`))];
  const vec = tfidf(docs);
  // the manuscript's 20 most specific terms: how much of them a work covers (cosine alone is diluted by long abstracts)
  const key = [...vec[0].entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const keyWeight = key.reduce((a, [, x]) => a + x, 0) || 1;
  // titles (+ keywords) compared on their own: a long abstract spreads its weight over many terms and compresses the
  // full-text cosine, while the title states what the work is about
  const tvec = tfidf([terms(`${title} ${(meta.keywords || []).join(' ')}`), ...prior.map(w => terms(w.title))]);
  prior.forEach((w, i) => {
    const have = new Set(docs[i + 1]);
    const coverage = key.reduce((a, [t, x]) => a + (have.has(t) ? x : 0), 0) / keyWeight;
    w.similarity = Math.round(Math.max(cosine(vec[0], vec[i + 1]), coverage * 0.85, cosine(tvec[0], tvec[i + 1]) * 0.9) * 1000) / 1000;
    // the manuscript's specific terms this work shares (shown so the editor sees why it is close)
    w.shared = key.filter(([t]) => have.has(t)).map(([t]) => t.replace(/_/g, ' ')).filter((t, j, a) => !a.some((u, k) => k !== j && u !== t && u.includes(t))).slice(0, 6);
  });
  prior.sort((a, b) => b.similarity - a.similarity);
  const top = prior.slice(0, 10);
  const maxSim = top[0].similarity;
  const meanTop5 = top.slice(0, 5).reduce((a, w) => a + w.similarity, 0) / Math.min(5, top.length);
  const close = prior.filter(w => w.similarity >= 0.35);
  const closeRecent = close.filter(w => w.year >= THIS_YEAR - 5).length;

  // concept combination rarity
  update('Measuring how often the key concepts were combined before');
  const concepts = keyConcepts(meta, docs.slice(1));
  const esc = c => String(c).replace(/[,|:]/g, ' ').trim();
  // pairs of concepts: how often each pair was studied together, relative to the rarer concept alone
  const pairs = [];
  for (let i = 0; i < concepts.length; i++) for (let j = i + 1; j < concepts.length; j++) pairs.push([concepts[i], concepts[j]]);
  const [allCount, single, pairCounts] = await Promise.all([
    countWorks(`title_and_abstract.search:${concepts.map(esc).join(' ')}`),
    Promise.all(concepts.map(c => countWorks(`title_and_abstract.search:${esc(c)}`))),
    Promise.all(pairs.map(([a, b]) => countWorks(`title_and_abstract.search:${esc(a)} ${esc(b)}`)))
  ]);
  const pairRarity = pairs.map(([a, b], k) => {
    const n = pairCounts[k], m = Math.min(single[concepts.indexOf(a)], single[concepts.indexOf(b)]);
    return Number.isFinite(n) && Number.isFinite(m) && m > 0 ? 1 - Math.min(1, Math.log10(1 + n) / Math.log10(1 + m)) : null;
  }).filter(x => x !== null);
  const rarity = pairRarity.length ? pairRarity.reduce((a, b) => a + b, 0) / pairRarity.length : null;

  // topic momentum
  update('Topic momentum and citation curves of similar works');
  const topicCount = new Map();
  for (const w of top) if (w.topic) topicCount.set(w.topic.id, { ...w.topic, n: (topicCount.get(w.topic.id)?.n || 0) + 1 });
  const mainTopic = [...topicCount.values()].sort((a, b) => b.n - a.n)[0] || null;
  let momentum = null;
  if (mainTopic) {
    const r = await S.openalex(`works?filter=topics.id:${mainTopic.id},publication_year:${THIS_YEAR - 7}-${THIS_YEAR - 1}&group_by=publication_year&per-page=200`, { ttl: 30 * 86400, timeout: 25000, retries: 1 });
    const byYear = (r.ok ? r.data.group_by || [] : []).map(g => ({ year: +g.key, works: g.count })).sort((a, b) => a.year - b.year);
    if (byYear.length >= 6) {
      const early = byYear.slice(0, 3).reduce((a, x) => a + x.works, 0), late = byYear.slice(-3).reduce((a, x) => a + x.works, 0);
      const perYear = early ? Math.pow(late / early, 1 / 3) - 1 : null;
      momentum = { topic: mainTopic.name, worksByYear: byYear, growthPerYear: perYear === null ? null : Math.round(perYear * 1000) / 10, trend: perYear === null ? 'unknown' : perYear > 0.08 ? 'growing fast' : perYear > 0.02 ? 'growing' : perYear > -0.02 ? 'stable' : 'declining' };
    }
  }

  // novelty score
  const distance = Math.max(0, Math.min(1, (0.8 - maxSim) / 0.6));         // similarity 0.2 -> 1, 0.5 -> 0.5, 0.8+ -> 0
  const crowd = Math.min(1, closeRecent / 10);
  const parts = [[distance, 0.5], [1 - crowd, 0.25], ...(rarity === null ? [] : [[rarity, 0.25]])];
  const score = Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / parts.reduce((a, [, w]) => a + w, 0) * 100);
  const band = score >= 70 ? 'high' : score >= 45 ? 'moderate' : 'low';

  // citation outlook from the similar works' curves
  // the 40 most similar works old enough to have a citation curve (prior is sorted by similarity)
  const neighbours = prior.filter(w => w.year && w.year <= THIS_YEAR - 2 && w.year >= THIS_YEAR - 12 && w.similarity > 0.03).slice(0, 40);
  const curve = w => {
    const by = new Map(w.counts.map(c => [c.year, c.cited_by_count]));
    // OpenAlex keeps the last ten years: a curve is only usable while year 1 after publication is inside that window
    const out = [];
    let acc = 0;
    for (let k = 0; k <= 5; k++) {
      const y = w.year + k;
      if (y > THIS_YEAR - 1) break;
      if (!by.has(y) && y < THIS_YEAR - 10) return null;
      acc += by.get(y) || 0;
      out.push(acc);
    }
    return out;
  };
  let journalFactor = 1, journalNote = null;
  const target = journal.issn || journal.name ? await D.openalexJournal({ issns: journal.issn ? [journal.issn] : [], name: journal.name || '' }).catch(() => null) : null;
  const neighbourJournals = [...new Set(neighbours.map(w => w.sourceId).filter(Boolean))].slice(0, 25);
  if (target?.summary_stats?.['2yr_mean_citedness'] && neighbourJournals.length) {
    const r = await S.openalex(`sources?filter=openalex:${neighbourJournals.join('|')}&per-page=50&select=id,summary_stats`, { ttl: 30 * 86400, timeout: 20000, retries: 1 });
    const cs = (r.ok ? r.data.results || [] : []).map(s => s.summary_stats?.['2yr_mean_citedness']).filter(x => x > 0);
    const med = quantile(cs, 0.5);
    if (med) {
      journalFactor = Math.max(0.2, Math.min(3, target.summary_stats['2yr_mean_citedness'] / med));
      journalNote = `${target.display_name}: 2-year mean citedness ${target.summary_stats['2yr_mean_citedness'].toFixed(2)} vs ${med.toFixed(2)} for the journals of the similar works (factor ${journalFactor.toFixed(2)})`;
    }
  }
  const curves = neighbours.map(w => ({ w, c: curve(w) })).filter(x => x.c && x.c.length >= 2);
  const at = k => curves.filter(x => x.c.length > k).map(x => ({ v: x.c[k] * journalFactor, w: Math.max(0.05, x.w.similarity) }));
  const horizon = [1, 3, 5].map(k => {
    const v = at(k);
    const r1 = x => (x < 10 ? Math.round(x * 10) / 10 : Math.round(x));
    return v.length >= 4 ? { years: k, median: r1(wq(v, 0.5)), low: r1(wq(v, 0.25)), high: r1(wq(v, 0.75)), basis: v.length } : { years: k, median: null, basis: v.length };
  });
  const five = horizon.find(h => h.years === 5) || {};
  const outlook = five.median === null || five.median === undefined ? 'insufficient data'
    : five.median >= 40 ? 'high' : five.median >= 15 ? 'moderate' : 'low';

  const level = band === 'low' ? 'warn' : 'ok';
  const c0 = top[0];
  const confidence = prior.length >= 60 && abstract.length >= 600 ? 'high' : prior.length >= 25 && abstract.length >= 200 ? 'moderate' : 'low';
  const statement = [
    band === 'high' ? 'The manuscript addresses a question that the published literature has covered little.' : band === 'moderate' ? 'The manuscript builds on an established line of work but differs from the closest published studies.' : 'The manuscript is close to work that is already published.',
    c0 ? `The closest published work is "${c0.title}" (${[c0.journal, c0.year].filter(Boolean).join(', ')}), with a similarity of ${Math.round(c0.similarity * 100)}%${c0.shared?.length ? `; it shares the key terms ${c0.shared.slice(0, 4).join(', ')}` : ''}.` : '',
    `${closeRecent} closely related work(s) appeared in the last five years${momentum ? `, in a research topic that is ${momentum.trend}` : ''}.`,
    rarity !== null ? `The key concepts of the manuscript have been studied together ${rarity >= 0.6 ? 'rarely' : rarity >= 0.3 ? 'occasionally' : 'often'}.` : ''
  ].filter(Boolean).join(' ');
  const guidance = band === 'low'
    ? ['Ask the authors to state clearly what is new compared with the closest published works listed in this report.', 'Check that the closest works are cited and discussed in the introduction.', 'Consider whether the contribution (new population, method, formulation or setting) justifies publication.']
    : band === 'moderate'
      ? ['Check that the introduction explains how the study differs from the closest published works.', 'Ask reviewers to confirm that the claimed novelty holds against the works listed here.']
      : ['Ask reviewers to confirm the novelty claim: a high score can also mean the topic is unusual for the indexed literature.', 'Check that the methods are described well enough for an unfamiliar topic to be assessed.'];
  const limitations = [
    'Novelty is measured on titles, abstracts and keywords; full texts and unpublished work are not compared.',
    `${prior.length} related works were compared (OpenAlex and Europe PMC); works missing from both databases cannot be found.`,
    'The score is a screening aid for the editor, not a judgement of scientific quality; reviewers decide on novelty.',
    ...(abstract.length < 200 ? ['The abstract was short or missing, so the assessment rests mostly on the title.'] : [])
  ];
  return {
    kind: 'novelty',
    version: 2,
    summary: { score, band, level, maxSimilarity: maxSim, closeWorks: close.length, closeRecent, outlook, fiveYearMedian: five.median ?? null, confidence },
    statement, guidance, limitations, selfMatches,
    weights: { distance: 50, uncrowded: 25, rarity: rarity === null ? 0 : 25 },
    components: { distance: Math.round(distance * 100), crowding: Math.round(crowd * 100), rarity: rarity === null ? null : Math.round(rarity * 100), meanTop5: Math.round(meanTop5 * 1000) / 1000 },
    concepts: { terms: concepts, together: allCount, individually: single, pairs: pairs.map(([a, b], k) => ({ a, b, works: pairCounts[k] })) },
    closest: top.map(w => ({ title: w.title, year: w.year, journal: w.journal, doi: w.doi, similarity: w.similarity, citedBy: w.citedBy, shared: w.shared || [], via: w.via || 'OpenAlex', url: w.url || (w.doi ? `https://doi.org/${w.doi}` : `https://openalex.org/${w.id}`) })),
    momentum,
    forecast: { horizon, journalFactor: Math.round(journalFactor * 100) / 100, journalNote, basis: curves.length, method: 'Cumulative citations of the most similar published works (OpenAlex counts by year), aligned on their publication year, similarity-weighted median and interquartile range; scaled by the target journal\'s citedness. A forecast, not a guarantee: citations also depend on visibility, open access and later work.' },
    checked: { works: prior.length, database: 'OpenAlex (about 250 million works) and Europe PMC (biomedical literature)', query },
    method: 'Novelty = 50% distance from the closest published work (TF-IDF cosine over words and two-word phrases of title, abstract and keywords), 25% how uncrowded the field was in the last five years, 25% how rarely the key concepts were studied together. Related works come from OpenAlex and Europe PMC; no generative AI - every number can be traced to the works listed.'
  };
}

module.exports = { checkNovelty, tfidf, cosine, tokens };
