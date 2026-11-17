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
    if (/^[A-Z]/.test(m[1]) && /^[A-Z]/.test(m[0].slice(m[1].length + m[2].length))) return null; // a name: Chu Chu, Li Li
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
  regexRule('subject-verb', 'correctness', 'Subject-verb agreement', /\b(he|she|it|this|that)\s+(have|do|are|were|don't)\b|\b(I|you|we|they)\s+(has|does|is|doesn't)\b|\b(you|we|they)\s+(was)\b/g, (m, p) => {
    const subj = m[1] || m[3] || m[5], verb = m[2] || m[4] || m[6];
    if (/^(?:this|that)$/i.test(subj) && /^(?:are|were|do|have)$/.test(verb)) return null; // "that are" (relative clause) is fine
    // "as it were" is an idiom; "compound I is", "Table I is" use a Roman numeral
    if (/^it$/i.test(subj) && verb === 'were' && /\bas\s+$/i.test(p.slice(Math.max(0, m.index - 4), m.index))) return null;
    if (subj === 'I' && /[A-Za-z0-9)]\s+$/.test(p.slice(Math.max(0, m.index - 3), m.index)) && !/\b(?:and|but|so|then|that|because|when|if|as|which|where|while|than)\s+$/i.test(p.slice(Math.max(0, m.index - 10), m.index))) return null;
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
// "After 12 weeks the ..." / "At 6 months participants ...": a time phrase that opens the sentence, before its subject
const TIME_INTRO = /^((?:After|At|Within|Following|Over|By)\s+(?:the end of\s+)?(?:\d+|one|two|three|four|five|six|eight|ten|twelve)\s+(?:weeks?|days?|months?|years?|hours?|minutes?)(?:\s+of\s+[a-z-]+)?)\s+(?=(?:the|a|an|we|all|participants|patients|it|this|these|there|both|no|mice|rats|animals|subjects|children|women|most)\b)/;
const INTRO = /^(However|Therefore|Moreover|Furthermore|Additionally|Consequently|Nevertheless|Nonetheless|Meanwhile|Similarly|Likewise|Thus|Hence|Finally|Firstly|Secondly|Thirdly|Lastly|Overall|Interestingly|Importantly|Notably|Accordingly|Conversely|Alternatively|Subsequently|Indeed|Instead|Otherwise|In addition|In contrast|In conclusion|In summary|In particular|For example|For instance|On the other hand|As a result|In other words|To date|Of note|Taken together|In this study|In the present study)(\s)(?=[a-z]|[A-Z][a-z])/;

function sentenceRules(p, s, g) {
  const out = [];
  const first = s.text.match(/^["“'‘(]*([a-z])/);
  // not a new sentence after an abbreviation with a full stop (s.c.) for 3 days, etc.) were, Cat. No.), nor the
  // "where ..." that explains the symbols of an equation
  const before = p.slice(Math.max(0, s.start - 12), s.start);
  if (first && !/^(?:e\.g|i\.e|et al|pH|mRNA|vs|cf|n\b|p\b|iPhone|eBay|where\b|wherein\b)/.test(s.text.slice(first[0].length - 1)) && /[.!?]["”’)]*$/.test(s.text) &&
      !/\b(?:s\.c|i\.p|i\.v|i\.m|p\.o|b\.i\.d|t\.i\.d|q\.d|etc|approx|ca|cat|no|nos|vs|fig|figs|ref|vol|eq|sp|spp|var|ed|eds|al|e\.g|i\.e)\.\)?,?\s*$/i.test(before)) {
    const at = s.start + first[0].length - 1;
    out.push(issue('sentence-capital', 'correctness', 'Capitalization', at, at + 1, p, 'Start a sentence with a capital letter.', [first[1].toUpperCase()]));
  }
  const intro = s.text.match(INTRO);
  // "In addition to X, ..." and "Instead of" are prepositions, and "Overall response rate" / "Overall survival" use
  // "overall" as an adjective: a comma only where the word opens a clause ("Overall, the results ...")
  const after = intro ? s.text.slice(intro[0].length) : '';
  if (intro && !(/^(?:In addition|Instead)$/.test(intro[1]) && /^(?:to|of)\b/.test(after)) && !/^(?:aimed|aims|was|were|is|are|has|have|had|showed|shows|found|investigated|evaluated|examined)\b/.test(after) &&
      !(intro[1] === 'Overall' && !/^(?:the|this|these|those|our|we|it|there|they|all|both|most|such|a|an)\b/i.test(after)) &&
      /[.!?]["”’)]*$/.test(s.text)) {
    const at = s.start + intro[1].length;
    out.push(issue('intro-comma', 'correctness', 'Missing comma', s.start, at, p, `Add a comma after the introductory "${intro[1]}".`, [`${intro[1]},`]));
  }
  // an opening time phrase before the subject: "After 12 weeks the scores rose" -> "After 12 weeks, the" (Grammarly
  // comparison on document 7; 34 of 38 such sentences in published PJPS articles have the comma)
  const time = s.text.match(TIME_INTRO);
  if (time) out.push(issue('intro-comma', 'correctness', 'Missing comma', s.start, s.start + time[1].length, p, `Add a comma after the introductory "${time[1]}".`, [`${time[1]},`]));
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
const ACADEMIC_OK = new Set(['ameliorate', 'ascertain', 'subsequently', 'implement', 'modification', 'parameters', 'sufficient', 'optimum', 'facilitate', 'whereby', 'utilization', 'utilisation']);

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
const BLAND = { good: ['effective', 'sound', 'positive'], bad: ['poor', 'adverse', 'harmful'], nice: ['pleasant', 'positive'], big: ['large', 'major', 'substantial'], thing: ['factor', 'aspect', 'element'], things: ['factors', 'aspects', 'elements'], stuff: ['material', 'items'], got: ['obtained', 'received'], get: ['obtain', 'receive'], gets: ['obtains', 'receives'], };
const FILLER = /\b(basically|actually|literally|totally|really|just|simply|truly|definitely|certainly|obviously|clearly|essentially|virtually)\b/gi;

// Synonyms for words academic writers repeat often
const THESAURUS = {
  significant: ['substantial', 'marked', 'considerable'], significantly: ['markedly', 'substantially', 'considerably'], important: ['key', 'essential', 'major'], increase: ['rise', 'growth', 'gain'],
  increased: ['rose', 'grew', 'elevated'], decrease: ['decline', 'reduction', 'drop'], decreased: ['declined', 'fell', 'reduced'], show: ['demonstrate', 'reveal', 'indicate'],
  showed: ['demonstrated', 'revealed', 'indicated'], shows: ['demonstrates', 'reveals', 'indicates'], use: ['application', 'employ'], used: ['employed', 'applied'], study: ['investigation', 'research', 'work'],
  effect: ['impact', 'influence', 'action'], effects: ['impacts', 'influences', 'actions'], result: ['finding', 'outcome'], results: ['findings', 'outcomes', 'data'], high: ['elevated', 'considerable'],
  different: ['distinct', 'diverse', 'various'], various: ['several', 'diverse', 'numerous'], also: ['additionally', 'likewise'], however: ['nevertheless', 'yet', 'still'],
  good: ['sound', 'effective', 'beneficial'], new: ['novel', 'recent'], main: ['principal', 'primary', 'chief'], help: ['assist', 'aid', 'support'], need: ['requirement', 'necessity'],
  potential: ['possible', 'prospective'], activity: ['action', 'effect', 'efficacy'], observed: ['noted', 'seen', 'recorded'], found: ['identified', 'detected', 'observed'],
  role: ['function', 'part'], level: ['concentration', 'amount'], levels: ['concentrations', 'amounts'], method: ['technique', 'procedure', 'approach'], methods: ['techniques', 'procedures', 'approaches'],
  determine: ['establish', 'ascertain', 'assess'], evaluate: ['assess', 'examine', 'appraise'], obtained: ['acquired', 'gained', 'derived'], present: ['current', 'this'], suggest: ['indicate', 'imply'],
  suggests: ['indicates', 'implies'], several: ['various', 'multiple', 'a number of'], large: ['substantial', 'considerable', 'extensive'], small: ['minor', 'limited', 'modest'], very: ['highly', 'extremely']
};
const STOP = new Set('the a an and or of to in on at for with by from as is are was were be been being this that these those it its which who whom whose what when where why how than then there their they them we our us you your he she his her i me my not no nor but if so such can could may might will would shall should must do does did done have has had having into onto over under about after before between during through above below up down out off again further once here both each few more most other some own same too very s t only also all any per vs et al fig figs table'.split(' '));

// words used by at least a fifth of published research articles (src/language/spell.js)
const RESEARCH_COMMON = S.RESEARCH_COMMON;

function engagementDoc(p, g) {
  const out = [];
  // overused word in one paragraph
  const w = words(p);
  const counts = new Map();
  for (const x of w) { const k = x.w.toLowerCase(); if (k.length > 3 && !STOP.has(k) && !/^[A-Z]{2,}/.test(x.w)) counts.set(k, [...(counts.get(k) || []), x]); }
  for (const [k, list] of counts) {
    const syn = THESAURUS[k];
    // words most research articles repeat ("significantly", "levels", "groups", "patients") are the vocabulary of the field
    if (!syn || list.length < 3 || (g.domain === 'academic' && RESEARCH_COMMON.has(k))) continue;
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
  awesome: ['excellent', 'impressive'], huge: ['substantial', 'major'], tons: ['a great deal'], 'a ton of': ['many'], 'pretty much': ['almost'],
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
  // PJPS practice (1,500 published articles counted, Nov 2026): P values are written "P<0.05" in 86 % of articles and
  // "P < 0.05" in the rest, nearly always with the leading zero; only a missing leading zero is reported, spacing kept as written
  regexRule('p-value', 'style', 'Statistics', /\b([Pp])(\s*)([<>=≤≥])(\s*)(\.\d+)/g, (m) => ({
    message: 'Write P values with a leading zero, e.g. "P<0.05".', replacements: [`${m[1]}${m[2]}${m[3]}${m[4]}0${m[5]}`]
  }), { when: g => g.domain === 'academic' })
];

// ------------------------------------------------------------------ grammar patterns of research writing
// verbs of Methods and Results with their forms: [base, 3rd person, past, past participle]
const REGULAR = `perform determine evaluate assess calculate analyze analyse observe obtain prepare administer select include exclude conduct investigate examine
identify isolate purchase dissolve filter incubate centrifuge wash dilute inject induce divide randomize randomise recruit enroll enrol euthanize anesthetize
anaesthetise compare detect quantify synthesize synthesise characterize characterise formulate optimize optimise validate apply compute explore establish
confirm demonstrate achieve consider define describe propose suggest document encourage expose inform interview involve maintain prescribe provide publish
receive reduce remove require store utilize utilise weigh approve adopt allocate assign classify homogenize homogenise lyse macerate quantitate reconstitute
sonicate standardize standardise sterilize sterilise suspend tabulate transfect transform inoculate immunize vaccinate embed increase decrease improve
inhibit enhance prevent contribute occur remain predict develop exhibit indicate reveal appear seem differ depend contain consist affect cause produce
protect regulate activate attenuate ameliorate alleviate aggravate elevate lower decline exceed report record collect measure test treat use need help
change control support follow extract express mix stain`.split(/\s+/);
const DOUBLE = new Set(['enrol', 'occur', 'control', 'transfer', 'refer', 'prefer', 'admit', 'submit', 'commit', 'permit', 'omit', 'stop', 'plan', 'drop']);
const third = v => (/(?:s|x|z|ch|sh|o)$/.test(v) ? `${v}es` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`);
const pastOf = v => (/e$/.test(v) ? `${v}d` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ied` : DOUBLE.has(v) ? `${v}${v.slice(-1)}ed` : `${v}ed`);
const IRREG = `show showed shown|take took taken|give gave given|find found found|make made made|see saw seen|begin began begun|become became become|choose chose chosen
|draw drew drawn|grow grew grown|write wrote written|know knew known|undergo underwent undergone|undertake undertook undertaken|rise rose risen|arise arose arisen
|fall fell fallen|hold held held|keep kept kept|lead led led|leave left left|feel felt felt|go went gone|run ran run|bring brought brought|buy bought bought
|seek sought sought|teach taught taught|think thought thought|spend spent spent|send sent sent|build built built|freeze froze frozen|shake shook shaken
|strike struck struck|bind bound bound|grind ground ground|withdraw withdrew withdrawn|overcome overcame overcome|mean meant meant|meet met met|lose lost lost
|pay paid paid|say said said|tell told told|understand understood understood|win won won|eat ate eaten|drive drove driven|break broke broken|speak spoke spoken`
  .split('|').map(s => s.trim().split(/\s+/));
const VERB = new Map();   // any form -> { base, s, past, pp }
for (const v of REGULAR) { const f = { base: v, s: third(v), past: pastOf(v), pp: pastOf(v) }; for (const x of [f.s, f.past]) VERB.set(x, f); }
for (const [base, past, pp] of IRREG) { const f = { base, s: third(base), past, pp }; for (const x of [f.s, past, pp]) if (x !== base) VERB.set(x, f); }
// base forms that are clearly verbs (never nouns) after "has", "was" or "been": "has demonstrate", "were determine"
const NEEDS_PP = new Set(`perform determine evaluate assess calculate analyze analyse observe obtain prepare administer select exclude investigate examine identify
isolate dissolve incubate dilute inject induce divide randomize randomise recruit enroll euthanize compare detect quantify synthesize synthesise characterize
characterise formulate optimize optimise validate apply compute explore establish confirm demonstrate achieve define describe propose suggest encourage expose
inform involve maintain prescribe provide publish receive reduce remove utilize utilise approve adopt allocate assign classify homogenize sonicate standardize
sterilize transfect inoculate immunize vaccinate improve inhibit enhance prevent contribute predict reveal indicate`.split(/\s+/));
for (const [base] of IRREG) if (!['become', 'overcome', 'run', 'lead', 'hold', 'keep', 'feel', 'find', 'mean', 'meet', 'win', 'pay', 'say', 'tell', 'build', 'spend', 'send', 'buy', 'think', 'teach', 'grind', 'bind', 'strike', 'fall', 'rise', 'lose', 'leave', 'go', 'speak', 'break', 'drive', 'eat'].includes(base)) NEEDS_PP.add(base);
const PP_OF = new Map([...REGULAR.map(v => [v, pastOf(v)]), ...IRREG.map(([b, , pp]) => [b, pp])]);
const ADV = '(?:(?:not|also|further|significantly|markedly|potentially|only|still|then|thus|therefore|clearly|successfully|effectively|both|all|first)\\s+)*';
const verbAlt = [...VERB.keys()].sort((a, b) => b.length - a.length).join('|');
const ppAlt = [...NEEDS_PP].sort((a, b) => b.length - a.length).join('|');

// research nouns: singular -> plural
const NOUNS = Object.fromEntries(`patient sample study result group rat mouse:mice cell compound extract drug method parameter factor case participant subject
child:children woman:women man:men animal plant experiment test value finding outcome variable strain isolate tablet formulation concentration dose day week
month year hour minute symptom disease infection reaction region area country hospital student pharmacist physician doctor nurse author researcher article
paper report trial enzyme protein gene receptor molecule solvent fraction peak technique approach model assay organism bacterium:bacteria fungus:fungi virus
pathogen product medicine herb leaf:leaves seed fruit criterion:criteria analysis:analyses hypothesis:hypotheses respondent volunteer prescription complication
tumor tumour lesion mutation cytokine marker biomarker level change difference effect property activity mechanism pathway treatment therapy condition
characteristic feature sign measurement observation question`.split(/\s+/).map(w => {
  const [s, p] = w.split(':');
  return [s, p || (/(?:s|x|ch|sh)$/.test(s) ? `${s}es` : /[^aeiou]y$/.test(s) ? `${s.slice(0, -1)}ies` : `${s}s`)];
}));
const SINGULAR_OF = Object.fromEntries(Object.entries(NOUNS).map(([s, p]) => [p, s]));
// plurals that are also verbs ("this results in", "this changes the"): never corrected after "this"
const VERBY = new Set(['results', 'effects', 'changes', 'reports', 'tests', 'models', 'approaches', 'features', 'signs', 'markers', 'studies', 'factors', 'cases', 'groups',
  'values', 'products', 'drugs', 'peaks', 'assays', 'samples', 'doses', 'extracts', 'plants', 'levels', 'treatments', 'conditions', 'measurements', 'experiments', 'findings', 'cells', 'papers', 'seeds', 'fractions', 'differences', 'properties', 'activities']);
const sgAlt = Object.keys(NOUNS).join('|'), plAlt = Object.values(NOUNS).join('|');
// what can follow a noun that ends its phrase (a noun used as a modifier, "several patient groups", is not followed by these)
const PHRASE_END = '(?=\\s+(?:were|was|are|is|had|have|has|with|who|which|that|in|of|from|at|for|showed|received|underwent|treated)\\b|\\s*[,.;:)])';
// a noun inside a phrase ("approval for the experiments was", "parameters affecting the reaction were") is not the subject
const NOT_SUBJECT = '(?<!\\b(?:of|in|for|from|with|by|on|at|to|among|between|than|into|about|under|over|after|before|during|through|against|without|within|per|via|almost|like|across|including|and|or|\\w+ing|\\w+ed)\\s)';
const BE_VERB_SG = { were: 'was', are: 'is', have: 'has', show: 'shows', suggest: 'suggests', indicate: 'indicates', demonstrate: 'demonstrates', reveal: 'reveals', remain: 'remains', seem: 'seems', appear: 'appears', do: 'does' };
const BE_VERB_PL = Object.fromEntries(Object.entries(BE_VERB_SG).map(([p, s]) => [s, p]));
// measures of disease and treatment that make a plural subject when two are joined ("incidence and mortality are")
const MEASURES = 'incidence|prevalence|morbidity|mortality|burden|severity|frequency|sensitivity|specificity|efficacy|safety|toxicity|tolerability|knowledge|awareness|absorption|distribution|metabolism|excretion|bioavailability|solubility|stability';
// a person in an author list (Chunyan Sheng, Muhammad Ali Khan, KF) and the verbs of a contributions statement
const PERSON = "(?:[A-Z][a-z'’-]+(?: [A-Z][a-z'’-]+){1,2}|[A-Z]{2,4})";
const CONTRIB_VERBS = 'conceived|designed|wrote|drafted|performed|collected|analy[sz]ed|interpreted|revised|reviewed|edited|supervised|contributed|carried|conducted|prepared|approved|developed|acquired';
const SUBSTANCES = 'streptozotocin|STZ|alloxan|carrageenan|paracetamol|acetaminophen|CCl4|LPS|lipopolysaccharide|cisplatin|doxorubicin|gentamicin|formalin|ethanol|isoproterenol|isoprenaline|haloperidol|scopolamine|reserpine|dexamethasone|cyclophosphamide|methotrexate|histamine|serotonin|capsaicin|pentylenetetrazole|PTZ|MPTP|rotenone|aluminium|aluminum|cadmium|arsenic|diclofenac|indomethacin|aspirin|ibuprofen|stress|exercise|diet|drug|chemotherapy|radiation|hypoxia|glucose|insulin|nicotine|alcohol|cocaine|morphine|MSG|fructose|thioacetamide|DMBA|DEN|azoxymethane|AOM|DSS|bleomycin|monocrotaline|L-NAME|receptor|antibody|immune|enzyme|cell|ligand|virus|bacteria|toxin|oxidative';

const grammar = [
  regexRule('verb-form', 'correctness', 'Verb form', new RegExp(`\\b(can|could|might|must|shall|should|will|would|cannot|can't|couldn't|won't|wouldn't|shouldn't|mustn't|may|did|didn't|does|doesn't|do|don't)(\\s+${ADV})(${verbAlt})\\b(?![-'’])`, 'g'), (m) => {
    const f = VERB.get(m[3]);
    // "do", "does", "did" only when negative: "How do treated cells respond" is a question with an adjective
    if (!f || (/^(?:do|does|did)$/.test(m[1]) && !/\bnot\b/.test(m[2]))) return null;
    const s = m.index + m[1].length + m[2].length;
    return { start: s, message: `After "${m[1]}" the verb takes its base form: "${f.base}".`, replacements: [f.base] };
  }),
  regexRule('verb-form', 'correctness', 'Verb form', new RegExp(`\\b(aimed|aim|aims|designed|intended|sought|able|unable|attempted|tried|tend|tends|tended|failed|order|decided|planned)\\s+to\\s+(${verbAlt})\\b(?![-'’])`, 'gi'), (m) => {
    const f = VERB.get(m[2].toLowerCase());
    if (!f) return null;
    const s = m.index + m[0].length - m[2].length;
    return { start: s, message: `After "to" the verb takes its base form: "to ${f.base}".`, replacements: [f.base] };
  }),
  regexRule('verb-form', 'correctness', 'Verb form', new RegExp(`\\b(has|have|had|having|is|are|was|were|be|been|being)(\\s+${ADV})(${ppAlt})\\b(?![-'’])`, 'gi'), (m) => {
    const base = m[3].toLowerCase(), pp = PP_OF.get(base);
    if (!pp) return null;
    // "to have" + base is a request ("have them complete"), "be" after "to" ("to be determine") is still wrong
    if (/^(?:have|has|had|having)$/i.test(m[1]) && /\b(?:them|him|her|patients|participants)\s*$/i.test(m[2])) return null;
    const s = m.index + m[1].length + m[2].length;
    return { start: s, message: `After "${m[1]}" the verb takes its past participle: "${pp}".`, replacements: [keepCase(m[3], pp)] };
  }),
  regexRule('noun-number', 'correctness', 'Noun form', new RegExp(`\\bone of the\\s+(?:(?:most|more|least|main|major|key|important|leading|common|significant|best|largest|first|primary|principal|other|potential|possible|few)\\s+){0,3}(${sgAlt})\\b(?![-'’])${PHRASE_END}`, 'gi'), (m) => {
    const s = m.index + m[0].length - m[1].length;
    return { start: s, message: `After "one of the" the noun is plural: "${NOUNS[m[1].toLowerCase()]}".`, replacements: [keepCase(m[1], NOUNS[m[1].toLowerCase()])] };
  }),
  // (not after a label: "phase 2 trial was", "Table 3 patient", "type 2 model"; not "both patient and physician")
  regexRule('noun-number', 'correctness', 'Noun form', new RegExp(`(?<!\\b(?:phase|type|grade|stage|class|figure|fig\\.|table|group|day|week|step|level|model|version|generation|cycle|arm|part|section|lane|wave|round|batch|experiment|study|item|question|category|tier|dose|visit|period|lot|no\\.)\\s)\\b(these|those|several|many|various|numerous|multiple|few|two|three|four|five|six|seven|eight|nine|ten|[2-9]|[1-9]\\d{1,2})\\s+(${sgAlt})\\b(?![-'’])${PHRASE_END}`, 'gi'), (m, p) => {
    // a number counts only after a word ("after 3 hour"), not in a formula, a range or a page header ("CO 2 level", "2.5 year", "613 extract")
    if (/^\d/.test(m[1])) {
      const w = p.slice(Math.max(0, m.index - 30), m.index).match(/(?:^|\s)([a-z]{3,})\s+$/);
      if (!w || /^(?:phase|type|grade|stage|class|table|group|day|week|step|level|model|version|cycle|arm|part|section|lane|wave|round|batch|experiment|study|item|question|category|tier|dose|visit|period|lot|page|vol|figure|interleukin|caspase|chromosome|cytochrome|exon|intron|codon|domain|subunit|isoform|complex|clone|serotype|genotype|vitamin|omega|compound|formula|equation|tube|well|plate|column|peak|fraction|sample|number|receptor|factor|kinase|protein|cluster|region|channel|line)$/.test(w[1])) return null;
    }
    const s = m.index + m[0].length - m[2].length;
    return { start: s, message: `After "${m[1]}" the noun is plural: "${NOUNS[m[2].toLowerCase()]}".`, replacements: [keepCase(m[2], NOUNS[m[2].toLowerCase()])] };
  }),
  regexRule('noun-number', 'correctness', 'Noun form', new RegExp(`\\b(each|every|another|this)\\s+(${plAlt})\\b(?![-'’])`, 'gi'), (m) => {
    const pl = m[2].toLowerCase();
    if (m[1].toLowerCase() === 'this') {
      // "this results in" is a verb; otherwise the writer meant "these patients"
      if (VERBY.has(pl)) return null;
      return { end: m.index + 4, message: `"${m[2]}" is plural, so the determiner is "these".`, replacements: [keepCase(m[1], 'these')] };
    }
    const s = m.index + m[0].length - m[2].length;
    return { start: s, message: `After "${m[1]}" the noun is singular: "${SINGULAR_OF[pl]}".`, replacements: [keepCase(m[2], SINGULAR_OF[pl])] };
  }),
  regexRule('subject-verb', 'correctness', 'Subject-verb agreement', new RegExp(`${NOT_SUBJECT}\\b(?:the|these|those|our|all|both|most)\\s+(${plAlt})\\s+(was|is|has|shows|suggests|indicates|demonstrates|reveals|remains|seems|appears|does)\\b`, 'gi'), (m) => {
    const s = m.index + m[0].length - m[2].length;
    return { start: s, message: `"${m[1]}" is plural, so the verb is "${BE_VERB_PL[m[2].toLowerCase()]}".`, replacements: [BE_VERB_PL[m[2].toLowerCase()]] };
  }),
  regexRule('subject-verb', 'correctness', 'Subject-verb agreement', new RegExp(`${NOT_SUBJECT}\\b(?:the|this|that|each|every)\\s+(${sgAlt})\\s+(were|are|have|show|suggest|indicate|demonstrate|reveal|remain|seem|appear|do)\\b`, 'gi'), (m) => {
    if (/^(?:group|analysis|criterion)$/i.test(m[1])) return null; // a group may take a plural verb in British English
    const s = m.index + m[0].length - m[2].length;
    return { start: s, message: `"${m[1]}" is singular, so the verb is "${BE_VERB_SG[m[2].toLowerCase()]}".`, replacements: [BE_VERB_SG[m[2].toLowerCase()]] };
  }),
  regexRule('subject-verb', 'correctness', 'Subject-verb agreement', /\b(the number of)\s+(?:(?!who\b|that\b|which\b)[\w-]+\s+){1,8}?(were|are|have)\b/gi, (m) => {
    const s = m.index + m[0].length - m[2].length;
    return { start: s, message: '"The number of …" takes a singular verb ("the number of patients was").', replacements: [{ were: 'was', are: 'is', have: 'has' }[m[2].toLowerCase()]] };
  }),
  // two measures joined by "and" are a plural subject ("TB disease burden and mortality is very high" -> are); not after
  // a preposition ("the risk of morbidity and mortality is" has "risk" as its subject)
  regexRule('subject-verb', 'correctness', 'Subject-verb agreement', new RegExp(`(?:^|(?<=[.;:]\\s+)|\\b(\\w+)\\s+)(${MEASURES})\\s+and\\s+(${MEASURES})\\s+(is|was|has)\\b`, 'gi'), (m) => {
    if (m[1] && /^(?:of|in|for|on|to|with|between|from|by|about|regarding|and|or|its|their)$/i.test(m[1])) return null;
    const v = m[4].toLowerCase(), s = m.index + m[0].length - m[4].length;
    return { start: s, message: `"${m[2]} and ${m[3]}" are two things, so the verb is "${BE_VERB_PL[v]}".`, replacements: [BE_VERB_PL[v]] };
  }),
  // the authors' contributions: "Chunyan Sheng, Guo Sun conceived the study" -> "Chunyan Sheng and Guo Sun"
  regexRule('author-list', 'correctness', 'Missing conjunction', new RegExp(`(?:^|(?<=[;:]\\s*))((?:${PERSON}, ){1,6})(${PERSON}) (?=(?:${CONTRIB_VERBS})\\b)`, 'g'), (m) => {
    const s = m.index + m[1].length - 2;
    return { start: s, end: s + 2, message: 'Join the last two names with "and": "A, B and C wrote the manuscript".', replacements: [' and '] };
  }),
  regexRule('subject-verb', 'correctness', 'Subject-verb agreement', /\b(there)\s+(is|was)\s+(?=(?:many|several|numerous|various|multiple|few|no significant differences|significant differences|differences|two|three|four|five)\b)/gi, (m) => {
    const s = m.index + m[1].length + 1;
    return { start: s, end: s + m[2].length, message: `The noun after "there ${m[2]}" is plural, so the verb is "${m[2].toLowerCase() === 'is' ? 'are' : 'were'}".`, replacements: [m[2].toLowerCase() === 'is' ? 'are' : 'were'] };
  }),
  regexRule('noun-number', 'correctness', 'Noun form', new RegExp(`\\b(much)\\s+(?=(?:${plAlt})\\b)`, 'gi'), (m) => ({ end: m.index + m[1].length, message: 'Use "many" with things you can count.', replacements: [keepCase(m[1], 'many')] })),
  regexRule('noun-number', 'correctness', 'Noun form', new RegExp(`\\b(amounts? of)\\s+(?=(?:patients|participants|people|subjects|cells|samples|studies|animals|rats|mice|cases|children|women|men|students|doctors|pharmacists|hospitals|tablets|errors|respondents|volunteers|colonies|isolates|strains)\\b)`, 'gi'), (m) => ({ end: m.index + m[1].length, message: 'Use "number of" with things you can count ("the number of patients").', replacements: [/s of$/i.test(m[1]) ? 'numbers of' : 'number of'] })),
  regexRule('compound-hyphen', 'style', 'Hyphen', /(?<!\bqua\s)\b(non)\s+(?!sequitur\b|grata\b)([a-z]{3,})\b/gi, (m) => ({ message: `"non" is joined to the word it qualifies: "non-${m[2]}".`, replacements: [`${m[1]}-${m[2]}`] })),
  regexRule('compound-hyphen', 'style', 'Hyphen', new RegExp(`\\b(?:[Ii]n|[Oo]n|[Aa]gainst|[Oo]f|[Ww]ith|[Ff]rom|[Ff]or|[Tt]o|[Ii]nto|[Dd]uring|[Aa]fter|[Ff]ollowing)\\s+(?=(?:${SUBSTANCES})\\s+(?:induced|mediated)\\s+(?!(?:by|in|with|the|a|an|and|or|was|were|is|are|via|through|at|after|for|to|from|on)\\b)[a-z])(\\S+)(\\s+)(induced|mediated)\\b`, 'g'), (m) => {
    const s = m.index + m[0].length - m[3].length - m[2].length - m[1].length;
    return { start: s, message: `A compound before a noun takes a hyphen: "${m[1]}-${m[3]}".`, replacements: [`${m[1]}-${m[3]}`] };
  }),
  regexRule('unit-style', 'style', 'Unit', /\b(\d+(?:\.\d+)?)\s?(oC|0C|ºC)(?![\w])/g, (m) => ({ message: 'Write degrees Celsius with the degree sign: "°C".', replacements: [`${m[1]} °C`] }), { when: g => g.domain === 'academic' }),
  regexRule('unit-style', 'style', 'Unit', /\b(\d+(?:\.\d+)?)(mins|hrs|hr|secs|gm|gms|mgs|kgs|Kg|mls)\b/g, (m) => ({ message: 'Put a space between a number and its unit, and use the SI symbol.', replacements: [`${m[1]} ${{ mins: 'min', hrs: 'h', hr: 'h', secs: 's', gm: 'g', gms: 'g', mgs: 'mg', kgs: 'kg', Kg: 'kg', mls: 'mL' }[m[2]]}`] }), { when: g => g.domain === 'academic' })
];

// ------------------------------------------------------------------ determiners, comparatives and formatting (gaps found
// against Grammarly on a PJPS manuscript, report of 16 Nov 2026: "in control group", "by physician", "highly efficacious than")
// singular countable nouns of research writing that need "the" or "a" after a preposition
const COUNT_DET = 'group|study|questionnaire|booklet|brochure|session|scale|instrument|interview|physician|nurse|doctor|pharmacist|researcher|investigator|assistant|patient|participant|clinic|sample|trial|survey|program|programme|video|cohort|ward|visit|population';
const NO_DET_BEFORE = new Set('the a an this that these those each every any some no our their its his her my your one another either neither same such which what all both whose per its'.split(' '));
const PREP_DET = 'in|of|from|to|for|by|at|with|into|on|after|before|during|among|within|across|than|regarding|about|including|without|through';
const DET_END = '(?=\\s+(?:were|was|are|is|had|have|has|with|who|which|that|in|of|from|at|for|and|or|but|while|whereas|compared|as|to|on|by|after|before|during|than|did|does|do|showed|received|underwent|could|can|may|might|will|would|should|must)\\b|\\s*[,.;:)]|\\s*$)';
const gerund = v => (/ee$/.test(v) ? `${v}ing` : /[^aeiou]e$/.test(v) ? `${v.slice(0, -1)}ing` : /^(?:[^aeiou]*[aeiou][bdgmnpt])$/.test(v) ? `${v}${v.slice(-1)}ing` : `${v}ing`);
const COMPARATIVE_OF = { high: 'higher', low: 'lower', large: 'larger', small: 'smaller', great: 'greater', strong: 'stronger', weak: 'weaker', good: 'better', poor: 'poorer', long: 'longer', short: 'shorter', fast: 'faster', slow: 'slower', early: 'earlier', late: 'later' };

const determiners = [
  regexRule('determiner', 'correctness', 'Missing article', new RegExp(`\\b(${PREP_DET})\\s+((?:(?:(?!(?:${PREP_DET})\\b)[a-z][a-z-]*|[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\\s+){0,3}?)(${COUNT_DET})\\b(?![-'’])${DET_END}`, 'g'), (m, p) => {
    const prep = m[1], mods = m[2].trim().split(/\s+/).filter(Boolean), noun = m[3];
    if (mods.some(w => NO_DET_BEFORE.has(w.toLowerCase()) || /[a-z]ing$|[^su]s$|^(?:further|vivo|vitro|silico|situ)$/.test(w) || /^(?:in|of|from|to|for|by|at|with|on|and|or|was|were|is|are|not|than|as)$/.test(w))) return null;
    if ((prep === 'to' && !mods.length && /^(?:study|survey|interview|sample|visit|trial)$/.test(noun)) || (prep === 'in' && noun === 'hospital') || (prep === 'by' && noun === 'group') || (prep === 'of' && noun === 'study' && !mods.length && /\b(?:design|area|period|protocol|site|population|duration)\s+$/.test(p.slice(0, m.index)))) return null;
    // "from patient to patient", "group to group"
    if (new RegExp(`\\b${noun}\\s+$`).test(p.slice(Math.max(0, m.index - 20), m.index))) return null;
    if (/^\s*[A-Z0-9]/.test(p.slice(m.index + m[0].length, m.index + m[0].length + 2)) && /\s/.test(p[m.index + m[0].length] || '')) return null; // "in group A", "in study 2"
    const start = m.index + prep.length + 1 + (m[0].slice(prep.length + 1).length - m[0].slice(prep.length + 1).trimStart().length);
    const span = p.slice(start, m.index + m[0].length);
    const first = span.split(/\s+/)[0];
    const article = /^(?:population|group|study|cohort|programme|program)$/.test(noun) || mods.length ? 'the' : 'a';
    const an = /^(?:[aeio]|u(?!ni|s[eu])|[AEFHILMNORSX][A-Z0-9-]*$)/.test(first) ? 'an' : 'a';
    const reps = article === 'the' ? [`the ${span}`, `${an} ${span}`] : [`${an} ${span}`, `the ${span}`];
    return { start, message: `A singular countable noun needs an article here: "${reps[0]}".`, replacements: reps };
  }),
  // a sentence that opens with a singular noun and its verb: "Booklet also included", "Total sample size was"
  regexRule('determiner', 'correctness', 'Missing article', /(?:^|(?<=[.!?]\s+))((?:Booklet|Brochure|Questionnaire|Session|Instrument|Scale|Study|Survey|Program|Programme|Video|Sample|Physician|Nurse|Researcher|Clinic|Intervention|Control group|Intervention group)|(?:Total|Overall|Mean|Average)\s+(?:sample size|number|score|duration|age))(?=\s+(?:also\s+)?(?:was|is|has|had|included|includes|contained|contains|consisted|comprised|showed|shows|demonstrated|provided)\b)/g, (m) => ({
    message: `A singular noun at the start of a sentence needs an article: "The ${m[1][0].toLowerCase()}${m[1].slice(1)}".`, replacements: [`The ${m[1][0].toLowerCase()}${m[1].slice(1)}`]
  })),
  regexRule('determiner', 'correctness', 'Missing article', /(?:^|(?<=[.!?;:]\s+|,\s+|\b(?:and|that|while|whereas|but|On average,)\s+))(Number|number|Percentage|percentage|Proportion|proportion|Majority|majority|Remainder|remainder|Rest|rest|Total|total) of\b(?=\s+[a-z])/g, (m, p) => {
    if (/\b(?:a|the|this|that|its|their|our|large|small|greater|higher|lower|total|same|any)\s*$/i.test(p.slice(Math.max(0, m.index - 12), m.index))) return null;
    const cap = /^[A-Z]/.test(m[1]);
    return { end: m.index + m[1].length, message: `"${m[1].toLowerCase()} of …" needs "the" here.`, replacements: [`${cap ? 'The' : 'the'} ${m[1].toLowerCase()}`] };
  }),
  regexRule('determiner', 'correctness', 'Missing article', /\b(Remaining|Following|Based on following|based on following|on following|in following|of following)\b(?=\s+(?:\d+|[a-z]+)\s+(?:[a-z]+\s+)?(?:were|was|are|is|had|have|did|has|characteristics|criteria|materials|steps|items)\b)/g, (m) => {
    const w = m[1];
    if (/^(?:Remaining|Following)$/.test(w)) return { message: `Add "the": "The ${w.toLowerCase()} …".`, replacements: [`The ${w.toLowerCase()}`] };
    return { message: 'Add "the": "the following".', replacements: [w.replace(/following$/, 'the following')] };
  }),
  // "highly efficacious than", "high adherence than": a comparison takes the comparative
  regexRule('comparative', 'correctness', 'Comparison', /\b(highly|very|much)\s+([a-z]{4,})\s+than\b/g, (m) => {
    if (/(?:er|more|less|other|rather|better|worse)$/.test(m[2])) return null;
    return { end: m.index + m[1].length + 1 + m[2].length, message: `A comparison with "than" needs "more": "more ${m[2]} than".`, replacements: [`more ${m[2]}`] };
  }),
  regexRule('comparative', 'correctness', 'Comparison', /\b(high|low|large|small|great|strong|weak|good|poor|long|short|fast|slow|early|late)\s+((?:[a-z-]+\s+){0,2}?)than\b/g, (m, p) => {
    if (/\b(?:rather|other|more|less|much)\s*$/.test(p.slice(Math.max(0, m.index - 10), m.index)) || /\b(?:rather|other|more|less|much)\b/.test(m[2])) return null;
    return { end: m.index + m[1].length, message: `A comparison with "than" needs the comparative: "${COMPARATIVE_OF[m[1]]}".`, replacements: [COMPARATIVE_OF[m[1]]] };
  }),
  // ranges: "from 30-35 minutes" -> "from 30 to 35"; "between 2-5" -> "between 2 and 5"; "31—40" -> en dash
  regexRule('range', 'style', 'Range', /\b(from|between)\s+(\d+(?:\.\d+)?)(\s?[-–—]\s+|[-–—])(\d+(?:\.\d+)?)\b/gi, (m) => {
    const s = m.index + m[1].length + 1;
    return { start: s, message: `After "${m[1].toLowerCase()}", write the range with "${/^from$/i.test(m[1]) ? 'to' : 'and'}".`, replacements: [`${m[2]} ${/^from$/i.test(m[1]) ? 'to' : 'and'} ${m[4]}`] };
  }),
  regexRule('range', 'style', 'Range', /\b(\d+(?:\.\d+)?)—(\d+(?:\.\d+)?)\b/g, (m) => ({ message: 'A range of numbers takes an en dash (–), not an em dash.', replacements: [`${m[1]}–${m[2]}`] })),
  // "pre:33.3%" (a space after the colon), "43% participants" (of)
  regexRule('spacing-colon', 'correctness', 'Spacing', /\b([a-z]{2,}):(?=\d)/g, (m) => ({ start: m.index + m[1].length, end: m.index + m[1].length + 1, message: 'Add a space after the colon.', replacements: [': '] })),
  regexRule('percent-of', 'correctness', 'Missing preposition', /\b(\d+(?:\.\d+)?\s?%)\s+(?=(?:participants|patients|respondents|subjects|cases|children|women|men|students|individuals|people|contacts|adults|doctors|nurses|pharmacists)\b)/g, (m) => ({
    end: m.index + m[1].length, message: 'A percentage of a group takes "of": "43% of participants".', replacements: [`${m[1]} of`]
  })),
  // "play a role to address" -> "role in addressing"
  regexRule('preposition', 'correctness', 'Preposition', /\b(?:play|plays|played|playing)\s+(?:an?\s+)?(?:[a-z]+\s+){0,4}?role\s+(to\s+([a-z]{3,}))\b/g, (m) => {
    const s = m.index + m[0].length - m[1].length;
    return { start: s, message: '"A role" is played "in" something: "role in addressing".', replacements: [`in ${gerund(m[2])}`] };
  }),
  // "12 week follow up", "a 6 month period": a number and unit before a noun are hyphenated
  regexRule('compound-hyphen', 'style', 'Hyphen', /\b(\d+)\s+(week|day|month|year|hour|minute|item|point)\s+(?=(?:period|follow-up|follow up|course|program|programme|intervention|study|trial|treatment|regimen|interval|time|scale|questionnaire|assessment|duration|history|survival|mortality|old)\b)/g, (m) => ({
    end: m.index + m[1].length + 1 + m[2].length, message: `A number and unit before a noun are joined by a hyphen: "${m[1]}-${m[2]}".`, replacements: [`${m[1]}-${m[2]}`]
  })),
  regexRule('compound-hyphen', 'style', 'Hyphen', /(?<!\b(?:to|will|would|should|must|can|could|may|might|we|they|did|not|and|or|please|i)\s)\b(follow up)\b(?!\s+(?:on|with|the|patients|participants|them|their|all|those|these|each)\b)/gi, (m) => ({
    message: 'As a noun or adjective, "follow-up" takes a hyphen.', replacements: [`${m[1].slice(0, 6)}-up`]
  })),
  // "pre and post-test" -> "pre- and post-test" (the first prefix keeps its hyphen)
  regexRule('compound-hyphen', 'style', 'Hyphen', /\b(pre|post|intra|inter|extra|sub|super|over|under|non|anti|self|short|long|low|high|first|second)(\s+(?:and|or|to)\s+)(?=(?:pre|post|intra|inter|extra|sub|super|over|under|non|anti|self|short|long|low|high|first|second|third)-[a-z])/gi, (m) => ({
    end: m.index + m[1].length, message: `A prefix shared with the next word keeps its hyphen: "${m[1]}-${m[2].trimEnd()} …".`, replacements: [`${m[1]}-`]
  })),
  // "P-value less than 0.05 was considered significant": a sentence that opens with a singular noun needs "A"
  regexRule('determiner', 'correctness', 'Missing article', /(?:^|(?<=[.!?]\s+))(P-value|P value|p-value|p value)(?=\s+(?:less|lower|smaller|below)\b)/g, (m) => ({
    message: 'A singular noun at the start of a sentence needs an article: "A P value".', replacements: [`A ${/^p/.test(m[1]) ? 'P' : 'P'}${m[1].slice(1).replace('-', ' ')}`]
  })),
  // a plural abbreviation used as a modifier: "SSRIs exposure" -> "SSRI exposure", "NSAIDs use" -> "NSAID use"
  regexRule('noun-number', 'correctness', 'Noun form', /\b([A-Z][A-Z0-9-]{1,9})s\s+(?=(?:exposure|use|users|usage|treatment|therapy|prescription|prescriptions|consumption|intake|administration|dosage|regimen|class|group|signals?|risk)\b)/g, (m, p) => {
    if (/\b(?:of|with|on|by|between|among|and|or)\s+$/.test(p.slice(Math.max(0, m.index - 12), m.index)) && !/\b(?:gestational|prenatal|maternal|long-term|chronic|concomitant|prior|recent)\s+$/.test(p.slice(Math.max(0, m.index - 20), m.index))) return null;
    return { end: m.index + m[1].length + 1, message: `An abbreviation used as a modifier stays singular: "${m[1]} ${p.slice(m.index + m[0].length).split(/\s/)[0]}".`, replacements: [m[1]] };
  }),
  // a caption label without punctuation: "Figure 1 Distribution of AEs" -> "Figure 1: Distribution" (PJPS writes "Fig. 1:" and "Table 1:")
  regexRule('punctuation', 'correctness', 'Caption', /^(\s*(?:Figure|Fig\.|Table)\s?\d+[A-Za-z]?)(\s+)(?=[A-Z][a-z])/g, (m) => ({ start: m.index + m[1].length - m[1].trimStart().length, end: m.index + m[0].length, message: 'A figure or table label is followed by a colon: "Fig. 1: …".', replacements: [`${m[1].trimStart()}: `] })),
  // "…, that is consistent with" -> "…, which is consistent with" (a clause after a comma adds a comment)
  regexRule('word-choice', 'correctness', 'Relative pronoun', /,\s+(that)\s+(?=(?:is|was|are|were)\s+(?:consistent|in line|in agreement|in accordance|similar|comparable)\b)/g, (m) => ({
    start: m.index + m[0].lastIndexOf(m[1]), end: m.index + m[0].lastIndexOf(m[1]) + 4, message: 'After a comma, a clause that adds a comment opens with "which".', replacements: ['which']
  })),
  // "... are broadly different settings indicating that" -> ", indicating": a participle that comments on the whole clause,
  // after a number, a bracket or an adjective or adverb (102 of 114 such clauses in published PJPS articles have the comma)
  regexRule('comma-participle', 'correctness', 'Missing comma', /(?<=(?:\d%?|\)|\]|[a-z]{2}(?:ly|ed|ant|ent|ive|ble|ous|ar|nt)))( )(indicating|suggesting|implying|confirming)(?= (?:that|a|an|the)\b)/g, (m, p) => {
    if (/\b(?:to|than|of)\s+[\d.]+$/.test(p.slice(Math.max(0, m.index - 30), m.index))) return null; // "values closer to 1.0 indicating a good fit" describes the values
    return { end: m.index + 1, message: `Put a comma before "${m[2]}" when it comments on the whole clause.`, replacements: [', '] };
  }),
  // the same after a plural noun when the clause already has its verb ("the control group yielded no significance in any of
  // the four outcomes indicating the futility of ..."); without one ("Patients indicating pain") the participle describes the noun
  regexRule('comma-participle', 'correctness', 'Missing comma', /(?:^|[.;:,]\s)[^.;:,]*?\b(?:showed|shows|yielded|yields|revealed|reveals|exhibited|produced|resulted|remained|increased|decreased|reduced|improved|(?:was|were|is|are)\s+(?:not\s+)?(?:observed|found|seen|noted|recorded|detected|reduced|increased|decreased))\b[^.;:,]*?\b[a-z]{3,}s( )(indicating|suggesting|implying|confirming)(?= (?:that|the|a|an)\b)/g, (m) => {
    const at = m.index + m[0].length - m[2].length - 1;
    return { start: at, end: at + 1, message: `Put a comma before "${m[2]}" when it comments on the whole clause.`, replacements: [', '] };
  }),
  regexRule('word-choice', 'correctness', 'Word choice', /\bread\b[^.;]{0,60}?\b(loudly)\b/gi, (m) => ({ start: m.index + m[0].length - m[1].length, message: 'Reading so others can hear is reading "aloud".', replacements: ['aloud'] }))
];

// the phrase rules of the bank (bank.js): medical confusions, prepositions, noun forms, terms, species, units and more
const B = require('./bank');
const bankRules = { id: 'bank', run: (p, g, disabled) => B.match(p, g, disabled) };

const ALL = [...correctness, ...grammar, ...determiners, ...clarity, ...engagement, ...delivery, ...style];

/** Spelling issues of one paragraph */
function spelling(p, opts) {
  const out = [];
  const sents = sentences(p);
  const startOf = new Set(sents.map(s => s.start));
  const list = words(p);
  for (const [k, x] of list.entries()) {
    // the species name of a Latin binomial after its genus ("Moringa oleifera", "E. coli"): not English
    const prev = list[k - 1];
    // (the genus is a name, not an English word starting a sentence: "After exclsuion" is a typo, not a species)
    if (prev && /^[a-z]+$/.test(x.w) && /^[A-Z][a-z]*$/.test(prev.w) && (prev.w.length === 1 || !S.load(opts.variant).correct(prev.w.toLowerCase())) && /^\s*\.?\s+$/.test(p.slice(prev.end, x.start)) && /(?:a|ae|um|us|is|ii|i|ensis|oides|ata|ica|ina|ans|ens|ix|ex|on)$/.test(x.w)) continue;
    // after an opening bracket or quote the word still starts the sentence
    let i = x.start - 1;
    while (i >= 0 && /["“'‘([\s]/.test(p[i]) && !startOf.has(i + 1)) i--;
    const midSentence = !startOf.has(x.start) && i >= 0 && !/[.!?:]/.test(p[i]);
    const repeated = (opts.docWords?.get(x.w.toLowerCase()) || 0) >= 3;
    // joined to a dot, slash or @ without a space: a web address, e-mail or file name ("pjps.pk", "report.pdf")
    const address = /[./@]\w/.test(p.slice(x.end, x.end + 2)) || /\w[./@]/.test(p.slice(Math.max(0, x.start - 2), x.start));
    // an author's name in a citation: "Prihantono et al.", "(Azim, 2019)", "Kamel and Hassan"
    const after = p.slice(x.end, x.end + 16);
    const name = /^[A-Z]/.test(x.w) && (/^\s+et\.?\s+al\b/.test(after) || /^,?\s+(?:19|20)\d\d\b/.test(after) || /^\s+(?:and|&)\s+[A-Z][a-z]+\s*(?:[,(]|\s(?:19|20)\d\d|$)/.test(after));
    if (name) continue;
    if (S.check(x.w, { variant: opts.variant, personal: opts.personal, ctx: { midSentence, repeated, address } })) continue;
    const variantWord = S.otherVariant(x.w, opts.variant);
    const us = opts.variant !== 'en-GB' && S.usMedical(x.w);
    const reps = us ? [us, ...S.suggest(x.w, opts.variant).filter(w => w !== us)] : S.suggest(x.w, opts.variant);
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
  out.push(...bankRules.run(p, g, disabled));
  for (const s of sentences(p)) out.push(...sentenceRules(p, s, g).filter(i => !disabled.has(i.rule)));
  if (!disabled.has('overused')) out.push(...engagementDoc(p, g));
  return out;
}

module.exports = { checkParagraph, THESAURUS, keepCase };
