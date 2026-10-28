// figureFiles.js - figures out of files on the server (Module 5 reference databases): images embedded in a PDF,
// media of a Word file, or PNG / JPEG files. Returns RGBA images { width, height, data, label }.
// PDF: every image XObject is read straight from the file (streams are never inside object streams), so no renderer
// is needed: DCTDecode = JPEG (jpeg-js), FlateDecode = raw samples (zlib + PNG predictors) in Gray / RGB / CMYK /
// Indexed colour. Soft masks and stencil masks are skipped; JPEG 2000, CCITT and JBIG2 are reported as unsupported.
const zlib = require('zlib');
const jpeg = require('jpeg-js');

const MIN = 80; // smaller images are icons, logos or equation bitmaps (same rule as the browser)

function decodeJpeg(buf) {
  const p = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 250, tolerantDecoding: true });
  return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data.buffer, p.data.byteOffset, p.data.length) };
}

function decodePng(buf) {
  const { PNG } = require('pngjs');
  const p = PNG.sync.read(buf);
  // transparent pixels on white, as the browser draws them on a white canvas
  const d = new Uint8ClampedArray(p.data);
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] < 255) { const a = d[i + 3] / 255; for (let k = 0; k < 3; k++) d[i + k] = d[i + k] * a + 255 * (1 - a); d[i + 3] = 255; }
  return { width: p.width, height: p.height, data: d };
}

/** PNG / JPEG bytes -> RGBA image, or null for other formats */
function decodeImage(buf) {
  if (!buf || buf.length < 8) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8) return decodeJpeg(buf);
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E) return decodePng(buf);
  return null;
}

/** Any image format: PNG / JPEG directly, WebP / TIFF / GIF / BMP through sharp (flattened on white) */
async function decodeAny(buf) {
  const direct = (() => { try { return decodeImage(buf); } catch { return null; } })();
  if (direct) return direct;
  try {
    const { data, info } = await require('sharp')(buf, { limitInputPixels: 250e6 }).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) };
  } catch { return null; }
}

// ------------------------------------------------------------------ PDF

/** Index of the dictionary end ('>>' matching the '<<' at i), skipping (strings) and <hex> */
function dictEnd(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '(') { let par = 1; for (k++; k < s.length && par; k++) { if (s[k] === '\\') k++; else if (s[k] === '(') par++; else if (s[k] === ')') par--; } k--; continue; }
    if (c === '<' && s[k + 1] === '<') { depth++; k++; continue; }
    if (c === '>' && s[k + 1] === '>') { depth--; k++; if (!depth) return k + 1; continue; }
    if (c === '<') { const e = s.indexOf('>', k); if (e < 0) return -1; k = e; }
  }
  return -1;
}

const num = (dict, key) => { const m = dict.match(new RegExp(`/${key}\\s+(-?\\d+)(?!\\s+\\d+\\s+R)`)); return m ? parseInt(m[1], 10) : null; };
const ref = (dict, key) => { const m = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`)); return m ? parseInt(m[1], 10) : null; };

function parsePdf(buf) {
  const s = buf.toString('latin1');
  const objs = new Map();   // object number -> offset of "N G obj"
  for (const m of s.matchAll(/(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g)) objs.set(parseInt(m[1], 10), m.index + m[0].length);
  /** Body of an indirect object (dictionary or plain value) */
  const body = n => {
    const at = objs.get(n);
    if (at === undefined) return null;
    const end = s.indexOf('endobj', at);
    return s.slice(at, end < 0 ? at + 4000 : end).trim();
  };
  const dictOf = n => { const b = body(n); if (!b) return null; const i = b.indexOf('<<'); return i < 0 ? null : b.slice(i, dictEnd(b, i)); };
  const streamOf = n => {
    const at = objs.get(n);
    if (at === undefined) return null;
    const i = s.indexOf('<<', at), e = dictEnd(s, i);
    if (i < 0 || e < 0) return null;
    const dict = s.slice(i, e);
    const m = /^\s*stream\r?\n/.exec(s.slice(e, e + 20));
    if (!m) return { dict, data: null };
    const start = e + m[0].length;
    let len = num(dict, 'Length');
    if (len === null) { const r = ref(dict, 'Length'); const v = r !== null ? body(r) : null; len = v && /^\d+$/.test(v) ? parseInt(v, 10) : null; }
    let end = len !== null && s.slice(start + len, start + len + 30).includes('endstream') ? start + len : s.indexOf('endstream', start);
    if (end < 0) return { dict, data: null };
    if (len === null) while (end > start && (s[end - 1] === '\n' || s[end - 1] === '\r')) end--;
    return { dict, data: buf.subarray(start, end) };
  };
  return { s, objs, body, dictOf, streamOf };
}

const names = v => [...String(v || '').matchAll(/\/([A-Za-z0-9]+)/g)].map(m => m[1]);

/** Colour space of an image dictionary: { comps, kind: gray|rgb|cmyk|indexed, base, palette } */
function colorSpace(pdf, dict) {
  let cs = (dict.match(/\/ColorSpace\s*(\/[A-Za-z0-9]+|\[[^\]]*\]|\d+\s+\d+\s+R)/) || [])[1] || '';
  for (let hop = 0; hop < 3; hop++) { const r = cs.match(/^(\d+)\s+\d+\s+R$/); if (!r) break; cs = (pdf.body(parseInt(r[1], 10)) || '').trim(); }
  const n = names(cs);
  const simple = name => ({ DeviceGray: ['gray', 1], CalGray: ['gray', 1], G: ['gray', 1], DeviceRGB: ['rgb', 3], CalRGB: ['rgb', 3], RGB: ['rgb', 3], Lab: ['rgb', 3], DeviceCMYK: ['cmyk', 4], CMYK: ['cmyk', 4] }[name]);
  if (n[0] === 'ICCBased') {
    const r = cs.match(/ICCBased\s+(\d+)\s+\d+\s+R/);
    const d = r ? pdf.dictOf(parseInt(r[1], 10)) : null;
    const N = d ? num(d, 'N') : null;
    return N === 1 ? { kind: 'gray', comps: 1 } : N === 4 ? { kind: 'cmyk', comps: 4 } : N === 3 ? { kind: 'rgb', comps: 3 } : { kind: 'unknown', comps: null };
  }
  if (n[0] === 'Indexed' || n[0] === 'I') {
    const baseName = n[1] === 'ICCBased' ? null : n[1];
    let base = simple(baseName) || ['rgb', 3];
    if (n[1] === 'ICCBased') { const r = cs.match(/ICCBased\s+(\d+)\s+\d+\s+R/); const d = r ? pdf.dictOf(parseInt(r[1], 10)) : null; const N = d ? num(d, 'N') : 3; base = N === 1 ? ['gray', 1] : N === 4 ? ['cmyk', 4] : ['rgb', 3]; }
    // lookup table: <hex>, (string) or a stream reference, after the hival number
    let palette = null;
    const tail = cs.replace(/^\[\s*\/(?:Indexed|I)\s*(\/[A-Za-z0-9]+|\[[^\]]*\]|\d+\s+\d+\s+R)\s*\d+\s*/, '');
    const hex = tail.match(/^<([0-9A-Fa-f\s]*)>/);
    const str = tail.match(/^\(/);
    const r = tail.match(/^(\d+)\s+\d+\s+R/);
    if (hex) palette = Buffer.from(hex[1].replace(/\s+/g, ''), 'hex');
    else if (str) {
      const bytes = [];
      for (let k = 1, par = 1; k < tail.length && par; k++) {
        let c = tail[k];
        if (c === '\\') {
          const nx = tail[++k];
          if (/[0-7]/.test(nx)) { let o = nx; while (o.length < 3 && /[0-7]/.test(tail[k + 1])) o += tail[++k]; bytes.push(parseInt(o, 8)); continue; }
          c = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[nx] ?? nx;
          if (nx === '\r' || nx === '\n') continue;
        } else if (c === '(') par++;
        else if (c === ')' && --par === 0) break;
        bytes.push(c.charCodeAt(0) & 255);
      }
      palette = Buffer.from(bytes);
    } else if (r) {
      const st = pdf.streamOf(parseInt(r[1], 10));
      if (st?.data) palette = names(st.dict.match(/\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/)?.[1]).includes('FlateDecode') ? inflate(st.data) : Buffer.from(st.data);
    }
    return { kind: 'indexed', comps: 1, base: base[0], baseComps: base[1], palette };
  }
  const sm = simple(n[0]);
  return sm ? { kind: sm[0], comps: sm[1] } : { kind: 'unknown', comps: null };
}

function inflate(data) {
  try { return zlib.inflateSync(data); } catch (e) { return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
}

/** Undo PNG row predictors (Predictor >= 10) */
function unpredict(data, rowBytes, bpp, rows) {
  const out = Buffer.alloc(rowBytes * rows);
  for (let y = 0; y < rows; y++) {
    const ft = data[y * (rowBytes + 1)], src = y * (rowBytes + 1) + 1, dst = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[src + x] || 0;
      const a = x >= bpp ? out[dst + x - bpp] : 0, b = y ? out[dst - rowBytes + x] : 0, c = y && x >= bpp ? out[dst - rowBytes + x - bpp] : 0;
      let v = raw;
      if (ft === 1) v = raw + a;
      else if (ft === 2) v = raw + b;
      else if (ft === 3) v = raw + ((a + b) >> 1);
      else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[dst + x] = v & 255;
    }
  }
  return out;
}

function samplesToRGBA(raw, w, h, bpc, cs, decodeInvert) {
  const comps = cs.comps;
  const rowBytes = Math.ceil(w * comps * bpc / 8);
  const out = new Uint8ClampedArray(w * h * 4);
  const max = (1 << bpc) - 1;
  const sample = (row, i) => {
    if (bpc === 8) return raw[row + i];
    if (bpc === 16) return raw[row + i * 2];
    const bit = i * bpc, byte = raw[row + (bit >> 3)];
    return (byte >> (8 - bpc - (bit & 7))) & max;
  };
  const to255 = v => (bpc === 8 || bpc === 16 ? v : Math.round(v * 255 / max));
  for (let y = 0; y < h; y++) {
    const row = y * (bpc === 16 ? w * comps * 2 : rowBytes);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r, g, b;
      if (cs.kind === 'indexed') {
        const idx = sample(row, x), p = cs.palette, bc = cs.baseComps, j = idx * bc;
        if (cs.base === 'gray') r = g = b = p[j] ?? 0;
        else if (cs.base === 'cmyk') { const k = 1 - (p[j + 3] ?? 0) / 255; r = 255 * (1 - (p[j] ?? 0) / 255) * k; g = 255 * (1 - (p[j + 1] ?? 0) / 255) * k; b = 255 * (1 - (p[j + 2] ?? 0) / 255) * k; }
        else { r = p[j] ?? 0; g = p[j + 1] ?? 0; b = p[j + 2] ?? 0; }
      } else {
        const v = k => { const s = to255(sample(row, x * comps + k)); return decodeInvert ? 255 - s : s; };
        if (comps === 1) r = g = b = v(0);
        else if (comps === 3) { r = v(0); g = v(1); b = v(2); }
        else { const k = 1 - v(3) / 255; r = 255 * (1 - v(0) / 255) * k; g = 255 * (1 - v(1) / 255) * k; b = 255 * (1 - v(2) / 255) * k; }
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}

/** Images embedded in a PDF: { images: [{ width, height, data, label }], skipped: [{ name, reason }] } */
function pdfImages(buf, { max = 60 } = {}) {
  const pdf = parsePdf(buf);
  const masks = new Set([...pdf.s.matchAll(/\/(?:SMask|Mask)\s+(\d+)\s+\d+\s+R/g)].map(m => parseInt(m[1], 10)));
  const images = [], skipped = [];
  const seen = new Set();
  const candidates = [...pdf.objs.keys()].filter(n => !masks.has(n)).sort((a, b) => pdf.objs.get(a) - pdf.objs.get(b));
  for (const n of candidates) {
    if (images.length >= max) break;
    const at = pdf.objs.get(n);
    const head = pdf.s.slice(at, at + 1200);
    if (!/\/Subtype\s*\/Image/.test(head.slice(0, head.indexOf('stream') > 0 ? head.indexOf('stream') : head.length))) continue;
    const st = pdf.streamOf(n);
    if (!st?.data) continue;
    const d = st.dict;
    if (/\/ImageMask\s+true/.test(d)) continue;
    const w = num(d, 'Width') ?? num(d, 'W'), h = num(d, 'Height') ?? num(d, 'H');
    if (!w || !h || w < MIN || h < 4) continue;   // thin strips are kept for stitching; small images dropped below
    const name = `Image object ${n}`;
    const filters = names((d.match(/\/Filter\s*(\/[A-Za-z0-9]+|\[[^\]]*\])/) || [])[1]);
    try {
      let data = Buffer.from(st.data);
      let img = null;
      for (const f of filters) {
        if (f === 'FlateDecode' || f === 'Fl') data = inflate(data);
        else if (f === 'DCTDecode' || f === 'DCT') { img = decodeJpeg(data); break; }
        else if (f === 'JPXDecode') throw new Error('JPEG 2000 image');
        else if (f === 'CCITTFaxDecode' || f === 'JBIG2Decode') throw new Error('black-and-white fax / JBIG2 image');
        else if (f !== 'ASCII85Decode' && f !== 'ASCIIHexDecode') throw new Error(`unsupported filter ${f}`);
        else if (f === 'ASCIIHexDecode') data = Buffer.from(data.toString('latin1').replace(/[^0-9A-Fa-f]/g, ''), 'hex');
        else throw new Error('ASCII85 image');
      }
      if (!img) {
        const bpc = num(d, 'BitsPerComponent') ?? num(d, 'BPC') ?? 8;
        let cs = colorSpace(pdf, d);
        if (cs.kind === 'indexed' && !cs.palette) throw new Error('indexed colours without a readable palette');
        const pred = num(d, 'Predictor') ?? 1;
        if (!cs.comps) {
          // colour space in an object stream: infer the number of components from the data size
          const per = pred >= 10 ? ((data.length / h) - 1) / w : data.length / (w * h);
          const c = Math.round(per * 8 / bpc);
          cs = { kind: c === 1 ? 'gray' : c === 4 ? 'cmyk' : 'rgb', comps: [1, 3, 4].includes(c) ? c : 3 };
        }
        const rowBytes = Math.ceil(w * cs.comps * bpc / 8);
        if (pred >= 10) data = unpredict(data, rowBytes, Math.max(1, Math.ceil(cs.comps * bpc / 8)), h);
        else if (pred === 2) throw new Error('TIFF predictor');
        if (data.length < rowBytes * h) throw new Error('truncated image data');
        const dec = d.match(/\/Decode\s*\[\s*1(?:\.0)?\s+0/);
        img = { width: w, height: h, data: samplesToRGBA(data, w, h, bpc, cs, !!dec && cs.kind !== 'indexed') };
      }
      if (img.width < MIN) continue;
      const key = `${img.width}x${img.height}:${st.data.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push(img);
    } catch (e) {
      skipped.push({ name, reason: e.message });
    }
  }
  return { images: stitchStrips(images).filter(im => im.height >= MIN).map((im, i) => ({ ...im, label: `Image ${i + 1}` })), skipped };
}

/**
 * Publishing software often stores one large figure as a run of horizontal strips (e.g. 27 images of 4638 x 216 px).
 * Consecutive images of the same width that are much wider than tall are stacked back into one figure.
 */
/** Mean grey difference between the bottom row of a and the top row of b */
function seam(a, b) {
  const w = a.width, ya = (a.height - 1) * w * 4;
  let s = 0, n = 0;
  for (let x = 0; x < w; x += 3) {
    const p = ya + x * 4, q = x * 4;
    s += Math.abs((a.data[p] + a.data[p + 1] + a.data[p + 2]) - (b.data[q] + b.data[q + 1] + b.data[q + 2])) / 3;
    n++;
  }
  return s / n;
}

function stitchStrips(list) {
  const out = [];
  for (let i = 0; i < list.length;) {
    const a = list[i];
    let j = i + 1;
    if (a.height * 3 < a.width) while (j < list.length && list[j].width === a.width && list[j].height * 3 < list[j].width) j++;
    if (j - i < 2) { out.push(a); i++; continue; }
    // the strips are not always stored top to bottom: keep the order whose joins are continuous (bottom row of one
    // strip ~ top row of the next); if neither order is, the images are separate figures
    const fwd = list.slice(i, j), rev = [...fwd].reverse();
    const cost = r => r.slice(1).reduce((s, x, k) => s + seam(r[k], x), 0) / (r.length - 1);
    const cf = cost(fwd), cr = cost(rev);
    if (Math.min(cf, cr) > 18) { out.push(...fwd); i = j; continue; }
    const run = cf <= cr ? fwd : rev, H = run.reduce((s, x) => s + x.height, 0);
    const data = new Uint8ClampedArray(a.width * H * 4);
    let y = 0;
    for (const x of run) { data.set(x.data.subarray(0, x.width * x.height * 4), y * a.width * 4); y += x.height; }
    out.push({ width: a.width, height: H, data, strips: run.length });
    i = j;
  }
  return out;
}

// ------------------------------------------------------------------ Word

async function docxImages(buf) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const images = [], skipped = [];
  const media = Object.keys(zip.files).filter(f => /^word\/media\//.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const f of media) {
    const name = f.split('/').pop();
    if (!/\.(png|jpe?g|tiff?|gif|bmp|webp)$/i.test(name)) { skipped.push({ name, reason: 'Vector drawing (EMF / WMF / SVG), not analysed' }); continue; }
    try {
      const img = await decodeAny(await zip.file(f).async('nodebuffer'));
      if (img && img.width >= MIN && img.height >= MIN) images.push({ ...img, label: `Image ${images.length + 1}` });
    } catch (e) { skipped.push({ name, reason: 'Could not decode the image' }); }
  }
  return { images, skipped };
}

/** Any supported file -> { images, skipped } */
async function figuresOfFile(name, buf) {
  if (/\.pdf$/i.test(name) || buf.slice(0, 5).toString() === '%PDF-') return pdfImages(buf);
  if (/\.docx$/i.test(name)) return docxImages(buf);
  if (/\.(png|jpe?g|tiff?|gif|bmp|webp)$/i.test(name)) {
    const img = await decodeAny(buf);
    return img ? { images: [{ ...img, label: name.replace(/\.[a-z]+$/i, '') }], skipped: [] } : { images: [], skipped: [{ name, reason: 'Could not decode the image' }] };
  }
  return { images: [], skipped: [{ name, reason: 'Unsupported file type (PDF, Word .docx, PNG, JPEG, TIFF or WebP)' }] };
}

module.exports = { pdfImages, docxImages, decodeImage, decodeAny, figuresOfFile };
