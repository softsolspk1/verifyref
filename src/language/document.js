// language/document.js - Module 6 checks that need the whole document: abbreviations defined at first use, figures and
// tables cited in order, the same term hyphenated two ways, the tone of the text and the overall writing score.
const { sentences, words, stats } = require('./text');

const KNOWN_ABBR = new Set(['DNA', 'RNA', 'mRNA', 'HIV', 'AIDS', 'USA', 'UK', 'EU', 'UN', 'WHO', 'FDA', 'NIH', 'ANOVA', 'SD', 'SEM', 'SE', 'CI', 'OR', 'HR', 'RR', 'ID', 'PhD',
  'MSc', 'BSc', 'MD', 'IV', 'II', 'III', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', 'UV', 'IR', 'NMR', 'PCR', 'ATP', 'ADP', 'AM', 'PM', 'BC', 'AD', 'CEO', 'IT', 'TV', 'GPS', 'pH',
  'COVID', 'SARS', 'ICU', 'BMI', 'ISBN', 'ISSN', 'DOI', 'URL', 'PDF', 'NA', 'NS', 'ND', 'OK', 'IQ', 'GDP', 'NGO', 'UNICEF', 'UNESCO', 'NASA', 'USD', 'PKR', 'IUPAC', 'SI']);

function abbreviations(text) {
  const out = [];
  const defined = new Map(); // abbr -> offset of its definition
  for (const m of text.matchAll(/\(([A-Z][A-Za-z0-9-]*[A-Z0-9]s?)\)/g)) {
    const a = m[1].replace(/s$/, '');
    if (!/[A-Z].*[A-Z0-9]/.test(a) || a.length > 10) continue;
    if (defined.has(a)) {
      out.push({ rule: 'abbr-redefined', category: 'style', title: 'Abbreviation defined twice', offset: m.index + 1, length: m[1].length, text: m[1],
        message: `"${a}" was already defined earlier. Define an abbreviation once, at first use, and use the short form after that.`, replacements: [] });
    } else defined.set(a, m.index);
  }
  const seen = new Set();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9-]*[A-Z0-9])s?\b/g)) {
    const a = m[1];
    if (a.length < 2 || a.length > 8 || seen.has(a) || KNOWN_ABBR.has(a) || /^[IVXLC]+$/.test(a) || /^\d/.test(a)) continue;
    // inside the definition brackets, in a heading in capitals or in the reference list: not a use
    if (text[m.index - 1] === '(' && text[m.index + m[0].length] === ')') { seen.add(a); continue; }
    const line = text.slice(text.lastIndexOf('\n', m.index) + 1, (text.indexOf('\n', m.index) + 1 || text.length + 1) - 1);
    if (line === line.toUpperCase() && line.length < 120) continue;
    seen.add(a);
    const def = defined.get(a);
    if (def === undefined) {
      if ((text.match(new RegExp(`\\b${a}s?\\b`, 'g')) || []).length < 2) continue; // used once: perhaps a name, not flagged
      out.push({ rule: 'abbr-undefined', category: 'style', title: 'Abbreviation not defined', offset: m.index, length: a.length, text: a,
        message: `"${a}" is never spelled out. Give the full term at first use, followed by the abbreviation in brackets.`, replacements: [] });
    } else if (def > m.index) {
      out.push({ rule: 'abbr-late', category: 'style', title: 'Abbreviation used before definition', offset: m.index, length: a.length, text: a,
        message: `"${a}" is used here before it is defined later in the text. Move the definition to this first use.`, replacements: [] });
    }
  }
  return out;
}

function figureOrder(text) {
  const out = [];
  for (const [kind, re] of [['Figure', /\b(?:Fig(?:ure)?s?\.?)\s*(\d+)/g], ['Table', /\bTables?\s+(\d+)/g]]) {
    let max = 0;
    const firsts = new Set();
    for (const m of text.matchAll(re)) {
      const n = +m[1];
      if (firsts.has(n)) continue;
      firsts.add(n);
      if (n > max + 1) {
        out.push({ rule: 'figure-order', category: 'style', title: `${kind} numbering`, offset: m.index, length: m[0].length, text: m[0],
          message: `${kind} ${n} is cited before ${kind} ${max + 1}. ${kind}s should be numbered in the order they are first cited.`, replacements: [] });
      }
      max = Math.max(max, n);
    }
  }
  return out;
}

function hyphenation(text) {
  const out = [];
  const lower = text.toLowerCase();
  const flagged = new Set();
  for (const m of text.matchAll(/\b([A-Za-z]{2,})-([A-Za-z]{2,})\b/g)) {
    const joined = (m[1] + m[2]).toLowerCase(), spaced = `${m[1]} ${m[2]}`.toLowerCase();
    const key = m[0].toLowerCase();
    if (flagged.has(key)) continue;
    const other = new RegExp(`\\b${joined}\\b`).test(lower) ? joined : null;
    if (!other) continue;
    flagged.add(key);
    out.push({ rule: 'hyphen-consistency', category: 'style', title: 'Inconsistent spelling', offset: m.index, length: m[0].length, text: m[0],
      message: `The text uses both "${m[0]}" and "${other}". Use one form throughout.`, replacements: [other], consistency: true });
    void spaced;
  }
  return out;
}

// ------------------------------------------------------------------ research manuscript checks

const HEADINGS = [
  ['abstract', /^(?:abstract|summary)\b/i], ['keywords', /^key\s*words?\b/i], ['introduction', /^(?:\d+\.?\s*)?(?:introduction|background)\b/i],
  ['methods', /^(?:\d+\.?\s*)?(?:materials?\s+and\s+methods?|methods?|methodology|experimental(?:\s+section)?|patients\s+and\s+methods)\b/i],
  ['results', /^(?:\d+\.?\s*)?results(?:\s+and\s+discussion)?\b/i], ['discussion', /^(?:\d+\.?\s*)?discussion\b/i], ['conclusion', /^(?:\d+\.?\s*)?conclusions?\b/i],
  ['acknowledgements', /^acknowledg/i], ['references', /^(?:references?|bibliography|literature\s+cited|works\s+cited)\b/i]
];

/** Manuscript sections: [{ key, heading, start, end }] (end = start of the next section) */
function sectionsOf(text) {
  const out = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    // a heading is a short line, or a run-in heading ("Abstract: ...", "Methods. ...")
    if (t && t.split(/\s+/).length <= 8 || /^[A-Z][A-Za-z ]{2,40}[:.]\s/.test(t)) {
      for (const [key, re] of HEADINGS) {
        if (re.test(t) && !out.some(s => s.key === key)) { out.push({ key, heading: t.slice(0, 60), start: pos }); break; }
      }
    }
    pos += line.length + 1;
  }
  out.sort((a, b) => a.start - b.start);
  out.forEach((s, i) => { s.end = out[i + 1] ? out[i + 1].start : text.length; });
  return out;
}

const PROC_VERBS = 'added|dissolved|incubated|measured|centrifuged|prepared|used|performed|calculated|determined|analy[sz]ed|recorded|obtained|collected|weighed|filtered|mixed|kept|stored|washed|diluted|heated|cooled|dried|extracted|evaporated|injected|administered|treated|randomi[sz]ed|divided|sacrificed|anaesthetized|anesthetized|homogeni[sz]ed|stained|transferred|shaken|stirred|sonicated|filled|placed|assessed|evaluated|tested|expressed|applied';
const WE_PRESENT = /\b(?:we|We)\s+(measure|add|use|perform|collect|prepare|calculate|determine|analy[sz]e|record|obtain|weigh|filter|mix|dissolve|incubate|evaluate|assess|test|apply|administer|treat|divide|extract|inject)\b/g;
const PAST = { measure: 'measured', add: 'added', use: 'used', perform: 'performed', collect: 'collected', prepare: 'prepared', calculate: 'calculated', determine: 'determined', analyse: 'analysed', analyze: 'analyzed', record: 'recorded', obtain: 'obtained', weigh: 'weighed', filter: 'filtered', mix: 'mixed', dissolve: 'dissolved', incubate: 'incubated', evaluate: 'evaluated', assess: 'assessed', test: 'tested', apply: 'applied', administer: 'administered', treat: 'treated', divide: 'divided', extract: 'extracted', inject: 'injected' };
const OVERCLAIM = /\b(prove[sd]?|proven|undoubtedly|unequivocally|definitively|conclusively|beyond (?:any )?doubt|it is certain that|for the first time)\b/gi;
const CLAIM = /\b(?:has|have) been (?:reported|shown|demonstrated|documented|observed|associated|linked|used)\b|\b(?:studies|reports|researchers|evidence|literature|previous (?:work|studies|research)|it is (?:well )?(?:known|established|reported))\b|\b(?:is|are) (?:widely|commonly|frequently|traditionally) (?:used|reported|known)\b|\b(?:recent|several|many|numerous|previous|earlier) (?:studies|reports|investigations|trials)\b/i;
const CITE = /\[\s*\d+(?:\s*[-–,]\s*\d+)*\s*\]|\(\s*[A-Z][A-Za-z'’-]+(?:\s+(?:et al\.?|and|&)\s*(?:[A-Z][A-Za-z'’-]+)?)?,?\s*(?:19|20)\d{2}[a-z]?(?:\s*[;,]\s*[^)]*)?\)|\b[A-Z][A-Za-z'’-]+\s+(?:et al\.?\s*)?\((?:19|20)\d{2}[a-z]?\)|(?<=[a-z.,)])\d{1,3}(?:[,–-]\d{1,3})*(?=[\s.,;]|$)|\^\d+/;

function research(text, goals = {}) {
  const out = [];
  const secs = sectionsOf(text);
  const sec = k => secs.find(s => s.key === k);
  const refs = sec('references');
  const proseEnd = refs ? refs.start : text.length;

  // Methods are reported in the past tense
  const methods = sec('methods');
  if (methods) {
    const part = text.slice(methods.start, methods.end);
    for (const m of part.matchAll(new RegExp(`\\b(is|are)\\s+((?:then|first|subsequently|carefully|gently|accurately)\\s+)?(${PROC_VERBS})\\b`, 'g'))) {
      const at = methods.start + m.index;
      out.push({ rule: 'methods-tense', category: 'style', title: 'Tense in Methods', offset: at, length: m[1].length, text: m[1],
        message: 'Methods describe what was done, in the past tense ("was added", "were incubated").', replacements: [m[1] === 'is' ? 'was' : 'were'] });
    }
    for (const m of part.matchAll(WE_PRESENT)) {
      const at = methods.start + m.index + m[0].length - m[1].length;
      out.push({ rule: 'methods-tense', category: 'style', title: 'Tense in Methods', offset: at, length: m[1].length, text: m[1],
        message: 'Methods describe what was done, in the past tense.', replacements: [PAST[m[1]] || `${m[1]}ed`] });
    }
  }

  // Abstract length
  const abs = sec('abstract');
  const absLimit = +goals.abstractWords || 250;
  if (abs) {
    const n = words(text.slice(abs.start, abs.end)).length - words(abs.heading).length;
    if (n > absLimit) out.push({ rule: 'abstract-length', category: 'style', title: 'Abstract too long', offset: abs.start, length: Math.min(abs.heading.length, abs.end - abs.start), text: text.substr(abs.start, Math.min(abs.heading.length, abs.end - abs.start)),
      message: `The abstract has about ${n} words; most journals allow ${absLimit}. Shorten it.`, replacements: [], ai: 'shorten' });
  }

  // Overclaiming: science reports evidence, it rarely "proves"
  for (const m of text.slice(0, proseEnd).matchAll(OVERCLAIM)) {
    const w = m[1].toLowerCase();
    const reps = /^prove/.test(w) ? ({ prove: ['show', 'indicate'], proves: ['shows', 'indicates'], proved: ['showed', 'indicated'], proven: ['shown', 'demonstrated'] }[w] || ['show']) : w === 'for the first time' ? [] : ['clearly'];
    out.push({ rule: 'overclaim', category: 'delivery', title: w === 'for the first time' ? 'Priority claim' : 'Overstated claim', offset: m.index, length: m[0].length, text: m[0],
      message: w === 'for the first time' ? 'A claim of being the first needs a thorough literature search to back it; reviewers often challenge it.' : `"${m[0]}" overstates what experimental evidence can establish; reviewers expect measured language ("shows", "indicates", "suggests").`, replacements: reps });
  }

  // Claims about the literature without a citation (Introduction and Discussion, or the whole text when it has no headings)
  const scope = secs.filter(s => ['introduction', 'discussion'].includes(s.key));
  const ranges = scope.length ? scope.map(s => [s.start, s.end]) : (secs.length ? [] : [[0, proseEnd]]);
  for (const [a, b] of ranges) {
    let pos = a;
    for (const para of text.slice(a, b).split('\n')) {
      for (const s of sentences(para)) {
        if (CLAIM.test(s.text) && !CITE.test(s.text) && words(s.text).length >= 6) {
          out.push({ rule: 'needs-citation', category: 'style', title: 'Claim without a citation', offset: pos + s.start, length: s.end - s.start, text: s.text,
            message: 'This sentence refers to earlier work but cites no source. Add the reference(s) it relies on.', replacements: [], whole: true, findSources: true });
        }
      }
      pos += para.length + 1;
    }
  }

  // Numbered and author-year citations mixed in one text
  const body = text.slice(0, proseEnd);
  const numbered = (body.match(/\[\s*\d+(?:\s*[-–,]\s*\d+)*\s*\]/g) || []).length;
  const ay = [...body.matchAll(/\(\s*[A-Z][A-Za-z'’-]+(?:\s+et al\.?|\s+(?:and|&)\s+[A-Z][A-Za-z'’-]+)?,?\s*(?:19|20)\d{2}[a-z]?\)/g)];
  if (numbered >= 3 && ay.length >= 3) {
    const m = ay[0];
    out.push({ rule: 'citation-mix', category: 'style', title: 'Mixed citation styles', offset: m.index, length: m[0].length, text: m[0],
      message: `The text uses both numbered citations (${numbered}) and author-year citations (${ay.length}). A journal uses one system throughout; Module 2 converts the reference list to the house style.`, replacements: [] });
  }

  const present = new Set(secs.map(s => s.key));
  const expected = ['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion', 'references'];
  const structure = { sections: secs.map(s => ({ key: s.key, heading: s.heading, start: s.start, words: words(text.slice(s.start, s.end)).length })),
    missing: words(text).length >= 1500 ? expected.filter(k => !present.has(k) && !(k === 'discussion' && /results\s+and\s+discussion/i.test(sec('results')?.heading || '')) && !(k === 'conclusion' && present.has('discussion'))) : [],
    referencesAt: refs ? refs.start : null };
  return { issues: out, structure };
}

// ------------------------------------------------------------------ tone

const TONES = {
  formal: /\b(?:therefore|thus|hence|moreover|furthermore|consequently|whereas|herein|accordingly|respectively|nevertheless|notwithstanding)\b/gi,
  confident: /\b(?:clearly|demonstrate[sd]?|confirm(?:s|ed)?|establish(?:es|ed)?|show(?:s|ed|n)?|prove[sdn]?|will|definitely|certainly|evidently)\b/gi,
  tentative: /\b(?:may|might|could|perhaps|possibly|seem[s]?|appear[s]?|suggest[s]?|likely|unclear|somewhat|i think|i guess|maybe)\b/gi,
  analytical: /\b(?:analy[sz]\w*|compar\w*|significan\w*|correlat\w*|statistic\w*|data|results?|measur\w*|evaluat\w*|assess\w*|variable\w*|mean|ratio|percent)\b/gi,
  friendly: /\b(?:thanks?|thank you|please|glad|happy|welcome|great|hope|appreciate[d]?|kind(?:ly)?|cheers|enjoy)\b/gi,
  optimistic: /\b(?:promising|improve[sd]?|benefit\w*|effective|success\w*|advantage\w*|potential|opportunit\w*|encourag\w*|positive)\b/gi,
  worried: /\b(?:concern\w*|risk\w*|worr\w*|danger\w*|threat\w*|alarming|serious|severe|fail\w*|problem\w*|unfortunately|adverse)\b/gi,
  informal: /\b(?:gonna|wanna|kinda|stuff|okay|ok|awesome|cool|guys|lol|yeah|nope|super|totally|really)\b|!|\b\w+n't\b/gi,
  urgent: /\b(?:urgent\w*|immediately|asap|critical|must|now|deadline|as soon as possible)\b/gi
};
const TONE_LABEL = { formal: 'Formal', confident: 'Confident', tentative: 'Tentative', analytical: 'Analytical', friendly: 'Friendly', optimistic: 'Optimistic', worried: 'Concerned', informal: 'Informal', urgent: 'Urgent' };
const TONE_GOOD = { formal: true, confident: true, analytical: true, friendly: true, optimistic: true, tentative: false, worried: null, informal: false, urgent: null };

/** Detected tones, strongest first: [{ key, label, score (0-100), good }] and a formality reading */
function tone(text) {
  const n = Math.max(1, words(text).length);
  const out = Object.entries(TONES).map(([k, re]) => {
    const hits = (text.match(re) || []).length;
    return { key: k, label: TONE_LABEL[k], score: Math.min(100, Math.round(hits / n * 1000 * 2.2)), good: TONE_GOOD[k] };
  }).filter(t => t.score >= 8).sort((a, b) => b.score - a.score).slice(0, 5);
  const formalHits = (text.match(TONES.formal) || []).length, informalHits = (text.match(TONES.informal) || []).length;
  const formality = informalHits > formalHits * 1.5 && informalHits > 1 ? 'informal' : formalHits > 0 || words(text).length > 150 ? 'formal' : 'neutral';
  return { tones: out, formality, source: 'in-house' };
}

// ------------------------------------------------------------------ score

const WEIGHT = { correctness: 3, clarity: 1.5, engagement: 0.6, delivery: 1.2, style: 1 };

/** Overall score 0-100 from the open suggestions per area ({ correctness: n, ... }): fewer per word and readability suited to the audience score higher */
function score(counts, st, goals = {}) {
  const n = Math.max(st.words, 1);
  const per = {};
  for (const c of Object.keys(WEIGHT)) per[c] = Math.max(0, +counts[c] || 0);
  const weighted = Object.entries(per).reduce((a, [c, k]) => a + k * WEIGHT[c], 0);
  let s = 100 - weighted / n * 100 * 2.4;
  // readability against the audience: experts can take dense text, a general audience cannot
  const target = goals.audience === 'general' ? 60 : goals.audience === 'knowledgeable' ? 45 : 30;
  if (st.words > 50 && st.readability.flesch < target - 15) s -= Math.min(8, (target - 15 - st.readability.flesch) / 3);
  if (st.words < 30) s = Math.min(s, 100);
  s = Math.max(0, Math.min(100, Math.round(s)));
  const area = c => {
    const k = per[c] / n * 100;
    return k === 0 ? 'Looking good' : k < 0.8 ? 'Minor issues' : k < 2.5 ? 'Needs attention' : 'Needs work';
  };
  return { overall: s, counts: per, areas: Object.fromEntries(Object.keys(WEIGHT).map(c => [c, area(c)])) };
}

/** Whole-document issues (positions in the full text) */
function checkDocument(text, goals = {}, opts = {}) {
  const disabled = new Set(opts.disabled || []);
  let out = [], structure = null;
  const academic = goals.domain === 'academic' || !goals.domain;
  if (academic) {
    const r = research(text, goals);
    structure = r.structure;
    // the reference list is names, abbreviations and journal titles: no writing checks there
    const prose = structure.referencesAt != null ? text.slice(0, structure.referencesAt) : text;
    out.push(...abbreviations(prose), ...figureOrder(prose), ...r.issues);
  }
  out.push(...hyphenation(structure?.referencesAt != null ? text.slice(0, structure.referencesAt) : text));
  out = out.filter(i => !disabled.has(i.rule) && !(i.rule.startsWith('abbr-') && disabled.has('abbreviations')));
  return { issues: out, structure };
}

/** Word counts of the document (lower case), used to accept terms the writer uses repeatedly */
function wordCounts(text) {
  const m = new Map();
  for (const { w } of words(text)) { const k = w.toLowerCase(); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

module.exports = { checkDocument, tone, score, stats, wordCounts, sentences };
