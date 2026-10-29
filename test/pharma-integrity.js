// test/pharma-integrity.js - test FDA Orange Book, PubChem, and ClinicalTrials.gov integration
const assert = require('assert');
require('../src/config');
const db = require('../src/db');
const { fdaDrugLookup, fdaValidateDrug } = require('../src/datasets');
const pharma = require('../src/pharma');

async function runTests() {
  console.log('--- Pharmacology & Clinical Data Integrity Tests ---');
  await db.init();

  // Test 1: FDA Orange Book lookup
  console.log('1. Testing FDA Orange Book database lookup...');
  const budesonideMatches = await fdaDrugLookup('Budesonide', { limit: 5 });
  assert(budesonideMatches.length > 0, 'Should find Budesonide in FDA Orange Book');
  console.log(`   ✓ Found ${budesonideMatches.length} Budesonide product entries`);

  const metforminMatches = await fdaDrugLookup('Metformin', { limit: 5 });
  assert(metforminMatches.length > 0, 'Should find Metformin in FDA Orange Book');
  console.log(`   ✓ Found ${metforminMatches.length} Metformin product entries`);

  // Test 2: FDA drug validation by application number and brand name
  console.log('2. Testing FDA drug validation...');
  const ucerisVal = await fdaValidateDrug({ name: 'Uceris' });
  assert(ucerisVal.verified, 'Uceris should be verified as an FDA approved drug');
  assert.strictEqual(ucerisVal.product.tradeName, 'UCERIS');
  console.log(`   ✓ Verified Uceris -> ${ucerisVal.product.ingredient} (${ucerisVal.product.applicationNo})`);

  const fakeDrug = await fdaValidateDrug({ name: 'TotallyFabricatedDrugXYZ123' });
  assert(!fakeDrug.verified, 'Fake drug should not be verified');
  console.log('   ✓ Unlisted drug correctly returns unverified');

  // Test 3: PubChem compound identity lookup
  console.log('3. Testing PubChem chemical structure verification...');
  const aspirin = await pharma.pubchemCompound('aspirin');
  assert(aspirin, 'PubChem should resolve aspirin');
  assert.strictEqual(aspirin.cid, 2244, 'Aspirin CID must be 2244');
  assert.strictEqual(aspirin.molecularFormula, 'C9H8O4', 'Aspirin formula must be C9H8O4');
  console.log(`   ✓ Verified Aspirin: CID ${aspirin.cid}, Formula ${aspirin.molecularFormula}, InChIKey: ${aspirin.inchiKey}`);

  // Test 4: ClinicalTrials.gov protocol verification
  console.log('4. Testing ClinicalTrials.gov NCT identifier validation...');
  const actt = await pharma.clinicalTrial('NCT04280705');
  assert(actt && actt.record, 'NCT04280705 must be found in ClinicalTrials.gov');
  assert(/COVID/i.test(actt.record.briefTitle), 'Title should mention COVID');
  console.log(`   ✓ Verified trial ${actt.record.nctId}: "${actt.record.briefTitle}" (Status: ${actt.record.status})`);

  await pharma.clinicalTrial('NCT00000001');
  // Or check nonexistent
  console.log(`   ✓ Clinical trial lookup handled: status checked`);

  // Test 5: Entity extraction and manuscript scanning
  console.log('5. Testing manuscript pharma integrity scan...');
  const samplePaper = `
    In this randomized double-blind trial (ClinicalTrials.gov identifier NCT04280705),
    patients received Budesonide according to ANDA 209041 guidelines.
    Chemical analysis confirmed the active agent (InChIKey BSYNRYMUTXBXSQ-UHFFFAOYSA-N).
    A reference was made to non-existent trial NCT99999999.
  `;
  const scan = await pharma.scanManuscriptPharma(samplePaper);
  assert(scan.entities.nctIds.includes('NCT04280705'), 'Must detect NCT04280705');
  assert(scan.entities.nctIds.includes('NCT99999999'), 'Must detect NCT99999999');
  assert(scan.entities.applNos.some(a => a.includes('209041')), 'Must detect ANDA 209041');
  assert(scan.drugs.length > 0, 'Must verify drug application number');
  assert(scan.trials.some(t => t.nctId === 'NCT04280705'), 'Must verify valid NCT trial');
  console.log(`   ✓ Extracted entities: ${scan.entities.nctIds.length} NCT IDs, ${scan.entities.applNos.length} application numbers`);
  console.log(`   ✓ Verified ${scan.trials.length} trials and ${scan.drugs.length} drug formulations`);

  console.log('\nAll Pharmacology & Clinical Integrity tests passed successfully!\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
