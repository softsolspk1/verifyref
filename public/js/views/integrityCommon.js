// views/integrityCommon.js - pieces shared by the Integrity Suite screens: risk banner with the score, the score
// explanation, a dimension's signals with their evidence, and "open a case" from a report.
import { api, esc, badge, toast } from '../core.js';

export const SEV_LABEL = { high: 'Strong', medium: 'Moderate', low: 'Weak' };
const sevTone = s => ({ high: 'bad', medium: 'warn', low: 'neutral' }[s] || 'neutral');

export function riskBanner(risk, title = 'Integrity risk', disclaimer = '') {
  return `<div class="risk-banner risk-${esc(risk.level.toLowerCase())}"><div class="risk-level">${esc(risk.level)}<span class="risk-score">${risk.score}/100</span></div>
    <div><b>${esc(title)}</b> · ${risk.strongSignals} strong signal(s) · ${risk.coverage ? `${risk.coverage.checked} of ${risk.coverage.total} dimensions` : ''}
    <div style="margin-top:4px">${esc(risk.recommendation || '')}</div>${disclaimer ? `<div class="muted" style="margin-top:4px">${esc(disclaimer)}</div>` : ''}</div></div>`;
}

export function explanationCard(risk) {
  return `<div class="card"><div class="card-head"><h3>Why this score</h3><span class="muted">Every point traced to a signal</span></div>
    <ul class="explain">${risk.explanation.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <details style="margin-top:8px"><summary class="muted">How the score is calculated</summary><p class="muted" style="margin:6px 0 0">${esc(risk.method || '')}</p></details></div>`;
}

export function signalList(signals) {
  if (!signals?.length) return '<p class="muted">No signal found.</p>';
  return signals.map(s => `<div class="flag ${esc(s.severity)}"><div style="flex:1">
    <div class="msg">${badge(SEV_LABEL[s.severity] || s.severity, sevTone(s.severity))} ${esc(s.title)} <span class="muted">· weight ${s.weight}</span></div>
    ${s.note ? `<div class="guide">${esc(s.note)}</div>` : ''}
    ${(s.evidence || []).length ? `<details ${s.severity === 'high' ? 'open' : ''}><summary class="muted">Evidence (${s.evidence.length})</summary><ul class="evidence">${s.evidence.map(e => `<li>${esc(e.text)}${e.quote ? `<div class="quote">“…${esc(e.quote)}…”</div>` : ''}${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}${e.link ? ` <a href="${esc(e.link)}" target="_blank" rel="noopener">source</a>` : ''}${e.checkId ? ` <a href="#/check/${e.checkId}">open report</a>` : ''}</li>`).join('')}</ul></details>` : ''}
  </div></div>`).join('');
}

/** Button handler: open an integrity case from a saved report */
export async function openCase(checkId) {
  try {
    const r = await api('/api/cases', { body: { checkIds: [checkId] } });
    toast(`Case #${r.case.id} opened`);
    location.hash = `#/cases/${r.case.id}`;
  } catch (e) { toast(e.message, 'error'); }
}
