// views/format.js - Manuscript Format converter: Word manuscript -> publisher template
import { api, esc, $, toast, dropzone, runJob, styleOptions, download, downloadJobFile, badge, ICONS, state } from '../core.js';
import { renderRestyleResult } from './restyle.js';

export function renderFormat(view) {
  let file = null;
  view.innerHTML = `
    <div class="page-head"><div><h1>Manuscript Format</h1>
      <p>Convert a Word manuscript to a publisher's general submission template — page layout and margins, fonts, line spacing, columns, line numbers and heading styles — and convert the citations and references in the same step.</p></div></div>
    <div id="form-area">
      <div class="card">
        <div class="dropzone" id="dz"><input type="file" id="file" accept=".docx" hidden>
          <div><strong>Upload the manuscript (.docx)</strong> — drag &amp; drop or click</div>
          <div class="muted" style="margin-top:4px">An editable Word file is required — PDF does not keep an editable structure.</div></div>
        <div id="file-info" class="alert alert-info" hidden style="margin-top:12px"></div>
        <div class="grid grid-3" style="margin-top:14px">
          <div class="field"><label for="tpl">Publisher template</label><select id="tpl">${state.app.templates.map(t => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}</select></div>
          <div class="field"><label for="atype">Article type</label><select id="atype">${state.app.articleTypes.map(t => `<option value="${t.key}">${esc(t.label)}</option>`).join('')}</select></div>
          <div class="field"><label for="style">Citation style</label><select id="style"><option value="">Template default</option>${styleOptions('')}</select></div>
        </div>
        <label class="check"><input type="checkbox" id="restyle" checked> Convert in-text citations and the reference list</label>
        <label class="check"><input type="checkbox" id="lookup" checked> Complete missing DOI, issue and pages from registered records${state.app.desktop ? ' (needs internet)' : ''}</label>
        <label class="check" style="margin-bottom:14px"><input type="checkbox" id="save" checked> Save the summary to My Activity</label>
        <button class="btn btn-primary" id="run">Convert manuscript</button>
      </div>
    </div>
    <div id="progress"></div><div id="result"></div>`;

  dropzone($('#dz', view), $('#file', view), f => {
    if (!/\.docx$/i.test(f.name)) return toast('Upload an editable Word document (.docx).', 'error');
    file = f;
    const info = $('#file-info', view);
    info.hidden = false;
    info.textContent = `${f.name} (${Math.round(f.size / 1024)} KB) ready.`;
  });
  const tplSel = $('#tpl', view);
  const syncStyle = () => { const t = state.app.templates.find(x => x.key === tplSel.value); $('#style', view).options[0].text = `Template default (${state.app.styles.find(s => s.key === t.style)?.label || t.style})`; };
  tplSel.onchange = syncStyle;
  syncStyle();

  $('#run', view).onclick = async () => {
    if (!file) return toast('Upload the manuscript first.', 'error');
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, id] of [['template', 'tpl'], ['articleType', 'atype'], ['style', 'style']]) fd.append(k, $(`#${id}`, view).value);
    for (const k of ['restyle', 'lookup', 'save']) fd.append(k, $(`#${k}`, view).checked);
    $('#form-area', view).hidden = true;
    try {
      const d = await api('/api/format', { form: fd });
      const result = await runJob(d.jobId, $('#progress', view), 'Converting the manuscript');
      renderFormatResult($('#result', view), result, { jobId: d.jobId, again: () => renderFormat(view) });
    } catch (e) {
      toast(e.message, 'error');
      $('#form-area', view).hidden = false;
    }
  };
}

export function renderFormatResult(el, r, { jobId, again } = {}) {
  const s = r.structure;
  el.innerHTML = `
    <div class="page-head"><div><h1>${esc(r.templateLabel)}</h1><p>${esc(r.filename)} · ${esc(s.articleType)}</p></div>
      <div class="row no-print">
        ${jobId ? `<button class="btn btn-primary btn-sm" id="dl">${ICONS.download} Download formatted Word file</button>` : ''}
        <button class="btn btn-sm" id="rep">${ICONS.download} Word report</button>
        ${again ? '<button class="btn btn-sm btn-ghost" id="again">Convert another</button>' : ''}
      </div></div>
    <div class="grid grid-2">
      <div class="card"><h3>Changes applied</h3><ul>${r.changes.map(c => `<li>${esc(c)}</li>`).join('')}</ul>
        <table class="t"><tr><td>Font</td><td>${esc(r.settings.font)} ${r.settings.size} pt</td></tr><tr><td>Line spacing</td><td>${r.settings.line === 1 ? 'Single' : r.settings.line === 2 ? 'Double' : r.settings.line}</td></tr>
        <tr><td>Page</td><td>${esc(r.settings.page)}, ${r.settings.cols} column(s)${r.settings.lineNumbers ? ', line numbers' : ''}</td></tr><tr><td>Citation style</td><td>${esc(state.app.styles.find(x => x.key === r.settings.style)?.label || r.settings.style)}</td></tr></table></div>
      <div class="card"><h3>Section checklist</h3>
        <table class="t">${s.sections.map(x => `<tr><td>${esc(x.section)}</td><td>${x.present ? badge('Present', 'good') : badge('Missing', 'warn')}</td></tr>`).join('')}</table>
        <p class="muted" style="margin:10px 0 0">Abstract: ${s.abstractWords === null ? 'not found' : `${s.abstractWords} words ${s.abstractTooLong ? badge(`over the ${s.abstractLimit}-word limit`, 'warn') : badge(`within ${s.abstractLimit}`, 'good')}`}</p></div>
    </div>
    <div class="alert alert-info">${esc(r.note)}</div>
    ${r.restyle ? '<h2>References</h2><div id="rs"></div>' : ''}`;
  if (r.restyle) renderRestyleResult($('#rs', el), r.restyle, {});
  if ($('#dl', el)) $('#dl', el).onclick = () => downloadJobFile(jobId).catch(e => toast(e.message, 'error'));
  $('#rep', el).onclick = () => download('/api/export/docx', { kind: 'format', data: r }).catch(e => toast(e.message, 'error'));
  if (again) $('#again', el).onclick = again;
}
