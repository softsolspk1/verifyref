// views/cases.js - Editorial Dashboard & Case Management: integrity workload at a glance, the case list, and each case
// with its linked reports, author queries and responses, workflow status, outcome, notes and full history.
import { api, esc, $, $$, toast, badge, fmtDate, download, ICONS, modal } from '../core.js';

const PRI_TONE = { urgent: 'bad', high: 'bad', normal: 'info', low: 'neutral' };
const RISK_TONE = { CRITICAL: 'bad', HIGH: 'bad', MODERATE: 'warn', MEDIUM: 'warn', LOW: 'good' };
const STATUS_TONE = { open: 'info', investigating: 'warn', awaiting_author: 'warn', committee: 'bad', closed: 'good' };
const KIND = { integrity: 'Paper Mill', papermill: 'Paper Mill (earlier version)', images: 'Image Integrity', 'peer-review': 'Peer review', manuscript: 'Full Screening', references: 'Bibliography' };
const when = d => (d ? new Date(d).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export async function renderCases(view) {
  view.innerHTML = '<div class="empty">Loading…</div>';
  const d = await api('/api/cases/dashboard');
  const L = d.labels;
  const n = Object.fromEntries(d.byStatus.map(x => [x.status, x.n]));
  const scr = Object.fromEntries(d.screenings.map(x => [x.level, x.n]));
  const mon = Object.fromEntries(d.monitoring.map(x => [x.status, x.n]));
  view.innerHTML = `
    <div class="page-head"><div><h1>Module 4 — Cases &amp; dashboard</h1><p>Open integrity cases, overdue author queries, high-risk screenings that nobody has picked up yet, and post-publication notices.</p></div>
      <div class="row"><button class="btn btn-primary btn-sm" id="new">New case</button></div></div>
    <div class="kpis">
      ${Object.entries(L.statuses).filter(([k]) => k !== 'closed').map(([k, l]) => `<div class="kpi ${k === 'committee' ? 'bad' : k === 'open' ? 'info' : 'warn'}"><div class="n">${n[k] || 0}</div><div class="l">${esc(l)}</div></div>`).join('')}
      <div class="kpi ${d.overdue.length ? 'bad' : 'good'}"><div class="n">${d.overdue.length}</div><div class="l">Overdue</div></div>
      <div class="kpi good"><div class="n">${n.closed || 0}</div><div class="l">Closed</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><h3>Screenings, last 90 days</h3><div class="kpis" style="margin:0">${['CRITICAL', 'HIGH', 'MODERATE', 'LOW'].map(l => `<div class="kpi ${RISK_TONE[l]}"><div class="n">${scr[l] || 0}</div><div class="l">${l}</div></div>`).join('')}</div></div>
      <div class="card"><h3>Published articles</h3><div class="kpis" style="margin:0">${[['retracted', 'Retracted'], ['concern', 'Concern'], ['corrected', 'Corrected'], ['cites-retracted', 'Cite retracted']].map(([k, l]) => `<div class="kpi ${mon[k] ? 'warn' : 'good'}"><div class="n">${mon[k] || 0}</div><div class="l">${l}</div></div>`).join('')}</div><a href="#/references/monitoring">Article monitoring →</a></div>
    </div>
    ${d.unhandled.length ? `<div class="card"><div class="card-head"><h3>High-risk reports without a case</h3>${badge(String(d.unhandled.length), 'bad')}</div><div class="table-wrap"><table class="t"><tr><th>Date</th><th>Report</th><th>Manuscript</th><th>Risk</th><th></th></tr>${d.unhandled.map(u => `<tr><td>${fmtDate(u.created_at)}</td><td>${esc(KIND[u.kind] || u.kind)}</td><td><a href="#/check/${u.id}">${esc(u.manuscript_code || '')} ${esc((u.title || '').slice(0, 80))}</a></td><td>${badge(u.level, RISK_TONE[u.level])}</td><td><button class="btn btn-sm" data-open="${u.id}">Open case</button></td></tr>`).join('')}</table></div></div>` : ''}
    <div class="card"><div class="card-head"><h3>Active cases</h3><div class="row"><input id="q" type="search" placeholder="Search" style="max-width:220px"><select id="st" style="max-width:220px"><option value="">Active</option>${Object.entries(L.statuses).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select><label class="check" hidden><input type="checkbox" id="mine"> Mine</label></div></div><div id="list"></div></div>`;

  const table = rows => (rows.length ? `<div class="table-wrap"><table class="t"><tr><th>#</th><th>Case</th><th>Status</th><th>Priority</th><th>Risk</th><th>Assigned</th><th>Due</th><th>Updated</th></tr>${rows.map(c => `<tr>
    <td>${c.id}</td><td><a href="#/papermill/cases/${c.id}">${esc(c.manuscript_code ? c.manuscript_code + ' — ' : '')}${esc(c.title.slice(0, 90))}</a></td>
    <td>${badge(L.statuses[c.status] || c.status, STATUS_TONE[c.status])}</td><td>${badge(L.priorities[c.priority] || c.priority, PRI_TONE[c.priority])}</td>
    <td>${c.risk_level ? badge(c.risk_level, RISK_TONE[c.risk_level]) : '—'}</td><td>${esc(c.assigned_name || '—')}</td>
    <td class="${c.due_at && new Date(c.due_at) < new Date() && c.status !== 'closed' ? 'txt-bad' : 'muted'}">${c.due_at ? fmtDate(c.due_at) : ''}</td><td class="muted">${fmtDate(c.updated_at)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No cases.</p>');
  $('#list', view).innerHTML = table(d.open);
  const reload = async () => {
    const qs = new URLSearchParams({ q: $('#q', view).value, status: $('#st', view).value || 'open,investigating,awaiting_author,committee', ...($('#mine', view).checked ? { mine: 1 } : {}) });
    $('#list', view).innerHTML = table((await api(`/api/cases?${qs}`)).items);
  };
  let t;
  $('#q', view).oninput = () => { clearTimeout(t); t = setTimeout(reload, 300); };
  $('#st', view).onchange = reload;
  $('#mine', view).onchange = reload;
  $$('[data-open]', view).forEach(b => { b.onclick = async () => { try { const r = await api('/api/cases', { body: { checkIds: [+b.dataset.open] } }); location.hash = `#/papermill/cases/${r.case.id}`; } catch (e) { toast(e.message, 'error'); } }; });
  $('#new', view).onclick = () => modal(`<h3>New integrity case</h3>
    <div class="field"><label>Title</label><input id="nc-title" type="text"></div>
    <div class="grid grid-2"><div class="field"><label>Manuscript ID or DOI</label><input id="nc-code" type="text"></div>
    <div class="field"><label>Priority</label><select id="nc-pri">${Object.entries(L.priorities).map(([k, l]) => `<option value="${k}" ${k === 'normal' ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <div class="field"><label>What prompted the case</label><textarea id="nc-note" rows="3" placeholder="e.g. reader complaint, reviewer concern, whistle-blower e-mail"></textarea></div>
    <div class="row"><button class="btn btn-primary" id="nc-save">Create</button><button class="btn" data-close>Cancel</button></div>`, { onMount: (m, close) => {
    $('#nc-save', m).onclick = async () => {
      try { const r = await api('/api/cases', { body: { title: $('#nc-title', m).value, manuscriptCode: $('#nc-code', m).value, priority: $('#nc-pri', m).value, note: $('#nc-note', m).value } }); close(); location.hash = `#/papermill/cases/${r.case.id}`; } catch (e) { toast(e.message, 'error'); }
    };
  } });
}

export async function renderCase(view, id) {
  view.innerHTML = '<div class="empty">Loading…</div>';
  const [{ case: c, labels: L }, { users }] = await Promise.all([api(`/api/cases/${id}`), api('/api/cases/assignees')]);
  const ev = e => {
    const d = e.data || {};
    const what = { created: 'opened the case', note: 'added a note', status: `moved the case to “${L.statuses[d.to] || d.to}”${d.outcomeLabel ? ` — outcome: ${d.outcomeLabel}` : ''}`, assign: `assigned the case to ${d.name}`, priority: `changed priority ${d.from} → ${d.to}`, query: `sent an author query “${d.subject || ''}”${d.to ? ` to ${d.to}` : ''}`, response: 'logged the authors\' response', decision: `recorded a decision${d.decision ? `: ${d.decision}` : ''}`, link: `linked report(s) ${(d.checkIds || []).map(x => '#' + x).join(', ')}` }[e.kind] || e.kind;
    return `<li><div class="when">${when(e.created_at)}</div><div><b>${esc(e.actor_name || 'System')}</b> ${esc(what)}</div>${e.body ? `<div class="body">${esc(e.body)}</div>` : ''}</li>`;
  };
  view.innerHTML = `
    <p class="muted no-print"><a href="#/papermill/cases">← Dashboard</a></p>
    <div class="page-head"><div><h1>Case #${c.id}: ${esc(c.title)}</h1>
      <p>${c.manuscript_code ? `<b>${esc(c.manuscript_code)}</b> · ` : ''}${badge(L.statuses[c.status], STATUS_TONE[c.status])} ${badge(L.priorities[c.priority], PRI_TONE[c.priority])} ${c.risk_level ? badge(`Risk ${c.risk_level}`, RISK_TONE[c.risk_level]) : ''} · opened ${fmtDate(c.created_at)} by ${esc(c.created_name || '—')}${c.outcome ? ` · <b>${esc(L.outcomes[c.outcome])}</b>` : ''}</p></div>
      <div class="row no-print"><button class="btn btn-sm" id="rep-docx">${ICONS.download} Case report (Word)</button><button class="btn btn-sm" id="rep-pdf">${ICONS.download} PDF</button></div></div>
    <div class="grid grid-2">
      <div>
        <div class="card"><h3>Workflow</h3>
          <div class="grid grid-2">
            <div class="field"><label>Status</label><select id="c-status">${Object.entries(L.statuses).map(([k, l]) => `<option value="${k}" ${k === c.status ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
            <div class="field" id="outcome-f" ${c.status === 'closed' ? '' : 'hidden'}><label>Outcome</label><select id="c-outcome"><option value="">— choose —</option>${Object.entries(L.outcomes).map(([k, l]) => `<option value="${k}" ${k === c.outcome ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          </div>
          <div class="grid grid-2">
            <div class="field" ${users.length > 1 ? '' : 'hidden'}><label>Assigned to</label><select id="c-assign"><option value="">— nobody —</option>${users.map(u => `<option value="${u.id}" ${u.id === c.assigned_to ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
            <div class="field"><label>Priority</label><select id="c-pri">${Object.entries(L.priorities).map(([k, l]) => `<option value="${k}" ${k === c.priority ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          </div>
          <div class="grid grid-2"><div class="field"><label>Due</label><input id="c-due" type="date" value="${c.due_at ? new Date(c.due_at).toISOString().slice(0, 10) : ''}"></div>
          <div class="field"><label>Reason for the change <span class="muted">(optional)</span></label><input id="c-why" type="text"></div></div>
          <button class="btn btn-primary btn-sm" id="c-save">Save</button></div>
        <div class="card"><div class="card-head"><h3>Evidence</h3><span class="muted">${c.reports.length} linked report(s)</span></div>
          ${c.reports.length ? `<div class="table-wrap"><table class="t"><tr><th>Report</th><th>Date</th><th>Risk</th><th>Key findings</th></tr>${c.reports.map(r => `<tr><td><a href="#/check/${r.id}">${esc(r.kindLabel)} #${r.id}</a></td><td class="muted">${fmtDate(r.created_at)}</td><td>${r.risk_level || r.image_level ? badge(r.risk_level || r.image_level, RISK_TONE[r.risk_level || r.image_level]) : ''}${r.risk_score && r.kind !== 'papermill' ? ` <span class="muted">${r.risk_score}/100</span>` : ''}</td><td class="muted">${esc((r.problems || []).slice(1, 4).join('; '))}</td></tr>`).join('')}</table></div>` : '<p class="muted">No report linked.</p>'}
          ${c.suggested.length ? `<div class="field" style="margin-top:10px"><label>Other reports for this manuscript</label><div class="row">${c.suggested.map(s => `<button class="btn btn-sm" data-link="${s.id}">+ ${esc(KIND[s.kind] || s.kind)} #${s.id} (${fmtDate(s.created_at)})</button>`).join('')}</div></div>` : ''}
          <div class="row" style="margin-top:10px"><input id="link-id" type="number" placeholder="Report #" style="max-width:130px"><button class="btn btn-sm" id="link">Link report</button></div></div>
        <div class="card"><div class="card-head"><h3>Author queries</h3><button class="btn btn-sm" id="draft">Draft from findings</button></div>
          ${c.queries.map(q => `<div class="rv-card"><div><b>${esc(q.data?.subject || 'Query')}</b> <span class="muted">· ${when(q.created_at)} · ${esc(q.actor_name)}${q.data?.dueAt ? ` · reply due ${fmtDate(q.data.dueAt)}` : ''}</span></div>
            <details><summary class="muted">Query text</summary><div class="body" style="white-space:pre-wrap">${esc(q.body)}</div></details>
            ${q.responses.map(a => `<div class="quote"><b>Response</b> <span class="muted">${fmtDate(a.data?.receivedAt || a.created_at)}</span><div style="white-space:pre-wrap">${esc(a.body)}</div></div>`).join('') || `<div class="row" style="margin-top:6px"><button class="btn btn-sm" data-respond="${q.id}">Log the authors' response</button></div>`}</div>`).join('') || '<p class="muted">No query sent yet.</p>'}
          <div id="q-form" hidden>
            <div class="grid grid-2"><div class="field"><label>To</label><input id="q-to" type="text" placeholder="corresponding author e-mail"></div><div class="field"><label>Reply due</label><input id="q-due" type="date"></div></div>
            <div class="field"><label>Subject</label><input id="q-subj" type="text"></div>
            <div class="field"><label>Query</label><textarea id="q-body" rows="10"></textarea><div class="hint">Send it from your e-mail, then record it here: the case moves to “Awaiting author response”.</div></div>
            <div class="row"><button class="btn btn-sm" id="q-copy">${ICONS.copy} Copy</button><button class="btn btn-primary btn-sm" id="q-save">Record as sent</button></div></div></div>
      </div>
      <div>
        <div class="card"><h3>Add to the case file</h3>
          <div class="field"><select id="e-kind"><option value="note">Note</option><option value="decision">Decision</option></select></div>
          <div class="field"><textarea id="e-body" rows="4" placeholder="What was checked, who was contacted, what was decided…"></textarea></div>
          <button class="btn btn-sm btn-primary" id="e-save">Add</button></div>
        <div class="card"><h3>History (audit trail)</h3><ul class="timeline">${c.events.slice().reverse().map(ev).join('')}</ul></div>
      </div>
    </div>`;

  const save = async body => { try { await api(`/api/cases/${c.id}`, { method: 'PATCH', body }); toast('Saved'); renderCase(view, id); } catch (e) { toast(e.message, 'error'); } };
  $('#c-status', view).onchange = () => { $('#outcome-f', view).hidden = $('#c-status', view).value !== 'closed'; };
  $('#c-save', view).onclick = () => save({ status: $('#c-status', view).value, outcome: $('#c-outcome', view).value || null, assignedTo: $('#c-assign', view).value || null, priority: $('#c-pri', view).value, dueAt: $('#c-due', view).value || null, note: $('#c-why', view).value });
  $$('[data-link]', view).forEach(b => { b.onclick = () => save({ linkChecks: [+b.dataset.link] }); });
  $('#link', view).onclick = () => { const v = +$('#link-id', view).value; if (v) save({ linkChecks: [v] }); };
  $('#rep-docx', view).onclick = () => download(`/api/cases/${c.id}/report`).catch(e => toast(e.message, 'error'));
  $('#rep-pdf', view).onclick = () => download(`/api/cases/${c.id}/report?format=pdf`).catch(e => toast(e.message, 'error'));
  $('#draft', view).onclick = async () => {
    const q = await api(`/api/cases/${c.id}/draft-query`);
    $('#q-form', view).hidden = false;
    $('#q-subj', view).value = q.subject;
    $('#q-body', view).value = q.body;
    const due = new Date(Date.now() + 14 * 86400000);
    $('#q-due', view).value = due.toISOString().slice(0, 10);
  };
  $('#q-copy', view).onclick = () => navigator.clipboard.writeText(`${$('#q-subj', view).value}\n\n${$('#q-body', view).value}`).then(() => toast('Copied'));
  const addEvent = async body => { try { await api(`/api/cases/${c.id}/events`, { body }); toast('Recorded'); renderCase(view, id); } catch (e) { toast(e.message, 'error'); } };
  $('#q-save', view).onclick = () => addEvent({ kind: 'query', subject: $('#q-subj', view).value, body: $('#q-body', view).value, to: $('#q-to', view).value, dueAt: $('#q-due', view).value || null });
  $('#e-save', view).onclick = () => addEvent({ kind: $('#e-kind', view).value, body: $('#e-body', view).value, decision: $('#e-kind', view).value === 'decision' ? $('#e-body', view).value.split('\n')[0].slice(0, 100) : undefined });
  $$('[data-respond]', view).forEach(b => { b.onclick = () => modal(`<h3>Authors' response</h3><div class="field"><label>Received</label><input id="r-date" type="date" value="${new Date().toISOString().slice(0, 10)}"></div><div class="field"><textarea id="r-body" rows="8" placeholder="Paste the response or summarise it"></textarea></div><div class="row"><button class="btn btn-primary" id="r-save">Record</button><button class="btn" data-close>Cancel</button></div>`, { onMount: (m, close) => {
    $('#r-save', m).onclick = async () => {
      const body = { kind: 'response', queryId: +b.dataset.respond, body: $('#r-body', m).value, receivedAt: $('#r-date', m).value };
      close();
      await addEvent(body);
    };
  } }); });
}
