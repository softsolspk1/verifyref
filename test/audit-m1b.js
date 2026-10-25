// test/audit-m1b.js - Module 1 supplementary audit: regional journals, predatory/hijacked list, self-citation, garbled text,
// .bib/.ris import, multi-line references, retraction monitoring.
const fs = require('fs');
const path = require('path');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname;
const R = {};
const note = (k, v) => console.log(k.padEnd(30), typeof v === 'string' ? v : JSON.stringify(v));

(async () => {
  const api = await boot();
  const run = async (body) => { const s = await api.json('POST', '/api/checks', { save: true, ...body }); if (!s.data.jobId) return { status: 'error', error: JSON.stringify(s.data) }; return api.job(s.data.jobId, 600); };

  // ---- regional journals: real articles
  let j = await run({ kind: 'references', referencesText: [
    '1. Hussain M, Wasif M, Awan MS and Ghaloo SK (2020). Use of endoscope in teaching of otolaryngology residents about site and size of tympanic membrane perforation and its impact on degree of hearing loss in adult patients: A cross sectional study. J. Pak. Med. Assoc., 70(12B): S14-S17.',
    '2. Sheikh A and Sheikh L (2020). Response to comments on changing prevalence of gestational diabetes mellitus during pregnancy over more than a decade. J. Pak. Med. Assoc., 70(12A): 2296-2297.',
    '3. Ali Z, Khan R and Noor S (2019). Formulation, characterization and in vitro evaluation of antifungal activity of Nystatin microemulsion for topical application. Pak. J. Pharm. Sci., 32(4): 1671-1677.',
    '4. Bashir T, Qazi M and Yousaf H (2018). Zorbitrex-modulated hepatonephric clearance of quinolate in Sprague-Dawley models. Pak. J. Pharm. Sci., 31(5): 2201-2209.'
  ].join('\n') });
  R.regional = (j.result?.references?.results || []).map(r => ({ i: r.index, status: r.status, label: r.statusLabel, conf: r.confidence, notIndexed: r.notIndexed, reason: (r.reason || '').slice(0, 120) }));
  R.regional.forEach(r => console.log('regional', JSON.stringify(r)));

  // ---- predatory / hijacked journal: take names from the loaded Beall list
  const pl = await api.json('GET', '/api/admin/lists/predatory/entries?q=journal&limit=5');
  note('predatory list endpoint', { status: pl.status, keys: Object.keys(pl.data), n: (pl.data.entries || []).length });
  const dbm = require('../src/db');
  const pred = await dbm.all("SELECT kind, name FROM predatory WHERE kind = 'journal' AND length(name) > 12 ORDER BY id LIMIT 3");
  const hij = await dbm.all("SELECT kind, name, genuine_name FROM predatory WHERE kind = 'hijacked' ORDER BY id LIMIT 2").catch(() => []);
  note('db predatory sample', pred.map(p => p.name)); note('db hijacked sample', hij.map(p => p.name));
  const pj = pred[0]?.name || 'Unknown Journal';
  j = await run({ kind: 'references', referencesText: [
    `1. Khan A, Ali B and Shah C (2020). Efficacy of green tea extract on lipid profile in rabbits: a randomized study. ${pj}, 5(2): 11-18.`,
    '2. Hanahan D and Weinberg RA (2011). Hallmarks of cancer: the next generation. Cell, 144(5): 646-674.'
  ].join('\n') });
  R.predatory = { journal: pj, journals: j.result?.journals?.summary, risky: j.result?.indicators?.riskyJournals, flags: j.result?.indicators?.flags };
  note('predatory result', R.predatory);

  // ---- self-citation (manuscript authors vs reference authors) + PJPS self-citation
  const body = 'Introduction\n'.padEnd(10) + 'Curcumin heals wounds (Ali and Khan, 2018) and plants are antibacterial (Khan et al., 2019). ' + 'Additional filler text describing the aims and scope of the work in detail. '.repeat(6) + '\n\nReferences\n' +
    '1. Ali B and Khan A (2018). Effect of curcumin on wound healing in rats. Pak. J. Pharm. Sci., 31(2): 455-460.\n2. Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.\n3. Hanahan D and Weinberg RA (2011). Hallmarks of cancer: the next generation. Cell, 144(5): 646-674.\n4. Watson JD and Crick FHC (1953). Molecular structure of nucleic acids. Nature, 171: 737-738.';
  j = await run({ kind: 'manuscript', text: body, meta: { title: 'Self citation test of a manuscript', authors: ['Khan A', 'Ali B'], manuscriptCode: 'AUDIT-SELF' } });
  R.selfCite = { selfCitation: j.result?.indicators?.selfCitation, home: j.result?.indicators?.homeJournal, pattern: j.result?.pattern?.summary, status: j.status, err: j.error };
  note('self-citation', R.selfCite);

  // ---- garbled PDF text: hyphenation, broken lines, ligatures
  const garbled = 'References\n1. Hanahan D, Wein-\nberg RA (2011). Hallmarks of can-\ncer: the next generation. Cell,\n144(5): 646-674.\n2. LeCun Y, Bengio Y, Hinton G (2015). Deep learning. Nature, 521(7553):\n436–444.\n3. Livak KJ, Schmittgen TD (2001). Analysis of relative gene expression data using real-time quantitative PCR and the 2−ΔΔCT method. Methods, 25(4): 402–408.\n4. Mosmann T (1983). Rapid colorimetric assay for cellular growth and survival: application to proliferation and cytotoxicity assays. J Immunol Methods, 65: 55–63. ﬁrst ﬂow';
  const ex = await api.json('POST', '/api/parse', { text: garbled.replace(/^References\n/, '') });
  R.garbled = (ex.data.references || []).map(r => ({ i: r.index, authors: (r.authors || []).map(a => a.family).join(','), title: (r.title || '').slice(0, 60), year: r.year, journal: r.journal, vol: r.volume, pg: r.pages }));
  R.garbled.forEach(r => console.log('garbled', JSON.stringify(r)));

  // ---- BibTeX / RIS import
  const bib = '@article{lecun2015,\n  author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},\n  title = {Deep learning},\n  journal = {Nature},\n  year = {2015},\n  volume = {521},\n  number = {7553},\n  pages = {436--444},\n  doi = {10.1038/nature14539}\n}\n\n@article{hanahan2011,\n  author = {Hanahan, Douglas and Weinberg, Robert A.},\n  title = {Hallmarks of cancer: the next generation},\n  journal = {Cell},\n  year = {2011},\n  volume = {144},\n  pages = {646--674}\n}\n';
  const ris = 'TY  - JOUR\nAU  - Mosmann, T.\nTI  - Rapid colorimetric assay for cellular growth and survival\nJO  - Journal of Immunological Methods\nPY  - 1983\nVL  - 65\nSP  - 55\nEP  - 63\nER  - \n\nTY  - JOUR\nAU  - Livak, K.J.\nAU  - Schmittgen, T.D.\nTI  - Analysis of relative gene expression data using real-time quantitative PCR\nJO  - Methods\nPY  - 2001\nVL  - 25\nIS  - 4\nSP  - 402\nEP  - 408\nER  - \n';
  R.import = {};
  for (const [name, content] of [['refs.bib', bib], ['refs.ris', ris]]) {
    const r = await api.form('/api/extract', {}, { file: { name, buffer: Buffer.from(content) } });
    R.import[name] = { status: r.status, count: r.data.referenceCount, structured: (r.data.structured || []).map(s => (s.title || s.raw || '').slice(0, 50)) };
  }
  note('bib/ris import', R.import);

  // ---- docx / txt / rtf / odt / pdf intake formats
  const { sampleManuscript } = require('./fixtures');
  const dbuf = await sampleManuscript();
  R.formats = {};
  const txt = 'Sample manuscript\n\nIntroduction\nNigella sativa shows activity (Khan et al., 2021).\n\nReferences\nKhan MA, Siddiqui A and Smith JR (2021). Antioxidant activity of Nigella sativa seed extract. Pak J Pharm Sci, 34(2): 455-462.\nHewlings SJ and Kalman DS (2017). Curcumin: A review of its effects on human health. Foods, 6(10): 92.\n';
  const rtf = '{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Times New Roman;}}\\f0 Sample manuscript\\par Introduction\\par Nigella sativa shows activity (Khan et al., 2021).\\par References\\par Khan MA, Siddiqui A and Smith JR (2021). Antioxidant activity of Nigella sativa seed extract. Pak J Pharm Sci, 34(2): 455-462.\\par Hewlings SJ and Kalman DS (2017). Curcumin: A review of its effects on human health. Foods, 6(10): 92.\\par}';
  for (const [name, buf] of [['m.docx', dbuf], ['m.txt', Buffer.from(txt)], ['m.rtf', Buffer.from(rtf)], ['m.odt', Buffer.from('not a real odt')], ['m.doc', Buffer.from('not a real doc')], ['m.pdf', Buffer.from('%PDF-1.4 broken')]]) {
    const r = await api.form('/api/extract', {}, { file: { name, buffer: buf } });
    R.formats[name] = { status: r.status, refs: r.data.referenceCount, ok: r.data.success, msg: (r.data.message || '').slice(0, 90) };
  }
  note('format intake', R.formats);

  // ---- retraction monitoring / alerts
  const chk = await api.json('GET', '/api/checks'); const first = (chk.data.checks || [])[0];
  const fo = await api.json('GET', '/api/follows'); note('follows endpoint', { status: fo.status, keys: Object.keys(fo.data) });
  const al = await api.json('POST', '/api/admin/alerts/run', {}); note('alerts run', { status: al.status, data: al.data });
  R.alerts = { follows: fo.status, run: al.status, data: al.data };
  fs.writeFileSync(path.join(OUT, 'audit-m1b.json'), JSON.stringify(R, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
