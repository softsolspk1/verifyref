// archiveReader.js - read files out of large .zip and .tar archives one at a time, without loading the archive into
// memory (RSIID 500 MB zip, BioFors 2 GB tar, BINDER 680 MB zip). Used to index the public image-integrity datasets.
const fs = require('fs');
const zlib = require('zlib');

/** Entries of a zip file from its central directory: [{ name, size, method, offset, csize }] (ZIP64 sizes supported) */
function zipEntries(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 66000 + 22);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('Not a zip file');
    let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xFFFFFFFF || count === 0xFFFF) {
      // ZIP64 end of central directory
      const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
      const z64 = Buffer.alloc(56);
      fs.readSync(fd, z64, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
      count = Number(z64.readBigUInt64LE(32)); cdSize = Number(z64.readBigUInt64LE(40)); cdOffset = Number(z64.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const out = [];
    for (let p = 0, i = 0; i < count && p < cd.length; i++) {
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      // ZIP64 extra field (0x0001): sizes and offset that did not fit in 32 bits
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
        if (id === 1) {
          let q = e + 4;
          if (usize === 0xFFFFFFFF) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xFFFFFFFF) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xFFFFFFFF) { offset = Number(cd.readBigUInt64LE(q)); }
        }
        e += 4 + len;
      }
      if (!name.endsWith('/')) out.push({ name, size: usize, csize, method, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally { fs.closeSync(fd); }
}

/** Content of one zip entry (stored or deflated) */
function zipRead(file, entry) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(30);
    fs.readSync(fd, head, 0, 30, entry.offset);
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    const data = Buffer.alloc(entry.csize);
    fs.readSync(fd, data, 0, entry.csize, start);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported zip compression (${entry.method})`);
  } finally { fs.closeSync(fd); }
}

/**
 * Stream a tar file: calls onFile(name, buffer) for every regular file whose name passes `want(name)`, in archive
 * order (awaited, so the reader waits while each file is processed). Supports ustar long names (prefix field).
 */
async function tarEach(file, want, onFile) {
  const stream = fs.createReadStream(file, { highWaterMark: 4 << 20 });
  let buf = Buffer.alloc(0);
  let need = null;   // { name, size, padded, keep }
  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (!need) {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every(b => b === 0)) continue;   // end-of-archive padding
        const str = (o, n) => h.toString('utf8', o, o + n).replace(/\0[\s\S]*$/, '');
        const size = parseInt(str(124, 12).trim() || '0', 8) || 0;
        const type = String.fromCharCode(h[156] || 48);
        const prefix = str(345, 155);
        const name = (prefix ? `${prefix}/` : '') + str(0, 100);
        need = { name, size, padded: Math.ceil(size / 512) * 512, keep: (type === '0' || type === '\0') && want(name) };
      }
      if (buf.length < need.padded) break;
      const data = need.keep ? Buffer.from(buf.subarray(0, need.size)) : null;
      buf = buf.subarray(need.padded);
      const done = need;
      need = null;
      if (data) await onFile(done.name, data);
    }
  }
}

module.exports = { zipEntries, zipRead, tarEach };
