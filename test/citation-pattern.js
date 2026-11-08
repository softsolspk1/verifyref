// citation-pattern.js - Module 3.C citation pattern with known answers: references padded with sources on other subjects
// are found when the manuscript text is read; methods sources and the topic's own papers are not called off-topic;
// badly split reference entries are not judged; co-authors of the same papers are one flag; self-citation is not
// matched by a common surname alone or across two different ORCID iDs. Offline: no database, no network.
const assert = require('assert');
const { analyzeCitationPattern } = require('../src/editor/pattern');

const ok = m => console.log(`  ok - ${m}`);
const ref = (index, title, authors = [{ given: 'J', family: `Author${index}` }], extra = {}) => ({ index, raw: title, status: 'verified', record: { title, authors, journal: extra.journal || `Journal ${index}`, year: 2020 }, parsed: { title, authors } });

const meta = {
  title: 'Antibacterial and antioxidant activity of Nigella sativa seed extract against Staphylococcus aureus',
  abstract: 'Nigella sativa seed extracts were tested for antibacterial activity against Staphylococcus aureus and for antioxidant activity by DPPH assay.',
  keywords: ['Nigella sativa', 'antibacterial', 'antioxidant'],
  authors: [{ given: 'Muhammad', family: 'Khan' }, { given: 'Sara', family: 'Mozafari', orcid: '0000-0002-1825-0097' }]
};
const body = (`Introduction. Nigella sativa (black seed) is used in traditional medicine. Thymoquinone is its main constituent. ` +
  `Staphylococcus aureus causes skin and wound infections and methicillin resistance limits treatment. ` +
  `Methods. Seeds were extracted with methanol. The minimum inhibitory concentration was measured by broth microdilution ` +
  `following the CLSI guideline. Antioxidant activity was measured with the DPPH radical scavenging assay. Statistical analysis ` +
  `used one-way ANOVA. Results. The extract inhibited Staphylococcus aureus and scavenged DPPH radicals. Discussion. ` +
  `Thymoquinone and phenolic compounds explain the antibacterial and antioxidant activity of black seed. `).repeat(12);

const topic = [
  'Thymoquinone from Nigella sativa seeds: antibacterial activity against methicillin resistant Staphylococcus aureus',
  'Antioxidant activity of black seed (Nigella sativa) extracts measured by DPPH radical scavenging',
  'Phenolic compounds and antioxidant activity of medicinal seed extracts',
  'Methicillin resistant Staphylococcus aureus skin and wound infections: treatment options',
  'Methods for dilution antimicrobial susceptibility tests: CLSI guideline M07',
  'Broth microdilution determination of the minimum inhibitory concentration of plant extracts',
  'Traditional medicine uses of Nigella sativa: a review',
  'Use of the DPPH free radical method to evaluate antioxidant activity',
  'One-way ANOVA in pharmacological statistical analysis',
  'Thymoquinone: a review of its antibacterial and antioxidant properties',
  'Staphylococcus aureus resistance to treatment with methicillin',
  'Nigella sativa seed oil and thymoquinone constituent analysis'
];
const padding = [
  'Dark matter halos and the rotation curves of spiral galaxies',
  'Monetary policy transmission and inflation expectations in emerging economies',
  'Seismic design of reinforced concrete bridges under earthquake loading',
  'Syntax and morphology of verb agreement in Bantu languages',
  'Deep reinforcement learning for autonomous vehicle path planning'
];

// 12 references on the subject + 5 padding: the padding is found, nothing else
const refs = [...topic, ...padding].map((t, i) => ref(i + 1, t));
let p = analyzeCitationPattern(meta, refs, { body });
const weak = p.relevance.filter(r => r.level === 'weak').map(r => r.index).sort((a, b) => a - b);
assert.deepStrictEqual(weak, [13, 14, 15, 16, 17], `only the padding is weak: ${weak}`);
assert.ok(p.flags.some(f => f.code === 'off-topic'), 'off-topic flag raised');
assert.strictEqual(p.basis, 'the whole manuscript text');
ok('5 padded references on other subjects found among 17; the methods and statistics sources are not off-topic');

// the same list without padding: no off-topic flag
p = analyzeCitationPattern(meta, topic.map((t, i) => ref(i + 1, t)), { body });
assert.ok(!p.flags.some(f => f.code === 'off-topic'), 'no off-topic flag on a clean list');
assert.strictEqual(p.offTopic.length, 0, 'no weak references');
ok('a clean reference list gets no off-topic flag');

// badly split entries are not judged (and not counted as off-topic)
const debris = ['Mol', 'Gaussian 09', '(A) Representative FerroOrange fluorescence images; scale bar, 50 μm', 'Papa E, Pierleoni A, Pignatelli M, Platt T, Rowland F, Wankar P', 'FOR PEER REVIEW Koscielny G, An P, Carvalho-Silva D'];
p = analyzeCitationPattern(meta, [...topic, ...debris].map((t, i) => ref(i + 1, t)), { body });
assert.deepStrictEqual(p.relevance.slice(12).map(r => r.level), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'], 'debris not judged');
assert.ok(!p.flags.some(f => f.code === 'off-topic'));
ok('reference entries the list splitter cut badly are not judged');

// one research group, one flag
const group = [{ given: 'E', family: 'Dombi' }, { given: 'AM', family: 'Gross' }, { given: 'PL', family: 'Wolters' }];
p = analyzeCitationPattern(meta, topic.map((t, i) => ref(i + 1, t, i < 5 ? group : undefined)), { body });
const ac = p.flags.filter(f => f.code === 'author-concentration');
assert.strictEqual(ac.length, 1, `one flag for the group, not ${ac.length}`);
assert.ok(/Dombi.*Gross.*Wolters.*one research group/.test(ac[0].message), ac[0].message);
ok('co-authors of the same 5 papers give one author-concentration flag');

// self-citation: a common surname alone is not the manuscript author; a different ORCID iD is another person
const selfRefs = [
  ref(1, topic[0], [{ given: '', family: 'Khan' }]),                                         // "Khan" alone: not matched
  ref(2, topic[1], [{ given: 'Muhammad', family: 'Khan' }]),                                 // full name: matched
  ref(3, topic[2], [{ given: 'S', family: 'Mozafari', orcid: '0000-0003-0000-0001' }]),      // same name, other ORCID
  ref(4, topic[3], [{ given: 'S', family: 'Mozafari', orcid: '0000-0002-1825-0097' }]),      // same ORCID: matched
  ref(5, topic[4], [{ given: '', family: 'Mozafari' }]),                                     // rare surname alone: matched
  ...topic.slice(5).map((t, i) => ref(6 + i, t))
];
p = analyzeCitationPattern(meta, selfRefs, { body });
assert.deepStrictEqual(p.selfCitation.refs.map(s => s.index), [2, 4, 5], JSON.stringify(p.selfCitation.refs.map(s => [s.index, s.matchedBy])));
ok('self-citation: not by a common surname alone, not across different ORCID iDs');

// a heading taken for an author is not a manuscript author
p = analyzeCitationPattern({ ...meta, authors: [{ given: '', family: 'META-ANALYSIS' }] }, [ref(1, topic[0], [{ given: 'K', family: 'Meta-Analysis' }])], { body });
assert.strictEqual(p.manuscriptAuthors.length, 0);
assert.strictEqual(p.selfCitation.refs.length, 0);
ok('"META-ANALYSIS" from the title is not taken as a manuscript author');

// without the manuscript text the old title / abstract comparison still works
p = analyzeCitationPattern(meta, refs);
assert.strictEqual(p.basis, 'title, abstract and keywords');
assert.ok(padding.every((t, i) => p.relevance[12 + i].level === 'weak'), 'padding weak without the body too');
ok('without the manuscript text the padding is still found from the title and abstract');

console.log('citation pattern test passed');
