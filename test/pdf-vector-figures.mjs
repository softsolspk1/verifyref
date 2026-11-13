// pdf-vector-figures.mjs - Module 5 on PDFs whose figures are drawn as vector graphics (charts printed to PDF, as in
// published articles; report #139 found no figures in one): each figure is found on the rendered page from its "Fig."
// caption - two figures side by side stay two, the running header, body text and a ruled table above are left out, a
// full-width figure with a short caption keeps its full width, a page without a figure caption gives nothing.
// Offline: a synthetic page (RGBA + text items), no browser, no PDF library.
import assert from 'assert';
import { figureBoxes } from '../public/js/images/vectorFigures.js';

const ok = m => console.log(`  ok - ${m}`);
const W = 1000, H = 1400, LH = 16;

function page() {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const items = [];
  const ink = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * W + x) * 4; data[o] = data[o + 1] = data[o + 2] = 0; } };
  // a text item: its box, inked as a solid bar of glyphs (descenders below the baseline)
  const text = (str, x, y, w, h = LH) => { items.push({ str, x, y, w, h }); ink(Math.round(x), Math.round(y + 3), Math.round(x + w), Math.round(y + h + 3)); };
  // a chart: axes, bars and small labels
  const chart = (x0, y0, x1, y1) => {
    ink(x0 + 30, y0, x0 + 32, y1); ink(x0 + 30, y1 - 2, x1, y1);
    for (let i = 0; i < 6; i++) ink(x0 + 50 + i * 40, y0 + 40 + i * 15, x0 + 70 + i * 40, y1 - 2);
    text('0.5', x0, y0 + 20, 22, 12); text('2DWI', x0 + 100, y1 + 6, 40, 12);
  };
  return { data, items, ink, text, chart, img: { data, width: W, height: H } };
}

// 1. two figures side by side (Fig. 1 left column, Fig. 2 right column), as on page 4 of report #139's article
{
  const p = page();
  p.text('1852', 60, 60, 40); p.text('AUTHOR ET AL.,', 760, 62, 180);
  for (const y of [120, 520, 920]) { p.chart(70, y, 470, y + 330); p.chart(530, y, 930, y + 330); }
  p.text('Fig. 1. Activities of SOD, CAT, and APX in carnations', 60, 1290, 420); p.text('exposed to extended watering intervals', 60, 1310, 330);
  p.text('Fig. 2. Free and total ascorbate and hydrogen peroxide', 520, 1290, 420); p.text('levels in carnation plants exposed', 520, 1310, 330);
  const b = figureBoxes(p.img, p.items);
  assert.deepStrictEqual(b.map(x => x.caption), ['Fig. 1', 'Fig. 2']);
  assert.ok(b[0].x + b[0].w <= W / 2 && b[1].x >= W / 2, 'one figure per column');
  for (const x of b) assert.ok(x.y > 85 && x.y < 125 && x.y + x.h > 1240 && x.y + x.h < 1290, `${x.caption}: the three charts, not the header or the caption (${x.y}-${x.y + x.h})`);
  ok('two drawn figures side by side are found as two, without the running header');
}

// 2. body text above, a ruled table above a figure (its "Table" caption is no figure), page number at the bottom
{
  const p = page();
  for (let i = 0; i < 6; i++) p.text('Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt', 60, 80 + i * 22, 880);
  p.text('Table 1. Analysis of variance for the measured traits', 60, 240, 500);
  p.ink(60, 270, 940, 272);
  for (let i = 0; i < 8; i++) { p.text('Trait', 70, 280 + i * 22, 50); p.text('12.3', 500, 280 + i * 22, 40); }
  p.ink(60, 462, 940, 464);
  p.chart(100, 500, 460, 900); p.chart(540, 500, 900, 900);
  p.text('Fig. 5. Principal component analysis of the traits under drought', 60, 940, 700);
  for (let i = 0; i < 8; i++) p.text('Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt', 60, 1000 + i * 22, 880);
  p.text('1855', 480, 1350, 40);
  const b = figureBoxes(p.img, p.items);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].caption, 'Fig. 5');
  assert.ok(b[0].y >= 464 && b[0].y < 520, `the table above is left out (top ${b[0].y})`);
  assert.ok(b[0].w > W * 0.75, 'the figure keeps its full width');
  ok('body text and a ruled table above the figure are left out; a table is not taken for a figure');
}

// 3. a full-width figure whose caption is short (left column only)
{
  const p = page();
  for (let i = 0; i < 4; i++) p.text('Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt', 60, 80 + i * 22, 880);
  p.ink(100, 300, 900, 302); p.ink(100, 700, 900, 702); p.ink(100, 300, 102, 702); p.ink(898, 300, 900, 702);
  p.chart(150, 340, 850, 680);
  p.text('Fig. 2. Workflow', 60, 740, 160);
  const b = figureBoxes(p.img, p.items);
  assert.strictEqual(b.length, 1);
  assert.ok(b[0].x < 110 && b[0].x + b[0].w > 890, `full width kept (${b[0].x}-${b[0].x + b[0].w})`);
  ok('a full-width figure with a short caption keeps its full width');
}

// 4. no figure caption: nothing (a page of text and a table)
{
  const p = page();
  for (let i = 0; i < 20; i++) p.text('Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt', 60, 80 + i * 22, 880);
  p.text('Table 2. Yield components', 60, 600, 300); p.ink(60, 630, 940, 632);
  assert.deepStrictEqual(figureBoxes(p.img, p.items), []);
  ok('a page without a figure caption gives no figure');
}
console.log('pdf vector figures test passed');
