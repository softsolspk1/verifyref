// views/papermill.js - Module 4 Paper Mill Detection (editor only): input form and the confidential risk report
import { api, esc, $, $$, toast, runJob, badge, download, fmtDate, ICONS, datasetBanner } from '../core.js';
import { decisionCard } from './decision.js';

const GROUPS = { text: 'Text signals', references: 'Reference signals', authors: 'Author & submission signals', data: 'Data signals' };
const sevTone = s => ({ high: 'bad', medium: 'warn', low: 'neutral' }[s] || 'neutral');

export function renderPaperMill(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Module 4 — Paper Mill Detection</h1>
      <p>Looks for signs that a manuscript came from a paper mill: tortured phrases, AI-text leftovers, template wording, vague methods, fabricated references, citations to papers retracted for paper-mill reasons, authors with earlier retractions, ORCID and e-mail signals, misidentified cell lines, microRNAs that do not exist in the species studied (miRBase) and overlap with earlier PJPS submissions. Gives a LOW / MEDIUM / HIGH risk level with the evidence for every signal.</p></div></div>
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

const SEV = { high: 'Strong', medium: 'Moderate', low: 'Weak' };

// what was checked: [check, result, done] (the same list as the Word / PDF report)
function coverage(r) {
  const c = r.checked || {}, d = r.details || {};
  const millRefs = (d.millJournals || []).reduce((n, j) => n + (j.refs || []).length, 0);
  return [
    ['Manuscript text (tortured phrases, AI-text leftovers, template wording, methods, hidden text)', 'Checked', !!c.text],
    ['References against the scholarly databases and Retraction Watch', c.references ? `${d.references?.total || 0} checked: ${d.references?.fabricated || 0} not found, ${d.references?.retracted || 0} retracted` : 'No reference list found', !!c.references],
    ['Cited journals with 20 or more paper-mill retractions (Retraction Watch)', c.references ? `${millRefs} reference(s)` : 'No reference list found', !!c.references],
    ['Authors against Retraction Watch (by name)', c.authors ? 'Checked' : 'No author names found — enter them above', !!c.authors],
    ['ORCID iDs and their publications against Retraction Watch', c.orcid ? `${(d.orcids || []).length} iD(s); ${(d.orcidRetractions || []).length} retracted publication(s)` : 'No ORCID iD in the manuscript', !!c.orcid],
    ['E-mail addresses (free-mail, disposable, institution)', (d.emails || []).length ? `${d.emails.length} address(es)` : 'No e-mail address found', !!(d.emails || []).length],
    ['Suggested reviewers', c.reviewers ? 'Checked' : 'None given', !!c.reviewers],
    ['Statistics recalculated (p-values, percentages)', c.statistics ? `${c.statistics} value(s), ${(d.statistics?.findings || []).length} inconsistent` : 'No test statistics found', !!c.statistics],
    ['Primer sequences (NCBI BLAST)', c.primers ? `${c.primers} found${c.primersBlasted ? `, ${c.primersBlasted} checked in BLAST` : ', BLAST not run'}` : 'No primer sequences', !!c.primers],
    ['Earlier version of this manuscript (author changes)', c.previousVersion ? 'Compared' : 'No earlier version with this manuscript ID', !!c.previousVersion],
    ['Earlier PJPS submissions (text overlap)', `${c.earlierSubmissions || 0} compared`, true],
    ['Image Integrity (Module 5)', c.images ? 'Included' : 'No Module 5 report attached', !!c.images]
  ];
}

const evidenceRow = (e, i) => `<tr><td class="num">${i + 1}</td><td>${esc(e.text)}${e.quote ? `<div class="quote">“…${esc(e.quote)}…”</div>` : ''}${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}</td><td class="no-wrap">${e.link ? `<a href="${esc(e.link)}" target="_blank" rel="noopener">Source</a>` : ''}${e.checkId ? ` <a href="#/check/${e.checkId}">Earlier report</a>` : ''}</td></tr>`;

export function renderPaperMillResult(el, r) {
  const signals = r.signals || [];
  const groups = Object.entries(GROUPS).map(([g, label]) => ({ g, label, list: signals.filter(s => s.group === g) }));
  const count = (list, sev) => list.filter(s => s.severity === sev).length;
  const main = signals.filter(s => s.severity !== 'low').sort((a, b) => b.weight - a.weight).slice(0, 6);
  // score on a 0-12 scale with the MEDIUM (4) and HIGH (8) thresholds marked
  const pct = Math.min(100, (r.risk.score / 12) * 100);
  const authors = (r.meta?.authors || []).map(a => a.name).filter(Boolean);
  let n = 0;
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(r.meta?.title || 'Paper Mill Detection')}</h1>
        <p>${r.meta?.manuscriptCode ? `<b>${esc(r.meta.manuscriptCode)}</b> · ` : ''}${fmtDate(r.createdAt)} · <span class="badge b-bad">Confidential — editor only</span></p></div>
      <div class="row no-print">${r.id ? `<button class="btn btn-sm" id="export">${ICONS.download} Confidential report (Word)</button><button class="btn btn-sm" id="export-pdf">${ICONS.download} PDF</button>` : ''}<button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print / PDF</button></div>
    </div>
    ${datasetBanner(r)}
    <div class="risk-banner risk-${r.risk.level.toLowerCase()}"><div class="risk-level">${esc(r.risk.level)}</div><div style="flex:1">
      <b>Paper mill risk</b> · score ${r.risk.score} · ${count(signals, 'high')} strong, ${count(signals, 'medium')} moderate, ${count(signals, 'low')} weak signal(s)
      <div class="score-meter" title="LOW below 4 · MEDIUM from 4 · HIGH from 8"><span class="fill" style="width:${pct}%"></span><span class="mark" style="left:33.3%"></span><span class="mark" style="left:66.6%"></span></div>
      <div class="score-scale"><span>LOW</span><span>MEDIUM ≥ 4</span><span>HIGH ≥ 8</span></div>
      <div class="muted">${esc(r.disclaimer)}</div></div></div>
    ${authors.length ? `<p class="muted" style="margin:-6px 0 14px">Authors: ${esc(authors.join(', '))}</p>` : ''}
    <div class="grid grid-2">
      <div class="card"><h3>Main reasons</h3>${main.length ? `<ol class="reasons">${main.map(s => `<li>${badge(SEV[s.severity], sevTone(s.severity))} ${esc(s.title)}</li>`).join('')}</ol>` : '<p class="muted">No strong or moderate signal was found.</p>'}</div>
      <div class="card"><h3>Signals at a glance</h3><div class="table-wrap"><table class="t"><tr><th>Area</th><th class="num">Strong</th><th class="num">Moderate</th><th class="num">Weak</th><th class="num">Weight</th></tr>
        ${groups.map(x => `<tr><td>${esc(x.label)}</td><td class="num">${count(x.list, 'high') || '—'}</td><td class="num">${count(x.list, 'medium') || '—'}</td><td class="num">${count(x.list, 'low') || '—'}</td><td class="num">${x.list.reduce((a, s) => a + s.weight, 0)}</td></tr>`).join('')}
        <tr class="total"><td>Total</td><td class="num">${count(signals, 'high')}</td><td class="num">${count(signals, 'medium')}</td><td class="num">${count(signals, 'low')}</td><td class="num">${r.risk.score}</td></tr></table></div></div>
    </div>
    ${groups.map(x => `<div class="card"><div class="card-head"><h3>${esc(x.label)}</h3>${badge(x.list.length ? `${x.list.length} signal(s)` : 'None', x.list.some(s => s.severity === 'high') ? 'bad' : x.list.length ? 'warn' : 'good')}</div>
      ${x.list.length ? x.list.map(s => { n++; const ev = s.evidence || []; return `<div class="pm-signal sev-${s.severity}">
        <div class="pm-head"><span class="pm-no">${n}</span><div style="flex:1"><div class="msg">${esc(s.title)}</div>${s.note ? `<div class="guide">${esc(s.note)}</div>` : ''}</div><div class="pm-sev">${badge(SEV[s.severity], sevTone(s.severity))}<span class="muted">weight ${s.weight}</span></div></div>
        ${ev.length ? `<details ${s.severity !== 'low' ? 'open' : ''}><summary class="muted">Evidence (${ev.length})</summary><div class="table-wrap"><table class="t ev"><tr><th class="num">#</th><th>Evidence</th><th></th></tr>${ev.map(evidenceRow).join('')}</table></div></details>` : ''}
      </div>`; }).join('') : '<p class="muted">No signal found.</p>'}</div>`).join('')}
    <div class="card"><h3>What was checked</h3><div class="table-wrap"><table class="t"><tr><th>Check</th><th>Result</th></tr>${coverage(r).map(([k, v, done]) => `<tr><td>${done ? '<span class="ok-mark">✓</span>' : '<span class="muted">—</span>'} ${esc(k)}</td><td class="${done ? '' : 'muted'}">${esc(v)}</td></tr>`).join('')}</table></div>
      <p class="muted" style="margin-top:8px">How the level is set: every signal has a weight (set on a benchmark of 150 paper-mill retractions and 126 ordinary papers). LOW below 4, MEDIUM from 4 or with one strong signal, HIGH from 8 or with two strong signals. No single signal proves that a paper came from a paper mill.</p></div>
    <div id="decision" class="no-print"></div>`;
  const ex = $('#export', el);
  if (ex) ex.onclick = () => download(`/api/checks/${r.id}/confidential`).catch(e => toast(e.message, 'error'));
  const exp = $('#export-pdf', el);
  if (exp) exp.onclick = () => download(`/api/checks/${r.id}/confidential?format=pdf`).catch(e => toast(e.message, 'error'));
  decisionCard($('#decision', el), r, 'papermill');
  void $$;
}
