// views/account.js - profile and password
import { api, esc, $, toast, state } from '../core.js';

export function renderAccount(view) {
  const u = state.user;
  view.innerHTML = `
    <div class="page-head"><div><h1>Account</h1></div></div>
    <div class="grid grid-2">
      <div class="card"><h3>Profile</h3>
        <table class="t">
          <tr><td>Name</td><td>${esc(u.name)}</td></tr>
          <tr><td>Email</td><td>${esc(u.email)}</td></tr>
          <tr><td>Journal</td><td>${esc(u.journal || '—')}</td></tr>
          <tr><td>Role</td><td>${esc(u.editorRole || '—')}${u.role === 'admin' ? ' · administrator' : ''}</td></tr>
          <tr><td>ORCID</td><td>${esc(u.orcid || '—')}</td></tr>
        </table>
      </div>
      <div class="card"><h3>Change password</h3>
        <form id="pw">
          <div class="field"><label for="pw-cur">Current password</label><input id="pw-cur" type="password" autocomplete="current-password" required></div>
          <div class="field"><label for="pw-new">New password</label><input id="pw-new" type="password" minlength="8" autocomplete="new-password" required></div>
          <button class="btn btn-primary" type="submit">Update password</button>
        </form>
      </div>
    </div>`;
  $('#pw', view).onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/api/auth/password', { body: { current: $('#pw-cur', view).value, next: $('#pw-new', view).value } });
      toast('Password updated');
      e.target.reset();
    } catch (err) { toast(err.message, 'error'); }
  };
}
