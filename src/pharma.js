// pharma.js - Pharmacology, Drug and Clinical Trial Data Integrity Engine
// Integrates:
// 1. FDA Orange Book (Approved Drug Products, active ingredients, dosage forms, NDA/ANDA applications)
// 2. PubChem (Chemical identity, molecular formulas, IUPAC names, InChIKeys, CIDs)
// 3. ClinicalTrials.gov (NCT protocol verification, trial phase, status, drug interventions, sponsors)

const { getJson } = require('./http');
const { fdaDrugLookup, fdaValidateDrug } = require('./datasets');
const { normalize } = require('./text');

const enc = encodeURIComponent;

// ------------------------------------------------------------------ PubChem (NCBI PUG-REST)

async function pubchemCompound(nameOrCid) {
  if (!nameOrCid) return null;
  const term = String(nameOrCid).trim();
  const isCid = /^\d+$/.test(term);
  const path = isCid ? `cid/${enc(term)}` : `name/${enc(term)}`;
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/${path}/property/MolecularFormula,MolecularWeight,IUPACName,InChIKey,CanonicalSMILES,ConnectivitySMILES/JSON`;

  const r = await getJson(url, { ttl: 30 * 86400, timeout: 15000 });
  if (!r.ok || !r.data?.PropertyTable?.Properties?.length) {
    return null;
  }

  const p = r.data.PropertyTable.Properties[0];
  return {
    source: 'PubChem',
    cid: p.CID,
    name: term,
    molecularFormula: p.MolecularFormula || '',
    molecularWeight: parseFloat(p.MolecularWeight) || p.MolecularWeight,
    iupacName: p.IUPACName || '',
    inchiKey: p.InChIKey || '',
    smiles: p.ConnectivitySMILES || p.CanonicalSMILES || '',
    url: `https://pubchem.ncbi.nlm.nih.gov/compound/${p.CID}`
  };
}

// ------------------------------------------------------------------ ClinicalTrials.gov (REST API v2)

function parseStudy(data) {
  if (!data?.protocolSection) return null;
  const proto = data.protocolSection;
  const idMod = proto.identificationModule || {};
  const statusMod = proto.statusModule || {};
  const designMod = proto.designModule || {};
  const condMod = proto.conditionsModule || {};
  const armMod = proto.armsInterventionsModule || {};
  const sponsorMod = proto.sponsorCollaboratorsModule || {};
  const descMod = proto.descriptionModule || {};

  return {
    source: 'ClinicalTrials.gov',
    nctId: idMod.nctId,
    briefTitle: idMod.briefTitle || '',
    officialTitle: idMod.officialTitle || idMod.briefTitle || '',
    acronym: idMod.acronym || '',
    organization: idMod.organization?.fullName || '',
    status: statusMod.overallStatus || 'UNKNOWN',
    phase: (designMod.phases || []).join(', ') || 'N/A',
    studyType: designMod.studyType || 'Interventional',
    conditions: condMod.conditions || [],
    interventions: (armMod.interventions || []).map(i => ({ type: i.type, name: i.name, description: i.description || '' })),
    leadSponsor: sponsorMod.leadSponsor?.name || 'N/A',
    startDate: statusMod.startDateStruct?.date || '',
    completionDate: statusMod.completionDateStruct?.date || '',
    resultsPosted: !!statusMod.resultsFirstPostDateStruct?.date,
    resultsDate: statusMod.resultsFirstPostDateStruct?.date || '',
    briefSummary: descMod.briefSummary || '',
    url: `https://clinicaltrials.gov/study/${idMod.nctId}`
  };
}

async function clinicalTrial(nctId) {
  if (!nctId) return null;
  const clean = String(nctId).trim().toUpperCase();
  const match = clean.match(/NCT\d{8}/i);
  if (!match) return null;
  const id = match[0].toUpperCase();

  const r = await getJson(`https://clinicaltrials.gov/api/v2/studies/${enc(id)}`, { ttl: 14 * 86400, timeout: 15000 });
  if (r.status === 404) return { notFound: true, nctId: id };
  if (!r.ok || !r.data) return { error: r.error || r.status, nctId: id };

  const study = parseStudy(r.data);
  return study ? { record: study } : { notFound: true, nctId: id };
}

async function searchClinicalTrials(query, { pageSize = 5 } = {}) {
  if (!query || String(query).trim().length < 2) return [];
  const term = String(query).trim();
  const r = await getJson(`https://clinicaltrials.gov/api/v2/studies?query.term=${enc(term)}&pageSize=${pageSize}`, { ttl: 7 * 86400, timeout: 15000 });
  if (!r.ok || !r.data?.studies) return [];
  return r.data.studies.map(parseStudy).filter(Boolean);
}

// ------------------------------------------------------------------ Entity Extraction & Integrity Verification

/** Extract pharmaceutical & clinical identifiers from free text */
function extractPharmaEntities(text) {
  if (!text || typeof text !== 'string') return { nctIds: [], applNos: [], inchiKeys: [], casNumbers: [] };

  // Clinical trial IDs: NCT01234567
  const nctIds = [...new Set((text.match(/\bNCT\d{8}\b/gi) || []).map(s => s.toUpperCase()))];

  // FDA NDA/ANDA numbers: NDA 205613, ANDA 215328, NDA# 123456
  const applMatches = [...text.matchAll(/\b(NDA|ANDA)\s*(?:#|no\.?|number)?\s*(\d{5,7})\b/gi)];
  const applNos = [...new Set(applMatches.map(m => `${m[1].toUpperCase()} ${m[2]}`))];

  // InChIKeys: 27-character standard chemical identifier (14-10-1 uppercase letters)
  const inchiKeys = [...new Set(text.match(/\b[A-Z]{14}-[A-Z]{10}-[A-Z]\b/g) || [])];

  // CAS Registry Numbers: 2-7 digits, hyphen, 2 digits, hyphen, 1 digit
  const casMatches = text.match(/\b\d{2,7}-\d{2}-\d\b/g) || [];
  // Validate CAS checksum
  const casNumbers = [...new Set(casMatches.filter(cas => {
    const parts = cas.split('-');
    if (parts.length !== 3) return false;
    const digits = (parts[0] + parts[1]).split('').map(Number);
    const check = Number(parts[2]);
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      sum += digits[digits.length - 1 - i] * (i + 1);
    }
    return sum % 10 === check;
  }))];

  return { nctIds, applNos, inchiKeys, casNumbers };
}

/** Full integrity check for a drug or clinical claim */
async function verifyPharmaIntegrity({ drugName, ingredient, applNo, nctId, chemicalName }) {
  const findings = [];
  let drugResult = null;
  let compoundResult = null;
  let trialResult = null;

  // 1. FDA Orange Book check
  if (drugName || ingredient || applNo) {
    const fda = await fdaValidateDrug({ name: drugName, ingredient, applNo });
    drugResult = fda;
    if (fda.verified) {
      findings.push({
        type: 'fda_verified',
        severity: 'good',
        title: `FDA Approved Drug Verified: ${fda.product.tradeName}`,
        detail: `${fda.product.ingredient} | ${fda.product.strength} | ${fda.product.dosageFormRoute} (${fda.product.applicationNo}, ${fda.product.applicant})`
      });
    } else if (drugName || ingredient) {
      findings.push({
        type: 'fda_unverified',
        severity: 'info',
        title: `No direct FDA Orange Book record for "${drugName || ingredient}"`,
        detail: 'The substance may be an investigational agent, foreign brand name, biologic, or chemical intermediate not listed in the FDA Orange Book.'
      });
    }
  }

  // 2. PubChem chemical structure check
  const chemQuery = chemicalName || ingredient || drugName;
  if (chemQuery) {
    const chem = await pubchemCompound(chemQuery);
    compoundResult = chem;
    if (chem) {
      findings.push({
        type: 'pubchem_verified',
        severity: 'good',
        title: `Chemical Structure Verified: ${chem.name}`,
        detail: `CID: ${chem.cid} | Formula: ${chem.molecularFormula} | MW: ${chem.molecularWeight} g/mol | InChIKey: ${chem.inchiKey}`
      });
    }
  }

  // 3. ClinicalTrials.gov check
  if (nctId) {
    const trial = await clinicalTrial(nctId);
    trialResult = trial;
    if (trial?.record) {
      findings.push({
        type: 'clinical_trial_verified',
        severity: 'good',
        title: `Clinical Trial Verified: ${trial.record.nctId} (${trial.record.status})`,
        detail: `${trial.record.briefTitle} — Phase: ${trial.record.phase} | Sponsor: ${trial.record.leadSponsor}`
      });
    } else if (trial?.notFound) {
      findings.push({
        type: 'clinical_trial_invalid',
        severity: 'bad',
        title: `Clinical Trial ID ${nctId.toUpperCase()} NOT Found in ClinicalTrials.gov`,
        detail: 'The cited clinical trial registration number does not exist in the official ClinicalTrials.gov registry.'
      });
    }
  }

  return {
    verified: findings.some(f => f.severity === 'good'),
    hasFlag: findings.some(f => f.severity === 'bad'),
    findings,
    drug: drugResult,
    chemical: compoundResult,
    trial: trialResult
  };
}

/** Scan a full manuscript text for pharmaceutical and clinical claims */
async function scanManuscriptPharma(text) {
  const entities = extractPharmaEntities(text);
  const results = {
    trials: [],
    drugs: [],
    compounds: [],
    flags: []
  };

  // Verify all NCT IDs found
  for (const nct of entities.nctIds.slice(0, 10)) {
    const t = await clinicalTrial(nct);
    if (t?.record) {
      results.trials.push(t.record);
    } else if (t?.notFound) {
      results.flags.push({
        type: 'fabricated_trial_id',
        severity: 'bad',
        id: nct,
        message: `Manuscript cites clinical trial identifier ${nct}, but this registration does not exist in ClinicalTrials.gov.`
      });
    }
  }

  // Verify all FDA application numbers found
  for (const appl of entities.applNos.slice(0, 10)) {
    const num = appl.replace(/\D/g, '');
    const lookup = await fdaDrugLookup(num, { limit: 5 });
    if (lookup.length) {
      results.drugs.push({
        applNo: appl,
        products: lookup.map(l => ({
          tradeName: l.trade_name,
          ingredient: l.ingredient,
          strength: l.strength,
          dosageFormRoute: l.dosage_form_route,
          applicant: l.applicant,
          approvalDate: l.approval_date
        }))
      });
    } else {
      results.flags.push({
        type: 'unverified_application_number',
        severity: 'warn',
        id: appl,
        message: `Manuscript cites application number ${appl}, but no matching approved product was found in the FDA Orange Book.`
      });
    }
  }

  return {
    entities,
    trials: results.trials,
    drugs: results.drugs,
    flags: results.flags,
    summary: {
      trialCount: results.trials.length,
      invalidTrialCount: results.flags.filter(f => f.type === 'fabricated_trial_id').length,
      drugCount: results.drugs.length,
      flagCount: results.flags.length
    }
  };
}

module.exports = {
  pubchemCompound,
  clinicalTrial,
  searchClinicalTrials,
  extractPharmaEntities,
  verifyPharmaIntegrity,
  scanManuscriptPharma,
  fdaDrugLookup,
  fdaValidateDrug
};
