// jobs.js - in-memory background jobs with progress, polled by the browser
const crypto = require('crypto');

const jobs = new Map();
const TTL = 2 * 3600 * 1000;

function createJob(userId, kind, fn) {
  const id = crypto.randomBytes(12).toString('hex');
  const job = { id, userId, kind, status: 'running', progress: 0, step: 'Starting…', result: null, error: null, startedAt: Date.now() };
  jobs.set(id, job);
  const update = (step, progress) => {
    if (step) job.step = step;
    if (typeof progress === 'number') job.progress = Math.max(job.progress, Math.min(99, Math.round(progress)));
  };
  Promise.resolve()
    .then(() => fn(update))
    .then(result => { job.result = result; job.status = 'done'; job.progress = 100; job.step = 'Complete'; })
    .catch(err => { console.error(`Job ${kind} failed:`, err); job.status = 'error'; job.error = err.message || String(err); });
  return job;
}

function getJob(id, userId) {
  const j = jobs.get(id);
  if (!j || j.userId !== userId) return null;
  return j;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.startedAt > TTL) jobs.delete(id);
}, 10 * 60000).unref();

module.exports = { createJob, getJob };
