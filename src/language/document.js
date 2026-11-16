// language/document.js - Module 6 checks that need the whole document: abbreviations defined at first use, figures and
// tables cited in order, the same term hyphenated two ways, the tone of the text and the overall writing score.
const { sentences, words, stats } = require('./text');

const KNOWN_ABBR = new Set(['DNA', 'RNA', 'mRNA', 'HIV', 'AIDS', 'USA', 'UK', 'EU', 'UN', 'WHO', 'FDA', 'NIH', 'ANOVA', 'SD', 'SEM', 'SE', 'CI', 'OR', 'HR', 'RR', 'ID', 'PhD',
  'MSc', 'BSc', 'MD', 'IV', 'II', 'III', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII', 'UV', 'IR', 'NMR', 'PCR', 'ATP', 'ADP', 'AM', 'PM', 'BC', 'AD', 'CEO', 'IT', 'TV', 'GPS', 'pH',
  'COVID', 'SARS', 'ICU', 'BMI', 'ISBN', 'ISSN', 'DOI', 'URL', 'PDF', 'NA', 'NS', 'ND', 'OK', 'IQ', 'GDP', 'NGO', 'UNICEF', 'UNESCO', 'NASA', 'USD', 'PKR', 'IUPAC', 'SI', 'PJPS',
  // medical and laboratory abbreviations readers of a pharmacy and medicine journal know without the full term
  'CT', 'MRI', 'ECG', 'EEG', 'TNF', 'IL', 'ELISA', 'HPLC', 'LC', 'GC', 'MS', 'TLC', 'FTIR', 'NF', 'IgG', 'IgM', 'IgE', 'IgA', 'cDNA', 'qPCR', 'RT', 'SPSS', 'USP', 'BP', 'EP', 'ICH', 'GMP',
  'ER', 'PR', 'IBM', 'CONSORT', 'STROBE', 'PRISMA', 'CARE', 'ARRIVE', 'TREND', 'GraphPad', 'RPMI', 'DMEM', 'MTT', 'DAPI', 'CO', 'NH', 'OH', 'CH', 'COOH', 'SH', 'CN']);

function abbreviations(text) {
  const out = [];
  const defined = new Map(); // abbr -> offset of its definition
  // the abstract stands alone: an abbreviation defined there is defined again at its first use in the main text
  const intro = text.search(/(?:^|\n)\s*(?:\d+\.?\s*)?introduction\s*:?\s*(?=\n)/i);
  const again = new Set();
  // the back matter (funding, acknowledgements, authors' contributions) stands alone too
  const backRe = /\n\s*(?:\d+\.?\s*)?(?:acknowledge?ments?|funding|financial support|authors?['’]?\s*contributions?|conflicts? of interest|competing interests?|declarations?|data availability|ethics? (?:approval|statement)|abbreviations?)\b/i;
  const back = intro > 0 ? text.slice(intro).search(backRe) : -1;
  const backAt = back > 0 ? intro + back : Infinity;
  // "(tumor-infiltrating lymphocytes (TILs)" and "(2,3,5,6-tetramethylpyrazine, TMP)" both define the abbreviation
  for (const m of text.matchAll(/(?:\(|,\s)([A-Z][A-Za-z0-9-]*[A-Z0-9]s?)\)/g)) {
    const a = m[1].replace(/s$/, '');
    if (!/[A-Z].*[A-Z0-9]/.test(a) || a.length > 10) continue;
    const at = m.index + m[0].indexOf(m[1]);
    // the comma form after a term in lower case only, not an address (Olympus Corporation, Tokyo, USA)
    if (m[0][0] === ',' && (KNOWN_ABBR.has(a) || !/(?:^|[\s(])[a-z0-9][\w,'-]*[a-z]{3,}$/.test(text.slice(Math.max(0, m.index - 60), m.index)))) continue;
    // table titles, figure legends and their footnotes stand alone: they define their abbreviations again
    const line = text.slice(text.lastIndexOf('\n', at) + 1, (text.indexOf('\n', at) + 1 || text.length + 1) - 1);
    if (defined.has(a) && (/^\s*(?:Table|Fig(?:ure)?s?\.?|Supplementary|Notes?\b|Abbreviations?|\(?[A-Za-z]\)\s)/i.test(line) || /\*\s*[pP]\s*[<≤]/.test(line))) continue;
    if (defined.has(a) && at > backAt) continue;
    if (defined.has(a) && intro > 0 && defined.get(a) < intro && at > intro && !again.has(a)) { again.add(a); continue; }
    if (defined.has(a)) {
      out.push({ rule: 'abbr-redefined', category: 'style', title: 'Abbreviation defined twice', offset: at, length: m[1].length, text: m[1],
        message: `"${a}" was already defined earlier. Define an abbreviation once, at first use, and use the short form after that.`, replacements: [] });
    } else defined.set(a, at);
  }
  const seen = new Set();
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9-]*[A-Z0-9])s?\b/g)) {
    const a = m[1];
    if (a.length < 2 || a.length > 8 || seen.has(a) || KNOWN_ABBR.has(a) || /^[IVXLC]+$/.test(a) || /^\d/.test(a)) continue;
    // inside the definition brackets, in a heading in capitals or in the reference list: not a use
    if (text[m.index - 1] === '(' && text[m.index + m[0].length] === ')') { seen.add(a); continue; }
    const line = text.slice(text.lastIndexOf('\n', m.index) + 1, (text.indexOf('\n', m.index) + 1 || text.length + 1) - 1);
    if (line === line.toUpperCase() && line.length < 120) continue;
    // part of a code with a number in front: 5-FU, 6-MP (the code is defined, not its letters)
    if (/\d-$/.test(text.slice(Math.max(0, m.index - 2), m.index))) continue;
    // a list of abbreviations ("TNBC: Triple-negative breast cancer; MRM: Modified radical mastectomy") defines them
    if ((line.match(/\b[A-Z][A-Za-z0-9-]*[A-Z0-9]s?\s*[:=]\s*[A-Za-z]/g) || []).length >= 2) { seen.add(a); continue; }
    seen.add(a);
    const def = defined.get(a);
    if (def === undefined) {
      if ((text.match(new RegExp(`\\b${a}s?\\b`, 'g')) || []).length < 2) continue; // used once: perhaps a name, not flagged
      if (/\d/.test(a)) continue; // cell lines, genes and compound codes (A549, PD-1, TMPAD-2): names, not abbreviations to spell out
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
  // (and "E-mail" / "email")
  for (const m of text.matchAll(/\b([A-Za-z]{2,}|[Ee])-([A-Za-z]{2,})\b/g)) {
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

// ------------------------------------------------------------------ capital letters used inconsistently
// "knowledge" in most sentences, "Knowledge" in the middle of one: Grammarly's "Text inconsistencies". A word written in
// lower case at least twice and with a capital mid-sentence is reported where it has the capital, unless the capital is
// part of a name ("Health Belief Model", "Tuberculosis Control Educational Program") or a heading, table row or quotation.
function capitals(text) {
  const out = [];
  const lowerCount = new Map();
  for (const m of text.matchAll(/(?<![A-Za-z'’-])([a-z][a-z-]{3,})\b/g)) lowerCount.set(m[1], (lowerCount.get(m[1]) || 0) + 1);
  const seen = new Set();
  for (const line of lineSpans(text)) {
    const s = text.slice(line.start, line.end);
    // headings, title lines, table cells and keyword lists keep their own capitals
    const ws = s.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    // (a line of thousands of characters is PDF text whose headings run into the sentences: not judged)
    if (ws.length < 8 || s.length > 2500 || ws.filter(w => /^[A-Z]/.test(w)).length > ws.length * 0.4 || !/[.?!]\s*$/.test(s.trim())) continue;
    // between two lower-case words: "management of Latent tuberculosis" (not "Table 2", "; Performed", "Figure S1")
    for (const m of s.matchAll(/(?<=[a-z]\s)([A-Z][a-z][a-z-]{2,})\b(?=\s+[a-z])/g)) {
      const w = m[1], low = w.toLowerCase();
      if ((lowerCount.get(low) || 0) < 3 || seen.has(low)) continue;
      const before = s.slice(Math.max(0, m.index - 30), m.index), after = s.slice(m.index + w.length, m.index + w.length + 30);
      // a name of several capitalised words, a quotation, or a word after "named", "called", "titled"
      if (/[A-Z][a-z]+\s+$/.test(before) || /^\s+(?:of\s+)?[A-Z][a-z]/.test(after) || /["“‘']\s*$/.test(before) || /\b(?:named|called|titled|entitled|termed)\s+$/i.test(before)) continue;
      seen.add(low);
      const at = line.start + m.index;
      out.push({ rule: 'case-consistency', category: 'correctness', title: 'Inconsistent capitalization', offset: at, length: w.length, text: w,
        message: `"${w}" has a capital letter here but is written "${low}" elsewhere in the text. Use one form throughout.`, replacements: [low], consistency: true });
    }
  }
  return out;
}
const lineSpans = text => { const out = []; let pos = 0; for (const l of text.split('\n')) { out.push({ start: pos, end: pos + l.length }); pos += l.length + 1; } return out; };

// ------------------------------------------------------------------ the author block (title page)
// Affiliations as editors correct them: "Jhang Punjab Pakistan" -> "Jhang, Punjab, Pakistan"; "Wardha. India" ->
// "Wardha, India"; "Medicine department" -> "Department of Medicine"; "RN,MHA" -> "RN, MHA"; "ORCIdD :-" -> "ORCID:"
const COUNTRIES = 'Pakistan|India|China|Malaysia|Bangladesh|Iran|Iraq|Turkey|Türkiye|Egypt|Nigeria|Saudi Arabia|Japan|Korea|Indonesia|Thailand|Vietnam|Nepal|Sri Lanka|Afghanistan|Jordan|Lebanon|Syria|Oman|Qatar|Kuwait|Bahrain|UAE|United Arab Emirates|USA|United States|UK|United Kingdom|Canada|Australia|Germany|France|Italy|Spain|Brazil|Mexico|South Africa|Kenya|Ethiopia|Ghana|Morocco|Algeria|Tunisia|Libya|Sudan|Yemen|Palestine|Russia|Poland|Romania|Greece|Portugal|Netherlands|Belgium|Sweden|Norway|Denmark|Finland|Switzerland|Austria|Ireland|Singapore|Philippines|Taiwan';
const PROVINCES = 'Punjab|Sindh|Balochistan|Baluchistan|Khyber Pakhtunkhwa|KPK|Gilgit-Baltistan|Azad Kashmir|Selangor|Johor|Penang|Sabah|Sarawak';
const NOT_PLACE = /^(?:University|College|Institute|Hospital|Journal|Society|Association|Council|Medical|National|Government|Republic|Bank|Army|Navy|Air|Railways|Agriculture|Agricultural|Pharmaceutical|Pharmacy|Islamic|Northern|Southern|Eastern|Western|Central|Upper|Lower|New|Sri|Saudi|South|North|East|West|United|Arab|Royal|State|Federal|Medicine|Sciences|Science|Technology|Health|Faculty|Department|School|Centre|Center|Laboratory|Company|Limited|Ltd|Inc|The|Of|And|Board|Commission|Authority|Ministry)$/;
function authorBlock(text, end) {
  const out = [];
  const block = text.slice(0, end);
  const add = (at, len, title, message, rep) => out.push({ rule: 'author-block', category: 'correctness', title, offset: at, length: len, text: text.substr(at, len), message, replacements: [rep] });
  // a missing comma before a country or province: "Punjab Pakistan", "Jhang Punjab"
  for (const m of block.matchAll(new RegExp(`\\b([A-Z][a-z]+)( )(?=(${COUNTRIES}|${PROVINCES})\\b(?![ \\t]+(?!(?:${COUNTRIES}|${PROVINCES})\\b)[A-Z][a-z])(?!-))`, 'g'))) {
    if (NOT_PLACE.test(m[1])) continue;
    const at = m.index + m[1].length;
    add(at, 1, 'Missing comma', `Separate the parts of an address with commas: "${m[1]}, ${m[3]}".`, ', ');
  }
  // a full stop between a city and its country: "Wardha. India"
  for (const m of block.matchAll(new RegExp(`\\b([A-Z][a-z]+)(\\.\\s+)(${COUNTRIES})\\b(?=\\s*(?:$|\\n|[,.;]))`, 'gm'))) {
    if (NOT_PLACE.test(m[1])) continue;
    add(m.index + m[1].length, m[2].length, 'Incorrect punctuation', `Use a comma between a city and its country: "${m[1]}, ${m[3]}".`, ', ');
  }
  // "Medicine department" -> "Department of Medicine"
  for (const m of block.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) department\b/g)) {
    if (/^(?:The|A|An|This|Our)$/.test(m[1])) continue;
    add(m.index, m[0].length, 'Misplaced words', `An affiliation names the department first: "Department of ${m[1]}".`, `Department of ${m[1]}`);
  }
  // degrees run together: "RN,MHA" -> "RN, MHA"
  for (const m of block.matchAll(/\b([A-Z][A-Za-z]{1,5}),([A-Z][A-Za-z]{1,5})\b/g)) add(m.index + m[1].length, 1, 'Spacing', 'Add a space after the comma.', ', ');
  // "ORCIdD :-", "Email /-" -> "ORCID:", "Email:"
  for (const m of block.matchAll(/\bORCI[dD]{1,2}\b/g)) if (m[0] !== 'ORCID') add(m.index, m[0].length, 'Spelling', 'The identifier is written "ORCID".', 'ORCID');
  for (const m of block.matchAll(/\s*(?::-|\/-|:\s*-(?=\s))/g)) add(m.index, m[0].length, 'Incorrect punctuation', 'Introduce the address or identifier with a colon alone.', ':');
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
    for (const m of part.matchAll(new RegExp(`\\b(is|are)\\s+((?:then|first|subsequently|carefully|gently|accurately)\\s+)?(${PROC_VERBS})\\b(?!\\s+as\\b)`, 'g'))) {
      // how data are reported and how a measure is defined are in the present tense: "data are expressed as mean ± SD",
      // "the incidence is calculated as"
      if (/^(?:data|values|results)$/i.test(part.slice(Math.max(0, m.index - 25), m.index).trim().split(/\s+/).pop() || '')) continue;
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
  // from the abstract on: the [1] [2] of the authors' affiliations are not citations
  const absAt = text.slice(0, 8000).search(/(?:^|\n)\s*abstract\b/i);
  const body = text.slice(Math.max(0, absAt), proseEnd);
  const numbered = (body.match(/(?<=[ \t])\[\s*\d+(?:\s*[-–,]\s*\d+)*\s*\]/g) || []).length;
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
    // the title page: everything before the first section heading (the abstract)
    const first = structure.sections.length ? structure.sections[0].start : null;
    if (first) out.push(...authorBlock(text, first));
  }
  const body = structure?.referencesAt != null ? text.slice(0, structure.referencesAt) : text;
  out.push(...hyphenation(body), ...capitals(body));
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
