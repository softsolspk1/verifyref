// images/panelEditor.js - manual panel adjustment before a Module 5 scan (as ImageTwin's "Adjust panels"): every
// figure is shown with the sub-image boxes the automatic split found; the editor can select and delete a box, draw a
// missing one (drag on the figure), move or resize the selected box (drag inside it / on its lower-right corner), or
// go back to the automatic boxes. The result is a { imageId: [box] } map the analysis uses instead of the automatic split.
import { modal, esc, $, $$ } from '../core.js';
import { splitPanels } from './engine.js';
import { imageDataOf } from './extract.js';

const MIN = 48; // the analysis skips panels smaller than this (px, both sides)

/** Automatic boxes of every figure: { imageId: [box] } */
export function autoPanels(images) {
  const out = {};
  for (const im of images) { try { out[im.id] = splitPanels(imageDataOf(im)).filter(b => b.w >= MIN && b.h >= MIN); } catch (e) { out[im.id] = []; } }
  return out;
}

/** Opens the editor; resolves with the edited map, or null when cancelled */
export function editPanels(images, current) {
  const auto = autoPanels(images);
  const boxes = Object.fromEntries(images.map(im => [im.id, (current?.[im.id] || auto[im.id]).map(b => ({ ...b }))]));
  return new Promise(resolve => {
    let done = false;
    const closeModal = modal(`
      <div class="card-head"><h2>Adjust panels</h2><button class="btn btn-sm btn-ghost" data-close>✕</button></div>
      <p class="muted" style="margin-top:0">Red: the figure. Blue: the sub-images (panels) that will be compared. Click a panel to select it; drag on an empty part of the figure to add a missing panel; drag a selected panel to move it, or its lower-right corner to resize it.</p>
      <div class="pe-wrap"><div class="pe-list" id="pe-list"></div>
        <div><div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">
          <button class="btn btn-sm" id="pe-del" disabled>Delete selected panel</button>
          <button class="btn btn-sm" id="pe-whole">Use the whole figure as one panel</button>
          <button class="btn btn-sm btn-ghost" id="pe-reset">Automatic panels</button>
          <span class="muted" id="pe-count"></span></div>
          <div class="pe-stage"><canvas id="pe-c"></canvas></div></div></div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-sm btn-ghost" data-close>Cancel</button><button class="btn btn-sm btn-primary" id="pe-ok">Use these panels</button></div>`, {
      onMount(m, close) {
        let cur = images[0]?.id, sel = -1, drag = null;
        const c = $('#pe-c', m), ctx = c.getContext('2d');
        const im = () => images.find(x => x.id === cur);
        const list = () => {
          $('#pe-list', m).innerHTML = images.map(x => `<button data-im="${esc(x.id)}" class="${x.id === cur ? 'active' : ''}">${esc(x.label)}<br><span class="muted">${boxes[x.id].length} panel(s)</span></button>`).join('');
          $$('[data-im]', m).forEach(b => (b.onclick = () => { cur = b.dataset.im; sel = -1; list(); draw(); }));
        };
        const draw = () => {
          const I = im();
          if (!I) return;
          c.width = I.canvas.width; c.height = I.canvas.height;
          ctx.drawImage(I.canvas, 0, 0);
          const lw = Math.max(2, c.width / 300);
          ctx.lineWidth = lw * 1.5; ctx.strokeStyle = '#e0143c'; ctx.setLineDash([]);
          ctx.strokeRect(lw, lw, c.width - 2 * lw, c.height - 2 * lw);
          boxes[cur].forEach((b, i) => {
            ctx.lineWidth = i === sel ? lw * 2 : lw; ctx.strokeStyle = i === sel ? '#ffb000' : '#0a84ff'; ctx.setLineDash(i === sel ? [] : [8, 4]);
            ctx.strokeRect(b.x, b.y, b.w, b.h);
            ctx.fillStyle = i === sel ? '#ffb000' : '#0a84ff';
            ctx.font = `bold ${Math.max(12, c.width / 45)}px sans-serif`;
            ctx.fillText(String(i + 1), b.x + 4, b.y + Math.max(14, c.width / 40));
            if (i === sel) ctx.fillRect(b.x + b.w - 8, b.y + b.h - 8, 10, 10);
          });
          if (drag?.mode === 'new') { ctx.setLineDash([4, 3]); ctx.strokeStyle = '#ffb000'; ctx.lineWidth = lw; ctx.strokeRect(drag.box.x, drag.box.y, drag.box.w, drag.box.h); }
          $('#pe-del', m).disabled = sel < 0;
          $('#pe-count', m).textContent = `${boxes[cur].length} panel(s) in this figure`;
        };
        const at = e => { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * c.width, y: (e.clientY - r.top) / r.height * c.height }; };
        const norm = b => { const x = Math.max(0, Math.min(b.x, b.x + b.w)), y = Math.max(0, Math.min(b.y, b.y + b.h)); return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.min(Math.abs(b.w), c.width - x)), h: Math.round(Math.min(Math.abs(b.h), c.height - y)) }; };
        c.onpointerdown = e => {
          const p = at(e), list0 = boxes[cur], hit = list0.findIndex(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
          c.setPointerCapture(e.pointerId);
          const grip = Math.max(12, c.width / 60);
          if (sel >= 0 && Math.abs(p.x - (list0[sel].x + list0[sel].w)) < grip && Math.abs(p.y - (list0[sel].y + list0[sel].h)) < grip) drag = { mode: 'resize', p, orig: { ...list0[sel] } };
          else if (hit >= 0) { sel = hit; drag = { mode: 'move', p, orig: { ...list0[hit] } }; }
          else { sel = -1; drag = { mode: 'new', p, box: { x: p.x, y: p.y, w: 0, h: 0 } }; }
          draw();
        };
        c.onpointermove = e => {
          if (!drag) return;
          const p = at(e), dx = p.x - drag.p.x, dy = p.y - drag.p.y;
          if (drag.mode === 'new') drag.box = { x: drag.p.x, y: drag.p.y, w: dx, h: dy };
          else if (drag.mode === 'move') boxes[cur][sel] = norm({ ...drag.orig, x: Math.max(0, Math.min(c.width - drag.orig.w, drag.orig.x + dx)), y: Math.max(0, Math.min(c.height - drag.orig.h, drag.orig.y + dy)) });
          else boxes[cur][sel] = norm({ ...drag.orig, w: Math.max(MIN, drag.orig.w + dx), h: Math.max(MIN, drag.orig.h + dy) });
          draw();
        };
        c.onpointerup = () => {
          if (drag?.mode === 'new') { const b = norm(drag.box); if (b.w >= MIN && b.h >= MIN) { boxes[cur].push(b); sel = boxes[cur].length - 1; } }
          drag = null; list(); draw();
        };
        $('#pe-del', m).onclick = () => { if (sel >= 0) { boxes[cur].splice(sel, 1); sel = -1; list(); draw(); } };
        $('#pe-whole', m).onclick = () => { const I = im(); boxes[cur] = [{ x: 0, y: 0, w: I.canvas.width, h: I.canvas.height }]; sel = -1; list(); draw(); };
        $('#pe-reset', m).onclick = () => { boxes[cur] = auto[cur].map(b => ({ ...b })); sel = -1; list(); draw(); };
        $('#pe-ok', m).onclick = () => { done = true; resolve(boxes); close(); };
        const obs = new MutationObserver(() => { if (!document.body.contains(m)) { obs.disconnect(); if (!done) resolve(null); } });
        obs.observe(document.body, { childList: true });
        list(); draw();
      }
    });
    void closeModal;
  });
}
