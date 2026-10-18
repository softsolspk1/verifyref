// views/reviewers.js - Reviewer Finder
import { api, esc, $, $$, badge, toast, runJob, download, ICONS, dropzone } from '../core.js';

export function renderReviewers(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Reviewer Finder</h1>
      <p>Lists candidates who have recently published on the manuscript's topic, with ORCID, institution, workload and conflict-of-interest flags (co-authorship with the manuscript's authors, shared institution). Contact details are intentionally not provided.</p></div></div>
    <div id="rf-form">
      <div class="card">
        <div class="dropzone" id="dz"><input type="file" id="file" accept=".pdf,.docx,.txt" hidden><strong>Fill from the manuscript</strong> — drop the Word/PDF file here, or type the details below</div>
        <div class="field" style="margin-top:14px"><label for="rf-title">Manuscript title</label><input id="rf-title" type="text"></div>
        <div class="field"><label for="rf-abs">Abstract</label><textarea id="rf-abs" rows="5"></textarea></div>
        <div class="grid grid-2">
          <div class="field"><label for="rf-kw">Keywords</label><input id="rf-kw" type="text" placeholder="separated by commas"></div>
          <div class="field"><label for="rf-years">Published within</label><select id="rf-years"><option value="3">last 3 years</option><option value="5" selected>last 5 years</option><option value="8">last 8 years</option></select></div>
        </div>
        <div class="grid grid-2">
          <div class="field"><label for="rf-authors">Manuscript authors</label><textarea id="rf-authors" rows="3" placeholder="One per line — used for conflict-of-interest screening"></textarea></div>
          <div class="field"><label for="rf-aff">Author affiliations</label><textarea id="rf-aff" rows="3" placeholder="One per line"></textarea></div>
        </div>
        <div class="field"><label for="rf-ex">Exclude <span class="muted">(optional)</span></label><input id="rf-ex" type="text" placeholder="Names the authors asked to exclude, separated by ;"></div>
        <button class="btn btn-primary" id="rf-run">Find reviewers</button>
      </div>
    </div>
    <div id="rf-progress"></div>
    <div id="rf-result"></div>`;

  dropzone($('#dz', view), $('#file', view), async file => {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const d = await api('/api/extract', { form: fd });
      const m = d.meta || {};
      if (m.title) $('#rf-title', view).value = m.title;
      if (m.abstract) $('#rf-abs', view).value = m.abstract;
      if (m.keywords?.length) $('#rf-kw', view).value = m.keywords.join(', ');
      if (m.authors?.length) $('#rf-authors', view).value = m.authors.map(a => a.name).join('\n');
      if (m.affiliations?.length) $('#rf-aff', view).value = m.affiliations.join('\n');
      toast('Details filled from the manuscript — please review');
    } catch (e) { toast(e.message, 'error'); }
  });

  $('#rf-run', view).onclick = async () => {
    const body = {
      title: $('#rf-title', view).value, abstract: $('#rf-abs', view).value, keywords: $('#rf-kw', view).value,
      authors: $('#rf-authors', view).value.split('\n').join(';'), affiliations: $('#rf-aff', view).value, exclude: $('#rf-ex', view).value,
      yearsBack: $('#rf-years', view).value
    };
    if (body.title.trim().length < 10) return toast('Enter the manuscript title', 'error');
    $('#rf-form', view).hidden = true;
    try {
      const { jobId } = await api('/api/reviewers', { body });
      const res = await runJob(jobId, $('#rf-progress', view), 'Finding reviewer candidates');
      renderCandidates($('#rf-result', view), res, () => { $('#rf-form', view).hidden = false; $('#rf-result', view).innerHTML = ''; });
    } catch (e) {
      toast(e.message, 'error');
      $('#rf-form', view).hidden = false;
    }
  };
}

function renderCandidates(el, res, onBack) {
  const draw = () => {
    const orcidOnly = $('#f-orcid', el).checked, noCoi = $('#f-coi', el).checked, country = $('#f-country', el).value;
    const list = res.candidates.filter(c => (!orcidOnly || c.orcid) && (!noCoi || !c.hasCoi) && (!country || (country === 'PK' ? c.country === 'PK' : c.country !== 'PK')));
    $('#cands', el).innerHTML = list.length ? list.map(card).join('') : '<div class="empty">No candidates match these filters.</div>';
  };
  el.innerHTML = `
    <div class="card no-print">
      <div class="row">
        <button class="btn btn-sm" id="back">← New search</button>
        <span class="muted">${res.candidates.length} candidates from ${res.works} recent publications</span>
        <span class="spacer"></span>
        <label class="check" style="margin:0"><input type="checkbox" id="f-orcid"> ORCID only</label>
        <label class="check" style="margin:0"><input type="checkbox" id="f-coi"> Hide conflicts</label>
        <select id="f-country" style="width:auto"><option value="">All countries</option><option value="PK">Pakistan-based</option><option value="INT">Outside Pakistan</option></select>
        <button class="btn btn-sm" id="x-docx">${ICONS.download} Word</button>
        <button class="btn btn-sm" id="x-csv">${ICONS.download} CSV</button>
      </div>
    </div>
    ${res.message ? `<div class="alert alert-warn">${esc(res.message)}</div>` : ''}
    <p class="muted">${esc(res.note || '')}</p>
    <div id="cands"></div>`;
  $('#back', el).onclick = onBack;
  $$('#f-orcid, #f-coi, #f-country', el).forEach(i => (i.onchange = draw));
  $('#x-docx', el).onclick = () => download('/api/reviewers/export', { data: res, format: 'docx' }).catch(e => toast(e.message, 'error'));
  $('#x-csv', el).onclick = () => download('/api/reviewers/export', { data: res, format: 'csv' }).catch(e => toast(e.message, 'error'));
  draw();
}

function card(c) {
  return `<div class="cand ${c.hasCoi ? 'coi' : ''}">
    <div class="row">
      <h3>${esc(c.name)}</h3>
      ${c.orcid ? `<a class="badge b-good" href="https://orcid.org/${esc(c.orcid)}" target="_blank" rel="noopener">ORCID ${esc(c.orcid)}</a>` : badge('No ORCID', 'neutral')}
      ${c.hasCoi ? badge('Conflict of interest', 'bad') : badge('No conflict found', 'good')}
      ${c.retractions.length ? badge(`${c.retractions.length} retraction(s)`, 'bad') : ''}
      <span class="spacer"></span>
      <a class="btn btn-sm btn-ghost" href="${esc(c.profileUrl)}" target="_blank" rel="noopener">Profile</a>
    </div>
    <div class="meta">${esc(c.institution || 'Institution unknown')}${c.country ? ` · ${esc(c.country)}` : ''}</div>
    <div class="stat-line"><span>h-index <b>${c.hIndex ?? '—'}</b></span><span>Works <b>${c.worksCount ?? '—'}</b></span><span>On this topic <b>${c.relevantCount}</b></span><span>Published this year <b>${c.workloadThisYear}</b></span><span>Last year <b>${c.workloadLastYear}</b></span></div>
    ${c.coi.map(x => `<div class="flag high" style="margin-top:8px"><div><div class="msg">${esc(x.message)}</div>${x.evidence ? `<div class="guide">${x.evidence.map(e => `${esc(e.title)} (${e.year})`).join(' · ')}</div>` : ''}</div></div>`).join('')}
    <ul>${c.relevantWorks.map(w => `<li>${w.doi ? `<a href="https://doi.org/${esc(w.doi)}" target="_blank" rel="noopener">${esc(w.title)}</a>` : esc(w.title)} <span class="muted">— ${esc(w.journal)} ${w.year} · ${esc(w.role)} author</span></li>`).join('')}</ul>
  </div>`;
}
