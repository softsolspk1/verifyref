// integrity/ethics.js - Research ethics verification:
//   - what kind of study it is (human, animal, clinical trial)
//   - ethics committee approval and its reference number; informed consent; Declaration of Helsinki / animal-welfare guideline
//   - clinical-trial registration numbers from 16 registries; NCT numbers checked in ClinicalTrials.gov (exists, registered
//     before the study started, about the same study)
//   - declarations: conflict of interest, funding, data availability, author contributions, use of AI tools
const { getJson, isOnline } = require('../http');
const { titleSimilarity } = require('../text');
const { dimension, finish, ctx } = require('./common');
const { studyType, approvalNumber } = require('../papermill/studyEthics');

const REGISTRIES = [
  ['ClinicalTrials.gov', /\bNCT\d{8}\b/gi], ['ISRCTN', /\bISRCTN\d{8}\b/gi], ['CTRI (India)', /\bCTRI\/\d{4}\/\d{2,3}\/\d{6}\b/gi], ['IRCT (Iran)', /\bIRCT\d{8,14}N\d{1,3}\b/gi],
  ['ChiCTR (China)', /\bChiCTR-?[A-Z]{0,4}-?\d{6,10}\b/gi], ['ANZCTR', /\bACTRN\d{14}\b/gi], ['PACTR (Africa)', /\bPACTR\d{15}\b/gi], ['DRKS (Germany)', /\bDRKS\d{8}\b/gi],
  ['EU CTR / EudraCT', /\b(?:EudraCT\s*(?:No\.?|number)?\s*:?\s*)?\d{4}-\d{6}-\d{2}(?:-\d{2})?\b/gi], ['jRCT (Japan)', /\bjRCT[s]?\d{10}\b/gi], ['UMIN (Japan)', /\bUMIN\d{9}\b/gi],
  ['CRIS (Korea)', /\bKCT\d{7}\b/gi], ['TCTR (Thailand)', /\bTCTR\d{11}\b/gi], ['SLCTR (Sri Lanka)', /\bSLCTR\/\d{4}\/\d{3}\b/gi], ['REBEC (Brazil)', /\bRBR-\w{6,8}\b/gi], ['Netherlands Trial Register', /\bNTR\d{3,5}\b|\bNL\d{4,5}\b(?=[^.]{0,40}regist)/gi]
];

const TRIAL = /\b(randomi[sz]ed (?:controlled |clinical )?trial|RCT\b|clinical trial|phase (?:I{1,3}|IV|[1-4])\b[^.]{0,30}\btrial|double[- ]blind|placebo[- ]controlled)\b/i;
const IN_VITRO_ONLY = /\b(in vitro|cell lines?|bacterial strains?|in silico|docking)\b/i;

const has = (re, t) => { const m = String(t).match(re); return m ? { found: m[0], quote: ctx(t, m.index, m[0].length, 60) } : null; };

async function trialRecord(nct) {
  const r = await getJson(`https://clinicaltrials.gov/api/v2/studies/${nct}`, { ttl: 14 * 86400, timeout: 15000, retries: 1 });
  if (r.status === 404) return { id: nct, exists: false };
  if (!r.ok) return { id: nct, error: r.error || `HTTP ${r.status}` };
  const s = r.data?.protocolSection || {};
  const st = s.statusModule || {};
  return {
    id: nct, exists: true, title: s.identificationModule?.officialTitle || s.identificationModule?.briefTitle || '',
    submitted: st.studyFirstSubmitDate || null, start: st.startDateStruct?.date || null, status: st.overallStatus || '',
    sponsor: s.sponsorCollaboratorsModule?.leadSponsor?.name || '', url: `https://clinicaltrials.gov/study/${nct}`
  };
}

async function analyzeEthics(text, { title = '', online = isOnline() } = {}) {
  const d = dimension('ethics', 'Research ethics');
  const t = String(text);
  // a human / animal study only when the manuscript reports the work (papermill/studyEthics.js): a mention is not enough
  const st = studyType(t);
  const human = st.human, animal = st.animal, trial = TRIAL.test(t);
  const inVitroOnly = !human && !animal && IN_VITRO_ONLY.test(t);

  const approval = has(/\b(ethic(?:s|al)? (?:review )?(?:committee|board|approval|clearance)|institutional review board|\bIRB\b|\bIACUC\b|animal (?:care|ethics) (?:and use )?committee|\bERC\b|\bIREB\b|bioethics committee|research ethics)\b/i, t);
  // the number is looked for in and next to the approval statement, in all the usual formats (AEC/2021/45, IRB-00123, Ref. No. ...)
  const approvalNo = (() => { const a = approvalNumber(t); return a.number ? { found: a.number, quote: a.approval?.sentence || '' } : null; })();
  const consent = has(/\b(informed consent|written consent|consent (?:was|were) (?:obtained|taken|signed)|consent forms?|assent)\b/i, t);
  const helsinki = has(/\bDeclaration of Helsinki\b|\bHelsinki Declaration\b/i, t);
  const animalGuide = has(/\b(ARRIVE|Guide for the Care and Use of Laboratory Animals|NIH (?:guide|guidelines)|Directive 2010\/63|OECD (?:guideline|test guideline)|CPCSEA|institutional (?:animal )?guidelines)\b/i, t);

  const registrations = [];
  for (const [registry, re] of REGISTRIES) for (const m of t.matchAll(re)) {
    if (registry === 'EU CTR / EudraCT' && !/eudract|eu ?ct|clinical trial/i.test(t.slice(Math.max(0, m.index - 80), m.index + 40))) continue;
    if (!registrations.some(r => r.id === m[0].toUpperCase())) registrations.push({ registry, id: m[0].toUpperCase().replace(/^EUDRACT\s*(?:NO\.?|NUMBER)?\s*:?\s*/, ''), quote: ctx(t, m.index, m[0].length, 50) });
  }

  if (human || animal) {
    const who = animal && !human ? 'Animal' : human && !animal ? 'Human' : 'Human and animal';
    if (!approval) d.sig('no-approval', `${who} study with no ethics committee approval stated`, 'high', 4, [], 'COPE / ICMJE: research on humans or animals needs approval by an ethics committee, named in the manuscript.');
    else if (!approvalNo) d.sig('no-approval-number', 'Ethics approval mentioned without an approval / reference number', 'medium', 1.5, [{ text: approval.found, quote: approval.quote }], 'Ask for the approval number and date, and the approval letter if in doubt.');
  }
  if (human && !consent && !/retrospective|anonymi[sz]ed|de-identified|waived/i.test(t)) d.sig('no-consent', 'Human participants with no informed-consent statement', 'medium', 2, [], 'State how informed consent was obtained (or why it was waived by the ethics committee).');
  if (human && trial && !helsinki) d.sig('no-helsinki', 'Clinical study without reference to the Declaration of Helsinki', 'low', 0.5);
  if (animal && !animalGuide) d.sig('no-animal-guideline', 'Animal study without an animal-welfare guideline (ARRIVE, NIH Guide, Directive 2010/63, OECD)', 'low', 1);
  if (trial && human && !registrations.length) d.sig('no-registration', 'Clinical trial with no trial-registration number', 'high', 4, [], 'ICMJE requires prospective registration in a WHO-recognised registry before the first participant is enrolled.');

  const trials = [];
  if (online) for (const r of registrations.filter(x => x.registry === 'ClinicalTrials.gov').slice(0, 5)) {
    const rec = await trialRecord(r.id).catch(e => ({ id: r.id, error: e.message }));
    trials.push(rec);
  }
  const missing = trials.filter(x => x.exists === false);
  if (missing.length) d.sig('registration-not-found', `Trial registration number(s) not found in ClinicalTrials.gov (${missing.length})`, 'high', 5, missing.map(x => ({ text: x.id, link: `https://clinicaltrials.gov/study/${x.id}` })), 'An unknown NCT number is either a typing error or an invented registration.');
  const retro = trials.filter(x => x.exists && x.submitted && x.start && new Date(x.submitted) - new Date(x.start) > 30 * 86400000);
  if (retro.length) d.sig('retrospective', `Trial registered after it started (${retro.length})`, 'medium', 1.5, retro.map(x => ({ text: `${x.id}: started ${x.start}, registered ${x.submitted}`, link: x.url })), 'Retrospective registration is not prospective registration as ICMJE requires; the journal policy decides whether it is acceptable.');
  const other = title ? trials.filter(x => x.exists && x.title && titleSimilarity(title, x.title) < 0.15) : [];
  if (other.length) d.sig('registration-mismatch', 'Registered trial seems to be about a different study', 'medium', 2, other.map(x => ({ text: `${x.id}: “${x.title}”`, link: x.url })), 'Compare the registered intervention, population and outcomes with the manuscript.');

  // Declarations
  const decl = {
    conflicts: has(/\b(conflicts? of interest|competing interests?|declaration of interest|no (?:conflict|competing))/i, t),
    funding: has(/\b(funding|funded by|financial support|grant (?:no|number)|supported by (?:the )?(?:higher education commission|HEC|grant)|no (?:external )?funding)\b/i, t),
    dataAvailability: has(/\b(data availability|data (?:are|is|will be) available|available (?:from|upon|on) (?:the corresponding author|reasonable request)|supplementary (?:data|material))\b/i, t),
    contributions: has(/\b(author(?:s'|'s)? contributions?|CRediT|conceptuali[sz]ation[,:]|contributed equally)\b/i, t),
    aiDisclosure: has(/\b(generative AI|ChatGPT|large language model|AI[- ]assisted (?:tools?|technologies)|use of AI)\b/i, t)
  };
  const absent = [['conflicts', 'Conflict-of-interest statement'], ['funding', 'Funding statement'], ['dataAvailability', 'Data-availability statement'], ['contributions', 'Author contributions']].filter(([k]) => !decl[k]).map(([, l]) => l);
  if (absent.length) d.sig('declarations', `Missing declaration(s): ${absent.join(', ')}`, absent.length >= 3 ? 'medium' : 'low', absent.length >= 3 ? 1.5 : 0.5, absent.map(a => ({ text: a })), 'Required by PJPS and ICMJE / COPE guidance; ask the authors to add them before review.');

  d.details = { studyType: { human, animal, trial, inVitroOnly }, approval, approvalNo, consent, helsinki, animalGuide, registrations, trials, declarations: decl, online };
  d.checked = true;
  return finish(d);
}

module.exports = { analyzeEthics, REGISTRIES };
