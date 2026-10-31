// study-ethics.js - study type, ethics approval number and dose detection (src/papermill/studyEthics.js)
const assert = require('assert');
const { studyType, approvalNumber, hasDose } = require('../src/papermill/studyEthics');

// approval numbers in the formats journals actually print
const withNumber = [
  'The study was approved by the Animal Ethics Committee of the University of Karachi (AEC/2021/45).',
  'Ethical approval was obtained from the Institutional Review Board (IRB-00123).',
  'The protocol was approved by the Ethics Review Committee, Ref. No. KU/ERC/22-10.',
  'All procedures were approved by the Institutional Animal Care and Use Committee (Approval ID: 2021-34).',
  'Ethical approval was granted by the Bioethics Committee vide letter No. 1245/BEC/2022.',
  'The experimental protocol (No. 2020/017) was approved by the Institutional Animal Ethics Committee.',
  'The study was approved by the ethics committee of the hospital. The approval number is 2019-112.',
  'This study was approved by the Research Ethics Committee (approval number: PJPS2021045).',
  'Approval for the study was granted by the ERC of Dow University (Ref # IRB-1890/DUHS/Approval/2021).',
  'The animal study was reviewed and approved by the IACUC of Zhejiang University (ZJU20210311).',
  'This study was approved by the Ethics Committee of Shenzhen Hospital of Beijing University of Chinese Medicine (Longgang) (2018041A).',
  'The study protocol was approved by the ethics committee of Cangzhou Central Hospital (Approval No. SKZ-X200325LS), and all processes complied.'
];
for (const s of withNumber) assert.ok(approvalNumber(s).number, `number expected in: ${s}`);

// approval without any number: still reported
const withoutNumber = [
  'The study was approved by the institutional ethics committee.',
  'All experiments were approved by the Animal Ethics Committee of the university in 2021.',
  'Samples were collected according to the approval of the Ethics Committees of our hospital.',
  'Ethical approval was obtained from the review board of the hospital, and the rats were treated humanely (p < 0.05).'
];
for (const s of withoutNumber) {
  const a = approvalNumber(s);
  assert.ok(a.approval, `approval expected in: ${s}`);
  assert.ok(!a.number, `no number expected in: ${s} (got ${a.number})`);
}

// study type: the work itself, not a mention
assert.deepStrictEqual(studyType('Thirty male Wistar rats (180-220 g) were divided into five groups.'), { animal: true, human: false });
assert.deepStrictEqual(studyType('The rats were housed under standard conditions and fed a pellet diet.'), { animal: true, human: false });
assert.deepStrictEqual(studyType('Swiss albino mice (n = 6 per group) received the extract orally.'), { animal: true, human: false });
assert.strictEqual(studyType('Quercetin was shown to reduce inflammation in rats and mice in earlier studies [12].').animal, false);
assert.strictEqual(studyType('Animal models of diabetes are widely used; we studied the compound in HepG2 cells.').animal, false);
assert.strictEqual(studyType('A total of 120 patients were enrolled and written informed consent was obtained.').human, true);
assert.strictEqual(studyType('Patients with diabetes often use herbal medicines (Khan et al., 2019).').human, false);

// doses
for (const d of ['200 mg/kg', '50 mg kg-1', '50 mg·kg−1', '0.5 mL/100 g', '300 mg/kg b.w.', '10 IU per kg', '2 g/kg/day', '25 mg kg^-1']) assert.ok(hasDose(`rats received ${d} orally`), `dose expected: ${d}`);
assert.ok(!hasDose('rats received the extract orally for 14 days'), 'no dose');

console.log('study ethics test passed (approval numbers, study type, doses)');

// reviews and public-data studies are not human / animal studies, and a waiver is not a gap
assert.strictEqual(studyType('A systematic review and meta-analysis. Patients were randomized in the included trials; rats were treated in two studies.').animal, false);
assert.strictEqual(studyType('This study utilized publicly available, de-identified data and did not involve human participants or animal experiments.').human, false);
assert.ok(approvalNumber('Therefore, ethical approval and informed consent were waived.').exempt);
console.log('study ethics test passed (reviews, public data, waivers)');
assert.strictEqual(studyType('Network pharmacology and molecular docking were used. Wistar rats were used and treated with the extract.').animal, true);
console.log('study ethics test passed (network pharmacology with animals)');
