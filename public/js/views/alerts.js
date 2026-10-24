// views/alerts.js - notifications and alerts: citation alerts (ORCID), topic, author and conference follows
import { api, esc, $, $$, toast, fmtDate, badge, hasModule, state } from '../core.js';

const KIND = { retraction: ['Retraction', 'bad'], citations: ['Citation', 'info'], topic: ['Topic', 'info'], author: ['Author', 'info'], conference: ['Conference', 'info'], queue: ['Offline queue', 'good'], system: ['System', 'neutral'] };
const FOLLOW = { citations: 'Citations of my work', topic: 'Topic', author: 'Author', conference: 'Conference' };

export async function renderAlerts(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Alerts &amp; notifications</h1><p>Retraction notices for references in your saved checks, new citations of your work, and weekly updates on followed topics, authors and conferences.</p></div></div>
    <div class="grid" style="grid-template-columns:minmax(0,3fr) minmax(0,2fr);align-items:start">
      <div class="card" style="padding:0"><div class="card-head" style="padding:14px 16px 0"><h3>Notifications</h3><button class="btn btn-sm" id="readall">Mark all read</button></div><div id="notifs"><div class="empty">Loading…</div></div></div>
      <div id="follows"></div>
    </div>`;
  loadNotifications(view);
  if (hasModule('alerts')) loadFollows(view); else $('#follows', view).innerHTML = '<div class="card muted">Alerts are not enabled for your account.</div>';
  $('#readall', view).onclick = async () => { await api('/api/notifications/read', { body: {} }); window.dispatchEvent(new Event('notifications-changed')); loadNotifications(view); };
}

async function loadNotifications(view) {
  const { notifications } = await api('/api/notifications');
  const el = $('#notifs', view);
  el.innerHTML = notifications.length ? notifications.map(n => `
    <div class="notif ${n.read ? '' : 'unread'}">
      <div style="flex:1"><div class="row">${badge((KIND[n.kind] || [n.kind])[0], (KIND[n.kind] || [0, 'neutral'])[1])}<b>${esc(n.title)}</b></div>
        ${n.body ? `<div class="body">${esc(n.body)}</div>` : ''}
        <div class="muted" style="font-size:12px;margin-top:4px">${fmtDate(n.created_at)}${n.emailed ? ' · e-mailed' : ''}${n.link ? ` · <a href="${esc(n.link)}" data-open="${n.id}">open</a>` : ''}</div></div>
      <div class="row" style="flex:none;align-items:flex-start">${n.read ? '' : `<button class="btn btn-sm btn-ghost" data-read="${n.id}" title="Mark read">✓</button>`}<button class="btn btn-sm btn-ghost btn-danger" data-del="${n.id}" title="Delete">✕</button></div>
    </div>`).join('') : '<div class="empty">No notifications yet.</div>';
  const changed = () => { window.dispatchEvent(new Event('notifications-changed')); loadNotifications(view); };
  $$('[data-read]', el).forEach(b => (b.onclick = () => api('/api/notifications/read', { body: { id: +b.dataset.read } }).then(changed)));
  $$('[data-open]', el).forEach(a => a.addEventListener('click', () => api('/api/notifications/read', { body: { id: +a.dataset.open } }).then(() => window.dispatchEvent(new Event('notifications-changed')))));
  $$('[data-del]', el).forEach(b => (b.onclick = () => api(`/api/notifications/${b.dataset.del}`, { method: 'DELETE' }).then(changed)));
}

async function loadFollows(view) {
  const el = $('#follows', view);
  let follows = [];
  try { follows = (await api('/api/follows')).follows; } catch (e) { el.innerHTML = `<div class="alert alert-warn">${esc(e.message)}</div>`; return; }
  const group = k => follows.filter(f => f.kind === k);
  const orcid = group('citations')[0];
  el.innerHTML = `
    <div class="card"><h3>Citation alerts</h3>
      <p class="muted" style="margin-top:0">E-mail and in-app notice when your works are cited, with the citing journal's quartile, predatory-list matches and self-citation flags.</p>
      ${orcid ? `<div class="row">${badge(`ORCID ${orcid.key}`, 'good')}<span class="muted">checked ${orcid.last_checked ? fmtDate(orcid.last_checked) : 'soon'}</span><button class="btn btn-sm btn-ghost btn-danger" data-unf="${orcid.id}">Stop</button></div>`
        : `<form id="orcid" class="row"><input name="key" type="text" placeholder="0000-0000-0000-0000" value="${esc(state.user.orcid || '')}" style="flex:1"><button class="btn btn-sm btn-primary">Start</button></form>`}
    </div>
    <div class="card"><h3>Topic alerts</h3><p class="muted" style="margin-top:0">Weekly digest of new papers (up to 10 topics).</p>
      <form id="topic" class="row" style="margin-bottom:10px"><input name="key" type="text" placeholder="e.g. nanoparticle drug delivery" style="flex:1"><button class="btn btn-sm btn-primary">Follow</button></form>
      ${list(group('topic'))}</div>
    <div class="card"><h3>Followed authors</h3>${list(group('author'))}<p class="muted" style="margin:6px 0 0">Follow authors from <a href="#/authors">Find by Author</a>.</p></div>
    <div class="card"><h3>Followed conferences</h3>${list(group('conference'))}<p class="muted" style="margin:6px 0 0">Follow conferences from <a href="#/conferences">Find &amp; Check a Conference</a>.</p></div>
    ${state.app.desktop ? '' : `<div class="card"><label class="check"><input type="checkbox" id="email" ${state.user.emailAlerts ? 'checked' : ''}> Also send alerts by e-mail</label></div>`}`;
  const reload = () => loadFollows(view);
  const add = (kind, key, label) => api('/api/follows', { body: { kind, key, label } }).then(() => { toast('Alert added'); reload(); }).catch(e => toast(e.message, 'error'));
  if ($('#orcid', el)) $('#orcid', el).onsubmit = e => { e.preventDefault(); const k = e.target.key.value.trim(); add('citations', k, `ORCID ${k}`); };
  $('#topic', el).onsubmit = e => { e.preventDefault(); const k = e.target.key.value.trim(); if (k) add('topic', k, k); };
  $$('[data-unf]', el).forEach(b => (b.onclick = () => api(`/api/follows/${b.dataset.unf}`, { method: 'DELETE' }).then(reload)));
  if ($('#email', el)) $('#email', el).onchange = e => api('/api/preferences', { body: { emailAlerts: e.target.checked } }).then(() => toast('Saved'));
}

function list(items) {
  return items.length ? `<table class="t">${items.map(f => `<tr><td>${esc(f.label)}<div class="muted" style="font-size:12px">${FOLLOW[f.kind]} · ${f.last_checked ? `checked ${fmtDate(f.last_checked)}` : 'first check pending'}</div></td><td class="num"><button class="btn btn-sm btn-ghost btn-danger" data-unf="${f.id}">✕</button></td></tr>`).join('')}</table>` : '<p class="muted" style="margin:0">None yet.</p>';
}
