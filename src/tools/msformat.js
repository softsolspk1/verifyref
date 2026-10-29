// tools/msformat.js - Manuscript Format converter: applies a publisher's general submission template to a Word
// manuscript — page size and margins, fonts, line spacing, columns, line numbers, heading styles — restyles the
// citations and references, and checks the section structure for the chosen article type.
const { Docx, W, kids, kid, desc } = require('../ooxml');
const { restyleDocx } = require('./restyle');

const CM = 567; // twips per centimetre
const A4 = { w: 11906, h: 16838 }, LETTER = { w: 12240, h: 15840 };

const TEMPLATES = {
  springer: { label: 'Springer Nature', page: A4, margin: 2.5 * CM, font: 'Times New Roman', size: 12, line: 2, cols: 1, lineNumbers: true, justify: false, style: 'springer', abstractWords: 250 },
  elsevier: { label: 'Elsevier', page: A4, margin: 2.5 * CM, font: 'Times New Roman', size: 12, line: 2, cols: 1, lineNumbers: true, justify: false, style: 'elsevier-harvard', abstractWords: 250 },
  ieee: { label: 'IEEE (conference/transactions)', page: LETTER, margin: { top: 1080, bottom: 1440, left: 900, right: 900 }, font: 'Times New Roman', size: 10, line: 1, cols: 2, colSpace: 360, lineNumbers: false, justify: true, style: 'ieee', abstractWords: 250 },
  wiley: { label: 'Wiley', page: A4, margin: 2.54 * CM, font: 'Times New Roman', size: 12, line: 2, cols: 1, lineNumbers: true, justify: false, style: 'apa7', abstractWords: 250 },
  tandf: { label: 'Taylor & Francis', page: A4, margin: 2.54 * CM, font: 'Times New Roman', size: 12, line: 2, cols: 1, lineNumbers: false, justify: false, style: 'apa7', abstractWords: 200 },
  sage: { label: 'SAGE', page: A4, margin: 2.54 * CM, font: 'Times New Roman', size: 12, line: 2, cols: 1, lineNumbers: false, justify: false, style: 'harvard', abstractWords: 250 },
  mdpi: { label: 'MDPI', page: A4, margin: { top: 1.5 * CM, bottom: 1.5 * CM, left: 1.5 * CM, right: 1.5 * CM }, font: 'Palatino Linotype', size: 10, line: 1, cols: 1, lineNumbers: true, justify: true, style: 'acs', abstractWords: 200 },
  frontiers: { label: 'Frontiers', page: A4, margin: 2.54 * CM, font: 'Times New Roman', size: 12, line: 2, cols: 1, lineNumbers: true, justify: false, style: 'harvard', abstractWords: 350 },
  plos: { label: 'PLOS', page: LETTER, margin: 2.54 * CM, font: 'Arial', size: 10, line: 2, cols: 1, lineNumbers: true, justify: false, style: 'plos', abstractWords: 300 },
  pjps: { label: 'Pakistan J Pharm Sci (PJPS)', page: A4, margin: 2.54 * CM, font: 'Times New Roman', size: 11, line: 1.15, cols: 1, lineNumbers: false, justify: true, style: 'pjps', abstractWords: 250 }
};

const ARTICLE_TYPES = {
  research: { label: 'Research article', sections: ['Abstract', 'Keywords', 'Introduction', 'Materials and Methods|Methods|Methodology', 'Results', 'Discussion', 'Conclusion', 'References'] },
  review: { label: 'Review article', sections: ['Abstract', 'Keywords', 'Introduction', 'Conclusion|Conclusions|Future perspectives', 'References'] },
  short: { label: 'Short communication', sections: ['Abstract', 'Introduction', 'Materials and Methods|Methods', 'Results|Results and Discussion', 'References'] },
  case: { label: 'Case report', sections: ['Abstract', 'Introduction', 'Case presentation|Case report|Case description', 'Discussion', 'Conclusion', 'References'] }
};

const SECTION_WORDS = /^\s*(?:\d+(?:\.\d+)*\.?\s+)?(abstract|summary|key\s*words?|introduction|background|materials? and methods|methods|methodology|experimental|results?(?: and discussion)?|discussion|conclusions?|future perspectives|case (?:presentation|report|description)|acknowledge?ments?|funding|conflicts? of interest|author contributions|references|bibliography|data availability)\s*:?\s*$/i;

const SECT_ORDER = ['headerReference', 'footerReference', 'footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid'];
const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'];

function margins(t) {
  const m = typeof t.margin === 'number' ? { top: t.margin, bottom: t.margin, left: t.margin, right: t.margin } : t.margin;
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)]));
}

function setRunDefaults(d, rPr, t, sizePt, bold) {
  d.setChild(rPr, 'rFonts', { ascii: t.font, hAnsi: t.font, cs: t.font, eastAsia: t.font }, RPR_ORDER);
  d.setChild(rPr, 'sz', { val: Math.round(sizePt * 2) }, RPR_ORDER);
  d.setChild(rPr, 'szCs', { val: Math.round(sizePt * 2) }, RPR_ORDER);
  if (bold !== undefined) {
    for (const x of kids(rPr, 'b')) rPr.removeChild(x);
    if (bold) d.setChild(rPr, 'b', {}, RPR_ORDER);
  }
}

/** Update docDefaults, Normal and Heading 1–3 / Title styles in styles.xml */
function applyStyles(d, t, changes) {
  const s = d.styles;
  if (!s) { changes.push('The document has no style sheet; only direct formatting was changed.'); return; }
  const root = s.documentElement;
  const mk = (name, attrs = {}) => {
    const e = s.createElementNS(W, `w:${name}`);
    for (const [k, v] of Object.entries(attrs)) e.setAttributeNS(W, `w:${k}`, String(v));
    return e;
  };
  // Borrow the document helpers for the style sheet DOM
  const sd = { setChild: (parent, name, attrs, order) => {
    for (const x of kids(parent, name)) parent.removeChild(x);
    const e = mk(name, attrs);
    const idx = order.indexOf(name);
    const before = idx >= 0 ? kids(parent).find(c => order.indexOf(c.localName) > idx) : null;
    parent.insertBefore(e, before || null);
    return e;
  } };
  let defaults = kid(root, 'docDefaults');
  if (!defaults) { defaults = mk('docDefaults'); root.insertBefore(defaults, root.firstChild); }
  let rPrDefault = kid(defaults, 'rPrDefault');
  if (!rPrDefault) { rPrDefault = mk('rPrDefault'); defaults.insertBefore(rPrDefault, defaults.firstChild); }
  let rPr = kid(rPrDefault, 'rPr');
  if (!rPr) { rPr = mk('rPr'); rPrDefault.appendChild(rPr); }
  setRunDefaults(sd, rPr, t, t.size);
  let pPrDefault = kid(defaults, 'pPrDefault');
  if (!pPrDefault) { pPrDefault = mk('pPrDefault'); defaults.appendChild(pPrDefault); }
  let pPr = kid(pPrDefault, 'pPr');
  if (!pPr) { pPr = mk('pPr'); pPrDefault.appendChild(pPr); }
  sd.setChild(pPr, 'spacing', { after: t.line >= 2 ? 0 : 120, line: Math.round(240 * t.line), lineRule: 'auto' }, PPR_ORDER);

  const styles = Array.from(root.getElementsByTagNameNS(W, 'style'));
  const byId = id => styles.find(x => x.getAttributeNS(W, 'styleId') === id);
  const sizes = { Normal: [t.size], Title: [t.size + 4, true], Heading1: [t.size + 2, true], Heading2: [t.size + 1, true], Heading3: [t.size, true] };
  for (const [id, [size, bold]] of Object.entries(sizes)) {
    let st = byId(id);
    if (!st) {
      if (id === 'Normal') continue;
      st = mk('style', { type: 'paragraph', styleId: id });
      const n = mk('name', { val: id === 'Title' ? 'Title' : `heading ${id.slice(-1)}` });
      st.appendChild(n);
      st.appendChild(mk('basedOn', { val: 'Normal' }));
      st.appendChild(mk('next', { val: 'Normal' }));
      st.appendChild(mk('qFormat'));
      const sp = mk('pPr');
      sp.appendChild(mk('keepNext'));
      sp.appendChild(mk('spacing', { before: 240, after: 120 }));
      if (id !== 'Title') sp.appendChild(mk('outlineLvl', { val: Number(id.slice(-1)) - 1 }));
      st.appendChild(sp);
      root.appendChild(st);
    }
    let r = kid(st, 'rPr');
    if (!r) { r = mk('rPr'); st.appendChild(r); }
    setRunDefaults(sd, r, t, size, bold);
    for (const x of kids(r, 'color')) r.removeChild(x); // publisher templates use black headings
    if (id === 'Heading2' || id === 'Heading3') { for (const x of kids(r, 'i')) r.removeChild(x); if (id === 'Heading3') sd.setChild(r, 'i', {}, RPR_ORDER); }
  }
  changes.push(`Default font set to ${t.font} ${t.size} pt, line spacing ${t.line === 1 ? 'single' : t.line === 2 ? 'double' : t.line}; heading styles updated.`);
}

/** Remove direct font/size/spacing overrides so the template's styles apply; normalise alignment */
function normaliseBody(d, t, changes) {
  let runs = 0, paras = 0, headings = 0;
  for (const r of desc(d.body, 'r')) {
    const rPr = kid(r, 'rPr');
    if (!rPr) continue;
    let touched = false;
    for (const name of ['rFonts', 'sz', 'szCs']) for (const x of kids(rPr, name)) { rPr.removeChild(x); touched = true; }
    if (touched) runs++;
  }
  for (const p of d.paragraphs()) {
    const pPr = kid(p, 'pPr');
    const styleEl = pPr && kid(pPr, 'pStyle');
    const style = styleEl ? styleEl.getAttributeNS(W, 'val') : '';
    const text = d.text(p).trim();
    const inTable = (() => { for (let n = p.parentNode; n; n = n.parentNode) if (n.localName === 'tc') return true; return false; })();
    // Unstyled section titles become Heading 1
    if (!inTable && !/^heading|^title/i.test(style) && text && text.length < 60 && SECTION_WORDS.test(text)) {
      const pp = pPr || p.insertBefore(d.el('pPr'), p.firstChild);
      d.setChild(pp, 'pStyle', { val: 'Heading1' }, PPR_ORDER);
      for (const x of kids(pp, 'numPr')) pp.removeChild(x);
      // bold set directly on runs would fight the style; remove it
      for (const r of desc(p, 'r')) { const rp = kid(r, 'rPr'); if (rp) for (const x of [...kids(rp, 'b'), ...kids(rp, 'bCs')]) rp.removeChild(x); }
      headings++;
      continue;
    }
    if (!pPr) continue;
    const sp = kid(pPr, 'spacing');
    if (sp && (sp.getAttributeNS(W, 'line') || sp.getAttributeNS(W, 'lineRule'))) {
      sp.removeAttributeNS(W, 'line');
      sp.removeAttributeNS(W, 'lineRule');
      paras++;
    }
    if (!inTable && !/^heading|^title/i.test(style) && text.length > 120) {
      const jc = kid(pPr, 'jc');
      const cur = jc ? jc.getAttributeNS(W, 'val') : '';
      if (t.justify && cur !== 'both') d.setChild(pPr, 'jc', { val: 'both' }, PPR_ORDER);
      if (!t.justify && cur === 'both') pPr.removeChild(jc);
    }
  }
  changes.push(`Direct formatting removed from ${runs} text runs and ${paras} paragraphs so the template applies.`);
  if (headings) changes.push(`${headings} section title(s) converted to Heading 1.`);
}

function applyPage(d, t, changes) {
  const s = d.sectPr();
  const m = margins(t);
  d.setChild(s, 'pgSz', { w: t.page.w, h: t.page.h }, SECT_ORDER);
  d.setChild(s, 'pgMar', { top: m.top, right: m.right, bottom: m.bottom, left: m.left, header: 708, footer: 708, gutter: 0 }, SECT_ORDER);
  if (t.lineNumbers) d.setChild(s, 'lnNumType', { countBy: 1, restart: 'continuous' }, SECT_ORDER);
  else for (const x of kids(s, 'lnNumType')) s.removeChild(x);
  d.setChild(s, 'cols', t.cols > 1 ? { num: t.cols, space: t.colSpace || 425 } : { space: 708 }, SECT_ORDER);
  changes.push(`Page: ${t.page === A4 ? 'A4' : 'US Letter'}, margins ${(m.top / CM).toFixed(1)}/${(m.left / CM).toFixed(1)} cm, ${t.cols} column(s)${t.lineNumbers ? ', continuous line numbers' : ''}.`);

  // Two-column layouts keep the title block (title, authors, abstract) in one column: section break before Introduction
  if (t.cols > 1) {
    const paras = d.paragraphs();
    const intro = paras.findIndex(p => /^\s*(?:\d+\.?\s*|I\.\s*)?introduction\s*$/i.test(d.text(p)));
    if (intro > 0) {
      const prev = paras[intro - 1];
      let pPr = kid(prev, 'pPr');
      if (!pPr) { pPr = d.el('pPr'); prev.insertBefore(pPr, prev.firstChild); }
      const one = s.cloneNode(true);
      for (const x of [...kids(one, 'cols'), ...kids(one, 'headerReference'), ...kids(one, 'footerReference')]) one.removeChild(x);
      d.setChild(one, 'cols', { space: 708 }, SECT_ORDER);
      for (const x of kids(pPr, 'sectPr')) pPr.removeChild(x);
      const after = kids(pPr).find(c => PPR_ORDER.indexOf(c.localName) > PPR_ORDER.indexOf('sectPr'));
      pPr.insertBefore(one, after || null);
      d.setChild(s, 'type', { val: 'continuous' }, SECT_ORDER);
      changes.push('Title, authors and abstract kept in a single column above the two-column body.');
    }
  }
}

/** Sections present / missing for the article type, abstract length */
function structureCheck(d, type, t) {
  const texts = d.paragraphs().map(p => d.text(p).trim());
  const def = ARTICLE_TYPES[type] || ARTICLE_TYPES.research;
  const has = alt => texts.some(x => x.length < 80 && new RegExp(`^\\s*(?:\\d+(?:\\.\\d+)*\\.?\\s+|[IVX]+\\.\\s+)?(?:${alt.replace(/ and /g, ' (?:and|&) ')})\\b`, 'i').test(x));
  const sections = def.sections.map(s => ({ section: s.split('|')[0], present: has(s.split('|').map(x => x.replace(/s$/, 's?')).join('|')) }));
  let abstractWords = null;
  const ai = texts.findIndex(x => /^(abstract|summary)\b/i.test(x));
  if (ai >= 0) {
    const inline = texts[ai].replace(/^(abstract|summary)\s*[:.\-–]?\s*/i, '');
    const parts = inline ? [inline] : [];
    for (let k = ai + 1; k < texts.length && !(texts[k].length < 60 && SECTION_WORDS.test(texts[k])) && !/^key\s*words?/i.test(texts[k]); k++) parts.push(texts[k]);
    abstractWords = parts.join(' ').split(/\s+/).filter(Boolean).length;
  }
  return { articleType: def.label, sections, abstractWords, abstractLimit: t.abstractWords, abstractTooLong: abstractWords !== null && abstractWords > t.abstractWords };
}

/**
 * opts: { template, articleType, restyle (true), style (overrides the template's citation style), lookup }
 */
async function formatManuscript(buffer, opts = {}) {
  const t = TEMPLATES[opts.template] || TEMPLATES.springer;
  const changes = [];
  let restyle = null;
  let buf = buffer;
  if (opts.restyle !== false) {
    try {
      const r = await restyleDocx(buffer, opts.style || t.style, { lookup: opts.lookup !== false, onProgress: opts.onProgress });
      buf = r.buffer;
      restyle = r.result;
      changes.push(`Citations and references converted to ${restyle.styleLabel} (${restyle.citationsConverted} in-text citations, ${restyle.counts.total} references).`);
    } catch (e) {
      changes.push(`References were not restyled: ${e.message}`);
    }
  }
  const d = await Docx.load(buf);
  applyStyles(d, t, changes);
  normaliseBody(d, t, changes);
  applyPage(d, t, changes);
  const structure = structureCheck(d, opts.articleType, t);
  const out = await d.save();
  return {
    buffer: out,
    result: {
      template: opts.template, templateLabel: t.label, settings: { font: t.font, size: t.size, line: t.line, cols: t.cols, lineNumbers: t.lineNumbers, page: t.page === A4 ? 'A4' : 'Letter', style: opts.style || t.style },
      changes, structure, restyle,
      note: 'General submission template. Always check the target journal’s current author guidelines before submitting.'
    }
  };
}

const TEMPLATE_LIST = Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, style: t.style }));
const ARTICLE_TYPE_LIST = Object.entries(ARTICLE_TYPES).map(([key, a]) => ({ key, label: a.label }));

module.exports = { formatManuscript, TEMPLATES, TEMPLATE_LIST, ARTICLE_TYPE_LIST };
