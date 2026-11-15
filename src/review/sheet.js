// review/sheet.js - the PJPS Preliminary Review Sheet, filled from the uploaded manuscript: the scope / novelty /
// suitability boxes, the article type with its reporting guideline (followed, checklist, flow diagram) and the checks
// of the Authors' Instructions (structured abstract of at most 300 words, separate headings, trial registration,
// ethical approval, PJPS reference format, figures as separate 600 dpi TIFF files), and the outcome: peer review, or
// resubmission after correction. Every answer carries the evidence it was read from; the editor can change any of
// them. Written back into the journal's own Word form (preliminary-review-sheet.docx). In-house only: no paid service.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const P = require('../parse');
const { SUBJECTS } = require('../subjects');
const { titleSimilarity } = require('../text');

const TEMPLATE = path.join(__dirname, 'preliminary-review-sheet.docx');

// ------------------------------------------------------------------ the form: article types and their guidelines

const TYPES = [
  { key: 'rct', label: 'Randomized Trial (RCT) or Interventional study', guideline: 'CONSORT', clinical: true, human: true },
  { key: 'observational', label: 'Observational Study (Cohort / Case-control / Cross-sectional)', guideline: 'STROBE or RECORD', human: true },
  { key: 'case-report', label: 'Case Report', guideline: 'CARE', human: true },
  { key: 'retrospective', label: 'Retrospective Study', guideline: 'STROBE', human: true },
  { key: 'systematic-review', label: 'Systematic Review', guideline: 'PRISMA' },
  { key: 'scoping-review', label: 'Scoping Review', guideline: 'PRISMA-ScR' },
  { key: 'animal', label: 'Animal study', guideline: 'ARRIVE', animal: true },
  { key: 'nonrandomized', label: 'Nonrandomized / quasi-experimental intervention studies', guideline: 'TREND', clinical: true, human: true },
  { key: 'other', label: 'Others', guideline: null }
];
const GUIDELINE_RE = {
  rct: /\bCONSORT\b/, observational: /\bSTROBE\b|\bRECORD\b(?= (?:statement|guideline|checklist|reporting))/, 'case-report': /\bCARE\b(?= (?:guideline|checklist|statement|reporting))|\bCARE guidelines?\b/,
  retrospective: /\bSTROBE\b|\bRECORD\b(?= (?:statement|guideline|checklist))/, 'systematic-review': /\bPRISMA\b(?!-ScR)/, 'scoping-review': /\bPRISMA-ScR\b|\bPRISMA extension for scoping/i,
  animal: /\bARRIVE\b/, nonrandomized: /\bTREND\b(?= (?:statement|guideline|checklist))|\bTREND statement\b/
};

const ITEMS = [
  { key: 'abstract', short: 'Abstract', label: 'Abstract contains: Background, Objectives, Methods, Results, and Conclusion. (Structured and ≤ 300 words)' },
  { key: 'introduction', short: 'Introduction', label: 'Introduction' },
  { key: 'methods', short: 'Materials and Methods', label: 'Materials and Method' },
  { key: 'registration', short: 'Trial registration', label: 'The clinical study is registered and the registration number and registration date are provided' },
  { key: 'ethics', short: 'Ethical approval', label: 'Ethical Approval (For animal and human study)' },
  { key: 'results', short: 'Results heading', label: 'Results (should be a separate heading)' },
  { key: 'discussion', short: 'Discussion heading', label: 'Discussion (should be a separate heading)' },
  { key: 'references', short: 'References (PJPS format)', label: 'References (within the manuscript and in the reference section as per PJPS Format)' },
  { key: 'figures', short: 'Figures (600 dpi TIFF files)', label: 'Figures (Submitted as a separate file with 600 dpi in TIFF format)' }
];

// ------------------------------------------------------------------ reading the manuscript

const words = s => (String(s).match(/\S+/g) || []).length;
const clip = (s, n = 160) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
/** The sentence around a match, as evidence */
function around(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  // a sentence ends at a full stop followed by a capital (not "ClinicalTrials.gov", "et al.", "Fig. 1")
  const before = text.slice(Math.max(0, m.index - 140), m.index);
  let cut = before.lastIndexOf('\n') + 1;
  for (const s of before.matchAll(/[.!?]\s+(?=[A-Z])/g)) cut = Math.max(cut, s.index + s[0].length);
  const a = Math.max(0, m.index - 140) + cut;
  let b = text.slice(m.index).search(/[.!?](?=\s+[A-Z(]|\s*$)|\n/);
  b = b < 0 ? text.length : Math.min(m.index + b + 1, m.index + 220);
  return clip(text.slice(a, b), 220);
}

// headings: a short line naming a section, numbered or not ("2. MATERIALS AND METHODS", "Results:")
const HEADINGS = {
  abstract: /^(?:abstract|summary)\b/i,
  keywords: /^(?:key\s*words?|index terms)\b/i,
  introduction: /^(?:introduction|background)\s*:?$/i,
  methods: /^(?:materials?\s*(?:and|&)\s*methods?|methods?(?:\s*(?:and|&)\s*materials?)?|methodology|experimental(?:\s+(?:section|work|procedures?))?|patients and methods|study design and methods?)\s*:?$/i,
  results: /^(?:results?)(?:\s*(?:and|&)\s*discussions?)?\s*:?$/i,
  discussion: /^(?:discussions?)\s*:?$/i,
  conclusion: /^(?:conclusions?|concluding remarks)\s*:?$/i,
  references: /^(?:references?|bibliography|literature cited)\s*:?$/i
};
function headings(text) {
  const out = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const l = line.trim().replace(/^(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s*/, '').replace(/[*_]+/g, '').trim();
    // the abstract's heading may begin its paragraph ("Abstract: Background: ...")
    if (/^(?:abstract|summary)\s*(?:[:.–-]|$)/i.test(l) && !out.some(h => h.key === 'abstract')) out.push({ key: 'abstract', heading: l.slice(0, 40), start: pos, line: l.slice(0, 40) });
    else if (/^(?:key\s*words?|index terms)\s*[:.–-]/i.test(l)) out.push({ key: 'keywords', heading: 'Keywords', start: pos, line: 'Keywords' });
    else if (l && l.length < 70) {
      for (const [key, re] of Object.entries(HEADINGS)) {
        if (key !== 'abstract' && re.test(l)) { out.push({ key, heading: l, start: pos, line: line.trim() }); break; }
      }
    }
    pos += line.length + 1;
  }
  return out;
}

/** The abstract: from its heading to the keywords or the first section after it */
function abstractOf(text, heads, meta) {
  const h = heads.find(x => x.key === 'abstract');
  if (h) {
    const next = heads.find(x => x.start > h.start && x.key !== 'abstract');
    let body = text.slice(h.start, next ? next.start : Math.min(text.length, h.start + 6000));
    body = body.replace(/^\s*(?:abstract|summary)\s*[:.]?\s*/i, '');
    return body.trim();
  }
  return String(meta.abstract || '').trim();
}

const ABSTRACT_PARTS = [
  ['Background', /\b(?:background|introduction|context)\s*[:.–-]/i],
  ['Objectives', /\b(?:objectives?|aims?(?: and objectives?)?|purpose|goals?)\s*[:.–-]/i],
  ['Methods', /\b(?:methods?|materials? and methods?|methodology|design|study design)\s*[:.–-]/i],
  ['Results', /\b(?:results?|findings)\s*[:.–-]/i],
  ['Conclusion', /\b(?:conclusions?|interpretation)\s*[:.–-]/i]
];

/** Article type from the title, abstract and methods (the strongest signal first) */
function articleType(title, abstract, body) {
  const head = `${title}\n${abstract}`;
  const all = `${head}\n${body.slice(0, 60000)}`;
  const ev = (re, src = all) => around(src, new RegExp(re.source, re.flags.replace('g', '')));
  const tests = [
    ['scoping-review', /\bscoping review\b/i, head],
    ['systematic-review', /\bsystematic (?:literature )?review\b|\bmeta-analys[ie]s\b/i, head],
    ['case-report', /\bcase report\b|\bwe (?:report|present|describe) (?:a|an|the) (?:case|rare)\b|\b(?:a|an) \d{1,3}[- ]year[- ]old (?:male|female|man|woman|boy|girl|patient|child)\b/i, head],
    ['rct', /\brandomi[sz]ed(?:,)? (?:controlled |clinical |double-blind(?:ed)? |placebo-controlled |single-blind(?:ed)? |open-label |parallel[- ]group )*(?:trial|study)\b|\bRCT\b/i, head],
    ['nonrandomized', /\bquasi-experimental\b|\bnon-?randomi[sz]ed (?:controlled |clinical )?(?:trial|intervention|study)\b|\bpre-? ?(?:and|\/) ?post-?(?:test|intervention)\b|\bbefore[- ]and[- ]after (?:study|intervention)\b/i, head],
    ['retrospective', /\bretrospective(?:ly)?\b/i, head],
    ['observational', /\bcross-sectional\b|\bcase-control\b|\b(?:prospective |retrospective )?cohort (?:study|of)\b|\bobservational (?:study|design)\b|\bsurvey\b|\bquestionnaire\b/i, head],
    ['animal', /\b(?:wistar|sprague[- ]dawley|albino) (?:rats?|mice)\b|\b(?:rats|mice|rabbits|guinea pigs|zebrafish|hamsters)\b|\bin vivo\b|\banimal (?:model|study|experiments?)\b/i, all]
  ];
  for (const [key, re, src] of tests) {
    // the animal study needs the animals in the title / abstract, or in the methods several times
    if (key === 'animal') {
      const n = (src.match(new RegExp(re.source, 'gi')) || []).length;
      if (!re.test(head) && n < 3) continue;
    } else if (!re.test(src)) continue;
    return { key, evidence: ev(re, src) };
  }
  // others: what kind of study it is, in a word for the "Specify" line
  const other = [
    [/\bin silico\b|\bmolecular docking\b|\bmolecular dynamics\b|\bnetwork pharmacology\b/i, 'In silico / computational study'],
    [/\b(?:narrative |literature )?review\b/i, 'Narrative review'],
    [/\bformulat(?:ed|ion)\b|\btablets?\b|\bnanoparticles?\b|\bhydrogels?\b|\bemulsions?\b/i, 'Formulation / pharmaceutical development'],
    [/\bHPLC\b|\bmethod validation\b|\bspectrophotometric\b|\bchromatograph/i, 'Analytical method development'],
    [/\bsynthes[ie]s\b|\bsynthesi[sz]ed\b|\bderivatives\b/i, 'Synthesis / medicinal chemistry (in vitro)'],
    [/\bin vitro\b|\bcell lines?\b|\bantimicrobial\b|\bantioxidant\b|\bextracts?\b|\bphytochemical\b/i, 'In vitro / laboratory study']
  ].find(([re]) => re.test(head));
  return { key: 'other', specify: other ? other[1] : 'Laboratory / other study', evidence: other ? ev(other[0], head) : null };
}

/** Within the scope: the PJPS subject areas the title, abstract and keywords fall under */
function scope(title, abstract, keywords) {
  const src = `${title}\n${abstract}\n${(keywords || []).join(', ')}`;
  const toRe = t => {
    const parts = t.split(' AND ').map(p => p.replace(/"/g, '').replace(/\*/g, '\\w*').replace(/[-\s]+/g, '[-\\s]+'));
    return parts.map(p => new RegExp(`\\b${p}\\b`, 'i'));
  };
  const subjects = SUBJECTS.filter(s => s.terms.some(t => toRe(t).every(re => re.test(src)))).map(s => s.name);
  const pharma = /\bpharma\w*|\bdrugs?\b|\bmedicin\w*|\bclinical\b|\bpatients?\b|\btherap\w*|\bplant\b|\bextracts?\b|\bformulation\w*|\bantibacterial|\bantimicrobial|\bantioxidant|\btoxic\w*|\bdisease/i;
  return { yes: subjects.length > 0 || pharma.test(src), subjects };
}

// ------------------------------------------------------------------ figures: separate files, TIFF, 600 dpi

/** dpi of an image file: TIFF (XResolution), JPEG (JFIF / EXIF density), PNG (pHYs) -> { format, dpi } */
function imageInfo(buf, name = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // TIFF
  if (b.length > 8 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d))) {
    const le = b[0] === 0x49;
    const u16 = o => (le ? b.readUInt16LE(o) : b.readUInt16BE(o)), u32 = o => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    try {
      const ifd = u32(4), n = u16(ifd);
      let x = null, unit = 2;
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12, tag = u16(e);
        if (tag === 282) { const off = u32(e + 8); x = u32(off) / (u32(off + 4) || 1); }
        if (tag === 296) unit = u16(e + 8);
      }
      return { format: 'TIFF', dpi: x == null ? null : Math.round(unit === 3 ? x * 2.54 : x) };
    } catch { return { format: 'TIFF', dpi: null }; }
  }
  // PNG
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    const i = b.indexOf('pHYs');
    if (i > 0) { const ppu = b.readUInt32BE(i + 4); return { format: 'PNG', dpi: b[i + 12] === 1 ? Math.round(ppu * 0.0254) : null }; }
    return { format: 'PNG', dpi: null };
  }
  // JPEG
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    const j = b.indexOf('JFIF');
    if (j > 0 && j < 64) { const unit = b[j + 7], d = b.readUInt16BE(j + 8); return { format: 'JPEG', dpi: unit === 1 ? d : unit === 2 ? Math.round(d * 2.54) : null }; }
    return { format: 'JPEG', dpi: null };
  }
  return { format: (path.extname(name).slice(1) || 'unknown').toUpperCase(), dpi: null };
}

/** Pictures inside the manuscript file itself (Word media, PDF images) */
async function embeddedPictures(buffer, filename) {
  if (!buffer) return 0;
  try {
    if (/\.docx$/i.test(filename) || (buffer[0] === 0x50 && buffer[1] === 0x4b)) {
      const z = await JSZip.loadAsync(buffer);
      return Object.keys(z.files).filter(n => /^word\/media\/.+\.(?:png|jpe?g|gif|bmp|tiff?|emf|wmf)$/i.test(n)).length;
    }
    if (/\.pdf$/i.test(filename) || buffer.slice(0, 4).toString() === '%PDF') return (buffer.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;
  } catch { /* unreadable: counted as none */ }
  return 0;
}

// ------------------------------------------------------------------ the sheet

const ans = (value, evidence, extra = {}) => ({ value, auto: value, evidence: evidence || null, ...extra });

/**
 * text: the manuscript text; opts: { filename, buffer (the uploaded file, for its pictures), figures: [{ name, buffer }],
 * manuscriptNo, pjpsTitles: [title] (published PJPS articles, for the same-title check) } -> sheet
 */
async function analyse(text, { filename = '', buffer = null, figures = [], manuscriptNo = '', pjpsTitles = [] } = {}) {
  text = String(text || '').replace(/\r\n?/g, '\n');
  const sec = P.findReferenceSection(text);
  const body = sec.found ? sec.body : text;
  const meta = P.extractManuscriptMeta(body);
  const heads = headings(text);
  const has = k => heads.some(h => h.key === k);
  const title = clip(meta.title || filename.replace(/\.[^.]+$/, ''), 400);
  const abstract = abstractOf(text, heads, meta);
  const msNo = manuscriptNo || (String(filename).match(/(?:G\.?P|PJPS|MS)[-_\s.]*(\d{4,6})/i) || String(filename).match(/\b(\d{5})\b/) || text.slice(0, 3000).match(/\b(?:MS|Manuscript)\s*(?:No\.?|ID|Number)\s*[:#]?\s*([A-Z]*-?\d{4,6})/i) || [])[1] || '';

  // scope, novelty, suitability
  const sc = scope(title, abstract, meta.keywords);
  const samePjps = pjpsTitles.map(t => ({ t, s: titleSimilarity(title, t) })).filter(x => x.s >= 0.85).sort((a, b) => b.s - a.s)[0] || null;
  const type = articleType(title, abstract, body);
  const T = TYPES.find(t => t.key === type.key);

  // reporting guideline: named, its checklist, its flow diagram
  // each type's guideline answers (the editor may change the type: its guideline's answers are ready)
  const checklist = around(text, /\bchecklist\b/i);
  const anyGuide = /\b(?:CONSORT|STROBE|RECORD|CARE|PRISMA(?:-ScR)?|ARRIVE|TREND|SPIRIT|STARD|SQUIRE|COREQ|CHEERS)\b/;
  const flow = around(text, /\bflow[- ]?(?:diagram|chart)\b|\b(?:PRISMA|CONSORT) (?:flow|diagram)\b|\bparticipant flow\b|\bstudy selection (?:process|flow)\b/i);
  const guidelineFor = key => {
    const t = TYPES.find(x => x.key === key);
    const gre = GUIDELINE_RE[key] || null;
    if (!t?.guideline || !gre) return { followed: ans(null, 'No reporting guideline applies to this article type'), checklist: ans(null, null), flow: ans(null, null) };
    const named = around(body, gre);
    const own = checklist && (gre.test(checklist) || anyGuide.test(checklist)) ? checklist
      : /\b(?:supplementary|appendix|additional file)[^.\n]{0,80}checklist|checklist[^.\n]{0,80}(?:supplementary|appendix|additional file)/i.test(text) ? checklist : null;
    return {
      followed: ans(named ? 'yes' : 'no', named || `${t.guideline} is not named in the manuscript`),
      checklist: ans(own ? 'yes' : 'no', own || `No ${t.guideline} checklist is mentioned`),
      flow: ans(flow ? 'yes' : 'no', flow || 'No flow diagram is mentioned')
    };
  };
  const guidelines = Object.fromEntries(TYPES.map(t => [t.key, guidelineFor(t.key)]));
  const guideline = guidelines[type.key];

  // Authors' Instructions
  const absWords = words(abstract);
  const parts = ABSTRACT_PARTS.filter(([, re]) => re.test(abstract)).map(([n]) => n);
  const missingParts = ABSTRACT_PARTS.map(([n]) => n).filter(n => !parts.includes(n));
  const absOk = abstract && missingParts.length === 0 && absWords <= 300;
  const items = {};
  items.abstract = ans(!abstract ? 'no' : absOk ? 'yes' : 'no', !abstract ? 'No abstract was found' : `${absWords} words including the headings; ${parts.length ? `headings found: ${parts.join(', ')}` : 'not structured (no headings)'}${missingParts.length && parts.length ? `; missing: ${missingParts.join(', ')}` : ''}${absWords > 300 ? '; over the 300-word limit' : ''}`, { words: absWords, parts, missing: missingParts });
  const hd = k => heads.find(h => h.key === k);
  items.introduction = ans(has('introduction') ? 'yes' : 'no', has('introduction') ? `Heading “${hd('introduction').line}”` : 'No Introduction heading was found');
  items.methods = ans(has('methods') ? 'yes' : 'no', has('methods') ? `Heading “${hd('methods').line}”` : 'No Materials and Methods heading was found');
  const human = T.human || (/\bpatients?\b|\bparticipants?\b|\bvolunteers?\b|\bsubjects were\b|\binformed consent\b/i.test(body.slice(0, 60000)) && type.key !== 'animal' && !/\bin vitro\b/i.test(title));
  const animal = T.animal || /\b(?:rats|mice|rabbits|animals were)\b/i.test(body.slice(0, 60000));
  const clinical = !!T.clinical;
  const reg = around(text, /\b(?:NCT\d{8}|ISRCTN\d{6,}|ChiCTR[-\w]{6,}|CTRI\/\d{4}\/\d{2,3}\/\d+|IRCT\w{8,}|ACTRN\d{10,}|PACTR\d{10,}|DRKS\d{6,}|jRCT\w{6,}|UMIN\d{6,}|KCT\d{6,}|TCTR\d{6,}|SLCTR\/\d{4}\/\d+|NCT\s?\d{8})\b|\b(?:trial|study) (?:was )?registered\b|\bregistration (?:no|number)\b/i);
  // the date is in the registration sentence or right beside it
  const regAt = reg ? text.indexOf(reg.slice(0, 40)) : -1;
  const regNear = reg ? `${reg} ${regAt >= 0 ? text.slice(regAt, regAt + reg.length + 160) : ''}` : '';
  const regDate = reg && /\b(?:\d{1,2}[\s/.-](?:\d{1,2}|jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)[\s/.-]\d{2,4}|(?:jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|(?:19|20)\d{2})\b/i.test(regNear);
  items.registration = clinical
    ? ans(reg && regDate ? 'yes' : 'no', reg ? `${reg}${regDate ? '' : ' (no registration date found)'}` : 'Clinical study: no trial registration number was found')
    : ans('na', 'Not a clinical trial: registration does not apply');
  let eth = around(text,/\bethic(?:s|al)(?: review)? (?:committee|board|approval|clearance)\b|\binstitutional (?:review board|animal care|ethics)\b|\bIRB\b|\bIACUC\b|\bapproval (?:no|number|ref)\b|\bethical (?:approval|permission)\b|\bERC\b|\bbioethic\w* committee\b/i);
  // a heading alone ("Ethical approval"): the statement under it is the evidence
  if (eth && eth.length < 40) {
    const at = text.indexOf(eth);
    const next = at >= 0 ? text.slice(at + eth.length).replace(/^[\s:.]+/, '') : '';
    if (next) eth = clip(`${eth}: ${next.split('\n')[0]}`, 240);
  }
  if (eth && /\bnot applicable\b|\bnot required\b|\bN\/A\b/i.test(eth) && !(human || animal)) eth = null;
  items.ethics = human || animal
    ? ans(eth && !/\bnot applicable\b|\bnot required\b/i.test(eth) ? 'yes' : 'no', eth || `${animal && !human ? 'Animal' : 'Human'} study: no ethical approval statement was found`)
    : ans('na', 'No human participants or animals: ethical approval does not apply');
  const res = hd('results');
  const combined = res && /discussion/i.test(res.heading);
  items.results = ans(res && !combined ? 'yes' : 'no', !res ? 'No Results heading was found' : combined ? `“${res.line}” – Results and Discussion are combined` : `Heading “${res.line}”`);
  items.discussion = ans(has('discussion') && !combined ? 'yes' : 'no', combined ? `“${res.line}” – no separate Discussion heading` : has('discussion') ? `Heading “${hd('discussion').line}”` : 'No Discussion heading was found');

  // references: PJPS format (Module 2's rules) and in-text citations matching the list (Module 3)
  let refNote = 'No reference list was found', refOk = false, refScore = null;
  if (sec.found && sec.references) {
    const entries = P.splitReferences(sec.references).entries.filter(P.looksLikeReference);
    const refs = entries.map((e, i) => P.parseReferenceEntry(e, i + 1));
    if (refs.length) {
      const cp = require('../checks/compliance').checkCompliance(refs, { records: [], body, nlm: [] });
      const ct = require('../checks/citation').checkCitations(body, refs);
      refScore = cp.summary.score;
      const miss = ct.summary?.missing || 0, unc = ct.summary?.uncited || 0;
      refOk = refScore >= 80 && miss <= 2 && unc <= 3;
      refNote = `${refs.length} references: ${refScore}% in PJPS format (${cp.summary.nonCompliant} to fix); in the text ${miss} citation(s) missing from the list, ${unc} reference(s) never cited`;
    }
  }
  items.references = ans(refOk ? 'yes' : 'no', refNote, { score: refScore });

  // figures
  const embedded = await embeddedPictures(buffer, filename);
  const figInfo = figures.map(f => ({ name: f.name, ...imageInfo(f.buffer, f.name) }));
  const cited = (body.match(/\bFig(?:ure)?s?\.?\s*\d/gi) || []).length;
  let figVal, figNote;
  if (figInfo.length) {
    const bad = figInfo.filter(f => f.format !== 'TIFF' || !f.dpi || f.dpi < 600);
    figVal = bad.length ? 'no' : 'yes';
    figNote = `${figInfo.length} figure file(s): ${figInfo.map(f => `${f.name} (${f.format}${f.dpi ? `, ${f.dpi} dpi` : ', resolution not recorded'})`).join('; ')}${bad.length ? ` – ${bad.length} not a 600 dpi TIFF` : ''}`;
  } else if (embedded || cited) {
    figVal = 'no';
    figNote = `${embedded ? `${embedded} picture(s) embedded in the manuscript file` : `${cited} figure citation(s) in the text`}; no separate figure files were uploaded (add the figure files to check their format and resolution)`;
  } else { figVal = 'na'; figNote = 'The manuscript has no figures'; }
  items.figures = ans(figVal, figNote, { files: figInfo, embedded });

  const scopeAns = ans(sc.yes ? 'yes' : 'no', sc.subjects.length ? `PJPS subject areas: ${sc.subjects.slice(0, 4).join(', ')}` : sc.yes ? 'Pharmaceutical / medical research' : 'No PJPS subject area found in the title, abstract or keywords');
  const novelty = ans(samePjps ? 'no' : 'yes', samePjps ? `A PJPS article with the same title is already published: “${clip(samePjps.t, 140)}”` : `No published PJPS article has the same title (${pjpsTitles.length.toLocaleString('en-US')} compared). Run the Full Screening for the novelty assessment against the literature.`);
  const sheet = {
    version: 1, createdAt: new Date().toISOString(), filename, msNo, title,
    scope: scopeAns, novelty,
    type: { key: type.key, auto: type.key, specify: type.specify || '', evidence: type.evidence, guideline },
    guidelines,
    items
  };
  sheet.suitable = ans(null, null);
  return finish(sheet);
}

/** Suitable and the outcome follow the answers (after the editor's changes too) */
function finish(sheet) {
  const need = ITEMS.map(i => sheet.items[i.key]).filter(a => a && a.value !== 'na');
  const failed = ITEMS.filter(i => sheet.items[i.key] && sheet.items[i.key].value === 'no').map(i => i.short);
  const scopeOk = sheet.scope.value === 'yes';
  const autoSuitable = scopeOk && sheet.novelty.value !== 'no' ? 'yes' : 'no';
  if (!sheet.suitable || sheet.suitable.auto === sheet.suitable.value || sheet.suitable.value == null) sheet.suitable = { ...sheet.suitable, value: autoSuitable, auto: autoSuitable, evidence: autoSuitable === 'yes' ? 'Within the scope and no same-title PJPS article' : !scopeOk ? 'Outside the scope of PJPS' : 'Already published in PJPS' };
  const peer = scopeOk && sheet.novelty.value !== 'no' && sheet.suitable.value === 'yes' && need.every(a => a.value === 'yes');
  sheet.outcome = scopeOk && sheet.suitable.value === 'yes' ? (peer ? 'peer-review' : 'resubmit') : 'reject';
  sheet.outcomeNote = sheet.outcome === 'peer-review' ? 'All checks are met: the article can be processed for peer review.'
    : sheet.outcome === 'resubmit' ? `Within the scope; to correct before peer review: ${failed.join('; ') || 'the reporting guideline items'}.`
    : 'Outside the scope or not suitable for PJPS.';
  return sheet;
}

/** The editor's changes: { scope, novelty, suitable, typeKey, specify, guideline: { followed, checklist, flow }, items: { key: value }, msNo, title, comments } */
function applyEdits(sheet, e = {}) {
  const s = JSON.parse(JSON.stringify(sheet));
  const v = x => (['yes', 'no', 'na', null].includes(x) ? x : undefined);
  for (const k of ['scope', 'novelty', 'suitable']) if (v(e[k]) !== undefined) s[k].value = e[k];
  if (e.typeKey && TYPES.some(t => t.key === e.typeKey) && e.typeKey !== s.type.key) {
    s.type.key = e.typeKey;
    if (s.guidelines?.[e.typeKey]) s.type.guideline = JSON.parse(JSON.stringify(s.guidelines[e.typeKey]));
  }
  if (e.specify !== undefined) s.type.specify = String(e.specify).slice(0, 120);
  for (const k of ['followed', 'checklist', 'flow']) if (v(e.guideline?.[k]) !== undefined) s.type.guideline[k].value = e.guideline[k];
  for (const i of ITEMS) if (v(e.items?.[i.key]) !== undefined) s.items[i.key].value = e.items[i.key];
  if (e.msNo !== undefined) s.msNo = String(e.msNo).slice(0, 40);
  if (e.title !== undefined) s.title = String(e.title).slice(0, 400);
  if (e.comments !== undefined) s.comments = String(e.comments).slice(0, 4000);
  return finish(s);
}

// ------------------------------------------------------------------ the Word form

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const RUN = (t, bold = true) => `<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>${bold ? '<w:b/>' : ''}<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const TICK = '✓';

/** A cell's text replaced (its paragraph and cell properties kept) */
function setCell(cell, text, { bold = true, center = true } = {}) {
  return cell.replace(/(<w:p\b[^>]*>)([\s\S]*?)(<\/w:p>)/, (m, open, inner, close) => {
    const ppr = (inner.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const p = center && !/<w:jc /.test(ppr) ? (ppr ? ppr.replace('<w:pPr>', '<w:pPr><w:jc w:val="center"/>') : '<w:pPr><w:jc w:val="center"/></w:pPr>') : ppr;
    return `${open}${p}${text ? RUN(text, bold) : ''}${close}`;
  });
}
function mapRows(table, fn) {
  let r = -1;
  return table.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, row => {
    r++;
    let c = -1;
    const cells = [];
    row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, x => { cells.push(x); return x; });
    const out = fn(r, cells.slice()) || cells;
    return row.replace(/<w:tc>[\s\S]*?<\/w:tc>/g, () => out[++c]);
  });
}

/** The filled journal form (.docx) */
async function toDocx(sheet) {
  const z = await JSZip.loadAsync(fs.readFileSync(TEMPLATE));
  let x = await z.file('word/document.xml').async('string');
  // MS No and the title (the template's example title is replaced)
  x = x.replace('<w:t>__________</w:t>', `<w:t xml:space="preserve">${esc(sheet.msNo || '__________')}</w:t>`);
  const paras = x.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  const tp = paras.find(p => /GC-MS Analysis/.test(p));
  if (tp) {
    const ppr = (tp.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    x = x.replace(tp, `${tp.match(/^<w:p\b[^>]*>/)[0]}${ppr}${RUN(sheet.title || '')}</w:p>`);
  }
  const tables = x.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
  const mark = (cells, i, on) => { if (on) cells[i] = setCell(cells[i], TICK); else cells[i] = setCell(cells[i], ''); };
  // 1: within the scope / novelty / suitable
  if (tables[0]) x = x.replace(tables[0], mapRows(tables[0], (r, cells) => {
    if (r === 1 || r === 2) {
      const want = r === 1 ? 'yes' : 'no';
      [sheet.scope, sheet.novelty, sheet.suitable].forEach((a, k) => mark(cells, k * 2 + 1, a?.value === want));
    }
    return cells;
  }));
  // 2: article type and its guideline (rows in pairs: Yes / No; "Others" has a blank row between)
  if (tables[1]) x = x.replace(tables[1], mapRows(tables[1], (r, cells) => {
    if (r < 2) return cells;
    const pair = r >= 18 ? 8 : Math.floor((r - 2) / 2);
    const yesRow = r >= 18 ? r === 18 : (r - 2) % 2 === 0;
    const t = TYPES[pair];
    if (!t || !cells[2]) return cells;
    const isType = sheet.type.key === t.key;
    if (r === 19) return cells;
    mark(cells, 2, yesRow ? isType : !isType);
    if (yesRow) {
      const g = sheet.type.guideline;
      for (const [k, col] of [['followed', 4], ['checklist', 6], ['flow', 8]]) {
        const v = isType ? g[k]?.value : null;
        mark(cells, col, v === 'yes');
        mark(cells, col + 1, v === 'no');
      }
      if (t.key === 'other') {
        if (isType && sheet.type.specify) cells[0] = cells[0].replace(/____________/, esc(sheet.type.specify));
      }
    }
    return cells;
  }));
  // 3: Authors' Instructions (Yes / No; not applicable written in the Yes column)
  if (tables[2]) x = x.replace(tables[2], mapRows(tables[2], (r, cells) => {
    const it = ITEMS[r - 1];
    if (!it) return cells;
    const v = sheet.items[it.key]?.value;
    cells[1] = setCell(cells[1], v === 'yes' ? TICK : v === 'na' ? 'N/A' : '');
    cells[2] = setCell(cells[2], v === 'no' ? TICK : '');
    return cells;
  }));
  // 4: the outcome
  if (tables[3]) x = x.replace(tables[3], mapRows(tables[3], (r, cells) => {
    if (cells[1]) cells[1] = setCell(cells[1], (r === 0 && sheet.outcome === 'peer-review') || (r === 1 && sheet.outcome === 'resubmit') ? TICK : '');
    return cells;
  }));
  // the editor's comments and what to correct, after the outcome
  const notes = [sheet.outcome === 'reject' ? 'Outside the scope or not suitable for PJPS.' : null, sheet.comments || null,
    ...ITEMS.filter(i => sheet.items[i.key]?.value === 'no').map(i => `${i.short}: ${sheet.items[i.key].evidence || ''}`)].filter(Boolean);
  if (notes.length) {
    const para = t => `<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>${RUN(t, false)}</w:p>`;
    const block = `<w:p/>${para('Comments:').replace(RUN('Comments:', false), RUN('Comments:'))}${notes.map(n => para(`• ${n}`)).join('')}`;
    const end = x.lastIndexOf('<w:sectPr');
    x = x.slice(0, end) + block + x.slice(end);
  }
  z.file('word/document.xml', x);
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { analyse, applyEdits, finish, toDocx, imageInfo, headings, articleType, TYPES, ITEMS };
