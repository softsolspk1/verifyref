// views/desktop.js - desktop edition: connection, synchronisation with the web platform and the offline queue
import { api, esc, $, $$, badge, toast, fmtDate, runJob, state } from '../core.js';

const OFFLINE_FEATURES = [
  ['Reading documents (PDF, Word, ODT, RTF, text, BibTeX, RIS)', 'Full'],
  ['Citation Check (in-text ↔ reference list)', 'Full'],
  ['Retraction check (Retraction Watch copy)', 'Full'],
  ['Predatory / hijacked journal check, journal index lists', 'Full'],
  ['Reference Style and Manuscript Format converters', 'Full (DOI completion when online)'],
  ['Citation pattern, Editor report, letters, revision comparison, Issue report', 'Full'],
  ['Saved reports and all exports', 'Full'],
  ['Bibliography Check against the 13 databases', 'Cached references verified; others queued'],
  ['Verify Citations', 'With uploaded source PDFs; otherwise queued'],
  ['Find Evidence, Find a Journal, Conferences, Thesis Assistant', 'Queued until online'],
  ['Author search, Reviewer Finder, Check a Conference', 'Online only']
];

export async function renderDesktop(view) {
  if (!state.app.desktop) { view.innerHTML = '<div class="card empty">This page belongs to the Windows desktop application.</div>'; return; }
  const [s, { items }] = await Promise.all([api('/api/desktop/status'), api('/api/desktop/queue')]);
  view.innerHTML = `
    <div class="page-head"><div><h1>Sync &amp; offline queue</h1><p>The desktop application keeps its own database on this computer. It synchronises your account, the integrity datasets, journal lists, reports and notifications with the web platform, and works offline in between.</p></div>
      <div class="row"><button class="btn btn-primary" id="sync" ${s.online ? '' : 'disabled'}>Sync now</button></div></div>
    <div class="kpis">
      <div class="kpi ${s.online ? 'good' : 'warn'}"><div class="n" style="font-size:1.25rem">${s.online ? 'Online' : 'Offline'}</div><div class="l">Connection</div></div>
      <div class="kpi"><div class="n" style="font-size:1.05rem">${s.lastSync ? new Date(s.lastSync).toLocaleString() : 'Never'}</div><div class="l">Last synchronisation</div></div>
      <div class="kpi"><div class="n" style="font-size:1.05rem">${s.offlineUntil ? fmtDate(s.offlineUntil) : '—'}</div><div class="l">Offline use allowed until</div></div>
      <div class="kpi ${s.queue?.waiting ? 'info' : ''}"><div class="n">${s.queue?.waiting || 0}</div><div class="l">Waiting in the queue</div></div>
    </div>
    <div id="sync-progress"></div>
    <div class="grid grid-2">
      <div class="card"><h3>Offline queue</h3>
        <p class="muted" style="margin-top:0">Runs that need the internet are kept here while offline and start automatically when the connection returns.</p>
        ${items.length ? `<table class="t">${items.map(i => `<tr><td>${esc(i.label || i.kind)}<div class="muted" style="font-size:12px">${fmtDate(i.created_at)}${i.error ? ` · ${esc(i.error)}` : ''}</div></td>
          <td>${badge(i.status, { waiting: 'info', running: 'info', done: 'good', error: 'warn' }[i.status])}</td>
          <td class="row" style="flex-wrap:nowrap">${i.check_id ? `<a class="btn btn-sm" href="#/check/${i.check_id}">Open</a>` : ''}<button class="btn btn-sm btn-ghost btn-danger" data-del="${i.id}">✕</button></td></tr>`).join('')}</table>
          <div class="row" style="margin-top:10px"><button class="btn btn-sm" id="runq" ${s.online ? '' : 'disabled'}>Run queue now</button></div>` : '<p class="muted">The queue is empty.</p>'}
      </div>
      <div class="card"><h3>This computer</h3>
        <table class="t">
          <tr><td>Web platform</td><td>${esc(s.remoteUrl || 'not set')}</td></tr>
          <tr><td>Datasets synchronised</td><td>${s.datasetsSyncedAt ? new Date(s.datasetsSyncedAt).toLocaleString() : badge('not yet', 'warn')}</td></tr>
          <tr><td>Offline period</td><td>${s.offlineDays || '—'} days (set by the Super Admin)</td></tr>
          <tr><td>Local data folder</td><td style="word-break:break-all" class="muted">${esc(s.dataDir || '')}</td></tr>
          <tr><td>Version</td><td>${esc(s.version)}</td></tr>
        </table>
      </div>
    </div>
    <div class="card"><h3>What works offline</h3><table class="t">${OFFLINE_FEATURES.map(([f, a]) => `<tr><td>${esc(f)}</td><td>${badge(a, /^Full/.test(a) ? 'good' : /Online only/.test(a) ? 'neutral' : 'info')}</td></tr>`).join('')}</table></div>`;

  $('#sync', view).onclick = async () => {
    try {
      const { jobId } = await api('/api/desktop/sync', { body: { datasets: true } });
      const r = await runJob(jobId, $('#sync-progress', view), 'Synchronising with the web platform');
      toast(`Synchronised — ${r.pushed} report(s) uploaded, ${r.pulled} downloaded, ${r.notifications} notification(s)`);
      window.dispatchEvent(new Event('notifications-changed'));
      renderDesktop(view);
    } catch (e) { toast(e.message, 'error'); }
  };
  if ($('#runq', view)) $('#runq', view).onclick = async () => {
    try { const r = await api('/api/desktop/queue/run', { body: {} }); toast(r.skipped ? 'The queue is already running' : `${r.done} item(s) processed`); renderDesktop(view); } catch (e) { toast(e.message, 'error'); }
  };
  $$('[data-del]', view).forEach(b => (b.onclick = async () => { await api(`/api/desktop/queue/${b.dataset.del}`, { method: 'DELETE' }); renderDesktop(view); }));
}
