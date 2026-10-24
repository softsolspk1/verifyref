// test/fixtures.js - builds a small sample manuscript (.docx) used by the smoke tests
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

async function sampleManuscript({ numeric = false } = {}) {
  const body = numeric ? [
    'Nigella sativa seeds show antioxidant activity [1]. Similar effects were reported for curcumin [2,3].',
    'Earlier work on hepatoprotection [3] and on the analgesic effect [1-2] supports this.'
  ] : [
    'Nigella sativa seeds show antioxidant activity (Khan et al., 2021). Similar effects were reported for curcumin (Hewlings and Kalman, 2017; Siddiqui, 2019).',
    'Khan et al. (2021) studied hepatoprotection, while Siddiqui (2019) examined analgesia.'
  ];
  const refs = [
    'Khan MA, Siddiqui A and Smith JR (2021). Antioxidant activity of Nigella sativa seed extract. Pak J Pharm Sci, 34(2): 455-462.',
    'Hewlings SJ and Kalman DS (2017). Curcumin: A review of its effects on human health. Foods, 6(10): 92.',
    'Siddiqui A (2019). Analgesic effect of a herbal preparation in mice. J Ethnopharmacol, 12: 1-9.'
  ].map((r, i) => (numeric ? `${i + 1}. ${r}` : r));
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun('Sample manuscript')] }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Introduction')] }),
    ...body.map(t => new Paragraph({ children: [new TextRun({ text: t, font: 'Times New Roman' })] })),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('References')] }),
    ...refs.map(t => new Paragraph({ children: [new TextRun(t)] }))
  ] }] });
  return Packer.toBuffer(doc);
}

module.exports = { sampleManuscript };
