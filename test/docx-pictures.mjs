// test/docx-pictures.mjs - Module 5 reads each Word picture once: figures laid out in text boxes (with Word's fallback
// copy for older readers) and tracked deletions are not read again as extra pictures.
// Run: node test/docx-pictures.mjs
import assert from 'assert';
import { createRequire } from 'module';
import { docxPictureUses } from '../public/js/images/extract.js';
const { DOMParser } = createRequire(import.meta.url)('@xmldom/xmldom');

const NS = 'xmlns:w="w" xmlns:a="a" xmlns:r="r" xmlns:v="v" xmlns:mc="mc" xmlns:wps="wps" xmlns:wp="wp"';
const pic = id => `<w:r><w:drawing><wp:inline><a:graphic><a:blip r:embed="${id}"/></a:graphic></wp:inline></w:drawing></w:r>`;
const text = t => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const box = inner => `<w:txbxContent>${inner}</w:txbxContent>`;
// Fig. 9 and Fig. 10 side by side in one text box; Word stores the box twice (drawing + VML fallback)
const grouped = (a, b, fa, fb) => `<w:p><w:r><mc:AlternateContent>
  <mc:Choice><w:drawing><wps:txbx>${box(`<w:p>${pic(a)}</w:p>${text('Fig. 9: Effect on immobility')}<w:p>${pic(b)}</w:p>${text('Fig. 10: Corticosterone')}`)}</wps:txbx></w:drawing></mc:Choice>
  <mc:Fallback><w:pict><v:textbox>${box(`<w:p><w:r><w:pict><v:imagedata r:id="${fa}"/></w:pict></w:r></w:p>${text('Fig. 9: Effect on immobility')}<w:p>${pic(fb)}</w:p>${text('Fig. 10: Corticosterone')}`)}</v:textbox></w:pict></mc:Fallback>
</mc:AlternateContent></w:r></w:p>`;

const xml = new DOMParser().parseFromString(`<w:document ${NS}><w:body>
  <w:p>${pic('rIdA')}</w:p>${text('Figure 1: GC-MS chromatogram')}
  ${grouped('rId9', 'rId10', 'rId91', 'rId101')}
  ${text('Results continue here.')}
  <w:p><w:del><w:r><w:drawing><a:blip r:embed="rIdOld"/></w:drawing></w:r></w:del>${pic('rIdNew')}</w:p>${text('Fig. 11: Histopathology')}
</w:body></w:document>`, 'text/xml');

const uses = docxPictureUses(xml);
assert.deepStrictEqual(uses.map(u => u.id), ['rIdA', 'rId9', 'rId10', 'rIdNew'], 'each picture once; fallback copies and deleted pictures left out');
assert.deepStrictEqual(uses.map(u => u.caption), ['Fig. 1', 'Fig. 9', 'Fig. 10', 'Fig. 11'], 'each picture keeps its own caption');
assert.ok(uses.every(u => u.sub === 0), 'pictures in their own paragraphs are not numbered as parts');

// Two pictures in one paragraph are still read as parts of one figure
const two = new DOMParser().parseFromString(`<w:document ${NS}><w:body><w:p>${pic('r1')}${pic('r2')}</w:p>${text('Fig. 3')}</w:body></w:document>`, 'text/xml');
assert.deepStrictEqual(docxPictureUses(two).map(u => [u.id, u.caption, u.sub]), [['r1', 'Fig. 3', 1], ['r2', 'Fig. 3', 2]]);

console.log('docx-pictures: ok');
