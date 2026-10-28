// views/restyle.js - Module 2: PJPS style compliance check (rule by rule) and converter to PJPS format (Word document
// with Track Changes, or a pasted list). Other styles remain available in the style picker.
import { api, esc, $, $$, toast, dropzone, runJob, download, downloadJobFile, copyText, badge, ICONS, state } from '../core.js';

const STATUS = { matched: ['Matched record', 'good'], parsed: ['From the text as written', 'warn'], kept: ['Unchanged — check manually', 'bad'] };

export function renderRestyle(view) {
  let mode = 'docx', file = null;
  view.innerHTML = `
    <div class="page-head"><div><h1>Module 2 — Reference Style Check &amp; PJPS Converter</h1>
      <p>Checks every reference and in-text citation against the PJPS house style rule by rule (authors, year, title, journal abbreviation, volume(issue): pages, missing details, order, a/b letters) and lists each deviation with the expected form. Then converts the citations and the reference list to PJPS format — in the Word file as Track Changes that you can accept or reject. Each entry is matched to its registered record first, so missing DOIs, issues and pages are filled in; entries that cannot be matched are flagged, never silently changed.</p></div></div>
    <div id="form-area">
      <div class="card">
        <div class="seg" style="margin-bottom:14px"><button class="active" data-mode="docx">Word document</button><button data-mode="list">Paste a reference list</button></div>
        <div id="m-docx">
          <div class="dropzone" id="dz"><input type="file" id="file" accept=".docx" hidden>
            <div><strong>Upload the manuscript (.docx)</strong> — drag &amp; drop or click</div>
            <div class="muted" style="margin-top:4px">Needs a “References” heading. Numbered ↔ author–date ↔ footnote conversion; up to 250 references.</div></div>
          <div id="file-info" class="alert alert-info" hidden style="margin-top:12px"></div>
        </div>
        <div id="m-list" hidden>
          <div class="field"><label for="list">References, one per line</label><textarea id="list" class="mono" rows="10" placeholder="Khan MA, Siddiqui A (2021). Antioxidant activity of … Pak J Pharm Sci 34(2): 455-462."></textarea></div>
        </div>
        <div class="grid grid-2" style="margin-top:14px">
          <div class="field"><label>Correct to</label><input type="hidden" id="style" value="pjps"><div><b>PJPS reference style</b></div><div class="hint">Every reference and in-text citation is checked against the PJPS house style and corrected to it.</div></div>
          <div class="field"><label>Options</label>
            <label class="check"><input type="checkbox" id="track" checked> Show the changes in the Word file as Track Changes</label>
            <label class="check"><input type="checkbox" id="lookup" checked> Complete missing DOI, issue and pages from registered records</label>
            <label class="check"><input type="checkbox" id="save" checked> Save the report to My Activity</label>
          </div>
        </div>
        <div class="field"><label for="m-code">Manuscript ID <span class="muted">(optional)</span></label><input id="m-code" type="text" placeholder="e.g. PJPS-2026-0412" style="max-width:320px"></div>
        <button class="btn btn-primary" id="run">Check &amp; convert</button>
      </div>
    </div>
    <div id="progress"></div><div id="result"></div>`;

  $$('.seg button', view).forEach(b => (b.onclick = () => {
    mode = b.dataset.mode;
    $$('.seg button', view).forEach(x => x.classList.toggle('active', x === b));
    $('#m-docx', view).hidden = mode !== 'docx';
    $('#m-list', view).hidden = mode !== 'list';
  }));
  dropzone($('#dz', view), $('#file', view), f => {
    if (!/\.docx$/i.test(f.name)) return toast('Upload an editable Word document (.docx).', 'error');
    file = f;
    const info = $('#file-info', view);
    info.hidden = false;
    info.textContent = `${f.name} (${Math.round(f.size / 1024)} KB) ready.`;
  });

  $('#run', view).onclick = async () => {
    const fd = new FormData();
    if (mode === 'docx') { if (!file) return toast('Upload a Word document first.', 'error'); fd.append('file', file); }
    else { const t = $('#list', view).value.trim(); if (!t) return toast('Paste the references first.', 'error'); fd.append('text', t); }
    fd.append('style', $('#style', view).value);
    fd.append('lookup', $('#lookup', view).checked);
    fd.append('save', $('#save', view).checked);
    fd.append('track', $('#track', view).checked);
    fd.append('manuscriptCode', $('#m-code', view).value.trim());
    $('#form-area', view).hidden = true;
    try {
      const d = await api('/api/restyle', { form: fd });
      const result = await runJob(d.jobId, $('#progress', view), 'Checking PJPS style and converting');
      renderRestyleResult($('#result', view), result, { jobId: d.jobId, again: () => renderRestyle(view) });
    } catch (e) {
      toast(e.message, 'error');
      $('#form-area', view).hidden = false;
    }
  };
}

const RULES = { authors: 'Authors', year: 'Year', title: 'Title', journal: 'Journal abbreviation', volume: 'Volume / issue', pages: 'Pages', missing: 'Missing details', doi: 'DOI', order: 'Order', suffix: 'a/b letters' };

function complianceHtml(cp) {
  if (!cp) return '<div class="alert alert-info">The compliance check was not part of this saved report.</div>';
  const s = cp.summary;
  const bad = cp.entries.filter(e => !e.compliant);
  return `
    <div class="kpis">
      <div class="kpi ${s.score >= 90 ? 'good' : s.score >= 60 ? 'warn' : 'bad'}"><div class="n">${s.score}%</div><div class="l">PJPS compliant (${s.compliant} of ${s.total})</div></div>
      <div class="kpi ${s.deviations ? 'warn' : 'good'}"><div class="n">${s.deviations}</div><div class="l">Deviations</div></div>
      <div class="kpi ${s.inTextIssues ? 'warn' : 'good'}"><div class="n">${s.inTextIssues}</div><div class="l">In-text citation problems</div></div>
      ${Object.entries(s.byRule).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `<div class="kpi"><div class="n">${n}</div><div class="l">${esc(RULES[k] || k)}</div></div>`).join('')}
    </div>
    ${cp.inText.issues.length ? `<div class="card"><h3>In-text citations ${s.citationSystem === 'numeric' ? '(numbered style found)' : ''}</h3><table class="t"><tr><th>Citation</th><th>Problem</th></tr>${cp.inText.issues.map(i => `<tr><td><b>${esc(i.citation || '—')}</b>${i.count > 1 ? ` <span class="muted">×${i.count}</span>` : ''}</td><td>${esc(i.message)}${i.context ? `<div class="muted">…${esc(i.context)}…</div>` : ''}</td></tr>`).join('')}</table></div>` : ''}
    ${bad.length ? bad.map(e => `<div class="entry kept">
        <div><b>[${e.index}]</b> ${esc(e.original)}</div>
        <ul class="issue-list">${e.deviations.map(d => `<li>${badge(RULES[d.rule] || d.rule, d.severity === 'high' ? 'bad' : d.severity === 'info' ? 'info' : 'warn')} ${esc(d.message)}${d.found ? ` — <span class="diff-old">${esc(d.found)}</span>` : ''}${d.expected ? ` → <span class="diff-new">${esc(d.expected)}</span>` : ''}</li>`).join('')}</ul>
        ${e.expected ? `<div class="suggest"><b>PJPS form:</b> ${esc(e.expected)} <button class="btn btn-sm btn-ghost" data-copy="${esc(e.expected)}">${ICONS.copy}</button></div>` : ''}
      </div>`).join('') : '<div class="alert alert-good">Every reference follows the PJPS house style.</div>'}`;
}

export function renderRestyleResult(el, r, { jobId, again } = {}) {
  const c = r.counts;
  el.innerHTML = `
    <div class="page-head"><div><h1>${esc(r.styleLabel)}</h1><p>${esc(r.filename || 'Pasted reference list')}${r.lookedUp === false ? ' · formatted without online lookup' : ''}${r.trackChanges ? ' · changes shown as Track Changes' : ''}</p></div>
      <div class="row no-print">
        ${jobId && r.file ? `<button class="btn btn-primary btn-sm" id="dl">${ICONS.download} Download converted Word file</button>` : ''}
        <button class="btn btn-sm" id="copy">${ICONS.copy} Copy reference list</button>
        <button class="btn btn-sm" id="rep">${ICONS.download} Word report</button>
        ${again ? '<button class="btn btn-sm btn-ghost" id="again">Convert another</button>' : ''}
      </div></div>
    <div class="kpis">
      <div class="kpi"><div class="n">${c.total}</div><div class="l">References</div></div>
      <div class="kpi good"><div class="n">${c.matched}</div><div class="l">Matched to a registered record</div></div>
      <div class="kpi warn"><div class="n">${c.parsed}</div><div class="l">Formatted from the text</div></div>
      <div class="kpi bad"><div class="n">${c.kept}</div><div class="l">Left unchanged</div></div>
      ${r.citationsConverted !== undefined && r.filename ? `<div class="kpi info"><div class="n">${r.citationsConverted}</div><div class="l">In-text citations converted</div></div>` : ''}
    </div>
    <div class="tabs"><button class="tab active" data-tab="compliance">PJPS style compliance${r.compliance ? `<span class="count">${r.compliance.summary.nonCompliant}</span>` : ''}</button><button class="tab" data-tab="converted">Converted (before / after)<span class="count">${c.total}</span></button></div>
    <div id="tab-compliance">${complianceHtml(r.compliance)}</div>
    <div id="tab-converted" hidden>
    ${r.unresolvedCitations ? `<div class="alert alert-warn">${r.unresolvedCitations} in-text citation(s) could not be matched to a reference and were left as written.</div>` : ''}
    ${r.uncited?.length ? `<div class="alert alert-info">Reference(s) ${r.uncited.join(', ')} are never cited in the text; they were placed at the end of the list.</div>` : ''}
    ${c.parsed + c.kept ? '<div class="alert alert-warn">Entries without a reliable database match are not auto-corrected: yellow entries were formatted from the text as written and red ones were left unchanged. Check them before submission.</div>' : ''}
    <div class="filters">${['all', 'matched', 'parsed', 'kept'].map((k, i) => `<button class="filter ${i ? '' : 'active'}" data-f="${k}">${k === 'all' ? 'All' : STATUS[k][0]}</button>`).join('')}</div>
    <div id="entries">${r.entries.map(e => `
      <div class="entry ${e.status}" data-s="${e.status}">
        <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap"><div><b>${e.number}.</b></div><div style="flex:none">${badge(STATUS[e.status][0], STATUS[e.status][1])}</div></div>
        ${(e.filled || []).length || (e.corrected || []).length ? `<div class="chips" style="margin-top:6px">${(e.filled || []).map(f => `<span class="chip found">${esc(f)} added</span>`).join('')}${(e.corrected || []).map(f => `<span class="chip error">${esc(f)} corrected</span>`).join('')}</div>` : ''}
        <div class="before-after"><div><div class="muted">Before</div>${esc(e.original)}</div><div><div class="muted">After</div>${e.html}</div></div>
      </div>`).join('')}</div>
    </div>`;
  $$('.tab', el).forEach(t => (t.onclick = () => {
    $$('.tab', el).forEach(x => x.classList.toggle('active', x === t));
    $('#tab-compliance', el).hidden = t.dataset.tab !== 'compliance';
    $('#tab-converted', el).hidden = t.dataset.tab !== 'converted';
  }));
  $$('[data-copy]', el).forEach(b => (b.onclick = () => copyText(b.dataset.copy)));
  if ($('#dl', el)) $('#dl', el).onclick = () => downloadJobFile(jobId).catch(e => toast(e.message, 'error'));
  $('#copy', el).onclick = () => copyText(r.entries.map(e => e.text).join('\n'));
  $('#rep', el).onclick = () => download('/api/export/docx', { kind: 'restyle', data: r }).catch(e => toast(e.message, 'error'));
  if (again) $('#again', el).onclick = again;
  $$('[data-f]', el).forEach(b => (b.onclick = () => {
    $$('[data-f]', el).forEach(x => x.classList.toggle('active', x === b));
    $$('.entry', el).forEach(x => (x.hidden = b.dataset.f !== 'all' && x.dataset.s !== b.dataset.f));
  }));
}
