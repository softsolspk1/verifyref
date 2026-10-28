// ooxml.js - edit existing Word (.docx) files in place: paragraph text with character offsets, replacing text ranges
// while keeping the surrounding run formatting, rewriting whole paragraphs, footnotes, styles and page settings.
const JSZip = require('jszip');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const FOOTNOTES_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes';
const FOOTNOTES_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml';

const parseXml = s => new DOMParser().parseFromString(s, 'text/xml');
const serialize = d => new XMLSerializer().serializeToString(d);

const kids = (el, local) => {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (!local || n.localName === local)) out.push(n);
  return out;
};
const kid = (el, local) => kids(el, local)[0] || null;
const desc = (el, local) => Array.from(el.getElementsByTagNameNS(W, local));

class Docx {
  static async load(buffer) {
    const d = new Docx();
    d.zip = await JSZip.loadAsync(buffer);
    const main = d.zip.file('word/document.xml');
    if (!main) throw new Error('This file is not a Word document (word/document.xml missing).');
    d.doc = parseXml(await main.async('string'));
    d.body = d.doc.getElementsByTagNameNS(W, 'body')[0];
    const st = d.zip.file('word/styles.xml');
    d.styles = st ? parseXml(await st.async('string')) : null;
    const fn = d.zip.file('word/footnotes.xml');
    d.footnotes = fn ? parseXml(await fn.async('string')) : null;
    return d;
  }

  el(name, attrs = {}, children = []) {
    const e = this.doc.createElementNS(W, `w:${name}`);
    for (const [k, v] of Object.entries(attrs)) e.setAttributeNS(W, `w:${k}`, String(v));
    for (const c of children) e.appendChild(c);
    return e;
  }

  /** Record later edits as Word tracked changes (insertions / deletions the editor can accept or reject) */
  trackChanges(author = 'PJPS Data Integration System') {
    this.track = { author, date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), id: 7000 };
    return this;
  }

  revAttrs() { return { id: this.track.id++, author: this.track.author, date: this.track.date }; }

  /** A deleted-text run (w:del > w:r > w:delText) carrying the formatting of baseRun */
  deletedRun(baseRun, text) {
    const del = this.el('del', this.revAttrs());
    const r = this.el('r');
    const rPr = baseRun && kid(baseRun, 'rPr');
    if (rPr) r.appendChild(rPr.cloneNode(true));
    const dt = this.el('delText');
    dt.setAttribute('xml:space', 'preserve');
    dt.appendChild(this.doc.createTextNode(text));
    r.appendChild(dt);
    del.appendChild(r);
    return del;
  }

  /** Mark an existing run as deleted in place */
  markRunDeleted(run) {
    for (const t of kids(run, 't')) {
      const dt = this.el('delText');
      dt.setAttribute('xml:space', 'preserve');
      dt.appendChild(this.doc.createTextNode(t.textContent || ''));
      run.replaceChild(dt, t);
    }
    const del = this.el('del', this.revAttrs());
    run.parentNode.insertBefore(del, run);
    del.appendChild(run);
  }

  /** Wrap a new run in w:ins when tracking */
  wrapIns(run) {
    if (!this.track) return run;
    const ins = this.el('ins', this.revAttrs());
    ins.appendChild(run);
    return ins;
  }

  /** Top-level body paragraphs plus paragraphs inside tables, in document order */
  paragraphs() { return desc(this.body, 'p').filter(p => !this.inFootnote(p)); }
  inFootnote() { return false; }

  /** Text units of a paragraph: [{ node (w:t or null), text, run, editable }] in order */
  units(p) {
    const out = [];
    for (const r of desc(p, 'r')) {
      for (let n = r.firstChild; n; n = n.nextSibling) {
        if (n.nodeType !== 1) continue;
        if (n.localName === 't') out.push({ node: n, text: n.textContent || '', run: r, editable: true });
        else if (n.localName === 'tab') out.push({ node: null, text: '\t', run: r, editable: false });
        else if (n.localName === 'br' || n.localName === 'cr') out.push({ node: null, text: '\n', run: r, editable: false });
        else if (n.localName === 'noBreakHyphen') out.push({ node: null, text: '-', run: r, editable: false });
      }
    }
    return out;
  }

  text(p) { return this.units(p).map(u => u.text).join(''); }

  isSuperscript(run) {
    const rPr = kid(run, 'rPr');
    const va = rPr && kid(rPr, 'vertAlign');
    return !!va && va.getAttributeNS(W, 'val') === 'superscript';
  }

  /** Character ranges of superscript text in a paragraph: [{ start, end, text }] */
  superscriptRanges(p) {
    const out = [];
    let pos = 0;
    for (const u of this.units(p)) {
      if (u.editable && this.isSuperscript(u.run) && u.text.trim()) {
        const last = out[out.length - 1];
        if (last && last.end === pos) { last.end += u.text.length; last.text += u.text; }
        else out.push({ start: pos, end: pos + u.text.length, text: u.text });
      }
      pos += u.text.length;
    }
    return out;
  }

  /** New run copying the base run's formatting, with segment flags { t, i, b, sup } applied */
  makeRun(baseRun, seg) {
    const r = this.el('r');
    const baseRPr = baseRun && kid(baseRun, 'rPr');
    const rPr = baseRPr ? baseRPr.cloneNode(true) : this.el('rPr');
    for (const name of ['vertAlign', 'i', 'iCs', 'b', 'bCs']) for (const x of kids(rPr, name)) rPr.removeChild(x);
    // Child order inside rPr is schema-enforced: b, i come early; vertAlign comes late
    const first = rPr.firstChild;
    const insertEarly = node => {
      const anchor = kids(rPr).find(c => !['rStyle', 'rFonts'].includes(c.localName));
      rPr.insertBefore(node, anchor || null);
    };
    if (seg.b) insertEarly(this.el('b'));
    if (seg.i) { const iEl = this.el('i'); const bEl = kid(rPr, 'b'); if (bEl) rPr.insertBefore(iEl, bEl.nextSibling); else insertEarly(iEl); }
    if (seg.sup) {
      const after = kids(rPr).filter(c => ['rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'].includes(c.localName))[0];
      rPr.insertBefore(this.el('vertAlign', { val: 'superscript' }), after || null);
    }
    void first;
    if (rPr.firstChild) r.appendChild(rPr);
    if (seg.node) { r.appendChild(seg.node); return r; }
    const t = this.el('t');
    t.setAttribute('xml:space', 'preserve');
    t.appendChild(this.doc.createTextNode(seg.t));
    r.appendChild(t);
    return r;
  }

  /**
   * Replace character ranges of a paragraph with segment arrays. edits: [{ start, end, segs: [{t,i,b,sup}|{node}] }]
   * Non-overlapping; processed from the end so earlier offsets stay valid. Formatting of the run at `start` is kept.
   */
  replaceRanges(p, edits) {
    const sorted = [...edits].sort((a, b) => b.start - a.start);
    for (const e of sorted) {
      const units = this.units(p);
      let pos = 0;
      const spans = units.map(u => { const s = { u, start: pos, end: pos + u.text.length }; pos += u.text.length; return s; });
      const hit = spans.filter(s => s.end > e.start && s.start < e.end && s.u.editable);
      const insertAt = hit[0] || spans.filter(s => s.u.editable && s.end <= e.start).pop();
      if (!insertAt) continue;
      const first = insertAt;
      const last = hit[hit.length - 1] || first;
      const prefix = first.u.text.slice(0, Math.max(0, e.start - first.start));
      const suffix = last.u.text.slice(Math.max(0, e.end - last.start));
      const baseRun = first.u.run;
      const removed = hit.map(s => s.u.text.slice(Math.max(0, e.start - s.start), Math.max(0, e.end - s.start))).join('');
      // Clear the covered text
      for (const s of hit) s.u.node.textContent = '';
      first.u.node.textContent = prefix;
      if (prefix !== prefix.trim()) first.u.node.setAttribute('xml:space', 'preserve');
      let anchor = baseRun;
      // Text after the range in the same run moves into its own run after the new segments
      let suffixRun = null;
      if (last === first && suffix) {
        suffixRun = baseRun.cloneNode(false);
        const rPr = kid(baseRun, 'rPr');
        if (rPr) suffixRun.appendChild(rPr.cloneNode(true));
        const t = this.el('t');
        t.setAttribute('xml:space', 'preserve');
        t.appendChild(this.doc.createTextNode(suffix));
        suffixRun.appendChild(t);
        // Move any non-text children that followed the w:t (rare) along with the suffix
        let n = first.u.node.nextSibling;
        while (n) { const next = n.nextSibling; if (n.nodeType === 1) suffixRun.appendChild(n); n = next; }
      } else if (last !== first) {
        last.u.node.textContent = suffix;
        last.u.node.setAttribute('xml:space', 'preserve');
      }
      if (this.track && removed) {
        const d = this.deletedRun(baseRun, removed);
        anchor.parentNode.insertBefore(d, anchor.nextSibling);
        anchor = d;
      }
      for (const seg of e.segs) {
        const r = this.wrapIns(this.makeRun(baseRun, seg));
        anchor.parentNode.insertBefore(r, anchor.nextSibling);
        anchor = r;
      }
      if (suffixRun) anchor.parentNode.insertBefore(suffixRun, anchor.nextSibling);
      // Drop runs left empty
      for (const s of hit) {
        const r = s.u.run;
        if (r !== baseRun && r !== last.u.run) this.dropIfEmpty(r);
      }
      if (!prefix) this.dropIfEmpty(baseRun);
    }
  }

  dropIfEmpty(run) {
    if (!run.parentNode) return;
    const content = kids(run).filter(c => c.localName !== 'rPr');
    if (content.every(c => c.localName === 't' && !c.textContent)) run.parentNode.removeChild(run);
  }

  /** Replace all text of a paragraph with segments (keeps paragraph properties and the first run's formatting) */
  setParagraph(p, segs) {
    const runs = desc(p, 'r');
    const base = runs.find(r => kid(r, 't')) || runs[0] || null;
    const baseClone = base ? base.cloneNode(true) : null;
    if (this.track) {
      // Unchanged paragraphs stay untouched; otherwise the old text is shown deleted and the new text inserted
      const newText = segs.map(x => x.t || '').join('');
      if (newText === this.text(p) && segs.every(x => !x.i && !x.b && !x.sup)) return;
      for (const r of runs) if (r.parentNode && r.parentNode.localName !== 'del' && kid(r, 't')) this.markRunDeleted(r);
      for (const seg of segs) p.appendChild(this.wrapIns(this.makeRun(baseClone, seg)));
      return;
    }
    for (const c of kids(p)) if (c.localName !== 'pPr') p.removeChild(c);
    for (const seg of segs) p.appendChild(this.makeRun(baseClone, seg));
  }

  /** Clone a paragraph (structure and properties only) and insert it after `after` */
  cloneParagraphAfter(src, after) {
    const p = src.cloneNode(true);
    after.parentNode.insertBefore(p, after.nextSibling);
    if (this.track) {
      // A new paragraph: keep its properties and one formatting run, mark the paragraph itself as inserted
      const run = desc(p, 'r').find(r => kid(r, 't'));
      const keep = run ? run.cloneNode(true) : null;
      for (const c of kids(p)) if (c.localName !== 'pPr') p.removeChild(c);
      if (keep) { for (const t of kids(keep, 't')) t.textContent = ''; p.appendChild(keep); }
      let pPr = kid(p, 'pPr');
      if (!pPr) { pPr = this.el('pPr'); p.insertBefore(pPr, p.firstChild); }
      let rPr = kid(pPr, 'rPr');
      if (!rPr) { rPr = this.el('rPr'); pPr.appendChild(rPr); }
      rPr.appendChild(this.el('ins', this.revAttrs()));
    }
    return p;
  }

  removeParagraph(p) {
    if (!p.parentNode) return;
    if (!this.track) { p.parentNode.removeChild(p); return; }
    for (const r of desc(p, 'r')) if (r.parentNode && r.parentNode.localName !== 'del' && kid(r, 't')) this.markRunDeleted(r);
    let pPr = kid(p, 'pPr');
    if (!pPr) { pPr = this.el('pPr'); p.insertBefore(pPr, p.firstChild); }
    let rPr = kid(pPr, 'rPr');
    if (!rPr) { rPr = this.el('rPr'); pPr.appendChild(rPr); }
    rPr.appendChild(this.el('del', this.revAttrs()));
  }

  /** Remove automatic list numbering from a paragraph */
  removeNumbering(p) {
    const pPr = kid(p, 'pPr');
    const n = pPr && kid(pPr, 'numPr');
    if (n) pPr.removeChild(n);
  }
  hasNumbering(p) {
    const pPr = kid(p, 'pPr');
    return !!(pPr && kid(pPr, 'numPr'));
  }

  // ---------------------------------------------------------------- footnotes

  async ensureFootnotes() {
    if (this.footnotes) return;
    this.footnotes = parseXml(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote></w:footnotes>`);
    const relsPath = 'word/_rels/document.xml.rels';
    const rels = parseXml(await this.zip.file(relsPath).async('string'));
    const root = rels.documentElement;
    const ids = Array.from(root.getElementsByTagNameNS(REL, 'Relationship')).map(r => r.getAttribute('Id'));
    let n = ids.length + 1;
    while (ids.includes(`rId${n}`)) n++;
    const rel = rels.createElementNS(REL, 'Relationship');
    rel.setAttribute('Id', `rId${n}`);
    rel.setAttribute('Type', FOOTNOTES_TYPE);
    rel.setAttribute('Target', 'footnotes.xml');
    root.appendChild(rel);
    this.zip.file(relsPath, serialize(rels));
    const ctPath = '[Content_Types].xml';
    const ct = parseXml(await this.zip.file(ctPath).async('string'));
    const o = ct.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override');
    o.setAttribute('PartName', '/word/footnotes.xml');
    o.setAttribute('ContentType', FOOTNOTES_CT);
    ct.documentElement.appendChild(o);
    this.zip.file(ctPath, serialize(ct));
  }

  /** Add a footnote with the given segments; returns the footnote reference run segment for replaceRanges */
  addFootnote(segs) {
    const root = this.footnotes.documentElement;
    const ids = Array.from(root.getElementsByTagNameNS(W, 'footnote')).map(f => parseInt(f.getAttributeNS(W, 'id') || f.getAttribute('w:id'), 10)).filter(n => !isNaN(n));
    const id = Math.max(0, ...ids) + 1;
    const mk = (name, attrs = {}) => {
      const e = this.footnotes.createElementNS(W, `w:${name}`);
      for (const [k, v] of Object.entries(attrs)) e.setAttributeNS(W, `w:${k}`, String(v));
      return e;
    };
    const fn = mk('footnote', { id });
    const p = mk('p');
    const refRun = mk('r');
    const rp = mk('rPr');
    rp.appendChild(mk('vertAlign', { val: 'superscript' }));
    refRun.appendChild(rp);
    refRun.appendChild(mk('footnoteRef'));
    p.appendChild(refRun);
    const space = mk('r');
    const st = mk('t');
    st.setAttribute('xml:space', 'preserve');
    st.appendChild(this.footnotes.createTextNode(' '));
    space.appendChild(st);
    p.appendChild(space);
    for (const s of segs) {
      const r = mk('r');
      if (s.i || s.b) {
        const rPr = mk('rPr');
        if (s.b) rPr.appendChild(mk('b'));
        if (s.i) rPr.appendChild(mk('i'));
        r.appendChild(rPr);
      }
      const t = mk('t');
      t.setAttribute('xml:space', 'preserve');
      t.appendChild(this.footnotes.createTextNode(s.t));
      r.appendChild(t);
      p.appendChild(r);
    }
    fn.appendChild(p);
    root.appendChild(fn);
    return { node: this.el('footnoteReference', { id }), sup: true };
  }

  // ---------------------------------------------------------------- page, styles

  sectPr() {
    let s = kids(this.body, 'sectPr')[0];
    if (!s) { s = this.el('sectPr'); this.body.appendChild(s); }
    return s;
  }

  /** Replace or add a child element of `parent`, keeping a schema-friendly position when `order` is given */
  setChild(parent, name, attrs, order = []) {
    for (const x of kids(parent, name)) parent.removeChild(x);
    const e = this.el(name, attrs);
    const idx = order.indexOf(name);
    const before = idx >= 0 ? kids(parent).find(c => order.indexOf(c.localName) > idx) : null;
    parent.insertBefore(e, before || null);
    return e;
  }

  async save() {
    this.zip.file('word/document.xml', serialize(this.doc));
    if (this.styles) this.zip.file('word/styles.xml', serialize(this.styles));
    if (this.footnotes) this.zip.file('word/footnotes.xml', serialize(this.footnotes));
    return this.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }
}

module.exports = { Docx, W, kids, kid, desc, parseXml, serialize };
