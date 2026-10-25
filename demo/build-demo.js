// demo/build-demo.js - builds the client demonstration files into public/demo/ (npm run demo).
// Two fictional manuscripts with planted problems, so every module has something real to find when uploaded:
//   PJPS-2025-0101  "earlier submission" - run it first (Modules 4 and 5, saved) so later matches can be found
//   PJPS-2026-0412  the demonstration manuscript: fabricated / wrong references, citation errors, tortured phrases,
//                   AI-text leftovers, vague methods, a misidentified cell line, and five figures with
//                   (a) a re-used panel, a cloned area and an edited (smoothed-over) area, a joined blot,
//                   (b) AI-generation markers, (c) the same data plotted twice in two bar charts.
// Everything is invented; no real person, institution or unpublished data is used.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType } = require('docx');

const OUT = path.join(__dirname, '..', 'public', 'demo');
fs.mkdirSync(path.join(OUT, 'figures'), { recursive: true });

// ------------------------------------------------------------------ tiny PNG writer
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(img, text = {}) {
  const { width: w, height: h, data } = img;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = y * (w * 3 + 1) + 1 + x * 3; raw[d] = data[s]; raw[d + 1] = data[s + 1]; raw[d + 2] = data[s + 2]; }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const texts = Object.entries(text).map(([k, v]) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), ...texts, chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ synthetic images
let seed = 20261024;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
const canvas = (w, h, v = 255) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(v) });
const setPx = (im, x, y, r, g, b) => { const i = (y * im.width + x) * 4; im.data[i] = r; im.data[i + 1] = g; im.data[i + 2] = b; im.data[i + 3] = 255; };

/** Fluorescence-style field: bright blobs on a dark background with camera noise (grows with brightness) */
function field(w, h, { blobs = 70, noise = 3, tint = [0.3, 1, 0.45] } = {}) {
  const f = new Float32Array(w * h);
  for (let b = 0; b < blobs; b++) {
    const cx = rnd() * w, cy = rnd() * h, r = 4 + rnd() * 12, a = 70 + rnd() * 170;
    for (let y = Math.max(0, Math.floor(cy - 3 * r)); y < Math.min(h, cy + 3 * r); y++)
      for (let x = Math.max(0, Math.floor(cx - 3 * r)); x < Math.min(w, cx + 3 * r); x++) f[y * w + x] += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
  }
  const im = canvas(w, h);
  for (let i = 0; i < w * h; i++) {
    const base = 14 + f[i];
    const v = Math.max(0, Math.min(255, base + gauss() * noise * (1 + base / 90)));
    im.data[i * 4] = v * tint[0]; im.data[i * 4 + 1] = v * tint[1]; im.data[i * 4 + 2] = v * tint[2]; im.data[i * 4 + 3] = 255;
  }
  return im;
}
function paste(dst, src, ox, oy, map = (x, y) => [x, y], sw = src.width, sh = src.height) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const [sx, sy] = map(x, y);
    if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height || ox + x >= dst.width || oy + y >= dst.height) continue;
    const s = (Math.floor(sy) * src.width + Math.floor(sx)) * 4, t = ((oy + y) * dst.width + ox + x) * 4;
    for (let k = 0; k < 4; k++) dst.data[t + k] = src.data[s + k];
  }
}
const copyOf = im => ({ width: im.width, height: im.height, data: im.data.slice() });

/** Western blot: 8 lanes, background level and bands */
function blot({ lanes = 8, w = 400, h = 130, splice = false } = {}) {
  const im = canvas(w, h);
  const laneW = w / lanes;
  const strength = Array.from({ length: lanes }, () => 0.5 + rnd() * 0.5);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const lane = Math.floor(x / laneW), lx = (x % laneW) / laneW;
    let v = 216 + gauss() * 2.2;
    if (splice && x >= w / 2) v -= 46;                       // right half comes from another blot
    const across = lx > 0.15 && lx < 0.85 ? Math.sin(Math.PI * (lx - 0.15) / 0.7) ** 0.5 : 0;
    v -= across * strength[lane] * 120 * Math.exp(-((y - 48) ** 2) / 55);
    v -= across * strength[(lane + 3) % lanes] * 85 * Math.exp(-((y - 92) ** 2) / 40);
    v = Math.max(0, Math.min(255, v));
    setPx(im, x, y, v, v, v);
  }
  return im;
}

/** Bar chart with axes on white */
function chart(values, { colour = [40, 90, 200], scale = 1, w = 300, h = 230, reverse = false } = {}) {
  const im = canvas(w, h);
  for (let y = 20; y < h - 28; y++) setPx(im, 34, y, 20, 20, 20);
  for (let x = 34; x < w - 12; x++) setPx(im, x, h - 28, 20, 20, 20);
  const vs = reverse ? [...values].reverse() : values;
  const span = w - 60;
  vs.forEach((v, k) => {
    const x0 = 44 + k * (span / vs.length), bw = span / vs.length - 12, hgt = Math.round(v * scale);
    for (let x = Math.round(x0); x < Math.round(x0 + bw); x++) for (let y = h - 28 - hgt; y < h - 28; y++) setPx(im, x, y, colour[0], colour[1], colour[2]);
  });
  return im;
}

/** "AI-looking" tissue image: smooth, noise-free gradients (no sensor noise at all) */
function synthetic(w, h) {
  const f = new Float32Array(w * h);
  for (let b = 0; b < 40; b++) {
    const cx = rnd() * w, cy = rnd() * h, r = 14 + rnd() * 26, a = 30 + rnd() * 90;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) f[y * w + x] += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r));
  }
  const im = canvas(w, h);
  for (let i = 0; i < w * h; i++) { const v = 90 + f[i]; im.data[i * 4] = Math.min(255, v * 1.25); im.data[i * 4 + 1] = Math.min(255, v * 0.55); im.data[i * 4 + 2] = Math.min(255, v * 0.9); im.data[i * 4 + 3] = 255; }
  return im;
}

// ------------------------------------------------------------------ the figures
const T1 = field(170, 170), T2 = field(170, 170, { blobs: 60 }), T3 = field(170, 170, { blobs: 80 }), T4 = field(170, 170, { blobs: 66 });
const BARS = [62, 118, 87, 154, 121, 176];                // the data of Figure 3 (and of the earlier submission)

function figure1(first) {                                   // 4 microscopy panels: original, rotated copy, cloned area, unrelated
  const im = canvas(4 * 190 + 10, 190);
  paste(im, first, 10, 10);
  paste(im, first, 200, 10, (x, y) => [y, 169 - x]);        // rotated 90 degrees
  const c = copyOf(T3);
  paste(c, copyOf(T3), 104, 96, (x, y) => [x + 12, y + 8], 50, 50); // a patch copied inside the same picture
  paste(im, c, 390, 10);
  paste(im, T4, 580, 10);
  return im;
}
function figure5() {                                        // photo with a smooth patch pasted over a structure
  const im = copyOf(field(300, 300, { blobs: 90, noise: 4, tint: [0.9, 0.7, 0.8] }));
  for (let y = 110; y < 190; y++) for (let x = 120; x < 220; x++) setPx(im, x, y, 120, 96, 108);
  return im;
}
function figure3(withSameData = true) {
  const im = canvas(2 * 320 + 10, 240);
  paste(im, chart(BARS), 10, 5);
  paste(im, withSameData ? chart(BARS, { colour: [200, 55, 50], scale: 1.12 }) : chart([48, 140, 70, 160, 40, 100], { colour: [200, 55, 50] }), 330, 5);
  return im;
}
const AI_TEXT = { parameters: 'histology of rat liver, hematoxylin and eosin, high detail\nNegative prompt: blurry\nSteps: 30, Sampler: Euler a, CFG scale: 7, Seed: 1928374650, Size: 512x512, Model: stable-diffusion-xl' };

const figs = {
  'Figure1_microscopy.png': png(figure1(T1)),
  'Figure2_western-blot.png': png(blot({ splice: true })),
  'Figure3_charts.png': png(figure3(true)),
  'Figure4_histology.png': png(synthetic(256, 256), AI_TEXT),
  'Figure5_photo.png': png(figure5())
};
for (const [name, buf] of Object.entries(figs)) fs.writeFileSync(path.join(OUT, 'figures', name), buf);

// ------------------------------------------------------------------ manuscripts
const para = (text, opts = {}) => new Paragraph({ spacing: { after: 120 }, ...opts, children: [new TextRun({ text, font: 'Times New Roman', size: 22, ...(opts.run || {}) })] });
const head = t => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t, font: 'Times New Roman' })] });
const figure = (buf, size, caption) => [
  new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: buf, transformation: size })] }),
  para(caption, { alignment: AlignmentType.CENTER, run: { italics: true, size: 20 } })
];

const SHARED_INTRO = 'Liver injury caused by paracetamol overdose remains a leading cause of acute liver failure, and herbal products are widely used in Pakistan for hepatic protection. Nigella sativa seed extract has shown antioxidant and anti-inflammatory activity in several experimental models (Ahmad et al., 2013; Hewlings and Kalman, 2017). The present work evaluated whether a standardised seed extract protects the liver of rats exposed to a toxic dose of paracetamol.';

async function main() {
  const earlierFig1 = png((() => { const im = canvas(190, 190); paste(im, T1, 10, 10); return im; })());
  const earlierFig2 = png((() => { const im = canvas(330, 240); paste(im, chart(BARS), 10, 5); return im; })());
  // --- earlier submission (stored first so the later manuscript can be matched against it)
  const earlier = new Document({ sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Protective effect of Nigella sativa extract on paracetamol-induced hepatotoxicity in rats', font: 'Times New Roman' })] }),
    para('Manuscript ID: PJPS-2025-0101'),
    para('Authors: Imran Hussain, Sana Qureshi, Tariq Mehmood'),
    para('Department of Pharmacology, Demo Institute of Pharmaceutical Sciences, Lahore, Pakistan'),
    para('Corresponding author: imran.hussain.demo@gmail.com'),
    head('Abstract'),
    para('This study examined the hepatoprotective activity of Nigella sativa seed extract in rats given paracetamol. Serum enzymes and liver histology were examined and the extract reduced the rise of liver enzymes in a dose-dependent manner.'),
    head('Introduction'), para(SHARED_INTRO),
    head('Materials and Methods'),
    para('Male Wistar rats (n = 48, 180-220 g) were divided into six groups of 8 animals. The extract was given at 100 and 200 mg/kg for seven days. The study was approved by the Institutional Animal Ethics Committee (approval no. DIPS/IAEC/2025/17). Chemicals were purchased from Sigma-Aldrich.'),
    head('Results'),
    para('The extract lowered serum ALT and AST in a dose-dependent manner (Figure 1, Figure 2).'),
    ...figure(earlierFig1, { width: 190, height: 190 }, 'Figure 1. Liver sections, control group.'),
    ...figure(earlierFig2, { width: 330, height: 240 }, 'Figure 2. Serum ALT in the experimental groups.'),
    head('Discussion'), para('The protective effect agrees with earlier reports (Ahmad et al., 2013).'),
    head('References'),
    para('Ahmad A, Husain A, Mujeeb M, Khan SA, Najmi AK, Siddique NA, Damanhouri ZA and Anwar F (2013). A review on therapeutic potential of Nigella sativa: A miracle herb. Asian Pac J Trop Biomed, 3(5): 337-352.'),
    para('Hewlings SJ and Kalman DS (2017). Curcumin: A review of its effects on human health. Foods, 6(10): 92.')
  ] }] });
  fs.writeFileSync(path.join(OUT, 'PJPS-2025-0101_Earlier-Submission.docx'), await Packer.toBuffer(earlier));

  // --- demonstration manuscript
  const refs = [
    'Ahmad A, Husain A, Mujeeb M, Khan SA, Najmi AK, Siddique NA, Damanhouri ZA and Anwar F (2013). A review on therapeutic potential of Nigella sativa: A miracle herb. Asian Pac J Trop Biomed, 3(5): 337-352.',
    'Hewlings SJ and Kalman DS (2017). Curcumin: A review of its effects on human health. Foods, 6(10): 92.',
    'Hewlings SJ and Kalman DS (2019). Curcumin: A review of its effects on human health. Foods, 6(10): 92.',
    'Wakefield AJ, Murch SH, Anthony A, Linnell J, Casson DM, Malik M, Berelowitz M, Dhillon AP, Thomson MA, Harvey P, Valentine A, Davies SE and Walker-Smith JA (1998). Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children. Lancet, 351(9103): 637-641.',
    'Rehman S, Qureshi T and Mirza FJ (2022). Nano-engineered phytosomal curcumin attenuates paracetamol hepatotoxicity through Nrf2 up-regulation in Wistar rats. J Adv Hepatic Pharmacol, 14(3): 211-226.',
    'Farooqi HM, Zafar N and Baig MA (2021). Synergistic hepatoprotective activity of Nigella sativa and silymarin: a randomised multicentre trial. Int J Phytother Res, 9(2): 45-58.',
    'Iqbal M, Shah SA and Rauf A (2020). Herbal hepatoprotectants in South Asia: an overview. Pak J Pharm Sci, 33(4): 1801-1812.'
  ];
  const doc = new Document({ sections: [{ children: [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Hepatoprotective effect of Nigella sativa seed extract against paracetamol-induced liver injury in rats: molecular docking and machine-learning prediction', font: 'Times New Roman' })] }),
    para('Manuscript ID: PJPS-2026-0412'),
    para('Authors: Imran Hussain, Sana Qureshi, Bilal Ahmed, Kamran Raza'),
    para('Department of Pharmacology, Demo Institute of Pharmaceutical Sciences, Lahore, Pakistan'),
    para('Department of Mechanical Engineering, Sample University of Technology, Karachi, Pakistan'),
    para('Corresponding author: bilal.ahmed.demo@gmail.com, imran.hussain.demo@yahoo.com'),
    head('Abstract'),
    para('This study examined the hepatoprotective activity of Nigella sativa seed extract in rats given paracetamol. Serum enzymes and liver histology were examined and the extract reduced the rise of liver enzymes in a dose-dependent manner. Network pharmacology, molecular docking, hub genes and KEGG/GO enrichment analysis identified the likely targets. A counterfeit consciousness model was used to predict activity.'),
    head('Introduction'), para(SHARED_INTRO),
    para('Curcumin and silymarin act through similar pathways (Hewlings and Kalman, 2017; Rehman et al., 2022). Combined use gave synergistic protection (Farooqi et al., 2021), and an earlier trial reported comparable effects (Ali et al., 2020). Autism and hepatic outcomes have also been debated (Wakefield et al., 1998).'),
    head('Materials and Methods'),
    para('Rats were divided into groups and treated with the extract. HEp-2 cells were used to test cytotoxicity. Reagents and kits were used according to the instructions. A profound learning model, an irregular woodland classifier and a bolster vector machine were trained on the docking scores; data mining of the targets used the STRING database.'),
    para('As an AI language model, I cannot provide the exact catalogue numbers, but the following sections describe a typical protocol. Certainly! Here is a revised version of the statistical section.'),
    head('Results'),
    para('The extract lowered serum ALT and AST in a dose-dependent manner. Liver sections of the control and treated groups are shown in Figure 1, the protein expression in Figure 2, and the effect on serum markers in Figure 3. Histology of the treated liver is shown in Figure 4 and the gross appearance in Figure 5.'),
    ...figure(figs['Figure1_microscopy.png'], { width: 640, height: 160 }, 'Figure 1. Liver sections of the control and treated groups.'),
    ...figure(figs['Figure2_western-blot.png'], { width: 400, height: 130 }, 'Figure 2. Western blot of Nrf2 in liver tissue.'),
    ...figure(figs['Figure3_charts.png'], { width: 640, height: 240 }, 'Figure 3. Serum ALT (left) and AST (right) in the experimental groups.'),
    ...figure(figs['Figure4_histology.png'], { width: 256, height: 256 }, 'Figure 4. Histology of the treated liver (H&E).'),
    ...figure(figs['Figure5_photo.png'], { width: 300, height: 300 }, 'Figure 5. Gross appearance of the liver.'),
    head('Discussion'), para('The protective effect agrees with the earlier work (Ahmad et al., 2013; Iqbal et al., 2020). I hope this helps.'),
    head('References'),
    ...refs.map(r => para(r))
  ] }] });
  fs.writeFileSync(path.join(OUT, 'PJPS-2026-0412_Demo-Manuscript.docx'), await Packer.toBuffer(doc));
  fs.writeFileSync(path.join(OUT, 'PJPS-2026-0412_Reference-List.txt'), refs.join('\n') + '\n');
  for (const f of fs.readdirSync(OUT)) if (!fs.statSync(path.join(OUT, f)).isDirectory()) console.log(f.padEnd(48), (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB');
  for (const f of fs.readdirSync(path.join(OUT, 'figures'))) console.log('figures/' + f.padEnd(40), (fs.statSync(path.join(OUT, 'figures', f)).size / 1024).toFixed(0) + ' KB');
}
main().catch(e => { console.error(e); process.exit(1); });
