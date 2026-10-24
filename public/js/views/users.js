// views/users.js - Super Admin: create and manage every user account, roles, module permissions,
// web / desktop access, password resets and desktop devices
import { api, esc, $, $$, toast, fmtDate, badge, modal, copyText, state, ICONS } from '../core.js';

let META = null;

export async function renderUsers(view) {
  if (state.app.desktop) {
    view.innerHTML = `<div class="page-head"><div><h1>Users</h1></div></div><div class="card"><p>User accounts are created and managed by the Super Admin on the web platform${state.app.remoteUrl ? ` (<a href="${esc(state.app.remoteUrl)}/app#/admin/users" target="_blank" rel="noopener">${esc(state.app.remoteUrl)}</a>)` : ''}. Changes reach this computer at the next synchronisation.</p></div>`;
    return;
  }
  META = META || await api('/api/admin/meta');
  const { users } = await api('/api/admin/users');
  view.innerHTML = `
    <div class="page-head"><div><h1>Users</h1><p>Only the Super Admin creates accounts — there is no public sign-up. Choose each user's role, the tools they may use and whether they can use the web platform, the desktop application or both.</p></div>
      <div class="row"><input id="q" type="text" placeholder="Search…" style="width:220px"><button class="btn btn-primary" id="new">+ Create user</button></div></div>
    <div class="table-wrap"><table class="t" id="tbl">
      <tr><th>User</th><th>Role</th><th>Access</th><th>Tools</th><th>Last sign-in</th><th class="num">Runs (30 d)</th><th>Status</th><th></th></tr>
      ${users.map(u => `<tr data-search="${esc(`${u.name} ${u.email} ${u.journal || ''}`.toLowerCase())}">
        <td><b>${esc(u.name)}</b><div class="muted">${esc(u.email)}</div>${u.designation || u.journal ? `<div class="muted" style="font-size:12px">${esc([u.designation, u.journal].filter(Boolean).join(' · '))}</div>` : ''}</td>
        <td>${badge(META.roles[u.role]?.label || u.role, u.role === 'super_admin' ? 'info' : 'neutral')}</td>
        <td>${u.role === 'super_admin' || u.allow_web ? badge('Web', 'good') : ''} ${u.role === 'super_admin' || u.allow_desktop ? badge(`Desktop · ${u.offline_days} d offline`, 'good') : ''}${u.devices ? `<div class="muted" style="font-size:12px">${u.devices} device(s)</div>` : ''}</td>
        <td class="muted" style="font-size:12.5px">${u.role === 'super_admin' ? 'All' : Array.isArray(u.permissions) ? `${u.permissions.filter(k => k[0] !== "_").length} of ${META.modules.length} (custom)` : 'Role default'}</td>
        <td>${u.last_login_at ? fmtDate(u.last_login_at) : '<span class="muted">never</span>'}${u.must_change_password ? `<div>${badge('must change password', 'warn')}</div>` : ''}</td>
        <td class="num">${u.runs_30d}</td>
        <td>${badge(u.status, u.status === 'active' ? 'good' : 'bad')}</td>
        <td class="row" style="flex-wrap:nowrap">
          <button class="btn btn-sm" data-edit="${u.id}">Edit</button>
          <button class="btn btn-sm btn-ghost" data-pw="${u.id}" title="Reset password">Reset password</button>
          ${u.devices ? `<button class="btn btn-sm btn-ghost" data-dev="${u.id}">Devices</button>` : ''}
          ${u.id === state.user.id ? '<span class="muted">you</span>' : `<button class="btn btn-sm btn-ghost" data-status="${u.id}" data-to="${u.status === 'active' ? 'suspended' : 'active'}">${u.status === 'active' ? 'Suspend' : 'Activate'}</button><button class="btn btn-sm btn-ghost btn-danger" data-del="${u.id}" title="Delete">✕</button>`}
        </td></tr>`).join('')}
    </table></div>`;
  const reload = () => renderUsers(view);
  $('#q', view).oninput = e => { const q = e.target.value.toLowerCase(); $$('#tbl tr[data-search]', view).forEach(tr => (tr.hidden = q && !tr.dataset.search.includes(q))); };
  $('#new', view).onclick = () => userForm(null, reload);
  $$('[data-edit]', view).forEach(b => (b.onclick = () => userForm(users.find(u => u.id === +b.dataset.edit), reload)));
  $$('[data-status]', view).forEach(b => (b.onclick = async () => {
    if (b.dataset.to === 'suspended' && !confirm('Suspend this user? They are signed out of the web and the desktop application.')) return;
    await api(`/api/admin/users/${b.dataset.status}`, { method: 'PATCH', body: { status: b.dataset.to } }).catch(e => toast(e.message, 'error'));
    reload();
  }));
  $$('[data-del]', view).forEach(b => (b.onclick = async () => {
    const u = users.find(x => x.id === +b.dataset.del);
    if (!confirm(`Delete ${u.name}? Their saved reports are deleted too. Suspending keeps the data.`)) return;
    await api(`/api/admin/users/${u.id}`, { method: 'DELETE' }).then(() => toast('User deleted')).catch(e => toast(e.message, 'error'));
    reload();
  }));
  $$('[data-pw]', view).forEach(b => (b.onclick = async () => {
    const u = users.find(x => x.id === +b.dataset.pw);
    if (!confirm(`Reset the password of ${u.name}? A new temporary password is generated and they must change it at sign-in.`)) return;
    try { const r = await api(`/api/admin/users/${u.id}/password`, { body: {} }); showPassword(u.email, r.password); reload(); } catch (e) { toast(e.message, 'error'); }
  }));
  $$('[data-dev]', view).forEach(b => (b.onclick = () => devices(users.find(x => x.id === +b.dataset.dev))));
}

function showPassword(email, pw) {
  modal(`<h2>Temporary password</h2><p>Give this password to <b>${esc(email)}</b>. It is shown only once; the user must change it at first sign-in.</p>
    <div class="row"><span class="pw-box">${esc(pw)}</span><button class="btn btn-sm" id="cp">${ICONS.copy} Copy</button></div>
    <div class="row" style="margin-top:16px"><button class="btn btn-primary" data-close>Done</button></div>`, { onMount: m => ($('#cp', m).onclick = () => copyText(pw)) });
}

function permGrid(selected) {
  const groups = [...new Set(META.modules.map(m => m.group))];
  return groups.map(g => `<div class="perm-group">${esc(g)}</div>${META.modules.filter(m => m.group === g).map(m => `<label class="check"><input type="checkbox" name="perm" value="${m.key}" ${selected.includes(m.key) ? 'checked' : ''}> ${esc(m.label)}${m.editor ? ' <span class="muted">(editor)</span>' : ''}</label>`).join('')}`).join('');
}

function userForm(u, done) {
  const isNew = !u;
  const role = u?.role || 'editor';
  const perms = Array.isArray(u?.permissions) ? u.permissions : META.defaults[role];
  modal(`
    <div class="card-head"><h2 style="margin:0">${isNew ? 'Create user' : `Edit ${esc(u.name)}`}</h2><button class="btn btn-sm btn-ghost" data-close>✕</button></div>
    <form id="uf">
      <div class="grid grid-2">
        <div class="field"><label>Full name</label><input name="fullname" type="text" required value="${esc(u?.name || '')}"></div>
        <div class="field"><label>E-mail (sign-in)</label><input name="email" type="email" required value="${esc(u?.email || '')}"></div>
        <div class="field"><label>Role</label><select name="role">${Object.entries(META.roles).map(([k, r]) => `<option value="${k}" ${k === role ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></div>
        <div class="field"><label>Designation</label><input name="designation" type="text" value="${esc(u?.designation || '')}" placeholder="e.g. Associate Editor"></div>
        <div class="field"><label>Journal / organisation</label><input name="journal" type="text" value="${esc(u?.journal || state.app.homeJournal.name)}"></div>
        <div class="field"><label>ORCID <span class="muted">(optional)</span></label><input name="orcid" type="text" value="${esc(u?.orcid || '')}" placeholder="0000-0000-0000-0000"></div>
      </div>
      <div class="card" style="padding:14px;margin-bottom:12px">
        <label>Access</label>
        <label class="check"><input type="checkbox" name="allowWeb" ${!u || u.allow_web ? 'checked' : ''}> Web platform</label>
        <label class="check"><input type="checkbox" name="allowDesktop" ${u?.allow_desktop ? 'checked' : ''}> Desktop application (Windows), including offline use</label>
        <div class="field" style="margin:8px 0 0;max-width:280px"><label>Offline use allowed for (days)</label><input name="offlineDays" type="number" min="1" max="90" value="${u?.offline_days || 14}"><div class="hint">After this many days without a connection the desktop asks the user to reconnect.</div></div>
      </div>
      <div class="card" style="padding:14px;margin-bottom:12px" id="perm-card">
        <div class="row" style="justify-content:space-between"><label style="margin:0">Tools this user may use</label><button type="button" class="btn btn-sm btn-ghost" id="defaults">Reset to role defaults</button></div>
        <div class="perm-grid" id="perms">${permGrid(perms)}</div>
      </div>
      ${isNew ? `<div class="field"><label>Password <span class="muted">(leave empty to generate one)</span></label><input name="password" type="text" autocomplete="off" minlength="8"></div>` : ''}
      <label class="check" style="margin-bottom:14px"><input type="checkbox" name="mustChangePassword" ${!u || u.must_change_password ? 'checked' : ''}> Must change the password at next sign-in</label>
      <div class="row"><button class="btn btn-primary" type="submit">${isNew ? 'Create user' : 'Save changes'}</button><button class="btn btn-ghost" type="button" data-close>Cancel</button></div>
    </form>`, {
    onMount: (m, close) => {
      const form = $('#uf', m);
      const roleSel = form.role;
      const syncRole = () => { $('#perm-card', m).hidden = roleSel.value === 'super_admin'; };
      roleSel.onchange = () => { $('#perms', m).innerHTML = permGrid(META.defaults[roleSel.value]); syncRole(); };
      $('#defaults', m).onclick = () => { $('#perms', m).innerHTML = permGrid(META.defaults[roleSel.value]); };
      syncRole();
      form.onsubmit = async e => {
        e.preventDefault();
        const f = form;
        const body = {
          name: f.fullname.value, email: f.email.value, role: f.role.value, designation: f.designation.value, journal: f.journal.value, orcid: f.orcid.value.trim(),
          allowWeb: f.allowWeb.checked, allowDesktop: f.allowDesktop.checked, offlineDays: +f.offlineDays.value, mustChangePassword: f.mustChangePassword.checked,
          permissions: $$('input[name=perm]:checked', m).map(x => x.value)
        };
        if (!body.allowWeb && !body.allowDesktop && body.role !== 'super_admin') return toast('Give the user web access, desktop access or both.', 'error');
        try {
          if (isNew) {
            if (f.password.value) body.password = f.password.value;
            const r = await api('/api/admin/users', { body });
            close();
            toast('User created');
            if (r.password) showPassword(body.email, r.password);
          } else {
            await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
            close();
            toast('Saved');
          }
          done();
        } catch (err) { toast(err.message, 'error'); }
      };
    }
  });
}

async function devices(u) {
  const { devices } = await api(`/api/admin/users/${u.id}/devices`);
  modal(`<div class="card-head"><h2 style="margin:0">Desktop devices — ${esc(u.name)}</h2><button class="btn btn-sm btn-ghost" data-close>✕</button></div>
    <table class="t"><tr><th>Computer</th><th>Version</th><th>Linked</th><th>Last seen</th><th></th></tr>
    ${devices.map(d => `<tr><td>${esc(d.name)}</td><td>${esc(d.app_version || '')}</td><td>${fmtDate(d.created_at)}</td><td>${d.last_seen ? fmtDate(d.last_seen) : '—'}</td><td>${d.revoked ? badge('revoked', 'neutral') : `<button class="btn btn-sm btn-danger" data-rev="${d.id}">Revoke</button>`}</td></tr>`).join('')}</table>
    <p class="muted">A revoked computer can no longer sync and the user is signed out of it at the next connection.</p>`, {
    onMount: (m, close) => $$('[data-rev]', m).forEach(b => (b.onclick = async () => { await api(`/api/admin/devices/${b.dataset.rev}/revoke`, { body: {} }); toast('Device revoked'); close(); devices(u); }))
  });
}
