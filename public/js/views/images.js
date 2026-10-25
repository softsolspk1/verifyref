// views/images.js - Module 5 Image Integrity Detection. Figures are extracted and analysed in the browser (nothing large
// is uploaded); the result, small thumbnails and figure fingerprints are saved to the PJPS server.
import { api, esc, $, $$, toast, badge, download, fmtDate, ICONS, state } from '../core.js';
import { extractFigures, imageDataOf } from '../images/extract.js';
import { openViewer } from '../images/viewer.js';
import { decisionCard } from './decision.js';

const KIND = { duplicate: 'Duplicated image', partial: 'Overlapping / re-used part', clone: 'Cloned area inside one panel', alteration: 'Possible alteration / manipulation', ai: 'Possible AI-generated image', chart: 'Graph / chart data duplicated' };
const CATS = [['duplication', 'a', 'Duplication & reuse'], ['manipulation', 'b', 'Alteration & manipulation'], ['ai', 'c', 'AI-generated images'], ['chart', 'd', 'Graph & chart duplication']];
const single = f => f.a.panel === f.b.panel;
const TYPE = { blot: 'Blot / gel', fluorescence: 'Fluorescence', histology: 'Histology', chart: 'Chart / graph', grayscale: 'Grayscale', photo: 'Photo / microscopy' };
const levelTone = l => ({ HIGH: 'bad', MEDIUM: 'warn', LOW: 'good', high: 'bad', medium: 'warn' }[l] || 'neutral');

export function renderImages(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Module 5 — Image Integrity Detection</h1>
      <p>Finds duplicated, re-used and edited figures (Western blots, gels, microscopy, histology, photos): the same image used twice — also rotated, mirrored, resized or cropped — overlapping panels, and cloned areas inside one image. Figures are compared with all earlier PJPS manuscripts. The analysis runs in your browser; the manuscript itself is not uploaded.</p></div></div>
    <div id="form-area">
      <div class="card">
        <div class="dropzone" id="dz">
          <input type="file" id="file" accept=".docx,.pdf,.png,.jpg,.jpeg,.gif,.bmp,.webp" multiple hidden>
          <div><strong>Upload the manuscript (Word or PDF) or the figure files</strong> — drag &amp; drop or click</div>
          <div class="muted" style="margin-top:4px">.docx gives the best result (original figure files and “Figure n” captions) · several PNG/JPEG figure files can be selected together</div>
        </div>
        <div id="file-info" class="alert alert-info" hidden style="margin-top:12px"></div>
        <div class="grid grid-2" style="margin-top:12px">
          <div class="field"><label for="m-code">Manuscript ID</label><input id="m-code" type="text" placeholder="e.g. PJPS-2026-0412"></div>
          <div class="field"><label for="m-title">Title <span class="muted">(optional)</span></label><input id="m-title" type="text"></div>
        </div>
        <div class="row"><button class="btn btn-primary" id="run" disabled>Analyse figures</button><span class="muted">Editor only · results are confidential</span></div>
      </div>
      <div id="vendor"></div>
    </div>
    <div id="progress"></div>
    <div id="result"></div>`;

  let files = [];
  const info = $('#file-info', view);
  const input = $('#file', view);
  const zone = $('#dz', view);
  const take = list => {
    files = [...list];
    if (!files.length) return;
    info.hidden = false;
    info.textContent = files.length === 1 ? files[0].name : `${files.length} files: ${files.map(f => f.name).join(', ')}`;
    $('#run', view).disabled = false;
    const code = (files[0].name.match(/PJPS[-_\s]?\d{4}[-_\s]?\d{2,5}/i) || [])[0];
    if (code && !$('#m-code', view).value) $('#m-code', view).value = code.toUpperCase().replace(/[_\s]/g, '-');
  };
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); take(e.dataTransfer.files); });
  input.addEventListener('change', () => { take(input.files); input.value = ''; });

  api('/api/images/vendor').then(v => { $('#vendor', view).innerHTML = vendorCard(v); }).catch(() => {});

  $('#run', view).onclick = async () => {
    const prog = $('#progress', view);
    $('#form-area', view).hidden = true;
    prog.innerHTML = `<div class="progress"><h3>Analysing figures</h3><div class="progress-bar"><span style="width:2%"></span></div><div class="muted step">Reading the manuscript…</div></div>`;
    const bar = $('.progress-bar span', prog), step = $('.step', prog);
    const set = (s, p) => { if (s) step.textContent = s; if (p !== undefined) bar.style.width = `${Math.max(2, Math.min(99, p))}%`; };
    try {
      const { images, skipped } = await extractFigures(files, s => set(s, 5));
      if (!images.length) throw new Error(`No figures could be read. ${skipped.map(s => `${s.name}: ${s.reason}`).join(' · ')}`);
      set(`${images.length} figure(s) found — starting the analysis`, 10);
      const analysis = await analyse(images, set);
      set('Preparing thumbnails and saving', 97);
      const meta = { title: $('#m-title', view).value.trim(), manuscriptCode: $('#m-code', view).value.trim(), filename: files.map(f => f.name).join(', ') };
      const payload = buildPayload(images, analysis, skipped, meta);
      const saved = await api('/api/images', { body: { result: payload } });
      prog.innerHTML = '';
      const result = saved.result;
      result.id = saved.id;
      renderImagesResult($('#result', view), result, { live: new Map(images.map(im => [im.id, im])) });
      toast(result.summary.findings ? `${result.summary.findings} finding(s) to check` : 'No image problems found');
    } catch (e) {
      prog.innerHTML = '';
      $('#form-area', view).hidden = false;
      toast(e.message, 'error');
    }
  };
}

function analyse(images, set) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../images/worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'progress') set(m.step, m.progress);
      else if (m.type === 'done') { worker.terminate(); resolve(m); }
      else if (m.type === 'error') { worker.terminate(); reject(new Error(m.message)); }
    };
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message || 'The analysis failed in the browser.')); };
    const payload = images.map(im => { const d = imageDataOf(im); return { id: im.id, label: im.label, width: d.width, height: d.height, data: d.data.buffer, provenance: im.provenance || [] }; });
    worker.postMessage({ images: payload }, payload.map(p => p.data));
  });
}

// ------------------------------------------------------------------ thumbnails

function thumb(im, box, marks = [], max = 360, quality = 0.78) {
  const b = box || { x: 0, y: 0, w: im.canvas.width, h: im.canvas.height };
  const k = Math.min(1, max / Math.max(b.w, b.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(b.w * k)); c.height = Math.max(1, Math.round(b.h * k));
  const ctx = c.getContext('2d');
  ctx.drawImage(im.canvas, b.x, b.y, b.w, b.h, 0, 0, c.width, c.height);
  const colors = ['#ff1f5a', '#00b3ff'];
  marks.forEach((m, i) => {
    ctx.strokeStyle = colors[i % 2];
    ctx.lineWidth = Math.max(2, c.width / 120);
    ctx.setLineDash([6, 3]);
    ctx.strokeRect((m.x - b.x) * k, (m.y - b.y) * k, m.w * k, m.h * k);
  });
  return { src: c.toDataURL('image/jpeg', quality), w: c.width, h: c.height };
}

function buildPayload(images, analysis, skipped, meta) {
  const byId = new Map(images.map(im => [im.id, im]));
  const panelById = new Map(analysis.panels.map(p => [p.id, p]));
  const imgOfPanel = id => byId.get(panelById.get(id)?.imageId);
  const panels = analysis.panels.map(p => {
    const t = thumb(byId.get(p.imageId), p.box, [], 150, 0.7);
    return { ...p, thumb: t.src, w: p.box.w, h: p.box.h };
  });
  let budget = 3_400_000 - panels.reduce((a, p) => a + p.thumb.length, 0);
  const findings = analysis.findings.slice(0, 60).map((f, i) => {
    const A = panelById.get(f.a.panel), B = panelById.get(f.b.panel);
    const out = { ...f, a: { ...f.a, label: A?.label || f.a.panel }, b: { ...f.b, label: B?.label || f.b.panel } };
    const size = budget > 1_000_000 ? 360 : budget > 300_000 ? 240 : 0;
    if (size) {
      if (f.kind === 'clone') {
        const t = thumb(imgOfPanel(f.a.panel), A.box, [f.a.box, f.b.box], size);
        Object.assign(out, { thumbA: t.src, thumbAW: t.w, thumbAH: t.h });
        budget -= t.src.length;
      } else {
        const ta = thumb(imgOfPanel(f.a.panel), A.box, f.kind === 'partial' ? [f.a.box] : [], size);
        const tb = thumb(imgOfPanel(f.b.panel), B.box, f.kind === 'partial' ? [f.b.box] : [], size);
        Object.assign(out, { thumbA: ta.src, thumbAW: ta.w, thumbAH: ta.h, thumbB: tb.src, thumbBW: tb.w, thumbBH: tb.h });
        budget -= ta.src.length + tb.src.length;
      }
    }
    return out;
  });
  const perImage = new Map();
  for (const p of analysis.panels) perImage.set(p.imageId, (perImage.get(p.imageId) || 0) + 1);
  return {
    meta, findings, panels, skipped, charts: analysis.charts || [], provenance: analysis.provenance || 0,
    images: images.map(im => ({ id: im.id, label: im.label, width: im.width, height: im.height, panels: perImage.get(im.id) || 0, source: im.source })),
    summary: { images: images.length }
  };
}

// ------------------------------------------------------------------ result

function vendorCard(v) {
  return `<div class="card"><div class="card-head"><h3>Comparison with published figures (external database)</h3>${badge(v.connected ? 'Connected' : 'Not checked', v.connected ? 'good' : 'neutral')}</div><p class="muted" style="margin:0">${esc(v.note)}</p></div>`;
}

export function renderImagesResult(el, result, { live = null } = {}) {
  const s = result.summary;
  const marks = new Map((result.findingMarks || []).map(m => [m.id, m.mark]));
  const panelById = new Map((result.panels || []).map(p => [p.id, p]));
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(result.meta?.title || result.meta?.filename || 'Image Integrity')}</h1>
        <p>${result.meta?.manuscriptCode ? `<b>${esc(result.meta.manuscriptCode)}</b> · ` : ''}${fmtDate(result.createdAt)} · <span class="badge b-bad">Confidential — editor only</span></p></div>
      <div class="row no-print">
        ${result.id ? `<button class="btn btn-sm" id="export">${ICONS.download} Confidential report (Word)</button>` : ''}
        <button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print / PDF</button>
      </div>
    </div>
    <div class="risk-banner risk-${s.level.toLowerCase()}"><div class="risk-level">${esc(s.level)}</div><div><b>Image risk</b><div class="muted">${s.findings ? `${s.byLevel.high || 0} strong finding(s), ${s.byLevel.medium || 0} to check` : 'No duplicated or edited figures were found'}${s.earlier ? ` · ${s.earlier} figure(s) match earlier PJPS manuscripts` : ''}</div></div></div>
    <div class="kpis">
      <div class="kpi"><div class="n">${s.images}</div><div class="l">Figures</div></div>
      <div class="kpi"><div class="n">${s.panels}</div><div class="l">Panels compared</div></div>
      <div class="kpi ${s.byLevel.high ? 'bad' : ''}"><div class="n">${s.byLevel.high || 0}</div><div class="l">Strong findings</div></div>
      <div class="kpi ${s.byLevel.medium ? 'warn' : ''}"><div class="n">${s.byLevel.medium || 0}</div><div class="l">To check</div></div>
      <div class="kpi ${s.earlier ? 'warn' : ''}"><div class="n">${s.earlier || 0}</div><div class="l">Earlier PJPS matches</div></div>
      <div class="kpi"><div class="n">${s.skipped || 0}</div><div class="l">Not readable</div></div>
    </div>
    <div class="cat-strip">${CATS.map(([k, l, name]) => { const n = (result.findings || []).filter(f => (f.category || 'duplication') === k).length; const st = (result.coverage || {})[k]; return `<button class="cat ${catFilter === k ? 'active' : ''} ${n ? 'has' : ''}" data-cat="${k}"><span class="cat-l">${l})</span><b>${name}</b><span class="cat-n">${n ? n + ' finding' + (n > 1 ? 's' : '') : 'none found'}</span><small>${esc(st?.note || '')}</small></button>`; }).join('')}</div>
    <div class="alert alert-info">${esc(result.disclaimer)}</div>
    <div class="tabs"><button class="tab active" data-tab="findings">Findings<span class="count">${s.findings}</span></button><button class="tab" data-tab="earlier">Earlier PJPS manuscripts<span class="count">${(s.earlier || 0) + (s.earlierCharts || 0)}</span></button><button class="tab" data-tab="panels">All panels<span class="count">${s.panels}</span></button><button class="tab" data-tab="method">Method &amp; coverage</button></div>
    <div id="tab-body"></div>
    <div id="decision" class="no-print"></div>`;

  const body = $('#tab-body', el);
  const srcOf = panelId => {
    const p = panelById.get(panelId);
    const im = live?.get(p?.imageId);
    return im ? { src: im.canvas, box: p.box } : { src: p?.thumb, box: null };
  };
  const show = k => {
    $$('.tab', el).forEach(t => t.classList.toggle('active', t.dataset.tab === k));
    if (k === 'findings') findingsTab();
    else if (k === 'earlier') earlierTab();
    else if (k === 'panels') panelsTab();
    else methodTab();
  };
  const findingsTab = () => {
    const list = result.findings.filter(f => !catFilter || (f.category || 'duplication') === catFilter);
    if (!list.length) { body.innerHTML = '<div class="alert alert-good">' + (catFilter ? 'No findings in this category.' : 'No duplicated, altered, AI-generated or duplicated-chart content was found among the figures that could be read.') + '</div>'; return; }
    body.innerHTML = list.map((f, i) => `
      <div class="card finding" data-id="${esc(f.id)}">
        <div class="card-head"><h3>${i + 1}. ${esc(KIND[f.kind] || f.kind)}</h3><div class="row">${badge(f.level === 'high' ? 'Strong' : 'Check', levelTone(f.level))}${marks.get(f.id) ? badge({ confirmed: 'Confirmed', false: 'False alarm', ask: 'Ask authors' }[marks.get(f.id)], marks.get(f.id) === 'false' ? 'neutral' : 'info') : ''}</div></div>
        <p style="margin:0 0 8px">${esc(f.description)}</p>${(f.details || []).length ? `<ul class="muted" style="margin:0 0 8px">${f.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        <div class="pair">
          <figure>${f.thumbA ? `<img src="${f.thumbA}" alt="" data-view="a">` : '<div class="muted">no thumbnail</div>'}<figcaption>${esc(f.a.label)}</figcaption></figure>
          ${!single(f) ? `<figure>${f.thumbB ? `<img src="${f.thumbB}" alt="" data-view="b">` : '<div class="muted">no thumbnail</div>'}<figcaption>${esc(f.b.label)}</figcaption></figure>` : ''}
        </div>
        <div class="row no-print" style="margin-top:8px">
          <button class="btn btn-sm" data-open>Open forensic viewer</button>
          <span class="spacer"></span>
          <span class="muted">Your assessment:</span>
          ${[['confirmed', 'Confirmed'], ['false', 'False alarm'], ['ask', 'Ask the authors']].map(([k, l]) => `<button class="filter ${marks.get(f.id) === k ? 'active' : ''}" data-mark="${k}">${l}</button>`).join('')}
        </div>
      </div>`).join('') + `<div class="card no-print"><h3>Letter to the authors</h3><p class="muted">Lists the findings you marked “Ask the authors” (or all strong findings if none are marked) and asks for the original, uncropped images.</p><button class="btn btn-sm" id="letter">Prepare the letter</button><pre id="letter-text" class="mono" hidden style="white-space:pre-wrap;margin-top:10px"></pre></div>`;
    $$('.finding', body).forEach(card => {
      const f = result.findings.find(x => x.id === card.dataset.id);
      const openIt = () => {
        const A = srcOf(f.a.panel), B = srcOf(f.b.panel);
        if (!A.src) return toast('No image available for this finding', 'error');
        const pa = panelById.get(f.a.panel), pb = panelById.get(f.b.panel);
        // Live: crop to the matched regions; saved: thumbnails only
        const boxA = live && f.kind !== 'duplicate' && f.kind !== 'chart' && f.kind !== 'ai' ? f.a.box : A.box, boxB = live && f.kind !== 'duplicate' && f.kind !== 'chart' && f.kind !== 'ai' ? f.b.box : B.box;
        openViewer({ title: `${KIND[f.kind]} — ${f.a.label}${!single(f) ? ' ↔ ' + f.b.label : ''}`, a: { src: A.src, box: boxA, label: f.a.label || pa?.label }, b: B.src && !(single(f) && f.kind !== 'clone') ? { src: B.src, box: boxB, label: f.b.label || pb?.label } : null, transform: f.transform });
      };
      $('[data-open]', card).onclick = openIt;
      $$('img[data-view]', card).forEach(img => (img.onclick = openIt));
      $$('[data-mark]', card).forEach(b => (b.onclick = () => {
        const cur = marks.get(f.id) === b.dataset.mark ? null : b.dataset.mark;
        if (cur) marks.set(f.id, cur); else marks.delete(f.id);
        result.findingMarks = [...marks.entries()].map(([id, mark]) => ({ id, mark }));
        $$('[data-mark]', card).forEach(x => x.classList.toggle('active', x.dataset.mark === cur));
        if (result.id) api(`/api/checks/${result.id}/decision`, { method: 'PUT', body: { decision: result.decision?.decision || null, notes: result.decision?.notes || '', findingMarks: result.findingMarks } }).then(r => { result.decision = r.decision; }).catch(e => toast(e.message, 'error'));
      }));
    });
    $('#letter', body).onclick = () => {
      const chosen = result.findings.filter(f => marks.get(f.id) === 'ask');
      const list = chosen.length ? chosen : result.findings.filter(f => f.level === 'high' && marks.get(f.id) !== 'false');
      const code = result.meta?.manuscriptCode ? `${result.meta.manuscriptCode}: ` : '';
      const text = [`Subject: Query about figures — ${code}${result.meta?.title || ''}`, '', 'Dear Author(s),', '', `During the editorial screening of your manuscript, the following figure panels appear to contain duplicated or overlapping image content. Please explain each case and send the original, uncropped image files (and the full raw blots/gels where applicable) within 14 days.`, '',
        ...list.map((f, i) => `${i + 1}. ${single(f) ? f.a.label : `${f.a.label} and ${f.b.label}`}: ${KIND[f.kind].toLowerCase()} — ${f.description}`), '',
        'If an image was re-used intentionally (for example the same control in two figures), please state this in the figure legend.', '', 'Kind regards,', `Editorial Office, ${state.app?.homeJournal?.name || 'Pakistan Journal of Pharmaceutical Sciences'}`].join('\n');
      const pre = $('#letter-text', body);
      pre.hidden = false;
      pre.textContent = list.length ? text : 'No findings selected. Mark findings as “Ask the authors” first.';
    };
  };
  const earlierTab = () => {
    const e = result.earlier || [], ec = result.earlierCharts || [];
    const chartsTable = ec.length ? `<div class="card"><h3>Graph / chart data matching earlier manuscripts</h3><div class="table-wrap"><table class="t"><tr><th>This manuscript</th><th>Earlier manuscript</th><th>Earlier chart</th><th class="num">Correlation</th></tr>${ec.map(x => `<tr><td>${esc(x.chart)}</td><td><a href="#/check/${x.checkId}">${esc(x.manuscriptCode || 'Report #' + x.checkId)}</a><div class="muted">${esc(x.title || '')} · ${fmtDate(x.date)}</div></td><td>${esc(x.label)}</td><td class="num">${x.correlation}</td></tr>`).join('')}</table></div></div>` : '';
    body.innerHTML = e.length ? `<div class="card"><p class="muted">Panels whose fingerprint matches a figure in an earlier PJPS manuscript (smaller distance = closer match; 0 = identical).</p><div class="table-wrap"><table class="t"><tr><th>This manuscript</th><th>Earlier manuscript</th><th>Earlier figure</th><th class="num">Distance</th></tr>
      ${e.map(x => { const p = panelById.get(x.panel); return `<tr><td>${p?.thumb ? `<img src="${p.thumb}" class="mini">` : ''} ${esc(x.panelLabel)}</td><td><a href="#/check/${x.checkId}">${esc(x.manuscriptCode || 'Report #' + x.checkId)}</a><div class="muted">${esc(x.title || '')} · ${fmtDate(x.date)}</div></td><td>${x.thumb ? `<img src="${x.thumb}" class="mini">` : ''} ${esc(x.label || '')}</td><td class="num">${x.distance}</td></tr>`; }).join('')}</table></div></div>`
      : (ec.length ? '' : '<div class="alert alert-good">No figure or chart matches an earlier PJPS manuscript screened in this system.</div>');
    body.innerHTML += chartsTable;
  };
  const panelsTab = () => {
    body.innerHTML = `<div class="panel-grid">${(result.panels || []).map(p => `<figure class="panel-cell" data-panel="${esc(p.id)}">${p.thumb ? `<img src="${p.thumb}" alt="">` : ''}<figcaption>${esc(p.label)}<br><span class="muted">${esc(TYPE[p.type] || p.type)}${p.blank ? ' · blank/skipped' : ''}</span></figcaption></figure>`).join('')}</div>`;
    $$('.panel-cell', body).forEach(c => (c.onclick = () => { const s = srcOf(c.dataset.panel); const p = panelById.get(c.dataset.panel); if (s.src) openViewer({ title: p.label, a: { src: s.src, box: s.box, label: p.label } }); }));
  };
  const methodTab = () => {
    body.innerHTML = `<div class="card"><h3>How the figures were checked</h3><p>${esc(result.method)}</p>
      <h3>Figures</h3><table class="t"><tr><th>Figure</th><th>Size</th><th class="num">Panels</th></tr>${(result.images || []).map(im => `<tr><td>${esc(im.label)}</td><td>${im.width} × ${im.height}</td><td class="num">${im.panels}</td></tr>`).join('')}</table>
      ${(result.skipped || []).length ? `<h3>Not analysed</h3><ul>${result.skipped.map(x => `<li><b>${esc(x.name)}</b> — ${esc(x.reason)}</li>`).join('')}</ul>` : ''}
      <h3>Not covered</h3><p class="muted">${esc(result.vendor?.note || '')}</p></div>`;
  };
  $('.tab', el).forEach(t => (t.onclick = () => show(t.dataset.tab)));
  $$('.cat', el).forEach(b => (b.onclick = () => { catFilter = catFilter === b.dataset.cat ? null : b.dataset.cat; $$('.cat', el).forEach(x => x.classList.toggle('active', x.dataset.cat === catFilter)); show('findings'); }));
  show('findings');
  const ex = $('#export', el);
  if (ex) ex.onclick = () => download(`/api/checks/${result.id}/confidential`).catch(e => toast(e.message, 'error'));
  decisionCard($('#decision', el), result, 'images', { getExtra: () => ({ findingMarks: result.findingMarks || [] }) });
}
