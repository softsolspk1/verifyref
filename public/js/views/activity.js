// views/activity.js - My Activity: saved results of every tool, with manuscript versions grouped together
import { api, esc, $, $$, badge, toast, fmtDate, issueOptions, state } from '../core.js';

export const KIND_LABEL = {
  manuscript: 'Full Screening Report', references: '1 · Check Bibliography', citations: '3 · Citations', 'reviewer-report': 'Reviewer report',
  restyle: '2 · Reference Style', papermill: '4 · Paper Mill', images: '5 · Image Integrity', format: 'Manuscript Format', verify: 'Verify Citations', evidence: 'Find Evidence', 'journal-finder': 'Find a Journal',
  conferences: 'Conferences', assistant: 'Thesis/Paper Assistant', authors: 'Author publications',
  integrity: '4 · Paper Mill (integrity)', 'peer-review': '4 · Peer-review integrity'
};
const MS_KINDS = ['manuscript', 'references', 'citations'];
const RISK = /(?:risk|Image risk) (LOW|MEDIUM|HIGH)/;

function findings(c) {
  if (c.kind === 'integrity' || c.kind === 'peer-review') {
    const m = (c.problems || [])[0]?.match(/risk (LOW|MODERATE|HIGH|CRITICAL)/);
    return `${m ? badge(`Risk ${m[1]}`, m[1] === 'LOW' ? 'good' : m[1] === 'MODERATE' ? 'warn' : 'bad') : ''} ${(c.problems || []).slice(1, 3).map(p => `<div class="muted">${esc(p)}</div>`).join('')}`;
  }
  if (c.kind === 'papermill' || c.kind === 'images') {
    const m = (c.problems || []).map(p => p.match(RISK)).find(Boolean);
    const level = m ? m[1] : null;
    return `${level ? badge(`${c.kind === 'images' ? 'Image' : 'Mill'} risk ${level}`, level === 'HIGH' ? 'bad' : level === 'MEDIUM' ? 'warn' : 'good') : ''} ${(c.problems || []).slice(1, 3).map(p => `<div class="muted">${esc(p)}</div>`).join('')}`;
  }
  if (c.kind === 'citations' && !c.suspicious && !c.retracted && (c.problems || []).length) return (c.problems || []).slice(0, 2).map(p => `<div class="muted">${esc(p)}</div>`).join('');
  if (MS_KINDS.includes(c.kind)) {
    return [c.pending_online ? badge(`${c.pending_online} pending online`, 'info') : '', c.suspicious ? badge(`${c.suspicious} suspicious`, 'bad') : '', c.retracted ? badge(`${c.retracted} retracted`, 'bad') : '', c.miscited ? badge(`${c.miscited} miscited`, 'warn') : ''].join(' ') || badge('Clean', 'good');
  }
  if (c.kind === 'verify') return [c.suspicious ? badge(`${c.suspicious} unsupported`, 'bad') : '', c.unverified ? badge(`${c.unverified} partial / unverifiable`, 'warn') : '', c.verified ? badge(`${c.verified} supported`, 'good') : ''].join(' ');
  return (c.problems || []).slice(0, 2).map(p => `<div class="muted">${esc(p)}</div>`).join('') || `<span class="muted">${c.ref_total ? `${c.ref_total} item(s)` : ''}</span>`;
}

export async function renderActivity(view) {
  const { items } = await api('/api/activity');
  const kinds = [...new Set(items.map(i => i.kind))];
  view.innerHTML = `
    <div class="page-head"><div><h1>My Activity</h1><p>Every saved report from every tool. Manuscript checks are grouped by manuscript ID so revisions sit together; saved bibliography checks are re-checked daily for new retractions.${state.app.desktop ? ' Reports made on this computer are uploaded to the web platform at the next synchronisation.' : ''}</p></div>
      <input id="q" type="text" placeholder="Search title or ID…" style="width:260px"></div>
    <div class="filters"><button class="filter active" data-k="">All</button>${kinds.map(k => `<button class="filter" data-k="${k}">${esc(KIND_LABEL[k] || k)}</button>`).join('')}</div>
    ${items.length ? `<div class="table-wrap"><table class="t" id="tbl">
      <tr><th>Title</th><th>Tool</th><th>Date</th><th>Findings</th><th>Issue</th><th></th></tr>
      ${items.map(c => `<tr data-k="${c.kind}" data-search="${esc(`${c.manuscript_code || ''} ${c.title || ''}`.toLowerCase())}">
        <td>${c.manuscript_code ? `<b>${esc(c.manuscript_code)}</b>${c.version > 1 ? ` <span class="muted">v${c.version}</span>` : ''}<br>` : ''}${esc((c.title || 'Untitled').slice(0, 110))}
          ${state.app.desktop ? `<div>${c.origin === 'desktop' ? badge(c.synced_at ? 'Synced' : 'On this computer', c.synced_at ? 'good' : 'neutral') : badge('From web', 'info')}</div>` : c.origin === 'desktop' ? `<div>${badge('From desktop', 'info')}</div>` : ''}</td>
        <td>${esc(KIND_LABEL[c.kind] || c.kind)}</td>
        <td>${fmtDate(c.created_at)}</td>
        <td>${findings(c)}</td>
        <td>${MS_KINDS.includes(c.kind) && c.kind !== 'citations' ? `<select data-issue="${c.id}" style="width:auto;padding:4px 8px;font-size:12.5px">${issueOptions(c.issue_id)}</select>` : ''}</td>
        <td class="row" style="flex-wrap:nowrap">${c.has_result ? `<a class="btn btn-sm" href="#/check/${c.id}">Open</a>` : '<span class="muted" title="Saved as counts only">counts only</span>'}<button class="btn btn-sm btn-ghost btn-danger" data-del="${c.id}" title="Delete">✕</button></td>
      </tr>`).join('')}
    </table></div>` : '<div class="card empty">Nothing saved yet. Results of every tool appear here.</div>'}`;
  let kind = '';
  const filter = () => {
    const q = $('#q', view).value.toLowerCase();
    $$('#tbl tr[data-k]', view).forEach(tr => (tr.hidden = (kind && tr.dataset.k !== kind) || (q && !tr.dataset.search.includes(q))));
  };
  $('#q', view).oninput = filter;
  $$('[data-k].filter', view).forEach(b => (b.onclick = () => { kind = b.dataset.k; $$('.filter', view).forEach(x => x.classList.toggle('active', x === b)); filter(); }));
  $$('[data-issue]', view).forEach(s => (s.onchange = () => api(`/api/checks/${s.dataset.issue}`, { method: 'PATCH', body: { issueId: s.value || null } }).then(() => toast('Saved')).catch(e => toast(e.message, 'error'))));
  $$('[data-del]', view).forEach(b => (b.onclick = async () => {
    if (!confirm('Delete this saved report?')) return;
    await api(`/api/checks/${b.dataset.del}`, { method: 'DELETE' });
    renderActivity(view);
  }));
}
