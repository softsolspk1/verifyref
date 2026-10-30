// test/imagetwin.js - Module 5.7 ImageTwin API connection, against a stub of api.imagetwin.ai that answers exactly as the
// public API documentation describes (https://user-manual.imagetwin.ai/api-documentation): the request we send (endpoint,
// bearer key, multipart "file" field, options, sandbox path), the documented limits, 202 while running, 200 with counts,
// error codes, the audit record, and the result copied into the saved Module 5 report. Run: node test/imagetwin.js
process.env.PGLITE_DIR = 'memory://';
delete process.env.DATABASE_URL;
delete process.env.APP_MODE;
delete process.env.IMAGETWIN_API_KEY;
delete process.env.IMAGETWIN_SANDBOX;
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET']) process.env[k] = '';
const assert = require('assert');

// ---- stub of the ImageTwin API (documented request and response shapes)
const calls = [];
let resultPolls = 0;
const SCAN_ID = 'd904c90756d6653f27ce9fc27847a5bf61e35b4cb288d0a301e879cbef3e4579'; // the documentation's sample id
const realFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://api.imagetwin.ai/')) return realFetch(url, init);
  const call = { url: String(url), method: init.method, auth: init.headers?.Authorization, form: init.body instanceof FormData ? init.body : null };
  calls.push(call);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (call.auth !== 'Bearer it-test-key') return json(401, { message: 'Unauthorized' });
  if (/\/scan$/.test(call.url)) return json(200, { scanId: SCAN_ID, message: 'Scan started successfully' });
  if (call.url.endsWith(`/result/${SCAN_ID}`)) {
    resultPolls++;
    if (resultPolls === 1) return json(202, { message: 'Scan in progress' });
    return json(200, { scanId: SCAN_ID, alterationCount: 1, localDuplicateCount: 2, externDuplicateCount: 3, aiImageCount: 0, pdfReport: 'https://app.imagetwin.ai/report.pdf', resultUrl: 'https://app.imagetwin.ai/result/x', minScore: 0.33, highestScore: 0.81 });
  }
  if (/\/result\//.test(call.url)) return json(404, { message: 'Not found' });
  return json(500, {});
};

const db = require('../src/db');
const IT = require('../src/vendors/imagetwin');
const IMG = require('../src/images');
const { saveResult } = require('../src/pipeline');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };
const rejects = async (p, re, m) => { try { await p; } catch (e) { ok(re.test(e.message), `${m} (got: ${e.message})`); return; } assert.fail(`${m}: did not fail`); };
const file = (name, size = 1000) => ({ name, type: 'application/octet-stream', buffer: Buffer.alloc(size, 1) });

(async () => {
  await db.init();
  const user = await db.one("INSERT INTO users(email, name, password_hash, role, status) VALUES('editor@test.local', 'Editor', 'x', 'editor', 'active') RETURNING id");

  // ---- not connected: nothing is sent, the report says "not checked"
  ok(!(await IMG.vendorStatus(user.id)).connected, 'without IMAGETWIN_API_KEY: not connected');
  await rejects(IMG.startVendorScan(user.id, [file('ms.pdf')]), /not connected/, 'without a key nothing is sent');
  ok(calls.length === 0, 'no request reached ImageTwin');

  // ---- documented limits
  ok(IT.validate([file('ms.pdf')]) === 'document' && IT.validate([file('a.png'), file('b.tif')]) === 'images', 'one document, or images');
  for (const [files, re, m] of [
    [[file('ms.pdf'), file('a.png')], /not both/, 'document and images together refused'],
    [[file('ms.pdf', 30 * 1024 * 1024)], /under 30 MB/, 'document of 30 MB refused'],
    [Array.from({ length: 26 }, (_, i) => file(`f${i}.png`)), /up to 25/, '26 images refused'],
    [[file('big.png', 20 * 1024 * 1024)], /under 20 MB/, 'image of 20 MB refused'],
    [[file('notes.txt')], /does not accept/, 'unsupported file type refused']
  ]) { try { IT.validate(files); assert.fail(m); } catch (e) { ok(re.test(e.message), m); } }

  // ---- wrong key: the documented 401 is explained
  process.env.IMAGETWIN_API_KEY = 'wrong-key';
  await rejects(IMG.startVendorScan(user.id, [file('ms.pdf')]), /refused the API key/, '401 explained');

  // ---- connected: scan, poll (202 then 200), result attached to the saved report
  process.env.IMAGETWIN_API_KEY = 'it-test-key';
  const st = await IMG.vendorStatus(user.id);
  ok(st.connected && st.vendor === 'ImageTwin' && !st.sandbox, 'with the key: connected (live mode)');
  const check = { kind: 'images', module: 5, summary: { level: 'LOW', findings: 0 }, findings: [], meta: { manuscriptCode: 'PJPS-2026-0412' } };
  const checkId = await saveResult(user.id, 'images', check, { title: 'Figures', manuscriptCode: 'PJPS-2026-0412' });
  calls.length = 0;
  const scan = await IMG.startVendorScan(user.id, [file('PJPS-2026-0412.pdf')], { checkId, manuscriptCode: 'PJPS-2026-0412', minScore: 0.66, excludeIdenticalPaper: true });
  const sent = calls[0];
  ok(sent.url === 'https://api.imagetwin.ai/v1/scan' && sent.method === 'POST', 'POST /v1/scan');
  ok(sent.form.get('file').name === 'PJPS-2026-0412.pdf' && sent.form.get('minScore') === '0.66' && sent.form.get('excludeIdenticalPaper') === 'true', 'multipart "file", minScore and excludeIdenticalPaper sent');
  ok(scan.scanId === SCAN_ID && scan.status === 'running', 'scan recorded as running with ImageTwin\'s scanId');
  const audit = await db.one("SELECT * FROM audit_log WHERE action = 'vendor.imagetwin.scan'");
  ok(audit && /PJPS-2026-0412/.test(audit.target), 'sending is written to the audit log');

  const first = await IMG.vendorScan(user.id, scan.id);
  ok(first.status === 'running' && calls.at(-1).url === `https://api.imagetwin.ai/v1/result/${SCAN_ID}`, '202 Accepted: still running');
  const done = await IMG.vendorScan(user.id, scan.id);
  ok(done.status === 'finished' && done.result.externalDuplicates === 3 && done.result.localDuplicates === 2 && done.result.alterations === 1 && done.result.aiImages === 0, '200: counts read from the documented fields');
  ok(done.level === 'HIGH', 'highest confidence 81% = HIGH (ImageTwin band 66-100%)');
  ok(done.result.pdfReport && done.result.resultUrl, 'PDF report and web result links kept');
  const polls = resultPolls;
  await IMG.vendorScan(user.id, scan.id);
  ok(resultPolls === polls, 'a finished scan is not asked for again');
  const saved = await db.one('SELECT result FROM checks WHERE id = $1', [checkId]);
  const res = typeof saved.result === 'string' ? JSON.parse(saved.result) : saved.result;
  ok(res.vendorScan?.status === 'finished' && res.vendorScan.result.externalDuplicates === 3, 'result copied into the saved Module 5 report');
  ok(!(await IMG.vendorScan(user.id + 999, scan.id)), 'another user cannot read the scan');

  // ---- confidence bands, Word report section
  ok(IT.level(IT.normalize({ highestScore: 0.5, localDuplicateCount: 1 })) === 'MEDIUM' && IT.level(IT.normalize({ highestScore: 0 })) === 'LOW', '33-65% = MEDIUM, nothing found = LOW');
  const W = require('../src/docx');
  ok(JSON.stringify(W.imagesBlocks({ ...res, summary: { level: 'LOW', images: 0, panels: 0, findings: 0, byLevel: {} }, findings: [] })).includes('Matches with published figures'), 'Word report lists the ImageTwin counts');

  // ---- sandbox mode uses the free sandbox path
  process.env.IMAGETWIN_SANDBOX = '1';
  calls.length = 0;
  const sb = await IMG.startVendorScan(user.id, [file('a.png'), file('b.jpg')]);
  ok(calls[0].url === 'https://api.imagetwin.ai/v1/sandbox/scan' && sb.sandbox === true, 'IMAGETWIN_SANDBOX=1: /v1/sandbox/scan, marked as sandbox');
  ok(calls[0].form.getAll('file').length === 2, 'several images sent as repeated "file" fields');

  console.log(`imagetwin test passed (${n} checks)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
