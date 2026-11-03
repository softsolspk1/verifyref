// views/dashboard.js - analytics of the articles checked: Super Admin sees every user, everyone else their own reports
import { api, esc, $, $$, fmtDate, state } from '../core.js';
import { KIND_LABEL } from './activity.js';

const n = v => Number(v || 0).toLocaleString();
const pctOf = (a, b) => (b ? Math.round(a / b * 1000) / 10 : 0);
const RISK_LEVELS = [['LOW', 'Low', 'good'], ['MODERATE', 'Moderate', 'warn'], ['HIGH', 'High', 'bad'], ['CRITICAL', 'Critical', 'crit']];
const RISK_GROUP = { manuscript: 'Full Screening Report', papermill: '4 · Paper Mill', 'peer-review': '4 · Peer-review integrity', images: '5 · Image Integrity' };

/** Reports per day (or per week over long ranges), with every empty day kept so gaps read as zero */
function series(byDay, days) {
  const map = new Map(byDay.map(d => [d.day, d.runs]));
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    out.push({ date: d, runs: map.get(key) || 0 });
  }
  if (days <= 120) return { unit: 'day', points: out };
  const weeks = [];
  for (let i = 0; i < out.length; i += 7) weeks.push({ date: out[i].date, runs: out.slice(i, i + 7).reduce((a, p) => a + p.runs, 0) });
  return { unit: 'week', points: weeks };
}

function columnChart({ unit, points }) {
  const W = 760, H = 220, L = 36, B = 24, T = 10;
  const max = Math.max(1, ...points.map(p => p.runs));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const slot = (W - L) / points.length;
  const bw = Math.max(1, Math.min(18, slot - 2));
  const y = v => T + (H - T - B) * (1 - v / top);
  const ticks = [0, top / 2, top];
  const every = Math.ceil(points.length / 8);
  const label = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `<svg class="dv-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Reports per ${unit}">
    ${ticks.map(t => `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="dv-grid"/><text x="${L - 6}" y="${y(t) + 4}" class="dv-axis" text-anchor="end">${n(Math.round(t))}</text>`).join('')}
    ${points.map((p, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      const h = Math.max(0, H - B - y(p.runs));
      const r = Math.min(4, bw / 2, h);
      const tip = `${unit === 'week' ? 'Week of ' : ''}${label(p.date)}: ${n(p.runs)} report(s)`;
      return `<g data-tip="${esc(tip)}"><rect x="${L + i * slot}" y="${T}" width="${slot}" height="${H - T - B}" fill="transparent"/>
        ${p.runs ? `<path class="dv-bar" d="M${x},${H - B} V${H - B - h + r} Q${x},${H - B - h} ${x + r},${H - B - h} H${x + bw - r} Q${x + bw},${H - B - h} ${x + bw},${H - B - h + r} V${H - B} Z"/>` : ''}</g>`;
    }).join('')}
    <line x1="${L}" x2="${W}" y1="${H - B}" y2="${H - B}" class="dv-base"/>
    ${points.map((p, i) => (i % every === 0 ? `<text x="${L + i * slot + slot / 2}" y="${H - 6}" class="dv-axis" text-anchor="middle">${label(p.date)}</text>` : '')).join('')}
  </svg>`;
}

/** Horizontal bars, one series: label, bar, value */
function barList(rows, { unit = '' } = {}) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return rows.length ? `<div class="dv-bars">${rows.map(r => `<div class="dv-row" data-tip="${esc(`${r.label}: ${n(r.value)}${unit}`)}">
    <span class="dv-label">${esc(r.label)}</span><span class="dv-track"><span class="dv-fill" style="width:${Math.max(r.value ? 1.5 : 0, r.value / max * 100)}%"></span></span><span class="dv-val">${n(r.value)}</span></div>`).join('')}</div>`
    : '<p class="muted">No data in this period.</p>';
}

/** 100% stacked bar with status colours; every segment named in the legend with its count */
function stacked(parts) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (!total) return '<p class="muted">No data in this period.</p>';
  return `<div class="dv-stack">${parts.filter(p => p.value).map(p => `<span class="dv-seg s-${p.tone}" style="flex:${p.value}" data-tip="${esc(`${p.label}: ${n(p.value)} (${pctOf(p.value, total)}%)`)}"></span>`).join('')}</div>
    <div class="dv-legend">${parts.map(p => `<span><i class="s-${p.tone}"></i>${esc(p.label)} <b>${n(p.value)}</b> <span class="muted">${pctOf(p.value, total)}%</span></span>`).join('')}</div>`;
}

function bindTips(view) {
  let tip = $('#dv-tip');
  if (!tip) { tip = document.createElement('div'); tip.id = 'dv-tip'; tip.className = 'dv-tip'; tip.hidden = true; document.body.appendChild(tip); }
  $$('[data-tip]', view).forEach(el => {
    el.onmousemove = e => {
      tip.textContent = el.dataset.tip;
      tip.hidden = false;
      const x = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${x}px`;
      tip.style.top = `${e.clientY - tip.offsetHeight - 10}px`;
    };
    el.onmouseleave = () => (tip.hidden = true);
  });
}

export async function renderDashboard(view) {
  const isAdmin = state.user.role === 'super_admin';
  view.innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><p>${isAdmin ? 'Analytics of every article checked on the platform, by every user.' : 'Analytics of the articles you have checked.'}</p></div>
      <div class="row">${isAdmin ? '<select id="d-user" style="width:auto"><option value="">All users</option></select>' : ''}
      <select id="d-days" style="width:auto"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90" selected>Last 90 days</option><option value="365">Last 12 months</option><option value="1095">Last 3 years</option></select></div></div>
    <div id="d-body"><div class="progress">Loading…</div></div>`;
  let usersLoaded = false;
  const load = async () => {
    const days = parseInt($('#d-days', view).value, 10);
    const d = await api(`/api/dashboard?days=${days}${isAdmin && $('#d-user', view).value ? `&user=${$('#d-user', view).value}` : ''}`);
    if (isAdmin && !usersLoaded) { $('#d-user', view).innerHTML += d.users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join(''); usersLoaded = true; }
    const t = d.totals;
    const checked = t.verified + t.unverified + t.suspicious + t.retracted;
    const risks = Object.entries(d.risk);
    $('#d-body', view).innerHTML = `
      <div class="kpis">
        <div class="kpi"><div class="n">${n(t.articles)}</div><div class="l">Articles checked</div></div>
        <div class="kpi info"><div class="n">${n(t.reports)}</div><div class="l">Reports run</div></div>
        <div class="kpi"><div class="n">${n(t.refs)}</div><div class="l">References checked</div></div>
        <div class="kpi warn"><div class="n">${n(t.suspicious)}</div><div class="l">Suspicious references</div></div>
        <div class="kpi bad"><div class="n">${n(t.retracted)}</div><div class="l">Retracted references</div></div>
        <div class="kpi warn"><div class="n">${n(t.flagged)}</div><div class="l">Reports with flags · ${pctOf(t.flagged, t.reports)}%</div></div>
        ${isAdmin ? `<div class="kpi good"><div class="n">${n(t.users)}</div><div class="l">Active users</div></div>` : ''}
      </div>
      <div class="card"><h3>Reports over time</h3><p class="muted" style="margin-top:-4px">Reports per ${days > 120 ? 'week' : 'day'}, last ${days} days</p>${columnChart(series(d.byDay, days))}</div>
      <div class="grid grid-2">
        <div class="card"><h3>Reports by module</h3>${barList(d.byKind.map(k => ({ label: KIND_LABEL[k.kind] || k.kind, value: k.runs })), { unit: ' report(s)' })}</div>
        <div class="card"><h3>Reference verification outcome</h3>${stacked([
          { label: 'Verified', value: t.verified, tone: 'good' }, { label: 'Unverified / partial', value: t.unverified, tone: 'neutral' },
          { label: 'Suspicious', value: t.suspicious, tone: 'warn' }, { label: 'Retracted', value: t.retracted, tone: 'bad' }])}
          <p class="muted" style="margin-top:10px">${n(checked)} reference verdicts across all reports in this period.</p></div>
      </div>
      <div class="grid grid-2">
        <div class="card"><h3>Integrity risk levels</h3>${risks.length ? risks.map(([g, r]) => `<div style="margin-bottom:14px"><div style="font-weight:600;margin-bottom:6px">${esc(RISK_GROUP[g] || g)}</div>
          ${stacked(RISK_LEVELS.map(([k, label, tone]) => ({ label, value: r[k] || 0, tone })))}</div>`).join('') : '<p class="muted">No paper-mill or image-integrity reports in this period.</p>'}</div>
        <div class="card"><h3>Citation &amp; journal issues</h3>${barList([
          { label: 'Miscited references', value: t.miscited }, { label: 'Missing in-text citations', value: t.missing_citations },
          { label: 'Uncited references', value: t.uncited_references }, { label: 'Journal flags', value: t.journal_flags }].filter((r, i, a) => a.some(x => x.value)))}</div>
      </div>
      <div class="grid ${isAdmin ? 'grid-2' : ''}">
        <div class="card"><h3>By module</h3><div class="table-wrap"><table class="t"><tr><th>Module</th><th class="num">Reports</th><th class="num">References</th><th class="num">Suspicious</th><th class="num">Retracted</th></tr>
          ${d.byKind.map(k => `<tr><td>${esc(KIND_LABEL[k.kind] || k.kind)}</td><td class="num">${n(k.runs)}</td><td class="num">${n(k.refs)}</td><td class="num">${n(k.suspicious)}</td><td class="num">${n(k.retracted)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No reports in this period.</td></tr>'}
          ${d.byKind.length > 1 ? `<tr class="total"><td>Total</td><td class="num">${n(t.reports)}</td><td class="num">${n(t.refs)}</td><td class="num">${n(t.suspicious)}</td><td class="num">${n(t.retracted)}</td></tr>` : ''}</table></div></div>
        ${isAdmin ? `<div class="card"><h3>By user</h3><div class="table-wrap"><table class="t"><tr><th>User</th><th class="num">Reports</th><th class="num">References</th><th class="num">Flags</th><th>Last report</th></tr>
          ${d.byUser.map(u => `<tr><td>${esc(u.name)}<div class="muted">${esc(u.email)}</div></td><td class="num">${n(u.runs)}</td><td class="num">${n(u.refs)}</td><td class="num">${n(u.suspicious + u.retracted)}</td><td>${fmtDate(u.last_run)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No reports in this period.</td></tr>'}</table></div></div>` : ''}
      </div>
      <div class="card"><div class="card-head"><h3 style="margin:0">Most-flagged articles</h3>${isAdmin ? '<a href="#/reports">All reports →</a>' : '<a href="#/activity">Saved reports →</a>'}</div>
        <div class="table-wrap"><table class="t"><tr><th>Date</th>${isAdmin ? '<th>User</th>' : ''}<th>Module</th><th>Manuscript / title</th><th class="num">Suspicious</th><th class="num">Retracted</th><th class="num">Miscited</th><th></th></tr>
        ${d.topFlagged.map(c => `<tr><td>${fmtDate(c.created_at)}</td>${isAdmin ? `<td>${esc(c.user_name)}</td>` : ''}<td>${esc(KIND_LABEL[c.kind] || c.kind)}</td>
          <td>${c.manuscript_code ? `<b>${esc(c.manuscript_code)}</b> ` : ''}${esc((c.title || 'Untitled').slice(0, 90))}</td><td class="num">${n(c.suspicious)}</td><td class="num">${n(c.retracted)}</td><td class="num">${n(c.miscited)}</td>
          <td><a class="btn btn-sm" href="#/check/${c.id}">Open</a></td></tr>`).join('') || `<tr><td colspan="${isAdmin ? 8 : 7}" class="muted">No flagged articles in this period.</td></tr>`}</table></div></div>`;
    bindTips(view);
  };
  const reload = () => load().catch(e => ($('#d-body', view).innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`));
  $('#d-days', view).onchange = reload;
  if (isAdmin) $('#d-user', view).onchange = reload;
  await reload();
}
