// test/remediation.js - regression tests for the defects found in the platform audit (D1-D20) and for the features added
// afterwards (server PDF, footnote citations, .odt/.rtf input, statistics and primer checks, blot lanes, panel hashes).
// Offline: no database or network is needed. Run: node test/remediation.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const P = require('../src/parse');
const ST = require('../src/styles');
const { restyleList } = require('../src/tools/restyle');
const { checkCitations } = require('../src/checks/citation');
const { duplicates } = require('../src/checks/indicators');
const { scoreCandidate } = require('../src/checks/reference');
const { pjpsJournal } = require('../src/abbrev');
const { verdictOf } = require('../src/tools/match');
const DC = require('../src/papermill/dataChecks');
const { buildPdf } = require('../src/pdf');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

(async () => {
  // ---- D1: both crashes in the Module 5 result screen were plain script errors
  const view = fs.readFileSync(path.join(__dirname, '../public/js/views/images.js'), 'utf8');
  ok(/let catFilter\s*=/.test(view), 'D1: catFilter declared');
  ok(!/(?<!\$)\$\('\.tab', el\)\.forEach/.test(view), 'D1: tabs wired with $$ (a single element has no forEach)');

  // ---- D2: an unparseable entry no longer crashes the converter; it is kept and flagged
  const r2 = await restyleList('1. Khan A, Ali B (2019). Antibacterial plants. Pak J Pharm Sci, 32(1): 1-5.\n2. World Health Organization. Guidelines on good manufacturing practice. https://www.who.int/x\n3. Nature-style entry that cannot be read at all', 'pjps', { lookup: false });
  ok(r2.entries.length === 3, 'D2: three entries come back');
  ok(r2.entries.some(e => e.status === 'kept'), 'D2: unparseable entry kept and flagged');
  ok(ST.orderBibliography([{ record: null, ref: {} }, { record: { authors: [{ family: 'Zed' }], year: 2000, title: 't' } }], 'apa').length === 2, 'D2: orderBibliography tolerates a null record');

  // ---- D5: no author lost in a Chicago entry; D8: journal abbreviated like the checker expects
  const chi = P.parseReferenceEntry('Khan, A., B. Ali, and C. Shah. 2019. "Antibacterial Activity of Medicinal Plants." Pakistan Journal of Pharmaceutical Sciences 32 (1): 1–5.', 1);
  eq(chi.authors.length, 3, 'D5: three authors read from a Chicago entry');
  const nat = P.parseReferenceEntry('Khan, A., Ali, B. & Shah, C. Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci. 32, 1–5 (2019).', 1);
  ok(nat.authors.length === 3 && nat.volume === '32' && nat.year === 2019 && /Antibacterial/.test(nat.title), 'D2/D5: Nature-style entry parsed');
  eq(pjpsJournal('Pakistan Journal of Pharmaceutical Sciences'), 'Pak. J. Pharm. Sci.', 'D8: full name abbreviated');
  eq(pjpsJournal('Pak J Pharm Sci'), 'Pak. J. Pharm. Sci.', 'D8: dot-less abbreviation gets its dots');
  const apa = await restyleList('Khan, A., Ali, B., & Shah, C. (2019). Antibacterial activity of medicinal plants. Pakistan Journal of Pharmaceutical Sciences, 32(1), 1–5.', 'pjps', { lookup: false });
  eq(apa.entries[0].text.replace(/^\d+\.\s*/, ''), 'Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', 'D8: APA converts to the exact PJPS text');
  const van = await restyleList('1. Khan A, Ali B, Shah C. Antibacterial activity of medicinal plants. Pak J Pharm Sci. 2019;32(1):1-5.', 'pjps', { lookup: false });
  ok(/Pak\. J\. Pharm\. Sci\./.test(van.entries[0].text), 'D8: Vancouver converts with dotted abbreviation');

  // ---- D6: article-number locators; D7: title with an inner full stop
  const moher = P.parseReferenceEntry('Moher D, Liberati A, Tetzlaff J, Altman DG. Preferred reporting items for systematic reviews and meta-analyses: the PRISMA statement. PLoS Med. 2009;6(7):e1000097.', 1);
  eq(moher.pages, 'e1000097', 'D6: e-locator kept whole');
  const page = P.parseReferenceEntry('Page MJ, McKenzie JE, Bossuyt PM, et al. The PRISMA 2020 statement. BMJ 2021, 372: n71.', 1);
  ok(page.volume === '372' && page.pages === 'n71', 'D6: "372: n71" read');
  const hig = P.parseReferenceEntry('Higuchi T. Mechanism of sustained-action medication. Theoretical analysis of rate of release of solid drugs dispersed in solid matrices. J Pharm Sci. 1963;52(12):1145-1149.', 1);
  const sc = scoreCandidate(hig, { title: 'Mechanism of sustained-action medication. Theoretical analysis of rate of release of solid drugs dispersed in solid matrices', authors: [{ family: 'Higuchi', given: 'T' }], year: 1963, journal: 'Journal of Pharmaceutical Sciences' });
  ok(sc.journalScore >= 0.8 && sc.tSim >= 0.9, 'D7: split title re-joined, journal not blamed');

  // ---- D10: invented words in a real title lower the match
  const inv = P.parseReferenceEntry('Khan A (2019). Curcumin and health in rats showing remarkable reversal of cognitive blue decline. Pak J Pharm Sci, 32(1): 1-5.', 1);
  ok(scoreCandidate(inv, { title: 'Curcumin and health', authors: [{ family: 'Khan', given: 'A' }], year: 2019, journal: 'Pak J Pharm Sci' }).tSim < 0.85, 'D10: extra words lower the title match');

  // ---- D13: footnote citations; D18: author spelling; paragraph numbers
  const docx = require('docx');
  const doc = new docx.Document({ footnotes: { 1: { children: [new docx.Paragraph('See also (Malik, 2022) for details.')] } }, sections: [{ children: [
    new docx.Paragraph({ children: [new docx.TextRun('Curcumin is beneficial (Hewlings et al., 2017) as reviewed.'), new docx.FootnoteReferenceRun(1)] }),
    new docx.Paragraph('References'), new docx.Paragraph('Hewlings SJ, Kalman DS (2017). Curcumin. Foods, 6(10): 92.')] }] });
  const text = (await P.extractDocument(await docx.Packer.toBuffer(doc), 'a.docx', '')).text;
  ok(/Footnote: See also \(Malik, 2022\)/.test(text), 'D13: footnote text placed at its call');
  ok(!/\n\s*See also \(Malik/.test(text.split('References')[1] || ''), 'D13: footnote text is not left among the references');
  const body = 'Intro text about drugs. '.repeat(10) + '\nCurcumin was studied (Siddique, 2019) in rats and also (Zahid, 2018).\n' + 'More. '.repeat(30);
  const refs = ['Siddiqui A, Khan B (2019). Curcumin in rats. Pak. J. Pharm. Sci., 32(1): 1-5.', 'Noor C (2020). Other. Pak. J. Pharm. Sci., 33(1): 1-5.'].map((x, i) => P.parseReferenceEntry(x, i + 1));
  const cc = checkCitations(body, refs);
  ok(cc.spelling.length === 1 && /Siddiqui/.test(cc.spelling[0].message), 'D18: misspelt author reported as spelling');
  ok(cc.missing.length === 1 && cc.missing[0].para === 3, 'D4/3.A: location given as a paragraph number');

  // ---- D3: a claim whose source is not available still returns notes
  ok(Array.isArray(verdictOf(null, { fullText: false }).notes), 'D3: verdict always has notes');

  // ---- D19: duplicates grouped by work
  const mk = i => ({ index: i, record: null, parsed: { doi: '10.1000/abc', title: 'Same title of the work here 12345', year: 2019 } });
  eq(duplicates([mk(1), mk(2), mk(3)]).length, 1, 'D19: three copies are one group');

  // ---- D17: an initials-first reference starts a new entry
  const split = P.splitReferences('Smith J, Lee K (2019). A study. Pak J Pharm Sci, 3(2).\nA. Khan, B. Ali (2018). Another study with a long title here. J Pharm, 2(1): 1-5.');
  eq(split.entries.length, 2, 'D17: initials-first reference not merged');

  // ---- input formats .rtf and .odt, readable PDF error
  const rtf = await P.extractDocument(Buffer.from('{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello\\par Second line (Khan, 2019).\\par}'), 'a.rtf', '');
  ok(/Hello\nSecond line \(Khan, 2019\)\./.test(rtf.text), 'S2: RTF text extracted');
  const JSZip = require('jszip');
  const z = new JSZip();
  z.file('content.xml', '<office:document-content><text:p>Hello &amp; welcome</text:p><text:p>Line 2</text:p></office:document-content>');
  eq((await P.extractDocument(await z.generateAsync({ type: 'nodebuffer' }), 'a.odt', '')).text.trim(), 'Hello & welcome\nLine 2', 'S2: ODT text extracted');
  await assert.rejects(() => P.extractDocument(Buffer.from('not a pdf'), 'a.pdf', ''), /could not be read/); n++;

  // ---- S5: server PDF
  const pdf = await buildPdf([{ h1: 'Test report' }, { p: 'Paragraph with “quotes” – and a dash.' }, { bullets: ['one', 'two'] }, { kv: [['Key', 'Value']] },
    { table: { headers: ['#', 'Finding'], rows: Array.from({ length: 80 }, (_, i) => [String(i + 1), 'Row text that wraps over the column width '.repeat(3)]) } }]);
  ok(pdf.slice(0, 5).toString() === '%PDF-' && pdf.length > 3000, 'S5: a real PDF is produced (multi-page table)');

  // ---- Module 4 phase 3: statistics and primers
  const stats = DC.statisticsCheck('The groups differed (t(28) = 2.05, p = .03). Another test F(2, 27) = 3.50, p < .001. Also 12 of 30 (45%) improved. And chi-square χ2(1) = 4.20, p = .04.');
  ok(stats.findings.some(f => /F\(2, 27\)/.test(f.reported) && f.gross), 'M4: wrong p-value that changes the conclusion found');
  ok(stats.findings.some(f => f.kind === 'percentage'), 'M4: percentage that does not follow from the counts found');
  ok(!stats.findings.some(f => /χ2/.test(f.reported)), 'M4: a correct statistic is not flagged');
  ok(Math.abs(DC.pT(2.05, 28) - 0.0498) < 0.001 && Math.abs(DC.pChi(3.84, 1) - 0.05) < 0.001, 'M4: p-value maths correct');
  const pr = DC.findPrimers("GAPDH F: 5'-GGAGCGAGATCCCTCCAAAAT-3' R: 5'-GGCTGTTGTCATACTTCTCATGG-3'. IL-6 Forward 5'-ACTCACCTCTTCAGAACGAATTG-3', Reverse 5'-ACTCACCTCTTCAGAACGAATTG-3'");
  ok(pr.length === 4 && pr[3].gene === 'IL-6', 'M4: primers and their genes read');
  ok(DC.primerSanity(pr).some(i => /identical/.test(i.message)), 'M4: forward = reverse primer found');
  const spread = DC.affiliationSpread(['Department of Pharmacy, University of Lahore, Pakistan', 'Chongqing University, China', 'University of Cairo, Egypt'], 3);
  ok(spread.far && spread.countries.length === 3, 'M4: institutions in three countries flagged');

  // ---- Module 5: engine (Node)
  const E = await import('../public/js/images/engine.js');
  const { laneFindings, findLanes } = await import('../public/js/images/lanes.js');
  let seed = 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return (s - 3) / 0.7; };
  const blot = (W, H, nL, from, to) => {
    const laneW = Math.floor(W / nL), data = new Uint8ClampedArray(W * H * 4);
    const bands = Array.from({ length: nL }, () => Array.from({ length: 3 }, () => ({ y: 10 + rnd() * (H - 20), a: 40 + rnd() * 150, s: 3 + rnd() * 4 })));
    const noise = Array.from({ length: nL }, () => Array.from({ length: laneW * H }, () => gauss() * 4));
    if (from !== null) { bands[to] = bands[from]; noise[to] = noise[from]; }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const l = Math.min(nL - 1, Math.floor(x / laneW)), lx = x - l * laneW, inLane = lx > 3 && lx < laneW - 3;
      let v = 235;
      if (inLane) for (const b of bands[l]) v -= b.a * Math.exp(-((y - b.y) ** 2) / (2 * b.s * b.s)) * (0.6 + 0.4 * Math.sin(Math.PI * (lx - 3) / (laneW - 6)));
      v += inLane ? noise[l][y * laneW + lx] : gauss() * 0.5;
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v)); data[i + 3] = 255;
    }
    return { width: W, height: H, data };
  };
  const prep = img => E.preparePanel(img, { x: 0, y: 0, w: img.width, h: img.height }, { id: 'p1', label: 'Fig. 1', imageId: 'i1', index: 1 }, E.toGray(img));
  const dupBlot = prep(blot(480, 70, 10, 2, 6));
  ok(findLanes(dupBlot).length === 10, '5.5: ten lanes found');
  ok(laneFindings([dupBlot]).some(f => /lane 3 looks identical to lane 7/.test(f.description)), '5.5: copied lane found');
  eq(laneFindings([prep(blot(480, 70, 10, null, null))]).length, 0, '5.5: no false alarm on a clean blot');
  const hp = E.hashPanel(blot(200, 150, 5, null, null), { x: 0, y: 0, w: 200, h: 150 });
  ok(hp.hashes.length === 8 && hp.hashes.every(h => /^[0-9a-f]{16}$/.test(h)), '5.6: panel fingerprint has 8 orientations');
  // thin strips now have keypoints; a strip copied with a small shift is found by dense registration
  const strip = blot(700, 72, 7, null, null);
  const copy = { width: 700, height: 72, data: new Uint8ClampedArray(strip.data) };
  const A = prep(strip), B = prep(copy);
  ok(E.findIssues([A, B]).some(f => f.kind === 'duplicate'), '5.2: identical thin strips found');

  console.log(`remediation tests passed (${n} checks)`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
