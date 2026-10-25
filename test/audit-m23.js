// test/audit-m23.js - Module 2 (compliance + converter) and Module 3 (citations) accuracy audit with planted ground truth.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, FootnoteReferenceRun, WidthType } = require('docx');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname;
const R = { m2: {}, m3: {} };
const note = (k, v) => console.log(k.padEnd(34), typeof v === 'string' ? v : JSON.stringify(v));

async function docxFrom(paras, { table, footnote } = {}) {
  const children = [];
  for (const p of paras) {
    if (p.h) children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(p.h)] }));
    else children.push(new Paragraph({ children: [new TextRun({ text: p.t, font: 'Times New Roman', size: 24 }), ...(p.fn ? [new FootnoteReferenceRun(1)] : [])] }));
  }
  if (table) children.splice(2, 0, new Table({ width: { size: 9000, type: WidthType.DXA }, rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph(table)] })] })] }));
  const doc = new Document({ footnotes: footnote ? { 1: { children: [new Paragraph(footnote)] } } : undefined, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

(async () => {
  const api = await boot();

  // =========================================================== MODULE 2.1 compliance (rule by rule)
  const compCases = [
    // [raw, expectedRules(set that MUST fire), mustBeCompliant]
    ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', [], true],
    ['Ali B and Khan A (2018). Effect of curcumin on wound healing in rats. Pak. J. Pharm. Sci., 31(2): 455-460.', [], true],
    ['Khan, A., Ali, B. & Shah, C. (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', ['authors'], false],
    ['Khan A, Ali B and Shah C (2019). Antibacterial Activity Of Medicinal Plants In Northern Areas. Pak. J. Pharm. Sci., 32(1): 1-5.', ['title'], false],
    ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pakistan Journal of Pharmaceutical Sciences, 32(1): 1-5.', ['journal'], false],
    ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): pp. 1-5.', ['pages'], false],
    ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., Vol. 32, No. 1, 1-5.', ['volume'], false],
    ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1–5.', ['pages'], false],
    ['Khan A, Ali B and Shah C. Antibacterial activity of medicinal plants. Pak J Pharm Sci. 2019;32(1):1-5.', ['year'], false],
    ['Khan A, Ali B, Shah C, Malik D, Raza E, Noor F, Butt G and Iqbal H (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', ['authors'], false],
    ['Khan A et al. (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', ['authors'], false],
    ['A. Khan, B. Ali and C. Shah (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.', ['authors'], false],
    ['Khan MA, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5. doi:10.1234/abc.2019.1', [], true], // DOI link is "info" only
    ['Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci.', ['missing'], false]
  ];
  const fd = new FormData();
  fd.append('text', compCases.map(c => c[0]).join('\n'));
  fd.append('style', 'pjps'); fd.append('lookup', 'false'); fd.append('save', 'false');
  let resp = await fetch(api.base + '/api/restyle', { method: 'POST', body: fd, headers: { Cookie: (await cookieOf(api)) } });
  let sj = await resp.json();
  let job = await api.job(sj.jobId);
  const comp = job.result.compliance;
  let hit = 0, tot = 0, fp = 0, fn = 0; const m2rows = [];
  compCases.forEach((c, i) => {
    const e = comp.entries[i]; const rules = new Set(e.deviations.filter(d => d.severity !== 'info' && !['order','suffix'].includes(d.rule)).map(d => d.rule)); e.compliant = rules.size === 0;
    const needOK = c[1].every(r => rules.has(r)); const compOK = c[2] ? e.compliant : !e.compliant;
    tot++; if (needOK && compOK) hit++;
    if (c[2] && !e.compliant) fp++; if (!c[2] && e.compliant) fn++;
    m2rows.push({ n: i + 1, expect: c[1].join(',') || 'compliant', got: [...rules].join(',') || 'compliant', pass: needOK && compOK });
  });
  m2rows.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'} M2.1 #${r.n} expect=${r.expect} got=${r.got}`));
  note('M2.1 compliance accuracy', `${hit}/${tot}  falseAlarms(compliant flagged)=${fp} missed(non-compliant passed)=${fn}  score=${comp.summary.score}%`);
  R.m2.compliance = { hit, tot, fp, fn, rows: m2rows, byRule: comp.summary.byRule };

  // list order + a/b suffix
  const ord = 'Zahid A (2019). Title of the study one is here. Pak. J. Pharm. Sci., 32(1): 1-5.\nAli B (2018). Title of the study two is here. Pak. J. Pharm. Sci., 31(2): 1-5.\nKhan A (2019). Title of the study three is here. Pak. J. Pharm. Sci., 32(3): 1-5.\nKhan A (2019). Title of the study four is here. Pak. J. Pharm. Sci., 32(4): 1-5.';
  const fd2 = new FormData(); fd2.append('text', ord); fd2.append('style', 'pjps'); fd2.append('lookup', 'false'); fd2.append('save', 'false');
  resp = await fetch(api.base + '/api/restyle', { method: 'POST', body: fd2, headers: { Cookie: (await cookieOf(api)) } });
  job = await api.job((await resp.json()).jobId);
  const li = job.result.compliance.listIssues.map(x => x.rule);
  note('M2.1 order+suffix rules', li);
  R.m2.listRules = { order: li.includes('order'), suffix: li.includes('suffix') };

  // in-text format
  const body = 'Plants are used widely (Khan 2019). Others agree (Khan & Ali, 2019). Also (Khan et al 2019) and (Ali, 2018, Khan, 2019). Good example (Khan et al., 2019). Misuse (Ali et al., 2018) and (Zahid, 2019).';
  const refsT = 'Khan A, Ali B and Shah C (2019). Title one is here for test. Pak. J. Pharm. Sci., 32(1): 1-5.\nAli B and Khan A (2018). Title two is here for test. Pak. J. Pharm. Sci., 31(2): 1-5.\nZahid A, Noor B and Raza C (2019). Title three is here for test. Pak. J. Pharm. Sci., 32(3): 1-5.';
  const comp2 = require('../src/checks/compliance');
  const P = require('../src/parse');
  const refsP = P.splitReferences(refsT).entries.map((e, i) => P.parseReferenceEntry(e, i + 1));
  const it = comp2.inTextRules(body + ' '.repeat(60), refsP).issues.map(x => x.message);
  it.forEach(m => console.log('  in-text:', m));
  const wantIn = [/Comma between author and year/, /Use “and”/, /et al\.,/, /semicolons|Separate several/, /has 2 author/, /has 3 authors/];
  const inHit = wantIn.filter(rx => it.some(m => rx.test(m))).length;
  note('M2.1 in-text rules found', `${inHit}/${wantIn.length}`);
  R.m2.inText = { found: inHit, of: wantIn.length, messages: it };

  // =========================================================== MODULE 2.2 converter
  // (a) source styles -> PJPS, no lookup (deterministic). Expected PJPS text for the same work.
  const EXP = 'Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.';
  const styles = {
    apa: 'Khan, A., Ali, B., & Shah, C. (2019). Antibacterial activity of medicinal plants. Pakistan Journal of Pharmaceutical Sciences, 32(1), 1–5.',
    vancouver: '1. Khan A, Ali B, Shah C. Antibacterial activity of medicinal plants. Pak J Pharm Sci. 2019;32(1):1-5.',
    harvard: 'Khan, A., Ali, B. and Shah, C. (2019) Antibacterial activity of medicinal plants. Pakistan Journal of Pharmaceutical Sciences, 32(1), pp. 1-5.',
    ieee: '[1] A. Khan, B. Ali, and C. Shah, "Antibacterial activity of medicinal plants," Pak. J. Pharm. Sci., vol. 32, no. 1, pp. 1-5, 2019.',
    ama: '1. Khan A, Ali B, Shah C. Antibacterial activity of medicinal plants. Pak J Pharm Sci. 2019;32(1):1-5.',
    chicago: 'Khan, A., B. Ali, and C. Shah. 2019. "Antibacterial Activity of Medicinal Plants." Pakistan Journal of Pharmaceutical Sciences 32 (1): 1–5.',
    nature: 'Khan, A., Ali, B. & Shah, C. Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci. 32, 1–5 (2019).'
  };
  const conv = {};
  for (const [name, txt] of Object.entries(styles)) {
    const f = new FormData(); f.append('text', txt); f.append('style', 'pjps'); f.append('lookup', 'false'); f.append('save', 'false');
    const r = await fetch(api.base + '/api/restyle', { method: 'POST', body: f, headers: { Cookie: (await cookieOf(api)) } });
    const j = await api.job((await r.json()).jobId);
    if (j.status !== 'done') { conv[name] = { exact: false, crash: j.error }; console.log('CRASH M2.2 ' + name + ' -> ' + j.error); continue; }
    const out = j.result.entries[0].text.replace(/^\d+\.\s*/, '');
    const norm = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const exact = norm(out) === norm(EXP);
    conv[name] = { exact, out: norm(out) };
    console.log(`${exact ? 'PASS' : 'DIFF'} M2.2 ${name.padEnd(10)} -> ${norm(out)}`);
  }
  R.m2.converterStyles = conv;

  // (b) Word manuscript, numbered -> PJPS with track changes
  const refsNum = [
    '1. Zahid A, Noor B and Raza C (2019). Study of drug release kinetics in matrix tablets. Pak. J. Pharm. Sci., 32(3): 11-19.',
    '2. Ali B and Khan A (2018). Effect of curcumin on wound healing in rats. Pak. J. Pharm. Sci., 31(2): 455-460.',
    '3. Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.'
  ];
  const bodyNum = [
    { h: 'Introduction' },
    { t: 'Drug release from matrices is well described [1]. Curcumin heals wounds [2] and plant extracts are antibacterial [3]. Both findings agree [2,3].' },
    { t: 'The unchanged sentence stays exactly as written by the author.' },
    { h: 'References' }, ...refsNum.map(t => ({ t }))
  ];
  const buf = await docxFrom(bodyNum);
  for (const track of [false, true]) {
    const f = new FormData(); f.append('file', new Blob([buf]), 'ms.docx'); f.append('style', 'pjps'); f.append('lookup', 'false'); f.append('save', 'false'); f.append('track', String(track));
    const r = await fetch(api.base + '/api/restyle', { method: 'POST', body: f, headers: { Cookie: (await cookieOf(api)) } });
    const jid = (await r.json()).jobId; const j = await api.job(jid);
    if (j.status !== 'done') { note('M2.2 docx job', j); continue; }
    const file = await api.raw(`/api/jobs/${jid}/file`);
    const zip = await JSZip.loadAsync(file.buffer); const xml = await zip.file('word/document.xml').async('string');
    const plain = xml.replace(/<w:delText[^>]*>[^<]*<\/w:delText>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const chk = { status: file.status, ins: (xml.match(/<w:ins /g) || []).length, del: (xml.match(/<w:del /g) || []).length, bracketLeft: (plain.match(/\[\d+(?:[,-]\d+)*\]/g) || []).length, unchangedSentence: plain.includes('The unchanged sentence stays exactly as written by the author.'), authorYear: (plain.match(/\([A-Z][a-z]+[^)]*\d{4}\)/g) || []), refOrder: ['Ali B and Khan','Khan A, Ali B','Zahid A'].map(k => plain.indexOf(k)) };
    note('M2.2 docx check track=' + track, chk); R.m2['docx_check_' + track] = chk;
    R.m2['docx_track_' + track] = { citationsConverted: j.result.citationsConverted, counts: j.result.counts, fileName: j.result.file?.name };
    note(`M2.2 docx track=${track}`, { citationsConverted: j.result.citationsConverted, counts: j.result.counts, file: j.result.file });
    R.__lastJob = R.__lastJob || {}; R.__lastJob[track] = j;
  }

  // =========================================================== MODULE 3 citations
  const refsM3 = [
    'Ali B and Khan A (2020a). First study of herbal extract activity in mice. Pak. J. Pharm. Sci., 33(1): 11-19.',
    'Ali B, Noor C and Raza D (2020b). Second study of herbal extract activity in rats. Pak. J. Pharm. Sci., 33(2): 21-29.',
    'Hewlings SJ and Kalman DS (2017). Curcumin: a review of its effects on human health. Foods, 6(10): 92.',
    'Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.',
    'Siddiqui A (2019). Analgesic effect of a herbal preparation in mice. J. Ethnopharmacol., 12: 1-9.',
    'Uncited N (2015). A reference that is never cited in the manuscript text. Pak. J. Pharm. Sci., 28(1): 1-9.'
  ];
  const m3body = [
    { h: 'Introduction' },
    { t: 'Plants are antibacterial (Khan et al., 2019). The same was reported again (Khan, 2018) with a different year.' },
    { t: 'Analgesia was shown earlier (Siddique, 2019). Herbal activity is known (Ali, 2020) in several models.' },
    { t: 'Curcumin is beneficial (Hewlings et al., 2017) as reviewed. Another study (Zubair, 2020) found more, with a footnote.', fn: true },
    { h: 'Results' },
    { t: 'Dose response was linear in all groups tested during the experiment and no deaths were recorded in any animal group during the full period of observation reported here.' },
    { h: 'References' }, ...refsM3.map(t => ({ t }))
  ];
  const buf3 = await docxFrom(m3body, { table: 'Table 1. Summary of studies (Noor, 2021)', footnote: 'See also (Malik, 2022) for details.' });
  const f3 = new FormData(); f3.append('manuscript', new Blob([buf3]), 'm3.docx'); f3.append('claims', 'false'); f3.append('save', 'false');
  const r3 = await fetch(api.base + '/api/citations', { method: 'POST', body: f3, headers: { Cookie: (await cookieOf(api)) } });
  const j3 = await api.job((await r3.json()).jobId);
  if (j3.status !== 'done') { console.error('M3 failed', j3); } else {
    const c = j3.result.consistency;
    const miss = (c.missing || []).map(m => m.citation || m.text || JSON.stringify(m));
    note('M3.A missing', miss); note('M3.A uncited', (c.uncited || []).map(u => (u.raw || u.reference || JSON.stringify(u)).slice(0, 40)));
    note('M3.A summary', c.summary);
    note('M3.A yearMismatch', c.yearMismatch || c.year); note('M3.A ambiguous', c.ambiguous); note('M3.A etAl', c.etAlIssues || c.etAl); note('M3.A keys', Object.keys(c));
    R.m3.consistency = { summary: c.summary, missing: miss, keys: Object.keys(c), raw: JSON.parse(JSON.stringify(c)) };
    R.m3.pattern = j3.result.pattern?.flags?.map(f => f.code);
    R.m3.summary = j3.result.summary;
  }

  // numbered gaps
  const numBody = 'Alpha result [1]. Beta result [2]. Gamma result [4]. Delta result [9]. ' + 'Filler text for the body of the manuscript goes here and goes on. '.repeat(6);
  const numRefs = ['1. A One (2010). Title number one for numbering. J. Test, 1: 1-2.', '2. B Two (2011). Title number two for numbering. J. Test, 2: 1-2.', '3. C Three (2012). Title number three for numbering. J. Test, 3: 1-2.', '4. D Four (2013). Title number four for numbering. J. Test, 4: 1-2.', '5. E Five (2014). Title number five for numbering. J. Test, 5: 1-2.'];
  const f4 = new FormData(); f4.append('text', numBody + '\n\nReferences\n' + numRefs.join('\n')); f4.append('claims', 'false'); f4.append('save', 'false');
  const r4 = await fetch(api.base + '/api/citations', { method: 'POST', body: f4, headers: { Cookie: (await cookieOf(api)) } });
  const j4 = await api.job((await r4.json()).jobId);
  note('M3.A numbered status', j4.status);
  if (j4.status === 'done') { const c = j4.result.consistency; note('M3.A numbered', { summary: c.summary, numbering: c.numbering, missing: (c.missing || []).map(m => m.citation), uncited: (c.uncited || []).length }); R.m3.numbered = JSON.parse(JSON.stringify({ summary: c.summary, numbering: c.numbering, missing: c.missing })); }

  fs.writeFileSync(path.join(OUT, 'audit-m23.json'), JSON.stringify(R, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

async function cookieOf(api) { // login again to obtain the cookie for raw fetch
  if (cookieOf.c) return cookieOf.c;
  const r = await fetch(api.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'admin-pass-123' }) });
  return (cookieOf.c = r.headers.get('set-cookie').split(';')[0]);
}
async function lastJobId() { return null; }
