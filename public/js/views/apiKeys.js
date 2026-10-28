// views/apiKeys.js - Super Admin: Research Integrity API keys for the PJPS submission software and external journals,
// with the endpoint reference.
import { api, esc, $, $$, toast, badge, fmtDate, modal, copyText } from '../core.js';

export async function renderApiKeys(view) {
  const [d, u] = await Promise.all([api('/api/admin/api-keys'), api('/api/admin/users')]);
  const origin = location.origin;
  view.innerHTML = `
    <div class="page-head"><div><h1>Research Integrity API</h1><p>Lets the PJPS submission software (and, later, other journals) send manuscripts for Integrity Screening and Peer-Review Integrity checks, follow the job, receive the result by webhook and download the evidence-linked PDF report. Each key acts as the account it is issued for and only sees that account's reports.</p></div>
      <div class="row"><button class="btn btn-primary btn-sm" id="new">New API key</button></div></div>
    <div class="card"><h3>Keys</h3>${d.keys.length ? `<div class="table-wrap"><table class="t"><tr><th>Integration</th><th>Key</th><th>Acts as</th><th>Scopes</th><th>Webhook</th><th>Last used</th><th></th></tr>${d.keys.map(k => `<tr>
      <td><b>${esc(k.name)}</b><div class="muted">created ${fmtDate(k.created_at)}</div></td><td><code>${esc(k.prefix)}…</code></td><td>${esc(k.user_name)}<div class="muted">${esc(k.user_email)}</div></td>
      <td>${(k.scopes || []).map(s => badge(s, 'info')).join(' ')}</td><td class="muted">${esc(k.webhook_url || '—')}</td><td class="muted">${k.last_used ? fmtDate(k.last_used) : 'never'}</td>
      <td>${k.revoked ? badge('revoked', 'neutral') : `<button class="btn btn-sm btn-danger" data-revoke="${k.id}">Revoke</button>`}</td></tr>`).join('')}</table></div>` : '<p class="muted">No API keys yet.</p>'}</div>
    <div class="card"><h3>Endpoints</h3>
      <p>Send the key as <code>Authorization: Bearer pjps_…</code> (or <code>X-API-Key</code>). JSON in, JSON out; 60 requests per minute per key.</p>
      <div class="table-wrap"><table class="t">
        <tr><th>Method</th><th>Path</th><th>Scope</th><th>What it does</th></tr>
        <tr><td>GET</td><td><code>/api/v1/ping</code></td><td>—</td><td>Checks the key; returns the account and scopes.</td></tr>
        <tr><td>POST</td><td><code>/api/v1/screenings</code></td><td>screen</td><td>Starts an Integrity Screening. Body: <code>manuscriptCode, title, authors[], affiliations[], abstract, suggestedReviewers, text</code> or <code>fileBase64 + filename</code>, <code>deep</code> (verify references), <code>externalId</code>. Returns <code>202 { jobId, statusUrl }</code>.</td></tr>
        <tr><td>POST</td><td><code>/api/v1/peer-review</code></td><td>peer-review</td><td>Checks reviewers: <code>manuscriptCode, title, authors, affiliations, authorEmails, reviewers: [{ name, email, orcid, institution, report, invitedAt, returnedAt }]</code>.</td></tr>
        <tr><td>GET</td><td><code>/api/v1/jobs/:jobId</code></td><td>reports</td><td>Status and progress; when done, the result summary: risk level, score, recommendation, explanation, signals per dimension, report links.</td></tr>
        <tr><td>GET</td><td><code>/api/v1/reports?manuscriptCode=</code></td><td>reports</td><td>Saved screenings for a manuscript.</td></tr>
        <tr><td>GET</td><td><code>/api/v1/reports/:checkId</code></td><td>reports</td><td>Summary; <code>?format=pdf</code> the confidential PDF report; <code>?full=1</code> every signal with its evidence.</td></tr>
        <tr><td>GET</td><td><code>/api/v1/articles?doi=</code></td><td>monitoring</td><td>Post-publication status of a monitored article (retraction, concern, correction, cites retracted work); without <code>doi</code>, every flagged article.</td></tr>
      </table></div>
      <h4>Webhook</h4>
      <p>When a screening started through the API finishes, the summary is POSTed to the key's webhook URL with <code>"event": "screening.completed"</code> and your <code>externalId</code>. Verify it with the header <code>X-PJPS-Signature: sha256=…</code>: an HMAC-SHA256 of the raw body, keyed with the SHA-256 hex digest of your API key.</p>
      <h4>Example</h4>
      <div class="code-block" id="example">curl -X POST ${esc(origin)}/api/v1/screenings \\
  -H "Authorization: Bearer pjps_YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"manuscriptCode":"PJPS-2026-0412","title":"…","authors":["Ahmad Khan"],"text":"…full manuscript text…","externalId":"submission-991"}'

curl ${esc(origin)}/api/v1/jobs/JOB_ID -H "Authorization: Bearer pjps_YOUR_KEY"</div>
      <button class="btn btn-sm" id="copy-ex" style="margin-top:8px">Copy example</button></div>`;

  $('#copy-ex', view).onclick = () => copyText($('#example', view).textContent);
  $$('[data-revoke]', view).forEach(b => { b.onclick = async () => { await api(`/api/admin/api-keys/${b.dataset.revoke}`, { method: 'DELETE' }); toast('Key revoked'); renderApiKeys(view); }; });
  $('#new', view).onclick = () => modal(`<h3>New API key</h3>
    <div class="field"><label>Integration name</label><input id="k-name" type="text" placeholder="PJPS submission system"></div>
    <div class="field"><label>Acts as account</label><select id="k-user">${u.users.filter(x => x.status === 'active' && x.role !== 'researcher').map(x => `<option value="${x.id}">${esc(x.name)} (${esc(x.email)})</option>`).join('')}</select><div class="hint">Results are saved under this account; use a dedicated editor account for an integration.</div></div>
    <div class="field"><label>Scopes</label>${Object.entries(d.scopes).map(([k, l]) => `<label class="check"><input type="checkbox" data-scope="${k}" checked> ${esc(l)}</label>`).join('')}</div>
    <div class="field"><label>Webhook URL <span class="muted">(optional, https)</span></label><input id="k-hook" type="url" placeholder="https://submission.pjps.pk/integrity-webhook"></div>
    <div class="row"><button class="btn btn-primary" id="k-save">Create key</button><button class="btn" data-close>Cancel</button></div><div id="k-out"></div>`, { onMount: m => {
    $('#k-save', m).onclick = async () => {
      try {
        const r = await api('/api/admin/api-keys', { body: { name: $('#k-name', m).value, userId: $('#k-user', m).value, webhookUrl: $('#k-hook', m).value, scopes: $$('[data-scope]', m).filter(x => x.checked).map(x => x.dataset.scope) } });
        $('#k-save', m).disabled = true;
        $('#k-out', m).innerHTML = `<div class="alert alert-warn" style="margin-top:12px"><b>${esc(r.message)}</b><div class="code-block" style="margin-top:6px">${esc(r.key)}</div><button class="btn btn-sm" id="k-copy" style="margin-top:6px">Copy key</button> <button class="btn btn-sm" data-close>Done</button></div>`;
        $('#k-copy', m).onclick = () => copyText(r.key);
        renderApiKeys(view);
      } catch (e) { toast(e.message, 'error'); }
    };
  } });
}
