// views/admin.js - Super Admin: integrity datasets, journal index lists, alert run; audit log and usage statistics
import { api, esc, $, $$, badge, toast, fmtDate, runJob, modal, state } from '../core.js';

export async function renderAdmin(view) {
  const ds = await api('/api/admin/datasets');
  const desk = state.app.desktop;
  view.innerHTML = `
    <div class="page-head"><div><h1>Datasets, journal lists &amp; PJPS rules</h1><p>Integrity datasets used by every check, and the licensed journal index lists used by Journal Check and Find a Journal.${desk ? ' On the desktop these are copies synchronised from the web platform, which is what makes the offline checks possible.' : ' Desktop computers download copies of all of these at synchronisation for offline use.'}</p></div></div>

    <div class="card">
      <div class="card-head"><h2>Integrity datasets</h2><div class="row"><button class="btn btn-sm" id="refresh">${desk ? 'Download from source now' : 'Refresh now'}</button>${desk ? '' : '<button class="btn btn-sm" id="alerts">Run alerts now</button>'}</div></div>
      <table class="t">
        <tr><td><b>Retraction Watch</b><div class="muted">Retractions, expressions of concern and corrections (via Crossref)</div></td><td class="num">${ds.retractionWatch.count.toLocaleString()} records</td><td>${ds.retractionWatch.loadedAt ? fmtDate(ds.retractionWatch.loadedAt) : badge('not loaded', 'warn')}</td></tr>
        <tr><td><b>Beall's list</b><div class="muted">Potential predatory publishers, standalone journals and hijacked journals</div></td><td class="num">${ds.beall.count.toLocaleString()} entries</td><td>${ds.beall.loadedAt ? fmtDate(ds.beall.loadedAt) : badge('not loaded', 'warn')}</td></tr>
      </table>
      <p class="muted" style="margin:10px 0 0">${desk ? 'Synchronised from the web platform; use “Sync & offline queue” to update.' : 'Both refresh automatically every 7 days. Alerts and retraction monitoring run daily.'}</p>
      <div id="refresh-progress"></div>
    </div>

    <div class="card" id="image-sources">
      <div class="card-head"><h2>Image Integrity sources</h2><span class="muted">Used by Module 5</span></div>
      <div class="muted">Loading…</div>
    </div>

    <div class="card" id="pjps-rules">
      <div class="card-head"><h2>PJPS rules</h2><span class="muted">Used by Module 1 and Module 4</span></div>
      <div class="grid grid-2">
        <div class="field"><label>Recent references (Module 1)</label>
          <div class="row">At least <input id="rule-share" type="number" min="0" max="100" style="width:80px">% of references from the last <input id="rule-years" type="number" min="1" max="20" style="width:70px"> years</div>
          <div class="hint">A warning is shown in Check Bibliography when a manuscript falls below this share. 0 switches the warning off.</div>
          <button class="btn btn-sm" id="rule-save" style="margin-top:8px">Save rule</button></div>
        <div class="field"><label>Extra tortured phrases (Module 4)</label>
          <textarea id="tp-list" rows="6" class="mono" placeholder="tortured phrase = correct term&#10;e.g. medication conveyance = drug delivery"></textarea>
          <div class="hint">One per line, “phrase = correct term”. Added to the <span id="tp-builtin"></span> built-in phrases from the Problematic Paper Screener.</div>
          <button class="btn btn-sm" id="tp-save" style="margin-top:8px">Save phrases</button></div>
      </div>
    </div>

    <div class="card">
      <h2>Journal index lists</h2>
      ${desk ? '<p class="muted">Lists are uploaded by the Super Admin on the web platform.</p>' : `<p class="muted">Scopus, Web of Science, JCR, EBSCO and HEC HJRS lists are licensed or behind logins, so upload the current CSV files your journal has access to. Columns are detected automatically (title, ISSN, eISSN, quartile, category). Excel files: save as <b>CSV UTF-8</b> first.</p>
      <ul class="muted" style="font-size:13px">
        <li><b>SJR</b>: scimagojr.com → Journal Rankings → Download data (gives Scopus quartiles).</li>
        <li><b>Scopus source list</b>: Elsevier “Scopus Sources” page → download the source list workbook → save as CSV (include the conference proceedings sheet for conference coverage).</li>
        <li><b>Web of Science</b>: scimagojr.com → Journal Rankings → “Only WoS Journals” → Download data.</li>
        <li><b>JCR</b>: Journal Citation Reports export (needs a JCR subscription).</li>
        <li><b>HEC HJRS</b>: hjrs.hec.gov.pk → journal list export (Category W/X/Y).</li>
        <li><b>EBSCO</b>: ebsco.com/title-lists → download the title list of each database you need (Excel). To load several databases, paste them into one sheet and add a <b>Database</b> column, then save as CSV. A new upload replaces the previous EBSCO list.</li>
      </ul>`}
      <div class="table-wrap"><table class="t">
        <tr><th>List</th><th class="num">Rows</th><th>Uploaded</th><th></th></tr>
        ${ds.lists.map(l => `<tr>
          <td>${esc(l.label)}${l.filename ? `<div class="muted">${esc(l.filename)}</div>` : ''}</td>
          <td class="num">${l.row_count ? Number(l.row_count).toLocaleString() : '—'}</td>
          <td>${l.uploaded_at ? fmtDate(l.uploaded_at) : badge('not uploaded', 'neutral')}</td>
          <td class="row" style="flex-wrap:nowrap">${l.row_count ? `<button class="btn btn-sm" data-view="${l.type}">View</button>` : ''}${desk ? '' : `<label class="btn btn-sm" style="margin:0">Upload CSV<input type="file" accept=".csv,.txt" hidden data-list="${l.type}"></label>${l.row_count ? `<button class="btn btn-sm btn-ghost btn-danger" data-rm="${l.type}">✕</button>` : ''}`}</td>
        </tr>`).join('')}
      </table></div>
    </div>`;

  api('/api/settings/age-rule').then(d => { $('#rule-share', view).value = d.rule.minShare; $('#rule-years', view).value = d.rule.years; }).catch(() => {});
  api('/api/settings/tortured').then(d => { $('#tp-list', view).value = d.list.map(x => `${x.phrase} = ${x.correct}`).join('\n'); $('#tp-builtin', view).textContent = d.builtIn; }).catch(() => {});
  api('/api/admin/image-sources').then(({ datasets, knowledge, benchmark: b, cases }) => {
    $('#image-sources', view).innerHTML = `<div class="card-head"><h2>Image Integrity sources</h2><span class="muted">Used by Module 5</span></div>
      <table class="t">
        <tr><td><b>ImageTwin &amp; Proofig knowledge base</b><div class="muted">${knowledge.sources.map(esc).join(' · ')} — finding types, risk and false-alarm guidance, decision matrix, author query letters</div></td><td class="num">${knowledge.files.toLocaleString()} files</td><td>${knowledge.updatedAt ? fmtDate(knowledge.updatedAt) : badge('not loaded', 'warn')}</td></tr>
        <tr><td><b>Retracted papers with image problems</b><div class="muted">Retraction Watch (Crossref) + Europe PMC open-access flags</div></td><td class="num">${cases ? cases.total.toLocaleString() + ' papers' : '—'}</td><td>${cases ? fmtDate(cases.fetchedAt) : badge('not loaded', 'warn')}</td></tr>
        <tr><td><b>Engine benchmark</b><div class="muted">Forgeries generated from the RSIID pristine images</div></td><td class="num">${b ? b.images + ' images' : '—'}</td><td>${b ? fmtDate(b.runAt) : badge('not run', 'warn')}</td></tr>
        ${datasets.map(d => `<tr><td><a href="${esc(d.url)}" target="_blank" rel="noopener"><b>${esc(d.name)}</b></a><div class="muted">${esc(d.license)} · ${esc(d.scale)}</div></td><td colspan="2">${esc(d.status)}<div class="muted">${esc(d.access)}</div></td></tr>`).join('')}
      </table>
      <p class="muted" style="margin:10px 0 0">Loaded with <code>node scripts/fetch-public-image-data.js</code> and <code>node scripts/benchmark-public-images.mjs</code>; the knowledge base is read from <code>data/new</code>. On a server where these folders are missing the rows show “not loaded”.</p>`;
  }).catch(() => { $('#image-sources', view).innerHTML = ''; });
  $('#rule-save', view).onclick = () => api('/api/settings/age-rule', { method: 'PUT', body: { minShare: $('#rule-share', view).value, years: $('#rule-years', view).value } }).then(() => toast('Rule saved')).catch(e => toast(e.message, 'error'));
  $('#tp-save', view).onclick = () => {
    const list = $('#tp-list', view).value.split('\n').map(l => l.split('=')).filter(p => p.length === 2).map(([a, b]) => ({ phrase: a.trim(), correct: b.trim() }));
    api('/api/settings/tortured', { method: 'PUT', body: { list } }).then(d => toast(`${d.list.length} phrase(s) saved`)).catch(e => toast(e.message, 'error'));
  };
  $('#refresh', view).onclick = async () => {
    try {
      const { jobId } = await api('/api/admin/datasets/refresh', { body: {} });
      await runJob(jobId, $('#refresh-progress', view), 'Refreshing datasets (this takes a few minutes)');
      toast('Datasets refreshed');
      renderAdmin(view);
    } catch (e) { toast(e.message, 'error'); }
  };
  if ($('#alerts', view)) $('#alerts', view).onclick = async () => {
    try {
      const { jobId } = await api('/api/admin/alerts/run', { body: {} });
      const r = await runJob(jobId, $('#refresh-progress', view), 'Running alerts and retraction monitoring');
      toast(`${r.follows} alert(s) checked, ${r.notices} notice(s), ${r.retractions} retraction notice(s)`);
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
  $$('[data-view]', view).forEach(b => (b.onclick = () => viewList(ds.lists.find(l => l.type === b.dataset.view))));
}

/** Read-only, searchable, paged view of an uploaded journal list */
function viewList(list) {
  modal(`<div class="card-head"><div><h2 style="margin:0">${esc(list.label)}</h2><div class="muted">${list.filename ? `${esc(list.filename)} · ` : ''}${Number(list.row_count).toLocaleString()} journals</div></div><button class="btn btn-sm btn-ghost" data-close>✕</button></div>
    <div class="row" style="margin:12px 0"><input type="search" id="lv-q" placeholder="Search title or ISSN" style="flex:1"><button class="btn btn-sm" id="lv-go">Search</button></div>
    <div id="lv-body"><div class="progress">Loading…</div></div>`, {
    onMount: el => {
      let page = 1, q = '';
      const body = $('#lv-body', el);
      const load = async () => {
        try {
          const d = await api(`/api/admin/lists/${list.type}/entries?page=${page}&q=${encodeURIComponent(q)}`);
          // columns: the first few that have a value in this page and are short enough to read in a table
          const cols = [];
          for (const r of d.rows) for (const k of Object.keys(r.data || {})) if (!cols.includes(k) && String(r.data[k] || '').trim() && !/^[\s\S]*\n/.test(k) && cols.length < 8) cols.push(k);
          const pages = Math.max(1, Math.ceil(d.total / d.size));
          body.innerHTML = d.rows.length ? `<div class="table-wrap"><table class="t"><tr>${cols.map(c => `<th>${esc(c.slice(0, 40))}</th>`).join('')}</tr>
            ${d.rows.map(r => `<tr>${cols.map(c => `<td>${esc(String((r.data || {})[c] ?? '').slice(0, 120))}</td>`).join('')}</tr>`).join('')}</table></div>
            <div class="row" style="justify-content:space-between;margin-top:10px"><span class="muted">${d.total.toLocaleString()} ${q ? 'matching ' : ''}journals · page ${page} of ${pages.toLocaleString()}</span>
            <span class="row"><button class="btn btn-sm" id="lv-prev" ${page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn btn-sm" id="lv-next" ${page >= pages ? 'disabled' : ''}>Next</button></span></div>`
            : '<p class="muted">No journals match.</p>';
          if ($('#lv-prev', el)) $('#lv-prev', el).onclick = () => { page--; load(); };
          if ($('#lv-next', el)) $('#lv-next', el).onclick = () => { page++; load(); };
        } catch (e) { body.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
      };
      const search = () => { q = $('#lv-q', el).value.trim(); page = 1; load(); };
      $('#lv-go', el).onclick = search;
      $('#lv-q', el).onkeydown = e => { if (e.key === 'Enter') search(); };
      load();
    }
  });
}

const ACTION = { login: 'Signed in', 'login-failed': 'Failed sign-in', 'desktop-login': 'Linked a desktop', 'desktop-login-failed': 'Failed desktop sign-in', 'user-created': 'Created user', 'user-updated': 'Updated user', 'user-suspended': 'Suspended user', 'user-activated': 'Activated user', 'user-deleted': 'Deleted user', 'password-reset': 'Reset password', 'password-changed': 'Changed password', 'device-revoked': 'Revoked device', 'list-uploaded': 'Uploaded list', 'list-removed': 'Removed list' };

export async function renderAudit(view) {
  if (state.app.desktop) { view.innerHTML = '<div class="page-head"><div><h1>Audit log &amp; usage</h1></div></div><div class="card">The audit log and usage statistics are kept on the web platform.</div>'; return; }
  const [{ entries }, stats] = await Promise.all([api('/api/admin/audit?limit=300'), api('/api/admin/stats?days=30')]);
  const { KIND_LABEL } = await import('./activity.js');
  const t = stats.totals;
  view.innerHTML = `
    <div class="page-head"><div><h1>Audit log &amp; usage</h1><p>Sign-ins, account and permission changes, and how the tools were used in the last ${stats.days} days.</p></div></div>
    <div class="kpis">
      <div class="kpi"><div class="n">${t.users}</div><div class="l">Users</div></div>
      <div class="kpi good"><div class="n">${t.active}</div><div class="l">Active</div></div>
      <div class="kpi info"><div class="n">${t.desktop_users}</div><div class="l">With desktop access</div></div>
      <div class="kpi"><div class="n">${t.devices}</div><div class="l">Linked computers</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>Runs by tool</h3><table class="t"><tr><th>Tool</th><th class="num">Runs</th><th class="num">References</th><th class="num">Suspicious</th><th class="num">Retracted</th></tr>
        ${stats.byKind.map(k => `<tr><td>${esc(KIND_LABEL[k.kind] || k.kind)}</td><td class="num">${k.runs}</td><td class="num">${k.refs}</td><td class="num">${k.suspicious}</td><td class="num">${k.retracted}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No runs yet.</td></tr>'}</table></div>
      <div class="card"><h3>Runs by user</h3><table class="t"><tr><th>User</th><th class="num">Runs</th><th class="num">References</th><th>Last run</th></tr>
        ${stats.byUser.map(u => `<tr><td>${esc(u.name)}<div class="muted">${esc(u.email)}</div></td><td class="num">${u.runs}</td><td class="num">${u.refs}</td><td>${u.last_run ? fmtDate(u.last_run) : '—'}</td></tr>`).join('')}</table></div>
    </div>
    <div class="card"><h3>Audit log</h3><div class="table-wrap"><table class="t"><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Channel</th><th>IP</th></tr>
      ${entries.map(e => `<tr><td>${new Date(e.created_at).toLocaleString()}</td><td>${esc(e.actor_email || '—')}</td><td>${badge(ACTION[e.action] || e.action, /failed|suspend|delete|revoke/.test(e.action) ? 'warn' : 'neutral')}</td><td>${esc(e.target || '')}${e.details ? `<div class="muted" style="font-size:12px">${esc(Object.entries(e.details).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · '))}</div>` : ''}</td><td>${esc(e.channel || '')}</td><td class="muted">${esc(e.ip || '')}</td></tr>`).join('')}
    </table></div></div>`;
}
