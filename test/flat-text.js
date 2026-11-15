// test/flat-text.js - a manuscript whose line breaks were lost (some PDFs give the whole article as one line): the reference
// list is found after its heading inside the line, the run-together references are split (after a word, a bracket or a page
// range without a full stop, particle surnames, organisations as authors) and a citation written differently from its
// entry ("Abu, 2017" for "Abu Arab W (2017)") is one name-form note, not a missing and an uncited reference.
// Measured on 38 published PJPS articles (15 Nov 2026): wrong "not in the list" flags 114 -> 26.
const assert = require('assert');
const P = require('../src/parse');
const { prepare } = require('../src/pipeline');
const { checkCitations } = require('../src/checks/citation');

const body = 'INTRODUCTION Ferroptosis was described in detail (Dixon et al., 2012). Diabetes affects many patients (Sabu and Kuttan, 2004; ' +
  'Percie du Sert et al., 2020). Plant monographs were consulted (ESCOP, 2003) and the surgery was reviewed (Abu, 2017). ' +
  'The histamine assay followed Barrett and Pearce (1983) and statistics followed Johansen et al. (2014). '.repeat(3) +
  'Further work is needed. ';
const refs = 'REFERENCES Abu Arab W (2017). Video-assisted thoracoscopic surgery for non-small cell lung cancer. Minim Invasive Surg. Oncol., 1(1): 1-11. ' +
  'Backer CA and van den Brink RCB (1965). Flora of Java, Vol.II, The Netherlands: N.V.P. Noordhoff. ' +
  'Barrett KE and Pearce FL (1983). A comparison of histamine secretion from isolated peritoneal mast cells of the mouse and rat. Int. Arch. Allergy Appl. Immunol., 72(3): 234-238. ' +
  'Dixon SJ, Lemberg KM and Stockwell BR (2012). Ferroptosis: an iron-dependent form of nonapoptotic cell death. Cell, 149(5): 1060-1072. ' +
  'ESCOP Monographs (2003). Uvae ursi folium. European Scientific Cooperative on Phytotherapy, Exeter, pp.536-544. ' +
  'Iqbal S, Dodani S and Qureshi R (2004). Risk factors for coronary artery disease among ambulatory Pakistanis. J. Pak. Med. Assoc., 54(5): 261- 266 ' +
  'Johansen JS, Harris AK and Ergul A (2014). Oxidative stress and the use of antioxidants in diabetes. Cardiovasc. Diabetol., 4(1): 5. ' +
  'Percie du Sert N, Hurst V and Ahluwalia A (2020). The ARRIVE guidelines 2.0. PLoS Biol., 18(7): e3000410. ' +
  'Riyanto S (2003). Phytochemical studies of Murraya paniculata, Dissertation, Universiti Putra, Malaysia. ' +
  'Sabu MC and Kuttan R (2004). Anti-diabetic activity of Aegle marmelos. Indian J. Physiol. Pharmacol., 48(1): 81-88.';
const text = 'Pak. J. Pharm. Sci., Vol.24, No.3, July 2011 ' + body.repeat(2) + refs;
assert.ok(!text.includes('\n'), 'the test text is one line');

const sec = P.findReferenceSection(text);
assert.ok(sec.found && sec.flattened, 'reference list found inside the long line');
const { body: b, refs: list } = prepare({ text, kind: 'manuscript' });
assert.deepStrictEqual(list.map(r => r.raw.split(/\s*\(/)[0]), ['Abu Arab W', 'Backer CA and van den Brink RCB', 'Barrett KE and Pearce FL', 'Dixon SJ, Lemberg KM and Stockwell BR',
  'ESCOP Monographs', 'Iqbal S, Dodani S and Qureshi R', 'Johansen JS, Harris AK and Ergul A', 'Percie du Sert N, Hurst V and Ahluwalia A', 'Riyanto S', 'Sabu MC and Kuttan R'], 'run-together references split one by one');

const c = checkCitations(b, list);
assert.deepStrictEqual(c.missing.map(m => m.citation), [], 'every citation has its entry');
assert.deepStrictEqual(c.uncited.map(u => u.raw.split(/\s*\(/)[0]).sort(), ['Backer CA and van den Brink RCB', 'Iqbal S, Dodani S and Qureshi R', 'Riyanto S'], 'only the entries never cited are uncited');
const notes = c.spelling.map(s => s.citation).sort();
assert.deepStrictEqual(notes, ['Abu, 2017', 'ESCOP, 2003'], 'differently written names are one note each');

// a normal Word manuscript (one reference per line) is read as before
const word = P.findReferenceSection('Introduction\nText (Khan, 2019).\nReferences\nKhan A (2019). A title of the paper. J. Pharm. Sci., 1(1): 1-5.\n');
assert.ok(word.found && !word.flattened && /^Khan A/.test(word.references), 'heading on its own line still used');

console.log('flat-text: all checks passed');
