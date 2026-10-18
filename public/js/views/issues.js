// views/issues.js - Issue report: summary table of every manuscript checked in an issue (or a period)
import { api, esc, $, $$, badge, toast, download, loadIssues, ICONS } from '../core.js';

export async function renderIssues(view) {
  const issues = await loadIssues();
  view.innerHTML = `
    <div class="page-head"><div><h1>Issue report</h1><p>A summary table of every manuscript checked in an issue: how many references, how many suspicious, which problems. Only the latest version of each manuscript is counted.</p></div></div>
    <div class="grid grid-2">
      <div class="card">
        <h3>Issues</h3>
        <form id="new-issue" class="row" style="margin-bottom:12px"><input id="issue-label" type="text" placeholder='e.g. Vol. 39, No. 6 (Nov 2026)' style="flex:1"><button class="btn btn-primary" type="submit">Add issue</button></form>
        ${issues.length ? `<table class="t">${issues.map(i => `<tr><td><a href="#" data-issue="${i.id}"><b>${esc(i.label)}</b></a></td><td class="num">${i.manuscripts} checks</td><td><button class="btn btn-sm btn-ghost btn-danger" data-del="${i.id}">✕</button></td></tr>`).join('')}</table>` : '<p class="muted">No issues yet. Add one, then assign manuscripts to it when you check them (or from Manuscripts &amp; reports).</p>'}
      </div>
      <div class="card">
        <h3>Period report</h3>
        <p class="muted">All manuscripts you checked in a period — trends in suspicious and not-found references and the most frequent problems.</p>
        <div class="row">${[1, 3, 6, 12].map(m => `<button class="btn" data-months="${m}">Last ${m} month${m > 1 ? 's' : ''}</button>`).join('')}</div>
      </div>
    </div>
    <div id="rep"></div>`;

  $('#new-issue', view).onsubmit = async e => {
    e.preventDefault();
    const label = $('#issue-label', view).value.trim();
    if (!label) return;
    await api('/api/issues', { body: { label } }).catch(err => toast(err.message, 'error'));
    renderIssues(view);
  };
  $$('[data-del]', view).forEach(b => (b.onclick = async () => {
    if (!confirm('Delete this issue? Checks stay saved but are no longer assigned to it.')) return;
    await api(`/api/issues/${b.dataset.del}`, { method: 'DELETE' });
    renderIssues(view);
  }));
  $$('[data-issue]', view).forEach(a => (a.onclick = e => { e.preventDefault(); showReport($('#rep', view), `issue=${a.dataset.issue}`); }));
  $$('[data-months]', view).forEach(b => (b.onclick = () => showReport($('#rep', view), `months=${b.dataset.months}`)));
  if (issues[0]) showReport($('#rep', view), `issue=${issues[0].id}`);
}

async function showReport(el, query) {
  el.innerHTML = '<div class="empty">Loading…</div>';
  try {
    const { label, report: r } = await api(`/api/issue-report?${query}`);
    const t = r.totals;
    el.innerHTML = `
      <div class="card">
        <div class="card-head"><h2>${esc(label)}</h2>
          <div class="row no-print"><button class="btn btn-sm" data-fmt="docx">${ICONS.download} Word</button><button class="btn btn-sm" data-fmt="csv">${ICONS.download} CSV</button><button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print</button></div></div>
        <div class="kpis">
          <div class="kpi"><div class="n">${t.manuscripts}</div><div class="l">Manuscripts</div></div>
          <div class="kpi"><div class="n">${t.references}</div><div class="l">References</div></div>
          <div class="kpi bad"><div class="n">${t.suspicious}</div><div class="l">Suspicious (${t.manuscriptsWithSuspicious} mss)</div></div>
          <div class="kpi bad"><div class="n">${t.retracted}</div><div class="l">Retracted</div></div>
          <div class="kpi warn"><div class="n">${t.miscited}</div><div class="l">Miscited</div></div>
          <div class="kpi warn"><div class="n">${t.missingCitations + t.uncited}</div><div class="l">Citation mismatches</div></div>
          <div class="kpi"><div class="n">${t.avgSelfCitation}%</div><div class="l">Avg. self-citation</div></div>
        </div>
        ${r.rows.length ? `<div class="table-wrap"><table class="t">
          <tr><th>Manuscript</th><th class="num">Ver.</th><th class="num">Refs</th><th class="num">Suspicious</th><th class="num">Retracted</th><th class="num">Miscited</th><th class="num">Missing</th><th class="num">Uncited</th><th class="num">Risky journals</th><th class="num">Self-cit.</th><th>Problems</th></tr>
          ${r.rows.map(x => `<tr><td><b>${esc(x.manuscriptCode || '—')}</b><div class="muted">${esc(x.title.slice(0, 80))}</div></td><td class="num">${x.version}</td><td class="num">${x.references}</td><td class="num">${x.suspicious ? badge(x.suspicious, 'bad') : 0}</td><td class="num">${x.retracted ? badge(x.retracted, 'bad') : 0}</td><td class="num">${x.miscited}</td><td class="num">${x.missingCitations}</td><td class="num">${x.uncited}</td><td class="num">${x.journalFlags}</td><td class="num">${x.selfCitationRate || 0}%</td><td style="font-size:12.5px">${x.problems.slice(0, 4).map(esc).join('<br>') || badge('None', 'good')}</td></tr>`).join('')}
        </table></div>` : '<p class="muted">No manuscripts in this report yet.</p>'}
        ${r.frequentProblems.length ? `<h3 style="margin-top:16px">Most frequent problems</h3><table class="t">${r.frequentProblems.map(p => `<tr><td>${esc(p.problem)}</td><td class="num">${p.manuscripts} manuscript(s)</td></tr>`).join('')}</table>` : ''}
      </div>`;
    $$('[data-fmt]', el).forEach(b => (b.onclick = () => download(`/api/issue-report?${query}&format=${b.dataset.fmt}`).catch(e => toast(e.message, 'error'))));
  } catch (e) { el.innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`; }
}
