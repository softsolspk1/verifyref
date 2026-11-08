// scripts/corpus-load-pmc.js - fills the bulk text repository (src/corpusBulk.js, everything on Cloudflare R2) with
// PubMed Central open-access full texts in the PJPS subject areas (src/subjects.js): the papers are chosen with Europe
// PMC's search (newest first, open access, in PMC) and their plain text is read from NCBI's PMC Article Datasets on AWS
// (public bucket pmc-oa-opendata, free). Texts go to R2 in packs of 1,000; the (hash, document) pairs are collected on
// this computer and turned into the R2 index by --publish. Resumes where it stopped (state in --dir).
//   node scripts/corpus-load-pmc.js [--limit 20000] [--dir D:\pjps-tmp\pmc-bulk]    load more papers
//   node scripts/corpus-load-pmc.js --publish                                        build and upload the index
//   node scripts/corpus-load-pmc.js --status
//   node scripts/corpus-load-pmc.js --cleanup                                        remove index versions on R2 the manifest does not use
// No paid service is used: Europe PMC, the PMC bucket and R2 storage only.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const U = require('../src/uploads');
const B = require('../src/corpusBulk');
const SUBJ = require('../src/subjects');

const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true; };
const DIR = arg('dir', 'D:\\pjps-tmp\\pmc-bulk');
const LIMIT = parseInt(arg('limit', '2000'), 10);
const CONCURRENCY = 20;
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const AWS = 'https://pmc-oa-opendata.s3.amazonaws.com';
// every PJPS subject area at once, open access and in PMC (the plain text is in the PMC bucket); reviews included
const QUERY = `(${SUBJ.SUBJECTS.map(s => `(${s.terms.map(t => `(TITLE_ABS:${t.includes(' AND ') ? `(${t})` : t})`).join(' OR ')})`).join(' OR ')}) AND OPEN_ACCESS:y AND IN_PMC:y`;

const file = n => path.join(DIR, n);
const readState = () => { try { return JSON.parse(fs.readFileSync(file('state.json'), 'utf8')); } catch (e) { return { nextPack: 0, cursor: '*', docs: 0, entries: 0, skipped: 0 }; } };
const writeState = s => { fs.writeFileSync(file('state.json.tmp'), JSON.stringify(s, null, 1)); fs.renameSync(file('state.json.tmp'), file('state.json')); };
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);

async function fetchText(url, { timeout = 60000 } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'PJPS-Data-Integrity-System/1.0 (bulk open-access corpus)' } });
      if (r.status === 404 || r.status === 403) return { status: r.status };
      if (r.ok) return { status: 200, text: await r.text() };
    } catch (e) { /* retried */ } finally { clearTimeout(t); }
    await new Promise(res => setTimeout(res, 2000 * (attempt + 1)));
  }
  return { status: 0 };
}

/** PMC plain text: the article version folder (usually .1), else the latest one listed */
async function pmcText(pmcid) {
  let r = await fetchText(`${AWS}/${pmcid}.1/${pmcid}.1.txt`);
  if (r.status === 200) return r.text;
  const list = await fetchText(`${AWS}/?list-type=2&delimiter=/&prefix=${pmcid}.`);
  const versions = [...String(list.text || '').matchAll(/<Prefix>(PMC\d+\.\d+)\/<\/Prefix>/g)].map(m => m[1]).sort((a, b) => parseInt(b.split('.')[1], 10) - parseInt(a.split('.')[1], 10));
  if (!versions.length) return null;
  r = await fetchText(`${AWS}/${versions[0]}/${versions[0]}.txt`);
  return r.status === 200 ? r.text : null;
}

/** Body (after the header blocks, before the reference list) and the reference list of a PMC plain text */
function splitText(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const seps = lines.map((l, i) => (/^={20,}\s*$/.test(l) ? i : -1)).filter(i => i >= 0);
  const start = seps.length >= 3 ? seps[2] + 1 : 0;
  let end = lines.length;
  for (let i = lines.length - 1; i > start; i--) if (/^\s*(references|bibliography|reference list|literature cited|works cited)\s*$/i.test(lines[i])) { end = i; break; }
  const clean = a => a.join('\n').replace(/\uFEFF/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { body: clean(lines.slice(start, end)), refs: clean(lines.slice(end + 1)) };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]).catch(() => null); } }));
  return out;
}

/** Write one pack to R2, then its index pairs and its PMCIDs here (a pack is either fully recorded or not at all) */
async function flush(state, pack, docs) {
  if (!docs.length) return;
  const parts = [], cat = [];
  let off = 0;
  docs.forEach((d, n) => {
    const gz = zlib.gzipSync(d.text, { level: 9 });
    const id = pack * B.PACK + n;
    cat.push({ id, key: `pmc:${d.pmcid}`, title: d.title, journal: d.journal, year: d.year, doi: d.doi, license: d.license, url: `https://pmc.ncbi.nlm.nih.gov/articles/${d.pmcid}/`, off, len: gz.length });
    parts.push(gz);
    off += gz.length;
    d.id = id;
  });
  await U.putObject(`${B.prefix()}/text/p${pack}.bin`, Buffer.concat(parts), 'application/octet-stream');
  await U.putObject(`${B.prefix()}/cat/p${pack}.json`, Buffer.from(JSON.stringify(cat)), 'application/json');
  // index pairs by file
  const byFile = new Map();
  let entries = 0;
  for (const d of docs) for (const h of d.hashes) {
    const f = B.fileOf(h);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(h, d.id);
    entries++;
  }
  for (const [f, list] of byFile) fs.appendFileSync(file(`idx/b${f.toString(16).padStart(2, '0')}.bin`), Buffer.from(new Uint32Array(list).buffer));
  fs.appendFileSync(file('done.txt'), docs.map(d => d.pmcid).join('\n') + '\n');
  state.docs += docs.length;
  state.entries += entries;
  state.nextPack = pack + 1;
  (state.packSizes = state.packSizes || [])[pack] = docs.length;
  writeState(state);
  log(`pack ${pack}: ${docs.length} papers, ${entries.toLocaleString('en')} index entries (total ${state.docs.toLocaleString('en')} papers)`);
}

async function load() {
  const state = readState();
  const done = new Set(fs.existsSync(file('done.txt')) ? fs.readFileSync(file('done.txt'), 'utf8').split('\n').filter(Boolean) : []);
  log(`Loading up to ${LIMIT.toLocaleString('en')} papers; ${done.size.toLocaleString('en')} already in the bulk repository`);
  let added = 0;
  // one pack per search page (at most 1,000 papers): the pack is written before the cursor moves past its page, so a
  // run stopped at any point resumes without losing or repeating papers
  while (added < LIMIT && state.cursor) {
    const url = `${EPMC}?format=json&resultType=lite&pageSize=1000&sort=P_PDATE_D%20desc&cursorMark=${encodeURIComponent(state.cursor)}&query=${encodeURIComponent(QUERY)}`;
    // Europe PMC's search fails now and then for a few minutes: tried again for up to 10 minutes (waits of 15 s
    // doubling to 2 min) before the run stops, since a stopped run costs an early publish of the whole index
    let r = await fetchText(url, { timeout: 120000 });
    for (let wait = 15000, until = Date.now() + 10 * 60000; r.status !== 200 && Date.now() + wait < until; wait = Math.min(wait * 2, 120000)) {
      log(`Europe PMC search failed (${r.status || 'no answer'}); trying again in ${wait / 1000} s`);
      await new Promise(res => setTimeout(res, wait));
      r = await fetchText(url, { timeout: 120000 });
    }
    if (r.status !== 200) { log('Europe PMC search failed for 10 minutes; stopping (run again to continue)'); break; }
    const data = JSON.parse(r.text);
    const list = (data.resultList?.result || []).filter(x => x.pmcid && !done.has(x.pmcid));
    const got = await pool(list.slice(0, LIMIT - added + 50), CONCURRENCY, async x => {
      const raw = await pmcText(x.pmcid);
      if (!raw) return null;
      const { body, refs } = splitText(raw);
      if (body.length < 3000) return null;
      return { pmcid: x.pmcid, title: String(x.title || '').replace(/<[^>]+>/g, '').slice(0, 500), journal: x.journalTitle || null, year: x.pubYear || null, doi: x.doi || null,
        license: (raw.match(/^License URL: (.+)$/m) || [])[1] || null, text: refs ? `${body}\n\nReferences\n${refs}` : body, hashes: B.bulkHashes(body) };
    });
    const page = [];
    for (const d of got) {
      if (!d) { state.skipped++; continue; }
      if (added >= LIMIT) break;
      page.push(d); done.add(d.pmcid); added++;
    }
    await flush(state, state.nextPack, page);
    // a page cut short by the limit is read again next run (its loaded papers are skipped as done)
    if (added < LIMIT) state.cursor = data.nextCursorMark && data.nextCursorMark !== state.cursor ? data.nextCursorMark : null;
    writeState(state);
  }
  log(`Done: ${added.toLocaleString('en')} papers added this run; ${state.docs.toLocaleString('en')} in total; run --publish to update the index on R2`);
}

/** Papers in each pack (Admin > Data pages through the catalogue with it); packs loaded before it was recorded are counted from their catalogue on R2 */
async function packSizes(state) {
  const sizes = state.packSizes || [];
  const missing = Array.from({ length: state.nextPack }, (_, p) => p).filter(p => sizes[p] == null);
  await pool(missing, 16, async p => { sizes[p] = JSON.parse((await U.getObject(`${B.prefix()}/cat/p${p}.json`)).toString('utf8')).length; });
  if (missing.some(p => sizes[p] == null)) throw new Error('could not count the papers of every pack - the manifest is not changed; run --publish again');
  state.packSizes = sizes;
  writeState(state);
  return sizes.slice(0, state.nextPack);
}

/** The R2 key of one index file of a version */
const indexKey = (version, f) => `${B.prefix()}/idx/v${version}/f${f.toString(16).padStart(2, '0')}.bin`;
// waits between the tries of one index file upload (a few minutes in all, so a short network drop does not fail the publish)
const UPLOAD_WAITS = [5000, 15000, 30000, 60000, 120000];

/**
 * Remove the index versions on R2 that the manifest does not use (a publish that failed or was stopped half way); keep:
 * the version being uploaded now. -> bytes removed
 */
async function cleanup({ keep = null } = {}) {
  const m = await B.getManifest().catch(() => null);
  if (!m?.version) { log('No published manifest; nothing removed'); return 0; }
  const objects = await U.listObjects(`${B.prefix()}/idx/`);
  const byVersion = new Map();
  for (const o of objects) {
    const v = (o.key.match(/\/idx\/v(\d+)\//) || [])[1];
    if (!v || Number(v) === Number(m.version) || (keep && Number(v) === Number(keep))) continue;
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(o);
  }
  let bytes = 0;
  for (const [v, list] of byVersion) {
    await pool(list, 8, o => U.deleteObject(o.key));
    const left = (await U.listObjects(`${B.prefix()}/idx/v${v}/`)).length;
    const size = list.reduce((a, o) => a + o.size, 0);
    bytes += size;
    log(`Removed unused index version ${v}: ${list.length - left} of ${list.length} files, ${(size / 1e9).toFixed(2)} GB${left ? ` (${left} could not be removed; run --cleanup again)` : ''}`);
  }
  if (!byVersion.size) log(`No unused index versions on R2 (published version ${m.version})`);
  return bytes;
}

async function publish() {
  const state = readState();
  const version = Date.now();
  const old = await B.getManifest().catch(() => null);
  // a run that added nothing (Europe PMC down) does not upload the same index again
  if (old?.docs === state.docs && old?.entries === state.entries && Array.isArray(old.packSizes)) { log(`Nothing new since the published index (${state.docs.toLocaleString('en')} papers); not rebuilt`); return; }
  // the files of an earlier publish that failed are removed first (R2 storage is paid by the GB)
  await cleanup().catch(e => log(`Unused index versions not removed: ${e.message}`));
  log(`Building index version ${version} from ${state.entries.toLocaleString('en')} entries`);
  let entries = 0, uploaded = 0;
  const failed = [];
  const send = async f => {
    const name = `b${f.toString(16).padStart(2, '0')}.bin`;
    const raw = fs.existsSync(file(`idx/${name}`)) ? fs.readFileSync(file(`idx/${name}`)) : Buffer.alloc(0);
    const pairs = new Uint32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 8)));
    const out = B.buildIndexFile(pairs);
    for (let attempt = 0; ; attempt++) {
      try { await U.putObject(indexKey(version, f), out, 'application/octet-stream'); break; }
      catch (e) {
        if (attempt >= UPLOAD_WAITS.length) { log(`  index file ${f} not uploaded: ${e.message}`); return false; }
        await new Promise(r => setTimeout(r, UPLOAD_WAITS[attempt]));
      }
    }
    entries += pairs.length / 2;
    if (++uploaded % 32 === 0) log(`  ${uploaded} / ${B.FILES} index files uploaded`);
    return true;
  };
  // 6 files built and uploaded at a time (each up to a few tens of MB); a file that failed every try is sent again at the end, alone
  await pool(Array.from({ length: B.FILES }, (_, f) => f), 6, async f => { if (!(await send(f))) failed.push(f); });
  if (failed.length) {
    log(`  ${failed.length} index file(s) failed; sending them again one at a time`);
    for (const f of failed.splice(0)) if (!(await send(f))) failed.push(f);
  }
  if (uploaded !== B.FILES) {
    // the manifest still points at the published version: this version's files are of no use, so they are removed
    await pool(Array.from({ length: B.FILES }, (_, f) => f), 8, f => U.deleteObject(indexKey(version, f)));
    throw new Error(`only ${uploaded} of ${B.FILES} index files uploaded - the manifest is not changed and the uploaded files were removed; run --publish again`);
  }
  const manifest = { version, docs: state.docs, entries, packs: state.nextPack, packSizes: await packSizes(state), builtAt: new Date().toISOString(), source: 'PubMed Central open access (PMC Article Datasets), PJPS subject areas' };
  await U.putObject(`${B.prefix()}/manifest.json`, Buffer.from(JSON.stringify(manifest, null, 1)), 'application/json');
  log(`Published: ${manifest.docs.toLocaleString('en')} papers, ${entries.toLocaleString('en')} index entries`);
  // the previous version's files are removed once the new manifest is in place
  if (old?.version && old.version !== version) {
    await pool(Array.from({ length: B.FILES }, (_, f) => f), 8, f => U.deleteObject(indexKey(old.version, f)));
    log(`Removed index version ${old.version}`);
  }
}

(async () => {
  if (!U.enabled()) throw new Error('Cloudflare R2 is not configured (R2_* in .env)');
  fs.mkdirSync(file('idx'), { recursive: true });
  if (arg('status')) { console.log({ local: readState(), published: await B.getManifest() }); }
  else if (arg('publish')) await publish();
  else if (arg('cleanup')) await cleanup();
  else await load();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
