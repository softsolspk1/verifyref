// integrity/monitoring.js - Published article monitoring. Watches the journal's published articles (added by DOI or
// imported from Crossref by ISSN) for:
//   - retractions, expressions of concern, corrections and withdrawals (Crossref "updates" notices + Retraction Watch)
//   - references to papers that have since been retracted (archive rescreening of each article's reference list)
// New events notify the editor who added the article and every Super Admin. Runs from the daily cron (weekly per article)
// or on demand; the archive of saved screening reports is rescreened by alerts.retractionMonitor at the same time.
const db = require('../db');
const D = require('../datasets');
const { getJson } = require('../http');
const { cleanDoi } = require('../text');
const { notify, retractionMonitor } = require('../alerts');

const CROSSREF = 'https://api.crossref.org';
const STATUS_RANK = { ok: 0, 'cites-retracted': 1, corrected: 2, concern: 3, retracted: 4 };
const TYPE_STATUS = { retraction: 'retracted', withdrawal: 'retracted', removal: 'retracted', expression_of_concern: 'concern', correction: 'corrected', erratum: 'corrected', corrigendum: 'corrected', addendum: 'corrected' };

const norm = doi => (cleanDoi(doi) || '').toLowerCase();

async function crossrefWork(doi) {
  const r = await getJson(`${CROSSREF}/works/${encodeURIComponent(doi)}`, { ttl: 86400, timeout: 15000, retries: 1 });
  return r.ok ? r.data?.message || null : null;
}

const metaOf = w => ({
  title: (w.title || [])[0] || '', journal: (w['container-title'] || [])[0] || '', year: w.issued?.['date-parts']?.[0]?.[0] || null,
  authors: (w.author || []).map(a => `${a.given || ''} ${a.family || ''}`.trim()).filter(Boolean).slice(0, 30).join('; ')
});

async function addArticles(list, userId, { manuscriptCode = null } = {}) {
  const out = { added: 0, skipped: 0, invalid: [] };
  for (const raw of list.slice(0, 500)) {
    const doi = norm(raw);
    if (!doi) { out.invalid.push(String(raw).slice(0, 80)); continue; }
    const w = await crossrefWork(doi).catch(() => null);
    const m = w ? metaOf(w) : {};
    const row = await db.one(`INSERT INTO monitored_articles(doi, title, journal, year, authors, manuscript_code, added_by) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (doi) DO NOTHING RETURNING id`, [doi, m.title || null, m.journal || null, m.year || null, m.authors || null, manuscriptCode, userId]);
    row ? out.added++ : out.skipped++;
  }
  return out;
}

/** Import a journal's articles from Crossref by ISSN (newest first) */
async function importJournal(issn, userId, { fromYear = new Date().getFullYear() - 5, max = 1000 } = {}) {
  let cursor = '*', added = 0, seen = 0;
  while (seen < max) {
    const r = await getJson(`${CROSSREF}/journals/${encodeURIComponent(issn)}/works?filter=from-pub-date:${fromYear}-01-01,type:journal-article&rows=200&select=DOI,title,container-title,issued,author&cursor=${encodeURIComponent(cursor)}`, { ttl: 3600, timeout: 30000, retries: 1 });
    if (!r.ok) { if (!seen) throw new Error(`Crossref did not answer for ISSN ${issn} (${r.error || r.status}).`); break; }
    const items = r.data?.message?.items || [];
    if (!items.length) break;
    for (const w of items) {
      const m = metaOf(w);
      const row = await db.one(`INSERT INTO monitored_articles(doi, title, journal, year, authors, added_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (doi) DO NOTHING RETURNING id`,
        [norm(w.DOI), m.title || null, m.journal || null, m.year || null, m.authors || null, userId]);
      if (row) added++;
    }
    seen += items.length;
    cursor = r.data?.message?.['next-cursor'];
    if (!cursor || items.length < 200) break;
  }
  return { added, seen };
}

/** Check one article; returns the new events */
async function checkArticle(row) {
  const doi = row.doi;
  const events = [];
  // Crossref notices that update this DOI (retraction, correction, expression of concern…)
  const n = await getJson(`${CROSSREF}/works?filter=updates:${encodeURIComponent(doi)}&rows=20&select=DOI,title,update-to,issued`, { ttl: 86400, timeout: 15000, retries: 1 });
  if (n.ok) for (const it of n.data?.message?.items || []) for (const u of it['update-to'] || []) {
    if (norm(u.DOI) !== doi) continue;
    const date = (u.updated?.['date-parts']?.[0] || it.issued?.['date-parts']?.[0] || []).join('-');
    events.push({ source: 'Crossref', type: String(u.type || 'update').toLowerCase(), notice: norm(it.DOI), date, title: (it.title || [])[0] || '' });
  }
  // Retraction Watch
  const rw = (await D.retractionsFor([doi])).get(doi);
  if (rw) {
    const type = /retraction/i.test(rw.nature) ? 'retraction' : /concern/i.test(rw.nature) ? 'expression_of_concern' : /correction/i.test(rw.nature) ? 'correction' : String(rw.nature || 'notice').toLowerCase();
    events.push({ source: 'Retraction Watch', type, notice: rw.retraction_doi || null, date: rw.retraction_date || '', reason: rw.reason || '' });
  }
  // Rescreen the reference list against Retraction Watch
  const w = await crossrefWork(doi).catch(() => null);
  const refDois = [...new Set((w?.reference || []).map(r => norm(r.DOI)).filter(Boolean))];
  const hits = await D.retractionsFor(refDois);
  const citedRetracted = [...hits.values()].filter(x => /retraction/i.test(x.nature || '')).map(x => ({ doi: x.doi, title: x.title, date: x.retraction_date, reason: (x.reason || '').split(';').slice(0, 3).join('; ') }));
  if (w && !row.title) Object.assign(row, metaOf(w));

  const known = new Set((row.events || []).map(e => `${e.source}|${e.type}|${e.notice || e.date}`));
  const fresh = events.filter(e => !known.has(`${e.source}|${e.type}|${e.notice || e.date}`));
  const merged = [...(row.events || []), ...fresh.map(e => ({ ...e, found: new Date().toISOString() }))];
  let status = merged.reduce((s, e) => (STATUS_RANK[TYPE_STATUS[e.type]] || 0) > STATUS_RANK[s] ? TYPE_STATUS[e.type] : s, 'ok');
  if (status === 'ok' && citedRetracted.length) status = 'cites-retracted';
  const newCited = citedRetracted.filter(c => !(row.cited_retracted || []).some(x => x.doi === c.doi));
  await db.query(`UPDATE monitored_articles SET events = $2, cited_retracted = $3, status = $4, last_checked = now(), title = COALESCE(title, $5), journal = COALESCE(journal, $6), year = COALESCE(year, $7) WHERE id = $1`,
    [row.id, JSON.stringify(merged), JSON.stringify(citedRetracted), status, row.title || null, row.journal || null, row.year || null]);
  return { status, fresh, newCited };
}

async function recipients(row) {
  const admins = await db.all("SELECT id FROM users WHERE role = 'super_admin' AND status = 'active'");
  return [...new Set([row.added_by, ...admins.map(a => a.id)].filter(Boolean))];
}

/** Scheduled / on-demand run: articles not checked for 7 days (or all with force), in batches */
async function runMonitor({ force = false, limit = 150, ids = null } = {}) {
  const rows = ids
    ? await db.all('SELECT * FROM monitored_articles WHERE id = ANY($1::int[])', [ids])
    : await db.all(`SELECT * FROM monitored_articles ${force ? '' : "WHERE last_checked IS NULL OR last_checked < now() - interval '7 days'"} ORDER BY last_checked NULLS FIRST LIMIT $1`, [limit]);
  const out = { checked: 0, events: 0, citedRetracted: 0, errors: 0 };
  for (const row of rows) {
    try {
      const r = await checkArticle(row);
      out.checked++;
      if (r.fresh.length || r.newCited.length) {
        out.events += r.fresh.length; out.citedRetracted += r.newCited.length;
        const lines = [...r.fresh.map(e => `${e.type.replace(/_/g, ' ')} (${e.source}${e.date ? ', ' + e.date : ''})${e.reason ? ' — ' + e.reason : ''}`), ...r.newCited.map(c => `Cites a retracted paper: ${c.title || c.doi}`)];
        for (const uid of await recipients(row)) await notify(uid, { kind: 'retraction', title: `Published article: ${r.fresh.length ? r.fresh[0].type.replace(/_/g, ' ') : 'cites a retracted paper'} — ${row.title?.slice(0, 80) || row.doi}`, body: `${row.doi}\n${lines.join('\n')}`, link: '#/references/monitoring', data: { doi: row.doi, monitored: row.id } });
      }
    } catch (e) {
      out.errors++;
      console.error(`Monitoring ${row.doi} failed:`, e.message);
    }
  }
  return out;
}

/** Archive rescreening: monitored articles (forced) and every saved screening report's references */
async function rescreenArchive() {
  const articles = await runMonitor({ force: true, limit: 2000 });
  const reports = await retractionMonitor();
  return { articles, reportNotices: reports };
}

module.exports = { addArticles, importJournal, checkArticle, runMonitor, rescreenArchive };
