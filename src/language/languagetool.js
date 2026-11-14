// language/languagetool.js - Module 6 optional grammar engine: a LanguageTool server (open source, self-hosted) adds its
// ~5,000 English grammar rules when LANGUAGETOOL_URL is set (e.g. http://our-server:8081). Without it, or when it does not
// answer, the in-house rules work alone. Paragraphs are sent together in requests of at most ~18 KB.
const URL_ = () => (process.env.LANGUAGETOOL_URL || '').replace(/\/+$/, '');
const enabled = () => !!URL_();

const CATEGORY = {
  TYPOS: 'correctness', GRAMMAR: 'correctness', PUNCTUATION: 'correctness', CASING: 'correctness', CONFUSED_WORDS: 'correctness', TYPOGRAPHY: 'correctness',
  COLLOCATIONS: 'correctness', SEMANTICS: 'correctness', COMPOUNDING: 'correctness', NONSTANDARD_PHRASES: 'correctness', MISC: 'correctness',
  STYLE: 'clarity', REDUNDANCY: 'clarity', PLAIN_ENGLISH: 'clarity', WIKIPEDIA: 'clarity', REPETITIONS_STYLE: 'engagement', CREATIVE_WRITING: 'engagement',
  GENDER_NEUTRALITY: 'delivery', AMERICAN_ENGLISH_STYLE: 'style', BRITISH_ENGLISH: 'style'
};

async function request(text, variant) {
  const body = new URLSearchParams({ text, language: variant === 'en-GB' ? 'en-GB' : 'en-US', level: 'picky' });
  if (process.env.LANGUAGETOOL_USER) body.set('username', process.env.LANGUAGETOOL_USER);
  if (process.env.LANGUAGETOOL_KEY) body.set('apiKey', process.env.LANGUAGETOOL_KEY);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    // our own server sits behind a gatekeeper (scripts/setup-languagetool-server.sh) that only lets this token through
    if (process.env.LANGUAGETOOL_TOKEN) headers.Authorization = `Bearer ${process.env.LANGUAGETOOL_TOKEN}`;
    const r = await fetch(`${URL_()}/v2/check`, { method: 'POST', body, signal: ctl.signal, headers });
    if (!r.ok) throw new Error(`LanguageTool ${r.status}`);
    return (await r.json()).matches || [];
  } finally { clearTimeout(t); }
}

/** paragraphs [text] -> [[issue]] per paragraph, or null when the server is not configured or failed */
async function check(paragraphs, variant) {
  if (!enabled() || !paragraphs.length) return null;
  const out = paragraphs.map(() => []);
  const SEP = '\n\n';
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const text = batch.map(b => paragraphs[b]).join(SEP);
    const starts = [];
    let pos = 0;
    for (const b of batch) { starts.push(pos); pos += paragraphs[b].length + SEP.length; }
    for (const m of await request(text, variant)) {
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
    batch = []; size = 0;
  };
  try {
    for (let i = 0; i < paragraphs.length; i++) {
      if (size + paragraphs[i].length > 18000) await flush();
      batch.push(i); size += paragraphs[i].length + 2;
    }
    await flush();
    return out;
  } catch (e) {
    console.warn(`[languagetool] ${e.message}`);
    return null;
  }
}

module.exports = { enabled, check };
