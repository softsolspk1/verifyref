// app.js - router and navigation for the workspace (web and desktop)
import { api, state, $, esc, ICONS, toast, loadIssues, hasModule } from './core.js';
import { renderCheckForm } from './views/check.js';
import { renderSavedReport } from './views/report.js';
import { renderJournalCheck } from './views/journal.js';
import { renderReviewers } from './views/reviewers.js';
import { renderReviewerReport } from './views/reviewerReport.js';
import { renderIssues } from './views/issues.js';
import { renderAccount } from './views/account.js';
import { renderRestyle } from './views/restyle.js';
import { renderVerify } from './views/verify.js';
import { renderEvidence } from './views/evidence.js';
import { renderFormat } from './views/format.js';
import { renderJournalFinder } from './views/journalFinder.js';
import { renderConferences } from './views/conferences.js';
import { renderAssistant } from './views/assistant.js';
import { renderAuthors } from './views/authors.js';
import { renderActivity } from './views/activity.js';
import { renderAlerts } from './views/alerts.js';
import { renderUsers } from './views/users.js';
import { renderAdmin, renderAudit } from './views/admin.js';
import { renderDesktop } from './views/desktop.js';
import { renderHome } from './views/home.js';
import { renderCitations } from './views/citations.js';
import { renderPaperMill } from './views/papermill.js';
import { renderImages } from './views/images.js';

// PJPS v4: the five modules and the Full Screening Report. The earlier tools stay in the code (routes below) but are
// switched off in src/modules.js, so they are not shown and their routes refuse access.
const NAV = [
  { path: '/home', label: 'Home', icon: 'home' },
  { group: 'PJPS modules' },
  { path: '/manuscript', label: 'Full Screening Report', icon: 'manuscript', module: 'manuscript' },
  { path: '/references', label: '1 · Check Bibliography', icon: 'refs', module: 'references' },
  { path: '/restyle', label: '2 · Reference Style & PJPS', icon: 'style', module: 'restyle' },
  { path: '/citations', label: '3 · Citations', icon: 'cite', module: 'citations' },
  { path: '/papermill', label: '4 · Paper Mill Detection', icon: 'papermill', module: 'papermill' },
  { path: '/images', label: '5 · Image Integrity', icon: 'image', module: 'images' },
  { group: 'Earlier tools' },
  { path: '/verify', label: 'Verify Citations', icon: 'verify', module: 'verify', hidden: true },
  { path: '/evidence', label: 'Find Evidence', icon: 'evidence', module: 'evidence' },
  { path: '/format', label: 'Manuscript Format', icon: 'format', module: 'format' },
  { path: '/journal-finder', label: 'Find a Journal', icon: 'finder', module: 'journal-finder' },
  { path: '/journal', label: 'Check a Journal', icon: 'journal', module: 'journal-check' },
  { path: '/conferences', label: 'Find & Check a Conference', icon: 'conference', module: 'conferences' },
  { path: '/assistant', label: 'Thesis / Paper Assistant', icon: 'assistant', module: 'assistant' },
  { path: '/authors', label: 'Find by Author', icon: 'author', module: 'authors' },
  { path: '/reviewers', label: 'Reviewer Finder', icon: 'reviewers', module: 'reviewers' },
  { path: '/reviewer-report', label: 'Reviewer report check', icon: 'report', module: 'reviewer-report' },
  { path: '/issues', label: 'Issue report', icon: 'issue', module: 'issues' },
  { group: 'My Activity' },
  { path: '/activity', label: 'Saved reports', icon: 'activity' },
  { path: '/alerts', label: 'Alerts & notifications', icon: 'bell', badge: 'unread' },
  { path: '/desktop', label: 'Sync & offline queue', icon: 'sync', desktop: true },
  { group: 'Administration', admin: true },
  { path: '/admin/users', label: 'Users', icon: 'users', admin: true },
  { path: '/admin/data', label: 'Datasets & journal lists', icon: 'data', admin: true },
  { path: '/admin/audit', label: 'Audit log & usage', icon: 'audit', admin: true }
];

const guard = (module, fn) => (v, m) => (hasModule(module) ? fn(v, m) : (v.innerHTML = '<div class="card empty">Your account does not have access to this tool. Ask the Super Admin to enable it.</div>'));
const adminOnly = fn => (v, m) => (state.user.role === 'super_admin' ? fn(v, m) : (v.innerHTML = '<div class="card empty">Super Admin access required.</div>'));

const ROUTES = [
  [/^\/manuscript$/, guard('manuscript', v => renderCheckForm(v, 'manuscript'))],
  [/^\/references$/, guard('references', v => renderCheckForm(v, 'references'))],
  [/^\/home$/, renderHome],
  [/^\/citations$/, guard('citations', renderCitations)],
  [/^\/papermill$/, guard('papermill', renderPaperMill)],
  [/^\/images$/, guard('images', renderImages)],
  [/^\/restyle$/, guard('restyle', renderRestyle)],
  [/^\/verify$/, guard('verify', renderVerify)],
  [/^\/evidence$/, guard('evidence', renderEvidence)],
  [/^\/format$/, guard('format', renderFormat)],
  [/^\/journal-finder$/, guard('journal-finder', renderJournalFinder)],
  [/^\/journal$/, guard('journal-check', renderJournalCheck)],
  [/^\/conferences$/, guard('conferences', renderConferences)],
  [/^\/assistant$/, guard('assistant', renderAssistant)],
  [/^\/authors$/, guard('authors', renderAuthors)],
  [/^\/reviewers$/, guard('reviewers', renderReviewers)],
  [/^\/reviewer-report$/, guard('reviewer-report', renderReviewerReport)],
  [/^\/issues$/, guard('issues', renderIssues)],
  [/^\/(activity|history)$/, renderActivity],
  [/^\/alerts$/, renderAlerts],
  [/^\/check\/(\d+)$/, (v, m) => renderSavedReport(v, m[1])],
  [/^\/desktop$/, renderDesktop],
  [/^\/admin\/users$/, adminOnly(renderUsers)],
  [/^\/admin\/data$/, adminOnly(renderAdmin)],
  [/^\/admin\/audit$/, adminOnly(renderAudit)],
  [/^\/admin$/, adminOnly(renderUsers)],
  [/^\/account$/, renderAccount]
];

function firstAllowedPath() {
  return '/home';
}

function renderNav() {
  const isAdmin = state.user.role === 'super_admin';
  const items = NAV.filter(n => !n.hidden && (!n.admin || isAdmin) && (!n.desktop || state.app.desktop) && (!n.module || hasModule(n.module)));
  // Drop group headings with no visible items
  const visible = items.filter((n, i) => !n.group || (items[i + 1] && !items[i + 1].group));
  $('#nav').innerHTML = visible.map(n => n.group
    ? `<div class="nav-group">${esc(n.group)}</div>`
    : `<a href="#${n.path}" data-path="${n.path}">${ICONS[n.icon]}<span>${esc(n.label)}</span>${n.badge ? '<span class="nav-badge" id="unread" hidden></span>' : ''}</a>`).join('');
}

async function refreshUnread() {
  try {
    const d = await api('/api/notifications');
    const el = $('#unread');
    if (el) { el.hidden = !d.unread; el.textContent = d.unread > 99 ? '99+' : d.unread; }
  } catch (e) { /* ignore */ }
}

async function refreshConnection() {
  if (!state.app.desktop) return;
  try {
    const s = await api('/api/desktop/status');
    state.online = s.online;
    const el = $('#conn');
    el.hidden = false;
    el.className = `conn ${s.online ? 'on' : 'off'}`;
    el.innerHTML = `<span class="dot"></span>${s.online ? 'Online' : 'Offline'}${s.queue?.waiting ? ` · ${s.queue.waiting} queued` : ''}${s.lastSync ? `<span class="muted"> · synced ${new Date(s.lastSync).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>` : ''}`;
  } catch (e) { /* ignore */ }
}

async function route() {
  let path = location.hash.replace(/^#/, '') || firstAllowedPath();
  if (state.user.mustChangePassword && path !== '/account') { location.hash = '#/account'; return; }
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', path === a.dataset.path || path.startsWith(a.dataset.path + '/')));
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
  if (!me.user) { location.href = '/'; return; }
  state.user = me.user;
  state.app = await api('/api/app');
  $('#who').textContent = me.user.name;
  $('#who-role').textContent = `${me.user.roleLabel}${me.user.journal ? ' · ' + me.user.journal : ''}`;
  if (state.app.desktop) document.body.classList.add('is-desktop');
  renderNav();
  await loadIssues().catch(() => {});
  $('#logout').onclick = async e => { e.preventDefault(); await api('/api/auth/logout', { body: {} }); location.href = '/'; };
  $('#menu-btn').onclick = () => $('#sidebar').classList.toggle('open');
  window.addEventListener('hashchange', route);
  window.addEventListener('notifications-changed', refreshUnread);
  route();
  refreshUnread();
  refreshConnection();
  setInterval(refreshUnread, 60000);
  if (state.app.desktop) setInterval(refreshConnection, 15000);
}

init().catch(e => toast(e.message, 'error'));
