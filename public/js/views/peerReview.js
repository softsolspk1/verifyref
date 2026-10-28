// views/peerReview.js - Peer-Review Integrity (editor only): reviewer identity, conflicts of interest with the authors,
// and suspicious review patterns (generic or recycled reports, coercive citation, AI text, implausibly fast returns).
import { api, esc, $, $$, toast, runJob, download, fmtDate, ICONS, hasModule } from '../core.js';
import { decisionCard } from './decision.js';
import { riskBanner, explanationCard, signalList, openCase } from './integrityCommon.js';

const rvForm = i => `<div class="rv-card" data-rv="${i}">
  <div class="card-head" style="margin-bottom:6px"><b>Reviewer ${i + 1}</b>${i ? '<button class="btn btn-sm btn-ghost" data-remove>Remove</button>' : ''}</div>
  <div class="grid grid-2">
    <div class="field"><label>Name</label><input data-f="name" type="text"></div>
    <div class="field"><label>E-mail</label><input data-f="email" type="email"></div>
  </div>
  <div class="grid grid-2">
    <div class="field"><label>ORCID iD <span class="muted">(optional)</span></label><input data-f="orcid" type="text" placeholder="0000-0000-0000-0000"></div>
    <div class="field"><label>Institution <span class="muted">(optional)</span></label><input data-f="institution" type="text"></div>
  </div>
  <div class="grid grid-2">
    <div class="field"><label>Invited <span class="muted">(optional)</span></label><input data-f="invitedAt" type="datetime-local"></div>
    <div class="field"><label>Report returned <span class="muted">(optional)</span></label><input data-f="returnedAt" type="datetime-local"></div>
  </div>
  <div class="field"><label>Review report <span class="muted">(paste, optional)</span></label><textarea data-f="report" rows="4"></textarea></div>
</div>`;

export function renderPeerReview(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Module 4 — Peer-review integrity</h1>
      <p>Checks each reviewer of a manuscript: is the identity real (ORCID, institutional e-mail), is there a conflict of interest with the authors (same institution, co-authored papers in the last 10 years, shared surname), and does the report look genuine (specific to this manuscript, not reused from another review, no coercive citation requests, no AI-tool traces, not returned within hours). Reviewers suggested by unrelated author teams are flagged as possible review rings.</p></div></div>
    <div id="form-area">
      <div class="card">
        <div class="card-head"><h2>Manuscript</h2><span class="muted">Or take the details from a Module 4 screening</span></div>
        <div class="grid grid-2">
          <div class="field"><label for="p-from">From a Module 4 screening</label><select id="p-from"><option value="">— enter below —</option></select></div>
          <div class="field"><label for="p-code">Manuscript ID</label><input id="p-code" type="text"></div>
        </div>
        <div class="grid grid-2">
          <div class="field"><label for="p-title">Title</label><input id="p-title" type="text"></div>
          <div class="field"><label for="p-emails">Author e-mail addresses</label><input id="p-emails" type="text" placeholder="a@uni.edu.pk, b@uni.edu.pk"></div>
        </div>
        <div class="grid grid-2">
          <div class="field"><label for="p-authors">Authors (one per line)</label><textarea id="p-authors" rows="3"></textarea></div>
          <div class="field"><label for="p-aff">Affiliations (one per line)</label><textarea id="p-aff" rows="3"></textarea></div>
        </div>
        <div class="grid grid-2">
          <div class="field"><label for="p-sugg">Reviewers suggested by the authors <span class="muted">(names / e-mails)</span></label><textarea id="p-sugg" rows="2"></textarea></div>
          <div class="field"><label>Manuscript file <span class="muted">(optional — lets the report be checked for specificity)</span></label><input type="file" id="p-file" accept=".docx,.doc,.pdf,.txt"></div>
        </div>
      </div>
      <div class="card"><div class="card-head"><h2>Reviewers</h2><button class="btn btn-sm" id="add-rv">+ Add reviewer</button></div><div id="rvs">${rvForm(0)}</div>
        <div class="row"><button class="btn btn-primary" id="run">Check peer review</button></div></div>
    </div>
    <div id="progress"></div>
    <div id="result"></div>`;

  let n = 1;
  $('#add-rv', view).onclick = () => { if (n >= 10) return; $('#rvs', view).insertAdjacentHTML('beforeend', rvForm(n++)); };
  $('#rvs', view).onclick = e => { if (e.target.closest('[data-remove]')) e.target.closest('.rv-card').remove(); };
  api('/api/checks?kind=integrity').then(d => { $('#p-from', view).innerHTML += d.checks.slice(0, 60).map(c => `<option value="${c.id}">${esc(c.manuscript_code || '')} ${esc((c.title || '').slice(0, 70))} · ${fmtDate(c.created_at)}</option>`).join(''); }).catch(() => {});

  $('#run', view).onclick = async () => {
    const reviewers = $$('.rv-card', view).map(card => Object.fromEntries($$('[data-f]', card).map(i => [i.dataset.f, i.type === 'datetime-local' && i.value ? new Date(i.value).toISOString() : i.value.trim()]))).filter(r => r.name || r.email);
    if (!reviewers.length) return toast('Add at least one reviewer (name or e-mail).', 'error');
    const fd = new FormData();
    const file = $('#p-file', view).files[0];
    if (file) fd.append('file', file);
    fd.append('reviewers', JSON.stringify(reviewers));
    for (const [k, id] of [['fromCheckId', 'p-from'], ['manuscriptCode', 'p-code'], ['title', 'p-title'], ['authorEmails', 'p-emails'], ['authors', 'p-authors'], ['affiliations', 'p-aff'], ['suggestedReviewers', 'p-sugg']]) fd.append(k, $(`#${id}`, view).value);
    $('#form-area', view).hidden = true;
    try {
      const { jobId } = await api('/api/peer-review', { form: fd });
      renderPeerReviewResult($('#result', view), await runJob(jobId, $('#progress', view), 'Peer-Review Integrity'));
    } catch (e) { toast(e.message, 'error'); $('#form-area', view).hidden = false; }
  };
}

export function renderPeerReviewResult(el, r) {
  const d = r.dimensions[0];
  const reviewers = d.details?.reviewers || [];
  el.innerHTML = `
    <div class="page-head"><div><h1>Peer-review integrity${r.meta?.manuscriptCode ? ` — ${esc(r.meta.manuscriptCode)}` : ''}</h1><p>${esc(r.meta?.title || '')} · ${fmtDate(r.createdAt)} · <span class="badge b-bad">Confidential</span></p></div>
      <div class="row no-print">${r.id ? `<button class="btn btn-sm" id="x-docx">${ICONS.download} Report (Word)</button><button class="btn btn-sm" id="x-pdf">${ICONS.download} PDF</button>${hasModule('papermill') ? '<button class="btn btn-sm btn-primary" id="x-case">Open integrity case</button>' : ''}` : ''}</div></div>
    ${riskBanner(r.risk, 'Peer-review risk', r.disclaimer)}
    ${reviewers.map(rv => `<div class="card"><div class="card-head"><h3>${esc(rv.name || rv.email || 'Reviewer')}</h3><span class="muted">${esc(rv.email || '')}${rv.orcid ? ` · <a href="https://orcid.org/${esc(rv.orcid)}" target="_blank" rel="noopener">${esc(rv.orcid)}</a>` : ''}</span></div>
      ${rv.coauthorship?.checked ? `<p class="muted">OpenAlex: ${esc(rv.coauthorship.displayName || '')}${rv.coauthorship.institution ? `, ${esc(rv.coauthorship.institution)}` : ''} · ${rv.coauthorship.items.length} joint paper(s) with the authors</p>` : ''}
      ${rv.reportStats ? `<p class="muted">Report: ${rv.reportStats.words} words${rv.reportStats.specificity ? `, ${rv.reportStats.specificity.specific} of ${rv.reportStats.specificity.total} distinctive terms also in the manuscript` : ''}</p>` : ''}
      ${rv.findings.length ? signalList(rv.findings.map(f => ({ title: f.text, severity: f.severity, weight: f.weight, note: f.note, evidence: f.link ? [{ text: 'Source record', link: f.link }] : [] }))) : '<p class="muted">No concern found.</p>'}</div>`).join('')}
    ${explanationCard(r.risk)}
    <div id="decision" class="no-print"></div>`;
  if (r.id) {
    $('#x-docx', el).onclick = () => download(`/api/checks/${r.id}/integrity-report`).catch(e => toast(e.message, 'error'));
    $('#x-pdf', el).onclick = () => download(`/api/checks/${r.id}/integrity-report?format=pdf`).catch(e => toast(e.message, 'error'));
    const c = $('#x-case', el);
    if (c) c.onclick = () => openCase(r.id);
  }
  decisionCard($('#decision', el), r, 'peer-review');
}
