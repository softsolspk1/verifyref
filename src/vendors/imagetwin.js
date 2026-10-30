// vendors/imagetwin.js - Module 5.7: the ImageTwin REST API, for the two checks that cannot be built in-house: comparison
// with ImageTwin's database of published figures and AI-generated image detection (it also reports alterations and
// duplicates inside the manuscript). Implemented from the public API documentation:
//   https://user-manual.imagetwin.ai/api-documentation   (copy: data/new/imagetwin/raw/it_manual_api.json)
//   POST /v1/scan            one document (.pdf, .docx; < 30 MB, < 50 pages) or up to 25 images (< 20 MB each)
//   GET  /v1/result/{scanId} 202 while running, 200 with counts + PDF report / web result links (kept 90 days)
//   /v1/sandbox/...          free, predefined responses (for testing the connection)
// Configuration (platform only; the desktop goes through the platform): IMAGETWIN_API_KEY, from the PJPS ImageTwin
// account (Account > API Access, after ImageTwin activates API access), and IMAGETWIN_SANDBOX=1 to use the sandbox.
// Figures leave PJPS systems, so nothing is sent unless the editor asks for it per manuscript; every scan is recorded.

const BASE = 'https://api.imagetwin.ai/v1';
const DOC_TYPES = /\.(pdf|docx)$/i;
const IMAGE_TYPES = /\.(jpe?g|png|gif|jfif|bmp|tiff?|svg|webp)$/i;
const MAX_DOC = 30 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const MAX_IMAGES = 25;

const apiKey = () => process.env.IMAGETWIN_API_KEY || '';
const sandbox = () => /^(1|true|yes)$/i.test(process.env.IMAGETWIN_SANDBOX || '');
const configured = () => !!apiKey();

class VendorError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

const STATUS_TEXT = {
  400: 'ImageTwin refused the files (invalid request, or a size / page limit was exceeded)',
  401: 'ImageTwin refused the API key (check IMAGETWIN_API_KEY; generating a new key invalidates the old one)',
  404: 'ImageTwin has no result for this scan (results are kept for 90 days)',
  429: 'Too many requests to ImageTwin - try again in a minute',
  500: 'ImageTwin could not process the files',
  503: 'ImageTwin is unavailable or under maintenance',
  504: 'ImageTwin is unavailable or under maintenance'
};

/** Check the files against the documented limits; returns 'document' or 'images' */
function validate(files) {
  if (!files.length) throw new VendorError('No file to send.', 400);
  const docs = files.filter(f => DOC_TYPES.test(f.name));
  if (docs.length) {
    if (files.length > 1) throw new VendorError('ImageTwin takes one document (PDF or Word) or up to 25 image files per scan, not both.', 400);
    if (docs[0].buffer.length >= MAX_DOC) throw new VendorError('ImageTwin accepts documents under 30 MB.', 400);
    return 'document';
  }
  const bad = files.find(f => !IMAGE_TYPES.test(f.name));
  if (bad) throw new VendorError(`ImageTwin does not accept this file type: ${bad.name}`, 400);
  if (files.length > MAX_IMAGES) throw new VendorError(`ImageTwin accepts up to ${MAX_IMAGES} images per scan (${files.length} given).`, 400);
  const big = files.find(f => f.buffer.length >= MAX_IMAGE);
  if (big) throw new VendorError(`ImageTwin accepts images under 20 MB: ${big.name}`, 400);
  return 'images';
}

async function call(path, init) {
  let r;
  try {
    r = await fetch(`${BASE}${sandbox() ? '/sandbox' : ''}${path}`, { ...init, headers: { Authorization: `Bearer ${apiKey()}`, ...(init?.headers || {}) }, signal: AbortSignal.timeout(120000) });
  } catch (e) {
    throw new VendorError(`ImageTwin could not be reached (${e.message})`);
  }
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON */ }
  return { status: r.status, body };
}

/**
 * Start a scan. files: [{ name, buffer, type }]. opts: { minScore (0-0.9, default 0.33), excludeIdenticalPaper, callbackUrl }.
 * Returns { scanId, kind, sandbox }.
 */
async function scan(files, opts = {}) {
  if (!configured()) throw new VendorError('ImageTwin is not connected (IMAGETWIN_API_KEY is not set).', 400);
  const kind = validate(files);
  const form = new FormData();
  for (const f of files) form.append('file', new Blob([f.buffer], { type: f.type || 'application/octet-stream' }), f.name);
  if (opts.minScore != null) form.append('minScore', String(Math.min(0.9, Math.max(0, Number(opts.minScore) || 0))));
  if (opts.excludeIdenticalPaper) form.append('excludeIdenticalPaper', 'true');
  if (opts.callbackUrl) form.append('callbackUrl', opts.callbackUrl);
  const { status, body } = await call('/scan', { method: 'POST', body: form });
  if (status !== 200 || !body?.scanId) throw new VendorError(`${STATUS_TEXT[status] || `ImageTwin error (HTTP ${status})`}${body?.message ? `: ${body.message}` : ''}`, status === 401 || status === 400 ? 400 : 502);
  return { scanId: String(body.scanId), kind, sandbox: sandbox() };
}

/** Result of a scan: { status: 'running' } (HTTP 202) or { status: 'finished', ...counts, links } */
async function result(scanId) {
  if (!configured()) throw new VendorError('ImageTwin is not connected (IMAGETWIN_API_KEY is not set).', 400);
  if (!/^[\w-]{6,128}$/.test(String(scanId))) throw new VendorError('Invalid ImageTwin scan id.', 400);
  const { status, body } = await call(`/result/${encodeURIComponent(scanId)}`, { method: 'GET' });
  if (status === 202) return { status: 'running' };
  if (status !== 200) throw new VendorError(STATUS_TEXT[status] || `ImageTwin error (HTTP ${status})`, status === 404 ? 404 : 502);
  return normalize(body);
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The documented result fields, with what each means for the editor */
function normalize(b) {
  return {
    status: 'finished',
    scanId: b.scanId,
    alterations: num(b.alterationCount),           // e.g. image splicing
    localDuplicates: num(b.localDuplicateCount),   // within and between the manuscript's images
    externalDuplicates: num(b.externDuplicateCount), // with ImageTwin's reference database of published figures
    aiImages: num(b.aiImageCount),                 // potential AI-generated images
    highestScore: num(b.highestScore),
    minScore: b.minScore != null ? num(b.minScore) : 0.33,
    pdfReport: typeof b.pdfReport === 'string' ? b.pdfReport : null,
    resultUrl: typeof b.resultUrl === 'string' ? b.resultUrl : null
  };
}

/**
 * Risk level on the Module 5 scale from ImageTwin's own confidence bands (user manual, "Confidence Score"):
 * 0-32% low (hidden by default), 33-65% fair (warrants investigation), 66-100% high (requires attention).
 */
function level(r) {
  if (!r || r.status !== 'finished') return null;
  const issues = r.alterations + r.localDuplicates + r.externalDuplicates + r.aiImages;
  if (!issues || r.highestScore < 0.33) return 'LOW';
  return r.highestScore >= 0.66 ? 'HIGH' : 'MEDIUM';
}

module.exports = { scan, result, normalize, level, validate, configured, sandbox, VendorError, BASE };
