// views/getDesktop.js - web portal: download the Windows desktop application (same five modules, own database,
// works offline and synchronises with this platform)
import { api, esc, fmtDate, copyText, ICONS } from '../core.js';

const mb = n => `${(Number(n || 0) / 1048576).toFixed(0)} MB`;

const SAME = [
  ['Five PJPS modules', 'Check Bibliography, Reference Style & PJPS, Citations, Paper Mill Detection and Image Integrity, and the Full Screening Report.'],
  ['Same accounts', 'Sign in with your web platform e-mail and password. The Super Admin decides who may use the desktop application.'],
  ['Your reports everywhere', 'Reports made on the desktop are uploaded to the platform, and web reports appear on the desktop.'],
  ['Datasets on the computer', 'Retraction Watch, Beall’s list, PPS, NLM Catalog, DOAJ, LTWA, Crossref journals, journal index lists and the image-integrity knowledge base are copied to the computer.']
];

const ONLINE = [
  ['Works offline', 'Reading documents, the Citations module, retraction / predatory / index-list checks, PJPS style conversion, the image forensic analysis and viewer, saved reports and exports.'],
  ['Queued until online', 'Database look-ups for new references (Crossref, PubMed, OpenAlex, CORE …) run as soon as the connection returns.'],
  ['Needs the platform', 'Comparison with published PJPS figures, retracted-paper figures and PubMed Central (the image reference databases stay online) and author searches.']
];

export async function renderGetDesktop(view) {
  const d = await api('/api/desktop-app');
  const r = d.release;
  const setup = r?.files.find(f => f.kind === 'setup');
  const portable = r?.files.find(f => f.kind === 'portable');
  view.innerHTML = `
    <div class="dl-hero">
      <div class="dl-art" aria-hidden="true"><div class="scr"><i></i><div><i></i><i></i><i></i><i></i></div></div><div class="stand"></div></div>
      <h1>PJPS Data Integrity System for Windows</h1>
      <p>The complete software as a desktop application: the same five modules as this web portal, with its own database on your computer. It keeps working without internet and synchronises with the platform when you are online.</p>
      <div class="row" style="margin-top:16px">
        ${setup ? `<a class="btn" href="/api/desktop-app/download/setup">${ICONS.desktop} Download installer (${mb(setup.size)})</a>` : '<span class="btn" aria-disabled="true" style="opacity:.75;cursor:default">Not published yet</span>'}
        ${portable ? `<a class="btn btn-ghost" href="/api/desktop-app/download/portable">Portable version (${mb(portable.size)})</a>` : ''}
      </div>
      <div class="meta">${r ? `Version ${esc(r.version)} · published ${fmtDate(r.publishedAt)} · Windows 10 / 11, 64-bit` : 'Windows 10 / 11, 64-bit'}</div>
    </div>
    ${!r ? `<div class="alert alert-info">The desktop application has not been published to this platform yet.${d.storage ? ' The Super Admin publishes it with <code>npm run desktop:publish</code>.' : ' Publishing needs Cloudflare R2 storage (R2_* settings).'}</div>` : ''}
    ${d.allowed ? '' : '<div class="alert alert-warn"><b>Your account is not enabled for the desktop application yet.</b> You can download it, but signing in needs desktop access: ask the Super Admin to tick “Desktop application” on your account.</div>'}
    <div class="grid grid-2">
      <div class="card">
        <h2>Install in three steps</h2>
        <ol class="steps">
          <li>Download and run the installer. Windows may show “Windows protected your PC”: choose <b>More info → Run anyway</b>. The portable version runs without installing.</li>
          <li>When asked for the web platform address, enter
            <div class="row" style="margin-top:6px"><code id="pf-url">${esc(d.platformUrl)}</code><button class="btn btn-sm" id="pf-copy">Copy</button></div></li>
          <li>Sign in with your usual e-mail and password. The first sign-in must be online; the datasets then download in the background (a few minutes).</li>
        </ol>
      </div>
      <div class="card">
        <h2>Web and desktop together</h2>
        ${SAME.map(([t, x]) => `<p><b>${esc(t)}.</b> <span class="muted">${esc(x)}</span></p>`).join('')}
      </div>
    </div>
    <div class="platform-grid">
      ${ONLINE.map(([t, x], i) => `<div class="platform"><h3>${['🟢', '🕓', '🌐'][i]} ${esc(t)}</h3><p class="muted" style="margin:0">${esc(x)}</p></div>`).join('')}
    </div>
    ${r?.notes ? `<div class="card"><h2>What’s new in ${esc(r.version)}</h2><div style="white-space:pre-wrap">${esc(r.notes)}</div></div>` : ''}`;
  view.querySelector('#pf-copy').onclick = () => copyText(d.platformUrl);
}
