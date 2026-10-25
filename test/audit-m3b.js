// test/audit-m3b.js - Module 3.B claim <-> source verification, 3.C pattern flags and citation blocks, with ground truth.
// Source PDFs are generated here with known content so the correct verdict of every claim is known in advance.
const fs = require('fs');
const path = require('path');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname;

/** Minimal valid one-page-per-text PDF generator (Helvetica) */
function makePdf(pages) {
  const objs = []; const add = s => { objs.push(s); return objs.length; };
  const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = []; const contentIds = [];
  const pagesObjId = objs.length + 1 + pages.length * 2; // reserved after page+content objects
  for (const lines of pages) {
    let y = 760; let c = 'BT /F1 11 Tf 40 ' + y + ' Td 14 TL\n';
    for (const l of lines) c += '(' + esc(l) + ') Tj T*\n';
    c += 'ET';
    const cid = add('<< /Length ' + c.length + ' >>\nstream\n' + c + '\nendstream');
    const pid = add('<< /Type /Page /Parent ' + pagesObjId + ' 0 R /MediaBox [0 0 612 792] /Contents ' + cid + ' 0 R /Resources << /Font << /F1 ' + font + ' 0 R >> >> >>');
    contentIds.push(cid); pageIds.push(pid);
  }
  const pagesId = add('<< /Type /Pages /Kids [' + pageIds.map(i => i + ' 0 R').join(' ') + '] /Count ' + pageIds.length + ' >>');
  if (pagesId !== pagesObjId) throw new Error('pdf object numbering');
  const cat = add('<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');
  let out = '%PDF-1.4\n%' + 'x'.repeat(9000) + '\n'; const offs = []; // padded: Node pools Buffers < 4 KB, which the old pdf.js mis-reads
  objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + cat + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Buffer.from(out, 'latin1');
}

const wrapLines = (t, n = 85) => { const w = t.split(' '); const out = []; let l = ''; for (const x of w) { if ((l + ' ' + x).length > n) { out.push(l); l = x; } else l += (l ? ' ' : '') + x; } if (l) out.push(l); return out; };

(async () => {
  const api = await boot();
  const khanPdf = makePdf([
    ['Antibacterial activity of medicinal plants', 'Khan A, Ali B, Shah C. Pak. J. Pharm. Sci. 2019', 'Page 1 - Abstract'].concat(wrapLines('Aqueous extract of Nigella sativa seeds showed antibacterial activity against Staphylococcus aureus with a minimum inhibitory concentration of 12.5 mg/mL.')),
    ['Page 2 - Results'].concat(wrapLines('The extract was tested in vitro only. No activity was observed against Escherichia coli or Pseudomonas aeruginosa at concentrations up to 50 mg/mL. Cytotoxicity was not evaluated in this study.'))
  ]);
  const aliPdf = makePdf([['Effect of curcumin on wound healing in rats', 'Ali B, Khan A. 2018'].concat(wrapLines('Topical curcumin ointment at 2 percent accelerated wound closure in Wistar rats, reducing the healing time from 18 days to 12 days compared with the untreated control group.'))]);

  const claims = [
    // [sentence with citation, expected verdict class]
    ['Nigella sativa seed extract inhibits the growth of Staphylococcus aureus (Khan et al., 2019).', 'full'],
    ['Nigella sativa extract was also active against Escherichia coli and Pseudomonas aeruginosa (Khan et al., 2019).', 'unsupported'],   // source says NO activity (contradiction)
    ['The extract lowered blood glucose by 40% in diabetic rats and protected the liver (Khan et al., 2019).', 'unsupported'],
    ['Topical curcumin ointment accelerated wound closure in rats (Ali and Khan, 2018).', 'full'],
    ['Curcumin ointment shortened healing time from 18 days to 5 days (Ali and Khan, 2018).', 'unsupported|partial'],               // wrong number
    ['The MMR vaccine causes autism in children (Wakefield et al., 1998).', 'retracted-flag'],
    ['Zorbitrex nanogels cure hepatonephric disease (Bashir et al., 2018).', 'could-not-verify|unsupported']                       // fabricated source
  ];
  const refs = [
    'Ali B and Khan A (2018). Effect of curcumin on wound healing in rats. Pak. J. Pharm. Sci., 31(2): 455-460.',
    'Bashir T, Qazi M and Yousaf H (2018). Zorbitrex nanogel therapy for hepatonephric disease in Sprague-Dawley rats. Pak. J. Pharm. Sci., 31(5): 2201-2209.',
    'Khan A, Ali B and Shah C (2019). Antibacterial activity of medicinal plants. Pak. J. Pharm. Sci., 32(1): 1-5.',
    'Wakefield AJ, Murch SH, Anthony A et al. (1998). Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet, 351(9103): 637-641.'
  ];
  if (process.env.NOFAKE) { claims.pop(); refs.splice(1, 1); }
  const body = 'Introduction\n' + claims.map(c => c[0]).join(' ') + ' ' + 'Further methodological description follows in the sections below. '.repeat(4) + '\n\nReferences\n' + refs.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const s = await api.form('/api/citations', { text: body, claims: 'true', save: 'false', title: 'Audit claims' },
    { sources: { name: 'Khan_2019_antibacterial.pdf', buffer: khanPdf } });
  console.log('start', s.status, JSON.stringify(s.data).slice(0, 200));
  // second source file added separately is not possible via helper (single key) -> test mapping with one file; the second source is left un-uploaded on purpose
  const j = await api.job(s.data.jobId, 900);
  console.log('job', j.status, j.error || '');
  const R = j.result; const rows = [];
  if (R?.claims?.claims) R.claims.claims.forEach((c, i) => {
    c.citations.forEach(ct => console.log(`claim ${i + 1} -> ${ct.verdict} (${ct.score}) ref${ct.refIndex}:${ct.refStatus} src=${ct.evidence?.level || 'none'} p${ct.evidence?.page || '-'} | ${c.claim.slice(0, 60)} | notes=${(ct.notes || []).join(' / ').slice(0, 100)}`));
    rows.push({ sentence: c.sentence.slice(0, 80), cits: c.citations.map(ct => ({ ref: ct.refIndex, verdict: ct.verdict, score: ct.score, refStatus: ct.refStatus, level: ct.evidence?.level, page: ct.evidence?.page, quote: (ct.evidence?.quote || '').slice(0, 100) })) });
  });
  console.log('claims error:', R?.claims?.error, '| keys', Object.keys(R?.claims||{}).join(',')); console.log('claims summary', JSON.stringify(R?.claims?.summary), 'files', JSON.stringify(R?.claims?.files));
  console.log('retractedEvidence', R?.summary?.retractedEvidence);

  // ---- 3.C pattern flags: self-citation, stacking, blocks
  const pb = 'Introduction\n' + 'Results are known [1-8]. Another finding [1,2,3,4,5,6,7,8,9,10,11,12]. ' + 'Padding sentence to extend the introduction of the manuscript text further. '.repeat(5) + '\n\nReferences\n' +
    Array.from({ length: 14 }, (_, i) => `${i + 1}. ${i < 10 ? 'Khan A' : 'Zed Q'}, Ali B and Noor C (${2010 + i}). Study ${i} of the herbal activity profile in rodents. ${i < 12 ? 'Pak. J. Pharm. Sci.' : 'Other J.'}, ${20 + i}(1): 1-9.`).join('\n');
  const f2 = await api.form('/api/citations', { text: pb, claims: 'false', save: 'false', authors: 'Ahmad Khan\nBilal Ali', title: 'Pattern test' });
  const j2 = await api.job(f2.data.jobId, 300);
  const R2 = j2.result;
  console.log('pattern flags', JSON.stringify((R2?.pattern?.flags || []).map(f => f.code + ':' + f.severity)), 'blocks', R2?.consistency?.summary?.blocks, 'selfRate', R2?.pattern?.summary?.selfCitationRate);
  console.log('pattern summary', JSON.stringify(R2?.pattern?.summary));

  // ---- author letter EN/UR + exports from a saved citations check
  const f3 = await api.form('/api/citations', { text: body, claims: 'false', save: 'true', title: 'Letter test', manuscriptCode: 'AUDIT-M3' }, {});
  const j3 = await api.job(f3.data.jobId, 300);
  const id = j3.result?.id;
  const out = { id };
  for (const [name, p] of [['letter_en', `/api/checks/${id}/letter?lang=en`], ['letter_ur', `/api/checks/${id}/letter?lang=ur`], ['letter_docx', `/api/checks/${id}/letter?format=docx&lang=en`], ['summary_docx', `/api/checks/${id}/summary?format=docx`], ['csv', `/api/checks/${id}/export?format=csv`], ['docx', `/api/checks/${id}/export?format=docx`]]) {
    const r = await api.raw(p); out[name] = { status: r.status, bytes: r.buffer.length, type: r.type };
    if (name.startsWith('letter_') && name !== 'letter_docx') { const d = JSON.parse(r.buffer.toString('utf8')); out[name].text = (d.letter?.text || '').slice(0, 300); }
  }
  console.log('exports', JSON.stringify(out));
  fs.writeFileSync(path.join(OUT, 'audit-m3b.json'), JSON.stringify({ rows, claimsSummary: R?.claims?.summary, files: R?.claims?.files, patternFlags: R2?.pattern?.flags, patternSummary: R2?.pattern?.summary, blocks: R2?.consistency?.summary?.blocks, exports: out }, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
