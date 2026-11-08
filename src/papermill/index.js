// papermill/index.js - Module 4 Paper Mill Detection. Collects risk signals with evidence and weights:
//   text (tortured phrases, AI-text leftovers, template wording, vague methods), references (fabricated references,
//   citations to papers retracted for paper-mill reasons, predatory/hijacked journals, citation stacking), authors
//   (earlier retractions, free e-mail addresses, ORCID, affiliations, authorship changes, suggested reviewers) and data
//   (misidentified cell lines, duplicate submissions, image findings from Module 5).
// The result is a screening aid: LOW / MEDIUM / HIGH with the evidence for every signal. It never decides on its own.
const db = require('../db');
const D = require('../datasets');
const { getJson } = require('../http');
const { nameMatch, splitName, titleSimilarity, normalizeJournal } = require('../text');
const { TORTURED, AI_LEFTOVERS, TEMPLATES, CELL_LINES, FREE_MAIL, DISPOSABLE_MAIL } = require('./lists');
const { studyType, approvalNumber, hasDose } = require('./studyEthics');
const DC = require('./dataChecks');
const WL = require('./watchlist');
const { isOnline } = require('../http');

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ctx = (text, i, len) => text.slice(Math.max(0, i - 70), i + len + 70).replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ text signals

async function customPhrases() {
  try { return JSON.parse((await db.getMeta('tortured_custom')) || '[]'); } catch (e) { return []; }
}

function torturedPhrases(text, extra = []) {
  const hits = new Map();
  for (const t of [...TORTURED, ...extra]) {
    const re = new RegExp(`\\b${esc(t.phrase)}\\b`, 'gi');
    for (const m of text.matchAll(re)) {
      const k = t.phrase.toLowerCase();
      if (!hits.has(k)) hits.set(k, { phrase: t.phrase, correct: t.correct, count: 0, examples: [] });
      const h = hits.get(k);
      h.count++;
      if (h.examples.length < 2) h.examples.push(ctx(text, m.index, m[0].length));
    }
  }
  return [...hits.values()].sort((a, b) => b.count - a.count);
}

const isWordChar = c => !!c && /[\p{L}\p{N}]/u.test(c);
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** First whole-word occurrence of a lower-case phrase in lower-case text, or -1 */
function findWhole(lower, term) {
  for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + 1)) {
    if (!isWordChar(lower[i - 1]) && !isWordChar(lower[i + term.length])) return i;
  }
  return -1;
}

/**
 * Problematic Paper Screener fingerprints (tortured phrases, SCIgen text): every phrase of a fingerprint must occur.
 * Returns { tortured: [{phrase, correct, count, examples}], scigen: [{phrase, examples}] }
 */
async function screenerMatches(text) {
  const out = { tortured: [], scigen: [], suspect: [] };
  const fps = await D.ppsFingerprints().catch(() => []);
  if (!fps.length) return out;
  const lower = text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
  // a whole-word match needs every word of the phrase among the text's words: the fingerprints with a word the text lacks
  // are skipped before searching the text (searching all of them held the server for several seconds)
  const words = new Set(lower.split(WORD_SPLIT));
  for (const fp of fps) {
    // the phrases written as the text is ("dulbecco’s" with a curly apostrophe never matched the straightened text)
    const terms = fp._terms || (fp._terms = fp.terms.map(t => String(t).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ')));
    if (!(fp._words || (fp._words = terms.flatMap(t => t.split(WORD_SPLIT)).filter(Boolean))).every(w => words.has(w))) continue;
    const at = terms.map(t => findWhole(lower, t));
    if (at.some(i => i === -1)) continue;
    const phrase = fp.terms.join(' + ');
    const example = ctx(lower, at[0], fp.terms[0].length);
    // Mathgen writes mathematics papers the way SCIgen writes computer-science ones: same signal
    if (fp.kind === 'scigen' || fp.kind === 'mathgen') out.scigen.push({ phrase, examples: [example] });
    else if (fp.kind === 'suspect') out.suspect.push({ phrase, note: fp.expected || '', examples: [example] });
    else out.tortured.push({ phrase, correct: fp.expected || '', count: 1, examples: [example] });
  }
  return out;
}

function aiLeftovers(text) {
  const out = [];
  for (const [re, label] of AI_LEFTOVERS) {
    const m = text.match(re);
    if (m) out.push({ label, found: m[0], example: ctx(text, m.index, m[0].length) });
  }
  return out;
}

function templateWording(text) {
  const out = [];
  for (const [re, label] of TEMPLATES) {
    const m = text.match(re);
    if (m) out.push({ label, found: m[0], example: ctx(text, m.index, m[0].length) });
  }
  return out;
}

// ---- paper-mill profiles, set from the benchmark of 150 paper-mill retractions vs 126 papers of the same journals
// (tuned on one half, checked on the other; docs/benchmark-papermill.md)
const MILL_TECH = /\b(big data|deep learning|neural networks?|internet of things|IoT|intelligent|cloud computing|edge computing|machine learning|data mining|5G|blockchain|artificial intelligence|wireless sensors?|fuzzy|genetic algorithm|particle swarm|virtual reality|computer vision|mobile edge|optimi[sz]ation (algorithm|model)|multimedia|network environment|new media|information technology|digital twin|BD mining)\b/i;
const MILL_OFFTOPIC = /\b(education|college|universit(y|ies)|teaching|students?|music|sports?|athletes?|arts?|ideolog\w*|political|civics|marxis\w*|english|economic\w*|enterprises?|tourism|legal|law|management|culture|cultural|marketing|financ\w*|accounting|forestry|traffic|pavement|agricultur\w*|rural|urban|landscape|architect\w*|furniture|dance|painting|literature|translation|vocal|piano|employment|entrepreneur\w*|logistics|supply chain|gas field|tax\w*|corporate|social responsibility|building construction|library)\b/i;
const MILL_BIO = /\b(patients?|cells?|clinical|disease|cancer|tumou?r|rats?|mice|drugs?|therap\w*|treatment|diagnos\w*|medic\w*|health|nursing|hospital|proteins?|genes?|pharma\w*|ultrasound|imaging|psycholog\w*|plants?|extracts?)\b/i;
const MILL_ASSAYS = [/CCK-?8|MTT assay/i, /transwell/i, /wound[- ]healing|scratch assay/i, /colony formation/i, /flow cytometr/i, /western blot/i, /qRT-PCR|RT-qPCR|quantitative real-time PCR/i, /dual[- ]luciferase/i, /xenograft/i, /TUNEL/i, /\bEdU\b/, /RNA immunoprecipitation|\bRIP assay/, /chromatin immunoprecipitation|\bChIP\b/, /immunohistochemi/i, /ELISA/i];
const MILL_LINES = /\b(A549|HCT116|SW480|SW620|HepG2|Huh-?7|MCF-?7|MDA-MB-231|HeLa|SGC-?7901|BGC-?823|U87|U251|PANC-1|HT-?29|LoVo|T24|PC-?3|DU145|SKOV3|Hep3B|MKN-?45|AGS|LNCaP|H1299|HK-2|HUVECs?)\b/g;

/** The title: given, or the first short line of the manuscript */
function titleOf(text, given) {
  if (given) return String(given);
  const line = (text || '').split('\n').map(l => l.trim()).find(l => l.length >= 20);
  return line && line.length <= 300 && !/[.:]$/.test(line) ? line : '';
}

/**
 * The two profiles that recur in paper-mill output:
 *  - offScope: a technology buzzword applied to a non-biomedical subject ("big data" + ideological education, music,
 *    forestry economics...), submitted to a biomedical / pharmaceutical journal: mass special-issue mills.
 *  - template: the molecular-oncology template (non-coding RNA "axis" title, the same stack of assays, standard cancer
 *    cell lines, xenograft in nude mice). Each element is legitimate; the full stack together is the template.
 */
function millProfile(text, title) {
  const offScope = !!title && MILL_TECH.test(title) && MILL_OFFTOPIC.test(title) && !MILL_BIO.test(title);
  const assays = MILL_ASSAYS.filter(r => r.test(text)).length;
  const lines = new Set((text.match(MILL_LINES) || []).map(x => x.toUpperCase().replace(/-/g, ''))).size;
  const lineMentions = (text.match(MILL_LINES) || []).length;
  const parts = [];
  if (/\b(lnc ?rna|circ ?rna|circ[_-]\w|mir-\d|microrna|long non-?coding|ceRNA)/i.test(title)) parts.push({ pts: 2, text: 'Non-coding RNA in the title' });
  if (/\b(by|via|through)\b.*\b(regulat|target|activat|inhibit|modulat|suppress|mediat|spong|upregulat|downregulat)\w*/i.test(title)) parts.push({ pts: 1, text: 'Title of the form "X does Y via regulating Z"' });
  if (assays >= 5) parts.push({ pts: assays >= 7 ? 2 : 1, text: `${assays} standard assays stacked (CCK-8/MTT, Transwell, wound healing, colony formation, flow cytometry, western blot, qRT-PCR, luciferase ...)` });
  if (lineMentions >= 5) parts.push({ pts: 1, text: `Standard cancer cell lines used throughout (${lines} line(s), ${lineMentions} mentions)` });
  if (/xenograft|nude mice/i.test(text)) parts.push({ pts: 1, text: 'Xenograft in nude mice' });
  return { offScope, template: parts.reduce((a, p) => a + p.pts, 0), parts };
}

/** Methods that cannot be repeated: no supplier, catalogue number, dose, sample size or ethics approval */
function methodsGaps(text) {
  const methods = (text.match(/(?:^|\n)\s*(?:\d+\.?\s*)?(?:materials? and methods|methods?|methodology|experimental(?: section| procedures)?)\s*\n([\s\S]{200,30000}?)(?:\n\s*(?:\d+\.?\s*)?(?:results|results and discussion|discussion)\s*\n|$)/i) || [])[1] || '';
  const scope = methods || text;
  // an animal / human study only when the paper reports the work itself (not a mention of rats in the introduction)
  const { animal: animals, human: humans } = studyType(text);
  const reagents = /\b(reagents?|chemicals?|antibod(?:y|ies)|kits?|cell lines?|media|serum)\b/i.test(scope);
  const gaps = [];
  const ethics = animals || humans ? approvalNumber(text) : null;
  if (ethics && !ethics.approval) {
    gaps.push({ code: 'ethics', message: `${animals && humans ? 'Human and animal' : animals ? 'Animal' : 'Human'} study with no ethics approval (committee or approval number) stated` });
  } else if (ethics && !ethics.number) {
    gaps.push({ code: 'ethics-number', message: 'Ethics approval mentioned without an approval / reference number', quote: ethics.approval.sentence });
  }
  if (reagents && !/\b(purchased from|obtained from|supplied by|procured from|gift from|Sigma|Merck|Thermo|Invitrogen|Abcam|ATCC|Bio-?Rad|Santa Cruz|Cell Signaling|BDH|Fluka|Daejung|Scharlau)\b/i.test(scope)) {
    gaps.push({ code: 'supplier', message: 'Reagents, kits or cells used without naming the supplier' });
  }
  // doses only matter when the animals were treated; mg/kg, mg kg-1, mg/kg b.w., mL/100 g ... all count
  if (animals && /\b(?:treated|administered|dosed|given|received|gavage|injected|oral(?:ly)?|intraperitoneal(?:ly)?|i\.p\.|p\.o\.)\b/i.test(scope) && !hasDose(text)) gaps.push({ code: 'dose', message: 'Animal study without doses (mg/kg or similar)' });
  if ((animals || humans) && !/\b(?:n\s*=\s*\d+|\d+\s+(?:rats|mice|animals|patients|participants|subjects|volunteers)|(?:groups?|each) of \d+|sample size)\b/i.test(scope)) gaps.push({ code: 'sample', message: 'No sample size (n = …) stated' });
  return { checked: !!methods || animals || humans, methodsFound: !!methods, gaps };
}

function cellLines(text) {
  const out = [];
  for (const c of CELL_LINES) {
    const re = new RegExp(`(?<![\\w-])${esc(c.name)}(?![\\w-])`, 'g');
    for (const m of text.matchAll(re)) {
      const around = text.slice(Math.max(0, m.index - 80), m.index + 80);
      if (!/\bcells?\b|\bcell lines?\b|\bline\b/i.test(around)) continue;
      out.push({ name: c.name, actual: c.actual, nonVerifiable: !!c.nonVerifiable, example: ctx(text, m.index, m[0].length) });
      break;
    }
  }
  return out;
}

// Immune-cell and marker names that read like cell lines ("CD4 cells", "Th17 cells", "M1 cells")
const NOT_CELL_LINE = /^(?:CD\d|Th\d|Tc\d|IL-?\d|M[12]$|B\d|T\d|NK\d|G[0-2]$|S$|ES$|iPS)/i;

/** Cell-line names written as "X cells" / "X cell line" (must contain a digit), minus those already reported */
function cellLineCandidates(text, skip = new Set()) {
  const out = new Map();
  for (const m of text.matchAll(/\b([A-Z][A-Za-z]{0,7}-?\d[A-Za-z0-9]{0,6}(?:-[A-Za-z0-9]{1,6})?)\s+(cell lines?|cells?)\b/g)) {
    const name = m[1].trim();
    const k = name.toLowerCase();
    if (skip.has(k) || NOT_CELL_LINE.test(name) || /^\d/.test(name)) continue;
    const prev = out.get(k);
    const calledLine = /line/i.test(m[2]) || /\bcell lines?\b/i.test(text.slice(Math.max(0, m.index - 40), m.index));
    if (!prev) out.set(k, { name, calledLine, example: ctx(text, m.index, m[0].length) });
    else if (calledLine) prev.calledLine = true;
  }
  return [...out.values()];
}

/** Zero-width characters and look-alike letters from other alphabets: used to slip past plagiarism software */
function hiddenText(text) {
  // zero-width characters only: soft hyphens are ordinary typesetting in publisher files and not a disguise
  const zero = (text.match(/[\u200B-\u200D\u2060\uFEFF]/g) || []).length;
  const mixed = [];
  // Greek letters are routine in science (TNFα, ΔΔCt, NF-κB). Only Cyrillic letters, or Greek capitals that look like Latin ones
  // (Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ), inside an otherwise Latin word are used to slip past plagiarism software.
  const lookalikeGreek = /[ΑΒΕΖΗΙΚΜΝΟΡΤΥΧ]/u;
  for (const m of text.matchAll(/\p{L}{4,}/gu)) {
    const w = m[0];
    if (!/\p{Script=Latin}/u.test(w)) continue;
    const latin = (w.match(/\p{Script=Latin}/gu) || []).length;
    if (/\p{Script=Cyrillic}/u.test(w) || (lookalikeGreek.test(w) && latin >= 3 && !/[α-ω]/u.test(w))) { mixed.push(w); if (mixed.length >= 8) break; }
  }
  return { zero, mixed };
}

// known paper-mill papers (as Clear Skies' Papermill Alarm): src/papermill/millIndex.js
const MI = require('./millIndex');
const millLookalikes = (title, opts) => MI.titleLookalikes(title, opts);

/**
 * A paper with the same title is already published or posted (duplicate / redundant publication): Crossref (DOIs),
 * OpenAlex (journals, preprints) and CORE (repositories, theses, preprint servers). Merged by DOI / title.
 */
async function publishedElsewhere(title) {
  if (!title || title.length < 25) return [];
  const S = require('../sources');
  const [cr, oa, core] = await Promise.all([
    getJson('https://api.crossref.org/works?rows=4&select=DOI,title,container-title,issued&query.bibliographic=' + encodeURIComponent(title), { ttl: 7 * 86400, timeout: 12000, retries: 1 })
      .then(r => (r.ok ? (r.data?.message?.items || []).map(it => ({ title: (it.title || [])[0] || '', journal: (it['container-title'] || [])[0] || '', year: it.issued?.['date-parts']?.[0]?.[0] || null, doi: it.DOI, source: 'Crossref' })) : [])).catch(() => []),
    S.openalexSearch({ title }).then(r => (r.records || []).map(x => ({ title: x.title, journal: x.journal, year: x.year, doi: x.doi, url: x.url, source: 'OpenAlex' }))).catch(() => []),
    S.coreSearch({ title }).then(r => (r.records || []).map(x => ({ title: x.title, journal: x.journal || x.publisher, year: x.year, doi: x.doi, url: x.url, source: 'CORE' }))).catch(() => [])
  ]);
  const out = new Map();
  for (const x of [...cr, ...oa, ...core]) {
    const sim = titleSimilarity(title, x.title || '');
    if (sim < 0.92) continue;
    const key = x.doi ? String(x.doi).toLowerCase() : String(x.title).toLowerCase().replace(/\W+/g, '');
    const prev = out.get(key);
    if (prev) { if (!prev.sources.includes(x.source)) prev.sources.push(x.source); continue; }
    out.set(key, { ...x, sim, sources: [x.source] });
  }
  return [...out.values()];
}

// ------------------------------------------------------------------ author signals

const ORCID_RE = /\b(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/g;

function orcidValid(id) {
  const d = id.replace(/-/g, '');
  let total = 0;
  for (let i = 0; i < 15; i++) total = (total + parseInt(d[i], 10)) * 2;
  const r = (12 - (total % 11)) % 11;
  return (r === 10 ? 'X' : String(r)) === d[15];
}

async function orcidProfile(id) {
  const [works, rec] = await Promise.all([
    getJson(`https://pub.orcid.org/v3.0/${id}/works`, { ttl: 7 * 86400, timeout: 12000, retries: 1 }),
    getJson(`https://pub.orcid.org/v3.0/${id}/person`, { ttl: 7 * 86400, timeout: 12000, retries: 1 })
  ]);
  if (works.status === 404) return { id, exists: false };
  if (!works.ok) return { id, error: works.error || `HTTP ${works.status}` };
  const name = rec.ok ? `${rec.data?.name?.['given-names']?.value || ''} ${rec.data?.name?.['family-name']?.value || ''}`.trim() : '';
  const created = rec.ok ? rec.data?.['last-modified-date']?.value : null;
  const dois = [...new Set((works.data?.group || []).flatMap(g => (g['external-ids']?.['external-id'] || []).filter(x => x['external-id-type'] === 'doi').map(x => String(x['external-id-value'] || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim())).filter(Boolean))];
  return { id, exists: true, works: (works.data?.group || []).length, name, dois, lastModified: created ? new Date(created).toISOString().slice(0, 10) : null };
}

function emailsOf(text) {
  return [...new Set((text.slice(0, 12000).match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(e => e.toLowerCase().replace(/[.,;]+$/, '')))];
}

const AFF_STOP = new Set(['university', 'universit', 'department', 'faculty', 'college', 'institute', 'school', 'hospital', 'centre', 'center', 'pakistan', 'the', 'and', 'of', 'for', 'sciences', 'science', 'medical', 'pharmacy', 'pharmaceutical', 'research', 'national',
  // subject and generic words shared by thousands of departments: "health" or "pathology" in common is not the same institution
  'health', 'dental', 'dentistry', 'pathology', 'pharmacology', 'pharmaceutics', 'pharmacognosy', 'biochemistry', 'biotechnology', 'biology', 'chemistry', 'physics', 'zoology', 'botany', 'physiology', 'anatomy', 'microbiology', 'medicine', 'clinical', 'engineering', 'technology', 'information', 'studies', 'laboratory', 'state', 'government', 'public', 'international', 'applied', 'natural', 'basic', 'allied', 'veterinary', 'animal', 'animals', 'agriculture', 'agricultural', 'environment', 'environmental', 'teaching', 'campus', 'graduate', 'postgraduate', 'division', 'section', 'unit', 'program', 'programme', 'life', 'molecular', 'cell', 'cellular', 'nursing', 'surgery', 'women', 'children', 'general', 'city', 'province', 'provincial', 'federal', 'china', 'saudi', 'arabia', 'kingdom', 'republic', 'india', 'iran',
  // hospital and university name parts used by hundreds of institutions ("First Affiliated Hospital", "People's Hospital")
  'affiliated', 'people', 'peoples', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'chinese', 'traditional', 'integrated', 'western', 'municipal', 'central', 'normal', 'region', 'regional', 'autonomous', 'county', 'district', 'king', 'computer', 'technical', 'surgical', 'intensive', 'care', 'emergency', 'oncology', 'cancer', 'cardiology', 'neurology', 'radiology', 'orthopedics', 'orthopaedics', 'pediatrics', 'paediatrics', 'obstetrics', 'gynecology', 'urology', 'nephrology', 'respiratory', 'infectious', 'diseases', 'disease', 'biomedical', 'center', 'centers', 'key', 'joint', 'south', 'north', 'east', 'west', 'southern', 'northern', 'eastern', 'medical',
  // fields and generic words of other departments and languages ("Ministry of Education", "Facultad de Ciencias de la Salud")
  'ministry', 'education', 'electronic', 'electronics', 'electrical', 'mechanical', 'mathematics', 'mathematical', 'business', 'economics', 'management', 'computing', 'artificial', 'intelligence', 'development', 'deemed', 'egypt',
  'universidad', 'universidade', 'universita', 'facultad', 'faculdade', 'ciencias', 'ciencia', 'salud', 'saude', 'instituto', 'departamento', 'escuela', 'nacional']);
// Cities: a shared city is a weak hint only ("Multan" covers several universities and hospitals)
const AFF_PLACES = new Set(['karachi', 'lahore', 'islamabad', 'rawalpindi', 'multan', 'faisalabad', 'peshawar', 'quetta', 'hyderabad', 'bahawalpur', 'sialkot', 'gujranwala', 'abbottabad', 'jamshoro', 'sargodha', 'larkana', 'sukkur', 'nawabshah', 'mardan', 'gujrat', 'sahiwal', 'kohat', 'dera', 'ismail', 'punjab', 'sindh', 'khyber', 'pakhtunkhwa', 'balochistan', 'lyari',
  // China (provinces and large cities), the Gulf, India, Iran, Egypt: where most name-matched retractions come from
  'beijing', 'shanghai', 'tianjin', 'chongqing', 'guangzhou', 'shenzhen', 'wuhan', 'chengdu', 'nanjing', 'hangzhou', 'xian', 'shenyang', 'changsha', 'zhengzhou', 'jinan', 'harbin', 'kunming', 'hefei', 'fuzhou', 'nanchang', 'qingdao', 'dalian', 'suzhou', 'xiamen', 'ningbo', 'wenzhou', 'changchun', 'taiyuan', 'shijiazhuang', 'lanzhou', 'nanning', 'guiyang', 'urumqi', 'haikou', 'hohhot', 'yinchuan', 'xining', 'lhasa', 'xuzhou', 'wuxi', 'guangdong', 'jiangsu', 'zhejiang', 'shandong', 'henan', 'hubei', 'hunan', 'sichuan', 'hebei', 'shanxi', 'shaanxi', 'liaoning', 'jilin', 'heilongjiang', 'anhui', 'fujian', 'jiangxi', 'yunnan', 'guizhou', 'guangxi', 'gansu', 'xinjiang', 'mongolia', 'hainan', 'ningxia', 'qinghai', 'tibet',
  'riyadh', 'jeddah', 'makkah', 'mecca', 'medina', 'madinah', 'dammam', 'abha', 'taif', 'tabuk', 'sakaka', 'qassim', 'dubai', 'sharjah', 'doha', 'kuwait', 'muscat', 'manama', 'cairo', 'giza', 'alexandria', 'mansoura', 'tehran', 'tabriz', 'shiraz', 'isfahan', 'mashhad', 'delhi', 'mumbai', 'chennai', 'kolkata', 'bangalore', 'bengaluru', 'pune', 'dhaka', 'istanbul', 'ankara', 'baghdad', 'riyad',
  // Indian states and cities
  'tamil', 'nadu', 'kerala', 'karnataka', 'odisha', 'orissa', 'maharashtra', 'gujarat', 'telangana', 'andhra', 'pradesh', 'uttar', 'uttarakhand', 'bengal', 'rajasthan', 'haryana', 'bihar', 'assam', 'jharkhand', 'chhattisgarh', 'madhya', 'noida', 'mohali', 'chandigarh', 'lucknow', 'jaipur', 'bhubaneswar', 'kanchipuram', 'vellore', 'coimbatore', 'madurai', 'mysore', 'mysuru', 'mangalore', 'manipal', 'hyderabad', 'ahmedabad', 'nagpur', 'indore', 'bhopal', 'patna', 'varanasi', 'kanpur', 'ghaziabad', 'gurgaon', 'gurugram', 'faridabad', 'ludhiana', 'amritsar', 'jalandhar', 'phagwara', 'dehradun']);
const affTokens = s => new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/).filter(t => t.length > 3 && !AFF_STOP.has(t)));
// A name is treated as common when Retraction Watch holds it on papers from this many different institutions: one
// person retracted many times is usually at one or two places, a common name ("Muhammad Ali", "Wei Zhang") is everywhere
const COMMON_NAME_PLACES = 4;
// Neighbouring word pairs of the institution name ("veterinary animal" for the University of Veterinary and Animal
// Sciences): institutions named only with subject words still match each other, a lone subject word does not
const PAIR_SKIP = new Set(['the', 'and', 'of', 'for', 'department', 'faculty', 'institute', 'school', 'college', 'university', 'universit', 'centre', 'center', 'pakistan', 'dept']);
// a pair with one of these words is generic ("health sciences", "medical dental" name hundreds of institutions)
const PAIR_GENERIC = new Set(['sciences', 'science', 'medical', 'dental', 'health', 'research', 'studies', 'technology', 'engineering', 'hospital', 'medicine', 'pharmaceutical', 'pharmacy', 'clinical', 'national', 'international', 'applied', 'natural', 'life', 'basic', 'allied', 'general', 'teaching', 'government', 'public', 'state', 'key', 'laboratory',
  // country names: "Saudi Arabia" or "People's Republic of China" in common says nothing about the institution
  'saudi', 'arabia', 'republic', 'china', 'people', 'peoples', 'kingdom', 'united', 'states', 'india', 'iran', 'egypt', 'japan', 'korea', 'turkey', 'malaysia', 'nigeria', 'pakistan', 'tamil', 'nadu', 'academy', 'affiliated', 'first', 'second', 'third', 'chinese']);
const affPairs = s => {
  const out = new Set();
  for (const part of String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[;,]/)) {
    const w = part.split(/[^a-z]+/).filter(t => t.length > 2 && !PAIR_SKIP.has(t));
    for (let i = 0; i + 1 < w.length; i++) if (![w[i], w[i + 1]].some(t => AFF_PLACES.has(t) || PAIR_GENERIC.has(t))) out.add(`${w[i]} ${w[i + 1]}`);
  }
  return out;
};
const instKey = s => String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().slice(0, 40);

/**
 * Retraction Watch lists authors by name only, so a name match can be another person. Each hit carries a confidence:
 *   high   - first name agrees (not only the initial) and the retracted paper's institution shares a distinctive word
 *            with an affiliation (not a subject word such as "health" and not only the city)
 *   medium - first name agrees in full and the name is not a common one
 *   low    - surname + initial only, or a common name (retractions at 4+ different institutions) with no institution match
 */
async function authorRetractions(authors, affiliations = []) {
  const out = [];
  const myAff = affTokens((affiliations || []).join(' '));
  const myPairs = affPairs((affiliations || []).join('; '));
  const myPk = /pakistan|\bpk\b/i.test((affiliations || []).join(' '));
  const myOffField = NON_BIOMED.test((affiliations || []).join(' '));
  // the first word of the first name, when it is a name and not an initial ("M. A." gives none)
  const firstWord = g => { const w = String(g || '').toLowerCase().split(/[\s.]+/).filter(Boolean)[0] || ''; return w.replace(/-/g, '').length > 1 ? w.replace(/-/g, '') : ''; };
  for (const a of authors.slice(0, 15)) {
    if (!a.family || a.family.length < 2 || (a.family.length < 3 && String(a.given || '').replace(/[.\s-]/g, '').length < 2)) continue;
    const rows = await D.retractionsByAuthor(a.family, a.given).catch(() => []);
    const hits = [];
    for (const r of rows) {
      const names = String(r.authors || '').split(/\s*;\s*/).map(n => splitName(n.trim())).filter(n => n.family);
      if (!names.some(n => nameMatch(n, a) === 'exact' || (nameMatch(n, a) === 'likely' && n.given && a.given && n.given[0] === a.given[0]))) continue;
      const theirName = names.find(n => nameMatch(n, a) === 'exact' || nameMatch(n, a) === 'likely');
      // initials only ("M. A. Khan") are not a first name, even two of them
      const fullFirst = !!(firstWord(theirName?.given) && firstWord(theirName.given) === firstWord(a.given));
      const theirAff = affTokens(r.institution);
      const shared = [...myAff].filter(t => theirAff.has(t));
      const theirPairs = affPairs(r.institution);
      const pairs = [...myPairs].filter(p => theirPairs.has(p));
      // co-authors: another author of the manuscript, with the same full name, on the same retracted paper. Two names
      // together on one paper identify the group far better than an institution word does
      const coauthors = authors.filter(b => b !== a && b.family && firstWord(b.given) && names.some(n => n !== theirName && nameMatch(n, b) === 'exact' && firstWord(n.given) === firstWord(b.given)))
        .map(b => `${b.given} ${b.family}`.trim());
      // a retraction from an engineering, business or mathematics department, for an author of a biomedical manuscript
      // (every institution of the paper: one co-author from such a department says nothing)
      const offField = !myOffField && !!r.institution && String(r.institution).split(/\s*;\s*/).filter(Boolean).every(x => NON_BIOMED.test(x));
      hits.push({ r, fullFirst, coauthors, offField, distinctive: [...shared.filter(t => !AFF_PLACES.has(t)), ...pairs], places: shared.filter(t => AFF_PLACES.has(t)) });
    }
    const common = new Set(hits.filter(h => h.fullFirst && h.r.institution).map(h => instKey(h.r.institution))).size >= COMMON_NAME_PLACES;
    for (const { r, fullFirst, coauthors, offField, distinctive, places } of hits) {
      const sameCountry = myPk && /pakistan/i.test(r.country || '');
      const confidence = !fullFirst ? 'low'
        : coauthors.length ? 'high'
        : offField ? 'low'
        // a common name needs two distinctive words of the institution in common: one ward or hospital name is not enough
        : distinctive.length >= (common ? 2 : 1) ? 'high'
        : common ? 'low'
        : (places.length || (sameCountry && !r.institution)) ? 'high' : 'medium';
      out.push({ confidence, commonName: common, offField, coauthors, institutionMatch: [...distinctive, ...places].slice(0, 3), sameCountry, institution: (r.institution || '').slice(0, 160), author: `${a.given} ${a.family}`.trim(), title: r.title, journal: r.journal, date: r.retraction_date, doi: r.doi, reason: r.reason, mill: D.MILL_REASON_RE.test(r.reason || '') });
    }
  }
  return out;
}

/**
 * The ORCID iD Crossref lists for the author of a retracted paper who has this name (publishers deposit many), or null.
 * Benchmark (8 Nov 2026, PMC mill and ordinary papers whose XML gives the authors' ORCID iDs): of the HIGH name matches
 * it could settle, 56 were the same ORCID iD (the same person) and 8 another one (another person with the same name).
 */
async function crossrefAuthorOrcid(doi, a) {
  const r = await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { ttl: 30 * 86400, timeout: 15000, retries: 1 });
  const list = r.ok ? r.data?.message?.author || [] : [];
  const m = list.find(x => x.family && x.ORCID && ['exact', 'likely'].includes(nameMatch({ given: x.given || '', family: x.family }, a)));
  return m ? String(m.ORCID).replace(/^https?:\/\/orcid\.org\//i, '') : null;
}
const orcidDigits = o => String(o || '').replace(/[^\dX]/gi, '').toUpperCase().slice(-16);

const NON_BIOMED = /\b(?:mechanical|electrical|civil|chemical engineering|computer science|software|business|management sciences|economics|commerce|mathematics|physics|english|law|architecture|mass communication|islamic studies)\b/i;

// ------------------------------------------------------------------ duplicate submissions (text fingerprints)

function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Sampled 6-word shingles of the manuscript text */
function shingles(text) {
  const words = String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w.length > 1);
  const out = new Set();
  for (let i = 0; i + 6 <= words.length; i++) {
    const h = fnv(words.slice(i, i + 6).join(' '));
    if (h % 8 === 0) out.add(h);
  }
  return [...out].slice(0, 6000);
}

const WAVE_DAYS = 180;
const familyOf = name => String(name || '').trim().split(/\s+/).pop().toLowerCase();
/** Share of content words two titles have in common once the specific names (genes, drugs, numbers) are set aside */
function templateSimilarity(a, b) {
  const { tokens } = require('../checks/novelty');
  const words = t => new Set(tokens(t).filter(w => /^[a-z]+$/.test(w)));
  const x = words(a), y = words(b);
  if (x.size < 4 || y.size < 4) return 0;
  let k = 0;
  for (const w of x) if (y.has(w)) k++;
  return k / Math.min(x.size, y.size);
}

async function duplicateSubmissions({ body, meta, excludeCode, excludeCheckIds = [] }) {
  const skip = new Set(excludeCheckIds.map(Number).filter(Boolean));
  const mine = new Set(shingles(body));
  const waves = [];
  const myFamilies = new Set((meta.authors || []).map(a => String(a.family || a.name || '').trim().split(/\s+/).pop().toLowerCase()).filter(Boolean));
  const rows = await db.all("SELECT id, check_id, manuscript_code, title, data, created_at FROM fingerprints WHERE kind = 'text' ORDER BY created_at DESC LIMIT 3000");
  const out = [];
  for (const r of rows) {
    if (excludeCode && r.manuscript_code && r.manuscript_code === excludeCode) continue;
    // a re-run is not a duplicate of the report it re-runs (or of earlier runs of the same report)
    if (skip.has(Number(r.check_id))) continue;
    const theirs = r.data?.shingles || [];
    let inter = 0;
    for (const h of theirs) if (mine.has(h)) inter++;
    const overlap = mine.size && theirs.length ? inter / Math.min(mine.size, theirs.length) : 0;
    const tsim = meta.title && r.title ? titleSimilarity(meta.title, r.title) : 0;
    if (overlap >= 0.2 || tsim >= 0.9) out.push({ manuscriptCode: r.manuscript_code, title: r.title, checkId: r.check_id, date: r.created_at, textOverlap: Math.round(overlap * 100), titleSimilarity: Math.round(tsim * 100) });
    else if (Date.now() - new Date(r.created_at).getTime() < WAVE_DAYS * 86400e3) {
      // a wave: different manuscripts by different authors, built on the same title template or the same boilerplate
      const tw = templateSimilarity(meta.title, r.title);
      const shared = (r.data?.authors || []).some(a => myFamilies.has(familyOf(a)));
      if (!shared && (tw >= 0.5 || overlap >= 0.08)) waves.push({ manuscriptCode: r.manuscript_code, title: r.title, checkId: r.check_id, date: r.created_at, textOverlap: Math.round(overlap * 100), titleTemplate: Math.round(tw * 100) });
    }
  }
  return { compared: rows.length, matches: out.sort((a, b) => b.textOverlap - a.textOverlap).slice(0, 10), waves: waves.slice(0, 10), shingles: [...mine] };
}

async function previousAuthors(code, version) {
  if (!code) return null;
  const row = await db.one("SELECT data FROM fingerprints WHERE kind = 'text' AND manuscript_code = $1 ORDER BY created_at DESC LIMIT 1", [code]);
  return row?.data?.authors || null;
}

/** Store the fingerprint of a screened manuscript (after the check is saved) */
async function storeFingerprint({ checkId, userId, meta, shingles: sh, text }) {
  // No repository (as Turnitin's setting): the manuscript's text and abstract are never stored. Only sampled hashes of
  // 6-word sequences are kept - they cannot be turned back into text - so Module 4 can still recognise the same
  // manuscript submitted again; the similarity report does not compare with them.
  void text;
  if (!sh?.length) return;
  await db.query("INSERT INTO fingerprints(check_id, user_id, manuscript_code, kind, title, data) VALUES($1, $2, $3, 'text', $4, $5)",
    [checkId || null, userId || null, meta.manuscriptCode || null, (meta.title || '').slice(0, 300), JSON.stringify({ shingles: sh, authors: (meta.authors || []).map(a => `${a.given} ${a.family}`.trim()) })]);
}

// ------------------------------------------------------------------ scoring

/** The Module 5 signal from the image report summary ({ findings: byLevel, categories }), or null */
function imagesSignal(images) {
  const f = images?.findings;
  if (!f) return null;
  const cat = images.categories || {};
  const catText = Object.entries({ duplication: 'duplicated', manipulation: 'manipulated', ai: 'AI-generated', chart: 'duplicated-chart' }).filter(([k]) => cat[k]).map(([k, l]) => `${cat[k]} ${l}`).join(', ');
  const signal = (title, severity, weight) => ({ group: 'data', code: 'images', title, severity, weight, evidence: [], note: '' });
  if (f.high) return signal(`Image Integrity (Module 5): ${f.high} strong finding(s)${catText ? ` (${catText})` : ' of duplicated or edited figures'}`, 'high', 5);
  if (f.medium) return signal(`Image Integrity (Module 5): ${f.medium} finding(s) to check`, 'medium', 2);
  return null;
}

function riskLevel(signals) {
  const score = signals.reduce((a, s) => a + s.weight, 0);
  const highs = signals.filter(s => s.severity === 'high').length;
  let level = score >= 8 || highs >= 2 ? 'HIGH' : score >= 4 || highs === 1 ? 'MEDIUM' : 'LOW';
  return { level, score, highSignals: highs };
}

/** The text-only signals (no network): the exact logic used by detectPaperMill and by the benchmark. */
async function textSignals(text, body = text, custom = [], opts = {}) {
  const signals = [];
  const sig = (group, code, title, severity, weight, evidence = [], note = '') => signals.push({ group, code, title, severity, weight, evidence, note });
  const title = titleOf(text, opts.title);
  const mp = millProfile(body, title);
  if (mp.offScope) sig('text', 'off-scope', 'Technology buzzwords applied to a subject outside biomedicine', 'medium', 4, [{ text: `Title: “${title.slice(0, 200)}”` }],
    'The profile of the mass special-issue paper mills (big data / deep learning / IoT with education, music, ideology, economics ...): 7 of 150 known mill papers against 0 genuine biomedical papers in the benchmark. Out of scope for a pharmaceutical journal in any case.');
  if (mp.template >= 4) sig('text', 'mill-template', `Molecular-oncology paper-mill template (${mp.template} of 8 features)`, mp.template >= 6 ? 'medium' : 'low', mp.template >= 6 ? 4 : mp.template >= 5 ? 2 : 1, mp.parts.map(p => ({ text: p.text })),
    'Every element is legitimate on its own. Together they form the template of many retracted paper-mill papers (6+ features: 13 of 150 mill papers, 0 of 126 genuine papers in the benchmark). Check the figures (Module 5) and the raw data.');
  const screener = await screenerMatches(body);
  const tortured = torturedPhrases(body, custom);
  const known = new Set(tortured.map(t => t.phrase.toLowerCase()));
  for (const t of screener.tortured) if (!known.has(t.phrase.toLowerCase())) tortured.push(t);
  if (screener.scigen.length >= 2) sig('text', 'scigen', `Text matching computer-generated (SCIgen / Mathgen) papers: ${screener.scigen.length} fingerprint(s)`, screener.scigen.length >= 4 ? 'high' : 'medium', screener.scigen.length >= 4 ? 5 : 3,
    screener.scigen.slice(0, 8).map(s => ({ text: `“${s.phrase}”`, quote: s.examples[0] })), 'Sentences found in papers generated by SCIgen- and Mathgen-style programs (Problematic Paper Screener fingerprints).');
  if (screener.suspect.length) sig('text', 'suspect', `${screener.suspect.length} suspect expression(s) (typos or template residue)`, 'low', Math.min(2, screener.suspect.length),
    screener.suspect.slice(0, 8).map(s => ({ text: `“${s.phrase}”${s.note ? ` — ${s.note}` : ''}`, quote: s.examples[0] })), 'Typos and leftovers that the Problematic Paper Screener has seen in problematic papers; weak on their own.');
  if (tortured.length) sig('text', 'tortured', `${tortured.length} tortured phrase(s): ${tortured.slice(0, 3).map(t => `“${t.phrase}” (= ${t.correct})`).join(', ')}`, tortured.length >= 3 ? 'high' : 'medium', tortured.length >= 3 ? 5 : 2,
    tortured.map(t => ({ text: `“${t.phrase}” → ${t.correct}${t.count > 1 ? ` (×${t.count})` : ''}`, quote: t.examples[0] })), 'Odd synonyms produced by paraphrasing tools to hide copied text (Problematic Paper Screener).');
  const ai = aiLeftovers(text);
  if (ai.length) sig('text', 'ai-leftover', `AI-generated text or template left in the manuscript (${ai.length})`, 'high', Math.min(6, 4 + ai.length - 1), ai.map(a => ({ text: a.label, quote: a.example })), 'Only definite traces are flagged; no AI-probability score is used.');
  const tmpl = templateWording(body);
  if (tmpl.length >= 3) sig('text', 'template', `Wording typical of paper-mill templates (${tmpl.length} features)`, tmpl.length >= 5 ? 'medium' : 'low', tmpl.length >= 5 ? 2 : 1, tmpl.map(t => ({ text: t.label, quote: t.example })), 'These methods are legitimate on their own; several together are typical of templated mill papers.');
  const methods = methodsGaps(body);
  if (methods.gaps.length) sig('text', 'methods', `Methods too vague to repeat (${methods.gaps.length})`, methods.gaps.some(g => g.code === 'ethics') ? 'medium' : 'low', methods.gaps.some(g => g.code === 'ethics') ? 1 : 0, methods.gaps.map(g => ({ text: g.message, ...(g.quote ? { quote: g.quote } : {}) })));

  const hid = hiddenText(text);
  if (hid.zero >= 5 || hid.mixed.length) {
    const strongHid = hid.mixed.length >= 2 || hid.zero >= 20;
    sig('text', 'hidden-text', `Hidden characters or mixed-alphabet words (${hid.zero} invisible characters, ${hid.mixed.length} mixed-alphabet words)`, strongHid ? 'high' : 'medium', strongHid ? 4 : 2,
      [...(hid.zero ? [{ text: `${hid.zero} zero-width / soft-hyphen characters` }] : []), ...hid.mixed.map(w => ({ text: `Word mixing Latin and Cyrillic/Greek letters: “${w}”` }))], 'Used to defeat plagiarism-detection software; normal text contains neither.');
  }

  const cells = cellLines(body);
  if (cells.length) sig('data', 'cell-lines', `${cells.length} misidentified or contaminated cell line(s) named`, 'medium', Math.min(4, 2 * cells.length), cells.map(c => ({ text: c.nonVerifiable ? `${c.name}: ${c.actual}` : `${c.name} is actually ${c.actual} (ICLAC register)`, quote: c.example })), 'Results attributed to the named tissue may be invalid; ask for authentication (STR profile).');
  // ---- phase 3: statistics that do not add up, primer sanity
  const stats = DC.statisticsCheck(text);
  const gross = stats.findings.filter(f => f.gross);
  const impossible = stats.findings.filter(f => f.kind === 'impossible');
  if (gross.length >= 2 || impossible.length) sig('data', 'statistics', `Reported statistics do not add up (${stats.findings.length}; ${gross.length} change the conclusion)`, gross.length >= 3 || impossible.length ? 'medium' : 'low', gross.length >= 3 || impossible.length ? 3 : 1.5,
    stats.findings.slice(0, 8).map(f => ({ text: `${f.reported} - recalculated: ${f.recalculated}${f.gross ? ' (changes the conclusion)' : ''}`, quote: f.quote })), 'p-values are recalculated from the reported t, F, chi-square, r or z statistic, and percentages from their counts. Honest rounding or typing errors exist in many papers; look at the pattern, not one value.');
  else if (gross.length === 1) sig('data', 'statistics', 'One reported statistic does not add up', 'low', 1, [{ text: `${gross[0].reported} - recalculated: ${gross[0].recalculated}`, quote: gross[0].quote }], 'A single inconsistent value is often a typing error; check the original data.');
  else if (stats.findings.length >= 4) sig('data', 'statistics-minor', `Several small rounding inconsistencies in reported statistics (${stats.findings.length})`, 'low', 0.5, stats.findings.slice(0, 6).map(f => ({ text: `${f.reported} - recalculated: ${f.recalculated}`, quote: f.quote })));
  const primers = DC.findPrimers(text);
  const primerIssues = DC.primerSanity(primers);
  if (primerIssues.length) sig('data', 'primers', `Primer / sequence problems (${primerIssues.length})`, primerIssues.some(i => /identical|different genes|reverse complement/.test(i.message)) ? 'medium' : 'low', primerIssues.some(i => /identical|different genes|reverse complement/.test(i.message)) ? 2 : 1,
    primerIssues.slice(0, 8).map(i => ({ text: `${i.primer.gene || 'primer'} ${i.primer.direction} 5'-${i.primer.sequence}-3': ${i.message}`, quote: i.primer.quote })), 'Primer sequences were read from the text and checked for sense (length, GC content, forward = reverse, one primer for two genes).');
  signals.details = { tortured, ai, tmpl, methods, hid, cells, stats, primers, primerIssues };
  return signals;
}

/**
 * input: { text (whole manuscript), body, meta, references: reference-check results, pattern?, suggestedReviewers?,
 *          images?: Module 5 summary { findings, level } }
 */
/** fn over items, n at a time, results in order (the list lookups are database queries: one after another took ~20 s) */
async function inParallel(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

/** Load the lists and indexes Module 4 reads (once per server): a Full Screening starts this with Module 1, so they are ready */
function warm() {
  const MI = require('./millIndex');
  return Promise.all([D.warmEmailDomains(), D.ppsFingerprints(), customPhrases(), MI.titleIndex(), MI.abstractIndex()].map(p => Promise.resolve(p).catch(() => null)));
}

async function detectPaperMill(input, update = () => {}) {
  const text = input.text || input.body || '';
  const body = input.body || text;
  const meta = input.meta || {};
  const refs = input.references || [];
  const signals = [];
  const sig = (group, code, title, severity, weight, evidence = [], note = '') => signals.push({ group, code, title, severity, weight, evidence, note });

  // the mill-title index takes a few seconds to build: started now, read when the signal is added
  const lookOn = meta.title && input.millLookalike !== false;
  const lookalikes = lookOn ? MI.titleLookalikes(meta.title, { doi: meta.doi }).catch(() => []) : Promise.resolve([]);
  const absLookalikes = lookOn ? MI.abstractLookalikes(meta.title, MI.abstractOf(meta, text), { doi: meta.doi }).catch(() => null) : Promise.resolve(null);
  await D.warmEmailDomains();
  update('Searching for tortured phrases and AI-text leftovers', 2);
  const textSigs = await textSignals(text, body, await customPhrases(), { title: meta.title });
  signals.push(...textSigs);
  const { tortured, ai, tmpl, methods, hid, cells, stats, primers, primerIssues } = textSigs.details;

  // AI-written text (as the STM Integrity Hub's AI-text signal): LLM-favoured vocabulary, uniform sentence length and
  // stock transitions (src/integrity/aiWriting.js). Chatbot leftovers are already the ai-leftover signal above. Not on
  // the paper-mill benchmark (those papers predate LLMs), so it counts little: an indicator to ask about AI use.
  let aiWriting = null;
  try { aiWriting = require('../integrity/aiWriting').analyzeAiWriting(body); } catch (e) { aiWriting = null; }
  for (const x of (aiWriting?.signals || []).filter(x => x.code !== 'leftover')) signals.push({ ...x, group: 'text', code: 'ai-writing', weight: Math.min(1, x.weight) });

  // Seek & Blastn: does each primer match the gene it is claimed to amplify? (NCBI BLAST, online only)
  let blast = [];
  if (primers.length && input.blast !== false && isOnline()) {
    update('Checking primers against NCBI (Seek & Blastn)', 8);
    blast = await DC.seekAndBlast(primers, { limit: 4, update: s => update(s, 9) }).catch(() => []);
    const wrong = blast.filter(b => b.checked && !b.matches);
    if (wrong.length) signals.push({ group: 'data', code: 'primer-gene', title: `${wrong.length} primer(s) do not match the gene they are said to amplify`, severity: wrong.length >= 2 ? 'high' : 'medium', weight: wrong.length >= 2 ? 4 : 3,
      evidence: wrong.map(b => ({ text: `${b.primer.gene} ${b.primer.direction} 5'-${b.primer.sequence}-3' - top NCBI hits: ${b.hits.slice(0, 3).join(' | ') || 'none'}`, quote: b.primer.quote })), note: 'The primer was searched in NCBI BLAST (RefSeq RNA). A primer that hits other genes, or nothing, points to a wrong or invented sequence (Seek & Blastn method). Check the full BLAST result before drawing a conclusion.' });
  }

  // Cellosaurus (SIB / ExPASy): every named cell line that the built-in ICLAC list did not already report is looked up
  // for a "Problematic cell line" note (contaminated, misidentified) and, when called a cell line, for its existence
  // (offline - desktop - the bulk copy of Cellosaurus's problematic lines still answers; "not found" needs the live API)
  if (input.cellosaurus !== false) {
    const names = cellLineCandidates(body, new Set(cells.map(c => c.name.toLowerCase()))).slice(0, 12);
    if (names.length) {
      update('Checking named cell lines in Cellosaurus', 10);
      const found = await Promise.all(names.map(async c => ({ ...c, rec: await D.cellosaurusLookup(c.name).catch(() => null) })));
      const flagged = found.filter(c => c.rec?.found && c.rec.problematic);
      // "Misclassified" (e.g. HepG2: hepatoblastoma, long described as hepatocellular carcinoma) is a labelling note;
      // contamination and misidentification mean the cells are not what the paper says
      const problematic = flagged.filter(c => !/^Misclassified/i.test(c.rec.problematic));
      const misclassified = flagged.filter(c => /^Misclassified/i.test(c.rec.problematic));
      const ev = c => ({ text: `${c.rec.name} (${c.rec.accession}): ${c.rec.problematic}`, quote: c.example, link: c.rec.accession ? `https://www.cellosaurus.org/${c.rec.accession}` : null });
      const unknown = isOnline() ? found.filter(c => c.rec && !c.rec.found && c.calledLine) : [];
      if (problematic.length) sig('data', 'cellosaurus-problematic', `${problematic.length} contaminated or misidentified cell line(s) in Cellosaurus`, 'medium', Math.min(4, 2 * problematic.length),
        problematic.map(ev), 'Cellosaurus records contamination and misidentification reported in the literature. Ask the authors for an STR authentication profile.');
      if (misclassified.length) sig('data', 'cellosaurus-misclassified', `${misclassified.length} cell line(s) with a Cellosaurus misclassification note`, 'low', 0.5,
        misclassified.map(ev), 'Check that the paper describes the cell line\'s tissue of origin correctly; not a sign of misconduct by itself.');
      if (unknown.length) sig('data', 'cellosaurus-unknown', `${unknown.length} named cell line(s) not found in Cellosaurus`, 'low', 1,
        unknown.map(c => ({ text: `${c.name} - no Cellosaurus entry under this name or its synonyms`, quote: c.example })), 'Often a spelling variant; an invented cell line name is a known paper-mill sign. Ask for the supplier and catalogue number.');
    }
  }

  // miRBase: microRNAs that do not exist, or not in the species studied (a human microRNA measured in rats). On the
  // benchmark neither occurred in the 126 ordinary papers (nor in the 150 mill papers, few of which are microRNA
  // studies), so wrong-species counts a little and an unknown name is shown without weight (often a retired or mistyped name)
  const mirs = DC.mirnaMentions(body);
  if (mirs.length) {
    const known = await D.mirbaseSpecies(mirs.map(m => m.key)).catch(() => null);
    if (known) {
      const mr = DC.mirnaCheck(mirs, known, body);
      const SP = { rno: 'rat', mmu: 'mouse', hsa: 'human' };
      if (mr.wrongSpecies.length) sig('data', 'mirna-species', `${mr.wrongSpecies.length} microRNA(s) not known in the species studied (${SP[mr.wrongSpecies[0].target] || mr.wrongSpecies[0].target})`, 'low', mr.wrongSpecies.length >= 2 ? 2 : 1,
        mr.wrongSpecies.map(m => ({ text: `${m.name}: no ${SP[m.target] || m.target} microRNA of this name in miRBase (annotated in ${m.annotatedIn.join(', ')})`, quote: m.quote, link: `https://www.mirbase.org/results/?query=${encodeURIComponent(m.key)}` })),
        'Sleuths found human microRNAs "measured" in rat or mouse models in paper-mill papers. Ask which probe or primer was used and its target species.');
      if (mr.unknown.length) sig('data', 'mirna-unknown', `${mr.unknown.length} microRNA name(s) not in miRBase`, 'low', 0,
        mr.unknown.map(m => ({ text: `${m.name}: no microRNA of this name in the current miRBase release`, quote: m.quote })), 'Usually a typing error or a name miRBase has retired; an invented microRNA is a paper-mill sign. Check the name.');
    }
  }

  // Institutions far apart
  const spread = DC.affiliationSpread(meta.affiliations || [], (meta.authors || []).length);
  if (spread.far) signals.push({ group: 'authors', code: 'institutions-far', title: `Authors' institutions are in ${spread.countries.length} countries (${spread.countries.join(', ')})`, severity: 'low', weight: spread.countries.length >= 3 && (meta.authors || []).length <= 4 ? 2 : 1,
      evidence: Object.entries(spread.byCountry).map(([c, a]) => ({ text: `${c}: ${a[0]}` })), note: 'Many countries on a short author list with no stated collaboration is a paper-mill pattern (authorship for sale). International teams are common; ask the corresponding author how the group worked together if it is not clear.' });

  // Resemblance to papers already retracted for paper-mill reasons (title against ~15,000 Retraction Watch records)
  // Resemblance to papers already retracted for paper-mill reasons: title + abstract (OpenAlex abstracts of ~13,400 Retraction
  // Watch mill retractions) where available, else the title alone. Weights from the benchmark (150 mill / 126 ordinary papers,
  // checked on two halves): title + abstract >= 0.14 42 vs 7, >= 0.17 16 vs 3, >= 0.20 8 vs 0; title alone >= 0.5 15 vs 4.
  const look = await lookalikes;
  const absLook = await absLookalikes;
  {
    const top = absLook?.[0]?.score || 0;
    const [aSev, aW] = top >= 0.2 ? ['medium', 4] : top >= 0.17 ? ['medium', 3] : top >= 0.14 ? ['low', 2] : [null, 0];
    const tStrong = look.length && (look[0].score >= 0.6 || look.length >= 3);
    const [tSev, tW] = look.length ? (tStrong ? ['medium', 2] : ['low', 1]) : [null, 0];
    if (aW || tW) {
      const byAbstract = aW >= tW;
      const seen = new Set();
      const items = [...(absLook || []).map(l => ({ ...l, via: 'title and abstract' })), ...look.map(l => ({ ...l, via: 'title' }))].filter(l => { const k = l.doi || l.title; if (seen.has(k)) return false; seen.add(k); return true; });
      sig('text', 'mill-lookalike', byAbstract ? `Title and abstract resemble ${absLook.length} paper(s) retracted for paper-mill reasons (closest ${Math.round(top * 100)}%)` : `Title closely resembles ${look.length} paper(s) retracted for paper-mill reasons`,
        byAbstract ? aSev : tSev, Math.max(aW, tW),
        items.slice(0, 8).map(l => ({ text: `${Math.round(l.score * 100)}% similar (${l.via}): "${l.title}"${l.journal ? ` - ${l.journal}` : ''}${l.date ? `, retracted ${String(l.date).slice(0, 10)}` : ''}`, note: l.reason || null, link: l.doi ? `https://doi.org/${l.doi}` : null })),
        byAbstract
          ? 'Paper mills sell many papers made from one template, so their titles and abstracts read alike (the approach of Clear Skies’ Papermill Alarm in the STM Integrity Hub). Benchmark: a closest match of 20% or more was found for 8 of 150 mill papers and none of 126 ordinary papers; 14% or more for 42 of 150 mill and 7 of 126 ordinary papers. Read the closest retracted papers next to the manuscript: same design, assays and wording with other genes, drugs or diseases is the mill pattern.'
          : 'Paper mills sell many papers made from one template, so their titles look alike (the approach of Clear Skies’ Papermill Alarm in the STM Integrity Hub). On the benchmark 10% of mill papers and 3% of ordinary papers had a title this close to a mill retraction: an indicator to read with the other signals, not proof.');
    }
  }

  update('Checking whether the paper is already published', 15);
  const pub = await publishedElsewhere(meta.title).catch(() => []);
  if (pub.length) sig('data', 'published', `A paper with the same title is already published (${pub.length})`, 'medium', 3,
    pub.map(p => ({ text: `“${p.title}” — ${p.journal || 'journal unknown'}${p.year ? ', ' + p.year : ''} (found in ${p.sources.join(', ')})`, link: p.doi ? `https://doi.org/${p.doi}` : p.url })), "Possible duplicate publication or resubmission; it may also be the authors' own preprint or thesis - check before concluding.");

  update('Checking reference signals', 25);
  const fake = refs.filter(r => r.status === 'suspicious');
  if (fake.length) sig('references', 'fabricated', `${fake.length} reference(s) not found in any database (possibly fabricated)`, fake.length >= 3 ? 'high' : 'medium', fake.length >= 3 ? 4 : 2, fake.slice(0, 10).map(r => ({ text: `[${r.index}] ${r.raw.slice(0, 160)}`, note: r.reason })));
  const millRetracted = refs.filter(r => r.retraction && D.MILL_REASON_RE.test(r.retraction.reason || ''));
  // one such citation alone: 8 of 150 mill papers but also 2 of 126 ordinary ones (combined benchmark, 6 Nov), so it no
  // longer flags a manuscript by itself (no mill paper was missed by the change); two or more are a strong signal
  if (millRetracted.length) sig('references', 'mill-retraction', `${millRetracted.length} cited paper(s) retracted for paper-mill reasons`, millRetracted.length >= 2 ? 'high' : 'medium', millRetracted.length >= 2 ? Math.min(8, 4 * millRetracted.length) : 2, millRetracted.map(r => ({ text: `[${r.index}] ${r.record?.title || r.raw.slice(0, 140)}`, note: r.retraction.reason?.split(';').slice(0, 3).join('; ') })));
  const otherRetracted = refs.filter(r => r.status === 'retracted' && !millRetracted.includes(r));
  // flagged by a published integrity audit but not retracted (Module 1 attaches the record); not benchmarked: weak weight
  const flaggedRefs = refs.filter(r => r.flagged && r.status !== 'retracted');
  if (flaggedRefs.length) sig('references', 'flagged-refs', `${flaggedRefs.length} cited paper(s) flagged for integrity problems in a published audit`, flaggedRefs.length >= 3 ? 'medium' : 'low', flaggedRefs.length >= 3 ? 2 : 1,
    flaggedRefs.map(r => ({ text: `[${r.index}] ${r.record?.title || r.raw.slice(0, 140)}`, note: `${r.flagged.issue} (${r.flagged.source})`, link: r.flagged.url })), 'Not retracted, but sleuths documented major problems (image overlap, wrong primers, missing ethics approval). Mill papers often cite each other; check why these were chosen.');
  if (otherRetracted.length) sig('references', 'retracted', `${otherRetracted.length} retracted paper(s) cited`, 'low', 1, otherRetracted.map(r => ({ text: `[${r.index}] ${r.record?.title || r.raw.slice(0, 140)}` })));

  const journals = new Map();
  for (const r of refs) {
    const j = r.record?.journal || r.parsed?.journal;
    if (!j) continue;
    const k = normalizeJournal(j);
    if (!journals.has(k)) journals.set(k, { name: j, issns: new Set(), refs: [] });
    journals.get(k).refs.push(r.index);
    for (const i of r.record?.issn || []) journals.get(k).issns.add(i);
  }
  const refList = idx => idx.map(i => `[${i}]`).join(' ');
  const yearOf = new Map(refs.map(r => [r.index, parseInt(r.record?.year || r.parsed?.year, 10) || null]));
  const risky = [], clones = [], citejacked = [], dropped = [];
  // every journal's list lookups at once (predatory / hijacked lists, Scopus discontinued, paper-mill retractions), and
  // each reference link against the clone sites; the results are read in the order of the list
  const cited = [...journals.values()].slice(0, 80);
  const lookups = await inParallel(cited, 6, j => Promise.all([
    D.predatoryMatches({ journal: j.name, issns: [...j.issns] }).catch(() => []),
    D.listLookupAll([...j.issns], j.name).catch(() => ({})),
    D.millJournalFor(j.name).catch(() => null)
  ]));
  const linked = refs.filter(r => r.parsed?.url || r.record?.url);
  const homepages = await inParallel(linked, 6, r => D.predatoryMatches({ homepage: r.parsed?.url || r.record?.url }).catch(() => []));
  for (const [n, j] of cited.entries()) {
    // Stop Predatory Journals entries are left out here: on the benchmark (150 mill vs 126 ordinary papers) references to
    // them were as common in ordinary papers (7/126) as in mill papers (5/150); Journal Check still shows them
    const m = lookups[n][0].filter(x => x.source !== 'stoppredatoryjournals.com');
    // a hijacked-list name match only says that a clone of the journal exists (most such journals are genuine and indexed)
    if (m.some(x => x.kind !== 'hijacked')) risky.push({ ...j, kind: 'predatory' });
    else if (m.some(D.isCitejacked)) citejacked.push({ ...j, papers: m.find(D.isCitejacked).papers });
    else if (m.length) clones.push({ ...j, clone: m[0].domain, genuine: m[0].genuine_url });
    // Scopus discontinued the journal (Elsevier's Discontinued Titles sheet): references from its last covered year on
    const hit = lookups[n][1].scopus_discontinued;
    if (hit && !/policy/i.test(hit.data?.['Indexation Change'] || '')) {
      const year = parseInt(hit.data?.Year, 10) || null;
      const after = year ? j.refs.filter(i => (yearOf.get(i) || 0) >= year) : j.refs;
      if (after.length) dropped.push({ ...j, refs: after, year });
    }
  }
  // the reference's own link on a clone website
  for (const [n, r] of linked.entries()) {
    if (risky.some(j => j.refs.includes(r.index))) continue;
    const h = homepages[n].find(x => x.kind === 'hijacked');
    if (h) risky.push({ name: `${h.name} (clone site ${h.domain})`, refs: [r.index], kind: 'hijacked' });
  }
  const riskyRefs = risky.reduce((a, j) => a + j.refs.length, 0);
  if (riskyRefs) sig('references', 'predatory', `${riskyRefs} reference(s) to predatory or hijacked journals`, riskyRefs >= 3 ? 'medium' : 'low', riskyRefs >= 3 ? 3 : 1, risky.map(j => ({ text: `${j.name} (${j.kind}) — refs ${refList(j.refs)}` })));
  const droppedRefs = dropped.reduce((a, j) => a + j.refs.length, 0);
  if (droppedRefs) sig('references', 'scopus-discontinued', `${droppedRefs} reference(s) to journals discontinued by Scopus, published after Scopus stopped covering them`, 'low', droppedRefs >= 3 ? 1 : 0,
    dropped.map(j => ({ text: `${j.name} — Scopus coverage ends ${j.year || '(year not given)'} — refs ${refList(j.refs)}` })), 'Scopus drops journals after re-evaluation for publication concerns. On the benchmark (150 paper-mill retractions vs 126 ordinary papers) one or two such references were equally common in both groups, so they do not add to the risk score; three or more count a little.');
  // the screener's citejacked detector flags papers that cite these journals (the citations usually point to the hijacked version)
  const cjRefs = citejacked.reduce((a, j) => a + j.refs.length, 0);
  if (cjRefs) sig('references', 'citejacked', `${cjRefs} reference(s) to journals on the Problematic Paper Screener "citejacked" list`, cjRefs >= 2 ? 'medium' : 'low', cjRefs >= 2 ? 2 : 1,
    citejacked.map(j => ({ text: `${j.name}${j.papers ? ` (${j.papers.toLocaleString('en')} papers found citing its hijacked version)` : ''} — refs ${refList(j.refs)}` })), 'The hijacked versions of these journals publish mill-type papers that are then cited. Check whether each cited article is from the genuine journal (its DOI resolves to the genuine site).');
  // the HEC / institutional blacklist kept by PJPS on Admin > Data (no benchmark: it adds little to the score, the editor judges)
  const blacklisted = cited.map((j, n) => ({ ...j, hit: lookups[n][1].hec_blacklist })).filter(j => j.hit && !risky.some(x => x.name === j.name));
  const blRefs = blacklisted.reduce((a, j) => a + j.refs.length, 0);
  if (blRefs) sig('references', 'blacklisted', `${blRefs} reference(s) to journals on the HEC / institutional blacklist`, blRefs >= 3 ? 'medium' : 'low', blRefs >= 3 ? 2 : 1,
    blacklisted.map(j => ({ text: `${j.name}${j.hit.data?.Reason ? ` (${j.hit.data.Reason})` : ''} — refs ${refList(j.refs)}` })), 'These journals are on the blacklist kept on Admin > Data. Check whether the cited findings are confirmed by work in reputable journals.');
  const cloneRefs = clones.reduce((a, j) => a + j.refs.length, 0);
  if (cloneRefs) sig('references', 'hijacked-clone', `${cloneRefs} reference(s) to journals with a known hijacked clone website`, 'low', 0,
    clones.map(j => ({ text: `${j.name} — clone ${j.clone}${j.genuine ? `, genuine site ${j.genuine}` : ''} — refs ${refList(j.refs)}` })), 'Check that the cited articles come from the genuine journal (its DOI resolves to the genuine site) and not from the clone.');
  for (const f of (input.pattern?.flags || []).filter(f => ['citation-stacking', 'author-concentration', 'journal-concentration', 'irrelevant-self-citation', 'citation-blocks'].includes(f.code))) {
    sig('references', 'stacking', f.message, f.severity === 'high' ? 'medium' : 'low', f.severity === 'high' ? 2 : 1, [], f.guidance);
  }
  // Journals with many paper-mill retractions (Retraction Watch). Benchmark (150 mill-retracted vs 126 ordinary papers):
  // >= 3 references and >= 15% of the list: 16/150 vs 3/126; >= 5 and >= 20%: 9/150 vs 1/126 (scripts/benchmark-papermill-refs.js).
  const millByJournal = new Map();   // full and abbreviated forms of one journal are grouped under its Retraction Watch name
  for (const [n, j] of cited.entries()) {
    const m = lookups[n][2];
    if (!m) continue;
    if (!millByJournal.has(m.norm)) millByJournal.set(m.norm, { name: m.name, refs: [], mill: m.mill, total: m.total });
    millByJournal.get(m.norm).refs.push(...j.refs);
  }
  const millJ = [...millByJournal.values()];
  const millJRefs = millJ.reduce((a, j) => a + j.refs.length, 0);
  const millJShare = refs.length ? millJRefs / refs.length : 0;
  if (millJRefs >= 3 && millJShare >= 0.15) {
    const strongJ = millJRefs >= 5 && millJShare >= 0.2;
    sig('references', 'mill-journals', `${millJRefs} reference(s) (${Math.round(millJShare * 100)}%) to journals with many paper-mill retractions`, strongJ ? 'medium' : 'low', strongJ ? 2 : 1,
      millJ.sort((a, b) => b.refs.length - a.refs.length).map(j => ({ text: `${j.name} - ${j.mill} paper-mill retractions in Retraction Watch - refs ${j.refs.map(i => `[${i}]`).join(' ')}` })),
      'These journals published large numbers of paper-mill articles that were later retracted (Retraction Watch). Citing them is not wrong in itself; a reference list built largely on them is a pattern seen in mill papers. Check that the cited papers are sound and relevant.');
  }

  update('Checking authors (retractions, ORCID, e-mail addresses)', 40);
  const authors = (meta.authors || []).filter(a => a.family);
  const orcids = [...new Set([...text.slice(0, 15000).matchAll(ORCID_RE)].map(m => m[1]))];
  const orcidResults = [];
  if (!orcids.length) sig('authors', 'no-orcid', 'No ORCID iD given for any author', 'low', 1);
  for (const id of orcids.slice(0, 10)) {
    if (!orcidValid(id)) { orcidResults.push({ id, valid: false }); continue; }
    const p = await orcidProfile(id).catch(e => ({ id, error: e.message }));
    orcidResults.push({ ...p, valid: true });
  }
  const badOrcid = orcidResults.filter(o => o.valid === false || o.exists === false);
  const emptyOrcid = orcidResults.filter(o => o.exists && o.works === 0);
  if (badOrcid.length) sig('authors', 'orcid-invalid', `${badOrcid.length} ORCID iD(s) invalid or not registered`, 'medium', 2, badOrcid.map(o => ({ text: o.id })));
  if (emptyOrcid.length) sig('authors', 'orcid-empty', `${emptyOrcid.length} ORCID record(s) with no publications`, 'low', 1, emptyOrcid.map(o => ({ text: `${o.id}${o.name ? ' — ' + o.name : ''}`, link: `https://orcid.org/${o.id}` })));
  // Retracted papers on the authors' own ORCID records: exact DOI match with Retraction Watch (identity confirmed by ORCID)
  const orcidRetr = [];
  const ownDois = orcidResults.flatMap(o => (o.dois || []).map(doi => ({ doi, o })));
  if (ownDois.length) {
    const rw = await D.retractionsFor(ownDois.map(x => x.doi)).catch(() => new Map());
    for (const { doi, o } of ownDois) {
      const r = rw.get(doi);
      if (r && /retraction/i.test(r.nature || '') && !orcidRetr.some(x => x.doi === doi)) orcidRetr.push({ orcid: o.id, name: o.name, doi, title: r.title, journal: r.journal, date: r.retraction_date, reason: r.reason, mill: D.MILL_REASON_RE.test(r.reason || '') });
    }
  }
  const orcidEv = r => ({ text: `${r.name || r.orcid} (ORCID ${r.orcid}): “${r.title}” (${r.journal}, retracted ${r.date})`, note: r.reason?.split(';').slice(0, 3).join('; '), link: `https://doi.org/${r.doi}` });
  const orcidMill = orcidRetr.filter(r => r.mill);
  if (orcidMill.length) sig('authors', 'orcid-mill-retraction', `ORCID record(s) list paper(s) retracted for paper-mill or fake-peer-review reasons (${orcidMill.length})`, 'high', 5, orcidMill.map(orcidEv), "The DOI on the author's own ORCID record matches a Retraction Watch entry exactly. Confirm that the ORCID iD belongs to the author named in the manuscript.");
  const orcidOther = orcidRetr.filter(r => !r.mill);
  if (orcidOther.length) sig('authors', 'orcid-retraction', `ORCID record(s) list retracted paper(s) (${orcidOther.length})`, 'medium', 2, orcidOther.map(orcidEv), "Exact DOI match between the author's ORCID record and Retraction Watch. Retractions for honest error happen; read the reason.");
  // Name matching in Retraction Watch; a paper already found through an ORCID record is not counted twice
  const orcidRetrDois = new Set(orcidRetr.map(r => r.doi));
  const retr = (await authorRetractions(authors, meta.affiliations)).filter(r => !orcidRetrDois.has(String(r.doi || '').toLowerCase()));
  // identity by ORCID where both sides have one: the author's iD (given with the author, or an iD in the text whose
  // registered name is this author's) against the iD Crossref lists for the retracted paper's author of that name
  const orcidOf = a => a.orcid || orcidResults.find(o => o.exists && o.name && nameMatch(splitName(o.name), a) === 'exact')?.id || null;
  let orcidLookups = 0;
  for (const r of retr) {
    if (r.confidence === 'low' || !r.doi || orcidLookups >= 20) continue;
    const a = authors.find(x => `${x.given || ''} ${x.family}`.trim() === r.author);
    const mine = a && orcidOf(a);
    if (!mine) continue;
    orcidLookups++;
    const theirs = await crossrefAuthorOrcid(r.doi, a).catch(() => null);
    if (!theirs) continue;
    if (orcidDigits(theirs) === orcidDigits(mine)) { r.confidence = 'high'; r.orcidConfirmed = theirs; }
    else { r.confidence = 'low'; r.orcidDifferent = theirs; }
  }
  const sure = r => r.confidence !== 'low';
  // the high signal needs the institution to match as well: a name alone, even a full first name, is shared by many people
  // (benchmark of 6 Nov 2026: name-only hits fired on 4 in 10 ordinary papers with Chinese or Arabic author names)
  const millRetr = retr.filter(r => r.mill && r.confidence === 'high');
  const otherSure = retr.filter(r => sure(r) && !millRetr.includes(r));
  const confNote = r => r.orcidConfirmed ? `same person - the retracted paper lists the same ORCID iD (${r.orcidConfirmed})` : r.orcidDifferent ? `probably another person - the retracted paper's author of this name has another ORCID iD (${r.orcidDifferent})` : `${r.confidence} confidence${r.institutionMatch?.length ? ` (institution matches: ${r.institutionMatch.join(', ')})` : r.confidence === 'low' ? (r.commonName ? ' - common name (retractions at many different institutions), no institution in common: probably a different person' : ' - surname and initial only, may be a different person') : ''}`;
  if (millRetr.length) sig('authors', 'author-mill-retraction', `Author(s) with earlier retractions for paper-mill or fake-peer-review reasons (${millRetr.length})`, 'high', 5, millRetr.map(r => ({ text: `${r.author}: “${r.title}” (${r.journal}, retracted ${r.date}) - ${confNote(r)}`, note: r.reason?.split(';').slice(0, 3).join('; '), link: r.doi ? `https://doi.org/${r.doi}` : null })), 'Matched by name in Retraction Watch — confirm it is the same person (affiliation, ORCID).');
  if (otherSure.length) sig('authors', 'author-retraction', `Author(s) with earlier retractions (${otherSure.length})`, 'medium', 2, otherSure.map(r => ({ text: `${r.author}: “${r.title}” (${r.journal}, retracted ${r.date}) - ${confNote(r)}`, note: r.reason?.split(';').slice(0, 2).join('; '), link: r.doi ? `https://doi.org/${r.doi}` : null })), 'Matched by name in Retraction Watch — confirm it is the same person.');
  const unsure = retr.filter(r => !sure(r));
  if (unsure.length) sig('authors', 'author-retraction-name', `Possible earlier retraction(s) under a similar name (${unsure.length}) - probably other people`, 'low', 0.5, unsure.slice(0, 6).map(r => ({ text: `${r.author}: “${r.title}” (${r.journal}, retracted ${r.date}) - ${confNote(r)}`, link: r.doi ? `https://doi.org/${r.doi}` : null })), 'Retraction Watch gives author names only. These hits match the surname and first initial only, or a very common name with no institution in common; they are usually different people. Check ORCID and affiliation before drawing any conclusion.');

  const emails = emailsOf(text);
  // Cover letter (optional): written for another journal, template placeholders, another title, a third-party mailbox
  const SUB = require('./submission');
  const letter = String(input.coverLetter || '');
  for (const x of SUB.coverLetterSignals(letter, { title: meta.title || '', emails })) sig('authors', x.code, x.title, x.severity, x.weight, x.evidence, x.note);
  // Journal scope: shown for the editor, not counted (on the benchmark ordinary papers fell outside pharmacy as often as mill papers)
  const scope = SUB.scopeFit({ title: meta.title || '', abstract: meta.abstract || text.slice(0, 3000), keywords: meta.keywords || [] });
  if (!scope.inScope && scope.words >= 8 && !signals.some(x => x.code === 'off-scope')) sig('text', 'out-of-scope', 'Nothing in the title and abstract matches the pharmaceutical / biomedical scope of PJPS', 'low', 0,
    [{ text: `Title: “${String(meta.title || '').slice(0, 200)}”` }], 'An editorial scope question first: a paper outside the journal\'s field is often sent to many journals at once. Not counted in the risk score - ordinary papers were as often out of scope as mill papers on the benchmark.');
  const disposable = emails.filter(e => DISPOSABLE_MAIL.test(e));
  if (disposable.length) sig('authors', 'disposable-mail', `Disposable (throw-away) e-mail address(es) given for authors (${disposable.length})`, 'medium', 2, disposable.map(e => ({ text: e })), 'Throw-away mailboxes expire after minutes or days, so the author cannot be reached later. Domain listed in the disposable-email-domains register.');
  const free = emails.filter(e => FREE_MAIL.test(e));
  if (emails.length && free.length === emails.length) sig('authors', 'free-mail', `All author e-mail addresses are free-mail accounts (${free.length})`, 'low', 1, free.map(e => ({ text: e })), 'Common and often legitimate in Pakistan; counts only together with other signals.');

  // the editorial office's watchlist of e-mails, domains, names, ORCID iDs, institutions, phones and phrases from
  // earlier paper-mill submissions (as the STM Integrity Hub's shared watchlists)
  const watchEntries = await WL.load();
  const watch = WL.match(watchEntries, { text, emails, orcids, authors, affiliations: meta.affiliations || [] });
  if (watch.length) {
    const top = watch.some(w => w.entry.severity === 'high') ? 'high' : watch.some(w => w.entry.severity === 'medium') ? 'medium' : 'low';
    sig(watch.every(w => w.entry.type === 'phrase') ? 'text' : 'authors', 'watchlist', `${watch.length} entr${watch.length > 1 ? 'ies' : 'y'} of the editorial watchlist found in the manuscript`, top,
      Math.min(6, watch.reduce((a, w) => a + ({ high: 5, medium: 3, low: 1 }[w.entry.severity] || 1), 0)),
      watch.map(w => ({ text: `${WL.TYPES[w.entry.type]} “${w.entry.value}” — in the ${w.where}`, note: [w.entry.note, w.entry.by ? `listed by ${w.entry.by}, ${String(w.entry.at).slice(0, 10)}` : ''].filter(Boolean).join(' · ') })),
      'The editors put these on the watchlist after earlier paper-mill or fraudulent submissions. Check that it is the same person, address or institution before acting.');
  }

  const offTopicAff = (meta.affiliations || []).filter(a => NON_BIOMED.test(a));
  if (offTopicAff.length && (meta.affiliations || []).length) sig('authors', 'affiliation', 'Affiliation(s) unrelated to a pharmaceutical/biomedical topic', 'low', 1, offTopicAff.map(a => ({ text: a })), 'Interdisciplinary teams are common; check that each author\'s contribution is plausible.');

  const prev = await previousAuthors(meta.manuscriptCode, meta.version).catch(() => null);
  if (prev && authors.length) {
    const now = authors.map(a => `${a.given} ${a.family}`.trim());
    const same = (x, y) => !!nameMatch(splitName(x), splitName(y));
    const added = now.filter(n => !prev.some(p => same(p, n)));
    const removed = prev.filter(p => !now.some(n => same(p, n)));
    const reordered = !added.length && !removed.length && prev.join('|') !== now.join('|');
    if (added.length || removed.length || reordered) sig('authors', 'authorship-change', 'Authors changed since the earlier version', added.length ? 'medium' : 'low', added.length ? 2 : 1,
      [...added.map(n => ({ text: `Added: ${n}` })), ...removed.map(n => ({ text: `Removed: ${n}` })), ...(reordered ? [{ text: `Order changed: ${prev.join(', ')} → ${now.join(', ')}` }] : [])], 'Authorship sold by paper mills often appears as authors added during revision.');
  }

  const revText = String(input.suggestedReviewers || '');
  if (revText.trim()) {
    const revEmails = [...new Set((revText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map(e => e.toLowerCase()))];
    const authorDomains = new Set(emails.map(e => e.split('@')[1]).filter(d => !FREE_MAIL.test('@' + d)));
    const issues = [];
    for (const e of revEmails) {
      if (DISPOSABLE_MAIL.test(e)) issues.push({ text: `${e} — disposable (throw-away) address for a suggested reviewer` });
      else if (FREE_MAIL.test(e)) issues.push({ text: `${e} — free-mail address for a suggested reviewer` });
      else if (authorDomains.has(e.split('@')[1])) issues.push({ text: `${e} — same institution e-mail domain as an author` });
    }
    for (const a of authors) if (new RegExp(`\\b${esc(a.family)}\\b`, 'i').test(revText) && a.family.length > 3) issues.push({ text: `A suggested reviewer shares the surname “${a.family}” with an author` });
    // links to the authors: papers the suggested reviewer co-authored with an author in the last 10 years (OpenAlex), as
    // the Integrity Suite checks assigned reviewers. One reviewer per line: "Name, institution, e-mail" (ORCID iD optional)
    if (isOnline() && authors.length && input.coauthorCheck !== false) {
      const { coauthorships } = require('../integrity/peerReview');
      const people = revText.split(/\n+/).map(l => {
        const orcid = (l.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/) || [])[0] || null;
        const name = l.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ').replace(/https?:\/\/\S+|\d{4}-\d{4}-\d{4}-\d{3}[\dX]/g, ' ')
          .split(/[,;(<|\t]|\s[-–]\s/)[0].replace(/^\s*(?:\d+[.)]\s*|(?:prof(?:essor)?|dr|mr|mrs|ms)\.?\s+)+/i, '').trim();
        return { name, orcid };
      }).filter(p => p.orcid || (/^\p{Lu}[\p{L}.'-]*(?:\s+[\p{L}.'-]+){1,3}$/u.test(p.name) && !authors.some(a => nameMatch(splitName(p.name), a) === 'exact'))).slice(0, 5);
      for (const p of people) {
        const co = await coauthorships(p, authors).catch(() => null);
        if (co?.items?.length) issues.push({ text: `${co.displayName || p.name}: co-authored ${co.items.length} paper(s) with ${[...new Set(co.items.flatMap(i => i.with))].join(', ')} in the last 10 years`, link: co.items[0].link, severe: co.items.length >= 2 });
      }
    }
    // a suggested reviewer who often publishes with the authors is a conflict of interest in itself (ICMJE / COPE)
    const strongTie = issues.some(i => i.severe);
    if (issues.length) sig('authors', 'reviewers', `Suggested reviewers raise concerns (${issues.length})`, issues.length >= 2 || strongTie ? 'medium' : 'low', issues.length >= 2 || strongTie ? 2 : 1, issues.map(({ severe, ...i }) => i), 'Fake reviewer accounts with free-mail addresses, and reviewers who are the authors\' own co-authors, are known paper-mill techniques. ICMJE / COPE: recent co-authors should not review.');
  }

  update('Checking cell lines and earlier submissions', 70);

  const dup = await duplicateSubmissions({ body, meta, excludeCode: meta.manuscriptCode, excludeCheckIds: input.excludeCheckIds || [] }).catch(e => ({ compared: 0, matches: [], shingles: [], error: e.message }));
  const strong = dup.matches.filter(m => m.textOverlap >= 50 || m.titleSimilarity >= 90);
  if (strong.length) sig('data', 'duplicate', `Matches an earlier PJPS submission (${strong.length})`, 'high', 5, strong.map(m => ({ text: `${m.manuscriptCode || 'check #' + m.checkId}: “${m.title || ''}” — ${m.textOverlap}% text overlap${m.titleSimilarity >= 90 ? `, title ${m.titleSimilarity}% similar` : ''}`, checkId: m.checkId })));
  else if (dup.matches.length) sig('data', 'duplicate-partial', `Partial text overlap with earlier PJPS submission(s) (${dup.matches.length})`, 'medium', 3, dup.matches.map(m => ({ text: `${m.manuscriptCode || 'check #' + m.checkId}: “${m.title || ''}” — ${m.textOverlap}% overlap`, checkId: m.checkId })));
  // Waves of similar manuscripts from unrelated author groups (template reuse, a hallmark of mill output; papermill.txt 6)
  if (!strong.length && (dup.waves || []).length >= 2) sig('data', 'submission-wave', `Part of a wave: ${dup.waves.length} other recent PJPS submission(s) by other authors with the same title template or boilerplate`, dup.waves.length >= 3 ? 'medium' : 'low', dup.waves.length >= 3 ? 2 : 1,
    dup.waves.map(m => ({ text: `${m.manuscriptCode || 'check #' + m.checkId} (${String(m.date).slice(0, 10)}): “${m.title || ''}” — title template ${m.titleTemplate}% alike, ${m.textOverlap}% shared text`, checkId: m.checkId })),
    `Paper mills send batches of manuscripts made from one template, by different author groups, over a few weeks. Several submissions in the last ${WAVE_DAYS} days share this one's title pattern or boilerplate text. Common for one research group's series; compare the methods, figures and data of the manuscripts listed.`);

  const imgSig = imagesSignal(input.images);
  if (imgSig) signals.push(imgSig);

  const risk = riskLevel(signals);
  const groups = ['text', 'references', 'authors', 'data'];
  const out = {
    kind: 'papermill',
    module: 4,
    meta: { ...meta, authors: authors.map(a => ({ name: a.name || `${a.given} ${a.family}`.trim(), given: a.given, family: a.family })) },
    createdAt: new Date().toISOString(),
    datasets: await require('../datasets').datasetHealth(),
    risk,
    signals: signals.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || b.weight - a.weight),
    details: {
      tortured, aiLeftovers: ai, templates: tmpl, methods, cellLines: cells, statistics: { findings: stats.findings.slice(0, 30), checked: stats.checked }, primers: { found: primers.length, issues: primerIssues.length, blast: blast.map(b => ({ gene: b.primer.gene, direction: b.primer.direction, sequence: b.primer.sequence, checked: b.checked, matches: b.matches ?? null, hits: b.hits || [], error: b.error || null })) }, affiliationSpread: spread, emails, freeMail: free, orcids: orcidResults,
      watchlist: { entries: watchEntries.length, matches: watch.length }, aiWriting: aiWriting?.details ? { score: aiWriting.details.score, parts: aiWriting.details.parts } : null,
      authorRetractions: retr, orcidRetractions: orcidRetr, millJournals: millJ.map(j => ({ name: j.name, refs: j.refs, mill: j.mill })), duplicates: { compared: dup.compared, matches: dup.matches }, publishedElsewhere: pub, hiddenText: hid,
      millLookalikes: look, abstractLookalikes: absLook || [], abstractIndex: absLook !== null, scope: { subjects: scope.subjects, inScope: scope.inScope }, waves: dup.waves || [],
      references: { total: refs.length, fabricated: fake.length, retracted: refs.filter(r => r.status === 'retracted').length, millRetracted: millRetracted.length, riskyJournals: risky }
    },
    checked: {
      text: true, statistics: stats.checked.pTests + stats.checked.percentages, primers: primers.length, primersBlasted: blast.filter(b => b.checked).length, references: refs.length > 0, authors: authors.length > 0, orcid: orcids.length > 0, reviewers: !!revText.trim(),
      previousVersion: !!prev, images: !!input.images, earlierSubmissions: dup.compared, watchlist: watchEntries.length, aiWriting: !!aiWriting?.checked,
      millLookalike: !!meta.title && input.millLookalike !== false, coverLetter: letter.trim().length >= 40
    },
    disclaimer: 'Screening aid only. The risk level shows where to look closer; it is not proof of misconduct and never rejects a paper by itself. The editor decides. Confidential — not for authors or reviewers.',
    _shingles: dup.shingles
  };
  out.overview = require('./overview').overview(out);
  // the editor's summary: convergence of evidence, completeness, recommended action, checklist and the query letter
  const A = require('./assessment');
  out.assessment = A.assess(out);
  out.assessment.letter = A.queryLetter(out, out.assessment);
  return out;
}

function papermillProblems(r) {
  return [`Paper mill risk ${r.risk.level} (score ${r.risk.score})`, ...r.signals.filter(s => s.severity !== 'low').slice(0, 5).map(s => s.title)];
}

module.exports = { warm, imagesSignal, riskLevel, textSignals, millLookalikes, millProfile, methodsGaps, screenerMatches, detectPaperMill, publishedElsewhere, storeFingerprint, papermillProblems, torturedPhrases, aiLeftovers, templateWording, cellLines, cellLineCandidates, orcidValid, orcidProfile, authorRetractions, crossrefAuthorOrcid, emailsOf, hiddenText, shingles, fnv };
