// test/audit-m1-features.js - every Module 1 feature (spec 1.1-1.9) end to end through the API, with known answers:
// input (manuscript upload, .bib, .ris, pasted list, garbled PDF text, list editing), verification and verdicts, record
// shown with differing fields, corrected reference, links to the record, fabrication checks (DOI with junk repaired, DOI
// / PMID / arXiv that does not exist or points elsewhere, regional journal "Not indexed"), retraction with reason and
// date, retraction monitoring of saved reports, link check kept apart from the verdict, reference age, self-citation,
// PJPS citations, predatory journals, duplicates, summary, exports (CSV, BibTeX, RIS, Word, PDF, corrected list in any
// style) and re-check. Needs internet. node test/audit-m1-features.js
const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname;

const results = [];
const check = (feature, name, ok, detail = '') => { results.push({ feature, name, ok: !!ok, detail: ok ? '' : String(detail).slice(0, 300) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${feature.padEnd(4)} ${name}${ok ? '' : `  <- ${String(detail).slice(0, 300)}`}`); };

const REFS = {
  mosmann: 'Mosmann T (1983). Rapid colorimetric assay for cellular growth and survival: application to proliferation and cytotoxicity assays. J. Immunol. Methods, 65(1-2): 55-63.',
  wrongVol: 'Schneider CA, Rasband WS and Eliceiri KW (2012). NIH Image to ImageJ: 25 years of image analysis. Nat. Methods, 19(7): 671-675.',
  doiJunk: 'Schneider CA, Rasband WS and Eliceiri KW (2012). NIH Image to ImageJ: 25 years of image analysis. Nat. Methods, 9(7): 671-675. doi:10.1038/nmeth.2089671-675',
  pmidElsewhere: 'Laemmli UK (1970). Cleavage of structural proteins during the assembly of the head of bacteriophage T4. Nature, 227(5259): 680-685. PMID: 22930834',
  pmidFake: 'Ahmed R, Khan S and Malik T (2021). Nanostructured lipid carriers of glibenclamide improve glycaemic control in diabetic rabbits. Int. J. Pharm., 601: 120561. PMID: 99999999',
  arxivFake: 'Li X and Chen Y (2022). A transformer model for predicting oral bioavailability of flavonoids. arXiv:2299.99999.',
  regional: 'Shah ZA, Gul R and Afridi MS (2016). Prescribing pattern of antibiotics in tertiary care hospitals of Dera Ismail Khan. Gomal J. Med. Sci., 14(2): 77-81.',
  retracted: 'Wakefield AJ, Murch SH, Anthony A et al. (1998). Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet, 351(9103): 637-641.',
  brokenLink: 'Trott O and Olson AJ (2010). AutoDock Vina: improving the speed and accuracy of docking with a new scoring function, efficient optimization, and multithreading. J. Comput. Chem., 31(2): 455-461. Available at: https://www.example.org/this-page-does-not-exist-pjps-test (Accessed 10 May 2024).',
  pjps: 'Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants of Swat valley. Pak. J. Pharm. Sci., 32(1): 1-5.',
  invented: 'Bradford MM and Lowry OH (1981). Comparison of dye-binding and Folin methods for protein estimation in herbal formulations. Anal. Biochem., 112(2): 301-309.'
};

(async () => {
  const api = await boot();
  const db = require('../src/db');
  const t0 = Date.now();

  // ================================================================ 1.1 input
  // manuscript upload: the reference list is found under its heading
  const ms = await Packer.toBuffer(new Document({ sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Introduction')] }),
    new Paragraph({ children: [new TextRun('Cell viability was measured by the MTT assay (Mosmann, 1983) and images were analysed in ImageJ (Schneider et al., 2012). '.repeat(8))] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('References')] }),
    new Paragraph({ children: [new TextRun(REFS.mosmann)] }),
    new Paragraph({ children: [new TextRun(REFS.wrongVol.replace('19(7)', '9(7)'))] })
  ] }] }));
  let r = await api.form('/api/extract', {}, { file: { buffer: ms, name: 'manuscript.docx' } });
  check('1.1', 'Word manuscript: reference list found automatically (2 references, body kept)', r.data.referenceCount === 2 && /MTT assay/.test(r.data.bodyText), JSON.stringify(r.data).slice(0, 200));

  const bib = `@article{mos83, author = {Mosmann, Tim}, title = {Rapid colorimetric assay for cellular growth and survival: application to proliferation and cytotoxicity assays}, journal = {Journal of Immunological Methods}, year = {1983}, volume = {65}, number = {1-2}, pages = {55--63}, doi = {10.1016/0022-1759(83)90303-4}}
@article{sch12, author = {Schneider, Caroline A. and Rasband, Wayne S. and Eliceiri, Kevin W.}, title = {{NIH} Image to {ImageJ}: 25 years of image analysis}, journal = {Nature Methods}, year = {2012}, volume = {9}, pages = {671--675}}`;
  r = await api.form('/api/extract', {}, { file: { buffer: Buffer.from(bib), name: 'refs.bib' } });
  check('1.1', '.bib import: 2 structured entries', r.data.referenceCount === 2 && (r.data.structured || []).length === 2, JSON.stringify(r.data).slice(0, 200));
  const ris = `TY  - JOUR\nAU  - Mosmann, Tim\nTI  - Rapid colorimetric assay for cellular growth and survival\nJO  - Journal of Immunological Methods\nPY  - 1983\nVL  - 65\nSP  - 55\nEP  - 63\nER  - \nTY  - JOUR\nAU  - Laemmli, U. K.\nTI  - Cleavage of structural proteins during the assembly of the head of bacteriophage T4\nJO  - Nature\nPY  - 1970\nVL  - 227\nSP  - 680\nEP  - 685\nER  - \n`;
  r = await api.form('/api/extract', {}, { file: { buffer: Buffer.from(ris), name: 'refs.ris' } });
  check('1.1', '.ris import: 2 structured entries', r.data.referenceCount === 2, JSON.stringify(r.data).slice(0, 200));

  // garbled PDF text: entries broken over lines, hyphenation, ligatures
  const garbled = `1. Mosmann T (1983). Rapid colori-\nmetric assay for cellular growth and survival: application to prolif-\neration and cytotoxicity assays. J. Immunol. Methods, 65(1-2): 55-63.\n2. Laemmli UK (1970). Cleavage of structural proteins during the assembly of the head of bacterio-\nphage T4. Nature, 227(5259): 680-685.\n3. Brand-Williams W, Cuvelier ME and Berset C (1995). Use of a free radical method to evaluate antioxidant activity. LWT - Food Sci. Technol., 28(1): 25-30. Speciﬁc ﬂavonoids`;
  r = await api.json('POST', '/api/parse', { text: garbled });
  const pr = r.data.references || [];
  check('1.1', 'Garbled PDF text: 3 entries from 7 broken lines', pr.length === 3, `got ${pr.length}`);
  check('1.1', 'Garbled PDF text: hyphenation across lines repaired ("colorimetric", "proliferation", "bacteriophage")', /colorimetric/.test(pr[0]?.title) && /proliferation/.test(pr[0]?.title) && /bacteriophage/.test(pr[1]?.title), `${pr[0]?.title} | ${pr[1]?.title}`);
  check('1.1', 'Garbled PDF text: ligatures repaired (ﬁ, ﬂ)', !/[ﬁﬂ]/.test(pr[2]?.raw || '') && /Specific flavonoids/.test(pr[2]?.raw || ''), pr[2]?.raw);
  // editing the detected list: the checker takes the entries as edited (split / merged by the user)
  r = await api.json('POST', '/api/parse', { text: `${REFS.mosmann} ${REFS.pjps}`, strategy: 'auto' });
  check('1.1', 'Two references pasted on one line are split into two', (r.data.references || []).length === 2, `got ${(r.data.references || []).length}`);

  // ================================================================ main check
  const order = ['mosmann', 'wrongVol', 'doiJunk', 'pmidElsewhere', 'pmidFake', 'arxivFake', 'regional', 'retracted', 'brokenLink', 'pjps', 'invented', 'mosmann'];
  const text = order.map((k, i) => `${i + 1}. ${REFS[k]}`).join('\n');
  // predatory journal from the loaded list (Beall / Stop Predatory Journals), so the test does not depend on one name
  await require('../src/datasets').coreDatasetsReady();
  const pred = await db.one("SELECT name FROM predatory WHERE kind = 'journal' AND name ~ '^[A-Z][A-Za-z ]{15,80}$' AND name ~* 'pharm|medic|biolog|health' ORDER BY name LIMIT 1").catch(() => null);
  const predRef = pred ? `Rehman F and Aziz T (2020). Phytochemical screening of Calotropis procera leaves. ${pred.name}, 8(3): 112-118.` : null;
  const full = predRef ? `${text}\n${order.length + 1}. ${predRef}` : text;
  let s = await api.json('POST', '/api/checks', { kind: 'references', referencesText: full, manuscriptCode: 'AUDIT-M1-FEATURES', meta: { authors: ['Tim Mosmann', 'Bushra Ali'], title: 'MTT assay of medicinal plants' } });
  let job = await api.job(s.data.jobId, 900);
  if (job.status !== 'done') { console.error('check failed', job); process.exit(1); }
  const res = job.result, rows = res.references.results, sum = res.references.summary, ind = res.indicators || {};
  const row = k => rows[order.indexOf(k)];

  // ================================================================ 1.2 / 1.3 verification and verdicts
  check('1.2', 'Searched the scholarly databases (Crossref, OpenAlex, PubMed, Europe PMC, DataCite, arXiv, Open Library, Google Books ...)', ['Crossref', 'OpenAlex', 'PubMed', 'Europe PMC', 'DataCite', 'arXiv', 'Open Library', 'Google Books'].every(d => sum.databases.includes(d)), sum.databases);
  check('1.3', 'Genuine reference: Verified', row('mosmann').status === 'verified', row('mosmann').reason);
  check('1.3', 'Wrong volume: Miscited', row('wrongVol').status === 'miscited', row('wrongVol').reason);
  check('1.3', 'Retracted paper: Retracted', row('retracted').status === 'retracted', row('retracted').reason);
  check('1.3', 'Invented reference: Suspicious', row('invented').status === 'suspicious', row('invented').reason);
  check('1.3', 'Confidence 0-100 on every reference', rows.every(x => Number.isFinite(x.confidence) && x.confidence >= 0 && x.confidence <= 100), rows.map(x => x.confidence));
  const volIssue = (row('wrongVol').issues || []).find(i => i.code === 'volume');
  check('1.3', 'Matched record shown with the differing field (volume 19 cited, 9 registered)', volIssue && String(volIssue.cited) === '19' && String(volIssue.registered) === '9' && row('wrongVol').record?.title, JSON.stringify(row('wrongVol').issues));
  check('1.3', 'Corrected reference in PJPS style (volume 9, all authors, abbreviated journal)', /\(2012\)\. NIH Image to ImageJ/.test(row('wrongVol').suggestion || '') && /Nat\.? Methods, 9\(7\): 671-675/.test(row('wrongVol').suggestion || ''), row('wrongVol').suggestion);
  check('1.3', 'Link to the matched record (DOI)', /doi\.org\/10\.1038\/nmeth\.2089/i.test(row('wrongVol').record?.url || ''), row('wrongVol').record?.url);

  // ================================================================ 1.4 fabrication checks
  check('1.4', 'DOI with page numbers stuck on the end is repaired and the reference verified', row('doiJunk').status === 'verified' && /^10\.1038\/nmeth\.2089$/i.test(row('doiJunk').record?.doi || ''), `${row('doiJunk').status} ${row('doiJunk').record?.doi} ${row('doiJunk').reason}`);
  check('1.4', 'PMID pointing to a different paper is reported (not Verified)', row('pmidElsewhere').status !== 'verified' || (row('pmidElsewhere').issues || []).some(i => /pmid/i.test(i.code)), `${row('pmidElsewhere').status} ${JSON.stringify(row('pmidElsewhere').issues)}`);
  check('1.4', 'PMID that does not exist: Suspicious', row('pmidFake').status === 'suspicious' && (row('pmidFake').issues || []).some(i => i.code === 'pmid-invalid'), `${row('pmidFake').status} ${JSON.stringify(row('pmidFake').issues)}`);
  check('1.4', 'arXiv identifier that does not exist: Suspicious', row('arxivFake').status === 'suspicious' && (row('arxivFake').issues || []).some(i => i.code === 'arxiv-invalid'), `${row('arxivFake').status} ${JSON.stringify(row('arxivFake').issues)}`);
  check('1.4', 'Regional Pakistani journal not in the databases: "Not indexed", not Suspicious', row('regional').status === 'unverified' && row('regional').notIndexed, `${row('regional').status} ${row('regional').reason}`);
  check('1.4', 'Invented reference in a well-indexed journal: reason says the journal is well indexed', /well indexed/.test(row('invented').reason), row('invented').reason);

  // ================================================================ 1.5 retractions
  check('1.5', 'Retraction date and reason shown', row('retracted').retraction?.date && (row('retracted').retraction?.reason || '').length > 3, JSON.stringify(row('retracted').retraction));
  // monitoring: a saved report citing a paper that is retracted later -> the editor is notified
  const saved = await db.one('SELECT id, result FROM checks WHERE id = $1', [res.id]);
  const changed = JSON.parse(JSON.stringify(typeof saved.result === 'string' ? JSON.parse(saved.result) : saved.result));
  // the report as saved before the retraction: full result, or the stub left when the report is kept in storage (R2)
  const doiW = '10.1016/S0140-6736(97)11096-0', iW = order.indexOf('retracted') + 1;
  if (changed._r2) {
    changed.refDois = (changed.refDois || []).filter(x => x.index !== iW).concat({ index: iW, raw: REFS.retracted, doi: doiW, retracted: false });
  } else {
    const w = changed.references.results[iW - 1];
    Object.assign(w, { status: 'verified', retraction: null, record: { ...(w.record || {}), doi: doiW } });
  }
  await db.query('UPDATE checks SET result = $1 WHERE id = $2', [changed, res.id]);
  const notices = await require('../src/alerts').retractionMonitor();
  const note = await db.one("SELECT title, body FROM notifications WHERE kind = 'retraction' AND data->>'checkId' = $1", [String(res.id)]).catch(() => null);
  check('1.5', 'Retraction monitoring: editor notified when a cited work in a saved report is retracted', notices >= 1 && note && /Retraction Watch/.test(note.body), `notices=${notices} ${JSON.stringify(note)}`);
  await db.query('UPDATE checks SET result = $1 WHERE id = $2', [saved.result, res.id]);

  // ================================================================ 1.6 link check
  const bl = row('brokenLink');
  const link = (bl.links || []).find(l => /example\.org/.test(l.url));
  check('1.6', 'Broken URL reported as broken', link && link.status === 'broken', JSON.stringify(bl.links));
  check('1.6', 'Broken link kept apart from the verdict (reference still Verified)', bl.status === 'verified', `${bl.status} ${bl.reason}`);
  check('1.6', 'Link summary counts', sum.links && sum.links.broken >= 1, JSON.stringify(sum.links));

  // ================================================================ 1.7 reference age
  check('1.7', 'References by year (chart data) and age bands', ind.age?.byYear?.[1983] >= 1 && sum.ages && Object.values(sum.ages).reduce((a, b) => a + b, 0) === rows.length, JSON.stringify({ byYear: ind.age?.byYear, ages: sum.ages }));
  check('1.7', '% from the last 5 and last 10 years', Number.isFinite(ind.age?.recentShare) && Number.isFinite(ind.age?.within10Share), JSON.stringify(ind.age));
  check('1.7', 'List of references older than 10 years', (ind.age?.olderThan10 || []).includes(1) && (ind.age?.olderThan10 || []).includes(order.indexOf('retracted') + 1), JSON.stringify(ind.age?.olderThan10));
  check('1.7', 'Warning when few recent references (PJPS rule)', (ind.flags || []).some(f => f.code === 'few-recent'), JSON.stringify(ind.flags));

  // ================================================================ 1.8 indicators
  check('1.8', 'Self-citation counted (author Tim Mosmann cited)', ind.selfCitation?.measured && ind.selfCitation.count >= 1, JSON.stringify(ind.selfCitation));
  check('1.8', 'PJPS citations counted separately', ind.homeJournal?.count >= 1 && ind.homeJournal.refs.includes(order.indexOf('pjps') + 1), JSON.stringify(ind.homeJournal));
  if (predRef) check('1.8', `Predatory journal flagged (${pred.name})`, (ind.riskyJournals || []).some(j => j.refs.includes(order.length + 1)), JSON.stringify(ind.riskyJournals));
  else check('1.8', 'Predatory journal list loaded', false, 'no journal in the predatory table');
  check('1.8', 'Duplicate reference found (Mosmann listed twice)', (ind.duplicates || []).some(d => JSON.stringify(d).includes('1') && JSON.stringify(d).includes(String(order.length))), JSON.stringify(ind.duplicates));

  // ================================================================ 1.9 output
  const counted = ['verified', 'miscited', 'unverified', 'suspicious', 'retracted', 'pending'].reduce((a, k) => a + (sum[k] || 0), 0);
  check('1.9', 'Summary counts per verdict add up to the number of references', counted === rows.length && sum.total === rows.length, JSON.stringify(sum));
  const exp = async (q, test, label) => { const x = await api.raw(`/api/checks/${res.id}/export?${q}`); check('1.9', label, x.status === 200 && test(x), `${x.status} ${x.type} ${x.buffer.slice(0, 120).toString()}`); return x; };
  await exp('format=csv', x => /Status/.test(x.buffer.toString()) && x.buffer.toString().split('\n').length > rows.length, 'Export CSV');
  await exp('format=bibtex', x => (x.buffer.toString().match(/@\w+\{/g) || []).length === rows.length, 'Export BibTeX (one entry per reference)');
  await exp('format=ris', x => (x.buffer.toString().match(/^TY {2}- /gm) || []).length === rows.length, 'Export RIS (one entry per reference)');
  await exp('format=docx', x => x.buffer.slice(0, 2).toString() === 'PK' && x.buffer.length > 5000, 'Export Word report');
  await exp('format=pdf', x => x.buffer.slice(0, 4).toString() === '%PDF', 'Export PDF report');
  await exp('format=corrected', x => /Nat\.? Methods, 9\(7\): 671-675/.test(x.buffer.toString()), 'Export corrected reference list (PJPS)');
  await exp('format=corrected&style=apa', x => /Nature Methods, 9\(7\), 671[–-]675/.test(x.buffer.toString()), 'Corrected reference list in another style (APA)');
  const fm = await api.json('GET', `/api/checks/${res.id}/formatted?style=vancouver`);
  check('1.9', 'Corrected references in any chosen style (Vancouver)', fm.status === 200 && (fm.data.items || []).length === rows.length && /2012;9\(7\):671/.test(fm.data.items[order.indexOf('wrongVol')]?.text || ''), JSON.stringify(fm.data.items?.[1]));
  // re-check: only what changed since the last run
  s = await api.json('POST', `/api/checks/${res.id}/recheck`, {});
  job = await api.job(s.data.jobId, 900);
  const ch = job.result?.changes;
  check('1.9', 'Re-check runs and lists only what changed', job.status === 'done' && ch && Array.isArray(ch.rows) && ch.previousId === res.id && ch.rows.length <= 2, JSON.stringify(ch).slice(0, 300));

  const ok = results.filter(x => x.ok).length;
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`\nModule 1 features: ${ok}/${results.length} passed (${secs}s)`);
  fs.writeFileSync(path.join(OUT, 'audit-m1-features.json'), JSON.stringify({ ok, total: results.length, secs, results }, null, 1));
  process.exit(ok === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
