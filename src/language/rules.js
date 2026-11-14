// language/rules.js - Module 6 in-house writing rules. Four suggestion areas as editors know them from writing assistants
// (correctness, clarity, engagement, delivery) plus a style area for academic and journal conventions. Each rule returns
// issues with the position in the paragraph, the flagged text and the replacements offered. The writer's goals
// (domain, formality, audience) decide which rules apply: passive voice and "approximately" are normal in a manuscript,
// contractions are not.
const S = require('./spell');
const { sentences, words } = require('./text');

const issue = (rule, category, title, start, end, p, message, replacements = [], extra = {}) =>
  ({ rule, category, title, offset: start, length: end - start, text: p.slice(start, end), message, replacements: replacements.filter(r => r !== p.slice(start, end)), ...extra });

const keepCase = (src, rep) => (rep && /^[A-Z]/.test(src) && /^[a-z]/.test(rep) ? rep[0].toUpperCase() + rep.slice(1) : rep);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Phrase table rule: { phrase: [replacement, ...] } matched as whole words, case-insensitive */
function phraseRule(id, category, title, table, message, { when } = {}) {
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(?:${keys.map(k => esc(k).replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');
  return {
    id, category, when,
    run(p) {
      const out = [];
      for (const m of p.matchAll(re)) {
        const key = m[0].toLowerCase().replace(/\s+/g, ' ');
        const reps = table[key] || [];
        const msg = typeof message === 'function' ? message(m[0], reps) : message;
        out.push(issue(id, category, title, m.index, m.index + m[0].length, p, msg, reps.map(r => keepCase(m[0], r))));
      }
      return out;
    }
  };
}

/** Regex rule: fn(match) -> null or { start?, end?, replacements, message } */
function regexRule(id, category, title, re, fn, { when } = {}) {
  return {
    id, category, when,
    run(p) {
      const out = [];
      for (const m of p.matchAll(re)) {
        const r = fn(m, p);
        if (!r) continue;
        const start = r.start ?? m.index, end = r.end ?? m.index + m[0].length;
        out.push(issue(id, category, r.title || title, start, end, p, r.message, r.replacements || []));
      }
      return out;
    }
  };
}

const formal = g => g.formality !== 'informal' && g.domain !== 'casual';
const notAcademic = g => g.domain !== 'academic';

// ------------------------------------------------------------------ correctness

const AN_LETTERS = /^(?:[aeio]|u(?![nr]i|s[eu]|t[ie]|k|bi|ro|ra|fo)|hour|honest|honou?r|heir)/i;  // "an" words
const ACRONYM_AN = /^[AEFHILMNORSX][A-Z0-9]*\b/;                                                     // an HPLC, an MRI, an FDA
const A_EXCEPT = /^(?:one\b|once\b|eu|ewe|uni(?!n)|unanim|usu|use|user|usa|uti|ure|uro|ubiq|ukr|eucal)/i;

const correctness = [
  regexRule('repeated-word', 'correctness', 'Repeated word', /\b([A-Za-z]+)(\s+)\1\b/gi, (m) => {
    if (/^(?:that|had|is|can|do|bye|very|really|so|no|ha|well)$/i.test(m[1])) return null;
    return { start: m.index + m[1].length, message: `"${m[1]}" is repeated.`, replacements: [''] };
  }),
  regexRule('a-an', 'correctness', 'Article', /\b(a|an|A|An)\s+([A-Za-z][\w-]*)/g, (m) => {
    const art = m[1].toLowerCase(), w = m[2];
    if (/^[A-Z]{2,}/.test(w)) {
      const needAn = ACRONYM_AN.test(w);
      if (needAn && art === 'a') return { end: m.index + m[1].length, message: `Use "an" before "${w}": it is read letter by letter and starts with a vowel sound.`, replacements: [keepCase(m[1], 'an')] };
      if (!needAn && art === 'an') return { end: m.index + m[1].length, message: `Use "a" before "${w}".`, replacements: [keepCase(m[1], 'a')] };
      return null;
    }
    const vowel = AN_LETTERS.test(w) && !A_EXCEPT.test(w);
    if (art === 'a' && vowel) return { end: m.index + m[1].length, message: `Use "an" before a word that starts with a vowel sound ("${w}").`, replacements: [keepCase(m[1], 'an')] };
    if (art === 'an' && !vowel && !/^h/i.test(w)) return { end: m.index + m[1].length, message: `Use "a" before a word that starts with a consonant sound ("${w}").`, replacements: [keepCase(m[1], 'a')] };
    return null;
  }),
  regexRule('lowercase-i', 'correctness', 'Capitalization', /(?<![\w'’.-])i(?=\s|['’](?:m|ve|ll|d)\b)/g, () => ({ message: 'The pronoun "I" is always capitalized.', replacements: ['I'] })),
  regexRule('space-before-punct', 'correctness', 'Punctuation', /(\w)(\s+)([,.;:!?])(?!\d)/g, (m) => {
    const s = m.index + m[1].length;
    return { start: s, end: s + m[2].length + 1, message: 'Remove the space before the punctuation mark.', replacements: [m[3]] };
  }),
  regexRule('space-after-punct', 'correctness', 'Punctuation', /([a-z]{2,})([,;:])([A-Za-z]{2,})/g, (m) => {
    const s = m.index + m[1].length;
    return { start: s, end: s + 1, message: `Add a space after "${m[2]}".`, replacements: [`${m[2]} `] };
  }),
  regexRule('double-space', 'correctness', 'Spacing', /(?<=\S) {2,}(?=\S)/g, () => ({ message: 'Use a single space between words.', replacements: [' '] })),
  regexRule('double-punct', 'correctness', 'Punctuation', /(?<![.])([,;:!?])\1+|(?<=[a-z])\.\.(?!\.)/g, (m) => ({ message: 'Repeated punctuation mark.', replacements: [m[0][0]] })),
  regexRule('could-of', 'correctness', 'Grammar', /\b(could|should|would|must|might|may)\s+of\b/gi, (m) => ({ message: `"${m[1]} of" should be "${m[1]} have".`, replacements: [`${m[1]} have`] })),
  regexRule('then-than', 'correctness', 'Confused words', /\b(more|less|fewer|greater|higher|lower|larger|smaller|better|worse|rather|other|faster|slower|longer|shorter|older|younger|stronger|weaker|earlier|later)\s+(?:\w+\s+)?(then)\b/gi, (m) => {
    const s = m.index + m[0].length - 4;
    return { start: s, end: s + 4, message: 'Use "than" for comparisons; "then" refers to time.', replacements: [keepCase(m[2], 'than')] };
  }),
  regexRule('its-its', 'correctness', 'Confused words', /\b(its)\s+(a|an|the|not|been|important|possible|clear|likely|unlikely|necessary|true|known|thought|believed|evident|essential|worth)\b/gi, (m) => ({ end: m.index + 3, message: '"Its" is possessive; "it\'s" means "it is" or "it has".', replacements: [keepCase(m[1], "it's"), keepCase(m[1], 'it is')] })),
  regexRule('its-possessive', 'correctness', 'Confused words', /\b(?:of|in|on|for|by|with|from|into|about|through|under|over|at|determine|determined|assess|assessed|evaluate|evaluated|reduce|reduced|increase|increased|and)\s+(it['’]s)\s+(?!(?:a|an|the|not|been)\b)[a-z]/gi, (m) => {
    const sp = m[0].search(/\s/), s = m.index + sp + m[0].slice(sp).indexOf(m[1]);
    return { start: s, end: s + m[1].length, message: '"It\'s" means "it is"; the possessive is "its" (no apostrophe).', replacements: ['its'] };
  }),
  regexRule('its-apostrophe', 'correctness', 'Confused words', /\bits['’](?!\w)/gi, () => ({ message: '"Its\'" is not a word. Use "its" (possessive) or "it\'s" (it is).', replacements: ['its'] })),
  regexRule('their-there', 'correctness', 'Confused words', /\b(their|they're)\s+(is|are|was|were|has|have been|will be)\b/gi, (m) => ({ end: m.index + m[1].length, message: 'Use "there" to say something exists ("there is", "there are").', replacements: [keepCase(m[1], 'there')] })),
  regexRule('there-own', 'correctness', 'Confused words', /\b(there|they're)\s+(own|own\w*)\b/gi, (m) => ({ end: m.index + m[1].length, message: 'Use the possessive "their".', replacements: [keepCase(m[1], 'their')] })),
  regexRule('affect-effect', 'correctness', 'Confused words', /\b(?:the|an|any|no|this|that|significant|positive|negative|adverse|side|protective|inhibitory|synergistic|beneficial|toxic|therapeutic)\s+(affects?)\b/gi, (m) => {
    const s = m.index + m[0].length - m[1].length;
    return { start: s, message: '"Effect" is the noun (a result); "affect" is usually the verb.', replacements: [m[1].toLowerCase().endsWith('s') ? 'effects' : 'effect'] };
  }),
  regexRule('loose-lose', 'correctness', 'Confused words', /\b(to|will|may|might|could|would|not)\s+(loose)\b/gi, (m) => ({ start: m.index + m[0].length - 5, message: '"Lose" means to misplace or fail to keep; "loose" means not tight.', replacements: ['lose'] })),
  regexRule('your-youre', 'correctness', 'Confused words', /\b(your)\s+(welcome|right|wrong|going|not|being|able|sure|correct)\b/gi, (m) => ({ end: m.index + 4, message: 'Use "you\'re" (you are).', replacements: [keepCase(m[1], "you're")] })),
  regexRule('subject-verb', 'correctness', 'Subject-verb agreement', /\b(he|she|it|this|that)\s+(have|do|are|were|don't)\b|\b(I|you|we|they)\s+(has|does|is|doesn't)\b|\b(you|we|they)\s+(was)\b/g, (m) => {
    const subj = m[1] || m[3] || m[5], verb = m[2] || m[4] || m[6];
    if (/^(?:this|that)$/i.test(subj) && /^(?:are|were|do|have)$/.test(verb)) return null; // "that are" (relative clause) is fine
    const fix = { have: 'has', do: 'does', are: 'is', were: 'was', "don't": "doesn't", has: 'have', does: 'do', is: /^I$/.test(subj) ? 'am' : 'are', "doesn't": "don't", was: 'were' }[verb];
    const s = m.index + m[0].length - verb.length;
    return { start: s, message: `The verb does not agree with the subject "${subj}".`, replacements: [fix] };
  }),
  regexRule('less-fewer', 'correctness', 'Grammar', /\b(less)\s+(people|patients|participants|subjects|samples|studies|animals|rats|mice|cells|days|years|cases|items|words|errors|steps|tablets|doses|reports|articles|papers|students|children|women|men|questions|options|events|visits|side effects)\b/gi, (m) => ({ end: m.index + 4, message: 'Use "fewer" with things you can count.', replacements: [keepCase(m[1], 'fewer')] })),
  phraseRule('misused-phrases', 'correctness', 'Misused phrase', {
    'alot': ['a lot'], 'infact': ['in fact'], 'aswell': ['as well'], 'eachother': ['each other'], 'incase': ['in case'], 'atleast': ['at least'],
    'irregardless': ['regardless'], 'for all intensive purposes': ['for all intents and purposes'], 'could care less': ["couldn't care less"],
    'one in the same': ['one and the same'], 'nip it in the butt': ['nip it in the bud'], 'should of': ['should have'], 'supposably': ['supposedly'],
    'escape goat': ['scapegoat'], 'case and point': ['case in point'], 'per say': ['per se'], 'by in large': ['by and large'], 'in regards to': ['regarding', 'with regard to'],
    'different than': ['different from'], 'comprised of': ['composed of', 'comprises'], 'based off of': ['based on'], 'based off': ['based on'],
    'try and': ['try to'], 'between you and I': ['between you and me'], 'each are': ['each is'], 'neither are': ['neither is'], 'center around': ['center on'],
    'very unique': ['unique'], 'more optimal': ['better', 'optimal'], 'most optimal': ['optimal'], 'the reason is because': ['the reason is that'],
    'equally as': ['equally', 'as'], 'off of': ['off'], 'whom is': ['who is']
  }, (f, reps) => `"${f}" is non-standard${reps.length ? `; write "${reps[0]}"` : ''}.`)
];

// a sentence-level rule: capital letter at the start, comma after an introductory word, number at the start
const INTRO = /^(However|Therefore|Moreover|Furthermore|Additionally|Consequently|Nevertheless|Nonetheless|Meanwhile|Similarly|Likewise|Thus|Hence|Finally|Firstly|Secondly|Thirdly|Lastly|Overall|Interestingly|Importantly|Notably|Accordingly|Conversely|Alternatively|Subsequently|Indeed|Instead|Otherwise|In addition|In contrast|In conclusion|In summary|In particular|For example|For instance|On the other hand|As a result|In other words|To date|Of note|Taken together|In this study|In the present study)(\s)(?=[a-z]|[A-Z][a-z])/;

function sentenceRules(p, s, g) {
  const out = [];
  const first = s.text.match(/^["“'‘(]*([a-z])/);
  if (first && !/^(?:e\.g|i\.e|et al|pH|mRNA|vs|cf|n\b|p\b|iPhone|eBay)/.test(s.text.slice(first[0].length - 1)) && /[.!?]["”’)]*$/.test(s.text)) {
    const at = s.start + first[0].length - 1;
    out.push(issue('sentence-capital', 'correctness', 'Capitalization', at, at + 1, p, 'Start a sentence with a capital letter.', [first[1].toUpperCase()]));
  }
  const intro = s.text.match(INTRO);
  if (intro) {
    const at = s.start + intro[1].length;
    out.push(issue('intro-comma', 'correctness', 'Missing comma', s.start, at, p, `Add a comma after the introductory "${intro[1]}".`, [`${intro[1]},`]));
  }
  const num = s.text.match(/^(\d+)\s+[a-z]/);
  if (num && g.domain === 'academic') out.push(issue('number-start', 'style', 'Number at sentence start', s.start, s.start + num[1].length, p, 'Spell out a number that starts a sentence, or reword the sentence so it does not start with a number.', []));
  // unbalanced brackets and quotation marks
  const open = (s.text.match(/\(/g) || []).length, close = (s.text.match(/\)/g) || []).length;
  if (open !== close && !/^\s*[a-z0-9ivx]+\)/i.test(s.text)) out.push(issue('brackets', 'correctness', 'Unbalanced brackets', s.start, s.end, p, open > close ? 'A bracket is opened but not closed in this sentence.' : 'A bracket is closed but never opened in this sentence.', [], { whole: true }));
  const dq = (s.text.match(/"/g) || []).length;
  if (dq % 2) out.push(issue('quotes', 'correctness', 'Unbalanced quotation marks', s.start, s.end, p, 'A quotation mark is opened but not closed.', [], { whole: true }));
  // clarity: hard-to-read sentence
  const n = words(s.text).length;
  const limit = g.domain === 'academic' ? 45 : g.audience === 'general' ? 28 : 35;
  if (n > limit) out.push(issue('long-sentence', 'clarity', 'Hard-to-read sentence', s.start, s.end, p, `This sentence has ${n} words. Splitting it into two or more sentences would make it easier to follow.`, [], { whole: true, ai: 'shorten' }));
  // delivery: sentence starts with a conjunction in formal writing
  const conj = s.text.match(/^(And|But|So|Or|Plus|Also)\b,?\s/);
  if (conj && formal(g)) out.push(issue('conjunction-start', 'delivery', 'Informal sentence start', s.start, s.start + conj[1].length, p, `Starting a sentence with "${conj[1]}" reads as informal.`, { And: ['In addition', 'Also,'], But: ['However,'], So: ['Therefore,', 'Thus,'], Or: ['Alternatively,'], Plus: ['In addition,'], Also: ['In addition,'] }[conj[1]]));
  if (/!/.test(s.text) && (g.domain === 'academic' || g.formality === 'formal')) {
    const at = s.start + s.text.indexOf('!');
    out.push(issue('exclamation', 'delivery', 'Exclamation mark', at, at + 1, p, 'Exclamation marks are out of place in formal writing.', ['.']));
  }
  return out;
}

// ------------------------------------------------------------------ clarity

const WORDY = {
  'in order to': ['to'], 'due to the fact that': ['because'], 'owing to the fact that': ['because'], 'in view of the fact that': ['because'], 'on account of the fact that': ['because'],
  'in spite of the fact that': ['although'], 'despite the fact that': ['although'], 'regardless of the fact that': ['although'], 'at this point in time': ['now'], 'at the present time': ['now', 'currently'],
  'at this moment in time': ['now'], 'in the near future': ['soon'], 'a large number of': ['many'], 'a great number of': ['many'], 'a significant number of': ['many'],
  'a small number of': ['a few'], 'a majority of': ['most'], 'the majority of': ['most'], 'has the ability to': ['can'], 'have the ability to': ['can'], 'is able to': ['can'], 'are able to': ['can'],
  'has the capacity to': ['can'], 'it is important to note that': [''], 'it should be noted that': [''], 'it is worth noting that': [''], 'it is interesting to note that': [''],
  'for the purpose of': ['for', 'to'], 'with regard to': ['regarding', 'about'], 'with respect to': ['regarding', 'for'], 'in relation to': ['about', 'regarding'],
  'in the event that': ['if'], 'in the case that': ['if'], 'on the condition that': ['if'], 'prior to': ['before'], 'subsequent to': ['after'], 'in close proximity to': ['near'],
  'on a daily basis': ['daily'], 'on a weekly basis': ['weekly'], 'on a monthly basis': ['monthly'], 'on a regular basis': ['regularly'], 'make a decision': ['decide'],
  'come to a conclusion': ['conclude'], 'conduct an investigation': ['investigate'], 'perform an analysis': ['analyse', 'analyze'], 'carry out an analysis of': ['analyse', 'analyze'],
  'give consideration to': ['consider'], 'take into consideration': ['consider'], 'take into account': ['consider'], 'make an assumption': ['assume'], 'reach a conclusion': ['conclude'],
  'in the absence of': ['without'], 'in a timely manner': ['promptly'], 'in an effort to': ['to'], 'with the exception of': ['except'], 'in excess of': ['more than'],
  'a sufficient amount of': ['enough'], 'an adequate amount of': ['enough'], 'the fact that': ['that'], 'is indicative of': ['indicates'], 'are indicative of': ['indicate'],
  'is dependent upon': ['depends on'], 'is dependent on': ['depends on'], 'serves to': [''], 'in terms of': ['in', 'for'], 'as a means of': ['to'], 'by means of': ['by'],
  'there is no doubt that': ['undoubtedly'], 'in light of': ['because of'], 'until such time as': ['until'], 'at all times': ['always'], 'in many cases': ['often'],
  'each and every': ['each', 'every'], 'first and foremost': ['first'], 'whether or not': ['whether'], 'as to whether': ['whether'], 'during the course of': ['during'],
  'in the process of': ['while'], 'along the lines of': ['like'], 'for the reason that': ['because'], 'a total of': [''], 'it is possible that': ['perhaps', 'possibly'],
  'it is evident that': ['clearly'], 'it is clear that': ['clearly'], 'was found to be': ['was'], 'were found to be': ['were'], 'has been shown to be': ['is'], 'have been shown to be': ['are']
};
const REDUNDANT = {
  'past history': ['history'], 'end result': ['result'], 'final outcome': ['outcome'], 'advance planning': ['planning'], 'plan ahead': ['plan'], 'basic fundamentals': ['fundamentals'],
  'completely eliminate': ['eliminate'], 'completely eliminated': ['eliminated'], 'absolutely essential': ['essential'], 'close proximity': ['proximity'], 'repeat again': ['repeat'],
  'revert back': ['revert'], 'return back': ['return'], 'combine together': ['combine'], 'combined together': ['combined'], 'join together': ['join'], 'mix together': ['mix'], 'mixed together': ['mixed'],
  'few in number': ['few'], 'small in size': ['small'], 'large in size': ['large'], 'period of time': ['period', 'time'], 'exact same': ['same'], 'collaborate together': ['collaborate'],
  'new innovation': ['innovation'], 'unexpected surprise': ['surprise'], 'true fact': ['fact'], 'still remains': ['remains'], 'currently ongoing': ['ongoing'], 'reason why': ['reason'],
  'first began': ['began'], 'over exaggerate': ['exaggerate'], 'various different': ['various', 'different'], 'future plans': ['plans'], 'free gift': ['gift'], 'added bonus': ['bonus'],
  'brief summary': ['summary'], 'consensus of opinion': ['consensus'], 'circle around': ['circle'], 'ATM machine': ['ATM'], 'PIN number': ['PIN'], 'HIV virus': ['HIV'],
  'empty space': ['space'], 'general public': ['public'], 'joint collaboration': ['collaboration'], 'mutual cooperation': ['cooperation'], 'whether or not': ['whether'],
  'both of them': ['both'], 'both together': ['both'], 'separate entities': ['entities'], 'each individual': ['each'], 'compete with each other': ['compete'], 'later on': ['later'],
  'shorter in length': ['shorter'], 'longer in length': ['longer'], 'red in color': ['red'], 'oval in shape': ['oval'], 'sum total': ['total'], 'past experience': ['experience'],
  'estimated at about': ['estimated at'], 'approximately about': ['approximately', 'about'], 'and etc': ['etc.'], 'and so on and so forth': ['and so on']
};
const COMPLEX = {
  utilize: ['use'], utilizes: ['uses'], utilized: ['used'], utilizing: ['using'], utilise: ['use'], utilised: ['used'], utilization: ['use'], utilisation: ['use'],
  facilitate: ['help', 'ease'], commence: ['begin', 'start'], commenced: ['began', 'started'], endeavor: ['try', 'effort'], endeavour: ['try', 'effort'],
  ascertain: ['find out', 'determine'], terminate: ['end'], terminated: ['ended'], subsequently: ['later', 'then'], aforementioned: ['this', 'these'],
  henceforth: ['from now on'], heretofore: ['until now'], notwithstanding: ['despite'], whereby: ['by which'], therein: ['in it'], thereof: ['of it'],
  ameliorate: ['improve'], cognizant: ['aware'], effectuate: ['bring about'], expeditious: ['fast', 'quick'], implement: ['carry out'], modification: ['change'],
  necessitate: ['require'], optimum: ['best'], parameters: ['limits'], preponderance: ['most'], promulgate: ['announce'], remuneration: ['pay'], sufficient: ['enough']
};
// words that are normal and expected in a manuscript: not offered as "simpler" there
const ACADEMIC_OK = new Set(['subsequently', 'implement', 'modification', 'parameters', 'sufficient', 'optimum', 'facilitate', 'whereby', 'utilization', 'utilisation']);

const IRREGULAR = 'been|born|built|bought|brought|caught|chosen|done|drawn|driven|eaten|fallen|felt|found|given|gone|grown|held|hidden|kept|known|laid|led|left|lent|lost|made|meant|met|paid|put|read|run|said|seen|sent|set|shown|shut|sold|spent|split|spoken|spread|stolen|taken|taught|thought|told|undertaken|understood|written|won|withdrawn';
const PASSIVE = new RegExp(`\\b(am|is|are|was|were|be|been|being)\\s+(?:(?:not|also|then|further|significantly|subsequently|previously|already|often|usually|commonly|widely|generally)\\s+)?((?:[a-z]+ed)|(?:${IRREGULAR}))\\b(\\s+by\\b)?`, 'gi');
const NOT_PARTICIPLE = /^(?:need|seed|feed|bed|red|bleed|breed|speed|shed|wed|fled|bred|sacred|tired|interested|concerned|related|based|located|involved|used|supposed|married|excited|bored|scared|worried|pleased|satisfied|surprised|limited|advanced|detailed|experienced|qualified|required|designed|aged|indeed|hundred|kindred|naked|wicked|crooked|beloved|learned|accustomed|exposed|composed|associated|dedicated|committed|devoted|prepared|determined|inclined|equipped|engaged|entitled|obliged)$/i;

const clarity = [
  phraseRule('wordy', 'clarity', 'Wordy phrase', WORDY, (f, reps) => (reps[0] === '' ? `"${f}" adds words without adding meaning; it can usually be removed.` : `"${f}" can be said more briefly: "${reps.filter(Boolean).join('" or "')}".`)),
  phraseRule('redundant', 'clarity', 'Redundancy', REDUNDANT, (f, reps) => `"${f}" says the same thing twice; "${reps[0]}" is enough.`),
  {
    id: 'complex-word', category: 'clarity',
    run(p, g) {
      const out = [];
      for (const { w, start, end } of words(p)) {
        const reps = COMPLEX[w.toLowerCase()];
        if (!reps || (g.domain === 'academic' && ACADEMIC_OK.has(w.toLowerCase()))) continue;
        out.push(issue('complex-word', 'clarity', 'Complex word', start, end, p, `"${w}" is formal or long-winded; a simpler word is clearer.`, reps.map(r => keepCase(w, r))));
      }
      return out;
    }
  },
  regexRule('passive', 'clarity', 'Passive voice', PASSIVE, (m) => {
    if (NOT_PARTICIPLE.test(m[2])) return null;
    return { message: `"${m[0].trim()}" is in the passive voice. The active voice is usually more direct ("the team measured…" rather than "…was measured").`, replacements: [] };
  }, { when: g => notAcademic(g) || g.passive === 'flag' }),
  regexRule('there-is-that', 'clarity', 'Wordy sentence', /\b(There (?:is|are|was|were) (?:a |an |the |many |several |some )?\w+ (?:that|who|which))\b/g, (m) => ({ message: '"There is/are … that" openings add words; start with the subject instead.', replacements: [] })),
  regexRule('nominalization', 'clarity', 'Wordy phrase', /\b(make|makes|made|making|give|gives|gave|giving|perform|performs|performed|carry out|carried out|conduct|conducted)\s+(?:a|an|the)\s+(comparison|assessment|evaluation|measurement|determination|decision|recommendation|investigation|examination|analysis|suggestion|reduction|improvement|contribution|selection)\s+of\b/gi, (m) => {
    const verb = { comparison: 'compare', assessment: 'assess', evaluation: 'evaluate', measurement: 'measure', determination: 'determine', decision: 'decide', recommendation: 'recommend', investigation: 'investigate', examination: 'examine', analysis: 'analyse', suggestion: 'suggest', reduction: 'reduce', improvement: 'improve', contribution: 'contribute', selection: 'select' }[m[2].toLowerCase()];
    return { message: `A verb is more direct than "${m[0]}": "${verb}".`, replacements: [verb] };
  })
];

// ------------------------------------------------------------------ engagement

const WEAK = {
  'very important': ['crucial', 'essential', 'vital'], 'very large': ['huge', 'substantial'], 'very small': ['tiny', 'minute'], 'very good': ['excellent', 'outstanding'],
  'very bad': ['terrible', 'severe'], 'very clear': ['obvious', 'evident'], 'very difficult': ['challenging', 'arduous'], 'very different': ['distinct', 'dissimilar'],
  'very similar': ['nearly identical', 'alike'], 'very high': ['extremely high', 'exceptional'], 'very low': ['minimal', 'negligible'], 'very big': ['enormous', 'massive'],
  'very old': ['ancient', 'aged'], 'very new': ['novel', 'brand-new'], 'very quick': ['rapid', 'swift'], 'very fast': ['rapid', 'swift'], 'very slow': ['sluggish', 'gradual'],
  'very easy': ['effortless', 'straightforward'], 'very hard': ['arduous', 'demanding'], 'very strong': ['powerful', 'robust'], 'very weak': ['feeble', 'faint'],
  'very useful': ['invaluable', 'valuable'], 'very common': ['widespread', 'prevalent'], 'very rare': ['exceptional', 'scarce'], 'very interesting': ['fascinating', 'compelling'],
  'very effective': ['highly effective', 'potent'], 'very necessary': ['essential', 'indispensable'], 'very significant': ['substantial', 'major'], 'very many': ['numerous'],
  'very often': ['frequently'], 'very carefully': ['meticulously'], 'really important': ['crucial', 'essential'], 'really good': ['excellent'], 'quite large': ['sizeable'],
  'quite small': ['modest'], 'pretty good': ['decent', 'solid'], 'a lot of': ['many', 'much', 'considerable'], 'lots of': ['many', 'much'], 'a bit': ['slightly', 'somewhat']
};
const BLAND = { good: ['favourable', 'effective', 'sound'], bad: ['poor', 'adverse', 'harmful'], nice: ['pleasant', 'favourable'], big: ['large', 'major', 'substantial'], thing: ['factor', 'aspect', 'element'], things: ['factors', 'aspects', 'elements'], stuff: ['material', 'items'], got: ['obtained', 'received'], get: ['obtain', 'receive'], gets: ['obtains', 'receives'], };
const FILLER = /\b(basically|actually|literally|totally|really|just|simply|truly|definitely|certainly|obviously|clearly|essentially|virtually)\b/gi;

// Synonyms for words academic writers repeat often
const THESAURUS = {
  significant: ['substantial', 'marked', 'considerable'], significantly: ['markedly', 'substantially', 'considerably'], important: ['key', 'essential', 'major'], increase: ['rise', 'growth', 'gain'],
  increased: ['rose', 'grew', 'elevated'], decrease: ['decline', 'reduction', 'drop'], decreased: ['declined', 'fell', 'reduced'], show: ['demonstrate', 'reveal', 'indicate'],
  showed: ['demonstrated', 'revealed', 'indicated'], shows: ['demonstrates', 'reveals', 'indicates'], use: ['application', 'employ'], used: ['employed', 'applied'], study: ['investigation', 'research', 'work'],
  effect: ['impact', 'influence', 'action'], effects: ['impacts', 'influences', 'actions'], result: ['finding', 'outcome'], results: ['findings', 'outcomes', 'data'], high: ['elevated', 'considerable'],
  different: ['distinct', 'diverse', 'various'], various: ['several', 'diverse', 'numerous'], also: ['additionally', 'likewise'], however: ['nevertheless', 'yet', 'still'],
  good: ['favourable', 'sound', 'effective'], new: ['novel', 'recent'], main: ['principal', 'primary', 'chief'], help: ['assist', 'aid', 'support'], need: ['requirement', 'necessity'],
  potential: ['possible', 'prospective'], activity: ['action', 'effect', 'efficacy'], observed: ['noted', 'seen', 'recorded'], found: ['identified', 'detected', 'observed'],
  role: ['function', 'part'], level: ['concentration', 'amount'], levels: ['concentrations', 'amounts'], method: ['technique', 'procedure', 'approach'], methods: ['techniques', 'procedures', 'approaches'],
  determine: ['establish', 'ascertain', 'assess'], evaluate: ['assess', 'examine', 'appraise'], obtained: ['acquired', 'gained', 'derived'], present: ['current', 'this'], suggest: ['indicate', 'imply'],
  suggests: ['indicates', 'implies'], several: ['various', 'multiple', 'a number of'], large: ['substantial', 'considerable', 'extensive'], small: ['minor', 'limited', 'modest'], very: ['highly', 'extremely']
};
const STOP = new Set('the a an and or of to in on at for with by from as is are was were be been being this that these those it its which who whom whose what when where why how than then there their they them we our us you your he she his her i me my not no nor but if so such can could may might will would shall should must do does did done have has had having into onto over under about after before between during through above below up down out off again further once here both each few more most other some own same too very s t only also all any per vs et al fig figs table'.split(' '));

function engagementDoc(p, g) {
  const out = [];
  // overused word in one paragraph
  const w = words(p);
  const counts = new Map();
  for (const x of w) { const k = x.w.toLowerCase(); if (k.length > 3 && !STOP.has(k) && !/^[A-Z]{2,}/.test(x.w)) counts.set(k, [...(counts.get(k) || []), x]); }
  for (const [k, list] of counts) {
    const syn = THESAURUS[k];
    if (!syn || list.length < 3) continue;
    for (const x of list.slice(2)) out.push(issue('overused', 'engagement', 'Repetitive word', x.start, x.end, p, `"${x.w}" appears ${list.length} times in this paragraph. A synonym would keep the reader engaged.`, syn.map(s => keepCase(x.w, s))));
  }
  // three or more sentences in a row with the same first word
  const sents = sentences(p);
  for (let i = 2; i < sents.length; i++) {
    const f = s => (s.text.match(/^[A-Za-z]+/) || [''])[0].toLowerCase();
    const a = f(sents[i]);
    if (a && a === f(sents[i - 1]) && a === f(sents[i - 2]) && (i < 3 || f(sents[i - 3]) !== a)) {
      const s = sents[i];
      const n = f(s).length;
      out.push(issue('same-start', 'engagement', 'Repetitive sentence start', s.start, s.start + n, p, `Three sentences in a row start with "${s.text.slice(0, n)}". Varying the openings makes the text flow better.`, []));
    }
  }
  return out;
}

const engagement = [
  phraseRule('weak-adjective', 'engagement', 'Weak intensifier', WEAK, (f, reps) => `"${f}" is vague; a more precise word is stronger: "${reps.join('", "')}".`),
  {
    id: 'bland-word', category: 'engagement', when: g => g.formality !== 'informal',
    run(p) {
      const out = [];
      for (const { w, start, end } of words(p)) {
        const reps = BLAND[w.toLowerCase()];
        if (reps && !/\b(?:good|bad) (?:manufacturing|laboratory|clinical) practice/i.test(p.slice(start, end + 30))) out.push(issue('bland-word', 'engagement', 'Bland word', start, end, p, `"${w}" is overused and imprecise. A more specific word is clearer.`, reps.map(r => keepCase(w, r))));
      }
      return out;
    }
  },
  regexRule('filler', 'engagement', 'Unnecessary word', FILLER, (m, p) => {
    if (/^(?:clearly|certainly|simply)$/i.test(m[1]) && /\b(?:defined|stated|visible|written|explained)\b/.test(p.slice(m.index, m.index + 30))) return null;
    // remove the word and one neighbouring space
    const after = p[m.index + m[0].length] === ' ';
    return { end: m.index + m[0].length + (after ? 1 : 0), message: `"${m[1]}" usually adds nothing; the sentence is stronger without it.`, replacements: [''] };
  }, { when: g => g.formality !== 'informal' })
];

// ------------------------------------------------------------------ delivery

const HEDGE = {
  'i think': ['I believe', ''], 'i feel': ['I believe', ''], 'i guess': [''], 'kind of': ['somewhat', ''], 'sort of': ['somewhat', ''], 'i suppose': [''],
  'it seems that': ['apparently'], 'might possibly': ['might'], 'could possibly': ['could'], 'may possibly': ['may'], 'perhaps maybe': ['perhaps'], 'hopefully': ['ideally'],
  'just wanted to': ['want to'], 'i was wondering if': ['could'], 'sorry to bother': [''], 'if that makes sense': [''], 'i\'m no expert': [''], 'in my humble opinion': ['in my view']
};
const CONTRACTIONS = {
  "don't": ['do not'], "doesn't": ['does not'], "didn't": ['did not'], "can't": ['cannot'], "won't": ['will not'], "wouldn't": ['would not'], "couldn't": ['could not'],
  "shouldn't": ['should not'], "isn't": ['is not'], "aren't": ['are not'], "wasn't": ['was not'], "weren't": ['were not'], "hasn't": ['has not'], "haven't": ['have not'],
  "hadn't": ['had not'], "it's": ['it is'], "that's": ['that is'], "there's": ['there is'], "let's": ['let us'], "we're": ['we are'], "they're": ['they are'], "you're": ['you are'],
  "i'm": ['I am'], "we've": ['we have'], "they've": ['they have'], "i've": ['I have'], "we'll": ['we will'], "they'll": ['they will'], "it'll": ['it will'], "what's": ['what is']
};
const INFORMAL = {
  gonna: ['going to'], wanna: ['want to'], gotta: ['have to'], kinda: ['somewhat'], sorta: ['somewhat'], okay: ['acceptable'], ok: ['acceptable'], kids: ['children'],
  awesome: ['excellent', 'impressive'], cool: ['good', 'impressive'], huge: ['substantial', 'major'], tons: ['a great deal'], 'a ton of': ['many'], 'pretty much': ['almost'],
  anyways: ['anyway'], guy: ['person', 'man'], guys: ['people', 'everyone'], stuff: ['material', 'items'], 'figure out': ['determine'], 'find out': ['discover', 'determine'],
  'look into': ['investigate', 'examine'], 'come up with': ['develop', 'devise'], 'get rid of': ['remove', 'eliminate'], 'go up': ['increase', 'rise'], 'went up': ['increased', 'rose'],
  'go down': ['decrease', 'fall'], 'went down': ['decreased', 'fell'], 'set up': ['establish'], 'cut down on': ['reduce'], 'deal with': ['address', 'handle'], 'big deal': ['major issue'],
  'nowadays': ['today', 'currently'], 'super': ['very', 'extremely'], 'totally': ['completely'], 'basically': ['essentially'], 'thing': ['factor', 'aspect']
};
const INCLUSIVE = {
  mankind: ['humankind', 'humanity'], manpower: ['workforce', 'staff'], 'man-made': ['synthetic', 'artificial'], manmade: ['synthetic', 'artificial'], chairman: ['chair', 'chairperson'],
  chairmen: ['chairs'], policeman: ['police officer'], policemen: ['police officers'], fireman: ['firefighter'], firemen: ['firefighters'], businessman: ['businessperson'],
  spokesman: ['spokesperson'], salesman: ['salesperson'], 'cameraman': ['camera operator'], stewardess: ['flight attendant'], 'the elderly': ['older adults', 'older people'],
  'elderly people': ['older adults'], 'elderly patients': ['older patients'], 'wheelchair-bound': ['wheelchair user'], 'confined to a wheelchair': ['uses a wheelchair'],
  handicapped: ['disabled', 'with a disability'], 'mentally retarded': ['with an intellectual disability'], retarded: ['with an intellectual disability'],
  'committed suicide': ['died by suicide'], 'suffers from': ['has', 'lives with'], 'suffering from': ['with', 'living with'], 'suffered from': ['had'],
  'drug addict': ['person with a substance use disorder'], addicts: ['people with substance use disorders'], 'diabetics': ['people with diabetes', 'patients with diabetes'],
  'epileptics': ['people with epilepsy'], 'schizophrenics': ['people with schizophrenia'], 'blacklist': ['blocklist', 'denylist'], 'whitelist': ['allowlist'],
  'blacklisted': ['blocklisted'], 'whitelisted': ['allowlisted'], 'master/slave': ['primary/replica'], 'normal people': ['typical people', 'people without the condition'],
  'third world': ['developing', 'low- and middle-income'], 'third-world': ['developing', 'low- and middle-income'], 'he or she': ['they'], 'his or her': ['their'], 'his/her': ['their'], 'he/she': ['they'],
  'crazy': ['unreasonable', 'surprising'], 'insane': ['extreme', 'unreasonable'], 'lame': ['weak', 'unconvincing']
};

const delivery = [
  phraseRule('hedging', 'delivery', 'Hedging language', HEDGE, (f) => `"${f}" makes you sound unsure. Removing it makes the point more confident.`, { when: g => g.domain !== 'creative' }),
  phraseRule('contraction', 'delivery', 'Contraction', CONTRACTIONS, (f, reps) => `Contractions read as informal; write "${reps[0]}" in formal writing.`, { when: formal }),
  phraseRule('informal', 'delivery', 'Informal language', INFORMAL, (f, reps) => `"${f}" is informal for this kind of writing; "${reps.join('" or "')}" fits better.`, { when: g => g.formality === 'formal' || g.domain === 'academic' || g.domain === 'business' }),
  phraseRule('inclusive', 'delivery', 'Inclusive language', INCLUSIVE, (f, reps) => `"${f}" may exclude or offend some readers. Consider "${reps.join('" or "')}".`),
  regexRule('second-person', 'delivery', 'Second person', /\b(you|your|yours)\b/gi, () => ({ message: 'Academic writing avoids addressing the reader as "you"; use an impersonal form ("one", "the reader") or rephrase.' }), { when: g => g.domain === 'academic' })
];

// ------------------------------------------------------------------ style: academic and journal conventions

const style = [
  regexRule('unit-space', 'style', 'Number and unit', /\b(\d+(?:\.\d+)?)(mg|g|kg|µg|μg|ng|mL|ml|L|µL|μL|mM|µM|μM|nM|mol|mmol|cm|mm|nm|µm|μm|km|h|hr|hrs|min|sec|s|kDa|Da|rpm|°C|K|Hz|kHz|MHz|V|mV|W|kcal|IU)\b(?!\/?\d)/g, (m) => {
    if (/^(?:s|h|K|V|W|L|g)$/.test(m[2]) && /^\d{4}$/.test(m[1])) return null; // years and model numbers
    return { message: 'Put a space between a number and its unit (SI convention).', replacements: [`${m[1]} ${m[2]}`] };
  }, { when: g => g.domain === 'academic' }),
  regexRule('percent-space', 'style', 'Number and unit', /\b(\d+(?:\.\d+)?)\s+%/g, (m) => ({ message: 'No space between a number and the percent sign.', replacements: [`${m[1]}%`] }), { when: g => g.domain === 'academic' }),
  regexRule('et-al', 'style', 'Citation style', /\bet\s+al(?![.\w])/g, () => ({ message: '"et al." is an abbreviation and takes a full stop.', replacements: ['et al.'] })),
  regexRule('eg-ie', 'style', 'Abbreviation', /\b(e\.g|i\.e|eg|ie)(?![.\w])\.?(?!,)/g, (m) => {
    const base = m[1].replace(/\./g, '').toLowerCase() === 'eg' ? 'e.g.' : 'i.e.';
    if (m[0] === base || m[0] === `${base},`) return null;
    return { message: `Write "${base}," (with full stops, followed by a comma).`, replacements: [`${base},`] };
  }),
  regexRule('data-plural', 'style', 'Academic convention', /\b(data)\s+(is|was|has|shows|suggests|indicates|demonstrates|reveals|supports|confirms)\b/gi, (m) => {
    const fix = { is: 'are', was: 'were', has: 'have', shows: 'show', suggests: 'suggest', indicates: 'indicate', demonstrates: 'demonstrate', reveals: 'reveal', supports: 'support', confirms: 'confirm' }[m[2].toLowerCase()];
    return { start: m.index + m[1].length + 1, end: m.index + m[0].length, message: 'In scientific writing "data" is plural ("the data show", "the data were").', replacements: [fix] };
  }, { when: g => g.domain === 'academic' }),
  regexRule('p-value', 'style', 'Statistics', /\b([Pp])\s*([<>=≤≥])\s*(0?\.\d+)/g, (m) => {
    const want = `${m[1]} ${m[2]} ${m[3].startsWith('.') ? '0' + m[3] : m[3]}`;
    return m[0] === want ? null : { message: 'Write P values with spaces around the sign and a leading zero, e.g. "P < 0.05".', replacements: [want] };
  }, { when: g => g.domain === 'academic' })
];

const ALL = [...correctness, ...clarity, ...engagement, ...delivery, ...style];

/** Spelling issues of one paragraph */
function spelling(p, opts) {
  const out = [];
  const sents = sentences(p);
  const startOf = new Set(sents.map(s => s.start));
  const list = words(p);
  for (const [k, x] of list.entries()) {
    // the species name of a Latin binomial after its genus ("Moringa oleifera", "E. coli"): not English
    const prev = list[k - 1];
    if (prev && /^[a-z]+$/.test(x.w) && /^[A-Z][a-z]*$/.test(prev.w) && /^\s*\.?\s+$/.test(p.slice(prev.end, x.start)) && /(?:a|ae|um|us|is|ii|i|ensis|oides|ata|ica|ina|ans|ens|ix|ex|on)$/.test(x.w)) continue;
    // after an opening bracket or quote the word still starts the sentence
    let i = x.start - 1;
    while (i >= 0 && /["“'‘([\s]/.test(p[i]) && !startOf.has(i + 1)) i--;
    const midSentence = !startOf.has(x.start) && i >= 0 && !/[.!?:]/.test(p[i]);
    const repeated = (opts.docWords?.get(x.w.toLowerCase()) || 0) >= 3;
    if (S.check(x.w, { variant: opts.variant, personal: opts.personal, ctx: { midSentence, repeated } })) continue;
    const variantWord = S.otherVariant(x.w, opts.variant);
    const reps = S.suggest(x.w, opts.variant);
    if (variantWord) {
      out.push(issue('variant-spelling', 'correctness', opts.variant === 'en-GB' ? 'US spelling' : 'British spelling', x.start, x.end, p,
        `"${x.w}" is the ${opts.variant === 'en-GB' ? 'American' : 'British'} spelling. This document is set to ${opts.variant === 'en-GB' ? 'British' : 'American'} English.`, reps, { spelling: true }));
    } else {
      out.push(issue('spelling', 'correctness', 'Spelling', x.start, x.end, p, reps.length ? `"${x.w}" may be misspelled. Did you mean "${reps[0]}"?` : `"${x.w}" is not in the dictionary.`, reps, { spelling: true }));
    }
  }
  return out;
}

/** All in-house issues of one paragraph. goals: { domain, formality, audience, intent, passive }; opts: { variant, personal, docWords, disabled } */
function checkParagraph(p, goals = {}, opts = {}) {
  const g = { domain: 'academic', formality: 'formal', audience: 'expert', intent: 'inform', ...goals };
  const disabled = new Set(opts.disabled || []);
  const out = [];
  if (!disabled.has('spelling')) out.push(...spelling(p, opts));
  for (const r of ALL) {
    if (disabled.has(r.id) || (r.when && !r.when(g))) continue;
    out.push(...r.run(p, g));
  }
  for (const s of sentences(p)) out.push(...sentenceRules(p, s, g).filter(i => !disabled.has(i.rule)));
  if (!disabled.has('overused')) out.push(...engagementDoc(p, g));
  return out;
}

module.exports = { checkParagraph, THESAURUS, keepCase };
