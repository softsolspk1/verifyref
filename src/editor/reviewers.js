// editor/reviewers.js - Reviewer Finder: candidates who recently published on the manuscript's topic, with COI flags
const S = require('../sources');
const { nameMatch, splitName, normalize, tokens, relevanceScores } = require('../text');

const enc = encodeURIComponent;
const short = id => (id || '').replace('https://openalex.org/', '');

/** Pick distinctive search terms from the abstract (frequency × rarity heuristic) */
function keyTerms(text, n = 8) {
  const counts = new Map();
  for (const t of tokens(text)) {
    if (t.length < 5 || /^\d+$/.test(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] * b[0].length - a[1] * a[0].length).slice(0, n).map(([t]) => t);
}

async function searchWorks(query, fromYear, perPage = 100) {
  const select = 'id,title,publication_year,authorships,doi,cited_by_count,primary_location,relevance_score,is_retracted';
  const r = await S.openalex(`works?search=${enc(query.slice(0, 400))}&filter=from_publication_date:${fromYear}-01-01,type:article|review&per-page=${perPage}&select=${select}`);
  if (!r.ok) throw new Error(`OpenAlex search failed (${r.status || r.error})${r.status === 429 ? ' — daily limit reached; add an OPENALEX_API_KEY' : ''}`);
  return r.data.results || [];
}

function institutionMatchesAffiliation(instName, affiliations) {
  const n = normalize(instName);
  if (!n || n.length < 6) return false;
  return affiliations.some(a => {
    const na = normalize(a);
    return na.includes(n) || (n.split(' ').length >= 2 && n.split(' ').filter(w => w.length > 3).every(w => na.includes(w)));
  });
}

/**
 * input: { title, abstract, keywords[], authors:[{name}], affiliations:[], exclude:[names], yearsBack=5, limit=25 }
 */
async function findReviewers(input, { onProgress } = {}) {
  const thisYear = new Date().getFullYear();
  const fromYear = thisYear - (input.yearsBack || 5);
  const msAuthors = (input.authors || []).map(a => (typeof a === 'string' ? { name: a, ...splitName(a) } : a.family ? a : { ...a, ...splitName(a.name) })).filter(a => a.family);
  const affiliations = input.affiliations || [];
  const exclude = (input.exclude || []).map(splitName).filter(a => a.family);
  const progress = (step, pct) => onProgress && onProgress(step, pct);

  // ---- 1. Find recent topical works (two complementary queries)
  progress('Searching recent publications on the topic', 5);
  const q1 = [input.title, ...(input.keywords || [])].filter(Boolean).join(' ');
  const q2 = keyTerms(`${input.title} ${input.abstract || ''} ${(input.keywords || []).join(' ')}`).join(' ');
  const [w1, w2] = await Promise.all([searchWorks(q1, fromYear), q2 && q2 !== q1 ? searchWorks(q2, fromYear, 50) : []]);
  const works = new Map();
  for (const w of [...w1, ...w2]) if (!works.has(w.id)) works.set(w.id, w);
  const workList = [...works.values()];
  if (!workList.length) return { candidates: [], works: 0, message: 'No recent publications found for this topic. Try adding keywords.' };

  // Topic relevance of each work to the manuscript
  const query = `${input.title} ${input.title} ${input.abstract || ''} ${(input.keywords || []).join(' ')}`;
  const rel = relevanceScores(query, workList.map(w => w.title || ''));
  workList.forEach((w, i) => { w._rel = rel[i]; });

  // ---- 2. Aggregate authors
  progress('Ranking authors', 25);
  const authors = new Map();
  for (const w of workList) {
    const n = w.authorships?.length || 0;
    if (n > 30) continue; // consortium papers say little about individual expertise
    w.authorships.forEach((a, pos) => {
      const id = short(a.author?.id);
      if (!id || !a.author.display_name) return;
      const role = pos === 0 ? 'first' : pos === n - 1 ? 'last' : a.is_corresponding ? 'corresponding' : 'co';
      const weight = (w._rel + 0.05) * (role === 'co' ? 0.6 : 1) * (1 + Math.min(w.cited_by_count || 0, 200) / 400);
      if (!authors.has(id)) authors.set(id, { id, name: a.author.display_name, orcid: a.author.orcid ? a.author.orcid.replace('https://orcid.org/', '') : null, weight: 0, works: [] });
      const e = authors.get(id);
      e.weight += weight;
      e.works.push({ title: w.title, year: w.publication_year, doi: w.doi ? w.doi.replace('https://doi.org/', '') : null, journal: w.primary_location?.source?.display_name || '', role, citedBy: w.cited_by_count, rel: w._rel });
    });
  }

  // Drop the manuscript's own authors and explicitly excluded people
  const isMs = name => msAuthors.some(m => nameMatch(name, m) === 'exact');
  const isExcluded = name => exclude.some(x => nameMatch(name, x));
  let ranked = [...authors.values()]
    .filter(a => !isMs(a.name) && !isExcluded(a.name))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.max(40, (input.limit || 25) + 15));

  // ---- 3. Author profiles
  progress('Loading author profiles (ORCID, institution, h-index)', 40);
  const profiles = new Map();
  for (let i = 0; i < ranked.length; i += 50) {
    const ids = ranked.slice(i, i + 50).map(a => a.id).join('|');
    const r = await S.openalex(`authors?filter=id:${ids}&per-page=50&select=id,display_name,orcid,works_count,cited_by_count,summary_stats,last_known_institutions,counts_by_year,affiliations`);
    if (r.ok) for (const p of r.data.results || []) profiles.set(short(p.id), p);
  }

  // ---- 4. Conflict-of-interest screen: co-authorship and shared institution
  const candidates = [];
  let done = 0;
  let k = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (k < ranked.length) {
      const a = ranked[k++];
      const p = profiles.get(a.id) || {};
      const coi = [];
      // Recent works of the candidate — co-authors, retractions, workload
      const r = await S.openalex(`works?filter=author.id:${a.id},from_publication_date:${fromYear}-01-01&per-page=200&select=id,title,publication_year,authorships,is_retracted,doi`);
      const recent = r.ok ? r.data.results || [] : [];
      const coauthored = new Map();
      for (const w of recent) {
        for (const au of w.authorships || []) {
          if (short(au.author?.id) === a.id) continue;
          const m = msAuthors.find(ms => nameMatch(au.author?.display_name || '', ms) === 'exact');
          if (m) {
            const key = `${m.given} ${m.family}`.trim();
            if (!coauthored.has(key)) coauthored.set(key, []);
            coauthored.get(key).push({ title: w.title, year: w.publication_year });
          }
        }
      }
      for (const [ms, ws] of coauthored) coi.push({ type: 'co-authorship', severity: 'high', message: `Co-authored ${ws.length} paper(s) with ${ms} since ${fromYear}`, evidence: ws.slice(0, 3) });

      const insts = (p.last_known_institutions || []).map(i => ({ id: short(i.id), name: i.display_name, country: i.country_code }));
      for (const inst of insts) {
        if (institutionMatchesAffiliation(inst.name, affiliations)) {
          coi.push({ type: 'institution', severity: 'high', message: `Same institution as an author: ${inst.name}` });
        }
      }
      const retractions = recent.filter(w => w.is_retracted).map(w => ({ title: w.title, year: w.publication_year, doi: w.doi }));
      const yearCounts = Object.fromEntries((p.counts_by_year || []).map(c => [c.year, c.works_count]));

      candidates.push({
        id: a.id,
        name: p.display_name || a.name,
        orcid: (p.orcid || '').replace('https://orcid.org/', '') || a.orcid || null,
        institution: insts[0]?.name || null,
        institutions: insts,
        country: insts[0]?.country || null,
        hIndex: p.summary_stats?.h_index ?? null,
        i10: p.summary_stats?.i10_index ?? null,
        worksCount: p.works_count ?? null,
        citedBy: p.cited_by_count ?? null,
        relevantWorks: a.works.sort((x, y) => y.rel - x.rel || y.year - x.year).slice(0, 4),
        relevantCount: a.works.length,
        lastRelevantYear: Math.max(...a.works.map(w => w.year || 0)),
        workloadThisYear: yearCounts[thisYear] || recent.filter(w => w.publication_year === thisYear).length,
        workloadLastYear: yearCounts[thisYear - 1] || 0,
        retractions,
        coi,
        hasCoi: coi.length > 0,
        score: Math.round(a.weight * 100) / 100,
        profileUrl: `https://openalex.org/${a.id}`
      });
      done++;
      progress('Screening for conflicts of interest', 45 + Math.round(done / ranked.length * 50));
    }
  }));

  // Rank: relevance weight, nudged by seniority; candidates with COI sink but stay visible (flagged)
  candidates.sort((x, y) => {
    if (x.hasCoi !== y.hasCoi) return x.hasCoi ? 1 : -1;
    const sx = x.score * (1 + Math.log10(1 + (x.hIndex || 0)) / 3);
    const sy = y.score * (1 + Math.log10(1 + (y.hIndex || 0)) / 3);
    return sy - sx;
  });

  return {
    query: { title: input.title, keywords: input.keywords || [], terms: q2, fromYear },
    works: workList.length,
    candidates: candidates.slice(0, input.limit || 25),
    excludedManuscriptAuthors: msAuthors.map(a => `${a.given} ${a.family}`.trim()),
    note: 'Candidates are derived from publication records (OpenAlex). Contact details are intentionally not provided — use the ORCID or institutional page.'
  };
}

module.exports = { findReviewers, keyTerms };
