// papermill/assessment.js - the editor's summary of a Module 4 report, written the way publishers' research-integrity
// teams summarise a paper-mill screening:
//   - convergence: in how many independent areas of evidence (text, references, authors & submission, data & figures)
//     moderate or strong signals were found. Paper-mill products usually show signals in several areas at once; one
//     area alone more often has an innocent explanation (language editing, a careless reference list).
//   - completeness: how many of the checks could be run, and which could not (and why)
//   - a short written assessment, the recommended next step for the risk level (following COPE's guidance on systematic
//     manipulation of the publication process), a checklist of what the editor should verify, and the points to put to
//     the authors - phrased neutrally, without any mention of paper mills - for the query letter.
// Pure function of the report (signals, overview), so it can also be made for reports saved before it existed.

const AREAS = [
  ['text', 'Manuscript text'],
  ['references', 'References'],
  ['authors', 'Authors & submission'],
  ['data', 'Data & figures']
];

// signal code -> [what the editor verifies, what the authors are asked (null: nothing to ask)]
const ACTIONS = {
  tortured: ['Read the passages with tortured phrases: they are typical of text disguised by paraphrasing software.', 'Please explain the unusual wording in the passages listed and state how the manuscript was written and edited, including any paraphrasing, translation or AI tools used.'],
  scigen: ['Read the passages flagged as computer-generated text.', null],
  suspect: ['Check the suspect expressions in context.', null],
  'ai-leftover': ['Check the leftovers of AI tools in the text (prompts, "as an AI language model", "regenerate response").', 'Please state whether generative AI tools were used in preparing the manuscript, and for which parts, as required by the journal policy.'],
  template: ['Compare the template wording with the rest of the manuscript.', null],
  'ai-writing': ['Treat the AI-writing indicator as a weak hint only; it does not prove AI use.', null],
  methods: ['Check whether the methods could be repeated from what is written.', 'Please give the missing methodological details: sources and catalogue numbers of materials, equipment, and the ethics approval number and committee.'],
  'hidden-text': ['Open the file and inspect the hidden or look-alike characters: they are used to defeat similarity software.', 'Please submit a clean version of the manuscript file without hidden text or substituted characters.'],
  fabricated: ['Look up the references that were not found in any database.', 'Please provide the DOI or a working link for each reference listed, or correct or remove references that cannot be traced.'],
  retracted: ['Check why the retracted papers are cited.', 'Please explain why retracted papers are cited, or replace them, and state whether any conclusion depends on them.'],
  'mill-retraction': ['Note that references to papers retracted for paper-mill reasons are themselves a common pattern in mill products.', 'Please explain why retracted papers are cited, or replace them.'],
  'flagged-refs': ['Check the references flagged in published integrity audits.', null],
  'mill-journals': ['Review the references to journals with many paper-mill retractions.', null],
  predatory: ['Review the references to predatory journals.', null],
  blacklisted: ['Review the references to journals on the HEC / institutional blacklist.', 'Please replace or justify the references to the journals listed, which are on the blacklist this journal follows.'],
  'hijacked-clone': ['Check the references to hijacked (cloned) journal websites.', 'Please verify the journals of the references listed: several point to hijacked journal websites.'],
  citejacked: ['Check the references to citejacked journals.', null],
  'scopus-discontinued': ['Review the references to journals discontinued from Scopus.', null],
  stacking: ['Look at the citation stacking: many references to one journal or author group can point to a citation cartel.', 'Please justify the citations to the journal or authors cited unusually often.'],
  'author-retraction': ['Read the earlier retraction notices of the authors (Retraction Watch).', null],
  'author-mill-retraction': ['Read the authors’ earlier paper-mill retractions: a strong signal.', null],
  'author-retraction-name': ['Confirm that the retracted author with the same name is the same person.', null],
  'orcid-retraction': ['Read the retractions in the authors’ ORCID records.', null],
  'orcid-mill-retraction': ['Read the paper-mill retractions in the authors’ ORCID records: a strong signal.', null],
  'orcid-invalid': ['Check the ORCID iDs that are not valid.', 'Please provide a valid ORCID iD for every author.'],
  'orcid-empty': ['Check the empty ORCID records (created recently, no works).', null],
  'no-orcid': ['Note that no author gave an ORCID iD.', 'Please provide an ORCID iD for every author.'],
  'free-mail': ['Check the free-mail addresses of the authors.', 'Please provide an institutional e-mail address for the corresponding author and every co-author.'],
  'disposable-mail': ['Check the disposable (throw-away) e-mail addresses: a strong signal.', 'Please provide an institutional e-mail address for every author.'],
  affiliation: ['Check that the affiliations fit the subject of the work.', 'Please confirm each author’s affiliation and their contribution to the work (CRediT statement).'],
  'institutions-far': ['Check how the authors from distant institutions worked together.', 'Please describe how the authors collaborated and each author’s contribution (CRediT statement).'],
  'authorship-change': ['Compare the author lists of the versions.', 'Please explain the change of authors and send the journal’s authorship-change form signed by all authors, including those added or removed.'],
  reviewers: ['Do not invite the flagged suggested reviewers; choose independent reviewers.', null],
  watchlist: ['Compare with the earlier case recorded on the editorial watchlist.', null],
  statistics: ['Recalculate the inconsistent statistics listed.', 'Please send the raw data and the analysis files for the results listed, and correct the inconsistent values.'],
  'statistics-minor': ['Check the minor inconsistencies in the statistics.', null],
  primers: ['Check the primer sequences with NCBI BLAST.', 'Please confirm the primer sequences and their target genes, with the reference for each.'],
  'primer-gene': ['Check the primers that do not match their gene: a strong signal of fabricated data.', 'Please confirm the primer sequences and their target genes, with the reference for each.'],
  'cell-lines': ['Check the misidentified cell lines (ICLAC).', 'Please state the source of each cell line and its authentication (STR profile, date of testing).'],
  'cellosaurus-problematic': ['Check the problematic cell lines (Cellosaurus).', 'Please state the source of each cell line and its authentication (STR profile, date of testing).'],
  'cellosaurus-misclassified': ['Check the misclassified cell lines (Cellosaurus).', 'Please state the source of each cell line and its authentication (STR profile, date of testing).'],
  'cellosaurus-unknown': ['Check the cell-line names not known to Cellosaurus.', 'Please give the full name and source of each cell line.'],
  'mirna-species': ['Check the microRNAs that do not exist in the species studied (miRBase).', 'Please confirm the microRNA names and the species in which they were measured.'],
  'mirna-unknown': ['Check the microRNA names not in miRBase.', null],
  duplicate: ['Compare with the earlier PJPS submission: a strong signal of a resubmitted or duplicated manuscript.', 'Please explain the relation of this manuscript to the earlier submission listed.'],
  'duplicate-partial': ['Compare the overlapping text with the earlier PJPS submission.', 'Please explain the overlap with the earlier submission listed.'],
  published: ['Compare with the paper with the same title already published or posted.', 'Please explain the relation of this manuscript to the published work listed.'],
  images: ['Review the Module 5 image findings.', 'Please send the original, uncropped and unprocessed image files (including full blots and micrographs) for the figures listed.']
};

/** The assessment of a Module 4 report: { convergence, completeness, statement, action, verify, ask } */
function assess(r) {
  const signals = r.signals || [];
  const level = r.risk?.level || 'LOW';
  const counted = signals.filter(s => s.severity === 'high' || s.severity === 'medium');
  const areas = AREAS.map(([g, label]) => {
    const list = signals.filter(s => s.group === g);
    const strong = list.filter(s => s.severity === 'high').length, moderate = list.filter(s => s.severity === 'medium').length;
    return { area: g, label, strong, moderate, weak: list.length - strong - moderate, weight: list.reduce((a, s) => a + (s.weight || 0), 0), flagged: strong + moderate > 0 };
  });
  const flagged = areas.filter(a => a.flagged);
  const overview = r.overview || [];
  const notRun = overview.filter(o => o.light === 'grey');
  const run = overview.length - notRun.length;
  const share = overview.length ? run / overview.length : 1;
  const completeness = { run, total: overview.length, level: share >= 0.75 ? 'good' : share >= 0.5 ? 'partial' : 'limited', notRun: notRun.map(o => ({ check: o.check, why: o.result })) };

  // the written assessment
  const top = counted.slice().sort((a, b) => b.weight - a.weight).slice(0, 3).map(s => s.title);
  const parts = [];
  if (!counted.length) {
    parts.push(`No strong or moderate paper-mill indicator was found in the ${run} check(s) that could be run.`);
    const weak = signals.length;
    if (weak) parts.push(`${weak} weak signal(s) were noted; on their own they are common in ordinary manuscripts.`);
  } else {
    const strong = counted.filter(s => s.severity === 'high').length;
    parts.push(`The screening found ${strong ? `${strong} strong and ` : ''}${counted.length - strong} moderate indicator(s) in ${flagged.length} of ${AREAS.length} independent areas of evidence (${flagged.map(a => a.label.toLowerCase()).join(', ')}).`);
    parts.push(`The most important: ${top.join('; ')}.`);
    parts.push(flagged.length >= 2
      ? 'Indicators in several independent areas are the pattern typical of paper-mill manuscripts and are unlikely to share one innocent explanation.'
      : 'The indicators are confined to one area, where an innocent explanation (such as language editing or a careless reference list) is possible and should be asked for.');
  }
  if (completeness.level !== 'good') parts.push(`${notRun.length} of ${overview.length} checks could not be run (${notRun.slice(0, 4).map(o => o.check.split(' (')[0]).join('; ')}${notRun.length > 4 ? '; …' : ''}), so the assessment is ${completeness.level === 'limited' ? 'limited' : 'partial'}.`);

  const action = level === 'HIGH'
    ? { tone: 'bad', title: 'Hold the manuscript and escalate', text: 'Do not send the manuscript to reviewers. Refer it to the editor-in-chief or the research-integrity lead with this report. Following COPE’s guidance on systematic manipulation of the publication process: keep the evidence, ask the authors for an explanation and their raw data (query letter below, which does not mention paper mills), and contact the authors’ institution if the answer is not satisfactory. Record the decision below.' }
    : level === 'MEDIUM'
      ? { tone: 'warn', title: 'Clarify before peer review', text: `Ask the authors about the points below before the manuscript goes to reviewers${flagged.length >= 2 ? ', and inform the editor-in-chief, since the signals come from more than one area' : ''}. Continue only when the answers and the files sent resolve them.` }
      : { tone: 'good', title: 'Continue the usual editorial process', text: counted.length || signals.length ? 'No integrity query is needed on this evidence. The weak signals below can be kept in mind during review.' : 'No integrity query is needed on this evidence.' };

  // checklist: one line per signal type found, strongest first; author requests without duplicates
  const order = signals.slice().sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] - { high: 0, medium: 1, low: 2 }[b.severity]) || b.weight - a.weight);
  const verify = [], ask = [], seenCode = new Set(), seenAsk = new Set();
  for (const s of order) {
    if (seenCode.has(s.code)) continue;
    seenCode.add(s.code);
    const [v, q] = ACTIONS[s.code] || [`Check: ${s.title}`, null];
    verify.push({ text: v, severity: s.severity, signal: s.title });
    // questions to the authors only for signals that matter at this level (weak ones only in a HIGH case)
    if (q && !seenAsk.has(q) && (s.severity !== 'low' || level === 'HIGH')) { seenAsk.add(q); ask.push(q); }
  }
  return { convergence: { areas, flagged: flagged.length, of: AREAS.length }, completeness, statement: parts.join(' '), action, verify, ask };
}

/** A neutral query letter to the authors from the points to ask (never mentions paper mills or this screening) */
function queryLetter(r, a = assess(r)) {
  if (!a.ask.length) return '';
  const m = r.meta || {};
  const journal = require('../config').HOME_JOURNAL.name;
  return [
    'Dear Corresponding Author,',
    '',
    `Re: ${m.manuscriptCode ? `${m.manuscriptCode} - ` : ''}${m.title || 'your manuscript'}`,
    '',
    `Thank you for submitting your manuscript to the ${journal}. As part of our standard editorial checks, we would be grateful if you could address the following points before the manuscript can proceed:`,
    '',
    ...a.ask.map((q, i) => `${i + 1}. ${q}`),
    '',
    'Please send your reply and the requested files within 14 days. If we do not hear from you within this time, we will assume that you have withdrawn the manuscript.',
    '',
    'Yours sincerely,',
    '',
    'Editorial Office',
    journal
  ].join('\n');
}

module.exports = { assess, queryLetter, AREAS, ACTIONS };
