// alerts.js - notifications (in-app + e-mail) and the scheduled alert run: followed authors, topics and conferences,
// citation alerts for the user's own works (ORCID) and retraction monitoring of saved checks.
const db = require('./db');
const cfg = require('./config');
const S = require('./sources');
const D = require('./datasets');
const { interpretLists } = require('./checks/journal');

const enc = encodeURIComponent;
const short = id => String(id || '').replace('https://openalex.org/', '');
const DAY = 86400000;

let transport = null;
function mailer() {
  if (!cfg.SMTP.host) return null;
  if (!transport) transport = require('nodemailer').createTransport({ host: cfg.SMTP.host, port: cfg.SMTP.port, secure: cfg.SMTP.secure, auth: cfg.SMTP.user ? { user: cfg.SMTP.user, pass: cfg.SMTP.pass } : undefined });
  return transport;
}

async function sendEmail(to, subject, text) {
  const t = mailer();
  if (!t || !to) return false;
  try {
    await t.sendMail({ from: cfg.SMTP.from, to, subject: `[${cfg.APP_NAME}] ${subject}`, text: `${text}\n\n${cfg.PUBLIC_URL ? `Open: ${cfg.PUBLIC_URL}/app#/alerts\n` : ''}— ${cfg.APP_NAME} by ${cfg.APP_VENDOR}` });
    return true;
  } catch (e) {
    console.error('E-mail failed:', e.message);
    return false;
  }
}

/** Create a notification; e-mails it when SMTP is configured and the user has e-mail alerts on */
async function notify(userId, { kind, title, body = '', link = null, data = null, email = true }) {
  const row = await db.one('INSERT INTO notifications(user_id, kind, title, body, link, data) VALUES($1, $2, $3, $4, $5, $6) RETURNING id',
    [userId, kind, title, body, link, data ? JSON.stringify(data) : null]);
  if (email && !cfg.DESKTOP) {
    const u = await db.one('SELECT email, email_alerts FROM users WHERE id = $1', [userId]);
    if (u?.email_alerts && await sendEmail(u.email, title, body)) await db.query('UPDATE notifications SET emailed = true WHERE id = $1', [row.id]);
  }
  return row.id;
}

// ------------------------------------------------------------------ follow kinds

async function journalSignals(source) {
  if (!source) return {};
  const issns = source.issn || (source.issn_l ? [source.issn_l] : []);
  const lists = interpretLists(await D.listLookupAll(issns, source.display_name).catch(() => ({})));
  const pred = await D.predatoryMatches({ journal: source.display_name, publisher: source.host_organization_name }).catch(() => []);
  return { quartile: lists.sjr?.quartile || lists.jcr?.quartile || null, predatory: pred.length > 0, hjrs: lists.hjrs?.category || null };
}

const worksSince = (filter, sinceDays) => {
  const d = new Date(Date.now() - sinceDays * DAY).toISOString().slice(0, 10);
  return S.openalex(`works?filter=${filter},from_publication_date:${d}&sort=publication_date:desc&per-page=50&select=id,title,publication_year,doi,primary_location,authorships`);
};

async function checkAuthor(f, state) {
  const r = await worksSince(`author.id:${f.key}`, 60);
  if (!r.ok) return { state };
  const seen = new Set(state.seen || []);
  const fresh = (r.data.results || []).filter(w => !seen.has(short(w.id)));
  const items = fresh.map(w => `• ${w.title} (${w.publication_year}${w.primary_location?.source?.display_name ? ', ' + w.primary_location.source.display_name : ''})${w.doi ? ' ' + w.doi : ''}`);
  const next = { ...state, seen: [...fresh.map(w => short(w.id)), ...(state.seen || [])].slice(0, 300) };
  if (!state.initialised) return { state: { ...next, initialised: true } };
  return { state: next, notice: fresh.length ? { title: `${fresh.length} new publication(s) by ${f.label}`, body: items.join('\n'), data: { works: fresh.map(w => ({ title: w.title, doi: w.doi })) } } : null };
}

async function checkTopic(f, state) {
  const d = new Date(Date.now() - 21 * DAY).toISOString().slice(0, 10);
  const r = await S.openalex(`works?search=${enc(f.key)}&filter=from_publication_date:${d},type:article|review&sort=relevance_score:desc&per-page=25&select=id,title,publication_year,doi,primary_location`);
  if (!r.ok) return { state };
  const seen = new Set(state.seen || []);
  const fresh = (r.data.results || []).filter(w => !seen.has(short(w.id))).slice(0, 15);
  const next = { ...state, seen: [...fresh.map(w => short(w.id)), ...(state.seen || [])].slice(0, 500) };
  if (!state.initialised) return { state: { ...next, initialised: true } };
  return { state: next, notice: fresh.length ? { title: `${fresh.length} new paper(s) on “${f.label}”`, body: fresh.map(w => `• ${w.title} (${w.primary_location?.source?.display_name || 'unknown source'})${w.doi ? ' ' + w.doi : ''}`).join('\n'), data: { works: fresh.map(w => ({ title: w.title, doi: w.doi })) } } : null };
}

async function checkConference(f, state) {
  const r = await S.openalex(`sources/${f.key}`);
  if (!r.ok) return { state };
  const years = (r.data.counts_by_year || []).filter(c => c.works_count > 0).map(c => c.year);
  const known = new Set(state.years || []);
  const fresh = years.filter(y => !known.has(y));
  const next = { ...state, years };
  if (!state.initialised) return { state: { ...next, initialised: true } };
  return { state: next, notice: fresh.length ? { title: `New edition indexed: ${f.label}`, body: `Papers from ${fresh.sort().join(', ')} now appear for ${f.label}. Check its year-by-year coverage before submitting.` } : null };
}

/** Citation alerts for the works of the ORCID holder */
async function checkCitations(f, state) {
  const a = await S.openalex(`authors?filter=orcid:${f.key}`);
  const author = a.ok && a.data.results?.[0];
  if (!author) return { state };
  const authorId = short(author.id);
  const w = await S.openalex(`works?filter=author.id:${authorId}&per-page=200&select=id,title,cited_by_count`);
  if (!w.ok) return { state };
  const counts = Object.fromEntries((w.data.results || []).map(x => [short(x.id), x.cited_by_count]));
  if (!state.initialised) return { state: { counts, seenCiting: [], initialised: true, authorId } };
  const grown = (w.data.results || []).filter(x => (state.counts?.[short(x.id)] ?? 0) < x.cited_by_count).slice(0, 10);
  const seen = new Set(state.seenCiting || []);
  const lines = [];
  const found = [];
  for (const work of grown) {
    const c = await S.openalex(`works?filter=cites:${short(work.id)}&sort=publication_date:desc&per-page=10&select=id,title,publication_year,doi,primary_location,authorships`);
    for (const cw of (c.ok ? c.data.results || [] : [])) {
      if (seen.has(short(cw.id))) continue;
      seen.add(short(cw.id));
      const src = cw.primary_location?.source;
      const sig = await journalSignals(src && src.id ? (await S.openalex(`sources/${short(src.id)}`)).data : null);
      const self = (cw.authorships || []).some(x => short(x.author?.id) === authorId);
      const flags = [sig.quartile ? `quartile ${sig.quartile}` : null, sig.hjrs ? `HJRS ${sig.hjrs}` : null, sig.predatory ? 'PREDATORY-LIST MATCH' : null, self ? 'self-citation' : null].filter(Boolean);
      lines.push(`• “${work.title}” cited by: ${cw.title} (${src?.display_name || 'unknown source'}, ${cw.publication_year})${flags.length ? ' — ' + flags.join(', ') : ''}`);
      found.push({ cited: work.title, citing: cw.title, journal: src?.display_name, doi: cw.doi, quartile: sig.quartile, predatory: sig.predatory, self });
    }
  }
  return {
    state: { ...state, counts, authorId, seenCiting: [...seen].slice(-1000) },
    notice: found.length ? { title: `${found.length} new citation(s) of your work`, body: lines.join('\n'), data: { citations: found } } : null
  };
}

const RUNNERS = { author: [checkAuthor, 7], topic: [checkTopic, 7], conference: [checkConference, 7], citations: [checkCitations, 1] };

/** Retractions among references of saved checks that were not retracted when checked */
async function retractionMonitor() {
  const rows = await db.all(`SELECT id, user_id, title, manuscript_code, result FROM checks
    WHERE result IS NOT NULL AND kind IN ('manuscript', 'references', 'verify') AND created_at > now() - interval '3 years' ORDER BY id DESC LIMIT 3000`);
  let notices = 0;
  for (const row of rows) {
    const refs = row.result?.references?.results || [];
    const map = new Map();
    for (const r of refs) {
      const doi = (r.record?.doi || r.parsed?.doi || '').toLowerCase();
      if (doi && r.status !== 'retracted') map.set(doi, r);
    }
    if (!map.size) continue;
    const hits = await D.retractionsFor([...map.keys()]);
    for (const [doi, rw] of hits) {
      if (!/retraction/i.test(rw.nature || '')) continue;
      const dup = await db.one(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'retraction' AND data->>'doi' = $2 AND data->>'checkId' = $3`, [row.user_id, doi, String(row.id)]);
      if (dup) continue;
      const ref = map.get(doi);
      await notify(row.user_id, {
        kind: 'retraction',
        title: `A cited paper was retracted: ${row.manuscript_code || row.title || 'check #' + row.id}`,
        body: `Reference ${ref.index} — ${ref.raw}\nRetraction Watch: ${rw.nature}${rw.retraction_date ? ' (' + rw.retraction_date + ')' : ''}${rw.reason ? '\nReason: ' + rw.reason : ''}`,
        link: `#/check/${row.id}`, data: { doi, checkId: String(row.id), index: ref.index }
      });
      notices++;
    }
  }
  return notices;
}

let running = false;
/** Scheduled run (daily cron or timer). Each follow kind has its own cadence. */
async function runAlerts({ force = false } = {}) {
  if (running) return { skipped: true };
  running = true;
  const out = { follows: 0, notices: 0, retractions: 0, errors: 0 };
  try {
    const follows = await db.all('SELECT f.*, u.status FROM follows f JOIN users u ON u.id = f.user_id WHERE u.status = $1', ['active']);
    for (const f of follows) {
      const [fn, days] = RUNNERS[f.kind] || [];
      if (!fn) continue;
      if (!force && f.last_checked && Date.now() - new Date(f.last_checked).getTime() < days * DAY - 3600000) continue;
      try {
        const { state, notice } = await fn(f, f.state || {});
        await db.query('UPDATE follows SET state = $1, last_checked = now() WHERE id = $2', [JSON.stringify(state || {}), f.id]);
        out.follows++;
        if (notice) { await notify(f.user_id, { kind: f.kind, link: '#/alerts', ...notice }); out.notices++; }
      } catch (e) {
        out.errors++;
        console.error(`Alert ${f.kind}/${f.key} failed:`, e.message);
      }
    }
    out.retractions = await retractionMonitor();
  } finally {
    running = false;
  }
  return out;
}

module.exports = { notify, runAlerts, retractionMonitor, sendEmail, RUNNERS };
