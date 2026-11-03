// views/reports.js - Super Admin: every saved report run by every user (including other Super Admins)
import { api, esc, $, $$, badge, fmtDate } from '../core.js';
import { KIND_LABEL } from './activity.js';

const ROLE = { super_admin: 'Super Admin', editor: 'Editor', researcher: 'Researcher' };

function findings(c) {
  const out = [];
  if (c.suspicious) out.push(badge(`${c.suspicious} suspicious`, 'bad'));
  if (c.retracted) out.push(badge(`${c.retracted} retracted`, 'bad'));
  if (c.miscited) out.push(badge(`${c.miscited} miscited`, 'warn'));
  const notes = (c.problems || []).slice(0, 2).map(p => `<div class="muted">${esc(String(p).slice(0, 140))}</div>`).join('');
  return out.join(' ') + notes || '<span class="muted">—</span>';
}

const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

export async function renderReports(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Reports</h1><p>Every report run by every user, including other Super Admins. Open any report read-only.</p></div></div>
    <div class="card"><div class="row" style="flex-wrap:wrap;gap:10px">
      <input id="r-q" type="search" placeholder="Search title, manuscript ID, user…" style="flex:1;min-width:220px">
      <select id="r-user" style="width:auto"><option value="">All users</option></select>
      <select id="r-kind" style="width:auto"><option value="">All tools</option>${Object.entries(KIND_LABEL).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
      <select id="r-days" style="width:auto"><option value="0">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></select>
      <button class="btn btn-sm" id="r-csv">Export CSV</button>
    </div></div>
    <div id="r-body"><div class="progress">Loading…</div></div>`;
  let items = [];
  let loadedUsers = false;
  const load = async () => {
    const qs = new URLSearchParams({ days: $('#r-days', view).value, user: $('#r-user', view).value, kind: $('#r-kind', view).value, q: $('#r-q', view).value.trim() });
    const d = await api(`/api/reports?${qs}`);
    items = d.items;
    if (!loadedUsers) {
      $('#r-user', view).innerHTML += d.users.map(u => `<option value="${u.id}">${esc(u.name)} (${esc(ROLE[u.role] || u.role)})</option>`).join('');
      loadedUsers = true;
    }
    const users = new Set(items.map(i => i.user_id)).size;
    $('#r-body', view).innerHTML = items.length ? `
      <p class="muted">${items.length.toLocaleString()}${items.length >= 2000 ? '+' : ''} report(s) by ${users} user(s)${items.length >= 2000 ? ' — showing the newest 2,000; narrow the filters to see older ones' : ''}.</p>
      <div class="table-wrap"><table class="t">
        <tr><th>Date</th><th>User</th><th>Tool</th><th>Manuscript / title</th><th class="num">Refs</th><th>Findings</th><th></th></tr>
        ${items.map(c => `<tr>
          <td>${fmtDate(c.created_at)}<div class="muted">${new Date(c.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div></td>
          <td>${esc(c.user_name)}<div class="muted">${esc(c.user_email)}</div>${c.user_role === 'super_admin' ? badge('Super Admin', 'info') : ''}</td>
          <td>${esc(KIND_LABEL[c.kind] || c.kind)}${c.origin === 'desktop' ? `<div>${badge('Desktop', 'neutral')}</div>` : ''}</td>
          <td>${c.manuscript_code ? `<b>${esc(c.manuscript_code)}</b>${c.version > 1 ? ` <span class="muted">v${c.version}</span>` : ''}<br>` : ''}${esc((c.title || 'Untitled').slice(0, 110))}</td>
          <td class="num">${c.ref_total || ''}</td>
          <td>${findings(c)}</td>
          <td>${c.has_result ? `<a class="btn btn-sm" href="#/check/${c.id}">Open</a>` : '<span class="muted" title="Saved as counts only">counts only</span>'}</td>
        </tr>`).join('')}
      </table></div>` : '<div class="card empty">No reports match these filters.</div>';
  };
  const reload = () => load().catch(e => ($('#r-body', view).innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`));
  let timer;
  $('#r-q', view).oninput = () => { clearTimeout(timer); timer = setTimeout(reload, 350); };
  $$('#r-user, #r-kind, #r-days', view).forEach(s => (s.onchange = reload));
  $('#r-csv', view).onclick = () => {
    const head = ['ID', 'Date', 'User', 'Email', 'Role', 'Tool', 'Manuscript ID', 'Version', 'Title', 'References', 'Verified', 'Suspicious', 'Unverified', 'Miscited', 'Retracted', 'Findings'];
    const lines = [head.map(csvCell).join(','), ...items.map(c => [c.id, new Date(c.created_at).toISOString(), c.user_name, c.user_email, ROLE[c.user_role] || c.user_role, KIND_LABEL[c.kind] || c.kind,
      c.manuscript_code, c.version, c.title, c.ref_total, c.verified, c.suspicious, c.unverified, c.miscited, c.retracted, (c.problems || []).join(' | ')].map(csvCell).join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = `reports-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  await reload();
}
