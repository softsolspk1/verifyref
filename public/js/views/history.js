// views/history.js - saved checks grouped by manuscript (versions), with issue assignment
import { api, esc, $, $$, badge, toast, fmtDate, issueOptions, state } from '../core.js';

export async function renderHistory(view) {
  const { checks } = await api('/api/checks');
  const groups = new Map();
  for (const c of checks) {
    const k = c.kind === 'reviewer-report' ? `rr-${c.id}` : c.manuscript_code || `#${c.id}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const kindLabel = { manuscript: 'Full check', references: 'Reference Check', citations: 'Citation Check', 'reviewer-report': 'Reviewer report' };

  view.innerHTML = `
    <div class="page-head"><div><h1>Manuscripts &amp; reports</h1><p>Every saved check, grouped by manuscript ID. Open a report for the decision summary, correction letter and revision comparison.</p></div>
      <input id="h-search" type="text" placeholder="Search title or ID…" style="width:260px"></div>
    ${checks.length ? `<div class="table-wrap"><table class="t" id="h-table">
      <tr><th>Manuscript</th><th>Type</th><th>Ver.</th><th>Date</th><th class="num">Refs</th><th>Findings</th><th>Issue</th><th></th></tr>
      ${[...groups.values()].map(list => list.map((c, i) => `
        <tr data-search="${esc(`${c.manuscript_code || ''} ${c.title || ''}`.toLowerCase())}">
          <td>${i === 0 ? `<b>${esc(c.manuscript_code || '—')}</b><div>${esc((c.title || 'Untitled').slice(0, 90))}</div>` : '<span class="muted">↳ earlier version</span>'}</td>
          <td>${esc(kindLabel[c.kind] || c.kind)}</td>
          <td class="num">${c.version}</td>
          <td>${fmtDate(c.created_at)}</td>
          <td class="num">${c.ref_total}</td>
          <td>${c.kind === 'reviewer-report' ? (c.problems || []).slice(0, 2).map(p => `<div class="muted">${esc(p)}</div>`).join('') || badge('No flags', 'good')
            : [c.suspicious ? badge(`${c.suspicious} suspicious`, 'bad') : '', c.retracted ? badge(`${c.retracted} retracted`, 'bad') : '', c.miscited ? badge(`${c.miscited} miscited`, 'warn') : '', c.missing_citations ? badge(`${c.missing_citations} missing`, 'warn') : '', c.self_citation_rate >= 15 ? badge(`self-cit. ${c.self_citation_rate}%`, 'warn') : ''].join(' ') || badge('Clean', 'good')}</td>
          <td>${c.kind === 'reviewer-report' ? '' : `<select data-issue="${c.id}" style="width:auto;padding:4px 8px;font-size:12.5px">${issueOptions(c.issue_id)}</select>`}</td>
          <td class="row" style="flex-wrap:nowrap">${c.has_result ? `<a class="btn btn-sm" href="#/check/${c.id}">Open</a>` : '<span class="muted" title="Saved as counts only">counts only</span>'}<button class="btn btn-sm btn-ghost btn-danger" data-del="${c.id}" title="Delete">✕</button></td>
        </tr>`).join('')).join('')}
    </table></div>` : '<div class="card empty">No saved checks yet. Run a manuscript check to get started.</div>'}`;

  const search = $('#h-search', view);
  search.oninput = () => {
    const q = search.value.toLowerCase();
    $$('#h-table tr[data-search]', view).forEach(tr => (tr.hidden = q && !tr.dataset.search.includes(q)));
  };
  $$('[data-issue]', view).forEach(s => (s.onchange = () => api(`/api/checks/${s.dataset.issue}`, { method: 'PATCH', body: { issueId: s.value || null } }).then(() => toast('Saved')).catch(e => toast(e.message, 'error'))));
  $$('[data-del]', view).forEach(b => (b.onclick = async () => {
    if (!confirm('Delete this saved check?')) return;
    await api(`/api/checks/${b.dataset.del}`, { method: 'DELETE' });
    renderHistory(view);
  }));
}
