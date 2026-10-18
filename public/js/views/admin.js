// views/admin.js - editor approvals, datasets, journal list uploads
import { api, esc, $, $$, badge, toast, fmtDate, runJob, state } from '../core.js';

export async function renderAdmin(view) {
  const [{ users }, ds] = await Promise.all([api('/api/admin/users'), api('/api/admin/datasets')]);
  const pending = users.filter(u => u.status === 'pending');
  view.innerHTML = `
    <div class="page-head"><div><h1>Users &amp; data</h1><p>Approve editor access requests, keep the integrity datasets current and upload the journal index lists used by Journal Check.</p></div></div>

    <div class="card">
      <div class="card-head"><h2>Editor accounts</h2>${pending.length ? badge(`${pending.length} awaiting approval`, 'warn') : ''}</div>
      <div class="table-wrap"><table class="t">
        <tr><th>Name</th><th>Journal &amp; role</th><th>Co-editors</th><th>Requested</th><th>Status</th><th></th></tr>
        ${users.map(u => `<tr>
          <td><b>${esc(u.name)}</b><div class="muted">${esc(u.email)}</div>${u.orcid ? `<div class="muted">ORCID ${esc(u.orcid)}</div>` : ''}${u.note ? `<div class="muted">“${esc(u.note)}”</div>` : ''}</td>
          <td>${esc(u.journal || '')}<div class="muted">${esc(u.editor_role || '')}</div></td>
          <td class="muted" style="font-size:12.5px">${esc(u.co_editors || '—')}</td>
          <td>${fmtDate(u.created_at)}</td>
          <td>${badge(u.status, { approved: 'good', pending: 'warn', rejected: 'bad', disabled: 'neutral' }[u.status])} ${u.role === 'admin' ? badge('admin', 'info') : ''}</td>
          <td class="row" style="flex-wrap:nowrap">${u.id === state.user.id ? '<span class="muted">you</span>' : `
            ${u.status !== 'approved' ? `<button class="btn btn-sm btn-primary" data-u="${u.id}" data-status="approved">Approve</button>` : ''}
            ${u.status === 'pending' ? `<button class="btn btn-sm" data-u="${u.id}" data-status="rejected">Reject</button>` : ''}
            ${u.status === 'approved' ? `<button class="btn btn-sm" data-u="${u.id}" data-status="disabled">Disable</button>` : ''}
            ${u.status === 'approved' ? `<button class="btn btn-sm btn-ghost" data-u="${u.id}" data-role="${u.role === 'admin' ? 'editor' : 'admin'}">${u.role === 'admin' ? 'Remove admin' : 'Make admin'}</button>` : ''}`}
          </td></tr>`).join('')}
      </table></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Integrity datasets</h2><button class="btn btn-sm" id="refresh">Refresh now</button></div>
      <table class="t">
        <tr><td><b>Retraction Watch</b><div class="muted">Retractions, expressions of concern and corrections (via Crossref)</div></td><td class="num">${ds.retractionWatch.count.toLocaleString()} records</td><td>${ds.retractionWatch.loadedAt ? fmtDate(ds.retractionWatch.loadedAt) : badge('not loaded', 'warn')}</td></tr>
        <tr><td><b>Beall's list</b><div class="muted">Potential predatory publishers, standalone journals and hijacked journals</div></td><td class="num">${ds.beall.count.toLocaleString()} entries</td><td>${ds.beall.loadedAt ? fmtDate(ds.beall.loadedAt) : badge('not loaded', 'warn')}</td></tr>
      </table>
      <p class="muted" style="margin:10px 0 0">Both refresh automatically every 7 days.</p>
      <div id="refresh-progress"></div>
    </div>

    <div class="card">
      <h2>Journal index lists</h2>
      <p class="muted">Scopus, Web of Science, JCR and HEC HJRS lists are licensed or behind logins, so upload the current CSV files your journal has access to. Columns are detected automatically (title, ISSN, eISSN, quartile, category). Excel files: save as <b>CSV UTF-8</b> first.</p>
      <ul class="muted" style="font-size:13px">
        <li><b>SJR</b>: scimagojr.com → Journal Rankings → Download data (gives Scopus quartiles).</li>
        <li><b>Scopus source list</b>: Elsevier “Scopus Sources” page → download the source list workbook → save as CSV.</li>
        <li><b>Web of Science</b>: Master Journal List (mjl.clarivate.com) → each collection → Download (SCIE, SSCI, AHCI, ESCI separately).</li>
        <li><b>JCR</b>: Journal Citation Reports export (needs a JCR subscription).</li>
        <li><b>HEC HJRS</b>: hjrs.hec.gov.pk → journal list export (Category W/X/Y).</li>
      </ul>
      <div class="table-wrap"><table class="t">
        <tr><th>List</th><th class="num">Rows</th><th>Uploaded</th><th></th></tr>
        ${ds.lists.map(l => `<tr>
          <td>${esc(l.label)}${l.filename ? `<div class="muted">${esc(l.filename)}</div>` : ''}</td>
          <td class="num">${l.row_count ? Number(l.row_count).toLocaleString() : '—'}</td>
          <td>${l.uploaded_at ? fmtDate(l.uploaded_at) : badge('not uploaded', 'neutral')}</td>
          <td class="row" style="flex-wrap:nowrap"><label class="btn btn-sm" style="margin:0">Upload CSV<input type="file" accept=".csv,.txt" hidden data-list="${l.type}"></label>${l.row_count ? `<button class="btn btn-sm btn-ghost btn-danger" data-rm="${l.type}">✕</button>` : ''}</td>
        </tr>`).join('')}
      </table></div>
    </div>`;

  $$('[data-u]', view).forEach(b => (b.onclick = async () => {
    await api(`/api/admin/users/${b.dataset.u}`, { body: b.dataset.status ? { status: b.dataset.status } : { role: b.dataset.role } }).catch(e => toast(e.message, 'error'));
    renderAdmin(view);
  }));
  $('#refresh', view).onclick = async () => {
    try {
      const { jobId } = await api('/api/admin/datasets/refresh', { body: {} });
      await runJob(jobId, $('#refresh-progress', view), 'Refreshing datasets (this takes a few minutes)');
      toast('Datasets refreshed');
      renderAdmin(view);
    } catch (e) { toast(e.message, 'error'); }
  };
  $$('[data-list]', view).forEach(inp => (inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    toast(`Uploading ${f.name}…`);
    try {
      const d = await api(`/api/admin/lists/${inp.dataset.list}`, { form: fd });
      toast(`${d.rows.toLocaleString()} journals imported`);
      renderAdmin(view);
    } catch (e) { toast(e.message, 'error'); }
  }));
  $$('[data-rm]', view).forEach(b => (b.onclick = async () => {
    if (!confirm('Remove this list?')) return;
    await api(`/api/admin/lists/${b.dataset.rm}`, { method: 'DELETE' });
    renderAdmin(view);
  }));
}
