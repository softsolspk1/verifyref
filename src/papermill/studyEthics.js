// papermill/studyEthics.js - what kind of study a manuscript reports and whether its ethics approval carries a number.
// Shared by the Module 4 methods check (papermill/index.js) and the research-ethics dimension (integrity/ethics.js).
// A study counts as an animal / human study only when the paper did the work (animals housed, divided, treated; patients
// enrolled, consent obtained) - a mention of "rats" in the introduction or discussion does not make it one.

// laboratory strains and stocks
const STRAIN = /\b(Wistar|Sprague[- ]?Dawley|Long[- ]Evans|albino (?:rats?|mice|wistar)|Swiss (?:albino|Webster)|BALB\/c|C57BL\/?6\w*|Kunming mice|ICR mice|CD-?1 mice|NMRI mice|nude mice|New Zealand (?:white )?rabbits?|Dunkin[- ]Hartley|Golden Syrian hamsters?)\b/i;
const SPECIES = '(?:rats?|mice|mouse|rabbits?|guinea pigs?|hamsters?|animals?|dogs?|zebrafish|chicks?|broilers?)';
// "the rats were housed / divided / treated ...", "animals were randomly allocated ..."
const ANIMAL_WORK = new RegExp(`\\b${SPECIES}\\s+(?:\\w+\\s+){0,2}(?:were|was)\\s+(?:\\w+\\s+)?(?:housed|kept|maintained|acclimati[sz]ed|divided|randomi[sz]ed|randomly|allocated|assigned|grouped|treated|administered|given|dosed|fed|fasted|injected|gavaged|anaesthetized|anesthetized|sacrificed|euthanized|euthanised|killed|decapitated|weighed|obtained|purchased|procured|bred|used|exposed|immunized|induced|subjected)\\b`, 'i');
// "30 male rats", "48 Wistar rats (180-220 g)", "six rats per group", "rats (n = 6)"
const ANIMAL_COUNT = new RegExp(`\\b(?:\\d+|six|eight|ten|twelve|fifteen|twenty|thirty|forty|fifty)\\s+(?:adult\\s+|healthy\\s+)?(?:male\\s+|female\\s+)?(?:\\w+\\s+)?${SPECIES}\\b|\\b${SPECIES}\\s*\\(\\s*n\\s*=\\s*\\d+|\\b${SPECIES}\\s+(?:per|in each|/)\\s*group\\b|\\b\\d+\\s*[-–]\\s*\\d+\\s*g\\b[^.]{0,40}\\b${SPECIES}|\\b${SPECIES}\\b[^.]{0,40}\\(\\s*\\d+\\s*[-–]\\s*\\d+\\s*g\\s*\\)`, 'i');
const HUMAN_WORK = /\b(patients?|participants?|volunteers?|subjects?|respondents?|students?|individuals?|women|men|children|adults)\s+(?:\w+\s+){0,2}(?:were|was)\s+(?:\w+\s+)?(?:recruited|enrolled|included|selected|interviewed|surveyed|randomi[sz]ed|allocated|assigned|screened|invited|approached|followed|treated|administered|given|asked|sampled)\b|\b(informed consent|written consent|consent (?:was|were) (?:obtained|taken|signed)|questionnaire was (?:distributed|administered|filled)|cross-sectional (?:study|survey)|clinical trial|randomi[sz]ed controlled trial|blood samples? (?:were|was) (?:collected|drawn|taken) from)\b/i;

/** { animal, human } - only when the manuscript itself reports the work */
function studyType(text) {
  const t = String(text || '');
  return { animal: STRAIN.test(t) || ANIMAL_WORK.test(t) || ANIMAL_COUNT.test(t), human: HUMAN_WORK.test(t) };
}

// ethics approval statements
const APPROVAL = /\b(ethic(?:s|al)?\s+(?:review\s+)?(?:committees?|boards?|approvals?|clearance|permission|commissions?)|institutional review boards?|\bIRB\b|\bIACUC\b|animal (?:care|ethics|welfare|experimentation)(?:\s+and use)?\s+committees?|\b(?:ERC|IREB|IEC|REC|AEC|BEC|IAEC|IBC|ASRB|ADVSR|BASR)\b|bioethic(?:s|al) committee|research ethics|approved by the\b[^.]{0,80}\bcommittee)\b/i;
// an identifier: "No. 123", "Ref # KU/ERC/22", "Approval ID: 2021-34", "AEC/2021/45", "IRB-00123", "(12/2021)", "vide letter No."
const IDENTIFIER = [
  // after a keyword: any code with a digit in it ("No. SKZ-X200325LS", "Ref. No. KU/ERC/22", "ID: 2021-34")
  /\b(?:no|nos|number|num|ref(?:erence)?|id|code|protocol|letter|permit|approval|registration|reg|file|certificate|dated?|vide)\.?\s*(?:no\.?|number|#|id|code)?\s*(?:(?:is|was|are|were)\s+)?[:.#-]?\s*\(?\s*(?=[\w/.-]*\d)[A-Za-z0-9][\w/.-]{1,}/i,
  /#\s*\d[\w/.-]*/,
  /\b[A-Z][A-Za-z&.]{1,14}(?:[-/][A-Za-z0-9&.]+)*[-/]\s?\d[\w/.-]*/,       // AEC/2021/45, IRB-00123, KU/ERC/22-10
  /\b\d{1,6}\s*[-/]\s*[A-Za-z0-9]{1,8}(?:\s*[-/]\s*[A-Za-z0-9]{1,8})+\b/,  // 123/ERC/2022, 2021-34-01
  /\b[A-Z]{2,}\d{2,}[\w-]*/,                                              // PJPS2021045, IACUC2021034
  /\(\s*[A-Za-z]{0,6}[-\s]?\d{4,}[A-Za-z0-9/.-]*\s*\)/                    // (2018041A), (No 20210311): a code in brackets
];

/**
 * Ethics approval and its number: { approval: { found, index } | null, number: string | null }. The number is looked for
 * in the sentence that states the approval and the sentence after it (and in any other sentence that names the committee).
 */
// no approval needed: public databases, retrospective anonymised data, an exemption or waiver stated by the authors
const EXEMPT = /\b(?:did not|does not|do not|no|not)\s+(?:require|need)[^.]{0,50}\b(?:ethic|approval|consent)|\b(?:ethic\w*\s+)?approval[^.]{0,40}\b(?:not required|not needed|not applicable|was waived|were waived|exempt)|\bexempt(?:ed)?\s+from[^.]{0,40}\b(?:ethic|review|approval)|\bwaived\b[^.]{0,40}\b(?:ethic|review|consent)/i;

function approvalNumber(text) {
  const t = String(text || '');
  if (EXEMPT.test(t)) return { approval: { found: 'not required', sentence: (t.match(EXEMPT) || [''])[0] }, number: 'not required', exempt: true };
  // sentences; "No.", "Ref.", "e.g." and "et al." do not end one
  const sentences = t.split(/(?<!\b(?:No|no|Nos|Ref|ref|Fig|vs|al|approx|e\.g|i\.e|Dr|Prof|Univ|Dept))(?<=[.;])\s+(?=[A-Z(])|\n+/);
  let approval = null, number = null;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const m = s.match(APPROVAL);
    if (!m) continue;
    if (!approval) approval = { found: m[0], sentence: s.trim().slice(0, 300) };
    const near = `${s} ${sentences[i + 1] || ''}`.replace(/\b(?:19|20)\d{2}\b(?![-/]\s*\d)/g, ' ');   // a bare year is not a number
    for (const re of IDENTIFIER) {
      const id = near.match(re);
      if (id && /\d/.test(id[0]) && !/^(?:p|n|ph)\s*[=<>]/i.test(id[0])) { number = id[0].trim().slice(0, 60); break; }
    }
    if (number) break;
  }
  return { approval, number };
}

// doses: 50 mg/kg, 50 mg kg-1, 50 mg·kg−1, 0.5 mL/100 g, 200 mg/kg b.w., 10 IU per kg, 2 g/kg/day
const DOSE = /\d\s*(?:mg|µg|μg|ug|g|ng|ml|mL|µl|μl|IU|U|mmol|µmol|μmol|nmol|mEq)\s*(?:\/|per|·|∙|\.)?\s*(?:kg|100\s*g|g\s*(?:b\.?\s*w\.?|body))\b|\d\s*(?:mg|µg|μg|ug|g|ng|ml|mL)\s*[·∙.]?\s*kg\s*(?:-|−|–|\^\s*-?)\s*1\b|\d\s*(?:mg|µg|μg|g|ml|mL)\s*\/\s*kg/i;
const hasDose = text => DOSE.test(String(text || ''));

module.exports = { studyType, approvalNumber, hasDose, APPROVAL };
