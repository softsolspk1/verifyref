// papermill/lists.js - reference lists for Module 4 (Paper Mill Detection).
// Tortured phrases: synonyms produced by paraphrasing tools to dodge plagiarism checks, from the Problematic Paper
// Screener (Cabanac, Labbé & Magazinov 2021, https://www.irit.fr/~Guillaume.Cabanac/problematic-paper-screener)
// plus pharmacy/biomedical phrases; editors can add their own in Administration → Datasets.

const TORTURED = [
  // computing / statistics
  ['counterfeit consciousness', 'artificial intelligence'], ['man-made consciousness', 'artificial intelligence'], ['profound learning', 'deep learning'],
  ['colossal information', 'big data'], ['huge information', 'big data'], ['enormous information', 'big data'], ['flag to commotion', 'signal to noise'],
  ['irregular woodland', 'random forest'], ['arbitrary timberland', 'random forest'], ['irregular timberland', 'random forest'],
  ['neural organization', 'neural network'], ['fake neural organization', 'artificial neural network'], ['convolutional neural organization', 'convolutional neural network'],
  ['repetitive neural organization', 'recurrent neural network'], ['intermittent neural organization', 'recurrent neural network'], ['long transient memory', 'long short-term memory'],
  ['remote sensor organization', 'wireless sensor network'], ['versatile organization', 'mobile network'], ['haphazard access memory', 'random access memory'],
  ['information mining', 'data mining'], ['web of things', 'internet of things'], ['cloud figuring', 'cloud computing'], ['haze figuring', 'fog computing'],
  ['edge figuring', 'edge computing'], ['picture handling', 'image processing'], ['picture acknowledgment', 'image recognition'], ['discourse acknowledgment', 'speech recognition'],
  ['regular language preparing', 'natural language processing'], ['normal language handling', 'natural language processing'], ['bolster vector machine', 'support vector machine'],
  ['uphold vector machine', 'support vector machine'], ['k-closest neighbor', 'k-nearest neighbour'], ['strategic relapse', 'logistic regression'],
  ['calculated relapse', 'logistic regression'], ['direct relapse', 'linear regression'], ['straight relapse', 'linear regression'], ['relapse examination', 'regression analysis'],
  ['relapse investigation', 'regression analysis'], ['mean square blunder', 'mean square error'], ['root mean square blunder', 'root mean square error'], ['gaussian commotion', 'Gaussian noise'],
  ['slope plummet', 'gradient descent'], ['angle plummet', 'gradient descent'], ['molecule swarm advancement', 'particle swarm optimisation'], ['hereditary calculation', 'genetic algorithm'],
  ['insect province', 'ant colony'], ['subterranean insect state', 'ant colony'], ['honey bee province', 'bee colony'], ['choice tree', 'decision tree'],
  ['factual examination', 'statistical analysis'], ['measurable investigation', 'statistical analysis'], ['measurable examination', 'statistical analysis'], ['factual investigation', 'statistical analysis'],
  ['factual importance', 'statistical significance'], ['measurably critical', 'statistically significant'], ['genuinely huge', 'statistically significant'], ['measurably huge', 'statistically significant'],
  ['information base', 'database'], ['mistake rate', 'error rate'],
  // medicine / pharmacy / biology
  ['bosom peril', 'breast cancer'], ['bosom malignant growth', 'breast cancer'], ['bosom disease', 'breast cancer'], ['lung malignant growth', 'lung cancer'], ['liver malignant growth', 'liver cancer'],
  ['colon malignant growth', 'colon cancer'], ['prostate malignant growth', 'prostate cancer'], ['gastric malignant growth', 'gastric cancer'], ['malignant growth cells', 'cancer cells'],
  ['hostile to malignant growth', 'anticancer'], ['against malignant growth', 'anticancer'], ['kidney disappointment', 'kidney failure'], ['renal disappointment', 'renal failure'],
  ['cardiovascular breakdown', 'heart failure'], ['coronary disappointment', 'heart failure'], ['heart disappointment', 'heart failure'], ['circulatory strain', 'blood pressure'],
  ['insulin obstruction', 'insulin resistance'], ['safe framework', 'immune system'], ['resistant framework', 'immune system'], ['invulnerable framework', 'immune system'],
  ['oxidative pressure', 'oxidative stress'], ['receptive oxygen species', 'reactive oxygen species'], ['responsive oxygen species', 'reactive oxygen species'], ['cell reinforcement', 'antioxidant'],
  ['medication conveyance', 'drug delivery'], ['drug conveyance', 'drug delivery'], ['medication opposition', 'drug resistance'], ['anti-infection opposition', 'antibiotic resistance'],
  ['anti-toxin obstruction', 'antibiotic resistance'], ['anti-microbial obstruction', 'antimicrobial resistance'], ['quality articulation', 'gene expression'], ['quality expression', 'gene expression'],
  ['protein articulation', 'protein expression'], ['articulation level', 'expression level'], ['irresistible illness', 'infectious disease'], ['persistent kidney illness', 'chronic kidney disease'],
  ['ceaseless kidney illness', 'chronic kidney disease'], ['constant obstructive aspiratory illness', 'chronic obstructive pulmonary disease'], ['aspiratory fibrosis', 'pulmonary fibrosis'],
  ['cerebrum tumor', 'brain tumour'], ['mind tumor', 'brain tumour'], ['undifferentiated organism', 'stem cell'], ['foundational microorganisms', 'stem cells'], ['intellectual hindrance', 'cognitive impairment'],
  ['mental imbalance', 'autism'], ['attractive reverberation imaging', 'magnetic resonance imaging'], ['figured tomography', 'computed tomography'], ['registered tomography', 'computed tomography'],
  ['positron discharge tomography', 'positron emission tomography'], ['urinary lot contamination', 'urinary tract infection'], ['sort 2 diabetes', 'type 2 diabetes'], ['lipid digestion', 'lipid metabolism'],
  ['glucose digestion', 'glucose metabolism'], ['sound volunteers', 'healthy volunteers'], ['solid controls', 'healthy controls'], ['rejuvenating balm', 'essential oil'],
  ['fundamental oil', 'essential oil'], ['restorative plants', 'medicinal plants'], ['home grown medication', 'herbal medicine'], ['hostile to bacterial', 'antibacterial'],
  ['against bacterial', 'antibacterial'], ['hostile to parasitic', 'antifungal'], ['hostile to oxidant', 'antioxidant'], ['against oxidant', 'antioxidant'], ['hostile to inflammatory', 'anti-inflammatory'],
  ['against inflammatory', 'anti-inflammatory'], ['least inhibitory focus', 'minimum inhibitory concentration'], ['least inhibitory fixation', 'minimum inhibitory concentration'],
  ['zone of hindrance', 'zone of inhibition'], ['high-execution fluid chromatography', 'high-performance liquid chromatography'], ['superior fluid chromatography', 'high-performance liquid chromatography'],
  ['elite fluid chromatography', 'high-performance liquid chromatography'], ['fluid chromatography', 'liquid chromatography'], ['atomic docking', 'molecular docking'], ['sub-atomic docking', 'molecular docking'],
  ['atomic elements', 'molecular dynamics'], ['sub-atomic elements', 'molecular dynamics'], ['sub-atomic weight', 'molecular weight'], ['sub-atomic component', 'molecular mechanism'],
  ['flagging pathway', 'signalling pathway'], ['motioning pathway', 'signalling pathway'], ['record factor', 'transcription factor'], ['western smudge', 'western blot'], ['western blotch', 'western blot'],
  ['polymerase chain response', 'polymerase chain reaction'], ['stream cytometry', 'flow cytometry'], ['creature model', 'animal model'], ['test creatures', 'experimental animals'],
  ['trial creatures', 'experimental animals'], ['lethal portion', 'lethal dose'], ['middle deadly portion', 'median lethal dose'], ['dose subordinate', 'dose-dependent'], ['portion subordinate', 'dose-dependent'],
  ['cell feasibility', 'cell viability'], ['cell practicality', 'cell viability'], ['cell multiplication', 'cell proliferation'], ['customized cell passing', 'programmed cell death'],
  ['modified cell demise', 'programmed cell death'], ['cancer hindrance', 'tumour inhibition'], ['tumor concealment', 'tumour suppression'], ['tumor silencer', 'tumour suppressor'],
  ['growth silencer', 'tumour suppressor'], ['provocative cytokines', 'inflammatory cytokines'], ['incendiary cytokines', 'inflammatory cytokines'], ['fiery reaction', 'inflammatory response'],
  ['provocative reaction', 'inflammatory response'], ['liver harm', 'liver damage'], ['hepatic harm', 'hepatic damage'], ['kidney harm', 'kidney damage'],
  ['nanoparticle combination', 'nanoparticle synthesis'], ['green combination', 'green synthesis'], ['silver nanoparticles combination', 'silver nanoparticle synthesis'], ['examining electron magnifying lens', 'scanning electron microscope'],
  ['transmission electron magnifying lens', 'transmission electron microscope'], ['X-beam diffraction', 'X-ray diffraction'], ['x-beam diffraction', 'X-ray diffraction'], ['Fourier change infrared', 'Fourier-transform infrared'],
  ['bright noticeable', 'ultraviolet-visible'], ['UV-noticeable', 'UV-visible'], ['disintegration rate', 'dissolution rate'], ['bioavailability upgrade', 'bioavailability enhancement'],
  ['clinical preliminary', 'clinical trial'], ['randomized controlled preliminary', 'randomised controlled trial'], ['twofold visually impaired', 'double-blind'], ['fake treatment', 'placebo'],
  ['unfavorable impacts', 'adverse effects'], ['antagonistic impacts', 'adverse effects'], ['unfriendly occasions', 'adverse events'], ['antagonistic occasions', 'adverse events'],
  ['medication communication', 'drug interaction'], ['tranquilize', 'drug'], ['sedate conveyance', 'drug delivery'], ['sedate obstruction', 'drug resistance']
].map(([phrase, correct]) => ({ phrase, correct }));

// Clear traces of AI text generators / unfinished templates (flagged only on exact matches)
const AI_LEFTOVERS = [
  [/\bas an AI language model\b/i, 'As an AI language model'], [/\bas a large language model\b/i, 'As a large language model'], [/\bregenerate response\b/i, 'Regenerate response'],
  [/\bI (?:cannot|can't|am unable to) (?:fulfil|fulfill|provide|access|browse)\b/i, 'Chatbot refusal text'], [/\bcertainly[!,] here (?:is|are)\b/i, '“Certainly! Here is…”'],
  [/\bhere is (?:a|the) (?:revised|rewritten|improved|paraphrased) version\b/i, '“Here is a revised version…”'], [/\bmy (?:knowledge|training) (?:cutoff|cut-off)\b/i, 'Knowledge cut-off remark'],
  [/\bas of my last (?:knowledge )?update\b/i, '“As of my last update”'], [/\bI hope this helps\b/i, '“I hope this helps”'], [/\b(?:ChatGPT|GPT-4|GPT-3\.5)\b(?![^.]{0,80}\b(?:was used|were used|assist|tool|study|evaluat))/i, 'Chatbot name in the text'],
  [/\[insert [^\]]{2,40}\]/i, 'Unfilled “[insert …]” placeholder'], [/\blorem ipsum\b/i, 'Lorem ipsum placeholder'], [/\((?:Author|Authors|Smith) et al\.?,? (?:Year|20XX|XXXX)\)/i, 'Placeholder citation (Author, Year)'],
  [/\[(?:citation needed|reference|ref|citation)\]/i, 'Placeholder citation marker'], [/\bXX(?:\.X+)?\s?%/, 'Placeholder number (XX%)'], [/\bp\s*[<=]\s*0\.0X\b/i, 'Placeholder p-value']
];

// Wording typical of mill templates in pharmacology / oncology papers (several together raise the signal)
const TEMPLATES = [
  [/\bnetwork pharmacology\b/i, 'Network pharmacology'], [/\bmolecular docking\b/i, 'Molecular docking'], [/\bhub genes?\b/i, 'Hub genes'],
  [/\b(?:KEGG|GO) enrichment\b/i, 'KEGG/GO enrichment'], [/\bSTRING database\b/i, 'STRING database'], [/\bGEO (?:database|datasets?)\b/i, 'GEO database mining'],
  [/\b(?:miR|microRNA)-\d+[a-z]?(?:-\dp)?\s+(?:sponges?|targets?|regulates?)\b/i, '“miR-X targets/sponges Y”'], [/\b(?:lncRNA|circRNA|circ_\d+)\b[^.]{0,60}\bsponge/i, 'lncRNA/circRNA sponge'],
  [/\bvia (?:the )?[A-Z0-9-]{2,10}\/[A-Z0-9-]{2,10}(?:\/[A-Z0-9-]{2,10})? (?:signal(?:l)?ing )?(?:pathway|axis)\b/, '“via the A/B pathway”'],
  [/\b(?:promot|inhibit|suppress|enhanc|reduc|attenuat)\w*\b[^.]{0,80}\bproliferation, migration,? and invasion\b/i, '“proliferation, migration and invasion”'],
  [/\bbioinformatics analysis\b/i, 'Bioinformatics analysis'], [/\bceRNA network\b/i, 'ceRNA network'], [/\bTCMSP\b/, 'TCMSP database'], [/\bSwissTargetPrediction\b/i, 'SwissTargetPrediction']
];

// ICLAC register of misidentified cell lines (most frequent in pharmacology papers): name -> actual identity
const CELL_LINES = [
  ['HEp-2', 'HeLa (cervical adenocarcinoma)'], ['Hep-2', 'HeLa (cervical adenocarcinoma)'], ['KB', 'HeLa (cervical adenocarcinoma)'], ['INT-407', 'HeLa'], ['Intestine 407', 'HeLa'],
  ['Chang liver', 'HeLa'], ['WISH', 'HeLa'], ['L-132', 'HeLa'], ['AV3', 'HeLa'], ['J-111', 'HeLa'], ['BEL-7402', 'HeLa'], ['BEL-7404', 'HeLa'], ['SMMC-7721', 'HeLa'],
  ['L-02', 'HeLa'], ['HL-7702', 'HeLa'], ['QGY-7701', 'HeLa'], ['QGY-7703', 'HeLa'], ['SPC-A-1', 'HeLa'], ['SGC-7901', 'HeLa'], ['MGC-803', 'HeLa hybrid'], ['BGC-823', 'HeLa'],
  ['CNE-1', 'HeLa hybrid'], ['CNE-2', 'HeLa hybrid'], ['HO-8910', 'HeLa'], ['Tca8113', 'HeLa'], ['MDA-MB-435', 'M14 (melanoma)'], ['ECV304', 'T24 (bladder carcinoma)'],
  ['ECV-304', 'T24 (bladder carcinoma)'], ['EJ', 'T24 (bladder carcinoma)'], ['BIU-87', 'T24 (bladder carcinoma)'], ['NPA', 'M14 (melanoma)'], ['ARO', 'HT-29 (colon adenocarcinoma)'],
  ['KAT-4', 'HT-29 (colon adenocarcinoma)']
].map(([name, actual]) => ({ name, actual }));

const FREE_MAIL = /@(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mail|gmx|yandex|protonmail|proton|zoho|rediffmail|163|126|qq|sina|sohu|yeah|foxmail|aliyun|139)\.[a-z.]{2,6}\b/i;

module.exports = { TORTURED, AI_LEFTOVERS, TEMPLATES, CELL_LINES, FREE_MAIL };
