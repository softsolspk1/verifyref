// scripts/corpus-load.js - fills the PJPS text repository (src/corpus.js, texts on Cloudflare R2) in bulk with open-access
// full texts from Europe PMC, so the similarity report compares new manuscripts with them directly. Resumes where it
// stopped (cursor kept in the meta table).
//   node scripts/corpus-load.js [--query "<Europe PMC query>"] [--limit 2000]
// Default query: open-access pharmacy / pharmacology / medicinal-plant research papers, newest first.
require('../src/config');
const db = require('../src/db');
const corpus = require('../src/corpus');
const { getJson, getText } = require('../src/http');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const QUERY = arg('query', '(pharmaceutic* OR pharmacolog* OR "medicinal plant*" OR "drug delivery" OR formulation) AND OPEN_ACCESS:y AND HAS_FT:y AND PUB_TYPE:"research-article"');
const LIMIT = parseInt(arg('limit', '2000'), 10);
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';
const stripXml = x => String(x || '').replace(/<ref-list[\s\S]*?<\/ref-list>/g, ' ').replace(/<(table-wrap|fig)\b[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ');

(async () => {
  await db.init();
  const cursorKey = `corpus_cursor:${require('crypto').createHash('md5').update(QUERY).digest('hex').slice(0, 10)}`;
  let cursor = (await db.getMeta(cursorKey)) || '*';
  let added = 0, seen = 0;
  console.log(`Query: ${QUERY}\nStarting at cursor ${cursor}; limit ${LIMIT}`);
  while (added < LIMIT && cursor) {
    const r = await getJson(`${EPMC}/search?format=json&resultType=lite&pageSize=100&sort=P_PDATE_D%20desc&cursorMark=${encodeURIComponent(cursor)}&query=${encodeURIComponent(QUERY)}`, { ttl: 0, timeout: 60000, retries: 2 });
    if (!r.ok) { console.error('Europe PMC search failed:', r.error || r.status); break; }
    const list = r.data.resultList?.result || [];
    if (!list.length) break;
    for (const x of list) {
      if (added >= LIMIT) break;
      seen++;
      if (!x.pmcid) continue;
      const known = await db.one('SELECT id FROM corpus_docs WHERE source_key = $1', [`pmc:${x.pmcid}`]);
      if (known) continue;
      const ft = await getText(`${EPMC}/${x.pmcid}/fullTextXML`, { ttl: 0, timeout: 60000, retries: 1 });
      const text = ft.ok ? stripXml((String(ft.text).match(/<body>[\s\S]*<\/body>/) || [String(ft.text)])[0]) : '';
      if (text.length < 3000) continue;
      const id = await corpus.addDoc({ kind: 'publication', sourceKey: `pmc:${x.pmcid}`, title: x.title, text,
        meta: { journal: x.journalTitle || null, year: x.pubYear || null, doi: x.doi || null, url: `https://europepmc.org/article/PMC/${x.pmcid}`, via: 'Europe PMC', scope: 'full text' } }).catch(e => { console.error(x.pmcid, e.message); return null; });
      if (id) added++;
      if (added % 25 === 0 && id) console.log(`  ${added} added (${seen} seen)`);
    }
    cursor = r.data.nextCursorMark && r.data.nextCursorMark !== cursor ? r.data.nextCursorMark : null;
    await db.setMeta(cursorKey, cursor || '');
  }
  console.log(`Done: ${added} papers added. Repository: ${JSON.stringify(await corpus.stats())}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
