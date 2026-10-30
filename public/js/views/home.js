// views/home.js - dashboard built around the five PJPS modules and the Full Screening Report
import { api, esc, $, hasModule, fmtDate, badge, ICONS, state } from '../core.js';

const CARDS = [
  { path: '/manuscript', module: 'manuscript', icon: 'manuscript', title: 'Screen a new submission — all 5 modules at once', text: 'One upload runs Modules 1 to 4 (and attaches a Module 5 image report) and gives a front-page summary with a desk-review recommendation: proceed / return to authors / investigate.', wide: true },
  { path: '/references', module: 'references', icon: 'refs', title: '1 · Check Bibliography', text: 'Is every reference real, correct and not retracted? Every reference searched in all databases (13 scholarly databases, plus Google Scholar and Google when set up), DOIs, Retraction Watch, links, reference age, self-citation, predatory journals, duplicates. Editors: monitoring of published PJPS articles for retractions, corrections and concerns.' },
  { path: '/restyle', module: 'restyle', icon: 'style', title: '2 · Reference Style & PJPS', text: 'Rule-by-rule PJPS style compliance, then conversion of citations and the reference list — in Word as Track Changes.' },
  { path: '/citations', module: 'citations', icon: 'cite', title: '3 · Citations', text: 'In-text citations against the reference list, claim support from the cited sources, citation pattern flags and the author letter.' },
  { path: '/papermill', module: 'papermill', icon: 'papermill', title: '4 · Paper Mill Detection', text: 'Paper-mill signals plus plagiarism and text similarity, AI-written text, research data, pharmaceutical validation, ethics, authors, submission networks and one explained risk score; peer-review integrity; cases and dashboard.' },
  { path: '/images', module: 'images', icon: 'image', title: '5 · Image Integrity', text: 'Duplicated, rotated, mirrored, cropped, cloned, manipulated or AI-generated figures, chart reuse and re-use of earlier PJPS figures, with a forensic viewer.' }
];

const KIND_LABEL = { manuscript: 'Full Screening', references: 'Bibliography', restyle: 'Style', citations: 'Citations', papermill: 'Paper mill', images: 'Images', verify: 'Claim support', integrity: 'Paper mill', 'peer-review': 'Peer review' };

export async function renderHome(view) {
  const cards = CARDS.filter(c => hasModule(c.module));
  view.innerHTML = `
    <div class="page-head"><div><h1>${esc(state.app?.homeJournal?.name || 'PJPS')} — manuscript screening</h1>
      <p>Welcome, ${esc(state.user.name)}. Choose a module, or run the Full Screening Report to check a new submission with everything at once.</p></div></div>
    <div class="module-grid">${cards.map(c => `<a class="module-card ${c.wide ? 'wide' : ''}" href="#${c.path}"><div class="module-icon">${ICONS[c.icon]}</div><div><h3>${esc(c.title)}</h3><p>${esc(c.text)}</p></div></a>`).join('')}</div>
    ${!cards.length ? '<div class="card empty">No modules are enabled for your account. Ask the Super Admin.</div>' : ''}
    <div class="card"><div class="card-head"><h2>Recent reports</h2><a href="#/activity">All saved reports →</a></div><div id="recent" class="muted">Loading…</div></div>`;
  try {
    const d = await api('/api/checks?kind=manuscript,references,restyle,citations,papermill,images,integrity,peer-review');
    const rows = d.checks.slice(0, 12);
    $('#recent', view).innerHTML = rows.length ? `<div class="table-wrap"><table class="t"><tr><th>Date</th><th>Module</th><th>Manuscript</th><th>Findings</th></tr>${rows.map(r => `<tr>
      <td>${fmtDate(r.created_at)}</td><td>${badge(KIND_LABEL[r.kind] || r.kind, 'info')}</td>
      <td>${r.has_result ? `<a href="#/check/${r.id}">` : ''}${esc(r.manuscript_code || '')}${r.manuscript_code && r.title ? ' — ' : ''}${esc((r.title || '').slice(0, 90))}${r.has_result ? '</a>' : ''}</td>
      <td class="muted">${esc((r.problems || []).slice(0, 2).join('; ') || '—')}</td></tr>`).join('')}</table></div>` : '<p>No reports yet.</p>';
  } catch (e) {
    $('#recent', view).textContent = e.message;
  }
}
