// test/http-lanes.js - the reference lookups (foreground) are not queued behind the similarity search (inBackground)
// at a shared host: background requests hold only part of the host's slots, and a freed slot goes to the foreground
process.env.PGLITE_DIR = process.env.PGLITE_DIR || 'memory://';
const assert = require('assert');
const H = require('../src/http');

let running = 0, peak = 0, peakLow = 0, runningLow = 0;
const order = [];
globalThis.fetch = async url => {
  const low = url.includes('bg=');
  running++; if (low) runningLow++;
  peak = Math.max(peak, running); peakLow = Math.max(peakLow, runningLow);
  await new Promise(r => setTimeout(r, 40));
  running--; if (low) runningLow--;
  order.push(low ? 'bg' : 'fg');
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

(async () => {
  await require('../src/db').init();   // loading the database would stall the timings below
  const url = q => `https://lanes.example.org/x?${q}`;   // default limit: 4 slots, 3 for the background lane
  const bg = H.inBackground(() => Promise.all(Array.from({ length: 30 }, (_, i) => H.getJson(url(`bg=${i}`), { ttl: 0, retries: 0 }))));
  await new Promise(r => setTimeout(r, 5));
  const t0 = Date.now();
  const fg = await Promise.all(Array.from({ length: 6 }, (_, i) => H.getJson(url(`fg=${i}`), { ttl: 0, retries: 0 })));
  const fgMs = Date.now() - t0;
  await bg;
  assert.ok(fg.every(r => r.ok), 'foreground answered');
  assert.ok(peak <= 4, `host limit kept (${peak})`);
  assert.ok(peakLow <= 3, `background lane leaves a slot free (${peakLow})`);
  // 6 lookups behind 30 background requests: the old single queue took about 9 rounds (360 ms), now about 3-4
  assert.ok(fgMs < 250, `foreground not queued behind the background (${fgMs} ms)`);
  const lastFg = order.lastIndexOf('fg');
  assert.ok(lastFg < 15, `foreground done early (${lastFg + 1}th of ${order.length})`);
  // the background lane alone still uses its slots
  peakLow = 0;
  await H.inBackground(() => Promise.all(Array.from({ length: 9 }, (_, i) => H.getJson(url(`bg=b${i}`), { ttl: 0, retries: 0 }))));
  assert.strictEqual(peakLow, 3, 'background uses its 3 slots');
  console.log(`http lanes test passed (6 lookups in ${fgMs} ms behind 30 background requests)`);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
