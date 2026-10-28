// views/monitoring.js - Published Article Monitoring: the journal's published articles watched for retractions,
// expressions of concern, corrections and references to papers retracted since, with archive rescreening.
import { api, esc, $, $$, toast, runJob, badge, fmtDate, hasModule } from '../core.js';

const STATUS = { retracted: ['Retracted', 'bad'], concern: ['Expression of concern', 'bad'], corrected: ['Corrected', 'warn'], 'cites-retracted': ['Cites retracted work', 'warn'], ok: ['No notice', 'good'] };

export async function renderMonitoring(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Published Article Monitoring</h1>
      <p>Watches PJPS's published articles after publication: retractions, expressions of concern, corrections and withdrawals (Crossref notices and Retraction Watch), and references to papers that have been retracted since publication. Checked weekly by the daily schedule; editors who add articles and the Super Admins are notified of anything new.</p></div></div>
    <div class="kpis" id="kpis"></div>
    <div class="grid grid-2">
      <div class="card"><h3>Add articles by DOI</h3>
        <div class="field"><textarea id="dois" rows="4" placeholder="10.36721/PJPS.2024.37.1.REG.001.1&#10;one DOI per line"></textarea></div>
        <div class="field"><input id="code" type="text" placeholder="Manuscript ID (optional, for a single DOI)"></div>
        <button class="btn btn-primary btn-sm" id="add">Add to monitoring</button></div>
      <div class="card"><h3>Import from Crossref</h3>
        <div class="grid grid-2"><div class="field"><label for="issn">Journal ISSN</label><input id="issn" type="text"></div>
        <div class="field"><label for="from">Published since</label><input id="from" type="number" min="1950" max="2100"></div></div>
        <div class="row"><button class="btn btn-sm" id="import">Import articles</button><button class="btn btn-sm" id="check">Check all now</button><button class="btn btn-sm" id="rescreen" title="Every monitored article plus the references of every saved screening report">Rescreen the archive</button></div>
        <div id="job" style="margin-top:10px"></div></div>
    </div>
    <div class="card">
      <div class="filters row" style="margin-bottom:12px"><input id="q" type="search" placeholder="Search title, DOI or author" style="max-width:320px">
        <select id="st" style="max-width:240px"><option value="">All statuses</option>${Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join('')}</select><span class="spacer"></span><span class="muted" id="last"></span></div>
      <div id="list" class="muted">Loading…</div>
    </div>`;

  const load = async () => {
    const qs = new URLSearchParams({ q: $('#q', view).value, status: $('#st', view).value });
    const d = await api(`/api/monitoring?${qs}`);
    if (!$('#issn', view).value) $('#issn', view).value = d.issn?.[0] || '';
    if (!$('#from', view).value) $('#from', view).value = new Date().getFullYear() - 5;
    const n = Object.fromEntries(d.counts.map(c => [c.status, c.n]));
    const total = d.counts.reduce((a, c) => a + c.n, 0);
    $('#kpis', view).innerHTML = `<div class="kpi"><div class="n">${total}</div><div class="l">Articles monitored</div></div>${['retracted', 'concern', 'corrected', 'cites-retracted'].map(k => `<div class="kpi ${STATUS[k][1]} clickable" data-st="${k}"><div class="n">${n[k] || 0}</div><div class="l">${STATUS[k][0]}</div></div>`).join('')}`;
    $$('[data-st]', view).forEach(k => { k.onclick = () => { $('#st', view).value = k.dataset.st; load(); }; });
    $('#last', view).textContent = d.lastChecked ? `Last check ${fmtDate(d.lastChecked)}` : 'Not checked yet';
    $('#list', view).innerHTML = d.items.length ? `<div class="table-wrap"><table class="t"><tr><th>Article</th><th>Year</th><th>Status</th><th>Notices</th><th>Checked</th><th></th></tr>${d.items.map(a => `<tr>
      <td><a href="https://doi.org/${esc(a.doi)}" target="_blank" rel="noopener">${esc(a.title || a.doi)}</a><div class="muted">${esc(a.doi)}${a.manuscript_code ? ` · ${esc(a.manuscript_code)}` : ''}</div></td>
      <td>${a.year || ''}</td><td>${badge(...(STATUS[a.status] || [a.status, 'neutral']))}</td>
      <td>${(a.events || []).map(e => `<div>${esc(e.type.replace(/_/g, ' '))} <span class="muted">(${esc(e.source)}${e.date ? ', ' + esc(e.date) : ''})</span>${e.notice ? ` <a href="https://doi.org/${esc(e.notice)}" target="_blank" rel="noopener">notice</a>` : ''}</div>`).join('')}
        ${(a.cited_retracted || []).length ? `<details><summary class="muted">${a.cited_retracted.length} cited paper(s) retracted</summary><ul class="evidence">${a.cited_retracted.map(c => `<li><a href="https://doi.org/${esc(c.doi)}" target="_blank" rel="noopener">${esc(c.title || c.doi)}</a> <span class="muted">${esc(c.date || '')}</span>${c.reason ? `<div class="muted">${esc(c.reason)}</div>` : ''}</li>`).join('')}</ul></details>` : ''}</td>
      <td class="muted">${a.last_checked ? fmtDate(a.last_checked) : 'pending'}</td>
      <td class="no-print"><button class="btn btn-sm btn-ghost" data-one="${a.id}">Check</button>${hasModule('cases') && a.status !== 'ok' ? `<button class="btn btn-sm btn-ghost" data-case="${a.id}">Open case</button>` : ''}<button class="btn btn-sm btn-ghost" data-del="${a.id}">Remove</button></td></tr>`).join('')}</table></div>` : '<p>No articles yet. Add DOIs or import the journal from Crossref.</p>';
    $$('[data-one]', view).forEach(b => { b.onclick = () => job({ ids: [+b.dataset.one] }, 'Checking the article'); });
    $$('[data-del]', view).forEach(b => { b.onclick = async () => { await api(`/api/monitoring/articles/${b.dataset.del}`, { method: 'DELETE' }); load(); }; });
    $$('[data-case]', view).forEach(b => { b.onclick = async () => {
      const a = d.items.find(x => x.id === +b.dataset.case);
      try { const r = await api('/api/cases', { body: { title: `Post-publication: ${a.title || a.doi}`, manuscriptCode: a.manuscript_code || a.doi, category: 'post-publication', priority: a.status === 'retracted' || a.status === 'concern' ? 'high' : 'normal', note: `${STATUS[a.status]?.[0] || a.status} — https://doi.org/${a.doi}` } }); location.hash = `#/cases/${r.case.id}`; } catch (e) { toast(e.message, 'error'); }
    }; });
  };
  const job = async (body, title, url = '/api/monitoring/check') => {
    try {
      const { jobId } = await api(url, { body });
      const r = await runJob(jobId, $('#job', view), title);
      toast(r.added !== undefined ? `${r.added} article(s) imported` : r.articles ? `${r.articles.checked} articles rescreened, ${r.articles.events} new notice(s), ${r.reportNotices} report notice(s)` : `${r.checked} checked, ${r.events} new notice(s), ${r.citedRetracted} newly retracted reference(s)`);
      load();
    } catch (e) { toast(e.message, 'error'); }
  };
  $('#add', view).onclick = async () => {
    try { const r = await api('/api/monitoring/articles', { body: { dois: $('#dois', view).value, manuscriptCode: $('#code', view).value } }); toast(`${r.added} added${r.skipped ? `, ${r.skipped} already monitored` : ''}${r.invalid.length ? `, ${r.invalid.length} not a DOI` : ''}`); $('#dois', view).value = ''; load(); } catch (e) { toast(e.message, 'error'); }
  };
  $('#import', view).onclick = () => job({ issn: $('#issn', view).value, fromYear: $('#from', view).value }, 'Importing from Crossref', '/api/monitoring/import');
  $('#check', view).onclick = () => job({}, 'Checking every article');
  $('#rescreen', view).onclick = () => job({ rescreen: true }, 'Rescreening the archive');
  let t;
  $('#q', view).oninput = () => { clearTimeout(t); t = setTimeout(load, 300); };
  $('#st', view).onchange = load;
  await load();
}
