// uploads.js - file uploads up to MAX_UPLOAD_MB. Small files arrive in the request (multer); large ones go from the
// browser straight to Cloudflare R2 with a presigned URL (Vercel stops request bodies at 4.5 MB), and the form carries
// "r2:<field>" = { key, name, type, size } instead. The middleware fetches those objects back so routes see the same
// req.file / req.files either way. Signing is AWS SigV4 (R2 speaks the S3 API), done here without the AWS SDK.
const crypto = require('crypto');
const multer = require('multer');
const cfg = require('./config');

const MAX_BYTES = cfg.MAX_UPLOAD_MB * 1024 * 1024;
const R2 = cfg.R2;
const enabled = () => !!(R2.accountId && R2.accessKeyId && R2.secretAccessKey && R2.bucket);

// ------------------------------------------------------------------ SigV4 presigned URLs

const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const rfc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Presigned URL for one object. headers: extra headers to sign (lower-case name -> value) */
function presign(method, key, { expires = 900, headers = {}, query: extra = {} } = {}) {
  const host = `${R2.accountId}.r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  const all = { host, ...headers };
  const names = Object.keys(all).sort();
  const path = `/${R2.bucket}/${key.split('/').map(rfc3986).join('/')}`;
  const query = Object.entries({
    ...extra,   // e.g. multipart upload: uploads, partNumber, uploadId
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${R2.accessKeyId}/${scope}`, 'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': names.join(';')
  }).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`).join('&');
  const canonical = [method, path, query, names.map(n => `${n}:${String(all[n]).trim()}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let k = hmac(`AWS4${R2.secretAccessKey}`, amzDate.slice(0, 8));
  for (const part of ['auto', 's3', 'aws4_request']) k = hmac(k, part);
  return `https://${host}${path}?${query}&X-Amz-Signature=${hmac(k, toSign).toString('hex')}`;
}

/** Upload slot for a signed-in user. The exact size is signed, so R2 refuses a different (larger) body. */
function createUpload(userId, { name, size, type }) {
  size = Number(size);
  if (!enabled()) return { enabled: false };
  if (!Number.isInteger(size) || size <= 0) throw Object.assign(new Error('Invalid file size.'), { status: 400 });
  if (size > MAX_BYTES) throw Object.assign(new Error(`The file is too large (limit ${cfg.MAX_UPLOAD_MB} MB).`), { status: 413 });
  const safe = String(name || 'file').replace(/[^\w.\-]+/g, '_').slice(-120);
  const key = `uploads/${userId}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${safe}`;
  return { enabled: true, key, url: presign('PUT', key, { headers: { 'content-length': String(size) } }), maxBytes: MAX_BYTES };
}

async function getObject(key) {
  const r = await fetch(presign('GET', key));
  if (!r.ok) throw Object.assign(new Error(`The uploaded file could not be read from storage (${r.status}). Upload it again.`), { status: 400 });
  return Buffer.from(await r.arrayBuffer());
}

async function putObject(key, buffer, contentType = 'application/octet-stream') {
  if (!enabled()) throw new Error('Cloudflare R2 is not configured.');
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const url = presign('PUT', key, { headers: { 'content-length': String(buf.length), 'content-type': contentType } });
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'content-length': String(buf.length),
      'content-type': contentType
    },
    body: buf
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`R2 upload failed (${res.status}): ${errText}`);
  }
  return { ok: true, key, size: buf.length };
}

/**
 * Multipart upload of a large local file (S3 API): 64 MB parts read one at a time, each retried up to 4 times, so a
 * dropped connection costs one part instead of the whole multi-gigabyte upload.
 */
async function putFileMultipart(key, file, size, contentType = 'application/octet-stream', { partSize = 64 << 20, onPart = () => {} } = {}) {
  if (!enabled()) throw new Error('Cloudflare R2 is not configured.');
  const fs = require('fs');
  const init = await fetch(presign('POST', key, { query: { uploads: '' }, headers: { 'content-type': contentType } }), { method: 'POST', headers: { 'content-type': contentType } });
  const initText = await init.text();
  const uploadId = (initText.match(/<UploadId>([^<]+)<\/UploadId>/) || [])[1];
  if (!init.ok || !uploadId) throw new Error(`R2 multipart start failed (${init.status}): ${initText.slice(0, 200)}`);
  const parts = [];
  const fd = fs.openSync(file, 'r');
  try {
    const n = Math.ceil(size / partSize);
    for (let i = 0; i < n; i++) {
      const len = Math.min(partSize, size - i * partSize);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, i * partSize);
      let etag = null, lastErr = null;
      for (let attempt = 1; attempt <= 4 && !etag; attempt++) {
        try {
          const url = presign('PUT', key, { expires: 3600, query: { partNumber: String(i + 1), uploadId }, headers: { 'content-length': String(len) } });
          const r = await fetch(url, { method: 'PUT', headers: { 'content-length': String(len) }, body: buf });
          if (!r.ok) throw new Error(`part ${i + 1}: HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
          etag = r.headers.get('etag');
        } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 2000 * attempt)); }
      }
      if (!etag) {
        await fetch(presign('DELETE', key, { query: { uploadId } }), { method: 'DELETE' }).catch(() => {});
        throw new Error(`R2 multipart upload failed: ${lastErr?.message}`);
      }
      parts.push(`<Part><PartNumber>${i + 1}</PartNumber><ETag>${etag}</ETag></Part>`);
      onPart(i + 1, n);
    }
  } finally { fs.closeSync(fd); }
  const body = `<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`;
  const done = await fetch(presign('POST', key, { query: { uploadId } }), { method: 'POST', body });
  const doneText = await done.text();
  if (!done.ok || /<Error>/.test(doneText)) throw new Error(`R2 multipart completion failed (${done.status}): ${doneText.slice(0, 200)}`);
  return { ok: true, key, size, parts: parts.length };
}

/** Upload a local file without loading it into memory (large dataset archives) */
function putFileStream(key, file, size, contentType = 'application/octet-stream') {
  if (!enabled()) return Promise.reject(new Error('Cloudflare R2 is not configured.'));
  const https = require('https');
  const fs = require('fs');
  const url = new URL(presign('PUT', key, { expires: 3600, headers: { 'content-length': String(size), 'content-type': contentType } }));
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'PUT', headers: { 'content-length': String(size), 'content-type': contentType } }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => (res.statusCode < 300 ? resolve({ ok: true, key, size }) : reject(new Error(`R2 upload failed (${res.statusCode}): ${body.slice(0, 300)}`))));
    });
    req.on('error', reject);
    fs.createReadStream(file).on('error', reject).pipe(req);
  });
}

async function deleteObject(key) {
  if (!enabled() || !key) return;
  await fetch(presign('DELETE', key), { method: 'DELETE' }).catch(() => {});
}

// ------------------------------------------------------------------ middleware

const ownKey = (req, key) => typeof key === 'string' && key.startsWith(`uploads/${req.user?.id}/`) && !key.includes('..');

/** Turn "r2:<field>" form values into multer-style file objects. Objects are deleted when the response ends,
 * unless a route keeps one for a background job (fileRef marks it). */
async function hydrate(req, res, single) {
  const b = req.body || {};
  const fields = Object.keys(b).filter(k => k.startsWith('r2:'));
  if (!fields.length) return;
  if (!enabled()) throw Object.assign(new Error('Large-file storage is not configured.'), { status: 400 });
  const files = [];
  for (const f of fields) {
    for (const raw of [].concat(b[f])) {
      const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!ownKey(req, m?.key)) throw Object.assign(new Error('Invalid upload reference.'), { status: 400 });
      files.push({ fieldname: f.slice(3), originalname: String(m.name || 'file'), mimetype: String(m.type || 'application/octet-stream'), r2Key: m.key });
    }
    delete b[f];
  }
  res.on('finish', () => { for (const f of files) if (!f.r2Keep) deleteObject(f.r2Key); });
  await Promise.all(files.map(async f => {
    f.buffer = await getObject(f.r2Key);
    f.size = f.buffer.length;
    if (f.size > MAX_BYTES) throw Object.assign(new Error(`The file is too large (limit ${cfg.MAX_UPLOAD_MB} MB).`), { status: 413 });
  }));
  for (const f of files) {
    if (single) { if (f.fieldname === single) req.file = f; continue; }
    req.files = req.files || {};
    (req.files[f.fieldname] = req.files[f.fieldname] || []).push(f);
  }
}

/** Drop-in for multer({ storage: memoryStorage, limits }): .single(name) and .fields(spec) also accept R2 uploads */
function upload(limits = {}) {
  const m = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, ...limits } });
  const after = single => (req, res, next) => hydrate(req, res, single).then(() => next(), next);
  return {
    single: name => [m.single(name), after(name)],
    fields: spec => [m.fields(spec), after(null)]
  };
}

// ------------------------------------------------------------------ files kept for background jobs

/** Job input for an uploaded file: an R2 reference when it came through R2 (kept until the job ends), else base64 */
function fileRef(f) {
  if (!f) return null;
  if (f.r2Key) { f.r2Keep = true; return { name: f.originalname, r2Key: f.r2Key }; }
  return { name: f.originalname, base64: f.buffer.toString('base64') };
}

const loadFile = ref => (ref.r2Key ? getObject(ref.r2Key) : Promise.resolve(Buffer.from(ref.base64, 'base64')));
const dropFiles = refs => Promise.all([].concat(refs || []).filter(r => r?.r2Key).map(r => deleteObject(r.r2Key)));

module.exports = { upload, createUpload, fileRef, loadFile, dropFiles, enabled, MAX_BYTES, presign, putObject, putFileStream, putFileMultipart, getObject, deleteObject };
