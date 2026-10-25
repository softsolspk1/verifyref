// images/worker.js - runs the Module 5 analysis off the main thread
import * as E from './engine.js';
import * as F from './forensics.js';
import { readPanelLetter } from './letters.js';
import { laneFindings } from './lanes.js';

// "Figure 2, part 1" / "Fig. 2" -> "Fig. 2"; anything else is kept as written
const figName = label => { const m = String(label).match(/^\s*fig(?:ure)?\.?\s*(\d+|[IVX]+)/i); return m ? `Fig. ${m[1]}` : null; };

self.onmessage = e => {
  const { images } = e.data;
  try {
    const panels = [];
    images.forEach((im, n) => {
      const img = { width: im.width, height: im.height, data: new Uint8ClampedArray(im.data) };
      const gray = E.toGray(img);
      const boxes = E.splitPanels(img);
      boxes.forEach((b, i) => {
        if (b.w < 48 || b.h < 48) return;
        // panel letter read from the corner (A, B, C ...) so a finding can say "Fig. 2C vs Fig. 4A"
        let letter = null;
        if (boxes.length > 1) { try { letter = readPanelLetter(gray, b); } catch (e) { letter = null; } }
        const fig = figName(im.label);
        const label = boxes.length > 1 ? (letter ? (fig ? `${fig}${letter}` : `${im.label}, panel ${letter}`) : `${im.label}, panel ${i + 1}`) : im.label;
        const p = E.preparePanel(img, b, { id: `${im.id}-p${i + 1}`, label, letter, imageId: im.id, index: i + 1 }, gray);
        p.forensic = F.analysePanel(img, gray, b, p.type, p.blank);
        panels.push(p);
      });
      self.postMessage({ type: 'progress', step: `Splitting and describing figures (${n + 1}/${images.length})`, progress: 10 + (n + 1) / images.length * 40 });
    });
    self.postMessage({ type: 'progress', step: `Comparing ${panels.length} panels`, progress: 52 });
    const core = E.findIssues(panels, p => self.postMessage({ type: 'progress', step: `Comparing ${panels.length} panels`, progress: 52 + p * 40 }));
    self.postMessage({ type: 'progress', step: 'Checking alterations, AI-image indicators and chart data', progress: 94 });
    const prov = {};
    images.forEach(im => { if (im.provenance?.length) prov[im.id] = im.provenance; });
    const lanes = laneFindings(panels).filter(l => !core.some(c => c.a.panel === l.a.panel && c.b.panel === l.b.panel && c.kind === l.kind));
    const findings = [...core, ...lanes, ...F.forensicFindings(panels, prov, [...core, ...lanes])].sort((a, b) => (a.level === b.level ? b.score - a.score : a.level === 'high' ? -1 : 1));
    self.postMessage({
      type: 'done',
      panels: panels.map(p => ({ id: p.id, label: p.label, letter: p.letter || null, imageId: p.imageId, index: p.index, box: p.box, type: p.type, blank: p.blank, hashes: p.hashes.map(E.hashHex) })),
      findings: findings.map((f, i) => ({ ...f, id: `f${i + 1}`, category: F.categoryOf(f.kind) })),
      charts: F.seriesFingerprints(panels),
      provenance: Object.keys(prov).length
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
