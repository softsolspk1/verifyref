// jobs.js - background jobs persisted in PostgreSQL, polled by the browser.
// Works on a long-running server and on Vercel: work runs after the response (waitUntil), and a job whose
// instance was stopped (time limit, scale-down) is resumed by the next poll. Resumed runs are fast because
// every database lookup a run made is already in the HTTP cache.
const crypto = require('crypto');
const { waitUntil } = require('@vercel/functions');
const db = require('./db');

const STALE_SECONDS = 45;     // no heartbeat for this long = the run was stopped
const HEARTBEAT_MS = 10000;
const MAX_ATTEMPTS = 8;    // runs of one job: the stopped ones and those a long similarity search hands over to the next
// one run's time on Vercel (its functions stop at 300 s): long stages stop searching in time to save what they found
const RUN_BUDGET_MS = process.env.VERCEL ? 240000 : Infinity;

const runners = new Map();
const STOPPED = 'This check was stopped by the server too many times before it could finish. Run it again: the parts already looked up are reused, so the next run is faster.';

/**
 * Thrown by a job that has more to do than one run allows (the similarity search of a long manuscript): the run ends
 * without an error, its finished stages kept, and the next poll starts the next run at once
 */
class ResumeLater extends Error {
  constructor(step) { super(step || 'Continuing in the next run'); this.resumeLater = true; }
}

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
    RETURNING id, user_id, kind, input, attempts, progress, partial`, [id, MAX_ATTEMPTS, STALE_SECONDS]);
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

  // stage(key, fn): a stage finished by an earlier run of this job is not run again (its result is kept in jobs.partial)
  const partial = job.partial || {};
  const stage = async (key, fn) => {
    if (partial[key] !== undefined) return partial[key];
    const out = await fn();
    partial[key] = out ?? null;
    await db.query(`UPDATE jobs SET partial = COALESCE(partial, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) WHERE ${mine}`, [id, key, JSON.stringify(out ?? null)]).catch(() => {});
    return out;
  };
  const deadline = Date.now() + RUN_BUDGET_MS;

  try {
    const result = await runners.get(job.kind)(job.input, { userId: job.user_id, update, stage, deadline, attempt, jobId: id });
    clearInterval(timer);
    // the input (manuscript text) is dropped as soon as the job ends: the job table never keeps an unpublished manuscript
    await db.query(`UPDATE jobs SET status = 'done', progress = 100, step = 'Complete', result = $2, input = '{}', partial = NULL, heartbeat = now() WHERE ${mine}`, [id, JSON.stringify(result ?? null)]);
  } catch (err) {
    clearInterval(timer);
    if (err?.resumeLater && attempt < MAX_ATTEMPTS) {
      // the heartbeat is set back so the browser's next poll finds the run stopped and starts the next one
      await db.query(`UPDATE jobs SET step = $2, heartbeat = now() - make_interval(secs => $3) WHERE ${mine} AND status = 'running'`, [id, err.message, STALE_SECONDS + 1]).catch(() => {});
      return;
    }
    if (!err?.resumeLater) console.error(`Job ${job.kind} failed:`, err);
    await db.query(`UPDATE jobs SET status = 'error', error = $2, input = '{}', partial = NULL, heartbeat = now() WHERE ${mine}`, [id, err?.resumeLater ? STOPPED : err.message || String(err)]);
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
      await db.query(`UPDATE jobs SET status = 'error', error = $2, input = '{}', partial = NULL WHERE id = $1 AND status IN ('queued', 'running')`,
        [id, STOPPED]);
      return { ...j, status: 'error', error: STOPPED };
    }
    background(runJob(id));
    j.step = 'Resuming…';
  }
  return j;
}

/** Add fields to the input of the owner's job while it runs (read by the job with jobInput) */
async function attachToJob(id, userId, fields) {
  const r = await db.query(`UPDATE jobs SET input = input || $3::jsonb WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running')`, [id, userId, JSON.stringify(fields)]);
  return (r.rowCount ?? r.affectedRows ?? 0) > 0;
}

/** The current input of a job (fields attached after it started) */
async function jobInput(id) {
  return (await db.one('SELECT input FROM jobs WHERE id = $1', [id]))?.input || null;
}

/** Remove finished jobs older than a day */
function purgeJobs() {
  return db.query("DELETE FROM jobs WHERE created_at < now() - interval '1 day'").catch(() => {});
}

module.exports = { defineJob, createJob, getJob, purgeJobs, attachToJob, jobInput, ResumeLater, MAX_ATTEMPTS };
