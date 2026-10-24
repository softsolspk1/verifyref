// queue.js - desktop offline queue. Tool runs that need the internet are queued while offline; saved checks whose
// references could not be verified offline ("Pending — online verification") are re-checked. The queue is processed
// automatically when the connection returns, and the user is notified.
const db = require('./db');
const cfg = require('./config');
const { isOnline, onConnectivity } = require('./http');

const runners = new Map(); // job kind -> async (input, { userId, update }) => result

function registerQueued(kind, fn) { runners.set(kind, fn); }

async function enqueue(userId, { kind, checkId = null, input = null, label = '' }) {
  const row = await db.one('INSERT INTO offline_queue(user_id, kind, check_id, input, label) VALUES($1, $2, $3, $4, $5) RETURNING id',
    [userId, kind, checkId, input ? JSON.stringify(input) : null, label.slice(0, 300)]);
  return row.id;
}

/** Re-verify the pending references of a saved check and update it */
async function recheck(item) {
  const { loadCheck } = require('./pipeline');
  const { checkReferences, summarize } = require('./checks/reference');
  const P = require('./parse');
  const c = await loadCheck(item.user_id, item.check_id);
  if (!c?.result?.references?.results) return { updated: 0 };
  const results = c.result.references.results;
  const pending = results.filter(r => r.status === 'pending');
  if (!pending.length) return { updated: 0 };
  // Re-run the full verification for the pending entries only, then splice them back
  const refs = pending.map(r => ({ ...P.parseReferenceEntry(r.raw, r.index), index: r.index }));
  const fresh = await checkReferences(refs, { checkLinks: true });
  const byIndex = new Map(fresh.results.map(r => [r.index, r]));
  c.result.references.results = results.map(r => byIndex.get(r.index) || r);
  c.result.references.summary = summarize(c.result.references.results);
  const s = c.result.references.summary;
  await db.query(`UPDATE checks SET result = $1, verified = $2, suspicious = $3, unverified = $4, miscited = $5, retracted = $6, pending_online = $7, synced_at = NULL WHERE id = $8`,
    [JSON.stringify(c.result), s.verified, s.suspicious, s.unverified, s.miscited, s.retracted, s.pending || 0, item.check_id]);
  return { updated: pending.length - (s.pending || 0), stillPending: s.pending || 0, summary: s, title: c.row.manuscript_code || c.row.title || `check #${c.row.id}` };
}

let processing = false;
async function processQueue() {
  if (processing || !isOnline()) return { skipped: true };
  processing = true;
  const { notify } = require('./alerts');
  let done = 0;
  try {
    const items = await db.all("SELECT * FROM offline_queue WHERE status IN ('waiting', 'error') AND (status = 'waiting' OR created_at > now() - interval '7 days') ORDER BY id LIMIT 20");
    for (const item of items) {
      if (!isOnline()) break;
      await db.query("UPDATE offline_queue SET status = 'running' WHERE id = $1", [item.id]);
      try {
        if (item.kind === 'recheck') {
          const r = await recheck(item);
          if (r.stillPending) throw new Error(`${r.stillPending} reference(s) still unreachable`);
          await db.query("UPDATE offline_queue SET status = 'done', done_at = now(), error = NULL WHERE id = $1", [item.id]);
          if (r.updated) await notify(item.user_id, { kind: 'queue', title: `Online verification finished: ${r.title}`, body: `${r.updated} reference(s) verified now that the connection is back — ${r.summary.verified} verified, ${r.summary.suspicious} suspicious, ${r.summary.retracted} retracted in total.`, link: `#/check/${item.check_id}`, email: false });
        } else {
          const fn = runners.get(item.input?.job);
          if (!fn) throw new Error(`Unknown queued tool: ${item.input?.job}`);
          const result = await fn(item.input.data, { userId: item.user_id, update: () => {} });
          const checkId = result?.id || null;
          await db.query("UPDATE offline_queue SET status = 'done', done_at = now(), error = NULL, check_id = $2 WHERE id = $1", [item.id, checkId]);
          await notify(item.user_id, { kind: 'queue', title: `Queued run finished: ${item.label}`, body: 'The run you queued while offline has completed and was saved to My Activity.', link: checkId ? `#/check/${checkId}` : '#/activity', email: false });
        }
        done++;
      } catch (e) {
        await db.query("UPDATE offline_queue SET status = 'error', error = $2 WHERE id = $1", [item.id, e.message]);
      }
    }
  } finally {
    processing = false;
  }
  return { done };
}

function startQueueWatcher() {
  if (!cfg.DESKTOP) return;
  onConnectivity(online => { if (online) setTimeout(() => processQueue().catch(() => {}), 2000); });
  setInterval(() => processQueue().catch(() => {}), 60000).unref();
}

module.exports = { enqueue, processQueue, startQueueWatcher, registerQueued, recheck };
