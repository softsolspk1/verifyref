// views/decision.js - editor notes and decision record on a saved report (Modules 4, 5 and the Full Screening Report)
import { api, esc, $, toast, fmtDate } from '../core.js';

const OPTIONS = {
  papermill: [['cleared', 'Cleared'], ['investigate', 'Needs investigation'], ['committee', 'Referred to the integrity committee']],
  images: [['cleared', 'Cleared'], ['investigate', 'Needs investigation (ask for original images)'], ['committee', 'Referred to the integrity committee']],
  manuscript: [['proceed', 'Proceed to peer review'], ['return', 'Return to the authors'], ['investigate', 'Investigate'], ['committee', 'Referred to the integrity committee']]
};

/** Render the decision card into el. getExtra() may return { findingMarks } to save with the decision. */
export function decisionCard(el, result, kind, { getExtra } = {}) {
  const d = result.decision || {};
  const opts = OPTIONS[kind] || OPTIONS.papermill;
  if (!result.id) { el.innerHTML = '<div class="card muted">Save the report to record a decision.</div>'; return; }
  el.innerHTML = `<div class="card">
    <div class="card-head"><h3>Editor decision</h3>${d.label ? `<span class="badge b-info">${esc(d.label)}</span>` : '<span class="muted">No decision recorded yet</span>'}</div>
    <div class="grid grid-2">
      <div class="field"><label>Decision</label><select id="dec-choice"><option value="">— Choose —</option>${opts.map(([k, l]) => `<option value="${k}" ${d.decision === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      <div class="field"><label>Notes for the editorial file</label><textarea id="dec-notes" rows="3" placeholder="What you checked, what you asked the authors…">${esc(d.notes || '')}</textarea></div>
    </div>
    <div class="row"><button class="btn btn-primary btn-sm" id="dec-save">Save decision</button>
    ${(result.decisionHistory || []).length ? `<span class="muted">${result.decisionHistory.slice(-3).reverse().map(h => `${esc(h.label || 'Notes')} — ${esc(h.by)}, ${fmtDate(h.at)}`).join(' · ')}</span>` : ''}</div>
  </div>`;
  $('#dec-save', el).onclick = async () => {
    try {
      const body = { decision: $('#dec-choice', el).value || null, notes: $('#dec-notes', el).value, ...(getExtra ? getExtra() : {}) };
      const r = await api(`/api/checks/${result.id}/decision`, { method: 'PUT', body });
      result.decision = r.decision;
      if (r.decision) result.decisionHistory = [...(result.decisionHistory || []).filter(h => h.at !== r.decision.at), r.decision];
      if (body.findingMarks) result.findingMarks = body.findingMarks;
      toast('Decision saved');
      decisionCard(el, result, kind, { getExtra });
    } catch (e) { toast(e.message, 'error'); }
  };
}
