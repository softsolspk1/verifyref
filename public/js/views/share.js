// views/share.js - "Shared link" for a Module 4 / Module 5 report: a read-only link to its confidential PDF that
// expires (1-30 days) and can be revoked; for a colleague without an account (e.g. the integrity committee).
import { api, esc, $, modal, toast, copyText, fmtDate } from '../core.js';

export const shareButton = r => (r.id ? '<button class="btn btn-sm" id="share">Shared link</button>' : '');

export function wireShare(el, r) {
  const btn = $('#share', el);
  if (!btn) return;
  btn.onclick = () => modal(`
    <div class="card-head"><h2>Shared link</h2><button class="btn btn-sm btn-ghost" data-close>✕</button></div>
    <div class="alert alert-warn">Anyone who has the link can open the confidential PDF of this report until it expires. Send it only to the people who need it (for example the integrity committee) — never to the authors or reviewers.</div>
    <div id="sh-body"></div>`, {
    onMount(m) {
      const url = s => `${location.origin}/api/shared/${s.token}`;
      const paint = () => {
        const s = r.share;
        $('#sh-body', m).innerHTML = s && new Date(s.expires) > new Date()
          ? `<div class="field"><label>Link</label><input type="text" readonly value="${esc(url(s))}" id="sh-url"></div>
             <p class="muted">Created by ${esc(s.by)} · valid until ${fmtDate(s.expires)}</p>
             <div class="row"><button class="btn btn-sm btn-primary" id="sh-copy">Copy link</button><button class="btn btn-sm btn-danger" id="sh-revoke">Revoke</button></div>`
          : `<div class="row"><label class="muted">Valid for <select id="sh-days"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label>
             <button class="btn btn-sm btn-primary" id="sh-make">Create link</button></div>`;
        const make = $('#sh-make', m);
        if (make) make.onclick = async () => {
          make.disabled = true;
          try { const out = await api(`/api/checks/${r.id}/share`, { body: { days: +$('#sh-days', m).value } }); r.share = out.share; paint(); copyText(url(out.share)); } catch (e) { toast(e.message, 'error'); make.disabled = false; }
        };
        const cp = $('#sh-copy', m);
        if (cp) cp.onclick = () => copyText(url(r.share));
        const rv = $('#sh-revoke', m);
        if (rv) rv.onclick = async () => {
          try { await api(`/api/checks/${r.id}/share`, { method: 'DELETE' }); delete r.share; paint(); toast('The link no longer works'); } catch (e) { toast(e.message, 'error'); }
        };
      };
      paint();
    }
  });
}
