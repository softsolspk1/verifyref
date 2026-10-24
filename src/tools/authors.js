// tools/authors.js - Find by Author: identify the right person (institution, ORCID, output) and list their verified
// publications from OpenAlex, formatted in any citation style for copying into a bibliography.
const S = require('../sources');
const ST = require('../styles');
const { relevanceScores } = require('../text');

const enc = encodeURIComponent;
const short = id => String(id || '').replace('https://openalex.org/', '');

function candidate(a) {
  const inst = (a.last_known_institutions || [])[0] || a.last_known_institution || null;
  return {
    id: short(a.id), name: a.display_name, orcid: a.orcid ? a.orcid.replace(/^https?:\/\/orcid\.org\//, '') : null,
    institution: inst?.display_name || null, country: inst?.country_code || null,
    works: a.works_count, citations: a.cited_by_count, hIndex: a.summary_stats?.h_index ?? null,
    topics: (a.topics || a.x_concepts || []).slice(0, 4).map(t => t.display_name),
    alternatives: (a.display_name_alternatives || []).slice(0, 4)
  };
}

/** input: { name, topic } */
async function searchAuthors(input) {
  const name = String(input.name || '').trim();
  if (name.length < 3) throw new Error('Enter the author’s name.');
  const orcid = (name.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/) || [])[0];
  const r = orcid
    ? await S.openalex(`authors?filter=orcid:${orcid}`)
    : await S.openalex(`authors?search=${enc(name)}&per-page=15`);
  if (!r.ok) throw new Error(`OpenAlex search failed (${r.status || r.error})`);
  let list = (r.data.results || []).map(candidate);
  if (input.topic && list.length > 1) {
    const rel = relevanceScores(input.topic, list.map(c => c.topics.join(' ')));
    list = list.map((c, i) => ({ ...c, topicMatch: Math.round(rel[i] * 100) })).sort((a, b) => b.topicMatch - a.topicMatch || b.works - a.works);
  }
  return { kind: 'authors', name, topic: input.topic || '', candidates: list };
}

/** input: { id, style, topic, limit } */
async function authorWorks(input) {
  const id = short(input.id);
  if (!/^A\d+$/.test(id)) throw new Error('Choose an author first.');
  const style = ST.styleKey(input.style || 'apa7');
  const [a, w] = await Promise.all([
    S.openalex(`authors/${id}`),
    S.openalex(`works?filter=author.id:${id}&sort=publication_date:desc&per-page=200&select=id,doi,title,publication_year,authorships,primary_location,biblio,type,is_retracted,cited_by_count,ids,topics`)
  ]);
  if (!w.ok) throw new Error(`OpenAlex request failed (${w.status || w.error})`);
  const seen = new Set();
  let works = (w.data.results || []).map(x => ({ ...S.fromOpenAlex(x), citedBy: x.cited_by_count, id: short(x.id), typeLabel: x.type }))
    .filter(x => x.title && !seen.has((x.doi || x.title).toLowerCase()) && seen.add((x.doi || x.title).toLowerCase()));
  if (input.topic) {
    const rel = relevanceScores(input.topic, works.map(x => `${x.title} ${(x.topics || []).join(' ')}`));
    works.forEach((x, i) => { x.topicMatch = Math.round(rel[i] * 100); });
  }
  return {
    kind: 'authors', author: a.ok ? candidate(a.data) : { id }, style, total: w.data.meta?.count || works.length,
    works: works.map(x => {
      const e = ST.entry(x, style);
      return { id: x.id, title: x.title, year: x.year, journal: x.journal, doi: x.doi, type: x.typeLabel, citedBy: x.citedBy, retracted: x.retracted, topicMatch: x.topicMatch ?? null, text: ST.toText(e), html: ST.toHtml(e), record: { authors: x.authors.slice(0, 30).map(({ given, family }) => ({ given, family })), title: x.title, year: x.year, journal: x.journal, journalAbbrev: x.journalAbbrev, volume: x.volume, issue: x.issue, pages: x.pages, doi: x.doi, type: x.type } };
    })
  };
}

module.exports = { searchAuthors, authorWorks };
