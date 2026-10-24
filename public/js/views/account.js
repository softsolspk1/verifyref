// views/account.js - profile, access, ORCID and password
import { api, esc, $, toast, state, badge } from '../core.js';

export function renderAccount(view) {
  const u = state.user;
  const labels = Object.fromEntries((state.app.modules || []).map(m => [m.key, m.label]));
  view.innerHTML = `
    <div class="page-head"><div><h1>Account</h1></div></div>
    ${u.mustChangePassword ? '<div class="alert alert-warn"><b>Please choose a new password.</b> Your account was created (or reset) by the Super Admin with a temporary password.</div>' : ''}
    <div class="grid grid-2">
      <div class="card"><h3>Profile</h3>
        <table class="t">
          <tr><td>Name</td><td>${esc(u.name)}</td></tr>
          <tr><td>E-mail</td><td>${esc(u.email)}</td></tr>
          <tr><td>Role</td><td>${esc(u.roleLabel)}${u.designation ? ` · ${esc(u.designation)}` : ''}</td></tr>
          <tr><td>Journal</td><td>${esc(u.journal || '—')}</td></tr>
          <tr><td>Access</td><td>${u.role === 'super_admin' || u.allowWeb ? badge('Web', 'good') : ''} ${u.role === 'super_admin' || u.allowDesktop ? badge('Desktop', 'good') : ''}</td></tr>
          <tr><td>Tools</td><td class="muted" style="font-size:12.5px">${u.permissions.map(k => esc(labels[k] || k)).join(' · ')}</td></tr>
        </table>
        <form id="orcid" class="row" style="margin-top:12px"><input name="orcid" type="text" placeholder="ORCID 0000-0000-0000-0000" value="${esc(u.orcid || '')}" style="flex:1"><button class="btn btn-sm">Save ORCID</button></form>
        <p class="muted" style="margin:6px 0 0">Your ORCID is used for citation alerts and to recognise your own work.</p>
      </div>
      <div class="card"><h3>Change password</h3>
        <form id="pw">
          <div class="field"><label for="pw-cur">Current password</label><input id="pw-cur" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="pw-new">New password</label><input id="pw-new" type="password" minlength="8" autocomplete="new-password" required></div>
          <div class="field"><label for="pw-new2">Repeat new password</label><input id="pw-new2" type="password" minlength="8" autocomplete="new-password" required></div>
          <button class="btn btn-primary" type="submit">Update password</button>
          ${state.app.desktop ? '<p class="muted" style="margin:10px 0 0">Changing the password needs an internet connection; the new password works on the web and on this computer.</p>' : ''}
        </form>
      </div>
    </div>`;
  $('#pw', view).onsubmit = async e => {
    e.preventDefault();
    if ($('#pw-new', view).value !== $('#pw-new2', view).value) return toast('The new passwords do not match.', 'error');
    try {
      await api('/api/auth/password', { body: { current: $('#pw-cur', view).value, next: $('#pw-new', view).value } });
      toast('Password updated');
      e.target.reset();
      if (u.mustChangePassword) { u.mustChangePassword = false; location.hash = ''; location.reload(); }
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#orcid', view).onsubmit = async e => {
    e.preventDefault();
    try { await api('/api/preferences', { body: { orcid: e.target.orcid.value.trim() } }); u.orcid = e.target.orcid.value.trim(); toast('Saved'); } catch (err) { toast(err.message, 'error'); }
  };
}
