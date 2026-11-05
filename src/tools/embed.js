// tools/embed.js - sentence embeddings (all-MiniLM-L6-v2, ONNX 8-bit, about 23 MB) run on this server: texts that mean
// the same thing get vectors that point the same way, whatever their wording. Used by the novelty assessment to compare a
// manuscript's title and abstract with published works. No text leaves the server; the model files are downloaded once
// from Hugging Face into DATA_DIR/models. PJPS_EMBED=off turns it off; when the library or model cannot be loaded,
// embed() returns null and the callers fall back on word matching.
const path = require('path');
const cfg = require('../config');

const MODEL = process.env.PJPS_EMBED_MODEL || 'Xenova/all-MiniLM-L6-v2';
const OFF = /^(off|0|false|no)$/i.test(process.env.PJPS_EMBED || '');
const RETRY_MS = 10 * 60 * 1000;

let loading = null, failedAt = 0;
function load() {
  if (OFF) return Promise.resolve(null);
  if (!loading && Date.now() - failedAt > RETRY_MS) {
    loading = (async () => {
      const T = await import('@huggingface/transformers');
      T.env.cacheDir = path.join(cfg.DATA_DIR, 'models');
      return await T.pipeline('feature-extraction', MODEL, { dtype: 'q8' });
    })().catch(err => {
      console.warn(`[embed] model unavailable, word matching only: ${err.message}`);
      failedAt = Date.now(); loading = null;
      return null;
    });
  }
  return loading || Promise.resolve(null);
}

/** Unit vectors (Float32Array) of the texts, in order, or null when the model is not available */
async function embed(texts, { batch = 16 } = {}) {
  const fx = await load();
  if (!fx) return null;
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const part = texts.slice(i, i + batch).map(t => String(t || '').slice(0, 2000));
    const res = await fx(part, { pooling: 'mean', normalize: true });
    const dim = res.dims[res.dims.length - 1];
    for (let k = 0; k < part.length; k++) out.push(res.data.slice(k * dim, (k + 1) * dim));
  }
  return out;
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

module.exports = { embed, dot, load, MODEL };
