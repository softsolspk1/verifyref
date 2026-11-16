// language/spell.js - PJPS Scribe (Module 6) spelling: Hunspell dictionaries for US and UK English (SCOWL, vendored in ./dict)
// read with nspell, the research vocabulary learned from published PJPS and PubMed Central papers (./dict/research.txt, made
// by scripts/build-research-lexicon.js: medical, pharmaceutical and statistical terms and names), plus what a manuscript
// needs so it is not drowned in false alarms: drug, chemical and Latin terms built from known prefixes, units, acronyms, gene/compound codes and words the writer uses repeatedly. Suggestions come from
// single edits checked against the dictionary (fast); nspell's own search is the slow fallback for a few words per call.
const fs = require('fs');
const path = require('path');

// literal paths so the serverless bundler includes the dictionaries
const FILES = {
  'en-US': [path.join(__dirname, 'dict', 'en-US.aff'), path.join(__dirname, 'dict', 'en-US.dic')],
  'en-GB': [path.join(__dirname, 'dict', 'en-GB.aff'), path.join(__dirname, 'dict', 'en-GB.dic')]
};
const RESEARCH = path.join(__dirname, 'dict', 'research.txt');
const RESEARCH_COMMON_FILE = path.join(__dirname, 'dict', 'research-common.txt');
const NAMES_FILE = path.join(__dirname, 'dict', 'names.txt');
const lines = f => { try { return fs.readFileSync(f, 'utf8').split('\n').map(w => w.trim()).filter(w => w && !w.startsWith('#')); } catch { return []; } };
// author surnames learned from published papers (scripts/build-names-lexicon.js): Liu, Gao, Mlinac, Leasure, Arayne
let NAMES = null;
const isName = w => /^[A-Z][a-z']+$/.test(w) && (NAMES || (NAMES = new Set(lines(NAMES_FILE)))).has(w);
const cache = {};

function load(variant) {
  const v = variant === 'en-GB' ? 'en-GB' : 'en-US';
  if (!cache[v]) {
    const nspell = require('nspell');
    cache[v] = nspell(fs.readFileSync(FILES[v][0]), fs.readFileSync(FILES[v][1]));
    for (const w of SCIENCE) cache[v].add(w);
    for (const w of lines(RESEARCH)) cache[v].add(w);
  }
  return cache[v];
}

// Common scientific and pharmaceutical words the general dictionaries lack
const SCIENCE = `pharmacokinetic pharmacokinetics pharmacodynamic pharmacodynamics pharmacological pharmacologically pharmacovigilance pharmacognosy
pharmaceutics bioavailability bioequivalence bioassay bioassays biomarker biomarkers biofilm biofilms cytotoxic cytotoxicity genotoxic genotoxicity
hepatotoxic hepatotoxicity nephrotoxic nephrotoxicity antioxidant antioxidants antimicrobial antimicrobials antibacterial antifungal antiviral antidiabetic
anticancer antiproliferative antiinflammatory analgesic anxiolytic antidepressant antihypertensive anticoagulant antiplatelet antiemetic antipyretic
nanoparticle nanoparticles nanoformulation nanocarrier nanocarriers nanoemulsion liposome liposomes liposomal micelle micelles excipient excipients
chromatography chromatographic chromatogram spectrophotometer spectrophotometric spectrophotometry spectroscopy spectroscopic spectrometry
phytochemical phytochemicals phytochemistry flavonoid flavonoids polyphenol polyphenols polyphenolic alkaloid alkaloids saponin saponins tannin tannins
terpenoid terpenoids glycoside glycosides metabolite metabolites metabolomics proteomics genomics transcriptomics lipidomics
immunohistochemistry immunohistochemical immunoassay histopathology histopathological histological apoptosis apoptotic necrosis necrotic
upregulated upregulation downregulated downregulation overexpression overexpressed knockdown knockout in vitro vivo silico situ
dose-dependent ethanolic methanolic aqueous hydroalcoholic lyophilized lyophilised centrifuged centrifugation homogenate homogenized homogenised
supernatant supernatants aliquot aliquots pipetted incubated incubation microplate microtiter mL μL µL μg µg μM µM nM mM kDa
docking ligand ligands pharmacophore pharmacophores ADMET QSAR inhibitory inhibitor inhibitors agonist agonists antagonist antagonists
cytokine cytokines chemokine chemokines interleukin interleukins macrophage macrophages lymphocyte lymphocytes neutrophil neutrophils
hyperglycemia hyperglycaemia hypoglycemia hypoglycaemia dyslipidemia dyslipidaemia normoglycemic streptozotocin alloxan glibenclamide metformin
pre paracetamol acetaminophen diclofenac ibuprofen indomethacin dexamethasone carrageenan formalin Wistar Sprague Dawley
covariate covariates multivariate univariate multivariable regression heterogeneity meta-analysis meta-analyses
preprint preprints dataset datasets workflow workflows curcumin quercetin rutin kaempferol resveratrol gallic catechin catechins
anthocyanin anthocyanins carotenoid carotenoids lycopene berberine silymarin thymoquinone eugenol carvacrol thymol menthol limonene`.split(/\s+/).filter(Boolean);

// Prefixes that build valid technical words from a dictionary word ("nanoformulated", "immunomodulatory")
const PREFIXES = ['syn', 'hetero', 'anti', 'bio', 'cyto', 'hepato', 'nephro', 'neuro', 'cardio', 'immuno', 'hydro', 'hyper', 'hypo', 'micro', 'nano', 'macro', 'multi', 'poly',
  'pharmaco', 'phyto', 'photo', 'radio', 'electro', 'thermo', 'chemo', 'pre', 'post', 'non', 'co', 're', 'sub', 'inter', 'intra', 'trans', 'pseudo', 'semi',
  'over', 'under', 'up', 'down', 'gastro', 'endo', 'exo', 'peri', 'para', 'meta', 'iso', 'di', 'tri', 'tetra', 'mono', 'methyl', 'ethyl', 'oxy', 'de', 'un', 'self'];
const CHEM_SUFFIX = /(?:ine|ide|ate|ite|ase|ose|ol|one|ene|yne|ane|yl|oid|in|an|mab|nib|vir|pril|sartan|olol|statin|azole|mycin|cillin|cycline|floxacin|dipine|tidine|prazole|gliptin|gliflozin|parin|xaban|lukast|setron|triptan|afil)s?$/i;

/** Words that are not spelling mistakes even if no dictionary has them */
// units, laboratory products and instruments written in their own case (MPa, KBr, mmol, TRIzol, UV-Vis, Q-TOF)
const UNITS = new Set('mol mmol nmol pmol fmol umol µmol mosm mosmol meq mmhg kpa mpa gpa hpa kda mda rpm ppm ppb ppt khz mhz ghz mev kev kbr kcl nacl trizol qtof vis uv-vis lux kcal kj mj'.split(' '));

function exempt(word, ctx = {}) {
  if (word.length < 3) return true;
  if (UNITS.has(word.toLowerCase())) return true;
  if (/^[A-Z]{2,}[a-z]{1,2}$/.test(word)) return true;              // MPa, KBr, QTof
  if (/^[A-Z][a-z]{1,4}-[A-Z][a-z]{1,4}$/.test(word)) return true;  // hyphenated given names: Yu-Jie, Dong-Mei
  if (/\d/.test(word)) return true;                                // compound codes, genes, units with numbers
  if (/^[A-Z0-9-]+s?$/.test(word)) return true;                    // acronyms: HPLC, NSAIDs, COX-2
  if (/[a-z][A-Z]/.test(word)) return true;                        // mixed case: mRNA, pH, iPhone, NaCl
  if (/^[A-Z][a-z]+$/.test(word) && ctx.midSentence) return true;  // proper nouns mid-sentence (names, places, genera)
  if (/[^ -~]/.test(word.replace(/’/g, "'"))) return true; // Greek letters, accented names
  if (/^(?:https?|www)\b/i.test(word) || word.includes('@')) return true;
  if (ctx.address) return true;                                    // part of a web address, e-mail or file name (pjps.pk, report.pdf)
  if (ctx.repeated && word.length > 6) return true;                // a term the writer uses again and again is their vocabulary
  return false;
}

const cap = w => w[0].toUpperCase() + w.slice(1).toLowerCase();

function correctAny(sp, w) {
  if (sp.correct(w)) return true;
  const lower = w.toLowerCase();
  if (lower !== w && sp.correct(lower)) return true;
  // hyphenated words: each part valid (an abbreviation, a prefix, a term or name: "LNG-IUS-containing", "non-absorbable", "Kaplan-Meier")
  if (w.includes('-')) return w.split('-').every(p => !p || /\d/.test(p) || p.length < 3 || /^[A-Z]+s?$/.test(p) || PREFIXES.includes(p.toLowerCase()) || sp.correct(p) || sp.correct(p.toLowerCase()) || sp.correct(cap(p)));
  // prefixed technical words and drug/chemical name endings
  for (const p of PREFIXES) {
    if (lower.startsWith(p) && lower.length - p.length >= (p.length <= 3 ? 5 : 4)) {
      const rest = lower.slice(p.length);
      if (sp.correct(rest) || sp.correct(rest.replace(/^-/, ''))) return true;
    }
  }
  return false;
}

/** Is the word spelled correctly for this variant? personal: Set of the user's own dictionary (lower case) */
function check(word, { variant = 'en-US', personal = null, ctx = {} } = {}) {
  if (personal && personal.has(word.toLowerCase())) return true;
  // a known misspelling is wrong even when its parts are words ("prevalance" = pre + valance)
  const t = TYPOS[word.toLowerCase()];
  if (t && t !== word.toLowerCase() && word.length >= 3 && !/\d/.test(word)) return false;
  if (exempt(word, ctx)) return true;
  if (isName(word)) return true;
  const sp = load(variant);
  if (sp.correct(word) || sp.correct(word.toLowerCase())) return true;
  // a name learned from published papers written here in lower case ("kaplan-meier" curves)
  if (/^[a-z]+$/.test(word) && sp.correct(cap(word))) return true;
  // the other variety's spelling ("colour" in a US document) is reported as such, not built from prefixes
  if (otherVariant(word, variant)) return false;
  if (correctAny(sp, word)) return true;
  // a drug or chemical name ("quercetin", "atorvastatin") that is not one slip away from a dictionary word
  const lower = word.toLowerCase();
  return lower.length >= 7 && CHEM_SUFFIX.test(lower) && !edits1(lower).some(c => sp.correct(c));
}

/** Correct in the other variant: a US spelling in a UK document or the reverse ("color" / "colour") */
function otherVariant(word, variant) {
  const other = variant === 'en-GB' ? 'en-US' : 'en-GB';
  return load(other).correct(word) || load(other).correct(word.toLowerCase());
}

// Frequent typing slips with an obvious answer, ranked ahead of computed suggestions
const HAND_TYPOS = {
  teh: 'the', adn: 'and', hte: 'the', taht: 'that', thier: 'their', recieve: 'receive', recieved: 'received', beleive: 'believe', occured: 'occurred',
  resistence: 'resistance', hypertention: 'hypertension', absense: 'absence', consistant: 'consistent', prevalance: 'prevalence', persistant: 'persistent',
  medecine: 'medicine', concentraion: 'concentration', signifcant: 'significant', statisticaly: 'statistically',
  diabetis: 'diabetes', antioxident: 'antioxidant', phosphorilation: 'phosphorylation', monocional: 'monoclonal', recommandations: 'recommendations',
  occurence: 'occurrence', seperate: 'separate', seperately: 'separately', definately: 'definitely', accomodate: 'accommodate', acheive: 'achieve',
  acheived: 'achieved', untill: 'until', wich: 'which', whcih: 'which', becuase: 'because', becasue: 'because', alot: 'a lot', goverment: 'government',
  enviroment: 'environment', existance: 'existence', independant: 'independent', neccessary: 'necessary', necesary: 'necessary', occassion: 'occasion',
  persue: 'pursue', publically: 'publicly', recomend: 'recommend', refered: 'referred', relevent: 'relevant', succesful: 'successful', truely: 'truly',
  wierd: 'weird', analyis: 'analysis', anaylsis: 'analysis', significnat: 'significant', signficant: 'significant', resutls: 'results',
  reuslts: 'results', studys: 'studies', concious: 'conscious', dependant: 'dependent', embarass: 'embarrass', foriegn: 'foreign', freind: 'friend',
  guage: 'gauge', happend: 'happened', judgement: 'judgment', knowlege: 'knowledge', liason: 'liaison', millenium: 'millennium', noticable: 'noticeable',
  posession: 'possession', prefered: 'preferred', priviledge: 'privilege', recurrance: 'recurrence', tommorow: 'tomorrow', tounge: 'tongue', wether: 'whether',
  // slips seen in manuscripts that read as a prefix plus a word, or that published scans repeat
  resluts: 'results', apotosis: 'apoptosis', apoptotis: 'apoptosis', fourty: 'forty', azometine: 'azomethine', patinets: 'patients', pateints: 'patients',
  paitents: 'patients', sigificant: 'significant', statisical: 'statistical', staistically: 'statistically', theraphy: 'therapy', inflamation: 'inflammation',
  inflammtory: 'inflammatory', hemorrage: 'hemorrhage', haemorrage: 'haemorrhage', protien: 'protein', protiens: 'proteins', efficasy: 'efficacy',
  efficiacy: 'efficacy', toxicty: 'toxicity', cytotoxicty: 'cytotoxicity', antibiotc: 'antibiotic', asthama: 'asthma', diarhea: 'diarrhea',
  arthiritis: 'arthritis', pnemonia: 'pneumonia', pneumonae: 'pneumoniae', ophthalmalogy: 'ophthalmology', opthalmic: 'ophthalmic', opthalmology: 'ophthalmology',
  hemmorhage: 'hemorrhage', haemorrhege: 'haemorrhage', rhythym: 'rhythm', arrythmia: 'arrhythmia', arrythmias: 'arrhythmias', dyspnoae: 'dyspnoea', diarrohea: 'diarrhoea',
  gastroentritis: 'gastroenteritis', hepatits: 'hepatitis', menengitis: 'meningitis', pharmacutical: 'pharmaceutical', pharmaceutcal: 'pharmaceutical', pharamaceutical: 'pharmaceutical',
  pharmacolgy: 'pharmacology', pharmocology: 'pharmacology', pharmacokinatics: 'pharmacokinetics', bioavailablity: 'bioavailability', paracetemol: 'paracetamol', ibuprofin: 'ibuprofen',
  acetominophen: 'acetaminophen', asprin: 'aspirin', amoxycilin: 'amoxicillin', amoxicilline: 'amoxicillin', penicilin: 'penicillin', ciprofloxacine: 'ciprofloxacin', metformine: 'metformin',
  insuline: 'insulin', glibenclamid: 'glibenclamide', dexamethazone: 'dexamethasone', predinsolone: 'prednisolone', hydrocortizone: 'hydrocortisone', omeprazol: 'omeprazole',
  flavanoids: 'flavonoids', flavanoid: 'flavonoid', alkaloides: 'alkaloids', saponines: 'saponins',
  chromatograpy: 'chromatography', chromotography: 'chromatography', spectrophotmeter: 'spectrophotometer', spectrophotomter: 'spectrophotometer', centrifugated: 'centrifuged',
  supernatent: 'supernatant', homogenete: 'homogenate', incubeted: 'incubated', aliqout: 'aliquot', aliqouts: 'aliquots',
  histopathalogy: 'histopathology', histopathalogical: 'histopathological', immunohistochemestry: 'immunohistochemistry', apoptois: 'apoptosis', necroisis: 'necrosis', infiltaration: 'infiltration',
  questionaire: 'questionnaire', questionaires: 'questionnaires', questionnair: 'questionnaire', particpants: 'participants', partcipants: 'participants', respondants: 'respondents',
  significanly: 'significantly', signficantly: 'significantly', statistcally: 'statistically', statistially: 'statistically', corelation: 'correlation', corellation: 'correlation',
  regresion: 'regression', varience: 'variance', standart: 'standard', deviaton: 'deviation', comparision: 'comparison', comparisions: 'comparisons', reproducability: 'reproducibility',
  recomended: 'recommended', recomendation: 'recommendation', occuring: 'occurring', ocurred: 'occurred', begining: 'beginning', sucessfully: 'successfully', succesfully: 'successfully',
  accomodation: 'accommodation', aquire: 'acquire', aquired: 'acquired', adress: 'address', adressed: 'addressed', apparant: 'apparent', concensus: 'consensus',
  critisism: 'criticism', excercise: 'exercise', excercises: 'exercises', foward: 'forward', grammer: 'grammar', harrass: 'harass', immediatly: 'immediately', interupt: 'interrupt',
  mantain: 'maintain', mantained: 'maintained', maintainance: 'maintenance', nieghbour: 'neighbour', occassionally: 'occasionally', paralell: 'parallel', parralel: 'parallel',
  perfomance: 'performance', perfomed: 'performed', posible: 'possible', prefered: 'preferred', presense: 'presence', responsibilty: 'responsibility',
  succesive: 'successive', suprise: 'surprise', tendancy: 'tendency', therefor: 'therefore', thershold: 'threshold', threshhold: 'threshold', usefull: 'useful', vaccum: 'vacuum', withold: 'withhold'
};
// with the slips found in published papers and drug names in another language's form (scripts/build-scribe-rules.js)
const TYPOS = { ...Object.fromEntries(require('./bank').typoList().map(t => [t.typo, t.word])), ...HAND_TYPOS };

const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
function edits1(w) {
  const out = new Set();
  for (let i = 0; i <= w.length; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if (b) out.add(a + b.slice(1));                                   // delete
    if (b.length > 1) out.add(a + b[1] + b[0] + b.slice(2));           // transpose
    for (const c of ALPHA) {
      if (b) out.add(a + c + b.slice(1));                             // replace
      out.add(a + c + b);                                             // insert
    }
  }
  out.delete(w);
  return [...out];
}

const matchCase = (src, s) => (/^[A-Z][a-z]/.test(src) ? s[0].toUpperCase() + s.slice(1) : /^[A-Z]+$/.test(src) ? s.toUpperCase() : s);

let slowBudget = 0;
/** Call before each check: how many slow (full search) suggestions this call may compute */
function resetBudget(n = 8) { slowBudget = n; }

/** Up to 4 suggestions, best first */
function suggest(word, variant = 'en-US') {
  const sp = load(variant);
  const lower = word.toLowerCase();
  const out = [];
  if (TYPOS[lower] && TYPOS[lower] !== lower) out.push(TYPOS[lower]);
  const near = edits1(lower).filter(c => sp.correct(c));
  // a transposition or a single dropped/doubled letter is the likeliest slip; same first letter next
  const rank = c => (c.length === lower.length && [...c].sort().join('') === [...lower].sort().join('') ? 0 : 1) + (c[0] === lower[0] ? 0 : 2);
  near.sort((a, b) => rank(a) - rank(b) || Math.abs(a.length - lower.length) - Math.abs(b.length - lower.length));
  out.push(...near);
  // split run-together words: "inorder" -> "in order"
  for (let i = 2; i < lower.length - 1 && out.length < 6; i++) {
    const a = lower.slice(0, i), b = lower.slice(i);
    if (a.length > 1 && b.length > 1 && sp.correct(a) && sp.correct(b) && (a.length > 2 || ['a', 'an', 'in', 'on', 'at', 'to', 'of', 'is', 'it', 'as', 'be', 'by', 'do', 'go', 'he', 'if', 'me', 'my', 'no', 'or', 'so', 'up', 'us', 'we'].includes(a))) out.push(`${a} ${b}`);
  }
  if (!out.length && slowBudget > 0) { slowBudget--; out.push(...sp.suggest(lower)); }
  return [...new Set(out)].slice(0, 4).map(s => matchCase(word, s));
}

// words used by at least a fifth of published research articles (same script): not "overused" when a paragraph repeats them
const RESEARCH_COMMON = new Set(lines(RESEARCH_COMMON_FILE));

module.exports = { load, check, suggest, otherVariant, resetBudget, exempt, isName, TYPOS, HAND_TYPOS, RESEARCH_COMMON };
