// core.js - API client, DOM helpers, toasts, modals, job polling, downloads

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const state = { user: null, app: null, issues: [] };

export async function api(url, opts = {}) {
  const init = { method: opts.method || (opts.body || opts.form ? 'POST' : 'GET'), headers: {} };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, init);
  if (r.status === 401) { location.href = '/'; throw new Error('Signed out'); }
  if (r.status === 413) throw new Error('File too large to upload (limit 100 MB). Paste the text instead, or save the document without images.');
  const data = await r.json().catch(() => ({ success: false, message: `Server error (${r.status})` }));
  if (!r.ok || data.success === false) throw new Error(data.message || `Request failed (${r.status})`);
  return data;
}

/** Download a file from a GET or POST endpoint */
export async function download(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.message || 'Download failed');
  }
  const blob = await r.blob();
  const name = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'download';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

export function modal(html, { onMount } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  const close = () => back.remove();
  back.addEventListener('click', e => { if (e.target === back || e.target.closest('[data-close]')) close(); });
  document.body.appendChild(back);
  if (onMount) onMount(back.querySelector('.modal'), close);
  return close;
}

export function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard')).catch(() => toast('Copy failed', 'error'));
}

/** Poll a background job until it finishes; renders progress into `el` */
export async function runJob(jobId, el, title = 'Working…') {
  el.innerHTML = `<div class="progress"><h3>${esc(title)}</h3><div class="progress-bar"><span style="width:2%"></span></div><div class="muted step">Starting…</div></div>`;
  const bar = $('.progress-bar span', el), step = $('.step', el);
  while (true) {
    await new Promise(r => setTimeout(r, 1200));
    const j = await api(`/api/jobs/${jobId}`);
    bar.style.width = `${Math.max(2, j.progress)}%`;
    step.textContent = j.step || '';
    if (j.status === 'done') { el.innerHTML = ''; return j.result; }
    if (j.status === 'error') { el.innerHTML = ''; throw new Error(j.error || 'The job failed'); }
  }
}

/**
 * Start a tool run (POST) and wait for it. Returns the result, or null when the desktop queued it for later
 * (the message is shown in `el`).
 */
export async function startJob(url, { body, form } = {}, el, title) {
  const d = await api(url, form ? { form } : { body });
  if (d.queued) {
    el.innerHTML = `<div class="alert alert-info"><b>Queued for when you are back online.</b> ${esc(d.message)} <a href="#/desktop">View the offline queue</a></div>`;
    return null;
  }
  return runJob(d.jobId, el, title);
}

export const hasModule = key => !!state.user?.permissions?.includes(key);

/** <option>s for the citation style picker, grouped by kind */
export function styleOptions(selected = 'apa7') {
  const groups = { 'author-date': 'Author–date', numeric: 'Numbered', note: 'Notes (footnotes)' };
  return Object.entries(groups).map(([k, label]) => `<optgroup label="${label}">${(state.app?.styles || []).filter(s => s.kind === k).map(s => `<option value="${s.key}" ${s.key === selected ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</optgroup>`).join('');
}

/** Download a file produced by a job (converted Word document) */
export const downloadJobFile = jobId => download(`/api/jobs/${jobId}/file`);

export const badge = (text, tone = 'neutral') => `<span class="badge b-${tone}">${esc(text)}</span>`;
export const sevTone = s => ({ high: 'bad', medium: 'warn', low: 'neutral', info: 'info' }[s] || 'neutral');
export const fmtDate = d => (d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
/** Warning shown on a report when a reference dataset (Retraction Watch, Beall, Problematic Paper Screener) was empty when it was made */
export const datasetBanner = r => (r?.datasets?.warning ? `<div class="alert alert-warn no-print"><b>Reference datasets incomplete.</b> ${esc(r.datasets.warning)}</div>` : '');
export const pct = (n, d) => (d ? Math.round(n / d * 100) : 0);

export async function loadIssues() {
  const d = await api('/api/issues');
  state.issues = d.issues;
  return d.issues;
}

export function issueOptions(selected) {
  return `<option value="">— No issue —</option>${state.issues.map(i => `<option value="${i.id}" ${String(i.id) === String(selected) ? 'selected' : ''}>${esc(i.label)}</option>`).join('')}`;
}

/**
 * S1 - upload once, reuse in every module. The manuscript chosen in any module is remembered for the session; every other
 * module page offers it with one click (it is put into that page's own file input, so each module handles it as usual).
 */
export function shareManuscript(view) {
  const input = $('#file', view);
  const zone = $('#dz', view);
  if (!input || !zone) return;
  const remember = f => { if (f && /\.(docx?|pdf|odt|rtf|txt)$/i.test(f.name)) { state.sharedFile = f; paint(); } };
  view.addEventListener('change', e => { if (e.target === input && input.files[0]) remember(input.files[0]); }, true);
  view.addEventListener('drop', e => { if (zone.contains(e.target) && e.dataTransfer?.files[0]) remember(e.dataTransfer.files[0]); }, true);
  let bar = null;
  function paint() {
    if (bar) bar.remove();
    bar = null;
  }
  const f = state.sharedFile;
  if (!f || !new RegExp('\\.(' + (input.accept || '').replace(/\./g, '').split(',').join('|') + ')$', 'i').test(f.name)) return;
  bar = document.createElement('div');
  bar.className = 'alert alert-info shared-bar';
  bar.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px';
  bar.innerHTML = `<span>Manuscript already uploaded in this session: <b>${esc(f.name)}</b></span><button class="btn btn-sm btn-primary" type="button">Use it here</button><button class="btn btn-sm btn-ghost" type="button">Forget</button>`;
  const [use, forget] = bar.querySelectorAll('button');
  use.onclick = () => {
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    bar.remove();
  };
  forget.onclick = () => { state.sharedFile = null; bar.remove(); };
  const card = zone.closest('.card') || zone;
  card.parentNode.insertBefore(bar, card);
}

/** Wire a dropzone + hidden file input; calls onFile(file) */
export function dropzone(zone, input, onFile) {
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
}

export const ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
  papermill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l9 4v6c0 5-4 9-9 10-5-1-9-5-9-10V6z"/><path d="M12 8v5M12 16h.01"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  manuscript: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>',
  refs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  cite: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v7a4 4 0 0 1-4 4"/></svg>',
  journal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/></svg>',
  reviewers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2M16 3.1a4 4 0 0 1 0 7.8M22 21v-2a4 4 0 0 0-3-3.9"/></svg>',
  report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/></svg>',
  history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
  issue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h8M8 18h5"/></svg>',
  admin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  print: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
  style: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>',
  verify: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11l2 2 4-4"/></svg>',
  evidence: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>',
  format: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
  finder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><circle cx="13" cy="10" r="3"/><path d="M15.2 12.2L17 14"/></svg>',
  conference: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
  assistant: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  author: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>',
  data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.7-4 3-9 3s-9-1.3-9-3M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/></svg>',
  sync: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>'
};
