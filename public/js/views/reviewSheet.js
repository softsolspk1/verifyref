// views/reviewSheet.js - the PJPS Preliminary Review Sheet: upload a manuscript (and the figure files, if sent) and the
// journal's desk-review form is filled from it, each answer with the text it was read from; the editor changes any
// answer (saved at once) and downloads the form as the journal's Word file.
import { api, esc, $, $$, toast, download, dropzone, shareManuscript, fmtDate } from '../core.js';

const OUTCOME = {
  'peer-review': ['The article can be processed for Peer Review', 'good'],
  resubmit: ['Lies in the Scope but requires resubmission after correction as per PJPS Author’s Guidelines', 'warn'],
  reject: ['Outside the scope / not suitable for PJPS', 'bad']
};
const badgeOf = o => `<span class="badge b-${OUTCOME[o]?.[1] || 'neutral'}">${esc(o === 'peer-review' ? 'Peer review' : o === 'resubmit' ? 'Resubmit after correction' : o === 'reject' ? 'Not suitable' : '—')}</span>`;

export async function renderReviewSheets(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Preliminary Review Sheet</h1>
      <p>Upload a manuscript and the PJPS Preliminary Review Sheet is filled in automatically: scope, novelty and suitability; the article type with its
      reporting guideline (CONSORT, STROBE, CARE, PRISMA, ARRIVE, TREND), checklist and flow diagram; and the Authors’ Instructions — structured abstract of at most
      300 words, Introduction, Materials and Methods, trial registration, ethical approval, separate Results and Discussion, references in PJPS format and figures as
      separate 600 dpi TIFF files. Each answer shows where it was found; change any of them, then download the sheet as the journal’s Word form.</p></div></div>
    <div class="card">
      <div class="dropzone" id="dz">
        <input type="file" id="file" accept=".docx,.doc,.pdf,.odt,.rtf,.txt" hidden>
        <div><strong>Upload the manuscript</strong> — drag &amp; drop or click; the sheet is filled at once</div>
        <div class="muted" style="margin-top:4px">Word (.docx, .doc), PDF, OpenDocument (.odt), RTF or plain text</div>
      </div>
      <div class="row" style="gap:16px;margin-top:14px;flex-wrap:wrap;align-items:flex-end">
        <div class="field" style="margin:0;min-width:180px"><label for="rs-msno">MS No (optional — read from the file name otherwise)</label><input id="rs-msno" placeholder="e.g. 16692"></div>
        <div class="field" style="margin:0;flex:1;min-width:260px"><label for="rs-figs">Figure files sent by the authors (optional: their format and dpi are checked)</label><input type="file" id="rs-figs" multiple accept=".tif,.tiff,.jpg,.jpeg,.png"></div>
      </div>
      <div id="rs-busy" class="alert alert-info" hidden style="margin-top:12px"></div>
    </div>
    <div id="rs-list"><div class="muted">Loading…</div></div>`;
  const input = $('#file', view);
  const busy = $('#rs-busy', view);
  dropzone($('#dz', view), input, async f => {
    const fd = new FormData();
    fd.append('file', f);
    for (const g of $('#rs-figs', view).files) fd.append('figures', g);
    fd.append('msNo', $('#rs-msno', view).value.trim());
    busy.hidden = false;
    busy.textContent = `Reading ${f.name} and filling the review sheet…`;
    try {
      const d = await api('/api/review-sheet', { form: fd });
      location.hash = `#/review-sheet/${d.id}`;
    } catch (e) { busy.hidden = true; toast(e.message, 'error'); }
  });
  shareManuscript(view);

  const d = await api('/api/review-sheets');
  const box = $('#rs-list', view);
  if (!d.sheets.length) { box.innerHTML = '<div class="card empty">No review sheets yet. Upload a manuscript above.</div>'; return; }
  box.innerHTML = `<div class="card"><h3>Review sheets</h3><table class="t"><tr><th>MS No</th><th>Title</th><th>Outcome</th><th>Updated</th><th></th></tr>
    ${d.sheets.map(s => `<tr><td><b>${esc(s.msNo || '—')}</b></td><td><a href="#/review-sheet/${s.id}">${esc(s.title || s.filename || 'Manuscript')}</a><div class="muted" style="font-size:12px">${esc(s.filename || '')}</div></td>
      <td>${badgeOf(s.outcome)}</td><td class="muted">${esc(fmtDate(s.updatedAt))}</td>
      <td class="num"><button class="btn btn-sm" data-dl="${s.id}">Word</button> <button class="btn btn-sm btn-ghost" data-del="${s.id}" title="Delete">✕</button></td></tr>`).join('')}</table></div>`;
  $$('[data-dl]', box).forEach(b => (b.onclick = () => download(`/api/review-sheet/${b.dataset.dl}/docx`).catch(e => toast(e.message, 'error'))));
  $$('[data-del]', box).forEach(b => (b.onclick = async () => {
    await api(`/api/review-sheet/${b.dataset.del}`, { method: 'DELETE' }).catch(e => toast(e.message, 'error'));
    renderReviewSheets(view);
  }));
}

const TYPES = [
  ['rct', 'Randomized Trial (RCT) or Interventional study', 'CONSORT'],
  ['observational', 'Observational Study (Cohort / Case-control / Cross-sectional)', 'STROBE or RECORD'],
  ['case-report', 'Case Report', 'CARE'],
  ['retrospective', 'Retrospective Study', 'STROBE'],
  ['systematic-review', 'Systematic Review', 'PRISMA'],
  ['scoping-review', 'Scoping Review', 'PRISMA-ScR'],
  ['animal', 'Animal study', 'ARRIVE'],
  ['nonrandomized', 'Nonrandomized / quasi-experimental intervention studies', 'TREND'],
  ['other', 'Others (Specify)', '—']
];
const ITEMS = [
  ['abstract', 'Abstract contains: Background, Objectives, Methods, Results, and Conclusion. (Structured and ≤ 300 words)'],
  ['introduction', 'Introduction'],
  ['methods', 'Materials and Method'],
  ['registration', 'The clinical study is registered and the registration number and registration date are provided'],
  ['ethics', 'Ethical Approval (For animal and human study)'],
  ['results', 'Results (should be a separate heading)'],
  ['discussion', 'Discussion (should be a separate heading)'],
  ['references', 'References (within the manuscript and in the reference section as per PJPS Format)'],
  ['figures', 'Figures (Submitted as a separate file with 600 dpi in TIFF format)']
];

export async function renderReviewSheet(view, id) {
  view.innerHTML = '<div class="muted">Loading…</div>';
  let d = await api(`/api/review-sheet/${id}`);
  const save = async edits => {
    try { d = await api(`/api/review-sheet/${id}`, { method: 'PUT', body: edits }); paint(); }
    catch (e) { toast(e.message, 'error'); }
  };
  // a Yes / No (/ N/A) choice: the automatic answer is marked, a changed one too
  const choice = (name, a, opts = ['yes', 'no']) => `<span class="rs-choice">${opts.map(o => `<label class="rs-opt ${a?.value === o ? 'on' : ''}"><input type="radio" name="${name}" value="${o}" ${a?.value === o ? 'checked' : ''}> ${o === 'na' ? 'N/A' : o === 'yes' ? 'Yes' : 'No'}</label>`).join('')}${a && a.auto !== undefined && a.value !== a.auto ? ' <span class="badge b-info" title="Changed by the editor">edited</span>' : ''}</span>`;
  const ev = a => (a?.evidence ? `<div class="rs-ev">${esc(a.evidence)}</div>` : '');

  function paint() {
    const s = d.sheet;
    const g = s.type.guideline;
    const [olabel, otone] = OUTCOME[s.outcome] || ['—', 'neutral'];
    view.innerHTML = `
      <div class="page-head"><div><h1>Preliminary Review Sheet</h1><p>${esc(d.filename || '')} · filled ${esc(fmtDate(d.createdAt))}${d.updatedAt !== d.createdAt ? ` · edited ${esc(fmtDate(d.updatedAt))}` : ''}</p></div>
        <div class="row no-print" style="gap:8px"><a class="btn btn-sm" href="#/review-sheet">← All sheets</a><button class="btn btn-sm" onclick="window.print()">Print</button><button class="btn btn-sm btn-primary" id="rs-dl">Download Word form</button></div></div>
      <div class="card rs-sheet">
        <div class="rs-head"><b>PAKISTAN JOURNAL OF PHARMACEUTICAL SCIENCES</b><div>Faculty of Pharmacy and Pharmaceutical Sciences</div><div>University of Karachi, Karachi, Pakistan</div><h2>PRELIMINARY REVIEW SHEET</h2></div>
        <div class="row" style="gap:12px;align-items:center;flex-wrap:wrap"><label for="rs-ms"><b>MS No</b></label><input id="rs-ms" value="${esc(s.msNo || '')}" style="max-width:180px"></div>
        <p style="margin:12px 0 4px">PJPS received an article for publication entitled:</p>
        <textarea id="rs-title" rows="2" class="rs-title">${esc(s.title || '')}</textarea>

        <h3>Please check that the above article is within the scope/domain of the journal</h3>
        <table class="t rs-t"><tr><th>Within the scope</th><th>Possesses Novelty</th><th>Suitable</th></tr>
          <tr><td>${choice('scope', s.scope)}${s.scope?.areas?.length ? `<div style="margin-top:4px">${s.scope.areas.map(a => `<span class="badge b-info">${esc(a)}</span>`).join(' ')}</div>` : ''}${ev(s.scope)}</td><td>${choice('novelty', s.novelty)}${ev(s.novelty)}</td><td>${choice('suitable', s.suitable)}${ev(s.suitable)}</td></tr></table>

        <h3>Article type and reporting guideline</h3>
        <table class="t rs-t"><tr><th>Article type</th><th>Guideline</th><th>Relevant guidelines followed</th><th>Guidelines checklist included</th><th>Guidelines flow diagram included</th></tr>
          ${TYPES.map(([k, label, gl]) => {
            const on = s.type.key === k;
            return `<tr class="${on ? 'rs-on' : ''}"><td><label class="rs-opt ${on ? 'on' : ''}"><input type="radio" name="type" value="${k}" ${on ? 'checked' : ''}> ${esc(label)}</label>${k === 'other' && on ? ` <input id="rs-specify" value="${esc(s.type.specify || '')}" placeholder="Specify" style="max-width:260px">` : ''}${on && s.type.auto !== s.type.key ? ' <span class="badge b-info">edited</span>' : ''}${on && s.type.evidence ? `<div class="rs-ev">${esc(s.type.evidence)}</div>` : ''}</td>
              <td>${esc(gl)}</td>
              ${['followed', 'checklist', 'flow'].map(x => `<td>${on && gl !== '—' ? `${choice(`g-${x}`, g[x])}${ev(g[x])}` : '<span class="muted">—</span>'}</td>`).join('')}</tr>`;
          }).join('')}</table>

        <h3>Please check that the above article is as per the Author’s Instructions for PJPS</h3>
        <table class="t rs-t"><tr><th>Item</th><th style="width:210px">Yes / No</th><th>Found in the manuscript</th></tr>
          ${ITEMS.map(([k, label]) => `<tr><td>${esc(label)}</td><td>${choice(`i-${k}`, s.items[k], ['yes', 'no', 'na'])}</td><td class="rs-ev">${esc(s.items[k]?.evidence || '')}</td></tr>`).join('')}</table>

        <div class="risk-banner risk-${{ good: 'low', warn: 'medium', bad: 'high' }[otone] || 'medium'}" style="margin-top:14px"><div class="risk-level">${s.outcome === 'peer-review' ? '✓' : s.outcome === 'resubmit' ? '↩' : '!'}</div>
          <div><b>${esc(olabel)}</b><div class="muted">${esc(s.outcomeNote || '')} The editor decides.</div></div></div>

        <div class="field" style="margin-top:14px"><label for="rs-comments">Comments (printed on the sheet)</label><textarea id="rs-comments" rows="3" placeholder="Notes to the authors or the editorial office">${esc(s.comments || '')}</textarea></div>
        <p class="muted" style="font-size:12px;margin:6px 0 0">Filled automatically from the manuscript: headings, abstract, article type and guideline statements are read from the text; references are checked with the PJPS style rules (Module 2) and against the in-text citations (Module 3); novelty is compared with the titles of all published PJPS articles. Upload the authors’ figure files with the manuscript to check their format and resolution.</p>
      </div>`;
    $('#rs-dl', view).onclick = () => download(`/api/review-sheet/${id}/docx`).catch(e => toast(e.message, 'error'));
    $$('input[type=radio]', view).forEach(r => (r.onchange = () => {
      const n = r.name, v = r.value;
      if (n === 'type') save({ typeKey: v });
      else if (n.startsWith('g-')) save({ guideline: { [n.slice(2)]: v } });
      else if (n.startsWith('i-')) save({ items: { [n.slice(2)]: v } });
      else save({ [n]: v });
    }));
    const onBlur = (sel, key) => { const el = $(sel, view); if (el) el.onchange = () => save({ [key]: el.value }); };
    onBlur('#rs-ms', 'msNo');
    onBlur('#rs-title', 'title');
    onBlur('#rs-specify', 'specify');
    onBlur('#rs-comments', 'comments');
  }
  paint();
}
