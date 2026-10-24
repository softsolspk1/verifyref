// images/extract.js - figures out of a manuscript, in the browser: Word (.docx) media in document order with their
// "Figure n" captions, images embedded in PDF pages (pdf.js), or separate image files. Returns canvases scaled to
// at most MAX px on the longest side, plus a list of what could not be read.
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

const FIG_RE = /^\s*(fig(?:ure)?\.?\s*[\dIVX]+[a-z]?)/i;

// ------------------------------------------------------------------ Word

async function fromDocx(file, onStep) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(file);
  const doc = zip.file('word/document.xml');
  if (!doc) throw new Error('This is not a Word document.');
  const rels = new DOMParser().parseFromString(await zip.file('word/_rels/document.xml.rels').async('string'), 'text/xml');
  const target = {};
  for (const r of rels.getElementsByTagName('Relationship')) target[r.getAttribute('Id')] = r.getAttribute('Target');
  const xml = new DOMParser().parseFromString(await doc.async('string'), 'text/xml');
  const paras = [...xml.getElementsByTagName('w:p')];
  const textOf = p => [...p.getElementsByTagName('w:t')].map(t => t.textContent).join('');
  // Images in document order, with the nearest "Figure n" caption (same paragraph or the next three / previous one)
  const uses = [];
  paras.forEach((p, i) => {
    const ids = [...p.getElementsByTagName('a:blip')].map(b => b.getAttribute('r:embed')).concat([...p.getElementsByTagName('v:imagedata')].map(b => b.getAttribute('r:id'))).filter(Boolean);
    if (!ids.length) return;
    let caption = '';
    for (const j of [i, i + 1, i + 2, i + 3, i - 1]) {
      const t = paras[j] ? textOf(paras[j]) : '';
      const m = t.match(FIG_RE);
      if (m) { caption = m[1].replace(/^fig(?:ure)?\.?\s*/i, 'Fig. '); break; }
    }
    ids.forEach((id, k) => uses.push({ id, caption, sub: ids.length > 1 ? k + 1 : 0 }));
  });
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
    if (/\.(emf|wmf|svg)$/i.test(path)) { skipped.push({ name: `${label} (${path.split('/').pop()})`, reason: 'Vector drawing (EMF/WMF/SVG) — not a photograph, not analysed' }); continue; }
    if (/\.tiff?$/i.test(path)) { skipped.push({ name: `${label} (${path.split('/').pop()})`, reason: 'TIFF cannot be read by the browser — convert the figure to PNG or JPEG' }); continue; }
    try {
      const bmp = await createImageBitmap(await f.async('blob'));
      if (bmp.width < MIN || bmp.height < MIN) continue;
      const { canvas, scale } = toCanvas(bmp, bmp.width, bmp.height);
      const im = { id: `img${n}`, label, source: 'docx', width: bmp.width, height: bmp.height, canvas, scale };
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

async function fromPdf(file, onStep) {
  const lib = await loadPdfjs();
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const images = [], skipped = [];
  const OPS = lib.OPS;
  for (let p = 1; p <= pdf.numPages; p++) {
    onStep(`Reading page ${p} of ${pdf.numPages}`);
    const page = await pdf.getPage(p);
    const ops = await page.getOperatorList();
    const names = [];
    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) { const nm = ops.argsArray[i][0]; if (!names.includes(nm)) names.push(nm); }
    }
    if (!names.length) continue;
    const text = await page.getTextContent();
    const captions = text.items.map(t => t.str).filter(s => FIG_RE.test(s)).map(s => s.match(FIG_RE)[1].replace(/^fig(?:ure)?\.?\s*/i, 'Fig. '));
    let k = 0;
    for (const nm of names) {
      const obj = await objGet(page, nm);
      if (!obj || (obj.width || obj.bitmap?.width || 0) < MIN || (obj.height || obj.bitmap?.height || 0) < MIN) continue;
      const cv = pdfImageToCanvas(obj);
      if (!cv) { skipped.push({ name: `Page ${p} image`, reason: 'Unsupported image encoding' }); continue; }
      k++;
      const cap = captions.length === names.length ? captions[k - 1] : captions.length === 1 ? captions[0] : '';
      images.push({ id: `p${p}i${k}`, label: `${cap ? cap + ' — ' : ''}page ${p}${names.length > 1 ? `, image ${k}` : ''}`, source: 'pdf', width: obj.width || obj.bitmap.width, height: obj.height || obj.bitmap.height, canvas: cv.canvas, scale: cv.scale });
    }
    page.cleanup();
  }
  if (!images.length) skipped.push({ name: file.name, reason: 'No embedded images found. Figures drawn as vector graphics, or a scanned PDF, cannot be split into figures — upload the Word file or the figure files.' });
  return { images, skipped };
}

// ------------------------------------------------------------------ image files

async function fromImage(file, n) {
  const bmp = await createImageBitmap(file);
  const { canvas, scale } = toCanvas(bmp, bmp.width, bmp.height);
  return { id: `file${n}`, label: file.name.replace(/\.[a-z]+$/i, ''), source: 'file', width: bmp.width, height: bmp.height, canvas, scale };
}

/** files: File[] (one manuscript, or several figure files) */
export async function extractFigures(files, onStep = () => {}) {
  const images = [], skipped = [];
  let n = 0;
  for (const f of files) {
    try {
      if (/\.docx$/i.test(f.name)) { const r = await fromDocx(f, onStep); images.push(...r.images); skipped.push(...r.skipped); }
      else if (/\.pdf$/i.test(f.name)) { const r = await fromPdf(f, onStep); images.push(...r.images); skipped.push(...r.skipped); }
      else if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)) images.push(await fromImage(f, ++n));
      else if (/\.tiff?$/i.test(f.name)) skipped.push({ name: f.name, reason: 'TIFF cannot be read by the browser — save the figure as PNG or JPEG' });
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
