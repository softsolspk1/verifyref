// jobs.js - background jobs persisted in PostgreSQL, polled by the browser.
// Works on a long-running server and on Vercel: work runs after the response (waitUntil), and a job whose
// instance was stopped (time limit, scale-down) is resumed by the next poll. Resumed runs are fast because
// every database lookup a run made is already in the HTTP cache.
const crypto = require('crypto');
const { waitUntil } = require('@vercel/functions');
const db = require('./db');

const STALE_SECONDS = 45;     // no heartbeat for this long = the run was stopped
const HEARTBEAT_MS = 10000;
const MAX_ATTEMPTS = 6;

const runners = new Map();

/** Register a job kind: fn(input, { userId, update }) => result. Input must be JSON-serialisable. */
function defineJob(kind, fn) {
  runners.set(kind, fn);
}

function background(promise) {
  const p = promise.catch(err => console.error('Job runner error:', err));
  try { waitUntil(p); } catch (e) { /* not on Vercel: the promise simply keeps running */ }
}

async function createJob(userId, kind, input) {
  if (!runners.has(kind)) throw new Error(`Unknown job kind: ${kind}`);
  const id = crypto.randomBytes(12).toString('hex');
  await db.query('INSERT INTO jobs(id, user_id, kind, input) VALUES($1, $2, $3, $4)', [id, userId, kind, JSON.stringify(input ?? {})]);
  background(runJob(id));
  return { id };
}

/** Claim the job (only if nobody holds a fresh lease) and run it */
async function runJob(id) {
  const job = await db.one(`UPDATE jobs SET attempts = attempts + 1, heartbeat = now(), status = 'running'
    WHERE id = $1 AND status IN ('queued', 'running') AND attempts < $2
      AND (heartbeat IS NULL OR heartbeat < now() - make_interval(secs => $3))
    RETURNING id, user_id, kind, input, attempts, progress`, [id, MAX_ATTEMPTS, STALE_SECONDS]);
  if (!job) return;
  const attempt = job.attempts;
  const mine = `id = $1 AND attempts = ${Number(attempt)}`; // a superseded run can no longer write

  let step = attempt > 1 ? 'Resuming…' : 'Starting…';
  let progress = job.progress || 0;
  let dirty = true;
  let lastWrite = 0;
  const flush = () => {
    dirty = false;
    lastWrite = Date.now();
    return db.query(`UPDATE jobs SET step = $2, progress = $3, heartbeat = now() WHERE ${mine} AND status = 'running'`, [id, step, progress]).catch(() => {});
  };
  const update = (s, p) => {
    if (s) step = s;
    if (typeof p === 'number') progress = Math.max(progress, Math.min(99, Math.round(p)));
    dirty = true;
    if (Date.now() - lastWrite > 1500) flush();
  };
  const timer = setInterval(() => { if (dirty || Date.now() - lastWrite > HEARTBEAT_MS - 500) flush(); }, HEARTBEAT_MS);
  flush();

  try {
    const result = await runners.get(job.kind)(job.input, { userId: job.user_id, update });
    clearInterval(timer);
    await db.query(`UPDATE jobs SET status = 'done', progress = 100, step = 'Complete', result = $2, heartbeat = now() WHERE ${mine}`, [id, JSON.stringify(result ?? null)]);
  } catch (err) {
    clearInterval(timer);
    console.error(`Job ${job.kind} failed:`, err);
    await db.query(`UPDATE jobs SET status = 'error', error = $2, heartbeat = now() WHERE ${mine}`, [id, err.message || String(err)]);
  }
}

/** Read a job for its owner; resumes it when its run was stopped */
async function getJob(id, userId) {
  const j = await db.one(`SELECT id, user_id, kind, status, progress, step, result, error, attempts,
      (heartbeat IS NULL OR heartbeat < now() - make_interval(secs => $2)) AS stale
    FROM jobs WHERE id = $1`, [id, STALE_SECONDS]);
  if (!j || j.user_id !== userId) return null;
  if ((j.status === 'running' || j.status === 'queued') && j.stale) {
    if (j.attempts >= MAX_ATTEMPTS) {
      await db.query(`UPDATE jobs SET status = 'error', error = $2 WHERE id = $1 AND status IN ('queued', 'running')`,
        [id, 'This check was interrupted too many times. Try again with fewer references.']);
      return { ...j, status: 'error', error: 'This check was interrupted too many times. Try again with fewer references.' };
    }
    background(runJob(id));
    j.step = 'Resuming…';
  }
  return j;
}

/** Remove finished jobs older than a day */
function purgeJobs() {
  return db.query("DELETE FROM jobs WHERE created_at < now() - interval '1 day'").catch(() => {});
}

module.exports = { defineJob, createJob, getJob, purgeJobs };
