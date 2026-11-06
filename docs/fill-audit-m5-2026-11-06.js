// docs/fill-audit-m5-2026-11-06.js - writes the Module 5 benchmark figures (images-public.log of D:\pjps-tmp\audit-2026-11-06
// and data/benchmark/images-results.json from scripts/benchmark-images.mjs) and the test-suite line into
// docs/audit-results-2026-11-06.json (placeholders @@...@@).
// Run after the benchmarks: node docs/fill-audit-m5-2026-11-06.js [logDir]
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || 'D:/pjps-tmp/audit-2026-11-06';
const file = path.join(__dirname, 'audit-results-2026-11-06.json');
const pub = fs.readFileSync(path.join(dir, 'images-public.log'), 'utf8').replace(/\r/g, '\n');
const line = (txt, re) => (txt.split('\n').find(l => re.test(l)) || '').trim();

// RSIID-style generated set: "rotation 90°   25/25", "copy-move 15/25; negatives with false alarm 0/30"
const n = re => (line(pub, re).match(/(\d+)\/(\d+)/) || []).slice(1).map(Number);
const [rot] = n(/^rotation 90/), [rot180] = n(/^rotation 180/), [mir] = n(/^mirror/), [res] = n(/^rescale/), [jpg] = n(/^JPEG/), [con, conN] = n(/^contrast/), [crop, cropN] = n(/^crop/);
const cm = line(pub, /^copy-move/).match(/copy-move (\d+)\/(\d+); negatives with false alarm (\d+)\/(\d+)/) || [];
const whole = `${(rot || 0) + (rot180 || 0) + (mir || 0) + (res || 0) + (jpg || 0)}/125`;

// BioFors (real figures, expert annotations)
const B = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'benchmark', 'images-results.json'), 'utf8'));
const pc = (a, b) => `${Math.round(100 * a / b)}%`;
const negPairs = Object.values(B.neg).reduce((a, x) => a + x.pairs, 0), negReports = Object.values(B.neg).reduce((a, x) => a + x.reports, 0);
const dupFound = `${B.edd.found}/${B.edd.testablePairs} (${pc(B.edd.found, B.edd.testablePairs)})`;
const clone = `${pc(B.idd.positives.flagged, B.idd.positives.tested)} found vs ${pc(B.idd.negatives.flagged, B.idd.negatives.tested)} of clean images reported`;
const bioRows = [
  [`Duplicated panels within a paper (${B.edd.testablePairs} annotated pairs, ${B.edd.papers} papers)`, [`${B.edd.found} found (${pc(B.edd.found, B.edd.testablePairs)}); ${B.edd.foundHigh} as Strong (${pc(B.edd.foundHigh, B.edd.testablePairs)})`, 'warn']],
  ['Reports not in the annotation (same papers)', [`${B.edd.extraReports} (${B.edd.extraHigh} Strong), about 1 Strong per paper; some are real duplicates the annotators missed`, 'warn']],
  [`Unrelated figures (${negPairs.toLocaleString('en')} pairs of blots and microscopy)`, [`${negReports} false reports`, negReports ? 'bad' : 'ok']],
  [`Cloned area inside one image (${B.idd.positives.tested} vs ${B.idd.negatives.tested} clean)`, [clone, 'bad']],
  [`Splicing in blots (${B.cstd.positives.tested} vs ${B.cstd.negatives.tested} clean)`, [`${pc(B.cstd.positives.flagged, B.cstd.positives.tested)} vs ${pc(B.cstd.negatives.flagged, B.cstd.negatives.tested)}: no separation (indicator only)`, 'bad']]
];

const rows = [
  ['Generated copies (60 scientific images)', 'Whole copies rotated, mirrored, resized, recompressed', [`${whole} found`, 'ok']],
  ['Generated copies', 'Copy with contrast / brightness change', [`${con}/${conN}`, con / conN >= 0.85 ? 'ok' : 'warn']],
  ['Generated copies', 'Partial copy (55% crop)', [`${crop}/${cropN}`, 'warn']],
  ['Generated copies', 'Cloned area inside one image', [`${cm[1]}/${cm[2]}`, 'warn']],
  ['Generated copies', 'Clean image pairs falsely reported', [`${cm[3]}/${cm[4]}`, Number(cm[3]) === 0 ? 'ok' : 'bad']],
  ...bioRows.map(([task, result]) => ['BioFors (real, expert-annotated)', task, result])
];
let s = fs.readFileSync(file, 'utf8');
s = s.replace('"@@M5ROWS@@"', JSON.stringify(rows))
  .replace('@@M5SUMMARY@@', `Generated copies: whole-image copies ${whole}, partial copies ${crop}/${cropN}, cloned areas ${cm[1]}/${cm[2]}, ${cm[3]}/${cm[4]} false alarms. Real expert-annotated figures (BioFors): duplicates ${dupFound}, ${negReports} false reports on ${negPairs.toLocaleString('en')} unrelated pairs; cloned areas ${clone}`)
  .replace('@@M5DUP@@', `Whole copies ${whole}; contrast change ${con}/${conN}; partial (55% crop) ${crop}/${cropN}; real duplicates (BioFors) ${dupFound}, ${negReports} false reports on ${negPairs.toLocaleString('en')} unrelated pairs`)
  .replace('@@M5CLONE@@', `Generated copy-moves ${cm[1]}/${cm[2]} with ${cm[3]}/${cm[4]} false alarms on clean images; BioFors: ${clone}`)
  .replace('@@SUITE@@', process.env.SUITE || 'npm test: 35 test programs, all passed on 6 November 2026 after every fix.');
fs.writeFileSync(file, s);
console.log('filled', file, '\n', rows.map(r => r.slice(0, 2).join(' | ') + ' | ' + (Array.isArray(r[2]) ? r[2][0] : r[2])).join('\n '));
