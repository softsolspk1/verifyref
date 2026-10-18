// views/reviewerReport.js - Reviewer report check (coercive citation requests)
import { api, esc, $, badge, sevTone, toast, runJob, copyText, ICONS } from '../core.js';

export async function renderReviewerReport(view) {
  const { checks } = await api('/api/checks?kind=manuscript').catch(() => ({ checks: [] }));
  view.innerHTML = `
    <div class="page-head"><div><h1>Reviewer report check</h1>
      <p>Extracts the citation requests in a reviewer report, verifies each requested reference and flags requests for the reviewer's own work, a single journal or weakly related sources — before the report reaches the author.</p></div></div>
    <div id="rr-form">
      <div class="card">
        <div class="grid grid-2">
          <div class="field"><label for="rr-name">Reviewer name</label><input id="rr-name" type="text" placeholder="As it appears on their publications"></div>
          <div class="field"><label for="rr-orcid">Reviewer ORCID <span class="muted">(recommended)</span></label><input id="rr-orcid" type="text" placeholder="0000-0000-0000-0000"></div>
        </div>
        <div class="field"><label for="rr-text">Reviewer report</label><textarea id="rr-text" rows="12" placeholder="Paste the full reviewer report, including any reference lists the reviewer suggests."></textarea></div>
        <div class="grid grid-2">
          <div class="field"><label for="rr-check">Manuscript</label>
            <select id="rr-check"><option value="">— Enter title below —</option>${checks.filter(c => c.has_result).map(c => `<option value="${c.id}">${esc(c.manuscript_code ? c.manuscript_code + ' — ' : '')}${esc((c.title || 'Untitled').slice(0, 80))} (v${c.version})</option>`).join('')}</select>
            <div class="hint">Choose a checked manuscript to judge relevance against its title and abstract.</div></div>
          <div class="field"><label for="rr-title">…or manuscript title</label><input id="rr-title" type="text"></div>
        </div>
        <div class="field"><label for="rr-abs">Abstract <span class="muted">(optional)</span></label><textarea id="rr-abs" rows="3"></textarea></div>
        <button class="btn btn-primary" id="rr-run">Check report</button>
      </div>
    </div>
    <div id="rr-progress"></div>
    <div id="rr-result"></div>`;

  $('#rr-run', view).onclick = async () => {
    const body = {
      text: $('#rr-text', view).value, reviewerName: $('#rr-name', view).value, reviewerOrcid: $('#rr-orcid', view).value,
      checkId: $('#rr-check', view).value || null, title: $('#rr-title', view).value, abstract: $('#rr-abs', view).value
    };
    if (body.text.trim().length < 30) return toast('Paste the reviewer report', 'error');
    if (!body.reviewerName && !body.reviewerOrcid) toast('Without the reviewer name or ORCID, own-work requests cannot be detected.');
    $('#rr-form', view).hidden = true;
    try {
      const { jobId } = await api('/api/reviewer-report', { body });
      const res = await runJob(jobId, $('#rr-progress', view), 'Checking reviewer report');
      renderReviewerReportResult($('#rr-result', view), res, () => { $('#rr-form', view).hidden = false; $('#rr-result', view).innerHTML = ''; });
    } catch (e) {
      toast(e.message, 'error');
      $('#rr-form', view).hidden = false;
    }
  };
}

export function renderReviewerReportResult(el, res, onBack) {
  const s = res.summary;
  const riskTone = { high: 'bad', medium: 'warn', low: 'neutral', none: 'good' }[res.risk];
  el.innerHTML = `
    <div class="page-head"><div><h1>Reviewer report check</h1><p>${res.reviewer?.name ? `Reviewer: <b>${esc(res.reviewer.name)}</b>${res.reviewer.orcid ? ` · ORCID ${esc(res.reviewer.orcid)}` : ''}` : 'Reviewer not specified'}${res.manuscript?.title ? ` · ${esc(res.manuscript.title)}` : ''}</p></div>
      <div class="row no-print">${onBack ? '<button class="btn btn-sm" id="rr-back">← Check another report</button>' : ''}<button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print / PDF</button></div></div>
    <div class="alert alert-${riskTone === 'neutral' ? 'info' : riskTone}"><b>Coercive-citation risk: ${esc(res.risk.toUpperCase())}</b></div>
    <div class="kpis">
      <div class="kpi"><div class="n">${s.requests}</div><div class="l">Citation requests</div></div>
      <div class="kpi ${s.ownWork ? 'bad' : 'good'}"><div class="n">${s.ownWork}</div><div class="l">Reviewer's own work</div></div>
      <div class="kpi ${s.singleJournal ? 'warn' : ''}"><div class="n">${s.singleJournal}</div><div class="l">Single-journal groups</div></div>
      <div class="kpi ${s.weakRelevance ? 'warn' : ''}"><div class="n">${s.weakRelevance}</div><div class="l">Weakly related</div></div>
      <div class="kpi ${s.unverifiable ? 'bad' : ''}"><div class="n">${s.unverifiable}</div><div class="l">Unverifiable</div></div>
    </div>
    ${res.flags.length ? `<div class="card"><h3>Findings</h3>${res.flags.map(f => `<div class="flag ${f.severity}"><div><div class="msg">${esc(f.message)}</div>${f.quote ? `<div class="guide">“…${esc(f.quote)}…”</div>` : ''}</div></div>`).join('')}</div>` : ''}
    <div class="card"><h3>Requested references</h3>
      ${res.items.length ? `<div class="table-wrap"><table class="t"><tr><th>#</th><th>Requested</th><th>Verification</th><th>Flags</th></tr>
        ${res.items.map(i => `<tr><td class="num">${i.index}</td><td>${esc(i.requested)}${i.record ? `<div class="muted">${esc(i.record.title)} — ${esc(i.record.journal || '')} ${i.record.year || ''}</div>` : ''}${i.context ? `<div class="muted" style="font-size:12px">Context: “${esc(i.context.slice(0, 200))}”</div>` : ''}</td><td>${badge(i.statusLabel || i.status, { verified: 'good', miscited: 'warn', suspicious: 'bad', retracted: 'bad' }[i.status] || 'neutral')}</td><td>${i.flags.map(f => `<div>${badge(f.severity, sevTone(f.severity))} ${esc(f.message)}</div>`).join('') || '<span class="muted">—</span>'}</td></tr>`).join('')}
      </table></div>` : '<p class="muted">No specific references were requested.</p>'}
    </div>
    ${res.genericRequests?.length ? `<div class="card"><h3>General citation requests (no specific source)</h3><ul>${res.genericRequests.map(g => `<li>${esc(g)}</li>`).join('')}</ul></div>` : ''}
    <div class="card"><div class="card-head"><h3>Suggested note to the author</h3><button class="btn btn-sm" id="rr-copy">${ICONS.copy} Copy</button></div><div class="letter">${esc(res.editorNote)}</div></div>`;
  if (onBack) $('#rr-back', el).onclick = onBack;
  $('#rr-copy', el).onclick = () => copyText(res.editorNote);
}
