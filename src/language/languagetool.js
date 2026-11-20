// language/languagetool.js - Module 6 optional grammar engine: a LanguageTool server (open source, self-hosted) adds its
// ~6,100 English grammar rules, its n-gram model of confused words and the ~6,300 PJPS Scribe rules for medical and
// pharmaceutical writing (scripts/build-scribe-rules.js) when LANGUAGETOOL_URL is set (e.g. http://our-server:8081).
// Without it, or when it does not answer, the in-house rules work alone. Paragraphs are sent together in requests of at most ~18 KB.
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
  GENDER_NEUTRALITY: 'delivery', AMERICAN_ENGLISH_STYLE: 'style', BRITISH_ENGLISH: 'style',
  // the PJPS Scribe rules on the server (scripts/build-scribe-rules.js): the rule bank of bank.js and the typing slips
  PJPS_CONFUSED_WORDS: 'correctness', PJPS_PREPOSITIONS: 'correctness', PJPS_GRAMMAR: 'correctness', PJPS_NOUN_FORMS: 'correctness', PJPS_TYPOS: 'correctness',
  PJPS_MEDICAL_TERMS: 'style', PJPS_SPECIES: 'style', PJPS_ABBREVIATIONS: 'style', PJPS_UNITS: 'style', PJPS_ACADEMIC: 'style', PJPS_REDUNDANCY: 'clarity', PJPS_WORDINESS: 'clarity'
};
/** A PJPS rule reports under the in-house rule of the same group ("PJPS_MEDICAL_TERM_12" -> "medical-term", a typo -> "spelling"),
 *  so the writer turns a kind of suggestion off once for both engines */
const ruleOf = id => {
  const pj = /^PJPS_(.+)_\d+$/.exec(id || '');
  if (!pj) return `lt:${id || 'rule'}`;
  return pj[1] === 'TYPO' ? 'spelling' : pj[1].toLowerCase().replace(/_/g, '-');
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
      // a suggestion the server returns in the case of the text ("Kg" -> "Kg" from the unit rule): the form its message names
      const said = p.slice(off, off + m.length);
      let reps = (m.replacements || []).map(r => r.value).filter(v => v !== said);
      if (!reps.length && m.replacements?.length) reps = [...String(m.message || '').matchAll(/[“"]([^”"]+)[”"]/g)].map(x => x[1]).filter(v => v !== said).slice(-1);
      out[batch[k]].push({
        rule: ruleOf(m.rule?.id), category: CATEGORY[cat] || 'correctness', title: m.shortMessage || m.rule?.category?.name || 'Grammar',
        offset: off, length: m.length, text: p.slice(off, off + m.length), message: m.message,
        replacements: reps.slice(0, 4), spelling: m.rule?.issueType === 'misspelling', engine: 'languagetool'
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
