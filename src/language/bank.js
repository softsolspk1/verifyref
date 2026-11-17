// language/bank.js - PJPS Scribe (Module 6) rule bank: the phrase rules editors of medical and pharmaceutical manuscripts
// correct most, written once and used twice - by the in-house checker (web and desktop, rules.js) and as LanguageTool
// rules on the grammar server (scripts/build-languagetool-rules.js writes them to grammar_custom.xml). Modelled on the
// writing-assistant areas: confused words in medical context, prepositions, forms second-language writers use, plural and
// uncountable nouns, medical and statistical terms, species names, abbreviations, units, redundant acronyms and wordiness.
//
// An entry is [find, to, ctx]: `find` the words flagged; `to` the replacements ('|' between them, '' to delete);
// ctx.b / ctx.a the word that must come just before / after (alternatives with '|', a regular expression for one word);
// ctx.cs: match the case exactly; ctx.m: a message of its own; ctx.xb / ctx.xa: example words when b / a is a pattern.
// Each entry is one rule; its example (built from b, find and a) must be found by both engines (test/language.js and the
// rule build check this).
const fs = require('fs');
const path = require('path');

const groups = [];
const G = (rule, category, title, message, entries, opts = {}) => groups.push({ rule, category, title, message, entries, ...opts });

const LANGS = ['English', 'Urdu', 'Punjabi', 'Sindhi', 'Pashto', 'Balochi', 'Saraiki', 'Arabic', 'Persian', 'Hindi', 'Bengali', 'Chinese', 'Malay', 'Turkish', 'French', 'Spanish', 'Portuguese', 'German', 'Japanese', 'Korean'];
// what may follow the language for the phrase to end there ("in English language teaching" is a compound and is left alone)
const LANG_END = '\\.|,|;|\\)|\\[|and|or|by|with|was|were|is|are|as|to|for|at|from|using|before|after|during';

// ------------------------------------------------------------------ confused words in medical and laboratory writing
const PATIENT_NOUNS = 'were|who|had|received|underwent|aged|enrolled|included|presenting|diagnosed|undergoing|admitted|treated|recruited';
G('medical-confusion', 'correctness', 'Confused words', (f, t) => `"${f}" is a different word here; the medical term is "${t[0]}".`, [
  ['prostrate', 'prostate', { a: 'cancer|gland|hyperplasia|enlargement|carcinoma|tissue|biopsy|volume|tumor|tumour|specific|cells|adenocarcinoma', m: '"Prostrate" means lying face down; the gland is the "prostate".' }],
  ['mucous', 'mucus', { a: 'production|plug|plugs|hypersecretion|clearance|was|is|were', m: '"Mucous" is the adjective (mucous membrane); the substance is "mucus".' }],
  ['mucus', 'mucous', { a: 'membrane|membranes|colitis', m: '"Mucus" is the noun; the adjective is "mucous" (mucous membrane).' }],
  ['palpations', 'palpitations', { b: 'heart|cardiac', m: 'A racing or pounding heartbeat is "palpitations"; "palpation" is examination by touch.' }],
  ['illicit', 'elicit', { a: 'a|an|the|this|these|immune|responses|response', m: '"Illicit" means illegal; "elicit" means to draw out or provoke (elicit a response).' }],
  ['illicited', 'elicited', { m: '"Elicited" (drew out, provoked) is spelled with "e"; "illicit" means illegal.' }],
  ['illicits', 'elicits', { m: '"Elicits" (draws out, provokes) is spelled with "e"; "illicit" means illegal.' }],
  ['elicit', 'illicit', { a: 'drug|drugs|substance|substances|trade|trafficking|use', m: '"Elicit" means to draw out; illegal drugs are "illicit".' }],
  ['discreet', 'discrete', { a: 'variable|variables|data|values|value|units|unit|steps|categories|lesions|nodules|peaks|bands|fragments|particles|domains|populations|distribution|time|intervals', m: '"Discreet" means tactful; separate, distinct values are "discrete".' }],
  ['compliment', 'complement', { a: 'system|activation|cascade|proteins|protein|factor|factors|component|components|receptor|fixation|deposition|levels|each|C3|C4', m: '"Compliment" is praise; the immune proteins and things that complete each other are "complement".' }],
  ['complimentary', 'complementary', { a: 'medicine|DNA|therapies|therapy|strand|strands|sequence|sequences|approach|approaches|methods|techniques|role|roles|information', m: '"Complimentary" means free or praising; "complementary" means completing or alternative (complementary medicine, complementary DNA).' }],
  ['principle', 'principal', { a: 'investigator|investigators|component|components|author|cause|causes|reason|source|aim|objective|axes|axis|constituent|constituents|outcome|finding|findings|mechanism|route|cells', m: '"Principle" is a rule or law; the adjective meaning main is "principal" (principal component, principal investigator).' }],
  ['principal', 'principle', { b: 'basic|general|fundamental|underlying|guiding|working|operating|ethical', m: 'A rule or law is a "principle"; "principal" means main.' }],
  ['insure', 'ensure', { a: 'that|adequate|proper|patient|safety|quality|accuracy|reproducibility|compliance|complete|uniform|homogeneity|sterility|stability', m: '"Insure" is about insurance; "ensure" means to make certain.' }],
  ['adverse', 'averse', { b: 'risk', m: 'Unwilling to take risks is "risk-averse"; "adverse" means harmful.' }],
  ['sight', 'site', { b: 'injection|surgical|binding|active|infection|incision|puncture|tumor|tumour|primary|catalytic|cleavage|insertion|anatomical|study|recruitment|metastatic|application', m: 'A location is a "site" (injection site, binding site); "sight" is vision.' }],
  ['sights', 'sites', { b: 'injection|surgical|binding|active|infection|incision|puncture|catalytic|cleavage|insertion|anatomical|study|recruitment|metastatic|application', m: 'Locations are "sites" (injection sites, binding sites); "sight" is vision.' }],
  ['breathe', 'breath', { b: 'of|deep|bad|fresh', m: '"Breath" is the noun (shortness of breath); "breathe" is the verb.' }],
  ['breath', 'breathe', { b: 'to|cannot|could|unable', a: 'in|out|normally|freely|properly|through|without|spontaneously|deeply|easily|on|and|\\.', xa: 'normally', m: '"Breathe" is the verb; "breath" is the noun.' }],
  ['plain', 'plane', { b: 'sagittal|coronal|axial|transverse|horizontal|frontal|median|focal|occlusal|cleavage|tissue|fascial|image|imaging', m: 'An anatomical or imaging section is a "plane"; "plain" means simple or flat land.' }],
  ['trail', 'trial', { b: 'clinical|randomized|randomised|controlled|crossover|pilot|phase|blind|blinded|multicenter|multicentre|placebo-controlled|open-label|drug|therapeutic|feasibility|interventional|vaccine|II|III|IV', m: 'A study of a treatment is a "trial"; a "trail" is a path.' }],
  ['trails', 'trials', { b: 'clinical|randomized|randomised|controlled|crossover|pilot|blind|blinded|multicenter|multicentre|placebo-controlled|open-label|drug|therapeutic|feasibility|interventional|vaccine', m: 'Studies of a treatment are "trials"; "trails" are paths.' }],
  ['casual', 'causal', { a: 'relationship|relationships|link|links|role|association|associations|effect|effects|inference|factor|factors|agent|agents|pathway|mechanism|connection|organism|organisms|relation|evidence', m: '"Casual" means informal; cause and effect is "causal".' }],
  ['systemic', 'systematic', { a: 'review|reviews|literature|search|searches|error|errors|sampling', m: 'A review that follows a defined method is "systematic"; "systemic" means affecting the whole body.' }],
  ['systematic', 'systemic', { a: 'administration|circulation|inflammation|toxicity|exposure|absorption|lupus|sclerosis|infection|infections|hypertension|candidiasis|corticosteroids|clearance|vascular|vasculitis|inflammatory|immunity|disorder|disorders|side|bioavailability', m: '"Systemic" means affecting the whole body (systemic circulation, systemic lupus); "systematic" means methodical.' }],
  ['excess', 'access', { b: 'have|has|had|limited|easy|free|open|poor|restricted|better|equitable|unrestricted|gain|gained|lack|lacked|lacking|improved|improve|unequal', a: 'to', m: 'Being able to reach or use something is "access"; "excess" means too much.' }],
  ['lead', 'led', { b: 'has|have|had|was|were|been', a: 'to', m: 'The past tense and participle of "lead" is "led" (has led to).' }],
  ['loose', 'lose', { a: 'weight|consciousness|blood|function|activity|efficacy|potency|their|its|viability|integrity', m: '"Loose" means not tight; to stop having something is "lose".' }],
  ['lose', 'loss', { b: 'weight|blood|hair|bone|hearing|vision|memory|appetite|fluid|water|heat|function|cell|neuronal|tooth|muscle|sight', m: 'The noun is "loss" (weight loss); "lose" is the verb.' }],
  ['loosing', 'losing', { a: 'weight|consciousness|blood|their|its|the|control|efficacy|function|activity|patients|viability', m: '"Losing" (no longer having) has one "o"; "loosing" means making loose.' }],
  ['weather', 'whether', { b: 'determine|determined|assess|assessed|evaluate|evaluated|investigate|investigated|examine|examined|know|unclear|unknown|explore|explored|test|tested|check|checked|decide|establish|ascertain|clarify|doubtful|uncertain', m: '"Whether" introduces alternatives; "weather" is the climate.' }],
  ['proceeded', 'preceded', { b: 'was|were|is|are|been', a: 'by', m: 'Coming before something is "preceded by"; "proceed" means to go on.' }],
  ['stationery', 'stationary', { a: 'phase|phases|state|point|points|distribution|cells|period|growth', m: 'Not moving is "stationary" (stationary phase); "stationery" is writing paper.' }],
  ['eluded', 'eluted', { a: 'with|from|by|at|using|in|fractions|fraction|isocratically', m: 'Washing a substance off a column is "eluted"; "eluded" means escaped.' }],
  ['eluding', 'eluting', { a: 'with|from|solvent|solvents|buffer|stent|stents|fractions', m: 'Washing a substance off a column is "eluting"; "eluding" means escaping.' }],
  ['affluent', 'effluent', { b: 'hospital|industrial|textile|pharmaceutical|wastewater|plant|final|treated|untreated|sewage|tannery|municipal', m: 'Discharged waste water is "effluent"; "affluent" means wealthy.' }],
  ['affluents', 'effluents', { b: 'hospital|industrial|textile|pharmaceutical|wastewater|treated|untreated|sewage|tannery|municipal', m: 'Discharged waste waters are "effluents"; "affluent" means wealthy.' }],
  ['vile', 'vial', { b: 'glass|amber|sealed|sterile|each|small|injection|serum|headspace|HPLC|autosampler|scintillation|a|the', m: 'A small container is a "vial"; "vile" means disgusting.' }],
  ['viles', 'vials', { b: 'glass|amber|sealed|sterile|small|injection|serum|headspace|HPLC|autosampler|scintillation|the', m: 'Small containers are "vials"; "vile" means disgusting.' }],
  ['pallet', 'pellet', { b: 'cell|bacterial|cellular|the|a|resulting|final', a: 'was|were|resuspended|obtained|washed|dissolved', m: 'The solid collected by centrifugation is a "pellet"; a "pallet" is a loading platform.' }],
  ['palate', 'pellet', { b: 'cell|bacterial|cellular|resulting|final', a: 'was|were|resuspended|obtained|washed|dissolved', m: 'The solid collected by centrifugation is a "pellet"; the "palate" is the roof of the mouth.' }],
  ['essay', 'assay', { b: 'MTT|ELISA|enzyme|binding|colony|clonogenic|biological|cytotoxicity|viability|luciferase|reporter|DPPH|ABTS|FRAP|antioxidant|inhibition|migration|invasion|wound|scratch|transwell|comet|TUNEL|Griess|Ellman|kinase|radioligand|plaque|microdilution|diffusion|well|disc|disk|hemolysis|haemolysis|cell|SRB|XTT|CCK-8|activity|hemagglutination|neutralization|immunoassay', m: 'A laboratory test is an "assay"; an "essay" is a piece of writing.' }],
  ['essays', 'assays', { b: 'MTT|ELISA|enzyme|binding|colony|clonogenic|biological|cytotoxicity|viability|luciferase|reporter|DPPH|ABTS|FRAP|antioxidant|inhibition|migration|invasion|wound|comet|TUNEL|kinase|radioligand|plaque|microdilution|diffusion|cell|in vitro|activity|these|all', m: 'Laboratory tests are "assays"; "essays" are pieces of writing.' }],
  ['flower', 'flour', { b: 'wheat|rice|maize|soybean|soy|barley|oat|chickpea|cassava|potato|almond|coconut|millet|sorghum|gram|rye|buckwheat|quinoa|banana|lentil', m: 'Ground grain is "flour"; a "flower" is a bloom.' }],
  ['root of administration', 'route of administration', { m: 'The way a drug is given is its "route of administration".' }],
  ['roots of administration', 'routes of administration', { m: 'The ways a drug is given are its "routes of administration".' }],
  ['root', 'route', { b: 'oral|intravenous|intraperitoneal|subcutaneous|intramuscular|parenteral|topical|transdermal|enteral|synthetic|biosynthetic|metabolic|exposure|transmission|intranasal|inhalation|sublingual|rectal|ocular', m: 'The way a drug is given or a reaction proceeds is its "route"; a "root" is part of a plant.' }],
  ['chord', 'cord', { b: 'spinal|vocal|umbilical', m: 'The anatomical structure is a "cord" (spinal cord); a "chord" is in music or geometry.' }],
  ['chords', 'cords', { b: 'spinal|vocal|umbilical', m: 'The anatomical structures are "cords" (vocal cords); "chords" are in music or geometry.' }],
  ['dairy', 'diary', { b: 'food|symptom|sleep|bladder|voiding|headache|seizure|pain|electronic|activity|medication|bleeding|study', m: 'A daily record is a "diary"; "dairy" is milk products.' }],
  ['sever', 'severe', { a: 'pain|disease|infection|infections|cases|case|forms|symptoms|toxicity|damage|hypoglycemia|hypoglycaemia|hypertension|anemia|anaemia|inflammation|adverse|acute|chronic|asthma|depression|malnutrition|dehydration|burns|injury|injuries|bleeding|hemorrhage|haemorrhage|reactions|reaction|impairment|complications|illness|sepsis|pneumonia|obesity|stenosis|fibrosis|form|COVID-19|side', m: '"Sever" means to cut off; very bad or serious is "severe".' }],
  ['compliant', 'complaint', { b: 'chief|presenting|main|common|major|primary|commonest', m: 'A symptom the patient reports is a "complaint" (chief complaint); "compliant" means following rules.' }],
  ['complaint', 'compliant', { b: 'fully|poorly|not|less|more|highly|remained|non', a: 'with|to', m: 'Following treatment or rules is "compliant"; a "complaint" is something reported.' }],
  ['personal', 'personnel', { b: 'medical|healthcare|health|nursing|hospital|laboratory|military|trained|paramedical|qualified|pharmacy|technical', a: 'were|was|are|who|working|involved|should|must|\\.', xa: 'were', m: 'Staff are "personnel"; "personal" means private or individual.' }],
  ['quiet', 'quite', { a: 'similar|different|high|low|large|small|common|rare|good|well|close|often|limited|effective|stable|clear|significant|interesting|consistent|difficult|useful|important|complex|variable|few|strong|weak|long|short|recently|frequently|promising|sensitive|specific|unusual|surprising|obvious|distinct|poor|safe|fast|slow|expensive|low|satisfactory', m: '"Quiet" means silent; "quite" means fairly or completely.' }],
  ['through', 'thorough', { b: 'a|an|more|very|most', a: 'review|investigation|examination|analysis|evaluation|understanding|search|assessment|study|literature|knowledge|history|clinical|physical|cleaning|mixing|washing|check|discussion|inspection', m: '"Through" means passing in one side and out the other; complete and careful is "thorough".' }],
  ['form', 'from', { b: 'collected|purchased|recruited|removed|excluded|separated|eluted|differ|differs|differed|away|apart|ranging|ranged|varied|varies|transferred|withdrawn|harvested|received|resulted|arising|originated|originating|suffering|protected|recovered|discharged|emerged|procured|sourced|supplied|gifted|kindly|donated|retrieved|downloaded|benefit|benefited|benefitted', m: '"Form" is a shape or a document; the preposition is "from".' }],
  ['fist', 'first', { b: 'the|a|for|at|in', a: 'time|step|line|week|day|year|group|trimester|author|dose|visit|stage|phase|generation|degree|order|choice|place|hour|month|days|weeks', m: '"Fist" is a closed hand; the ordinal is "first".' }],
  ['tow', 'two', { a: 'groups|weeks|days|years|times|doses|patients|samples|types|hours|months|different|main|major|separate|independent|consecutive|subgroups|sets|methods|drugs|strains|species|cases', m: '"Tow" means to pull; the number is "two".' }],
  ['filed', 'field', { b: 'magnetic|electric|electromagnetic|visual|research|clinical|medical|pharmaceutical|scientific|open|surgical|microscopic|this|the', a: 'of|study|studies|trial|trials|conditions|strain|strains|survey|data|samples|experiment|experiments|work|isolates|observations|\\.', xa: 'of', m: '"Filed" means put in a file; an area of study or space is a "field".' }],
  ['lager', 'larger', { a: 'than|number|sample|samples|amounts|amount|doses|scale|size|sizes|studies|study|cohort|cohorts|population|populations|particles|area|areas|volume|volumes|groups|trials', m: '"Lager" is a beer; the comparative of "large" is "larger".' }],
  ['exited', 'excited', { a: 'state|states|electrons|electron|molecules|singlet|triplet', m: 'A higher energy level is an "excited" state; "exited" means left.' }],
  ['sings', 'signs', { b: 'vital|clinical|neurological|early|warning|physical|obvious|typical|no|any|these|common|cardinal|toxic|withdrawal', m: '"Sings" is a form of "sing"; clinical findings are "signs".' }],
  ['patience', 'patients', { a: PATIENT_NOUNS, m: '"Patience" is the ability to wait; people under care are "patients".' }],
  ['patience', 'patients', { b: 'diabetic|hypertensive|elderly|cancer|hospitalized|hospitalised|pediatric|paediatric|adult|male|female|ICU|treated|untreated|older|surgical|asthmatic|epileptic|outpatient|inpatient', m: '"Patience" is the ability to wait; people under care are "patients".' }],
  ['effect', 'affect', { b: 'may|might|could|can|negatively|positively|adversely|significantly|directly|not|does|did|do|would|will', a: 'the|their|its|patient|patients|blood|cell|cells|both|our|this|these|survival|quality|drug|liver|kidney|renal|treatment|outcome|outcomes|growth|absorption|bioavailability|metabolism', m: '"Affect" is the verb (to influence); "effect" is usually the noun.' }],
  ['effects', 'affects', { b: 'it|negatively|positively|adversely|significantly|directly|also|only|strongly|greatly|severely', a: 'the|their|its|patient|patients|blood|cell|cells|both|our|survival|quality|drug|liver|kidney|renal|treatment|outcome|outcomes|growth|absorption|bioavailability|metabolism|about|approximately|millions', m: '"Affects" is the verb (influences); "effects" is the noun.' }],
  ['affects', 'effects', { b: 'side|toxic|therapeutic|beneficial|synergistic|inhibitory|harmful|deleterious|cytotoxic|antioxidant|anti-inflammatory|analgesic|pharmacological|biological|long-term|short-term|cardiovascular|hepatoprotective|placebo|its|their|these|additive|antagonistic|dose-dependent|undesirable|unwanted|systemic|toxicological|genotoxic|cardioprotective|neuroprotective', m: '"Effects" is the noun (results); "affects" is the verb.' }],
  ['affect', 'effect', { b: 'toxic|therapeutic|beneficial|synergistic|inhibitory|harmful|deleterious|cytotoxic|antioxidant|anti-inflammatory|analgesic|pharmacological|biological|long-term|short-term|cardiovascular|hepatoprotective|placebo|its|their|additive|antagonistic|dose-dependent|undesirable|systemic|toxicological|genotoxic|cardioprotective|neuroprotective|hypoglycemic|hypoglycaemic|antidiabetic|antimicrobial|antibacterial|antifungal|diuretic|sedative|anxiolytic|antidepressant|anticonvulsant|significant|marked|greater|stronger|weaker|similar|opposite', m: '"Effect" is the noun (a result); "affect" is usually the verb.' }],
  ['advice', 'advise', { b: 'to|would|we|should|strongly|must|may|might|always', a: 'patients|them|that|caution|against|the|him|her|people|clinicians|physicians|pregnant|women|parents|pharmacists|regular|avoiding|using|taking', m: '"Advise" is the verb; "advice" is the noun.' }],
  ['advise', 'advice', { b: 'medical|expert|professional|dietary|nutritional|clinical|sound|seek|seeking|sought|any|some|such|good|general|specific|lifestyle|pharmaceutical|the|their|his|her|our|this', a: 'on|from|of|was|is|about|and|\\.|,', xa: 'on', m: '"Advice" is the noun; "advise" is the verb.' }],
  ['device', 'devise', { b: 'to|we|could|should|must|can|cannot', a: 'a|an|new|strategies|methods|novel|ways|effective|appropriate|better|suitable|treatment|plans|interventions', m: '"Devise" is the verb (to plan); "device" is the noun.' }],
  ['devise', 'device', { b: 'medical|electronic|delivery|implantable|wearable|mobile|intrauterine|drug-delivery|inhalation|this|each|a|the|new|novel|portable|diagnostic|hearing|monitoring|measuring', a: 'was|is|were|for|used|that|which|\\.|,', xa: 'was', m: '"Device" is the noun (an instrument); "devise" is the verb.' }],
  ['bare in mind', 'bear in mind', { m: 'The phrase is "bear in mind".' }],
  ['baring in mind', 'bearing in mind', { m: 'The phrase is "bearing in mind".' }],
  ['everyday', 'every day', { b: 'given|administered|dosed|treated|taken|measured|recorded|monitored|repeated|changed|replaced|fed|weighed|observed|examined|injected|applied|once|twice', m: '"Everyday" is an adjective (everyday life); "each day" is "every day".' }],
  ['overtime', 'over time', { b: 'changes|changed|decreased|increased|declined|improved|varied|evolved|progressed|stable|vary|change|increase|decrease|develop|developed|accumulate|accumulated|decline|improve|progress|worsened|reduced|fluctuated|persisted', m: '"Overtime" is extra working hours; during a period is "over time".' }],
  ['apart of', 'a part of|part of', { b: 'is|was|are|were|be|become|became|being|form|forms|formed', m: '"Apart" means separated; "a part of" means belonging to.' }],
  ['dose', 'does', { b: 'it|which|he|she|what|how', a: 'not', m: 'The verb is "does" (does not); a "dose" is an amount of a drug.' }],
  ['does', 'dose', { b: 'single|daily|higher|lower|high|low|effective|therapeutic|toxic|lethal|oral|loading|maintenance|optimal|recommended|booster|per', na: 'not', m: '"Does" is a verb; an amount of a drug is a "dose".' }],
  ['dosed', 'dose', { b: 'the|a|single|daily|higher|lower|high|low|effective|therapeutic|toxic|lethal|maximum|minimum|oral|loading|maintenance|initial|total|optimal|recommended|booster', a: 'of|was|were|is|range|response|levels|level|group|groups|\\.', xa: 'of', m: '"Dosed" is a verb; the amount given is a "dose".' }],
  ['dysphasia', 'dysphagia', { b: 'oropharyngeal|esophageal|oesophageal|swallowing|solid|liquid|progressive|painful', m: 'Difficulty swallowing is "dysphagia"; "dysphasia" is a language disorder.' }],
  ['callous', 'callus', { b: 'bone|fracture|bony|plantar|cartilaginous|embryogenic|leaf|plant|friable', m: 'Thickened tissue (bone or plant callus) is "callus"; "callous" means unfeeling.' }],
  ['humorous', 'humerus', { b: 'proximal|distal|left|right|fractured|fracture', m: 'The upper arm bone is the "humerus"; "humorous" means funny.' }],
  ['vesical', 'vesicle', { b: 'synaptic|secretory|seminal|extracellular|transport|lipid|endocytic|coated|storage', m: 'A small sac is a "vesicle"; "vesical" refers to the bladder.' }],
  ['naval', 'navel', { b: 'the|umbilicus|umbilical|patient\'s|infant\'s|around', a: 'area|region|level|cord|orange|\\.', xa: 'area', m: 'The umbilicus is the "navel"; "naval" refers to a navy.' }],
  ['aural', 'oral', { a: 'administration|dose|doses|route|cavity|mucosa|hygiene|health|gavage|tablets|intake|bioavailability|contraceptives|contraceptive|hypoglycemic|hypoglycaemic|ulcers|cancer|candidiasis|suspension|solution|drug|drugs|antidiabetic', m: '"Aural" refers to the ear; by mouth is "oral".' }],
  ['perfusion', 'profusion', { b: 'a', a: 'of', m: '"A profusion of" means a large amount; "perfusion" is blood flow through tissue.' }],
  ['incidents', 'incidence', { b: 'high|higher|low|lower|annual|cumulative|overall|global|estimated', a: 'of|rate|rates|was|is|and', xa: 'of', m: 'How often a disease occurs is its "incidence"; "incidents" are events.' }],
  ['prevalent', 'prevalence', { b: 'the|high|higher|low|lower|overall|estimated|reported|global|increasing', a: 'of|rate|rates|was|is', xa: 'of', m: '"Prevalence" is the noun (the prevalence of); "prevalent" is the adjective.' }],
  ['viral', 'virial', { b: 'second', a: 'coefficient', m: 'The thermodynamic coefficient is the "virial" coefficient.' }],
  ['absorbance', 'absorption', { b: 'intestinal|gastrointestinal|oral|drug|percutaneous|dermal|systemic|transdermal|iron|calcium|glucose|nutrient|fat', m: 'Uptake into the body is "absorption"; "absorbance" is a spectrophotometer reading.' }],
  ['absorption', 'absorbance', { a: 'values|value|readings|reading|at', b: 'measured|read|recorded', m: 'A spectrophotometer reading is "absorbance"; "absorption" is uptake.' }],
  ['adsorbed', 'absorbed', { b: 'orally|systemically|percutaneously', m: 'Uptake into the body is "absorbed"; "adsorbed" means held on a surface.' }],
  ['dilatation', 'dilution', { b: 'serial|two-fold|twofold|ten-fold|tenfold|1:10|1:100|further', m: 'Making a solution weaker is "dilution"; "dilatation" is widening.' }],
  ['dissociation', 'dissolution', { b: 'drug|tablet|tablets|in vitro|in-vitro|capsule|capsules', a: 'test|testing|rate|rates|profile|profiles|medium|media|study|studies|apparatus|data|efficiency', xa: 'test', m: 'Drug release into a medium is "dissolution"; "dissociation" is separation into ions or parts.' }],
  ['hypertension', 'hypotension', { b: 'orthostatic|postural', m: 'A fall in blood pressure on standing is "orthostatic hypotension".' }],
  ['perineal', 'peroneal', { a: 'tendon|tendons|artery|muscle|muscles|neuropathy|retinaculum', m: 'The tendons and artery of the lower leg are "peroneal"; "perineal" refers to the perineum.' }],
  ['gait', 'gate', { a: 'control|theory|keeper|keepers', m: 'The pain theory and the controlling point are "gate" (gate control theory); "gait" is walking.' }],
  ['gate', 'gait', { a: 'disturbance|disturbances|abnormalities|abnormality|analysis|speed|velocity|ataxia|disorder|disorders|pattern|patterns|instability|training|impairment', m: 'A manner of walking is a "gait"; a "gate" is a door or barrier.' }],
  ['gate', 'gait', { b: 'abnormal|ataxic|unsteady|spastic|antalgic|shuffling|steppage|waddling|wide-based', m: 'A manner of walking is a "gait"; a "gate" is a door or barrier.' }],
  ['mussel', 'muscle', { a: 'cells|fibres|fibers|tissue|weakness|strength|mass|wasting|tone|relaxation|contraction|relaxant|relaxants|spasm|spasms|cramps|pain|damage|biopsy', m: '"Mussel" is a shellfish; the tissue is "muscle".' }],
  ['mussel', 'muscle', { b: 'skeletal|smooth|cardiac|gastrocnemius|soleus|psoas', m: '"Mussel" is a shellfish; the tissue is "muscle".' }],
  ['strain', 'strand', { b: 'single|double|complementary|template|leading|lagging|antisense|coding', m: 'One chain of DNA or RNA is a "strand" (double-strand break); a "strain" is a variety of organism.' }],
  ['serum', 'sera', { b: 'these|all|both|several|many', a: 'were|are|have', m: 'The plural of "serum" is "sera" (or "serums").' }],
  ['sera', 'serum', { b: 'a|the|each|one|this', a: 'was|is|has|sample|level|levels|concentration|concentrations|creatinine|albumin|glucose|cholesterol|triglycerides|urea', xb: 'the', xa: 'was', m: 'One sample is "serum"; "sera" is the plural.' }]
]);

// ------------------------------------------------------------------ prepositions and fixed expressions
G('preposition', 'correctness', 'Preposition', (f, t) => `The usual expression is "${t[0]}".`, [
  ['associated to', 'associated with'], ['association to', 'association with', { b: 'its|their|the|an|in|significant|strong|positive|negative' }], ['consistent to', 'consistent with'], ['in consistent with', 'consistent with'],
  ['in accordance to', 'in accordance with'], ['in agreement to', 'in agreement with'], ['in compliance to', 'in compliance with'], ['comply to', 'comply with'], ['complied to', 'complied with'],
  ['complies to', 'complies with'], ['similar with', 'similar to'], ['superior than', 'superior to'], ['inferior than', 'inferior to'], ['preferred than', 'preferred to|preferred over'],
  ['prefer than', 'prefer to'], ['compared than', 'compared with'], ['different with', 'different from'], ['differ with', 'differ from'], ['differs with', 'differs from'], ['differed with', 'differed from'],
  ['responsible of', 'responsible for'], ['capable to', 'capable of'], ['interested on', 'interested in'], ['depend of', 'depend on'], ['depends of', 'depends on'], ['depended of', 'depended on'],
  ['dependent of', 'dependent on'], ['resulted to', 'resulted in'], ['resulting to', 'resulting in'], ['result to', 'result in', { b: 'may|might|can|could|will|would|to|also|not' }],
  ['contribute in', 'contribute to', { a: 'the|a|an|its|their|this|these|reducing|increasing|improving|lowering|controlling|preventing|maintaining' }], ['contributed in', 'contributed to', { a: 'the|a|an|its|their|this|these|reducing|increasing|improving|lowering|controlling|preventing|maintaining' }],
  ['contributes in', 'contributes to', { a: 'the|a|an|its|their|this|these|reducing|increasing|improving|lowering|controlling|preventing|maintaining' }],
  ['participate on', 'participate in'], ['participated on', 'participated in'], ['succeed to', 'succeed in'], ['succeeded to', 'succeeded in'],
  ['emphasize on', 'emphasize'], ['emphasise on', 'emphasise'], ['emphasized on', 'emphasized'], ['emphasised on', 'emphasised'], ['emphasizes on', 'emphasizes'], ['emphasises on', 'emphasises'],
  ['discuss about', 'discuss', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['discussed about', 'discussed', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['discusses about', 'discusses', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['discussing about', 'discussing', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }],
  ['mention about', 'mention', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['mentioned about', 'mentioned', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['explain about', 'explain', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['explained about', 'explained', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['describe about', 'describe', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['described about', 'described', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }],
  ['investigate about', 'investigate', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['investigated about', 'investigated', { na: '\\d+(?:[.,]\\d+)?%?|half|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|a|an' }], ['focus about', 'focus on'], ['focused about', 'focused on'], ['focussed about', 'focused on'],
  ['comprise of', 'comprise|consist of'], ['comprises of', 'comprises|consists of'], ['comprising of', 'comprising|consisting of'],
  ['consist from', 'consist of'], ['consisted from', 'consisted of'], ['consists from', 'consists of'], ['consisting from', 'consisting of'],
  ['lacks of', 'lacks'], ['lacked of', 'lacked'], ['lacking of', 'lacking'], ['reached to', 'reached'], ['cope up with', 'cope with'], ['coped up with', 'coped with'],
  ['regarding to', 'regarding'], ['despite of', 'despite'], ['inspite of', 'in spite of'], ['in spite the', 'in spite of the|despite the'], ['according with', 'according to'], ['accordingly to', 'according to'],
  ['in the other hand', 'on the other hand'], ['at the other hand', 'on the other hand'], ['in contrary to', 'contrary to'], ['in contrary', 'on the contrary', { a: ',' }], ['on contrary', 'on the contrary'], ['in the contrary', 'on the contrary'],
  ['in addition with', 'in addition to'], ['in addition of', 'in addition to'], ['with respect of', 'with respect to'], ['with regards to', 'with regard to'], ['in regards of', 'with regard to'],
  ['in contrast of', 'in contrast to'], ['in line of', 'in line with'], ['in terms with', 'in terms of'], ['on basis of', 'on the basis of'], ['in the basis of', 'on the basis of'], ['on the basis on', 'on the basis of'],
  ['in the end of', 'at the end of'], ['sensitive for', 'sensitive to', { a: 'light|heat|temperature|oxygen|moisture|antibiotics|ampicillin|penicillin|vancomycin|ciprofloxacin|gentamicin|treatment|insulin|drugs|changes' }],
  ['susceptible for', 'susceptible to'], ['resistant for', 'resistant to'], ['resistance for', 'resistance to', { a: 'antibiotics|ampicillin|penicillin|vancomycin|ciprofloxacin|gentamicin|methicillin|carbapenems|insulin|drugs|treatment|chemotherapy|the|multiple|most|all|antimicrobials|antimicrobial' }],
  ['exposed with', 'exposed to'], ['allergic with', 'allergic to'], ['pertaining with', 'pertaining to'], ['related with', 'related to'], ['subjected with', 'subjected to'],
  ['accustomed with', 'accustomed to'], ['adhere with', 'adhere to'], ['abide with', 'abide by'], ['insight on', 'insight into'], ['insights on', 'insights into'],
  ['deficient of', 'deficient in'], ['rich of', 'rich in'], ['abundant of', 'abundant in'], ['soluble with', 'soluble in'], ['insoluble with', 'insoluble in'],
  ['role on', 'role in', { b: 'important|key|crucial|vital|major|significant|essential|pivotal|central|critical|protective|potential|possible|a|an|its|their' }],
  ['concern on', 'concern about'], ['concerns on', 'concerns about'], ['aware about', 'aware of'], ['satisfied from', 'satisfied with'], ['satisfaction from', 'satisfaction with'],
  ['divided in', 'divided into', { a: 'three|four|five|six|seven|eight|nine|ten|\\d+|groups|several|equal', xa: 'three' }], ['categorized in', 'categorized into', { a: 'two|three|four|five|six|\\d+|groups|several', xa: 'two' }], ['categorised in', 'categorised into', { a: 'two|three|four|five|six|\\d+|groups|several', xa: 'two' }],
  ['classified in', 'classified into', { a: 'two|three|four|five|six|\\d+|groups|several', xa: 'two' }],
  ['accompanied with', 'accompanied by'], ['followed with', 'followed by', { b: 'was|were|is|are|been' }], ['preceded with', 'preceded by'], ['characterized with', 'characterized by'], ['characterised with', 'characterised by'],
  ['caused from', 'caused by'], ['made up from', 'made up of'], ['full with', 'full of'],
  ['as compare to', 'compared with|as compared with'], ['in compare to', 'compared with'], ['comparing to', 'compared with', { b: 'when|as|while|,' , xb: 'when'}], ['when compare with', 'when compared with'], ['when compare to', 'when compared with'],
  ['in comparison of', 'in comparison with'], ['in comparison with to', 'in comparison with'], ['till date', 'to date'], ['till now', 'to date|so far'], ['up till now', 'to date|so far'],
  ['since long', 'for a long time'], ['besides of', 'besides'], ['married with', 'married to'], ['prior than', 'before|prior to'],
  ['affect on', 'effect on|affect', { m: '"Affect" is a verb and takes no "on"; the noun is "effect on".' }], ['affects on', 'effects on|affects', { m: '"Affects" is a verb and takes no "on"; the noun is "effects on".' }],
  ['impact of on', 'impact on'], ['effect of on', 'effect on'],
  ['medical adherence', 'medication adherence'], ['medicine adherence', 'medication adherence'], ['drug adherence', 'medication adherence|adherence to the drug'],
  ['the similar pattern', 'a similar pattern'], ['the similar trend', 'a similar trend'], ['the similar results', 'similar results'], ['the similar findings', 'similar findings'],
  ['a need of', 'a need for'], ['the need of', 'the need for', { a: '[a-z]+ing|more|further|new|better|effective|a|an|the', xa: 'more' }], ['due to absence of', 'due to the absence of'], ['in absence of', 'in the absence of'],
  ['in presence of', 'in the presence of'], ['after completion of', 'after the completion of'], ['before completion of', 'before the completion of'], ['In case of', 'In the case of', { cs: true, a: 'participants|patients|children|women|men|students|respondents|subjects|those', xa: 'patients' }],
  ['interviews were taken', 'interviews were conducted'], ['interview was taken', 'interview was conducted'], ['according to Health Belief Model', 'according to the Health Belief Model'],
  ['on impact of', 'on the impact of'], ['on effect of', 'on the effect of'], ['on role of', 'on the role of'], ['about importance of', 'about the importance of'],
  // third comparison with Grammarly on document 7
  ['prior the', 'prior to the'], ['prior this', 'prior to this'], ['prior their', 'prior to their'],
  ...['with', 'in', 'by', 'to', 'for', 'from', 'on'].flatMap(p => ['limited', 'small', 'large'].map(s => [`${p} ${s} number of`, `${p} a ${s} number of`])),
  ...['demonstrating', 'demonstrated', 'demonstrates', 'showing', 'showed', 'shows', 'had', 'has', 'have', 'having'].flatMap(v => ['positive', 'negative', 'significant'].map(s => [`${v} ${s} impact`, `${v} a ${s} impact`])),
  ['There was also similar', 'There was also a similar', { cs: true, a: '(?:slight |small |modest |marked |significant )?(?:increase|decrease|trend|pattern|improvement|rise|decline|reduction|change)', xa: 'increase' }],
  ['There was similar', 'There was a similar', { cs: true, a: '(?:slight |small |modest |marked |significant )?(?:increase|decrease|trend|pattern|improvement|rise|decline|reduction|change)', xa: 'increase' }],
  ['due to immunocompromised state', 'due to an immunocompromised state'], ['in immunocompromised state', 'in an immunocompromised state'],
  ['translating procedures', 'translation procedures'], ['translating procedure', 'translation procedure'], ['deeply penetrated in', 'deeply ingrained in|deeply rooted in'],
  ['be benefited from', 'benefit from'], ['be greatly benefited from', 'greatly benefit from'], ['be benefitted from', 'benefit from'],
  ['Author declare', 'Authors declare', { cs: true }], ['Authors declares', 'Authors declare', { cs: true }],
  // comparison with Grammarly on document 8
  ['the highest number of', 'the most', { a: '[a-z]+s', xa: 'reports' }], ['the lowest number of', 'the fewest', { a: '[a-z]+s', xa: 'reports' }],
  ['re-uptake', 'reuptake'], ['publishment', 'publication'], ['MySQ', 'MySQL', { cs: true }],
  ['The dataset generated', 'The datasets generated', { cs: true, a: 'during|and|or' , xa: 'during' }], ['The data set generated', 'The datasets generated', { cs: true, a: 'during|and|or', xa: 'during' }],
  ...['strong', 'high', 'low', 'small', 'large', 'weak', 'rare', 'severe', 'important', 'significant', 'sensitive', 'toxic', 'potent', 'difficult', 'useful', 'effective', 'dangerous', 'variable', 'heterogeneous', 'limited'].map(a => [`extreme ${a}`, `extremely ${a}`]),
  ['Linkert scale', 'Likert scale'], ['Linkert-type', 'Likert-type'], ['Lickert scale', 'Likert scale'], ['Lickert-type', 'Likert-type'],
  // fourth comparison (document 7): "in English language" -> in English; "in Urdu or Punjabi language" -> in Urdu or Punjabi
  ...LANGS.map(l => [`${l} language`, l, { cs: true, b: 'in|into|or|and', a: LANG_END, xb: 'in', xa: 'by' }]),
  // fifth pass (document 7): "Fully compliant to complete regimen" -> compliant with; not "compliance to take the medication"
  ...['compliant to', 'compliance to', 'non-compliant to', 'non-compliance to', 'noncompliance to'].map(f => [f, f.replace(/to$/, 'with'), { a: 'the|a|an|their|his|her|its|this|these|treatment|therapy|medication|medications|medicine|medicines|regimen|regimens|complete|full|guidelines|protocol|protocols|drugs|drug|diet|instructions|ART|antiretroviral|antihypertensive|antitubercular|insulin', xa: 'treatment' }]),
  // "The study design employed was quasi-experimental pre-test/post-test design" -> was a quasi-experimental
  ...['was', 'is'].flatMap(v => ['quasi-experimental', 'cross-sectional', 'prospective', 'retrospective', 'descriptive', 'observational', 'randomized', 'randomised', 'single-blind', 'double-blind', 'open-label', 'multicenter', 'multicentre'].map(d =>
    [`${v} ${d}`, `${v} ${/^[aeiou]/.test(d) ? 'an' : 'a'} ${d}`, { a: 'design|study|trial|survey|pre-test/post-test|pretest-posttest|pre-test|cohort|case-control|controlled|clinical|comparative|analytical', xa: 'study' }]))
]);

// ------------------------------------------------------------------ grammar second-language writers often need corrected
G('l2-grammar', 'correctness', 'Grammar', (f, t) => `"${f}" is not standard English; write "${t[0]}".`, [
  ['was consisted of', 'consisted of'], ['were consisted of', 'consisted of'], ['is consisted of', 'consists of'], ['are consisted of', 'consist of'], ['is consist of', 'consists of'], ['are consist of', 'consist of'], ['was consist of', 'consisted of'],
  ['were participated in', 'participated in'], ['was participated in', 'participated in'], ['was happened', 'happened'], ['were happened', 'happened'], ['is happened', 'happens|has happened'],
  ['has been occurred', 'has occurred'], ['have been occurred', 'have occurred'], ['had been occurred', 'had occurred'], ['was occurred', 'occurred'], ['were occurred', 'occurred'], ['is occurred', 'occurs|has occurred'], ['are occurred', 'occur|have occurred'],
  ['was existed', 'existed'], ['were existed', 'existed'], ['is existed', 'exists'], ['are existed', 'exist'], ['was died', 'died'], ['were died', 'died'], ['are died', 'have died|died'], ['have been died', 'have died'],
  ['was belonged', 'belonged'], ['were belonged', 'belonged'], ['is belonged', 'belongs'], ['are belonged', 'belong'], ['is belong to', 'belongs to'], ['are belong to', 'belong to'],
  ['was resulted in', 'resulted in'], ['were resulted in', 'resulted in'], ['is resulted in', 'results in'], ['are resulted in', 'result in'], ['has been resulted in', 'has resulted in'],
  ['was appeared', 'appeared'], ['were appeared', 'appeared'], ['was emerged', 'emerged'], ['were emerged', 'emerged'], ['was arisen', 'arose'], ['were arisen', 'arose'],
  ['was remained', 'remained'], ['were remained', 'remained'], ['was seemed', 'seemed'], ['were seemed', 'seemed'], ['was disappeared', 'disappeared'], ['were disappeared', 'disappeared'],
  ['was survived', 'survived'], ['were survived', 'survived'], ['was suffered from', 'suffered from'], ['were suffered from', 'suffered from'],
  ['is depend on', 'depends on'], ['are depend on', 'depend on'], ['was depend on', 'depended on'], ['were depend on', 'depended on'], ['is contain', 'contains'], ['are contain', 'contain'],
  ['is exist', 'exists'], ['are exist', 'exist'], ['is occur', 'occurs'], ['are occur', 'occur'], ['is require', 'requires'], ['are require', 'require'], ['is includes', 'includes'], ['are includes', 'include'],
  ['had underwent', 'had undergone'], ['have underwent', 'have undergone'], ['has underwent', 'has undergone'], ['was underwent', 'underwent'], ['were underwent', 'underwent'], ['had undergo', 'had undergone'],
  ['has took', 'has taken'], ['have took', 'have taken'], ['had took', 'had taken'], ['has began', 'has begun'], ['have began', 'have begun'], ['had began', 'had begun'],
  ['has became', 'has become'], ['have became', 'have become'], ['had became', 'had become'], ['has went', 'has gone'], ['have went', 'have gone'], ['had went', 'had gone'],
  ['has saw', 'has seen'], ['have saw', 'have seen'], ['had saw', 'had seen'], ['has wrote', 'has written'], ['have wrote', 'have written'], ['had wrote', 'had written'],
  ['has gave', 'has given'], ['have gave', 'have given'], ['had gave', 'had given'], ['has came', 'has come'], ['have came', 'have come'], ['had came', 'had come'],
  ['has grew', 'has grown'], ['have grew', 'have grown'], ['has drew', 'has drawn'], ['have drew', 'have drawn'], ['has chose', 'has chosen'], ['have chose', 'have chosen'],
  ['has fell', 'has fallen'], ['have fell', 'have fallen'], ['has rose', 'has risen'], ['have rose', 'have risen'], ['had rose', 'had risen'], ['has arose', 'has arisen'], ['have arose', 'have arisen'],
  ['has broke', 'has broken'], ['have broke', 'have broken'], ['has knew', 'has known'], ['have knew', 'have known'], ['has undertook', 'has undertaken'], ['have undertook', 'have undertaken'],
  ['has showed', 'has shown'], ['have showed', 'have shown'], ['had showed', 'had shown'], ['has spoke', 'has spoken'], ['have spoke', 'have spoken'], ['has forgot', 'has forgotten'],
  ['has show', 'has shown'], ['have show', 'have shown'], ['has shew', 'has shown'], ['was took', 'was taken'], ['were took', 'were taken'], ['was gave', 'was given'], ['were gave', 'were given'],
  ['was wrote', 'was written'], ['were wrote', 'were written'], ['was chose', 'was chosen'], ['were chose', 'were chosen'], ['was drew', 'was drawn'], ['were drew', 'were drawn'],
  ['was shook', 'was shaken'], ['were shook', 'were shaken'], ['was froze', 'was frozen'], ['were froze', 'were frozen'], ['was forbade', 'was forbidden'], ['was hid', 'was hidden'],
  ['did not showed', 'did not show'], ['did not found', 'did not find'], ['did not had', 'did not have'], ['did not received', 'did not receive'], ['did not differed', 'did not differ'], ['did not changed', 'did not change'],
  ['did not increased', 'did not increase'], ['did not decreased', 'did not decrease'], ['did not affected', 'did not affect'], ['did not reached', 'did not reach'], ['did not exhibited', 'did not exhibit'],
  ['does not showed', 'does not show'], ['does not shows', 'does not show'], ['does not exists', 'does not exist'], ['does not has', 'does not have'], ['does not contains', 'does not contain'],
  ['do not showed', 'do not show'], ['could not found', 'could not find|could not be found'], ['can not', 'cannot', { na: 'only|just|merely|simply|be', m: 'Write "cannot" as one word.' }],
  ['more better', 'better'], ['more worse', 'worse'], ['more higher', 'higher'], ['more lower', 'lower'], ['more greater', 'greater'], ['more larger', 'larger'], ['more smaller', 'smaller'],
  ['more stronger', 'stronger'], ['more weaker', 'weaker'], ['more easier', 'easier'], ['more faster', 'faster'], ['more longer', 'longer'], ['more shorter', 'shorter'], ['more lesser', 'less|lesser'],
  ['most highest', 'highest'], ['most lowest', 'lowest'], ['most best', 'best'], ['most greatest', 'greatest'], ['most largest', 'largest'], ['most smallest', 'smallest'], ['most commonest', 'most common|commonest'],
  ['more superior', 'superior'], ['more inferior', 'inferior'], ['more preferable', 'preferable'], ['much more higher', 'much higher'], ['very much higher', 'much higher'],
  ['lesser number', 'smaller number'], ['less number of', 'fewer|a smaller number of'], ['lesser amount', 'smaller amount'],
  ['the both', 'both|both the'], ['the most of', 'most of'], ['an another', 'another'], ['a another', 'another'], ['the another', 'another|the other'], ['each others', 'each other'],
  ['so called', 'so-called', { na: 'because|since|as' }], ['in last', 'in the last', { a: 'few|two|three|four|five|ten|several|decade|decades|years|year|\\d+', xa: 'few' }], ['from last', 'for the last|over the last', { a: 'few|two|three|four|five|ten|several|decade|decades|\\d+', xa: 'few' }],
  ['since last', 'for the last|over the last', { a: 'few|two|three|four|five|ten|several|decade|decades|\\d+', xa: 'few' }], ['since past', 'for the past|over the past', { a: 'few|two|three|four|five|ten|several|decade|decades|\\d+', xa: 'few' }],
  ['elder patients', 'older patients'], ['elder people', 'older people'], ['elder adults', 'older adults'], ['elder population', 'older population'], ['elder subjects', 'older subjects'], ['elder women', 'older women'], ['elder men', 'older men'],
  ['cent percent', '100%|completely'], ['do the needful', 'do what is necessary'], ['prepone', 'bring forward|move earlier'], ['preponed', 'brought forward|moved earlier'],
  ['upto', 'up to'], ['alongwith', 'along with'], ['along-with', 'along with'], ['inorder to', 'in order to'], ['eventhough', 'even though'], ['evenif', 'even if'], ['ofcourse', 'of course'],
  ['Further more', 'Furthermore', { cs: true }], ['More over', 'Moreover', { cs: true }], ['never the less', 'nevertheless'], ['none the less', 'nonetheless'],
  ['non the less', 'nonetheless'], ['where as', 'whereas'], ['Where as', 'Whereas', { cs: true }], ['there fore', 'therefore'], ['There fore', 'Therefore', { cs: true }], ['where by', 'whereby'], ['hence forth', 'henceforth'],
  ['what so ever', 'whatsoever'], ['in so far as', 'insofar as']
]);

// ------------------------------------------------------------------ uncountable nouns and Latin plurals
G('noun-number', 'correctness', 'Noun form', (f, t) => `"${f}" is not used in this form; write "${t[0]}".`, [
  ['informations', 'information', { m: '"Information" is uncountable and has no plural.' }], ['knowledges', 'knowledge', { m: '"Knowledge" is uncountable and has no plural.' }],
  ['equipments', 'equipment', { m: '"Equipment" is uncountable and has no plural.' }], ['advices', 'advice', { m: '"Advice" is uncountable; the plural is "pieces of advice".' }],
  ['feedbacks', 'feedback', { m: '"Feedback" is uncountable and has no plural.' }], ['softwares', 'software|software programs', { m: '"Software" is uncountable; write "software" or "software programs".' }],
  ['literatures', 'literature', { m: '"Literature" (published research) is uncountable.' }], ['datas', 'data', { m: '"Data" is already plural.' }], ['researchs', 'research|studies', { m: '"Research" is uncountable.' }],
  ['machineries', 'machinery'], ['expertises', 'expertise'], ['personnels', 'personnel'], ['guidances', 'guidance'], ['assistances', 'assistance'], ['nutritions', 'nutrition'], ['healths', 'health'],
  ['evidences', 'evidence', { b: 'these|the|many|several|some|other|more|clinical|scientific|experimental|accumulating|growing|strong|recent|previous|such|various|numerous|multiple|further|available|existing|current|epidemiological|preclinical|of', m: '"Evidence" is uncountable; write "evidence" (or "lines of evidence").' }],
  ['evidences', 'evidence', { a: 'show|showed|shown|suggest|suggested|indicate|indicated|have|are|were|support|supported|from|that|demonstrate|demonstrated|point', m: '"Evidence" is uncountable; write "evidence" (or "lines of evidence") and a singular verb.' }],
  ['researches', 'studies|research', { b: 'many|several|various|numerous|previous|recent|these|those|some|other|few|earlier|different|multiple|the|such|further|extensive|clinical|scientific|past|prior|similar|current|published|our', m: '"Research" is uncountable; write "studies" or "research".' }],
  ['researches', 'studies|research', { a: 'have|show|showed|shown|suggest|suggested|indicate|indicated|reported|revealed|demonstrated|found|are|were|on|conducted|carried|done', m: '"Research" is uncountable; write "studies" or "research".' }],
  ['trainings', 'training|training sessions', { b: 'the|several|various|many|these|different|regular|specific|special|professional|clinical|online|practical|formal|in-service', m: '"Training" is usually uncountable; write "training" or "training sessions".' }],
  ['staffs', 'staff|staff members', { b: 'medical|nursing|hospital|health|healthcare|clinical|pharmacy|laboratory|the|all|our|support|technical|administrative|other', m: 'People employed are "staff" (or "staff members"); "staffs" means rods or poles.' }],
  ['progresses', 'progress', { b: 'the|these|recent|great|significant|many|rapid|considerable|remarkable|major|substantial', m: '"Progress" (advances) is uncountable.' }],
  ['managements', 'management', { b: 'the|disease|clinical|patient|pain|their|its|medical|surgical|therapeutic|treatment|different|various', m: '"Management" (of a disease) is uncountable.' }],
  ['damages', 'damage', { b: 'liver|kidney|renal|tissue|cell|cellular|DNA|oxidative|hepatic|cardiac|brain|nerve|neuronal|organ|structural|mucosal|membrane|vascular|endothelial|myocardial|tubular|histological|histopathological|gastric|testicular|pancreatic|retinal|lung|pulmonary', m: 'Physical harm to tissue is "damage" (uncountable); "damages" is money awarded by a court.' }],
  ['a criteria', 'a criterion', { m: '"Criteria" is plural; one is a "criterion".' }], ['one criteria', 'one criterion', { m: '"Criteria" is plural; one is a "criterion".' }], ['this criteria', 'this criterion|these criteria', { m: '"Criteria" is plural; one is a "criterion".' }],
  ['each criteria', 'each criterion'], ['the criteria was', 'the criteria were|the criterion was'], ['the criteria is', 'the criteria are|the criterion is'],
  ['a phenomena', 'a phenomenon'], ['this phenomena', 'this phenomenon|these phenomena'], ['the phenomena is', 'the phenomenon is|the phenomena are'],
  ['a bacteria', 'a bacterium|a bacterial species', { m: '"Bacteria" is plural; one is a "bacterium".' }], ['this bacteria', 'this bacterium|these bacteria'], ['the bacteria is', 'the bacteria are|the bacterium is'], ['the bacteria was', 'the bacteria were|the bacterium was'],
  ['bacterias', 'bacteria'], ['a fungi', 'a fungus'], ['this fungi', 'this fungus|these fungi'], ['these fungus', 'these fungi'], ['the fungi is', 'the fungi are|the fungus is'],
  ['a nuclei', 'a nucleus'], ['these nucleus', 'these nuclei'], ['a stimuli', 'a stimulus'], ['these stimulus', 'these stimuli'], ['a larvae', 'a larva'], ['these larva', 'these larvae'],
  ['a mitochondria', 'a mitochondrion'], ['the mitochondria is', 'the mitochondria are|the mitochondrion is'], ['a spectra', 'a spectrum'], ['these spectrum', 'these spectra'], ['the spectra was', 'the spectra were|the spectrum was'],
  ['a vertebrae', 'a vertebra'], ['a metastases', 'a metastasis'], ['these metastasis', 'these metastases'], ['a diagnoses', 'a diagnosis'], ['these diagnosis', 'these diagnoses'],
  ['these analysis', 'these analyses'], ['those analysis', 'those analyses'], ['several analysis', 'several analyses'], ['many analysis', 'many analyses'], ['multiple analysis', 'multiple analyses'], ['both analysis', 'both analyses'],
  ['an analyses', 'an analysis'], ['this analyses', 'this analysis|these analyses'], ['these hypothesis', 'these hypotheses'], ['several hypothesis', 'several hypotheses'], ['a hypotheses', 'a hypothesis'],
  ['a media', 'a medium'], ['each media', 'each medium'], ['a matrices', 'a matrix'], ['these matrix', 'these matrices'], ['these appendix', 'these appendices'], ['a formulae', 'a formula'],
  ['these index', 'these indices|these indexes'], ['a indices', 'an index'], ['an indices', 'an index'], ['a bacilli', 'a bacillus'], ['these bacillus', 'these bacilli'],
  ['a cocci', 'a coccus'], ['a ova', 'an ovum'], ['an ova', 'an ovum'], ['a genera', 'a genus'], ['these genus', 'these genera'], ['a taxa', 'a taxon'], ['these taxon', 'these taxa'],
  ['a protozoa', 'a protozoan'], ['a corpora', 'a corpus'], ['a strata', 'a stratum'], ['a sera', 'a serum'], ['a foci', 'a focus'], ['these focus', 'these foci'], ['a emboli', 'an embolus'], ['an emboli', 'an embolus'],
  ['a thrombi', 'a thrombus'], ['these thrombus', 'these thrombi'], ['a calculi', 'a calculus'], ['a lumina', 'a lumen'], ['a alveoli', 'an alveolus'], ['an alveoli', 'an alveolus'], ['a villi', 'a villus'],
  ['a ganglia', 'a ganglion'], ['these ganglion', 'these ganglia'], ['a stomata', 'a stoma'], ['a sequelae', 'a sequela'], ['a sequalae', 'a sequela'], ['sequalae', 'sequelae']
]);

// ------------------------------------------------------------------ medical, pharmaceutical and statistical terms
const ANTI = 'oxidant oxidants oxidative inflammatory microbial microbials bacterial fungal viral cancer diabetic biotic biotics body bodies coagulant coagulants hypertensive depressant depressants emetic pyretic septic histamine histamines tumor tumour proliferative convulsant convulsants psychotic psychotics malarial platelet spasmodic diarrheal diarrhoeal ulcer arthritic nociceptive tubercular retroviral epileptic obesity aging angiogenic apoptotic cholinergic allergic asthmatic arrhythmic anxiety thrombotic hyperglycemic hyperglycaemic hyperlipidemic hyperlipidaemic leishmanial plasmodial parasitic protozoal fertility venom toxin serum sera mycobacterial helminthic'.split(' ');
const ANTI_FORM = { inflammatory: 'anti-inflammatory', obesity: 'anti-obesity', aging: 'anti-aging', apoptotic: 'anti-apoptotic', anxiety: 'anti-anxiety', ulcer: 'antiulcer|anti-ulcer', helminthic: 'anthelmintic' };
// a hyphen where the dictionaries close the word up (anti-microbial -> antimicrobial); both forms are standard for these
const ANTI_HYPHEN_OK = new Set(['inflammatory', 'obesity', 'aging', 'apoptotic', 'anxiety', 'ulcer', 'cancer', 'diabetic', 'hypertensive', 'emetic', 'proliferative', 'malarial', 'platelet', 'epileptic', 'arrhythmic', 'thrombotic', 'hyperlipidemic', 'hyperlipidaemic', 'parasitic', 'tumor', 'tumour', 'tubercular', 'angiogenic', 'diarrheal', 'diarrhoeal', 'arthritic', 'leishmanial', 'plasmodial', 'protozoal', 'hyperglycemic', 'hyperglycaemic', 'fertility', 'allergic', 'asthmatic', 'mycobacterial', 'nociceptive', 'convulsant', 'convulsants', 'coagulant', 'coagulants', 'retroviral']);
const TERMS = [];
for (const w of ANTI) {
  const right = ANTI_FORM[w] || `anti${w}`;
  TERMS.push([`anti ${w}`, right]);
  if (!ANTI_HYPHEN_OK.has(w) && !ANTI_FORM[w]) TERMS.push([`anti-${w}`, right]);
}
TERMS.push(['antiinflammatory', 'anti-inflammatory'], ['antihelminthic', 'anthelmintic'], ['anti-helminthic', 'anthelmintic'], ['anti-helmintic', 'anthelmintic'], ['antihelmintic', 'anthelmintic']);
// prefix + word written apart or hyphenated where medicine writes one word
const CLOSED = {
  hepato: 'protective toxicity toxic cellular biliary megaly', nephro: 'protective toxicity toxic pathy', neuro: 'protective protection transmitter transmitters degenerative degeneration inflammation toxicity toxic logical',
  cardio: 'protective vascular myopathy toxicity toxic', gastro: 'protective intestinal enteritis', immuno: 'modulatory suppressive suppression histochemistry histochemical fluorescence compromised therapy globulin',
  cyto: 'toxicity toxic plasm kine kines', geno: 'toxicity toxic', bio: 'availability equivalence film films marker markers assay assays chemical chemistry degradable compatible compatibility active activity synthesis informatics statistics safety technology medical',
  pharmaco: 'kinetics kinetic dynamics dynamic vigilance logical logy gnosy genomics economics therapy', phyto: 'chemical chemicals chemistry constituents therapy sterols', nano: 'particles particle technology emulsion formulation formulations carrier carriers',
  micro: 'organisms organism biota biome plate plates pipette environment array arrays spheres capsules emulsion nutrients scope scopic', macro: 'phages phage molecules nutrients',
  poly: 'phenols phenolic saccharides saccharide pharmacy', hyper: 'tension glycemia glycaemia lipidemia lipidaemia sensitivity activity thyroidism trophy plasia kalemia uricemia cholesterolemia',
  hypo: 'tension glycemia glycaemia thyroidism kalemia albuminemia', dys: 'function lipidemia lipidaemia pnea pnoea', endo: 'thelial crine',
  intra: 'venous venously muscular muscularly peritoneal peritoneally cellular dermal thecal nasal nasally ocular operative uterine', sub: 'cutaneous cutaneously lingual',
  trans: 'dermal fection', inter: 'leukin leukins feron', post: 'partum menopausal natal operatively', pre: 'menopausal clinical natal requisite',
  ante: 'natal', co: 'morbidities morbidity morbid factor factors enzyme enzymes', multi: 'center centre drug variate', uni: 'variate', bi: 'variate',
  psycho: 'social therapy', cerebro: 'vascular', musculo: 'skeletal', naso: 'gastric', myo: 'cardial', osteo: 'arthritis porosis', athero: 'sclerosis',
  thrombo: 'cytopenia', hemo: 'globin dialysis lysis', haemo: 'globin dialysis lysis', chemo: 'therapy', radio: 'therapy', physio: 'therapy', photo: 'therapy synthesis',
  electro: 'phoresis', spectro: 'photometer photometric photometry', histo: 'pathology pathological', patho: 'physiology genesis', over: 'weight dose expression expressed', under: 'weight',
  up: 'regulation regulated', down: 'regulation regulated'
};
// the hyphenated form is standard too (post-operative, co-administration): only the form written apart is reported
const HYPHEN_OK = /^(?:post-operatively|co-morbidities|co-morbidity|co-morbid|post-partum|post-natal|pre-natal|ante-natal|pre-clinical|post-menopausal|pre-menopausal|up-regulation|down-regulation|up-regulated|down-regulated|co-factor|co-enzyme|co-enzymes|co-factors|multi-center|multi-centre|over-expression|over-expressed|bio-active|intra-operative|micro-organisms|micro-organism|hyper-activity|neuro-logical|bio-statistics)$/;
for (const [pre, rest] of Object.entries(CLOSED)) {
  for (const w of rest.split(' ')) {
    const closed = pre + w;
    TERMS.push([`${pre} ${w}`, closed]);
    if (!HYPHEN_OK.test(`${pre}-${w}`)) TERMS.push([`${pre}-${w}`, closed]);
  }
}
TERMS.push(
  ['in-vitro', 'in vitro'], ['in-vivo', 'in vivo'], ['invitro', 'in vitro'], ['invivo', 'in vivo'], ['insilico', 'in silico'], ['in-silico', 'in silico'], ['ex-vivo', 'ex vivo'], ['exvivo', 'ex vivo'],
  ['in-situ', 'in situ'], ['insitu', 'in situ'], ['per-se', 'per se'], ['de-novo', 'de novo'], ['denovo', 'de novo'], ['post-hoc', 'post hoc'], ['posthoc', 'post hoc'], ['ad-libitum', 'ad libitum'],
  ['vice-versa', 'vice versa'], ['apriori', 'a priori'], ['in-toto', 'in toto'], ['status-quo', 'status quo'], ['sub-optimal', 'suboptimal'], ['statistically-significant', 'statistically significant'],
  ['t test', 't-test'], ['t tests', 't-tests'], ['student t test', "Student's t-test"], ["student's t test", "Student's t-test"], ['students t test', "Student's t-test"], ["Student's t test", "Student's t-test"], ['Student t test', "Student's t-test"],
  ['chi square', 'chi-square'], ['chi squared', 'chi-squared'], ['Mann Whitney', 'Mann-Whitney'], ['Kruskal Wallis', 'Kruskal-Wallis'], ['Kaplan Meier', 'Kaplan-Meier'], ['Kolmogorov Smirnov', 'Kolmogorov-Smirnov'],
  ['Shapiro Wilk', 'Shapiro-Wilk'], ['Wilcoxon signed rank', 'Wilcoxon signed-rank'], ['Bland Altman', 'Bland-Altman'], ['Hosmer Lemeshow', 'Hosmer-Lemeshow'], ['Newman Keuls', 'Newman-Keuls'],
  ['Michaelis Menten', 'Michaelis-Menten'], ['Lineweaver Burk', 'Lineweaver-Burk'], ['Henderson Hasselbalch', 'Henderson-Hasselbalch'], ['Sprague Dawley', 'Sprague-Dawley'], ['Folin Ciocalteu', 'Folin-Ciocalteu'],
  ['Folin Ciocalteau', 'Folin-Ciocalteu'], ['Folin-Ciocalteau', 'Folin-Ciocalteu'], ['Ziehl Neelsen', 'Ziehl-Neelsen'], ['Mueller Hinton', 'Mueller-Hinton'], ['Muller Hinton', 'Mueller-Hinton'], ['Muller-Hinton', 'Mueller-Hinton'],
  ['Hardy Weinberg', 'Hardy-Weinberg'], ['Guillain Barre', 'Guillain-Barré'], ['Guillain-Barre', 'Guillain-Barré'], ['Creutzfeldt Jakob', 'Creutzfeldt-Jakob'], ['Stevens Johnson', 'Stevens-Johnson'],
  ['Wolff Parkinson White', 'Wolff-Parkinson-White'], ['Epstein Barr', 'Epstein-Barr'], ['Zollinger Ellison', 'Zollinger-Ellison'], ['Mallory Weiss', 'Mallory-Weiss'], ['Peutz Jeghers', 'Peutz-Jeghers'],
  ['Budd Chiari', 'Budd-Chiari'], ['Arnold Chiari', 'Arnold-Chiari'], ['Wernicke Korsakoff', 'Wernicke-Korsakoff'], ['Lesch Nyhan', 'Lesch-Nyhan'], ['Prader Willi', 'Prader-Willi'], ['Ehlers Danlos', 'Ehlers-Danlos'],
  ['Cheyne Stokes', 'Cheyne-Stokes'], ['Frank Starling', 'Frank-Starling'], ['Lambert Eaton', 'Lambert-Eaton'], ['Brown Sequard', 'Brown-Séquard'], ['Osgood Schlatter', 'Osgood-Schlatter'],
  ['Chediak Higashi', 'Chediak-Higashi'], ['Wiskott Aldrich', 'Wiskott-Aldrich'], ['Bernard Soulier', 'Bernard-Soulier'], ['Dubin Johnson', 'Dubin-Johnson'], ['Crigler Najjar', 'Crigler-Najjar'], ['Charcot Marie Tooth', 'Charcot-Marie-Tooth'],
  ['Henoch Schonlein', 'Henoch-Schönlein'], ['Waterhouse Friderichsen', 'Waterhouse-Friderichsen'], ['Kimmelstiel Wilson', 'Kimmelstiel-Wilson'], ['Stein Leventhal', 'Stein-Leventhal'], ['Dandy Walker', 'Dandy-Walker'],
  ['Non Hodgkin', 'non-Hodgkin'], ['Non-hodgkin', 'non-Hodgkin', { cs: true }], ['non hodgkin', 'non-Hodgkin'], ['Von Willebrand', 'von Willebrand', { cs: true }], ['Von Hippel Lindau', 'von Hippel-Lindau'], ['von Hippel Lindau', 'von Hippel-Lindau'],
  ['x ray', 'X-ray'], ['x rays', 'X-rays'], ['X ray', 'X-ray', { cs: true }], ['X rays', 'X-rays', { cs: true }], ['followup', 'follow-up'], ['follow up period', 'follow-up period'], ['follow up visit', 'follow-up visit'],
  ['follow up visits', 'follow-up visits'], ['follow up study', 'follow-up study'], ['follow up data', 'follow-up data'], ['follow up time', 'follow-up time'], ['follow up duration', 'follow-up duration'],
  ['lost to follow up', 'lost to follow-up'], ['loss to follow up', 'loss to follow-up'], ['during follow up', 'during follow-up'], ['median follow up', 'median follow-up'], ['mean follow up', 'mean follow-up'],
  ['time consuming', 'time-consuming'], ['cost effective', 'cost-effective'], ['cost effectiveness', 'cost-effectiveness'], ['dose dependent', 'dose-dependent'], ['dose dependently', 'dose-dependently'],
  ['time dependent', 'time-dependent'], ['concentration dependent', 'concentration-dependent'], ['age dependent', 'age-dependent'], ['dose related', 'dose-related'], ['age related', 'age-related'], ['age matched', 'age-matched'],
  ['sex matched', 'sex-matched'], ['gender matched', 'gender-matched'], ['placebo controlled', 'placebo-controlled'], ['double blind', 'double-blind'], ['double blinded', 'double-blind|double-blinded'], ['single blind', 'single-blind'],
  ['triple blind', 'triple-blind'], ['open label', 'open-label'], ['cross sectional', 'cross-sectional'], ['case control', 'case-control', { a: 'study|studies|design' }], ['dose response', 'dose-response', { a: 'curve|curves|relationship|relationships|relation|study|studies|analysis|effect' }],
  ['structure activity relationship', 'structure-activity relationship'], ['structure activity relationships', 'structure-activity relationships'], ['first line', 'first-line', { a: 'treatment|therapy|drug|drugs|agent|agents|option|options|antibiotic|antibiotics|regimen|chemotherapy' }],
  ['second line', 'second-line', { a: 'treatment|therapy|drug|drugs|agent|agents|option|options|antibiotic|antibiotics|regimen|chemotherapy' }], ['life threatening', 'life-threatening'], ['life saving', 'life-saving|lifesaving'], ['well being', 'well-being'],
  ['multi drug resistant', 'multidrug-resistant'], ['multi-drug resistant', 'multidrug-resistant'], ['multidrug resistant', 'multidrug-resistant'], ['methicillin resistant', 'methicillin-resistant'], ['vancomycin resistant', 'vancomycin-resistant'],
  ['carbapenem resistant', 'carbapenem-resistant'], ['drug resistant', 'drug-resistant', { a: 'bacteria|strains|strain|isolates|tuberculosis|TB|infections|organisms|cancer|epilepsy|pathogens|cells' }], ['insulin dependent', 'insulin-dependent'], ['non insulin dependent', 'non-insulin-dependent'],
  ['high performance liquid chromatography', 'high-performance liquid chromatography'], ['thin layer chromatography', 'thin-layer chromatography'], ['reverse phase', 'reversed-phase'], ['reversed phase', 'reversed-phase'],
  ['real time PCR', 'real-time PCR'], ['real time polymerase', 'real-time polymerase'], ['real time quantitative', 'real-time quantitative'], ['enzyme linked immunosorbent', 'enzyme-linked immunosorbent'],
  ['enzyme linked immunosorbant', 'enzyme-linked immunosorbent'], ['enzyme-linked immunosorbant', 'enzyme-linked immunosorbent'], ['immunosorbant', 'immunosorbent'], ['infra red', 'infrared'], ['infra-red', 'infrared'],
  ['ultra violet', 'ultraviolet'], ['ultra-violet', 'ultraviolet'], ['UV visible', 'UV-visible'], ['UV Vis', 'UV-Vis'], ['blood brain barrier', 'blood-brain barrier'], ['blood-brain-barrier', 'blood-brain barrier'],
  ['gram positive', 'Gram-positive|gram-positive'], ['gram negative', 'Gram-negative|gram-negative'],
  ['self medication', 'self-medication'], ['self administered', 'self-administered'], ['self care', 'self-care'], ['self reported', 'self-reported'], ['self esteem', 'self-esteem'], ['self efficacy', 'self-efficacy'],
  ['self management', 'self-management'], ['self assessment', 'self-assessment'], ['self limiting', 'self-limiting'], ['self renewal', 'self-renewal'], ['self assembly', 'self-assembly'], ['self assembled', 'self-assembled'],
  ['self monitoring', 'self-monitoring'], ['self harm', 'self-harm'], ['self report', 'self-report'], ['self perceived', 'self-perceived'], ['self rated', 'self-rated'], ['self emulsifying', 'self-emulsifying'],
  ['knock out mice', 'knockout mice'], ['house keeping', 'housekeeping'], ['house-keeping', 'housekeeping'], ['pro inflammatory', 'proinflammatory|pro-inflammatory'], ['pre requisite', 'prerequisite'],
  ['pre treatment', 'pretreatment|pre-treatment'], ['post treatment', 'post-treatment'], ['out come', 'outcome', { b: 'the|primary|secondary|clinical|treatment|main|final|an|poor|good|favourable|favorable' }], ['out comes', 'outcomes'],
  ['data base', 'database'], ['work load', 'workload'], ['work flow', 'workflow'], ['frame work', 'framework'], ['life style', 'lifestyle'], ['blood stream', 'bloodstream'], ['heart beat', 'heartbeat'],
  ['check up', 'check-up', { b: 'a|the|regular|routine|annual|medical|health|periodic' }], ['cut off', 'cut-off|cutoff', { a: 'value|values|point|points|level|levels|score|scores|frequency' }], ['back ground', 'background'], ['base line', 'baseline'], ['base-line', 'baseline'],
  ['guide line', 'guideline'], ['guide lines', 'guidelines'], ['guide-lines', 'guidelines'], ['frame-work', 'framework'], ['out patient', 'outpatient'], ['out patients', 'outpatients'], ['over all', 'overall', { b: 'the|an|their|its', a: 'survival|response|rate|mean|prevalence|incidence|effect|score|quality|mortality|accuracy' }],
  ['socio economic', 'socioeconomic|socio-economic'], ['knock down', 'knockdown', { a: 'of|efficiency|cells|experiments' }], ['wild type', 'wild-type', { a: 'mice|rats|cells|strain|strains|allele|alleles|protein|animals|littermates|controls' }],
  ['et.al', 'et al.'], ['et.al.', 'et al.'], ['etal', 'et al.'], ['etc..', 'etc.'], ['e.g.,.', 'e.g.,'], ['i.e.,.', 'i.e.,'], ['viz', 'viz.', { a: ',|\\(', xa: ',' }],
  ['hematoxylin and eosine', 'hematoxylin and eosin'], ['haematoxylin and eosine', 'haematoxylin and eosin'], ['eosine', 'eosin'], ['Hematoxylin-Eosin', 'hematoxylin and eosin|hematoxylin-eosin', { cs: true }],
  ['tween 80', 'Tween 80'], ['tween-80', 'Tween 80'], ['triton X-100', 'Triton X-100'],
  ['whatman filter paper', 'Whatman filter paper'], ['whatman No', 'Whatman No'], ['petri dish', 'Petri dish'], ['petri dishes', 'Petri dishes'], ['petri plates', 'Petri plates'], ['eppendorf tubes', 'Eppendorf tubes'], ['eppendorf tube', 'Eppendorf tube'],
  ['soxhlet apparatus', 'Soxhlet apparatus'], ['soxhlet extraction', 'Soxhlet extraction'], ['soxhlet extractor', 'Soxhlet extractor'], ['bonferroni correction', 'Bonferroni correction'], ['tukey test', "Tukey's test"], ["tukey's test", "Tukey's test"],
  ['dunnett test', "Dunnett's test"], ["dunnett's test", "Dunnett's test"], ['fisher exact test', "Fisher's exact test"], ["fisher's exact test", "Fisher's exact test"], ['Fisher exact test', "Fisher's exact test"], ['pearson correlation', 'Pearson correlation'],
  ['spearman correlation', 'Spearman correlation'], ['spearman rank', 'Spearman rank'], ['pearson chi-square', 'Pearson chi-square'], ['cronbach alpha', "Cronbach's alpha"], ["cronbach's alpha", "Cronbach's alpha"], ['Cronbach alpha', "Cronbach's alpha"],
  ['likert scale', 'Likert scale'], ['western blot', 'Western blot', { cs: true }], ['western blotting', 'Western blotting', { cs: true }], ['western blots', 'Western blots', { cs: true }], ['northern blot', 'Northern blot', { cs: true }], ['southern blot', 'Southern blot', { cs: true }],
  ['alzheimer disease', "Alzheimer's disease"], ["alzheimer's disease", "Alzheimer's disease"], ['parkinson disease', "Parkinson's disease"], ["parkinson's disease", "Parkinson's disease"], ['crohn disease', "Crohn's disease"], ["crohn's disease", "Crohn's disease"],
  ['hodgkin lymphoma', 'Hodgkin lymphoma'], ['cushing syndrome', "Cushing's syndrome"], ['addison disease', "Addison's disease"], ['graves disease', "Graves' disease"], ['hashimoto thyroiditis', "Hashimoto's thyroiditis"],
  ['down syndrome', 'Down syndrome', { cs: true }], ['downs syndrome', 'Down syndrome'], ["down's syndrome", 'Down syndrome'], ['huntington disease', "Huntington's disease"], ['wilson disease', "Wilson's disease"], ['raynaud phenomenon', "Raynaud's phenomenon"],
  ['bell palsy', "Bell's palsy"], ['kaposi sarcoma', "Kaposi's sarcoma"], ['burkitt lymphoma', "Burkitt's lymphoma"], ['ewing sarcoma', "Ewing's sarcoma"], ['wilms tumor', 'Wilms tumor'], ['wilms tumour', 'Wilms tumour'], ['sjogren syndrome', "Sjögren's syndrome"],
  ['type II diabetes', 'type 2 diabetes'], ['type I diabetes', 'type 1 diabetes'], ['Type II diabetes', 'Type 2 diabetes', { cs: true }], ['Type I diabetes', 'Type 1 diabetes', { cs: true }], ['diabetes mellitus type II', 'type 2 diabetes mellitus'], ['diabetes mellitus type I', 'type 1 diabetes mellitus']
);
G('medical-term', 'style', 'Medical term', (f, t) => `The standard form of this term is "${t[0]}".`, TERMS);

// ------------------------------------------------------------------ species names (italic, genus capitalised, species lower case)
const SPECIES = `Escherichia coli|Staphylococcus aureus|Staphylococcus epidermidis|Pseudomonas aeruginosa|Klebsiella pneumoniae|Bacillus subtilis|Bacillus cereus|Bacillus anthracis|Streptococcus pneumoniae|Streptococcus pyogenes|Streptococcus mutans|Streptococcus agalactiae|Enterococcus faecalis|Enterococcus faecium|Shigella flexneri|Shigella dysenteriae|Proteus mirabilis|Proteus vulgaris|Candida albicans|Candida tropicalis|Candida glabrata|Candida krusei|Candida auris|Aspergillus niger|Aspergillus flavus|Aspergillus fumigatus|Aspergillus terreus|Helicobacter pylori|Mycobacterium tuberculosis|Mycobacterium smegmatis|Listeria monocytogenes|Vibrio cholerae|Clostridium difficile|Clostridioides difficile|Clostridium perfringens|Clostridium botulinum|Acinetobacter baumannii|Enterobacter cloacae|Enterobacter aerogenes|Serratia marcescens|Micrococcus luteus|Saccharomyces cerevisiae|Trichophyton rubrum|Trichophyton mentagrophytes|Plasmodium falciparum|Plasmodium vivax|Plasmodium berghei|Leishmania major|Leishmania tropica|Leishmania donovani|Trypanosoma cruzi|Trypanosoma brucei|Toxoplasma gondii|Giardia lamblia|Entamoeba histolytica|Neisseria gonorrhoeae|Neisseria meningitidis|Haemophilus influenzae|Legionella pneumophila|Campylobacter jejuni|Lactobacillus acidophilus|Lactobacillus rhamnosus|Lactobacillus plantarum|Bifidobacterium bifidum|Caenorhabditis elegans|Drosophila melanogaster|Mus musculus|Rattus norvegicus|Danio rerio|Arabidopsis thaliana|Xanthomonas campestris|Agrobacterium tumefaciens|Salmonella enterica|Yersinia pestis|Bordetella pertussis|Corynebacterium diphtheriae|Treponema pallidum|Chlamydia trachomatis|Mycoplasma pneumoniae|Cryptococcus neoformans|Penicillium chrysogenum|Fusarium oxysporum|Rhizopus oryzae|Mucor mucedo|Nigella sativa|Moringa oleifera|Curcuma longa|Zingiber officinale|Allium sativum|Allium cepa|Aloe vera|Aloe barbadensis|Azadirachta indica|Ocimum sanctum|Ocimum basilicum|Withania somnifera|Glycyrrhiza glabra|Camellia sinensis|Cinnamomum zeylanicum|Cinnamomum verum|Cinnamomum cassia|Momordica charantia|Punica granatum|Phyllanthus emblica|Phyllanthus niruri|Emblica officinalis|Terminalia chebula|Terminalia arjuna|Terminalia bellirica|Berberis lycium|Berberis aristata|Berberis vulgaris|Foeniculum vulgare|Coriandrum sativum|Cuminum cyminum|Mentha piperita|Mentha spicata|Olea europaea|Citrus limon|Citrus sinensis|Citrus paradisi|Mangifera indica|Psidium guajava|Ficus carica|Ficus religiosa|Ficus benghalensis|Tamarindus indica|Syzygium cumini|Syzygium aromaticum|Piper nigrum|Piper longum|Piper betle|Capsicum annuum|Calotropis procera|Calotropis gigantea|Ricinus communis|Datura stramonium|Cannabis sativa|Papaver somniferum|Catharanthus roseus|Tinospora cordifolia|Achyranthes aspera|Fagonia cretica|Cassia fistula|Senna alexandrina|Peganum harmala|Rosmarinus officinalis|Thymus vulgaris|Salvia officinalis|Matricaria chamomilla|Plantago ovata|Lawsonia inermis|Eucalyptus globulus|Ginkgo biloba|Panax ginseng|Silybum marianum|Hypericum perforatum|Echinacea purpurea|Vitis vinifera|Linum usitatissimum|Brassica oleracea|Brassica nigra|Solanum nigrum|Solanum lycopersicum|Solanum tuberosum|Cucumis sativus|Carica papaya|Musa paradisiaca|Cocos nucifera|Phoenix dactylifera|Elettaria cardamomum|Crocus sativus|Acacia nilotica|Acacia arabica|Rauwolfia serpentina|Rauvolfia serpentina|Swertia chirata|Adhatoda vasica|Justicia adhatoda|Boerhavia diffusa|Bergenia ciliata|Artemisia annua|Artemisia absinthium|Origanum vulgare|Lepidium sativum|Nelumbo nucifera|Centella asiatica|Bacopa monnieri|Asparagus racemosus|Gymnema sylvestre|Andrographis paniculata|Euphorbia hirta|Cichorium intybus|Taraxacum officinale|Urtica dioica|Sesamum indicum|Arachis hypogaea|Oryza sativa|Triticum aestivum|Zea mays|Hordeum vulgare|Glycine max|Daucus carota|Beta vulgaris|Spinacia oleracea|Raphanus sativus|Trachyspermum ammi|Carum carvi|Anethum graveolens|Pimpinella anisum|Illicium verum|Myristica fragrans|Ziziphus jujuba|Ziziphus mauritiana|Aegle marmelos|Cassia angustifolia|Commiphora mukul|Commiphora myrrha|Boswellia serrata|Saussurea lappa|Valeriana officinalis|Valeriana wallichii|Melissa officinalis|Lavandula angustifolia|Hibiscus sabdariffa|Murraya koenigii|Sapindus mukorossi|Vernonia amygdalina|Tribulus terrestris|Mucuna pruriens|Pongamia pinnata|Butea monosperma|Woodfordia fruticosa|Embelia ribes|Picrorhiza kurroa|Swertia chirayita|Colchicum luteum|Ephedra sinica|Digitalis purpurea|Atropa belladonna|Hyoscyamus niger|Cinchona officinalis|Strychnos nux-vomica`.split('|');
const SPECIES_ENTRIES = [];
for (const name of SPECIES) {
  const [genus, sp] = name.split(' ');
  if (!/^[a-z]+$/.test(sp)) continue;
  const g = genus[0];
  const cap = sp[0].toUpperCase() + sp.slice(1);
  SPECIES_ENTRIES.push([`${genus} ${cap}`, name, { cs: true, m: `In a species name the genus is capitalised and the species epithet is lower case: "${name}" (in italics).` }]);
  if (name !== 'Aloe vera') SPECIES_ENTRIES.push([`${genus.toLowerCase()} ${sp}`, name, { cs: true, b: '[a-z,;()]+', xb: 'of', m: `The genus name is capitalised: "${name}" (in italics).` }]);
  SPECIES_ENTRIES.push([`${g}.${sp}`, `${g}. ${sp}`, { cs: true, m: `Put a space after the abbreviated genus: "${g}. ${sp}" (in italics).` }]);
  SPECIES_ENTRIES.push([`${g}. ${cap}`, `${g}. ${sp}`, { cs: true, m: `The species epithet is lower case: "${g}. ${sp}" (in italics).` }]);
}
G('species-name', 'style', 'Species name', (f, t) => `Write the species name as "${t[0]}".`, SPECIES_ENTRIES);

// ------------------------------------------------------------------ abbreviations written in the wrong case
G('abbreviation-case', 'style', 'Abbreviation', (f, t) => `The standard form of this abbreviation is "${t[0]}".`, [
  ['dna', 'DNA'], ['rna', 'RNA'], ['mrna', 'mRNA'], ['Mrna', 'mRNA'], ['MRNA', 'mRNA'], ['pcr', 'PCR'], ['Pcr', 'PCR'], ['elisa', 'ELISA'], ['Elisa', 'ELISA'], ['hplc', 'HPLC'], ['Hplc', 'HPLC'],
  ['tlc', 'TLC'], ['hptlc', 'HPTLC'], ['ftir', 'FTIR'], ['Ftir', 'FTIR'], ['nmr', 'NMR'], ['gcms', 'GC-MS'], ['GCMS', 'GC-MS'], ['lcms', 'LC-MS'], ['LCMS', 'LC-MS'], ['mri', 'MRI'], ['ecg', 'ECG'], ['eeg', 'EEG'],
  ['bmi', 'BMI'], ['Bmi', 'BMI'], ['hiv', 'HIV'], ['Hiv', 'HIV'], ['hbv', 'HBV'], ['hcv', 'HCV'], ['Covid-19', 'COVID-19'], ['covid-19', 'COVID-19'], ['SARS-COV-2', 'SARS-CoV-2'],
  ['Sars-CoV-2', 'SARS-CoV-2'], ['sars-cov-2', 'SARS-CoV-2'], ['anova', 'ANOVA'], ['Anova', 'ANOVA'], ['spss', 'SPSS'], ['Spss', 'SPSS'], ['fda', 'FDA'], ['nsaids', 'NSAIDs'], ['NSAIDS', 'NSAIDs'], ["NSAID's", 'NSAIDs'],
  ['tnf', 'TNF'], ['ldl', 'LDL'], ['hdl', 'HDL'], ['vldl', 'VLDL'], ['hba1c', 'HbA1c'], ['HBA1C', 'HbA1c'], ['Hba1c', 'HbA1c'], ['HBA1c', 'HbA1c'], ['dpph', 'DPPH'], ['Dpph', 'DPPH'], ['abts', 'ABTS'], ['frap', 'FRAP'],
  ['mtt', 'MTT'], ['dmso', 'DMSO'], ['Dmso', 'DMSO'], ['edta', 'EDTA'], ['Edta', 'EDTA'], ['pbs', 'PBS'], ['sds-page', 'SDS-PAGE'], ['Sds-page', 'SDS-PAGE'], ['SDS-Page', 'SDS-PAGE'], ['atp', 'ATP'], ['nadph', 'NADPH'],
  ['gsh', 'GSH'], ['gpx', 'GPx'], ['ic50', 'IC50'], ['Ic50', 'IC50'], ['ld50', 'LD50'], ['Ld50', 'LD50'], ['ed50', 'ED50'], ['Ed50', 'ED50'], ['cfu', 'CFU'], ['Cfu', 'CFU'], ['dmem', 'DMEM'],
  ['rpmi', 'RPMI'], ['fbs', 'FBS'], ['bsa', 'BSA'], ['icu', 'ICU'], ['copd', 'COPD'], ['Copd', 'COPD'], ['uti', 'UTI'], ['ckd', 'CKD'], ['nafld', 'NAFLD'], ['pcos', 'PCOS'], ['Pcos', 'PCOS'], ['gerd', 'GERD'],
  ['adhd', 'ADHD'], ['Adhd', 'ADHD'], ['ppi', 'PPI'], ['ppis', 'PPIs'], ['PPI\'s', 'PPIs'], ['ace inhibitors', 'ACE inhibitors'], ['Ace inhibitors', 'ACE inhibitors', { cs: true }], ['arb', 'ARB'], ['ssri', 'SSRI'], ['ssris', 'SSRIs'], ['SSRI\'s', 'SSRIs'],
  ['ros', 'ROS', { a: 'production|generation|levels|level|scavenging|formation|accumulation' }], ['mda', 'MDA', { a: 'levels|level|content|concentration|concentrations' }],
  ['S.D.', 'SD', { cs: true, b: '±|mean|Mean|as|and', xb: 'mean' }], ['S.E.M.', 'SEM', { cs: true, b: '±|mean|Mean|as|and', xb: 'mean' }],
  ['PH', 'pH', { cs: true, a: 'value|values|of|range|meter|levels|level|adjusted|was|scale|\\d+(?:\\.\\d+)?', xa: 'value' }], ['Ph', 'pH', { cs: true, a: 'value|values|of|range|meter|levels|level|adjusted|was|scale|\\d+(?:\\.\\d+)?', xa: 'value' }],
  ['ph', 'pH', { cs: true, a: 'value|values|of|range|meter|levels|level|adjusted|was|scale|\\d+(?:\\.\\d+)?', xa: 'value' }],
  // artificial intelligence (Grammarly comparison on document 7: "Ai Statement", "did not use Ai"); "Ai" alone is a surname (Ai W, Ai Q)
  ['Ai', 'AI', { cs: true, a: 'Statement|statement|Declaration|declaration|Disclosure|disclosure|tools?|models?|software|technology|technologies|chatbots?|assistance', xa: 'Statement' }],
  ['Ai', 'AI', { cs: true, b: 'use|used|using|uses|generative|Generative|any|no', xb: 'used' }]
], { cs: true });

// ------------------------------------------------------------------ units (SI and the forms journals use)
const NUM = '\\d+(?:[.,]\\d+)?';
const U = (bad, good, m) => [bad, good, { cs: true, b: NUM, xb: '10', m }];
G('unit-style', 'style', 'Unit', (f, t) => `Write the unit as "${t[0]}".`, [
  U('gm', 'g'), U('gms', 'g'), U('grms', 'g'), U('mgs', 'mg'), U('kgs', 'kg'), U('Kg', 'kg'), U('KG', 'kg'), U('Kgs', 'kg'), U('mls', 'mL'), U('ltr', 'L'), U('ltrs', 'L'), U('lit', 'L'),
  U('hrs', 'h'), U('hr', 'h'), U('Hrs', 'h'), U('Hr', 'h'), U('mins', 'min'), U('Mins', 'min'), U('secs', 's'), U('sec', 's'), U('mcg', 'µg'), U('ug', 'µg'), U('uL', 'µL'), U('ul', 'µL'), U('uM', 'µM'),
  U('umol', 'µmol'), U('cc', 'mL'), U('oC', '°C'), U('0C', '°C'), U('ºC', '°C'), U('degC', '°C'), U('Rpm', 'rpm'), U('RPM', 'rpm'), U('mmhg', 'mmHg'), U('MmHg', 'mmHg'), U('mmHG', 'mmHg'),
  U('Kda', 'kDa'), U('KDa', 'kDa'), U('kda', 'kDa'), U('iu', 'IU'), U('meq', 'mEq'), U('Meq', 'mEq'),   U('mg/Kg', 'mg/kg'), U('mg/KG', 'mg/kg'), U('g/Kg', 'g/kg'), U('Mg/kg', 'mg/kg'),
  U('mosm', 'mOsm'), U('KHz', 'kHz'), U('khz', 'kHz'), U('Mhz', 'MHz'), U('mhz', 'MHz'), U('Kcal', 'kcal'), U('KCal', 'kcal'), U('KJ', 'kJ'), U('Kj', 'kJ')
]);
// a number joined to a unit that is not SI (37oC, 10mins): one regular expression each, see rules.js `unit-joined`

// ------------------------------------------------------------------ redundant acronyms (the last word repeats the abbreviation)
G('redundant-acronym', 'clarity', 'Redundancy', (f, t) => `"${f}" repeats a word the abbreviation already contains; "${t[0]}" is enough.`, [
  ['HIV virus', 'HIV'], ['PCR reaction', 'PCR'], ['ELISA assay', 'ELISA'], ['HPLC chromatography', 'HPLC'], ['TLC chromatography', 'TLC'], ['GC chromatography', 'GC'], ['MRI imaging', 'MRI'], ['MRI scan', 'MRI|MRI scan', { m: '"MRI scan" is common usage; "MRI" alone is enough in formal writing.' }],
  ['CT tomography', 'CT'], ['BMI index', 'BMI'], ['ROS species', 'ROS'], ['ATP triphosphate', 'ATP'], ['MIC concentration', 'MIC'], ['IC50 concentration', 'IC50'], ['LD50 dose', 'LD50'], ['ED50 dose', 'ED50'],
  ['CBC count', 'CBC'], ['RBC cells', 'RBCs|red blood cells'], ['WBC cells', 'WBCs|white blood cells'], ['NSAID drugs', 'NSAIDs'], ['NSAIDs drugs', 'NSAIDs'], ['SSRI inhibitors', 'SSRIs'], ['ACE enzyme', 'ACE'],
  ['GFR rate', 'GFR'], ['LFT tests', 'LFTs'], ['RFT tests', 'RFTs'], ['RCT trial', 'RCT'], ['RCT trials', 'RCTs'], ['UTI infection', 'UTI'], ['UTI infections', 'UTIs'], ['URTI infection', 'URTI'],
  ['COPD disease', 'COPD'], ['AIDS syndrome', 'AIDS'], ['SARS syndrome', 'SARS'], ['CAD disease', 'CAD'], ['CKD disease', 'CKD'], ['NAFLD disease', 'NAFLD'], ['GERD disease', 'GERD'],
  ['PCOS syndrome', 'PCOS'], ['API ingredient', 'API'], ['APIs ingredients', 'APIs'], ['GMP practice', 'GMP'], ['GMP practices', 'GMP'], ['GLP practice', 'GLP'], ['SOP procedure', 'SOP'], ['SOPs procedures', 'SOPs'],
  ['QC control', 'QC'], ['TLC plate chromatography', 'TLC plate'], ['NMR resonance', 'NMR'], ['FTIR infrared', 'FTIR'], ['SEM microscopy', 'SEM'], ['TEM microscopy', 'TEM'], ['DSC calorimetry', 'DSC'],
  ['XRD diffraction', 'XRD'], ['LC-MS mass spectrometry', 'LC-MS'], ['DNA acid', 'DNA'], ['RNA acid', 'RNA'], ['mRNA RNA', 'mRNA'], ['BP pressure', 'BP'], ['HR rate', 'HR'], ['ECG electrocardiogram', 'ECG'],
  ['ICU unit', 'ICU'], ['OPD department', 'OPD'], ['ER room', 'ER'], ['ED department', 'ED'], ['PIN number', 'PIN'], ['ATM machine', 'ATM'], ['ISBN number', 'ISBN'], ['ISSN number', 'ISSN'], ['DOI identifier', 'DOI'],
  ['IUD device', 'IUD'], ['MDR resistance', 'MDR'], ['TB disease', 'TB|tuberculosis', { m: '"TB" already means tuberculosis.' }], ['DM diabetes', 'DM'], ['HTN hypertension', 'HTN'], ['OTC over-the-counter', 'OTC'],
  ['WHO organization', 'WHO'], ['WHO organisation', 'WHO'], ['NGO organization', 'NGO'], ['NGO organisation', 'NGO'], ['LAN network', 'LAN'], ['GUI interface', 'GUI'], ['UV ultraviolet', 'UV'],
  ['IR infrared', 'IR'], ['LOD limit', 'LOD'], ['LOQ limit', 'LOQ'], ['RSD deviation', 'RSD'], ['SD deviation', 'SD'], ['CI interval', 'CI'], ['OR ratio', 'OR'], ['HR ratio', 'HR'], ['AUC curve', 'AUC'], ['ROC curve analysis', 'ROC analysis'],
  ['ADR reaction', 'ADR'], ['ADRs reactions', 'ADRs'], ['ADE event', 'ADE'], ['DDI interaction', 'DDI'], ['DDIs interactions', 'DDIs']
], { cs: true });

// ------------------------------------------------------------------ wordiness and redundancy in research writing
G('wordy', 'clarity', 'Wordy phrase', (f, t) => (t[0] === '' ? `"${f}" adds words without adding meaning; it can usually be removed.` : `"${f}" can be said more briefly: "${t.filter(Boolean).join('" or "')}".`), [
  ['it was observed that', ''], ['it was found that', ''], ['it has been found that', ''], ['it is found that', ''], ['it can be seen that', ''], ['it is seen that', ''], ['it is observed that', ''],
  ['it was noticed that', ''], ['it was noted that', ''], ['it is a well known fact that', 'it is well known that'], ['it is a known fact that', 'it is known that'], ['as it is well known', 'as is well known'],
  ['as it is known', 'as is known'], ['it is a fact that', ''], ['the results obtained showed that', 'the results showed that'], ['in the present study it was found', 'this study found'], ['has been reported to be', 'is reportedly|is'],
  ['a total number of', 'a total of'], ['in the month of', 'in'], ['in the year', 'in', { a: '(?:19|20)\\d\\d', xa: '2020' }], ['during the period of', 'during'], ['at a later date', 'later'], ['at the time when', 'when'], ['at the same time as', 'while'],
  ['in a dose-dependent manner', 'dose-dependently'], ['in a time-dependent manner', 'time-dependently'], ['in a concentration-dependent manner', 'concentration-dependently'], ['in a significant manner', 'significantly'],
  ['in a similar manner', 'similarly'], ['in a similar way', 'similarly'], ['in an attempt to', 'to'], ['with the aim of', 'to'], ['with the purpose of', 'to'], ['for the purpose of determining', 'to determine'],
  ['in order to determine', 'to determine'], ['in order to evaluate', 'to evaluate'], ['in order to assess', 'to assess'], ['in order to investigate', 'to investigate'], ['so as to', 'to'],
  ['owing to the fact that', 'because'], ['given the fact that', 'because|given that'], ['in view of the fact', 'because'], ['by virtue of the fact that', 'because'], ['on the grounds that', 'because'],
  ['add an additional', 'add'], ['added an additional', 'added'], ['and also', 'and', { m: '"And also" repeats itself; "and" (or "also") is enough.' }], ['as being', 'as'], ['ask the question', 'ask'],
  ['basic essentials', 'essentials'], ['came to the conclusion', 'concluded'], ['continue on', 'continue'], ['definite decision', 'decision'], ['early beginnings', 'beginnings'], ['equal to one another', 'equal'],
  ['exactly the same', 'the same|identical'], ['filled to capacity', 'full'], ['final conclusion', 'conclusion'], ['final conclusions', 'conclusions'], ['grow in size', 'grow'], ['grew in size', 'grew'], ['has got', 'has'],
  ['have got', 'have'], ['heat up', 'heat'], ['hollow tube', 'tube'], ['integrate together', 'integrate'], ['integrated together', 'integrated'], ['major breakthrough', 'breakthrough'], ['merge together', 'merge'],
  ['merged together', 'merged'], ['never before', 'never'], ['none at all', 'none'], ['outside of', 'outside'], ['inside of', 'inside'], ['personal opinion', 'opinion'], ['postpone until later', 'postpone'],
  ['proceed ahead', 'proceed'], ['recur again', 'recur'], ['reduce down', 'reduce'], ['refer back', 'refer'], ['referred back', 'referred'], ['regular routine', 'routine'], ['repeat the same', 'repeat'],
  ['reply back', 'reply'], ['rise up', 'rise'], ['rose up', 'rose'], ['same identical', 'identical'], ['separate out', 'separate'], ['share together', 'share'], ['small in number', 'few'],
  ['surrounded on all sides', 'surrounded'], ['usual custom', 'custom'], ['visible to the eye', 'visible'], ['warn in advance', 'warn'], ['written down', 'written'], ['combine into one', 'combine'],
  ['completely filled', 'filled'], ['completely destroyed', 'destroyed'], ['completely abolished', 'abolished'], ['totally abolished', 'abolished'], ['entirely eliminated', 'eliminated'], ['unexpected surprise', 'surprise'],
  ['still continues', 'continues'], ['still persists', 'persists'], ['continues to remain', 'remains'], ['new discovery', 'discovery'], ['new invention', 'invention'], ['past records', 'records'], ['prior history', 'history'],
  ['previous history', 'history'], ['future prospects', 'prospects'], ['actual fact', 'fact'], ['actual experience', 'experience'], ['sudden onset', 'onset|sudden onset', { m: '"Sudden onset" is standard clinically; "onset" alone is enough only when timing is not the point.' }],
  ['totally complete', 'complete'], ['blend together', 'blend'], ['blended together', 'blended'], ['fuse together', 'fuse'], ['fused together', 'fused'], ['link together', 'link'], ['linked together', 'linked'],
  ['connect together', 'connect'], ['connected together', 'connected'], ['gather together', 'gather'], ['pooled together', 'pooled'], ['attach together', 'attach'], ['assemble together', 'assemble'],
  ['adequate enough', 'adequate|enough'], ['sufficient enough', 'sufficient|enough'], ['both alike', 'alike'], ['both equally', 'equally'], ['both of the two', 'both'], ['the two of them both', 'both'],
  ['circular in shape', 'circular'], ['round in shape', 'round'], ['square in shape', 'square'], ['spherical in shape', 'spherical'], ['rectangular in shape', 'rectangular'], ['triangular in shape', 'triangular'],
  ['blue in color', 'blue'], ['blue in colour', 'blue'], ['yellow in color', 'yellow'], ['yellow in colour', 'yellow'], ['green in color', 'green'], ['green in colour', 'green'], ['white in color', 'white'], ['white in colour', 'white'],
  ['brown in color', 'brown'], ['brown in colour', 'brown'], ['black in color', 'black'], ['black in colour', 'black'], ['red in colour', 'red'], ['orange in color', 'orange'], ['orange in colour', 'orange'],
  ['bitter in taste', 'bitter'], ['sweet in taste', 'sweet'], ['acidic in nature', 'acidic'], ['basic in nature', 'basic|alkaline'], ['chronic in nature', 'chronic'], ['acute in nature', 'acute'], ['toxic in nature', 'toxic'],
  ['polar in nature', 'polar'], ['hydrophobic in nature', 'hydrophobic'], ['hydrophilic in nature', 'hydrophilic'], ['crystalline in nature', 'crystalline'], ['amorphous in nature', 'amorphous'],
  ['heavy in weight', 'heavy'], ['light in weight', 'light|lightweight'], ['short in duration', 'short|brief'], ['long in duration', 'long'], ['brief in duration', 'brief'], ['mild in severity', 'mild'],
  ['twelve noon', 'noon'], ['midnight at night', 'midnight'], ['in the morning at', 'at', { a: '\\d+', xa: '8' }], ['a.m. in the morning', 'a.m.'], ['p.m. in the evening', 'p.m.'], ['p.m. at night', 'p.m.'],
  ['mutually agreed', 'agreed'], ['mutual agreement', 'agreement'], ['joint cooperation', 'cooperation'], ['close scrutiny', 'scrutiny'], ['careful scrutiny', 'scrutiny'], ['general consensus', 'consensus'],
  ['consensus of opinion', 'consensus'], ['overall consensus', 'consensus'], ['necessary requirement', 'requirement'], ['necessary requirements', 'requirements'], ['essential requirement', 'requirement'],
  ['basic principles', 'principles'], ['component parts', 'components'], ['end product', 'product'], ['end products', 'products'], ['major part of', 'most of'], ['in a number of cases', 'sometimes|in several cases'],
  ['on a number of occasions', 'often|several times'], ['at the present moment', 'now|currently'], ['in the present time', 'now|currently'], ['in today\'s world', 'today'], ['in recent times', 'recently'],
  ['in the recent past', 'recently'], ['in the not too distant future', 'soon'], ['has the potential to', 'can|may'], ['have the potential to', 'can|may'], ['is capable of', 'can'], ['are capable of', 'can'],
  ['is in a position to', 'can'], ['are in a position to', 'can'], ['it is necessary that', 'must'], ['there is a need for', 'is needed|requires'], ['plays a role in', 'affects|contributes to', { m: '"Plays a role in" is vague; a specific verb is clearer (affects, regulates, contributes to).' }],
  ['play a role in', 'affect|contribute to', { m: '"Play a role in" is vague; a specific verb is clearer (affect, regulate, contribute to).' }], ['give rise to', 'cause|produce'], ['gives rise to', 'causes|produces'],
  ['make use of', 'use'], ['makes use of', 'uses'], ['made use of', 'used'], ['making use of', 'using'], ['take place', 'occur', { m: '"Take place" can be said more briefly: "occur".' }], ['took place', 'occurred'],
  ['in a manner similar to', 'like|as'], ['in close agreement with', 'close to|agreeing with'], ['are in agreement with', 'agree with'], ['is in agreement with', 'agrees with'], ['was in agreement with', 'agreed with'],
  ['were in agreement with', 'agreed with'], ['has an effect on', 'affects'], ['have an effect on', 'affect'], ['had an effect on', 'affected'], ['exerted an effect on', 'affected'], ['showed an increase in', 'increased'],
  ['showed a decrease in', 'decreased'], ['showed a reduction in', 'reduced'], ['caused a reduction in', 'reduced'], ['caused an increase in', 'increased'], ['resulted in a reduction of', 'reduced'],
  ['resulted in an increase in', 'increased'], ['led to an increase in', 'increased'], ['led to a decrease in', 'decreased'], ['brought about a', 'caused a'], ['is suggestive of', 'suggests'], ['are suggestive of', 'suggest'],
  ['is reflective of', 'reflects'], ['are reflective of', 'reflect'], ['is supportive of', 'supports'], ['is consistent with the fact that', 'is consistent with'], ['for the reason that', 'because'],
  ['with reference to', 'about|regarding'], ['with the result that', 'so that'], ['in the vicinity of', 'near|about'], ['in the region of', 'about|around', { a: '\\d+|approximately', xa: '50' }], ['in the order of', 'about|around', { a: '\\d+', xa: '10' }],
  ['a great deal of', 'much'], ['a considerable amount of', 'much'], ['a considerable number of', 'many'],
  ['an increased number of', 'more'], ['a decreased number of', 'fewer'], ['an increasing number of', 'more and more|a growing number of'],
  ['the vast majority of', 'most'], ['the great majority of', 'most'], ['the overwhelming majority of', 'nearly all|most'], ['a large proportion of', 'many|much of'], ['a small proportion of', 'few|little of'],
  ['in the absence of any', 'without any'], ['on the part of', 'by|among'], ['as a consequence of', 'because of'],
  ['as a result of', 'because of'], ['in consequence of', 'because of'], ['in the course of', 'during'], ['for a period of', 'for'], ['over a period of', 'over|for'], ['for the duration of', 'during|throughout'],
  ['until such a time as', 'until'], ['at an earlier time', 'earlier'], ['at a later time', 'later'], ['in an effective manner', 'effectively'], ['in an efficient manner', 'efficiently'], ['in a rapid manner', 'rapidly'],
  ['in a careful manner', 'carefully'], ['in a consistent manner', 'consistently'], ['in a systematic manner', 'systematically'], ['in a random manner', 'randomly'], ['in a timely fashion', 'promptly'], ['in a similar fashion', 'similarly']
]);

// ------------------------------------------------------------------ academic usage (journal and editor conventions)
G('academic-usage', 'style', 'Academic usage', (f, t) => `In formal research writing, write "${t[0]}".`, [
  ['considered as', 'considered|regarded as', { m: '"Considered as" is wordy in formal writing; "considered" (or "regarded as") is enough.' }], ['termed as', 'termed'], ['called as', 'called'], ['entitled as', 'entitled'],
  ['vis a vis', 'compared with|regarding'], ['vis-a-vis', 'compared with|regarding'],
  ['proves that', 'shows that|indicates that', { m: 'A single study rarely proves; "shows" or "indicates" states the finding without overclaiming.' }], ['proved that', 'showed that|indicated that', { m: 'A single study rarely proves; "showed" or "indicated" states the finding without overclaiming.' }],
  ['it is proved that', 'it was shown that'], ['it was proved that', 'it was shown that'], ['this study proves', 'this study shows|this study indicates'], ['our results prove', 'our results show|our results indicate'],
  ['the results prove', 'the results show|the results indicate'], ['these results prove', 'these results show|these results indicate'], ['clearly proves', 'shows|indicates'], ['clearly proved', 'showed|indicated'],
  ['great significant', 'highly significant|significant'], ['great statistically significant', 'statistically significant|highly significant'], ['greatly significant', 'highly significant'],
  ['great statistical significance', 'high statistical significance|a statistically significant difference'], ['great significance', 'high significance|considerable importance'],
  ['is the leading causes', 'is the leading cause'], ['was the leading causes', 'was the leading cause'], ['is one of the leading cause', 'is one of the leading causes'],
  ['On every alternate days', 'On alternate days'], ['on every alternate days', 'on alternate days'], ['every alternate days', 'every alternate day|on alternate days'],
  ['very significant', 'highly significant', { m: 'Statistical significance is not graded with "very"; write "highly significant" with the P value, or describe the size of the effect.' }], ['very significantly', 'markedly|substantially'],
  ['extremely significant', 'highly significant'], ['more significant', 'stronger|larger', { m: 'Significance is a yes/no outcome of a test; compare the effect sizes or P values instead.' }], ['most significant', 'strongest|largest'],
  ['statistically insignificant', 'not statistically significant'], ['statistically non-significant', 'not statistically significant'], ['insignificant difference', 'non-significant difference|no significant difference'],
  ['almost significant', 'not significant (P = …)', { m: 'A result that misses the threshold is not significant; report the P value rather than "almost significant".' }], ['nearly significant', 'not significant (P = …)', { m: 'A result that misses the threshold is not significant; report the P value rather than "nearly significant".' }],
  ['borderline significant', 'not significant (P = …)', { m: 'Report the exact P value rather than "borderline significant".' }], ['marginally significant', 'not significant (P = …)', { m: 'Report the exact P value rather than "marginally significant".' }],
  ['trend towards significance', 'non-significant trend'], ['trend toward significance', 'non-significant trend'], ['highly statistically significant', 'statistically significant'],
  ['correlates to', 'correlates with'], ['correlated to', 'correlated with'], ['correlate to', 'correlate with'], ['correlating to', 'correlating with'], ['in correlation to', 'in correlation with'],
  ['etc', 'etc.', { a: '\\)|,|;|and', xa: ',', m: '"Etc." is an abbreviation and takes a full stop.' }],
  ['cf', 'cf.', { cs: true, a: 'Fig|Figure|Table|ref', xa: 'Figure', m: '"cf." (compare) takes a full stop.' }],
  ['such as etc', 'such as'], ['like for example', 'for example|such as'], ['for e.g.', 'e.g.|for example'], ['for eg', 'e.g.|for example'],
  ['the authors would like to thank', 'the authors thank', { m: '"Would like to thank" can be said more briefly: "thank".' }], ['we would like to thank', 'we thank'], ['would like to acknowledge', 'acknowledge|thank'],
  ['the present study was carried out', 'this study was conducted|this study'], ['the aim of the present study was to', 'this study aimed to'], ['the aim of this study was to', 'this study aimed to'],
  ['the purpose of this study was to', 'this study aimed to'], ['the objective of this study was to', 'this study aimed to'], ['this study was conducted to', 'this study aimed to'], ['this study was designed to', 'this study aimed to'],
  ['in this study we', 'here we|in this study, we'], ['showed significant results', 'showed significant differences|showed significant effects', { m: 'A result is not significant in itself; say what was significant (a difference, an effect, a correlation).' }],
  ['data are not shown', 'data not shown'], ['the data not shown', 'data not shown'],
  ['mean+SD', 'mean ± SD'], ['mean+/-SD', 'mean ± SD'], ['mean +/- SD', 'mean ± SD'], ['+/-', '±', { b: '\\d+(?:\\.\\d+)?|mean|SD|SEM', xb: '10' }], ['+-', '±', { b: '\\d+(?:\\.\\d+)?|mean|SD|SEM', xb: '10' }],
  ['p value', 'P value', { cs: true, m: 'PJPS and most medical journals write the P of a P value as a capital ("P value", "P<0.05").' }], ['p values', 'P values', { cs: true, m: 'PJPS and most medical journals write the P of a P value as a capital ("P values").' }],
  ['p-value', 'P-value|P value', { cs: true, m: 'PJPS and most medical journals write the P of a P value as a capital.' }], ['p-values', 'P-values|P values', { cs: true, m: 'PJPS and most medical journals write the P of a P value as a capital.' }],
  ['level of significance was set at', 'significance was set at'], ['were considered as significant', 'were considered significant'], ['was considered as significant', 'was considered significant'],
  ['was considered as statistically significant', 'was considered statistically significant'], ['were considered as statistically significant', 'were considered statistically significant'],
  ['according to the manufacturer instructions', "according to the manufacturer's instructions"], ['according to manufacturer instructions', "according to the manufacturer's instructions"],
  ['according to manufacturer\'s instructions', "according to the manufacturer's instructions"], ['according to the manufacturers instructions', "according to the manufacturer's instructions"]
]);

// ------------------------------------------------------------------ dictionaries the bank adds to (spelling)
// typing slips found in published papers (scripts/build-scribe-rules.js): "postive", "trasfected", "malodialdehyde"
const TYPO_FILE = path.join(__dirname, 'dict', 'typos.txt');
let typos = null;
/** typo -> correct word: [{ typo, word, kind }] (kind: 'published' slips seen in papers, 'drug' a drug name in another language's form) */
function typoList() {
  if (typos) return typos;
  typos = [];
  try {
    for (const line of fs.readFileSync(TYPO_FILE, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [typo, word, kind] = line.trim().split('\t');
      if (typo && word) typos.push({ typo, word, kind: kind || 'published' });
    }
  } catch { /* the bank works without the generated list */ }
  return typos;
}

// ------------------------------------------------------------------ compiled entries
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstAlt = s => String(s).split('|')[0].replace(/\\(.)/g, '$1');
/** The words of a phrase as the in-house matcher sees them: letters, digits and the signs inside terms */
const tokens = s => s.match(/[A-Za-z0-9µ°º±²³+\/'’-]+|[^\sA-Za-z0-9µ°º±²³+\/'’-]/g) || [];

let compiled = null;
/** [{ id, rule, category, title, find, to, before, after, cs, message, example: { bad, good, offset } }] */
function entries() {
  if (compiled) return compiled;
  compiled = [];
  const seen = new Set();
  for (const g of groups) {
    let n = 0;
    for (const [find, to, ctx = {}] of g.entries) {
      const reps = String(to).split('|');
      // a correction of capital letters only (tween 80 -> Tween 80) must not flag the right form
      const cs = ctx.cs ?? g.cs ?? reps.some(r => r.toLowerCase() === find.toLowerCase());
      const key = `${g.rule}|${cs ? find : find.toLowerCase()}|${ctx.b || ''}|${ctx.a || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const before = ctx.b || null, after = ctx.a || null;
      const pre = before ? `${ctx.xb ?? firstAlt(before)} ` : 'We found ';
      const post = after ? ` ${ctx.xa ?? firstAlt(after)}` : '';
      const bad = `${pre}${find}${post} in the samples.`;
      const good = `${pre}${reps[0]}${post} in the samples.`;
      compiled.push({
        id: `${g.rule}-${++n}`, rule: g.rule, category: g.category, title: g.title, find, to: reps, before, after, na: ctx.na || null, cs,
        when: g.when, message: ctx.m || g.message(find, reps), example: { bad, good: reps[0] === find ? null : good, offset: pre.length }
      });
    }
  }
  return compiled;
}

// ------------------------------------------------------------------ the in-house matcher
// a context alternative that is one punctuation mark ("." "," "±") may touch the word; a word needs a space
const isPunct = a => /^[^\w\s]$/.test(a.replace(/^\\/, ''));
function ctxRe(alts, side) {
  const list = alts.split('|');
  const w = list.filter(a => !isPunct(a)), p = list.filter(a => isPunct(a));
  const parts = [];
  if (side === 'before') {
    if (w.length) parts.push(`(?:^|[^\\w-])(?:${w.join('|')})\\s+$`);
    if (p.length) parts.push(`(?:${p.join('|')})\\s*$`);
  } else {
    if (w.length) parts.push(`^\\s+(?:${w.join('|')})(?![\\w-])`);
    if (p.length) parts.push(`^\\s*(?:${p.join('|')})`);
  }
  return new RegExp(parts.join('|'), 'i');
}
// the words of a paragraph as keys into the bank: the same pieces `tokens` makes of a rule's words
const WORD = /[A-Za-z0-9µ°º±²³+/'’-]+/g;
let index = null;
function buildIndex() {
  index = new Map();
  for (const e of entries()) {
    const key = tokens(e.find)[0].toLowerCase();
    const body = e.find.split(/\s+/).map(esc).join('\\s+');
    e.re = new RegExp(`${body}${/[\w.]$/.test(e.find) ? '(?![\\w-])' : ''}`, e.cs ? 'y' : 'iy');
    e.beforeRe = e.before ? ctxRe(e.before, 'before') : null;
    e.afterRe = e.after ? ctxRe(e.after, 'after') : null;
    e.naRe = e.na ? ctxRe(e.na, 'after') : null;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(e);
  }
}

/**
 * Bank issues in one paragraph: [{ rule, category, title, offset, length, text, message, replacements }].
 * goals decide the groups that apply (academic usage and units only in research writing); disabled: Set of rule ids.
 */
function match(p, goals = {}, disabled = new Set()) {
  if (!index) buildIndex();
  const out = [];
  const academic = (goals.domain || 'academic') === 'academic';
  for (const m of p.matchAll(WORD)) {
    // a token may start inside a longer run of signs ("(in-vitro"): look up from the first letter or digit
    const lead = m[0].search(/[A-Za-z0-9µ°º±+]/);
    if (lead < 0) continue;
    const start = m.index + lead;
    if (start > 0 && /[\w-]/.test(p[start - 1])) continue;
    for (const key of new Set([m[0].slice(lead).toLowerCase(), m[0].slice(lead).toLowerCase().replace(/[-'’].*$/, '')])) {
      for (const e of index.get(key) || []) {
        if (disabled.has(e.rule) || (!academic && (e.rule === 'academic-usage' || e.rule === 'unit-style'))) continue;
        e.re.lastIndex = start;
        const hit = e.re.exec(p);
        if (!hit) continue;
        const end = start + hit[0].length;
        if (e.beforeRe && !e.beforeRe.test(p.slice(Math.max(0, start - 80), start))) continue;
        if (e.afterRe && !e.afterRe.test(p.slice(end, end + 80))) continue;
        if (e.naRe && e.naRe.test(p.slice(end, end + 80))) continue;
        const text = p.slice(start, end);
        const reps = e.to.map(r => (e.cs || !r ? r : keepCase(text, r))).filter((r, k, a) => r !== text && a.indexOf(r) === k);
        out.push({ rule: e.rule, category: e.category, title: e.title, offset: start, length: end - start, text, message: e.message, replacements: reps });
      }
    }
  }
  return out;
}
const keepCase = (src, rep) => (/^[A-Z]/.test(src) && /^[a-z]/.test(rep) ? rep[0].toUpperCase() + rep.slice(1) : rep);

module.exports = { entries, match, typoList, tokens, esc, SPECIES, groups };
