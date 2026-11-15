// language/languagetool.js - Module 6 optional grammar engine: a LanguageTool server (open source, self-hosted) adds its
// ~5,000 English grammar rules when LANGUAGETOOL_URL is set (e.g. http://our-server:8081). Without it, or when it does not
// answer, the in-house rules work alone. Paragraphs are sent together in requests of at most ~18 KB.
// Standby: LANGUAGETOOL_STANDBY_URL (with LANGUAGETOOL_STANDBY_TOKEN when it has its own) is used when the main server does
// not answer, and a request that failed on every server is tried once more (a dropped connection is not an outage).
const servers = () => {
  const list = (v, token) => String(v || '').split(',').map(u => u.trim().replace(/\/+$/, '')).filter(Boolean).map(url => ({ url, token }));
  return [
    ...list(process.env.LANGUAGETOOL_URL, process.env.LANGUAGETOOL_TOKEN).map(s => ({ ...s, role: 'main' })),
    ...list(process.env.LANGUAGETOOL_STANDBY_URL, process.env.LANGUAGETOOL_STANDBY_TOKEN || process.env.LANGUAGETOOL_TOKEN).map(s => ({ ...s, role: 'standby' }))
  ];
};
const enabled = () => servers().length > 0;
// LanguageTool rules that are wrong in medical and pharmaceutical writing: "knot" is a surgical term (anchoring knot), not "not"
const OFF = ['CONFUSION_KNOT_NOT'];

const CATEGORY = {
  TYPOS: 'correctness', GRAMMAR: 'correctness', PUNCTUATION: 'correctness', CASING: 'correctness', CONFUSED_WORDS: 'correctness', TYPOGRAPHY: 'correctness',
  COLLOCATIONS: 'correctness', SEMANTICS: 'correctness', COMPOUNDING: 'correctness', NONSTANDARD_PHRASES: 'correctness', MISC: 'correctness',
  STYLE: 'clarity', REDUNDANCY: 'clarity', PLAIN_ENGLISH: 'clarity', WIKIPEDIA: 'clarity', REPETITIONS_STYLE: 'engagement', CREATIVE_WRITING: 'engagement',
  GENDER_NEUTRALITY: 'delivery', AMERICAN_ENGLISH_STYLE: 'style', BRITISH_ENGLISH: 'style'
};

// which server answered last (tried first next time) and the last outcome, for the admin health view
const state = { good: 0, lastOk: null, lastError: null, lastErrorAt: null };

async function request(text, variant, server, timeoutMs) {
  const body = new URLSearchParams({ text, language: variant === 'en-GB' ? 'en-GB' : 'en-US', level: 'picky', disabledRules: OFF.join(',') });
  if (process.env.LANGUAGETOOL_USER) body.set('username', process.env.LANGUAGETOOL_USER);
  if (process.env.LANGUAGETOOL_KEY) body.set('apiKey', process.env.LANGUAGETOOL_KEY);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || parseInt(process.env.LANGUAGETOOL_TIMEOUT_MS || '20000', 10));
  try {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    // our own server sits behind a gatekeeper (scripts/setup-languagetool-server.sh) that only lets this token through
    if (server.token) headers.Authorization = `Bearer ${server.token}`;
    const r = await fetch(`${server.url}/v2/check`, { method: 'POST', body, signal: ctl.signal, headers });
    if (!r.ok) throw new Error(`LanguageTool ${r.status}`);
    return (await r.json()).matches || [];
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'LanguageTool did not answer in time' : e.message);
  } finally { clearTimeout(t); }
}

/** one request on the server that answered last, then the others, then once more on the first */
async function ask(text, variant) {
  const list = servers();
  const start = state.good < list.length ? state.good : 0;
  const order = [...list.keys()].map(i => (start + i) % list.length);
  let err;
  for (const i of [...order, order[0]]) {
    try {
      const m = await request(text, variant, list[i]);
      state.good = i; state.lastOk = new Date().toISOString();
      return m;
    } catch (e) { err = e; }
  }
  state.lastError = err.message; state.lastErrorAt = new Date().toISOString();
  throw err;
}

/** paragraphs [text] -> [[issue]] per paragraph, or null when the server is not configured or failed */
async function check(paragraphs, variant) {
  if (!enabled() || !paragraphs.length) return null;
  const out = paragraphs.map(() => []);
  const SEP = '\n\n';
  const run = async batch => {
    const text = batch.map(b => paragraphs[b]).join(SEP);
    const starts = [];
    let pos = 0;
    for (const b of batch) { starts.push(pos); pos += paragraphs[b].length + SEP.length; }
    for (const m of await ask(text, variant)) {
      let k = starts.length - 1;
      while (k > 0 && starts[k] > m.offset) k--;
      const p = paragraphs[batch[k]], off = m.offset - starts[k];
      if (off < 0 || off + m.length > p.length) continue;
      const cat = m.rule?.category?.id;
      out[batch[k]].push({
        rule: `lt:${m.rule?.id || 'rule'}`, category: CATEGORY[cat] || 'correctness', title: m.shortMessage || m.rule?.category?.name || 'Grammar',
        offset: off, length: m.length, text: p.slice(off, off + m.length), message: m.message,
        replacements: (m.replacements || []).slice(0, 4).map(r => r.value), spelling: m.rule?.issueType === 'misspelling', engine: 'languagetool'
      });
    }
  };
  try {
    const batches = [];
    let batch = [], size = 0;
    for (let i = 0; i < paragraphs.length; i++) {
      if (batch.length && size + paragraphs[i].length > 18000) { batches.push(batch); batch = []; size = 0; }
      batch.push(i); size += paragraphs[i].length + 2;
    }
    if (batch.length) batches.push(batch);
    // a whole manuscript (Full Screening): three requests at a time, so 60,000 characters take one request's time
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => { while (next < batches.length) await run(batches[next++]); }));
    return out;
  } catch (e) {
    console.warn(`[languagetool] ${e.message}`);
    return null;
  }
}

/** every configured server checked with a short sentence -> { configured, servers: [{ role, ok, ms, error }], ok, ... } (addresses not shown) */
async function health() {
  const list = servers();
  const res = await Promise.all(list.map(async s => {
    const t0 = Date.now();
    try {
      const m = await request('This are a test sentence.', 'en-US', s, 10000);
      return { role: s.role, ok: true, ms: Date.now() - t0, rulesAnswer: m.length > 0 };
    } catch (e) { return { role: s.role, ok: false, ms: Date.now() - t0, error: e.message }; }
  }));
  return { configured: list.length > 0, ok: res.some(r => r.ok), servers: res, lastOk: state.lastOk, lastError: state.lastError, lastErrorAt: state.lastErrorAt };
}

module.exports = { enabled, check, health };
