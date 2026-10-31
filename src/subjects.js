// subjects.js - the PJPS subject areas, with the searches that fill the subject-specific datasets:
//   pmc   PubMed Central (E-utilities) query for Module 5's published-figure database (open-access papers' figures)
//   epmc  Europe PMC query for the text repository behind the similarity report (open-access full texts)
//   rw    Retraction Watch "Subject" codes of the field: paper-mill retractions in it go into Module 5's retracted figures
// One list, so every dataset covers the same fields.
const S = (id, name, terms, rw) => ({ id, name, terms, rw });

const SUBJECTS = [
  S('drug-delivery', 'Drug Delivery Systems', ['"drug delivery"', '"controlled release"', '"sustained release"', 'nanocarrier*', 'liposom*', 'microsphere*', 'hydrogel*'], /Pharmacology|Drug/i),
  S('drug-design', 'Drug Design & Synthesis', ['"drug design"', '"drug discovery"', '"medicinal chemistry"', '"structure-activity relationship"', 'synthesis AND derivatives'], /Chemistry|Pharmacology/i),
  S('clinical-pharmacology', 'Clinical Pharmacology', ['"clinical pharmacology"', '"drug-drug interaction*"', '"adverse drug reaction*"', '"randomized controlled trial"'], /Pharmacology|Medicine/i),
  S('pharmacokinetics', 'Pharmacokinetics', ['pharmacokinetic*', 'bioavailability', '"plasma concentration*"', 'AUC AND Cmax'], /Pharmacology/i),
  S('natural-products', 'Natural Products', ['"natural product*"', '"plant extract*"', 'phytochemical*', 'flavonoid*', '"essential oil*"'], /Pharmacology|Chemistry|Botany|Alternative/i),
  S('pharmaceutical-analysis', 'Pharmaceutical Analysis', ['HPLC', '"method validation"', '"stability-indicating"', 'chromatograph*', 'spectrophotometr*'], /Chemistry - Analytical|Chemistry/i),
  S('toxicology', 'Toxicology', ['toxicity', 'toxicolog*', 'hepatotoxic*', 'nephrotoxic*', '"oxidative stress"'], /Toxicology|Pharmacology/i),
  S('microbiology', 'Microbiology', ['antibacterial', 'antimicrobial', 'antifungal', '"biofilm*"', '"minimum inhibitory concentration"'], /Microbiology|Infectious/i),
  S('biotechnology', 'Biotechnology', ['biotechnolog*', '"recombinant protein*"', 'fermentation', '"gene expression"'], /Biotechnology|Genetics/i),
  S('pharmacognosy', 'Pharmacognosy', ['pharmacognos*', '"medicinal plant*"', 'ethnopharmacolog*', '"traditional medicine"', '"herbal medicine"'], /Alternative|Botany|Pharmacology/i),
  S('immunology', 'Immunology', ['immunolog*', 'cytokine*', 'inflammat*', '"T cell*"', 'macrophage*'], /Immunology/i),
  S('neuroscience', 'Neuroscience', ['neuroscien*', 'neuroprotect*', 'neurodegenerat*', '"Alzheimer*"', 'hippocamp*'], /Neuroscience|Neurology/i),
  S('pharmacotherapeutics', 'Pharmacotherapeutics', ['pharmacotherap*', '"drug therapy"', '"treatment outcome*"', '"rational drug use"'], /Medicine|Pharmacology/i),
  S('nanotechnology', 'Nanotechnology', ['nanoparticle*', 'nanotechnolog*', 'nanoformulation*', '"green synthesis"', 'nanocomposite*'], /Nanotechnology|Materials/i),
  S('biopharmaceutics', 'Biopharmaceutics', ['biopharmaceutic*', 'dissolution', 'permeability AND absorption', '"bioequivalence"'], /Pharmacology/i),
  S('pharmacogenomics', 'Pharmacogenomics', ['pharmacogenom*', 'pharmacogenetic*', 'polymorphism* AND drug', 'CYP2D6', 'CYP2C19'], /Genetics|Pharmacology/i),
  S('biochemistry', 'Biochemistry', ['biochemi*', '"enzyme inhibition"', 'apoptosis', '"western blot*"', '"signaling pathway"'], /Biochemistry|Biology - Molecular|Biology - Cellular/i),
  S('materials-science', 'Materials Science', ['"materials science"', 'polymer*', 'biomaterial*', 'scaffold*', 'composite*'], /Materials|Engineering/i),
  S('molecular-modeling', 'Molecular Modeling', ['"molecular docking"', '"molecular dynamics"', '"in silico"', 'QSAR', '"molecular modeling"'], /Chemistry|Computer|Bioinformatics/i)
];

// PubMed Central: title/abstract terms of the subject, open-access subset (figures can be downloaded)
// (each term in brackets: "AUC AND Cmax" inside the OR list would otherwise narrow the whole query)
const pmcQuery = s => `(${s.terms.map(t => `(${t.split(' AND ').map(w => `${w}[tiab]`).join(' AND ')})`).join(' OR ')}) AND open access[filter]`;
// Europe PMC: open-access research articles with full text
const epmcQuery = s => `(${s.terms.map(t => `(TITLE_ABS:${t.includes(' AND ') ? `(${t})` : t})`).join(' OR ')}) AND OPEN_ACCESS:y AND HAS_FT:y AND PUB_TYPE:"research-article"`;
/** The PJPS subjects a Retraction Watch "Subject" field falls under ("(BLS) Biology - Molecular;(HSC) Medicine - Oncology;") */
const rwSubjects = subjectField => SUBJECTS.filter(s => s.rw.test(String(subjectField || '')));

module.exports = { SUBJECTS, pmcQuery, epmcQuery, rwSubjects };
