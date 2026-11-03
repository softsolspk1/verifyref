// test/unformatted-docs.js - manuscripts as plain Word files, without the expected layout: no "References" heading,
// "References." with a full stop, the heading and the first reference in one paragraph, another heading word,
// numbered references run together in one paragraph, soft line breaks. The body and the reference list must both be
// found, so every module can review the manuscript. Run: node test/unformatted-docs.js
const assert = require('assert');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const P = require('../src/parse');
const { prepare } = require('../src/pipeline');

const body = [
  'Antioxidant activity of Thar desert plant extracts in diabetic rats',
  'Ali Khan, Sara Ahmed',
  'Department of Pharmacology, University of Karachi, Pakistan',
  'Abstract: Oxidative stress contributes to diabetic complications. We studied extracts of three plants in streptozotocin diabetic rats and measured glucose and antioxidant enzymes over six weeks of treatment with two doses.',
  'Introduction',
  'Diabetes mellitus is a growing burden in Pakistan (Khan et al., 2020). Plant extracts have long been used in traditional medicine for the disease (Ahmed and Shah, 2018). Antioxidant enzymes protect tissues from oxidative damage (Zhang, 2019).',
  'Methods',
  'Male Wistar rats were made diabetic with streptozotocin and treated orally for six weeks with each extract at two doses. Blood glucose was measured weekly and liver enzymes were measured at the end of the study.',
  'Results',
  'All three extracts reduced fasting glucose and raised superoxide dismutase and catalase activity compared with untreated diabetic rats, the highest dose giving the largest effect in every case.'
];
const refs = [
  'Ahmed S and Shah K (2018). Medicinal plants of Sindh. J. Ethnopharmacol., 210: 1-10.',
  'Khan A, Ali B and Noor C (2020). Diabetes prevalence in Pakistan. Pak. J. Pharm. Sci., 33(2): 101-108.',
  'Zhang Y (2019). Antioxidant enzymes in diabetes. Free Radic. Biol. Med., 130: 20-30.'
];
const apa = [
  'Ahmed, S., & Shah, K. (2018). Medicinal plants of Sindh. Journal of Ethnopharmacology, 210, 1–10.',
  'Khan, A., Ali, B., & Noor, C. (2020). Diabetes prevalence in Pakistan. Pakistan Journal of Pharmaceutical Sciences, 33(2), 101–108.',
  'World Health Organization (2021). Global report on diabetes. WHO, Geneva.'
];
const para = t => new Paragraph({ children: [new TextRun(t)] });
const lines = t => new Paragraph({ children: t.map((x, i) => new TextRun({ text: x, break: i ? 1 : 0 })) });
const bodyWords = body.join(' ').split(/\s+/).length;

const layouts = {
  'heading on its own line': [...body.map(para), para('References'), ...refs.map(para)],
  'no references heading': [...body.map(para), ...refs.map(para)],
  'no heading, APA style with an organisation': [...body.map(para), ...apa.map(para)],
  'no heading, numbered, figure legends after': [...body.map(para), ...refs.map((r, i) => para(`${i + 1}. ${r}`)), para('Figure legends'), para('Fig. 1. Fasting glucose over six weeks (mean ± SD, n = 6).')],
  '"References." with a full stop': [...body.map(para), para('References.'), ...refs.map(para)],
  'heading and first reference in one paragraph': [...body.map(para), para(`References: ${refs[0]}`), ...refs.slice(1).map(para)],
  'numbered references in one paragraph': [...body.map(para), para('References'), para(refs.map((r, i) => `${i + 1}. ${r}`).join(' '))],
  'soft line breaks': [...body.map(para), lines(['REFERENCES', ...refs])],
  '"Literature cited"': [...body.map(para), para('Literature cited'), ...refs.map(para)],
  'whole document in one paragraph': [lines([...body, 'Reference list', ...refs])]
};

(async () => {
  for (const [name, children] of Object.entries(layouts)) {
    const { text } = await P.extractDocument(await Packer.toBuffer(new Document({ sections: [{ children }] })), 'manuscript.docx', '');
    const p = prepare({ text });
    assert.strictEqual(p.refs.length, 3, `${name}: 3 references (got ${p.refs.length}: ${p.refs.map(r => r.raw.slice(0, 40)).join(' | ')})`);
    assert.ok(p.body.split(/\s+/).filter(Boolean).length >= bodyWords - 5, `${name}: the manuscript body is kept`);
    assert.ok(!p.refs.some(r => /Fig\. 1|Antioxidant activity of Thar/.test(r.raw)), `${name}: no body or legend text in the list`);
  }
  console.log(`  ✓ ${Object.keys(layouts).length} plain Word layouts: body and reference list found`);

  // prose is never taken for a reference list: a text without references keeps all of it as the body
  const prose = [...body, 'Discussion', 'Khan et al. (2020) reported a similar fall in glucose in 2020 with a related plant, and Zhang (2019) described the enzymes.', 'In 2021 the World Health Organization (2021) estimated the burden at 33 million people in Pakistan alone.'].join('\n');
  const sec = P.findReferenceSection(prose);
  assert.ok(!sec.found, 'prose with narrative citations is not a reference list');
  // "Sources" / "Literature" as ordinary words are not headings
  assert.ok(!P.findReferenceSection(`${body.join('\n')}\nSources\nThe plants were collected in Tharparkar in March and identified at the herbarium.`).found, '"Sources" followed by prose is not a heading');
  for (const r of [...refs, ...apa, '[4] Smith J, Lee K. Tablet coating. Int J Pharm 2019;560:1-9.']) assert.ok(P.looksLikeReference(r), `reference recognised: ${r.slice(0, 40)}`);
  for (const l of body) assert.ok(!P.looksLikeReference(l), `prose not taken for a reference: ${l.slice(0, 40)}`);
  console.log('  ✓ prose, narrative citations and ordinary "Sources" are not taken for references');

  // a Full Screening of a manuscript without any reference list reviews the text instead of failing
  const noRefs = [...body, ...body.slice(3), ...body.slice(3)].join('\n\n');
  const pm = prepare({ text: noRefs, kind: 'manuscript' });
  assert.ok(pm.noList && pm.refs.length === 0 && pm.body.length === noRefs.length, 'manuscript without references: text only');
  const pl = prepare({ text: refs.join('\n'), kind: 'references' });
  assert.strictEqual(pl.refs.length, 3, 'a bare reference list (Module 1) is still read as references');
  console.log('  ✓ no reference list: the manuscript is reviewed as text; a bare list is still a list');
  console.log('unformatted documents test passed');
})().catch(e => { console.error(e); process.exit(1); });
