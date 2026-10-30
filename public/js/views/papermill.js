// views/papermill.js - Module 4 Paper Mill Detection (editor only): input form and the confidential risk report
import { api, esc, $, $$, toast, runJob, badge, download, fmtDate, ICONS, datasetBanner } from '../core.js';
import { decisionCard } from './decision.js';

const GROUPS = { text: 'Text signals', references: 'Reference signals', authors: 'Author & submission signals', data: 'Data signals' };
const sevTone = s => ({ high: 'bad', medium: 'warn', low: 'neutral' }[s] || 'neutral');

export function renderPaperMill(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Module 4 — Paper Mill Detection</h1>
      <p>Looks for signs that a manuscript came from a paper mill: tortured phrases, AI-text leftovers, template wording, vague methods, fabricated references, citations to papers retracted for paper-mill reasons, authors with earlier retractions, ORCID and e-mail signals, misidentified cell lines and overlap with earlier PJPS submissions. Gives a LOW / MEDIUM / HIGH risk level with the evidence for every signal.</p></div></div>
    <div class="alert alert-warn">Screening aid only — it never rejects a paper by itself. The report is confidential and is never shared with authors or reviewers.</div>
    <div id="form-area">
      <div class="card">
        <div class="dropzone" id="dz">
          <input type="file" id="file" accept=".docx,.doc,.pdf,.txt,.odt,.rtf" hidden>
          <div><strong>Upload the full manuscript</strong> (title page with authors, e-mails and ORCID iDs, text and references) — drag &amp; drop or click</div>
          <div class="muted" style="margin-top:4px">Word (.docx) or PDF</div>
        </div>
        <div id="file-info" class="alert alert-info" hidden style="margin-top:12px"></div>
        <div class="field" style="margin-top:12px"><label for="paste">Or paste the complete manuscript text</label><textarea id="paste" rows="6" class="mono"></textarea></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Manuscript details</h2><span class="muted">Detected from the file when left empty</span></div>
        <div class="grid grid-2">
          <div class="field"><label for="m-code">Manuscript ID</label><input id="m-code" type="text" placeholder="e.g. PJPS-2026-0412"><div class="hint">Use the same ID for a revision: author changes between versions are detected.</div></div>
          <div class="field"><label for="m-title">Title</label><input id="m-title" type="text"></div>
        </div>
        <div class="grid grid-2">
          <div class="field"><label for="m-authors">Authors (one per line)</label><textarea id="m-authors" rows="4"></textarea></div>
          <div class="field"><label for="m-aff">Affiliations (one per line)</label><textarea id="m-aff" rows="4"></textarea></div>
        </div>
        <div class="grid grid-2">
          <div class="field"><label for="m-rev">Suggested reviewers <span class="muted">(names and e-mails, optional)</span></label><textarea id="m-rev" rows="3"></textarea></div>
          <div class="field"><label for="m-img">Image Integrity report <span class="muted">(optional)</span></label><select id="m-img"><option value="">— none —</option></select><div class="hint">Include the findings of a Module 5 report for this manuscript.</div></div>
        </div>
        <div class="row"><button class="btn btn-primary" id="run">Run Paper Mill Detection</button></div>
      </div>
    </div>
    <div id="progress"></div>
    <div id="result"></div>`;

  let file = null;
  const info = $('#file-info', view);
  const input = $('#file', view), zone = $('#dz', view);
  const take = f => { file = f; info.hidden = false; info.textContent = f.name; const code = (f.name.match(/PJPS[-_\s]?\d{4}[-_\s]?\d{2,5}/i) || [])[0]; if (code && !$('#m-code', view).value) $('#m-code', view).value = code.toUpperCase().replace(/[_\s]/g, '-'); };
  zone.onclick = () => input.click();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files[0]) take(e.dataTransfer.files[0]); };
  input.onchange = () => { if (input.files[0]) take(input.files[0]); input.value = ''; };
  api('/api/checks?kind=images').then(d => { $('#m-img', view).innerHTML += d.checks.slice(0, 50).map(c => `<option value="${c.id}">${esc(c.manuscript_code || '')} ${esc(c.title || '')} · ${fmtDate(c.created_at)}</option>`).join(''); }).catch(() => {});

  $('#run', view).onclick = async () => {
    const text = $('#paste', view).value.trim();
    if (!file && text.length < 300) return toast('Upload the manuscript or paste its full text.', 'error');
    const fd = new FormData();
    if (file) fd.append('file', file); else fd.append('text', text);
    for (const [k, id] of [['manuscriptCode', 'm-code'], ['title', 'm-title'], ['authors', 'm-authors'], ['affiliations', 'm-aff'], ['suggestedReviewers', 'm-rev'], ['imagesCheckId', 'm-img']]) fd.append(k, $(`#${id}`, view).value);
    $('#form-area', view).hidden = true;
    try {
      const { jobId } = await api('/api/papermill', { form: fd });
      const result = await runJob(jobId, $('#progress', view), 'Paper Mill Detection');
      renderPaperMillResult($('#result', view), result);
    } catch (e) {
      toast(e.message, 'error');
      $('#form-area', view).hidden = false;
    }
  };
}

export function renderPaperMillResult(el, r) {
  const groups = Object.entries(GROUPS).map(([g, label]) => ({ g, label, list: r.signals.filter(s => s.group === g) }));
  const c = r.checked || {};
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(r.meta?.title || 'Paper Mill Detection')}</h1>
        <p>${r.meta?.manuscriptCode ? `<b>${esc(r.meta.manuscriptCode)}</b> · ` : ''}${fmtDate(r.createdAt)} · <span class="badge b-bad">Confidential — editor only</span></p></div>
      <div class="row no-print">${r.id ? `<button class="btn btn-sm" id="export">${ICONS.download} Confidential report (Word)</button><button class="btn btn-sm" id="export-pdf">${ICONS.download} PDF</button>` : ''}<button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print / PDF</button></div>
    </div>
    ${datasetBanner(r)}
    <div class="risk-banner risk-${r.risk.level.toLowerCase()}"><div class="risk-level">${esc(r.risk.level)}</div><div><b>Paper mill risk</b> · score ${r.risk.score} · ${r.risk.highSignals} strong signal(s)<div class="muted">${esc(r.disclaimer)}</div></div></div>
    <div class="kpis">${groups.map(x => `<div class="kpi ${x.list.some(s => s.severity === 'high') ? 'bad' : x.list.length ? 'warn' : 'good'}"><div class="n">${x.list.length}</div><div class="l">${esc(x.label)}</div></div>`).join('')}</div>
    ${groups.map(x => `<div class="card"><div class="card-head"><h3>${esc(x.label)}</h3>${badge(x.list.length ? `${x.list.length} signal(s)` : 'None', x.list.length ? 'warn' : 'good')}</div>
      ${x.list.length ? x.list.map(s => `<div class="flag ${s.severity}"><div style="flex:1">
        <div class="msg">${badge(s.severity === 'high' ? 'Strong' : s.severity === 'medium' ? 'Moderate' : 'Weak', sevTone(s.severity))} ${esc(s.title)} <span class="muted">· weight ${s.weight}</span></div>
        ${s.note ? `<div class="guide">${esc(s.note)}</div>` : ''}
        ${(s.evidence || []).length ? `<details ${s.severity === 'high' ? 'open' : ''}><summary class="muted">Evidence (${s.evidence.length})</summary><ul class="evidence">${s.evidence.map(e => `<li>${esc(e.text)}${e.quote ? `<div class="quote">“…${esc(e.quote)}…”</div>` : ''}${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}${e.link ? ` <a href="${esc(e.link)}" target="_blank" rel="noopener">source</a>` : ''}${e.checkId ? ` <a href="#/check/${e.checkId}">open earlier report</a>` : ''}</li>`).join('')}</ul></details>` : ''}
      </div></div>`).join('') : '<p class="muted">No signal found.</p>'}</div>`).join('')}
    <div class="card"><h3>What was checked</h3><ul class="checked">
      <li>${c.references ? '✓' : '—'} References (${r.details?.references?.total || 0}: ${r.details?.references?.fabricated || 0} not found, ${r.details?.references?.retracted || 0} retracted)</li>
      <li>${c.authors ? '✓' : '—'} Authors against Retraction Watch${c.authors ? '' : ' (no author names found — enter them above)'}</li>
      <li>${c.orcid ? '✓' : '—'} ORCID iDs (${(r.details?.orcids || []).length}${c.orcid ? `; their publications checked against Retraction Watch: ${(r.details?.orcidRetractions || []).length} retracted` : ''})</li>
      <li>${c.references ? '✓' : '—'} Cited journals against the journals with 20 or more paper-mill retractions in Retraction Watch (${(r.details?.millJournals || []).reduce((n, j) => n + j.refs.length, 0)} reference(s))</li>
      <li>${c.statistics ? '✓' : '—'} Statistics recalculated (${c.statistics || 0} p-values and percentages found, ${(r.details?.statistics?.findings || []).length} inconsistent)</li>
      <li>${c.primers ? '✓' : '—'} Primer sequences (${c.primers || 0} found${c.primersBlasted ? `, ${c.primersBlasted} checked against NCBI BLAST` : c.primers ? ', NCBI BLAST not run' : ''})</li>
      <li>${(r.details?.emails || []).length ? '✓' : '—'} E-mail addresses (${(r.details?.emails || []).length})</li>
      <li>${c.reviewers ? '✓' : '—'} Suggested reviewers</li>
      <li>${c.previousVersion ? '✓ Compared with the earlier version' : '— No earlier version with this manuscript ID'}</li>
      <li>✓ Compared with ${c.earlierSubmissions || 0} earlier PJPS submission(s)</li>
      <li>${c.images ? '✓' : '—'} Image Integrity (Module 5)</li>
    </ul></div>
    <div id="decision" class="no-print"></div>`;
  const ex = $('#export', el);
  if (ex) ex.onclick = () => download(`/api/checks/${r.id}/confidential`).catch(e => toast(e.message, 'error'));
  const exp = $('#export-pdf', el);
  if (exp) exp.onclick = () => download(`/api/checks/${r.id}/confidential?format=pdf`).catch(e => toast(e.message, 'error'));
  decisionCard($('#decision', el), r, 'papermill');
  void $$;
}
