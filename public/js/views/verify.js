// views/verify.js - Verify Citations: does each cited sentence match its source?
import { esc, $, $$, toast, dropzone, startJob, download, badge, ICONS } from '../core.js';

const VTONE = { full: 'good', partial: 'warn', unsupported: 'bad', 'could-not-verify': 'neutral' };

export function renderVerify(view) {
  let manuscript = null;
  let sources = [];
  view.innerHTML = `
    <div class="page-head"><div><h1>Verify Citations</h1>
      <p>Checks whether the text's claims are actually supported by the sources they cite. The bibliography is verified first; the text is then split into cited claims and each claim is compared with the source's full text (uploaded or open access) or abstract. Analysis runs on this ${'server'} — the manuscript is not sent to external AI services.</p></div></div>
    <div id="form-area">
      <div class="card">
        <h3>1. Manuscript</h3>
        <div class="dropzone" id="dz"><input type="file" id="file" accept=".pdf,.docx,.txt,.odt,.rtf" hidden>
          <div><strong>Upload the manuscript</strong> (text and reference list) — Word, PDF, ODT, RTF or text</div></div>
        <div id="file-info" class="alert alert-info" hidden style="margin-top:12px"></div>
        <div class="field" style="margin-top:12px"><label for="paste">Or paste the full text including the References section</label><textarea id="paste" rows="7"></textarea></div>
        <div class="grid grid-2"><div class="field"><label for="title">Title <span class="muted">(optional)</span></label><input id="title" type="text"></div>
          <div class="field"><label for="code">Manuscript ID <span class="muted">(optional)</span></label><input id="code" type="text"></div></div>
      </div>
      <div class="card">
        <h3>2. Full texts of closed-access sources <span class="muted" style="font-weight:400">(optional)</span></h3>
        <p class="muted" style="margin-top:0">Upload the PDFs of paywalled sources for a full-text check. Files are linked to references automatically by DOI or title.</p>
        <div class="dropzone" id="dz2"><input type="file" id="files" accept=".pdf,.docx,.txt" multiple hidden><div><strong>Add source PDFs</strong> — up to 40 files</div></div>
        <div id="src-list" style="margin-top:10px"></div>
      </div>
      <div class="card row"><label class="check" style="margin:0"><input type="checkbox" id="save" checked> Save the report to My Activity</label><span class="spacer"></span><button class="btn btn-primary" id="run">Verify citations</button></div>
    </div>
    <div id="progress"></div><div id="result"></div>`;

  dropzone($('#dz', view), $('#file', view), f => {
    manuscript = f;
    const i = $('#file-info', view);
    i.hidden = false;
    i.textContent = `${f.name} ready.`;
  });
  const fileInput = $('#files', view);
  $('#dz2', view).onclick = () => fileInput.click();
  const showSources = () => { $('#src-list', view).innerHTML = sources.length ? `<div class="chips">${sources.map((f, i) => `<span class="chip">${esc(f.name)} <a href="#" data-rm="${i}">✕</a></span>`).join('')}</div>` : ''; $$('[data-rm]', view).forEach(a => (a.onclick = e => { e.preventDefault(); sources.splice(+a.dataset.rm, 1); showSources(); })); };
  const addFiles = list => { sources = [...sources, ...list].slice(0, 40); showSources(); };
  fileInput.onchange = () => { addFiles([...fileInput.files]); fileInput.value = ''; };
  $('#dz2', view).addEventListener('dragover', e => e.preventDefault());
  $('#dz2', view).addEventListener('drop', e => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });

  $('#run', view).onclick = async () => {
    const text = $('#paste', view).value.trim();
    if (!manuscript && !text) return toast('Upload or paste the manuscript first.', 'error');
    const fd = new FormData();
    if (manuscript) fd.append('manuscript', manuscript); else fd.append('text', text);
    for (const s of sources) fd.append('sources', s);
    fd.append('title', $('#title', view).value);
    fd.append('manuscriptCode', $('#code', view).value);
    fd.append('save', $('#save', view).checked);
    $('#form-area', view).hidden = true;
    try {
      const r = await startJob('/api/verify', { form: fd }, $('#progress', view), 'Verifying citations (1–5 minutes)');
      if (r) renderVerifyResult($('#result', view), r, { again: () => renderVerify(view) });
    } catch (e) {
      toast(e.message, 'error');
      $('#form-area', view).hidden = false;
    }
  };
}

export function renderVerifyResult(el, r, { again } = {}) {
  const s = r.summary;
  el.innerHTML = `
    <div class="page-head"><div><h1>${esc(r.meta?.title || 'Verify Citations')}</h1><p>${s.claims} cited claims · ${s.citations} citations · ${r.system === 'numeric' ? 'numbered' : 'author–year'} citations</p></div>
      <div class="row no-print"><button class="btn btn-sm" id="docx">${ICONS.download} Word</button><button class="btn btn-sm" id="csv">${ICONS.download} CSV</button>${again ? '<button class="btn btn-sm btn-ghost" id="again">Check another</button>' : ''}</div></div>
    <div class="kpis">
      <div class="kpi good"><div class="n">${s.full}</div><div class="l">Full match</div></div>
      <div class="kpi warn"><div class="n">${s.partial}</div><div class="l">Partial match</div></div>
      <div class="kpi bad"><div class="n">${s.unsupported}</div><div class="l">Unsupported</div></div>
      <div class="kpi"><div class="n">${s.couldNotVerify}</div><div class="l">Could not verify</div></div>
      <div class="kpi ${r.references.summary.suspicious ? 'bad' : ''}"><div class="n">${r.references.summary.suspicious}</div><div class="l">Suspicious references</div></div>
    </div>
    ${r.files?.linked?.length || r.files?.unlinked?.length ? `<div class="alert alert-info">${r.files.linked.length} uploaded file(s) linked: ${r.files.linked.map(f => `${esc(f.name)} → [${f.refIndex}]`).join(', ')}${r.files.unlinked.length ? `. Not linked (no matching DOI or title): ${r.files.unlinked.map(esc).join(', ')}` : ''}</div>` : ''}
    ${r.truncated ? '<div class="alert alert-warn">Only the first 400 cited claims were analysed.</div>' : ''}
    <p class="muted">${esc(r.method)}</p>
    <div class="filters">${[['all', 'All'], ['unsupported', 'Unsupported'], ['partial', 'Partial'], ['could-not-verify', 'Could not verify'], ['full', 'Full match']].map(([k, l], i) => `<button class="filter ${i ? '' : 'active'}" data-f="${k}">${l}</button>`).join('')}</div>
    <div id="claims">${r.claims.map(c => `
      <div class="claim" data-v="${c.citations.map(x => x.verdict).join(' ')}">
        <div class="claim-head">${esc(c.sentence)}</div>
        ${c.citations.map(x => `<div class="claim-cite" data-one="${x.verdict}">
          <div class="row" style="justify-content:space-between"><div class="row"><b>[${x.refIndex}]</b> ${badge(x.verdictLabel, VTONE[x.verdict])} ${x.refStatus !== 'verified' ? badge(`Reference: ${x.refStatusLabel}`, x.refStatus === 'suspicious' || x.refStatus === 'retracted' ? 'bad' : 'neutral') : ''}${x.score !== null ? `<span class="muted">match ${x.score}%</span>` : ''}</div></div>
          <div class="muted" style="font-size:12.5px;margin-top:4px">${esc(x.refRaw)}</div>
          ${x.evidence ? `<div class="quote">“${esc(x.evidence.quote)}”<span class="src">${esc(x.evidence.origin)}${x.evidence.page ? `, page ${x.evidence.page}` : ''} · ${esc(x.evidence.level)}${x.evidence.url ? ` · <a href="${esc(x.evidence.url)}" target="_blank" rel="noopener">open</a>` : ''}</span></div>` : ''}
          ${x.notes.length ? `<ul style="margin:4px 0 0;font-size:13px">${x.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        </div>`).join('')}
      </div>`).join('')}</div>`;
  $('#docx', el).onclick = () => download('/api/export/docx', { kind: 'verify', data: r }).catch(e => toast(e.message, 'error'));
  $('#csv', el).onclick = () => download('/api/export/csv', { kind: 'verify', data: r }).catch(e => toast(e.message, 'error'));
  if (again) $('#again', el).onclick = again;
  $$('[data-f]', el).forEach(b => (b.onclick = () => {
    $$('[data-f]', el).forEach(x => x.classList.toggle('active', x === b));
    $$('.claim', el).forEach(c => (c.hidden = b.dataset.f !== 'all' && !c.dataset.v.split(' ').includes(b.dataset.f)));
  }));
}
