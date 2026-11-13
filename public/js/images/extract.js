// images/extract.js - figures out of a manuscript, in the browser: Word (.docx) media in document order with their
// "Figure n" captions, images embedded in PDF pages (pdf.js), or separate image files. Returns canvases scaled to
// at most MAX px on the longest side, plus a list of what could not be read.
import { scanProvenance } from './forensics.js';
import { decodeTiff } from './tiff.js';
import { figureBoxes, itemsInViewport } from './vectorFigures.js';
const MAX = 1600;
const MIN = 80; // smaller images are icons, logos or equation bitmaps

let jszipReady = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipReady = jszipReady || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jszip.min.js';
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => reject(new Error('Could not load the Word reader.'));
    document.head.appendChild(s);
  });
  return jszipReady;
}

let pdfjs = null;
async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return pdfjs;
}

function toCanvas(source, w, h) {
  const k = Math.min(1, MAX / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return { canvas: c, scale: k };
}

/**
 * Any figure file as an ImageBitmap: what the browser decodes itself (PNG, JPEG / JFIF, GIF, BMP, WebP), TIFF through
 * the built-in reader (unless the browser - Safari - reads it), SVG drawn at its own size (at least 1200 px wide).
 */
async function decodeBitmap(blob, name) {
  if (/\.tiff?$/i.test(name)) {
    try { return await createImageBitmap(blob); } catch (e) { /* not Safari */ }
    const t = await decodeTiff(await blob.arrayBuffer());
    return createImageBitmap(new ImageData(t.data, t.width, t.height));
  }
  if (/\.svg$/i.test(name)) {
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const k = Math.max(1, 1200 / (img.naturalWidth || 1200));
      const c = document.createElement('canvas');
      c.width = Math.round((img.naturalWidth || 1200) * k); c.height = Math.round((img.naturalHeight || 900) * k);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return createImageBitmap(c);
    } finally { URL.revokeObjectURL(url); }
  }
  return createImageBitmap(blob);
}

const FIG_RE = /^\s*(fig(?:ure)?\.?\s*[\dIVX]+[a-z]?)/i;

// ------------------------------------------------------------------ Word

// Word keeps a second copy of every text box and drawing for older readers (mc:Fallback) and the old version of
// tracked changes (w:del, w:moveFrom); pictures and captions there are not part of the document as read
const HIDDEN_COPY = new Set(['mc:Fallback', 'w:del', 'w:moveFrom']);

/** Closest paragraph holding a node, or null when the node sits in a hidden copy */
function ownerParagraph(node) {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (HIDDEN_COPY.has(n.nodeName)) return null;
    if (n.nodeName === 'w:p') return n;
  }
  return null;
}

/**
 * Pictures of document.xml in document order: [{ id (relationship id), caption ("Fig. n" or ''), sub (part number
 * when one paragraph holds several pictures, else 0) }]. A picture belongs to its own (innermost) paragraph only: a
 * figure laid out in a text box or a group is read once, not again for every paragraph around it (6 Nov 2026: a
 * manuscript of 14 figures was read as 56 pictures and every copy reported as a duplicate).
 */
export function docxPictureUses(xml) {
  const paras = Array.from(xml.getElementsByTagName('w:p')).filter(p => !hiddenAncestor(p));
  const textOf = p => Array.from(p.getElementsByTagName('w:t')).filter(t => ownerParagraph(t) === p).map(t => t.textContent).join('');
  // Images in document order, with the nearest "Figure n" caption (same paragraph or the next three / previous one)
  const uses = [];
  paras.forEach((p, i) => {
    const own = el => ownerParagraph(el) === p;
    const ids = Array.from(p.getElementsByTagName('a:blip')).filter(own).map(b => b.getAttribute('r:embed'))
      .concat(Array.from(p.getElementsByTagName('v:imagedata')).filter(own).map(b => b.getAttribute('r:id'))).filter(Boolean);
    if (!ids.length) return;
    let caption = '';
    for (const j of [i, i + 1, i + 2, i + 3, i - 1]) {
      const t = paras[j] ? textOf(paras[j]) : '';
      const m = t.match(FIG_RE);
      if (m) { caption = m[1].replace(/^fig(?:ure)?\.?\s*/i, 'Fig. '); break; }
    }
    ids.forEach((id, k) => uses.push({ id, caption, sub: ids.length > 1 ? k + 1 : 0 }));
  });
  return uses;
}

function hiddenAncestor(node) {
  for (let n = node.parentNode; n; n = n.parentNode) if (HIDDEN_COPY.has(n.nodeName)) return true;
  return false;
}

async function fromDocx(file, onStep) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('This is not a Word document.');
  const rels = new DOMParser().parseFromString(await zip.file('word/_rels/document.xml.rels').async('string'), 'text/xml');
  const target = {};
  for (const r of rels.getElementsByTagName('Relationship')) target[r.getAttribute('Id')] = r.getAttribute('Target');
  const xml = new DOMParser().parseFromString(await doc.async('string'), 'text/xml');
  const uses = docxPictureUses(xml);
  const images = [], skipped = [];
  const seen = new Map();
  let n = 0;
  for (const u of uses) {
    const path = target[u.id] ? 'word/' + target[u.id].replace(/^\.?\//, '').replace(/^word\//, '') : null;
    const f = path && zip.file(path);
    if (!f) continue;
    n++;
    const label = `${u.caption || `Image ${n}`}${u.sub ? ` (part ${u.sub})` : ''}`;
    if (seen.has(path)) { images.push({ ...seen.get(path), id: `img${n}`, label, reusedFile: seen.get(path).label }); continue; }
    onStep(`Reading figure ${n} of ${uses.length}`);
    if (/\.(emf|wmf)$/i.test(path)) { skipped.push({ name: `${label} (${path.split('/').pop()})`, reason: 'Vector drawing (EMF/WMF) — not a photograph, not analysed' }); continue; }
    try {
      const blob = await f.async('blob');
      const provenance = scanProvenance(new Uint8Array(await blob.arrayBuffer()));
      const bmp = await decodeBitmap(blob, path);
      if (bmp.width < MIN || bmp.height < MIN) continue;
      const { canvas, scale } = toCanvas(bmp, bmp.width, bmp.height);
      const im = { id: `img${n}`, label, source: 'docx', width: bmp.width, height: bmp.height, canvas, scale, provenance };
      seen.set(path, im);
      images.push(im);
    } catch (e) {
      skipped.push({ name: label, reason: `Could not decode the image (${path.split('/').pop()})` });
    }
  }
  return { images, skipped };
}

// ------------------------------------------------------------------ PDF

function objGet(page, name) {
  const store = name.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) resolve(null); }, 8000);
    store.get(name, v => { done = true; clearTimeout(t); resolve(v); });
  });
}

function pdfImageToCanvas(obj) {
  if (obj.bitmap) return toCanvas(obj.bitmap, obj.bitmap.width, obj.bitmap.height);
  const { width: w, height: h, data, kind } = obj;
  if (!data || !w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  if (kind === 3) id.data.set(data.subarray(0, w * h * 4));
  else if (kind === 2) { for (let i = 0, j = 0; i < w * h; i++, j += 3) { id.data[i * 4] = data[j]; id.data[i * 4 + 1] = data[j + 1]; id.data[i * 4 + 2] = data[j + 2]; id.data[i * 4 + 3] = 255; } }
  else if (kind === 1) { const row = (w + 7) >> 3; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const bit = (data[y * row + (x >> 3)] >> (7 - (x & 7))) & 1; const v = bit ? 255 : 0; const o = (y * w + x) * 4; id.data[o] = id.data[o + 1] = id.data[o + 2] = v; id.data[o + 3] = 255; } }
  else return null;
  ctx.putImageData(id, 0, 0);
  return toCanvas(c, w, h);
}

const VECTOR_PATHS = 20;   // drawing operations on a page before its captioned figures are looked for
const RENDER_SCALE = 2.5;  // a 595 pt page -> about 1490 px wide: chart lines and labels stay sharp

/** The captioned figures drawn on a PDF page: [{ caption, canvas, scale, width, height }] */
async function vectorFigures(page, text) {
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  const c = document.createElement('canvas');
  c.width = Math.round(viewport.width);
  c.height = Math.round(viewport.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  const boxes = figureBoxes(ctx.getImageData(0, 0, c.width, c.height), itemsInViewport(text.items, viewport));
  return boxes.map(b => {
    const crop = document.createElement('canvas');
    crop.width = b.w; crop.height = b.h;
    crop.getContext('2d').drawImage(c, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    return { caption: b.caption, width: b.w, height: b.h, ...toCanvas(crop, b.w, b.h) };
  });
}

async function fromPdf(file, onStep) {
  const lib = await loadPdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const images = [], skipped = [];
  const OPS = lib.OPS;
  for (let p = 1; p <= pdf.numPages; p++) {
    onStep(`Reading page ${p} of ${pdf.numPages}`);
    const page = await pdf.getPage(p);
    const ops = await page.getOperatorList();
    const names = [], inline = [];
    let paths = 0;
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) { const nm = ops.argsArray[i][0]; if (!names.includes(nm)) names.push(nm); }
      else if (fn === OPS.paintInlineImageXObject && ops.argsArray[i][0]) inline.push(ops.argsArray[i][0]); // a picture written into the page itself
      else if (fn === OPS.constructPath) paths++;
    }
    if (!names.length && !inline.length && paths < VECTOR_PATHS) { page.cleanup(); continue; }
    const text = await page.getTextContent();
    const captions = text.items.map(t => t.str).filter(s => FIG_RE.test(s)).map(s => s.match(FIG_RE)[1].replace(/^fig(?:ure)?\.?\s*/i, 'Fig. '));
    let k = 0;
    const all = names.length + inline.length;
    for (const nm of [...names, ...inline]) {
      const obj = typeof nm === 'string' ? await objGet(page, nm) : nm;
      if (!obj || (obj.width || obj.bitmap?.width || 0) < MIN || (obj.height || obj.bitmap?.height || 0) < MIN) continue;
      const cv = pdfImageToCanvas(obj);
      if (!cv) { skipped.push({ name: `Page ${p} image`, reason: 'Unsupported image encoding' }); continue; }
      k++;
      const cap = captions.length === all ? captions[k - 1] : captions.length === 1 ? captions[0] : '';
      images.push({ id: `p${p}i${k}`, label: `${cap ? cap + ' — ' : ''}page ${p}${all > 1 ? `, image ${k}` : ''}`, source: 'pdf', width: obj.width || obj.bitmap.width, height: obj.height || obj.bitmap.height, canvas: cv.canvas, scale: cv.scale });
    }
    // no picture on the page but a figure caption and a drawing: charts printed to PDF as vector graphics (published
    // articles). The page is rendered and each captioned figure cut out of it (images/vectorFigures.js)
    if (!k && captions.length && paths >= VECTOR_PATHS) {
      onStep(`Reading the drawn figures on page ${p} of ${pdf.numPages}`);
      const got = await vectorFigures(page, text).catch(() => []);
      got.forEach((f, i) => images.push({ id: `p${p}v${i + 1}`, label: `${f.caption} — page ${p} (drawn figure)`, source: 'pdf', vector: true, width: f.width, height: f.height, canvas: f.canvas, scale: f.scale }));
    }
    page.cleanup();
  }
  if (!images.length) skipped.push({ name: file.name, reason: 'No figures found: no embedded pictures, and no drawing with a "Fig." caption. A scanned PDF or figures without captions cannot be split into figures — upload the Word file or the figure files.' });
  return { images, skipped };
}

// ------------------------------------------------------------------ image files

async function fromImage(file, n) {
  const provenance = scanProvenance(new Uint8Array(await file.arrayBuffer()));
  const bmp = await decodeBitmap(file, file.name);
  const { canvas, scale } = toCanvas(bmp, bmp.width, bmp.height);
  return { id: `file${n}`, label: file.name.replace(/\.[a-z]+$/i, ''), source: 'file', width: bmp.width, height: bmp.height, canvas, scale, provenance };
}

/** files: File[] (one manuscript, or several figure files) */
export async function extractFigures(files, onStep = () => {}) {
  const images = [], skipped = [];
  let n = 0;
  for (const f of files) {
    try {
      if (/\.docx$/i.test(f.name)) { const r = await fromDocx(f, onStep); images.push(...r.images); skipped.push(...r.skipped); }
      else if (/\.pdf$/i.test(f.name)) { const r = await fromPdf(f, onStep); images.push(...r.images); skipped.push(...r.skipped); }
      else if (/\.(png|jpe?g|jfif|gif|bmp|webp|tiff?|svg)$/i.test(f.name)) images.push(await fromImage(f, ++n));
      else if (/\.doc$/i.test(f.name)) skipped.push({ name: f.name, reason: 'Old Word format (.doc) — save as .docx' });
      else skipped.push({ name: f.name, reason: 'Unsupported file type' });
    } catch (e) {
      skipped.push({ name: f.name, reason: e.message });
    }
  }
  // Unique ids when several files are combined
  const ids = new Set();
  images.forEach((im, i) => { if (ids.has(im.id)) im.id = `${im.id}-${i}`; ids.add(im.id); });
  return { images, skipped };
}

export function imageDataOf(im) {
  const ctx = im.canvas.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, im.canvas.width, im.canvas.height);
}
