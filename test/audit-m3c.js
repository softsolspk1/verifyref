// test/audit-m3c.js - Module 3.B with a real uploaded PDF (arXiv 1706.03762) and an open-access article fetched online.
const fs = require('fs');
const path = require('path');
const { boot } = require('./audit-lib');
const OUT = process.env.AUDIT_OUT || __dirname;
(async () => {
  const api = await boot();
  const pdf = fs.readFileSync(path.join(OUT, 'vaswani.pdf'));
  const claims = [
    ['The Transformer is based solely on attention mechanisms, dispensing with recurrence and convolutions entirely (Vaswani et al., 2017).', 'full'],
    ['The Transformer reached 28.4 BLEU on the WMT 2014 English-to-German translation task (Vaswani et al., 2017).', 'full'],
    ['The Transformer relies on recurrent neural networks as its core building block (Vaswani et al., 2017).', 'unsupported'],
    ['The Transformer reached 45.9 BLEU on WMT 2014 English-to-German and cured cancer in mice (Vaswani et al., 2017).', 'unsupported|partial'],
    ['Curcumin has anti-inflammatory and antioxidant properties in humans (Hewlings and Kalman, 2017).', 'full|partial'],
    ['Curcumin completely cures COVID-19 in all patients within three days (Hewlings and Kalman, 2017).', 'unsupported']
  ];
  const refs = [
    'Hewlings SJ and Kalman DS (2017). Curcumin: a review of its effects on human health. Foods, 6(10): 92.',
    'Vaswani A, Shazeer N, Parmar N, Uszkoreit J, Jones L and Gomez AN (2017). Attention is all you need. Adv. Neural Inf. Process. Syst., 30: 5998-6008.'
  ];
  const body = 'Introduction\n' + claims.map(c => c[0]).join(' ') + ' ' + 'Further methodological description follows in the sections below. '.repeat(4) + '\n\nReferences\n' + refs.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const s = await api.form('/api/citations', { text: body, claims: 'true', save: 'false', title: 'Audit claims real' }, { sources: { name: 'Vaswani_2017_attention.pdf', buffer: pdf } });
  const j = await api.job(s.data.jobId, 900);
  const R = j.result; const rows = [];
  console.log('job', j.status, j.error || '', 'claims error:', R?.claims?.error);
  (R?.claims?.claims || []).forEach((c, i) => c.citations.forEach(ct => {
    const exp = claims[i][1]; const pass = exp.split('|').includes(ct.verdict);
    rows.push({ n: i + 1, exp, got: ct.verdict, score: ct.score, level: ct.evidence?.level, page: ct.evidence?.page, pass });
    console.log(`${pass ? 'PASS' : 'FAIL'} claim ${i + 1} exp=${exp} got=${ct.verdict} score=${ct.score} src=${ct.evidence?.level || 'none'} page=${ct.evidence?.page || '-'} | ${(ct.evidence?.quote || '').slice(0, 90)} | ${(ct.notes || []).join(' / ').slice(0, 90)}`);
  }));
  console.log('files', JSON.stringify(R?.claims?.files), 'summary', JSON.stringify(R?.claims?.summary));
  fs.writeFileSync(path.join(OUT, 'audit-m3c.json'), JSON.stringify({ rows, files: R?.claims?.files, summary: R?.claims?.summary }, null, 1));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
