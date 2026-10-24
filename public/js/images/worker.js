// images/worker.js - runs the Module 5 analysis off the main thread
import * as E from './engine.js';

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
        const p = E.preparePanel(img, b, { id: `${im.id}-p${i + 1}`, label: boxes.length > 1 ? `${im.label}, panel ${i + 1}` : im.label, imageId: im.id, index: i + 1 }, gray);
        panels.push(p);
      });
      self.postMessage({ type: 'progress', step: `Splitting and describing figures (${n + 1}/${images.length})`, progress: 10 + (n + 1) / images.length * 40 });
    });
    self.postMessage({ type: 'progress', step: `Comparing ${panels.length} panels`, progress: 52 });
    const findings = E.findIssues(panels, p => self.postMessage({ type: 'progress', step: `Comparing ${panels.length} panels`, progress: 52 + p * 45 }));
    self.postMessage({
      type: 'done',
      panels: panels.map(p => ({ id: p.id, label: p.label, imageId: p.imageId, index: p.index, box: p.box, type: p.type, blank: p.blank, hashes: p.hashes.map(E.hashHex) })),
      findings: findings.map((f, i) => ({ ...f, id: `f${i + 1}` }))
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};
