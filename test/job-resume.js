// job-resume.js - a job that hands its work over to the next run (jobs.ResumeLater, the similarity search of a long
// manuscript): the run ends without an error, its finished stages are kept, the next poll starts the next run at once,
// and the last run saves the result. Offline: the in-memory database, no external service.
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.VERCEL;
const assert = require('assert');
const db = require('../src/db');
const jobs = require('../src/jobs');

const ok = m => console.log(`  ok - ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await db.init();
  const u = await db.one("INSERT INTO users(email, name, password_hash) VALUES('resume@test', 'Resume test', 'x') RETURNING id");

  // runs 1 and 2 hand over; run 3 finishes. The 'first' stage runs once, whatever the number of runs
  let firstRuns = 0;
  const seen = [];
  jobs.defineJob('resume-test', async (input, { stage, attempt }) => {
    seen.push(attempt);
    const first = await stage('first', async () => { firstRuns++; return { n: 42 }; });
    if (attempt < 3) throw new jobs.ResumeLater(`Searching (run ${attempt})`);
    return { first, runs: attempt };
  });
  const { id } = await jobs.createJob(u.id, 'resume-test', { a: 1 });

  let j = null;
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    j = await jobs.getJob(id, u.id); // the browser's poll: starts the next run of a handed-over job
    if (j.status === 'done' || j.status === 'error') break;
  }
  assert.strictEqual(j.status, 'done', `finished, not ${j.status}: ${j.error || ''}`);
  assert.deepStrictEqual(seen, [1, 2, 3], 'three runs, one after another');
  assert.deepStrictEqual(j.result, { first: { n: 42 }, runs: 3 }, 'the result of the last run');
  assert.strictEqual(firstRuns, 1, 'a finished stage is not run again');
  ok('a handed-over job goes on in the next run and saves the result of the last');

  // a job that keeps handing over stops at MAX_ATTEMPTS with the usual message, not forever
  jobs.defineJob('resume-forever', async () => { throw new jobs.ResumeLater('again'); });
  const loop = await jobs.createJob(u.id, 'resume-forever', {});
  for (let i = 0; i < 200; i++) {
    await sleep(50);
    j = await jobs.getJob(loop.id, u.id);
    if (j.status === 'done' || j.status === 'error') break;
  }
  assert.strictEqual(j.status, 'error', 'stops');
  assert.ok(/stopped by the server too many times/.test(j.error), 'with the usual message');
  const row = await db.one('SELECT attempts FROM jobs WHERE id = $1', [loop.id]);
  assert.ok(row.attempts <= jobs.MAX_ATTEMPTS, `at most ${jobs.MAX_ATTEMPTS} runs (${row.attempts})`);
  ok(`a job that never finishes stops after ${jobs.MAX_ATTEMPTS} runs`);

  console.log('job resume test passed');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
