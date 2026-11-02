// images/tiff.js - baseline TIFF reader for Module 5 (browsers other than Safari cannot decode TIFF, and microscopy and
// blot figures are often delivered as TIFF). First page only; strips or tiles; uncompressed, LZW, PackBits or Deflate;
// horizontal predictor; 1/8/16 bits; grey (white or black is zero), RGB(A), palette. Returns ImageData-like RGBA.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

function readIfd(dv, off, le) {
  const n = dv.getUint16(off, le), tags = {};
  for (let i = 0; i < n; i++) {
    const e = off + 2 + i * 12, tag = dv.getUint16(e, le), type = dv.getUint16(e + 2, le), count = dv.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] || 1) * count;
    const at = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
    const vals = [];
    for (let k = 0; k < Math.min(count, 1 << 20); k++) {
      const p = at + k * (TYPE_SIZE[type] || 1);
      vals.push(type === 3 ? dv.getUint16(p, le) : type === 4 ? dv.getUint32(p, le) : type === 16 ? Number(dv.getBigUint64(p, le)) : dv.getUint8(p));
    }
    tags[tag] = vals;
  }
  return tags;
}

function lzw(src) {
  const out = [];
  let dict = [], bits = 9, pos = 0, prev = null;
  const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null, null); bits = 9; };
  const read = () => {
    let v = 0;
    for (let i = 0; i < bits; i++) { const byte = src[(pos + i) >> 3]; v = (v << 1) | ((byte >> (7 - ((pos + i) & 7))) & 1); }
    pos += bits;
    return v;
  };
  reset();
  while ((pos + bits) <= src.length * 8) {
    const code = read();
    if (code === 256) { reset(); prev = null; continue; }
    if (code === 257) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const b of entry) out.push(b);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length + 1 >= (1 << bits) && bits < 12) bits++;
  }
  return new Uint8Array(out);
}

function packBits(src, expected) {
  const out = new Uint8Array(expected);
  let i = 0, o = 0;
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < expected; k++) out[o++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n && o < expected; k++) out[o++] = v; }
  }
  return out;
}

async function inflate(src) {
  const ds = new DecompressionStream('deflate');
  const buf = await new Response(new Blob([src]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

async function decompress(data, comp, expected) {
  if (comp === 1) return data;
  if (comp === 5) return lzw(data);
  if (comp === 32773) return packBits(data, expected);
  if (comp === 8 || comp === 32946) return inflate(data);
  throw new Error(`TIFF compression ${comp} is not supported — save the figure as PNG or uncompressed / LZW TIFF`);
}

/** buffer: ArrayBuffer of a .tif file -> { width, height, data: Uint8ClampedArray (RGBA) } */
export async function decodeTiff(buffer) {
  const dv = new DataView(buffer), u8 = new Uint8Array(buffer);
  const le = dv.getUint16(0) === 0x4949;
  if (!le && dv.getUint16(0) !== 0x4d4d) throw new Error('Not a TIFF file');
  if (dv.getUint16(2, le) === 43) throw new Error('BigTIFF is not supported — save the figure as PNG');
  const t = readIfd(dv, dv.getUint32(4, le), le);
  const g = (tag, d) => (t[tag] ? t[tag][0] : d);
  const w = g(256), h = g(257), bps = g(258, 1), spp = g(277, 1), comp = g(259, 1), photo = g(262, 1), pred = g(317, 1), planar = g(284, 1);
  if (!w || !h) throw new Error('TIFF without image size');
  if (planar !== 1 && spp > 1) throw new Error('Planar TIFF is not supported — save the figure as PNG');
  if (![1, 8, 16].includes(bps)) throw new Error(`${bps}-bit TIFF is not supported — save the figure as PNG`);
  const tiled = !!t[322];
  const tw = tiled ? g(322) : w, th = tiled ? g(323) : g(278, h);
  const offsets = t[tiled ? 324 : 273] || [], counts = t[tiled ? 325 : 279] || [];
  const bpp = (bps * spp) / 8, rowBytes = Math.ceil((tw * bps * spp) / 8);
  const raw = new Uint8Array(Math.ceil((w * bps * spp) / 8) * h);
  const fullRow = Math.ceil((w * bps * spp) / 8);
  const across = tiled ? Math.ceil(w / tw) : 1;
  for (let s = 0; s < offsets.length; s++) {
    const chunk = await decompress(u8.subarray(offsets[s], offsets[s] + counts[s]), comp, rowBytes * th);
    if (pred === 2 && bps === 8) for (let r = 0; r < th; r++) for (let i = bpp; i < rowBytes; i++) chunk[r * rowBytes + i] = (chunk[r * rowBytes + i] + chunk[r * rowBytes + i - bpp]) & 255;
    const x0 = tiled ? (s % across) * tw : 0, y0 = tiled ? Math.floor(s / across) * th : s * th;
    for (let r = 0; r < th && y0 + r < h; r++) {
      const take = Math.min(rowBytes, fullRow - Math.ceil((x0 * bps * spp) / 8));
      raw.set(chunk.subarray(r * rowBytes, r * rowBytes + take), (y0 + r) * fullRow + Math.ceil((x0 * bps * spp) / 8));
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  const map = t[320];
  // 16-bit: scaled by the image's own range so faint microscopy signals are not lost
  let lo = 0, hi = 65535;
  if (bps === 16) {
    lo = 65535; hi = 0;
    for (let i = 0; i < raw.length; i += 2) { const v = le ? raw[i] | (raw[i + 1] << 8) : (raw[i] << 8) | raw[i + 1]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi <= lo) hi = lo + 1;
  }
  const sample = (row, x, c) => {
    if (bps === 8) return raw[row * fullRow + x * spp + c];
    if (bps === 16) { const i = row * fullRow + (x * spp + c) * 2, v = le ? raw[i] | (raw[i + 1] << 8) : (raw[i] << 8) | raw[i + 1]; return ((v - lo) / (hi - lo)) * 255; }
    return (raw[row * fullRow + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (photo === 3 && map) { const v = raw[y * fullRow + x], n = map.length / 3; out[o] = map[v] >> 8; out[o + 1] = map[n + v] >> 8; out[o + 2] = map[2 * n + v] >> 8; }
    else if (spp >= 3) { out[o] = sample(y, x, 0); out[o + 1] = sample(y, x, 1); out[o + 2] = sample(y, x, 2); }
    else { const v = sample(y, x, 0); out[o] = out[o + 1] = out[o + 2] = photo === 0 ? 255 - v : v; }
    out[o + 3] = 255;
  }
  return { width: w, height: h, data: out };
}
