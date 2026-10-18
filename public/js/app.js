// app.js - router and navigation for the editor workspace
import { api, state, $, esc, ICONS, toast, loadIssues } from './core.js';
import { renderCheckForm } from './views/check.js';
import { renderSavedReport } from './views/report.js';
import { renderJournalCheck } from './views/journal.js';
import { renderReviewers } from './views/reviewers.js';
import { renderReviewerReport } from './views/reviewerReport.js';
import { renderHistory } from './views/history.js';
import { renderIssues } from './views/issues.js';
import { renderAdmin } from './views/admin.js';
import { renderAccount } from './views/account.js';

const NAV = [
  { group: 'Check a manuscript' },
  { path: '/manuscript', label: 'Full manuscript check', icon: 'manuscript' },
  { path: '/references', label: 'Reference Check', icon: 'refs' },
  { path: '/citations', label: 'Citation Check', icon: 'cite' },
  { path: '/journal', label: 'Journal Check', icon: 'journal' },
  { group: 'Editor tools' },
  { path: '/reviewers', label: 'Reviewer Finder', icon: 'reviewers' },
  { path: '/reviewer-report', label: 'Reviewer report check', icon: 'report' },
  { path: '/history', label: 'Manuscripts & reports', icon: 'history' },
  { path: '/issues', label: 'Issue report', icon: 'issue' },
  { group: 'Administration', admin: true },
  { path: '/admin', label: 'Users & data', icon: 'admin', admin: true }
];

const ROUTES = [
  [/^\/manuscript$/, v => renderCheckForm(v, 'manuscript')],
  [/^\/references$/, v => renderCheckForm(v, 'references')],
  [/^\/citations$/, v => renderCheckForm(v, 'citations')],
  [/^\/journal$/, renderJournalCheck],
  [/^\/reviewers$/, renderReviewers],
  [/^\/reviewer-report$/, renderReviewerReport],
  [/^\/history$/, renderHistory],
  [/^\/issues$/, renderIssues],
  [/^\/check\/(\d+)$/, (v, m) => renderSavedReport(v, m[1])],
  [/^\/admin$/, v => (state.user.role === 'admin' ? renderAdmin(v) : (v.innerHTML = '<div class="empty">Administrator access required.</div>'))],
  [/^\/account$/, renderAccount]
];

function renderNav() {
  const isAdmin = state.user.role === 'admin';
  $('#nav').innerHTML = NAV.filter(n => !n.admin || isAdmin).map(n => n.group
    ? `<div class="nav-group">${esc(n.group)}</div>`
    : `<a href="#${n.path}" data-path="${n.path}">${ICONS[n.icon]}<span>${esc(n.label)}</span></a>`).join('');
}

async function route() {
  const path = location.hash.replace(/^#/, '') || '/manuscript';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', path.startsWith(a.dataset.path)));
  $('#sidebar').classList.remove('open');
  // A fresh container per navigation: late async renders from the previous page land in a detached node
  const root = $('#view');
  root.innerHTML = '';
  const view = document.createElement('div');
  root.appendChild(view);
  window.scrollTo(0, 0);
  for (const [re, fn] of ROUTES) {
    const m = path.match(re);
    if (m) {
      try { await fn(view, m); } catch (e) { view.innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`; }
      return;
    }
  }
  view.innerHTML = '<div class="empty">Page not found.</div>';
}

async function init() {
  const me = await api('/api/auth/me');
  if (!me.user || me.user.status !== 'approved') { location.href = '/'; return; }
  state.user = me.user;
  state.app = await api('/api/app');
  $('#who').textContent = me.user.name;
  $('#who-role').textContent = `${me.user.editorRole || me.user.role} · ${me.user.journal || ''}`;
  renderNav();
  await loadIssues().catch(() => {});
  $('#logout').onclick = async e => { e.preventDefault(); await api('/api/auth/logout', { body: {} }); location.href = '/'; };
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
  window.addEventListener('hashchange', route);
  route();
}

init().catch(e => toast(e.message, 'error'));
