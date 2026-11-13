// images/vectorFigures.js - figures drawn as vector graphics in a PDF (charts made in Excel / Origin and printed to PDF,
// as in most published articles): they have no embedded picture to extract, so the page is rendered and each figure is
// cut out of it. A figure is found from its caption ("Fig. 1 ..."): the drawing directly above it (or below, when the
// caption comes first) in the caption's column, up to the body text, the page header or a wide empty band. Tables are
// not taken: they have a "Table" caption. Pure functions (no DOM): used by extract.js, tested in Node.

const FIG_RE = /^\s*(fig(?:ure)?\.?\s*[\dIVX]+[a-z]?)/i;
const INK = 235;          // a pixel darker than this in any channel is ink
const GAP = 0.04;         // an empty band this tall (share of the page height) ends a figure
const MARGIN_TOP = 0.06, MARGIN_BOTTOM = 0.05; // running header / page number zones
const MIN_H = 0.06, MIN_W = 0.12;              // smaller regions are not figures

/**
 * Text items (pdf.js getTextContent, already in the rendered page's pixels, top-left origin) -> lines
 * items: [{ str, x, y (top), w, h }]
 */
function textLines(items) {
  const sorted = items.filter(t => t.str && t.str.trim() && t.w > 0 && t.h > 0).sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const t of sorted) {
    const l = lines.find(x => Math.abs(x.y - t.y) < Math.max(2, t.h * 0.5) && t.x - (x.x + x.w) < t.h * 1.2 && t.x + t.w > x.x - t.h * 1.2);
    if (l) {
      const x0 = Math.min(l.x, t.x), x1 = Math.max(l.x + l.w, t.x + t.w);
      l.items.push(t); l.x = x0; l.w = x1 - x0; l.h = Math.max(l.h, t.h);
    } else lines.push({ x: t.x, y: t.y, w: t.w, h: t.h, items: [t] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    l.str = l.items.map(t => t.str).join(' ').replace(/\s+/g, ' ').trim();
    l.words = l.str.split(' ').filter(w => /[a-z]{2,}/i.test(w)).length;
  }
  return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The most common text height on the page (body text), weighted by characters */
function bodyHeight(lines) {
  const n = new Map();
  for (const l of lines) for (const t of l.items) { const k = Math.round(t.h); n.set(k, (n.get(k) || 0) + t.str.length); }
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
}

/** The column a caption line belongs to: [x0, x1] in pixels */
function columnOf(line, W) {
  const mid = line.x + line.w / 2;
  if (line.w > W * 0.6) return [0, W];
  if (line.x + line.w < W * 0.55) return [0, W / 2];
  if (line.x > W * 0.45) return [W / 2, W];
  return Math.abs(mid - W / 2) < W * 0.1 ? [0, W] : mid < W / 2 ? [0, W / 2] : [W / 2, W];
}

/**
 * Figure regions on a rendered page.
 * img: { data (RGBA), width, height }; items: text items in pixels (see textLines)
 * -> [{ x, y, w, h, caption }]
 */
export function figureBoxes(img, items) {
  const { data, width: W, height: H } = img;
  const lines = textLines(items);
  const bh = bodyHeight(lines);
  const captions = lines.filter(l => FIG_RE.test(l.str));
  if (!captions.length) return [];
  const sameFont = l => bh && Math.abs(l.h - bh) <= bh * 0.2;

  // rows that stop a figure: body text (full-width lines of the body font in a column, and the short last line of a
  // paragraph under one) and the caption blocks
  const stops = [];
  const isBody = new Set();
  for (const l of lines) {
    const [c0, c1] = columnOf(l, W);
    if (sameFont(l) && l.words >= 5 && l.w >= (c1 - c0) * 0.75) isBody.add(l);
  }
  for (const l of lines) {
    if (isBody.has(l) || !sameFont(l)) continue;
    if ([...isBody].some(b => l.y > b.y && l.y - b.y < b.h * 1.9 && Math.abs(l.x - b.x) < b.h)) isBody.add(l);
  }
  // a caption block: the caption line and the lines of the same font that follow it in its column
  const blocks = captions.map(c => {
    const col = columnOf(c, W);
    let bottom = c.y + c.h;
    for (const l of lines) {
      if (l === c || l.y <= c.y || !sameFont(l) || l.x < col[0] - 2 || l.x + l.w > col[1] + 2) continue;
      if (l.y - bottom < c.h * 0.9) bottom = Math.max(bottom, l.y + l.h);
    }
    return { caption: c, col, top: c.y, bottom };
  });
  // the running header (the page's first text line, near the top) and the page number / footer (its last, near the bottom)
  const first = lines[0], last = lines[lines.length - 1];
  for (const l of lines) {
    if ((first && first.y < H * 0.1 && Math.abs(l.y - first.y) < first.h * 0.6) || (last && last.y > H * 0.9 && Math.abs(l.y - last.y) < last.h * 0.6)) isBody.add(l);
  }
  for (const l of isBody) stops.push({ x0: l.x, x1: l.x + l.w, y0: l.y, y1: l.y + l.h * 1.3 }); // text boxes end at the baseline: descenders below
  for (const b of blocks) stops.push({ x0: b.col[0], x1: b.col[1], y0: b.top, y1: b.bottom + b.caption.h * 0.3 });

  // ink per row inside a column range (header / footer zones and stop rows are blank)
  const inkAt = (x, y) => { const o = (y * W + x) * 4; return data[o] < INK || data[o + 1] < INK || data[o + 2] < INK; };
  const rowInk = (y, x0, x1) => {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x += 1) if (inkAt(x, y)) return true;
    return false;
  };
  const stopAt = (y, x0, x1) => stops.some(s => y >= s.y0 - 1 && y <= s.y1 + 1 && s.x1 > x0 && s.x0 < x1);
  const yMin = Math.round(H * MARGIN_TOP), yMax = Math.round(H * (1 - MARGIN_BOTTOM));
  const gap = Math.round(H * GAP);

  // the width of the text in a column: a ruled line as wide as it is a table border (a chart's axis is narrower, its
  // labels stand beside it)
  const textWidth = ([x0, x1]) => Math.max(0, ...[...isBody, ...blocks.map(b => b.caption)].filter(l => l.x >= x0 - 2 && l.x + l.w <= x1 + 2).map(l => l.w)) || (x1 - x0) * 0.8;
  const isRule = (y, x0, x1, min) => {
    let run = 0, best = 0, miss = 0;
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
      if (inkAt(x, y)) { run += miss + 1; miss = 0; best = Math.max(best, run); } else if (run && ++miss > 2) { run = 0; miss = 0; }
    }
    return best >= min;
  };
  // the other half of the page has no text beside the figure and its drawing crosses the gutter: a full-width figure
  const widen = (top, bottom, [x0, x1]) => {
    if (x1 - x0 > W * 0.6) return [x0, x1];
    const other = x0 < W / 2 ? [W / 2, W] : [0, W / 2];
    for (let y = top; y <= bottom; y += 2) if (stopAt(y, other[0], other[1])) return [x0, x1];
    // a figure of its own in the other column (its caption level with this one): two figures side by side
    if (blocks.some(b => b.col[0] === other[0] && b.col[1] === other[1] && b.top >= top && b.top <= bottom + H * 0.12)) return [x0, x1];
    const g0 = W * 0.49, g1 = W * 0.51;
    let crossing = 0;
    for (let y = top; y <= bottom; y += 2) if (rowInk(y, g0, g1)) crossing++;
    if (crossing >= (bottom - top) / 2 * 0.15) return [0, W];
    // ... or one line (a frame, an axis) runs unbroken across the middle of the page, and the other half is drawn on too
    let through = false, drawn = 0;
    for (let y = top; y <= bottom; y += 2) {
      if (!through && isRule(y, W * 0.4, W * 0.6, W * 0.2 - 1)) through = true;
      if (rowInk(y, other[0], other[1])) drawn++;
    }
    return through && drawn >= (bottom - top) / 2 * 0.3 ? [0, W] : [x0, x1];
  };

  const scan = (from, dir, col) => {
    let [x0, x1] = col;
    const rule = textWidth(col) * 0.92;
    let y = from, first = null, last = null, blank = 0;
    for (; y >= yMin && y <= yMax; y += dir) {
      if (stopAt(y, x0, x1)) { if (first !== null) break; continue; }
      if (first !== null && blank > 1 && isRule(y, x0, x1, rule)) break;
      if (rowInk(y, x0, x1)) { if (first === null) first = y; last = y; blank = 0; } else if (first !== null && ++blank > gap) break;
    }
    if (first === null) return null;
    const top = Math.min(first, last), bottom = Math.max(first, last);
    [x0, x1] = widen(top, bottom, col);
    // the horizontal extent of the ink in those rows
    let left = x1, right = x0;
    for (let yy = top; yy <= bottom; yy += 2) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) if (inkAt(x, yy)) { if (x < left) left = x; if (x > right) right = x; }
    const box = { x: Math.max(0, left - 4), y: Math.max(0, top - 4), w: Math.min(W, right + 5) - Math.max(0, left - 4), h: Math.min(H, bottom + 5) - Math.max(0, top - 4) };
    return box.h >= H * MIN_H && box.w >= W * MIN_W ? box : null;
  };

  const out = [];
  for (const b of blocks) {
    const box = scan(Math.floor(b.top) - 2, -1, b.col) || scan(Math.ceil(b.bottom) + 2, 1, b.col);
    if (box && !out.some(o => o.x < box.x + box.w && box.x < o.x + o.w && o.y < box.y + box.h && box.y < o.y + o.h)) out.push({ ...box, caption: b.caption.str.match(FIG_RE)[1].replace(/^fig(?:ure)?\.?\s*/i, 'Fig. ') });
  }
  return out;
}

/** pdf.js text items -> items in the pixels of a viewport (top-left origin) */
export function itemsInViewport(textItems, viewport) {
  return textItems.filter(t => t.str).map(t => {
    const [a, b, , , e, f] = t.transform;
    const fh = Math.hypot(a, b) || t.height || 0;
    const [x, yBase] = viewport.convertToViewportPoint(e, f);
    const s = viewport.scale;
    return { str: t.str, x, y: yBase - fh * s, w: (t.width || 0) * s, h: fh * s };
  });
}
