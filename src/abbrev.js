// abbrev.js - ISO 4 style journal-title abbreviations shared by the style checker (Module 2) and the PJPS converter

// ISO 4 abbreviations of the words most often found in biomedical journal titles
const ISO4 = {
  journal: 'J.', pakistan: 'Pak.', pharmaceutical: 'Pharm.', pharmacy: 'Pharm.', pharmacology: 'Pharmacol.', pharmacological: 'Pharmacol.',
  pharmacognosy: 'Pharmacogn.', sciences: 'Sci.', science: 'Sci.', scientific: 'Sci.', international: 'Int.', research: 'Res.', medical: 'Med.',
  medicine: 'Med.', medicinal: 'Med.', chemistry: 'Chem.', chemical: 'Chem.', biology: 'Biol.', biological: 'Biol.', biochemistry: 'Biochem.',
  biotechnology: 'Biotechnol.', clinical: 'Clin.', american: 'Am.', european: 'Eur.', british: 'Br.', indian: 'Indian', african: 'Afr.',
  asian: 'Asian', applied: 'Appl.', analytical: 'Anal.', microbiology: 'Microbiol.', molecular: 'Mol.', natural: 'Nat.', products: 'Prod.',
  ethnopharmacology: 'Ethnopharmacol.', toxicology: 'Toxicol.', society: 'Soc.', association: 'Assoc.', annals: 'Ann.', archives: 'Arch.',
  reviews: 'Rev.', review: 'Rev.', letters: 'Lett.', advances: 'Adv.', current: 'Curr.', experimental: 'Exp.', environmental: 'Environ.',
  health: 'Health', public: 'Public', nutrition: 'Nutr.', food: 'Food', agricultural: 'Agric.', agriculture: 'Agric.', veterinary: 'Vet.',
  physiology: 'Physiol.', pathology: 'Pathol.', immunology: 'Immunol.', oncology: 'Oncol.', cancer: 'Cancer', cardiology: 'Cardiol.',
  diabetes: 'Diabetes', endocrinology: 'Endocrinol.', therapeutics: 'Ther.', therapy: 'Ther.', drug: 'Drug', drugs: 'Drugs', delivery: 'Deliv.',
  technology: 'Technol.', engineering: 'Eng.', development: 'Dev.', industrial: 'Ind.', university: 'Univ.', college: 'Coll.', physicians: 'Physicians',
  surgeons: 'Surg.', surgery: 'Surg.', dental: 'Dent.', nursing: 'Nurs.', education: 'Educ.', biomedical: 'Biomed.', biomedicine: 'Biomed.',
  infectious: 'Infect.', diseases: 'Dis.', disease: 'Dis.', antimicrobial: 'Antimicrob.', agents: 'Agents', chemotherapy: 'Chemother.',
  pharmaceutics: 'Pharm.', phytochemistry: 'Phytochemistry', phytotherapy: 'Phytother.', complementary: 'Complement.', alternative: 'Altern.',
  evidence: 'Evid.', based: 'Based', traditional: 'Tradit.', bulletin: 'Bull.', communications: 'Commun.', proceedings: 'Proc.', academy: 'Acad.',
  national: 'Natl.', saudi: 'Saudi', iranian: 'Iran.', turkish: 'Turk.', chinese: 'Chin.', japanese: 'Jpn.', korean: 'Korean', brazilian: 'Braz.',
  tropical: 'Trop.', basic: 'Basic', advanced: 'Adv.', heterocyclic: 'Heterocycl.', organic: 'Org.', inorganic: 'Inorg.', physical: 'Phys.',
  medica: 'Med.', acta: 'Acta', quality: 'Qual.', safety: 'Saf.', statistics: 'Stat.', statistical: 'Stat.', methods: 'Methods', bioscience: 'Biosci.',
  biosciences: 'Biosci.', genetics: 'Genet.', genomics: 'Genomics', cell: 'Cell', cellular: 'Cell.', neuroscience: 'Neurosci.', psychiatry: 'Psychiatry'
};
const DROP = new Set(['of', 'the', 'and', '&', 'for', 'in', 'on', 'de', 'la', 'et', 'a']);

/** Expected ISO-style abbreviation of a full journal title, or null when the words are unknown */
function abbreviateJournal(name) {
  const words = String(name || '').replace(/[.,:]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  let known = 0;
  const out = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (DROP.has(lw)) continue;
    if (ISO4[lw]) { out.push(ISO4[lw]); known++; } else out.push(w);
  }
  return known ? out.join(' ') : null;
}


// abbreviation stem (no dot, lower case) -> abbreviated form, e.g. 'pharm' -> 'Pharm.'
const STEMS = new Map();
for (const v of Object.values(ISO4)) if (v.endsWith('.')) STEMS.set(v.slice(0, -1).toLowerCase(), v);

/** Journal name in PJPS form: full titles are abbreviated; dot-less abbreviations (Pak J Pharm Sci) get their dots */
function pjpsJournal(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) return n;
  const words = n.replace(/[.,:]/g, ' ').split(' ').filter(Boolean);
  if (words.length < 2) return n;
  let known = 0;
  const out = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (DROP.has(lw)) continue;
    if (ISO4[lw]) { out.push(ISO4[lw]); known++; } else if (STEMS.has(lw)) { out.push(STEMS.get(lw)); known++; } else out.push(w);
  }
  return known ? out.join(' ') : n;
}

module.exports = { ISO4, DROP, abbreviateJournal, pjpsJournal };
