// views/citations.js - Module 3 Citations: A. in-text citations <-> reference list, B. claim <-> source support,
// C. citation pattern flags, and the author letter (English / Urdu) the editor previews before sending.
import { api, esc, $, $$, toast, startJob, download, badge, ICONS, copyText, hasModule, fmtDate, datasetBanner } from '../core.js';
import { renderVerifyResult } from './verify.js';

export function renderCitations(view) {
  let manuscript = null, sources = [];
  view.innerHTML = `
    <div class="page-head"><div><h1>Module 3 — Citations</h1>
      <p>Checks that in-text citations and the reference list match (missing, never cited, year or spelling differences, ambiguous author–year, wrong “et al.”, numbering), whether each cited source really supports its claim (uploaded PDFs, open-access full text or abstracts, with the supporting passage quoted), and the citation pattern (self-citation, stacking on one journal or author group, citation blocks). Runs on the PJPS server; no manuscript text is sent to an outside AI.</p></div></div>
    <div id="form-area">
      <div class="card">
        <h3>1. Manuscript</h3>
        <div class="dropzone" id="dz"><input type="file" id="file" accept=".pdf,.docx,.doc,.txt,.odt,.rtf" hidden>
          <div><strong>Upload the manuscript</strong> (text and reference list) — Word, PDF, ODT, RTF or text</div></div>
        <div id="file-info" class="alert alert-info" hidden style="margin-top:12px"></div>
        <div class="field" style="margin-top:12px"><label for="paste">Or paste the full text including the References section</label><textarea id="paste" rows="6" class="mono"></textarea></div>
        <div class="grid grid-2">
          <div class="field"><label for="code">Manuscript ID</label><input id="code" type="text" placeholder="e.g. PJPS-2026-0412"></div>
          <div class="field"><label for="title">Title <span class="muted">(detected when empty)</span></label><input id="title" type="text"></div>
        </div>
        <div class="field"><label for="authors">Authors, one per line <span class="muted">(for self-citation; detected when empty)</span></label><textarea id="authors" rows="3"></textarea></div>
      </div>
      <div class="card">
        <h3>2. Claim support</h3>
        <label class="check"><input type="checkbox" id="claims" checked> Check that each cited source supports its claim (takes 1–5 minutes)</label>
        <p class="muted" style="margin:6px 0">Optional: upload PDFs of paywalled sources for a full-text check — they are linked to references by DOI or title.</p>
        <div class="dropzone" id="dz2"><input type="file" id="files" accept=".pdf,.docx,.txt" multiple hidden><div><strong>Add source PDFs</strong> — up to 40 files</div></div>
        <div id="src-list" style="margin-top:10px"></div>
      </div>
      <div class="card row"><label class="check" style="margin:0"><input type="checkbox" id="save" checked> Save the report to My Activity</label><span class="spacer"></span><button class="btn btn-primary" id="run">Check citations</button></div>
    </div>
    <div id="progress"></div><div id="result"></div>`;

  const fileInput = $('#file', view), srcInput = $('#files', view);
  $('#dz', view).onclick = () => fileInput.click();
  fileInput.onchange = () => { if (fileInput.files[0]) { manuscript = fileInput.files[0]; const i = $('#file-info', view); i.hidden = false; i.textContent = `${manuscript.name} ready.`; const code = (manuscript.name.match(/PJPS[-_\s]?\d{4}[-_\s]?\d{2,5}/i) || [])[0]; if (code && !$('#code', view).value) $('#code', view).value = code.toUpperCase().replace(/[_\s]/g, '-'); } fileInput.value = ''; };
  $('#dz', view).addEventListener('dragover', e => e.preventDefault());
  $('#dz', view).addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) { manuscript = e.dataTransfer.files[0]; const i = $('#file-info', view); i.hidden = false; i.textContent = `${manuscript.name} ready.`; } });
  const showSources = () => { $('#src-list', view).innerHTML = sources.length ? `<div class="chips">${sources.map((f, i) => `<span class="chip">${esc(f.name)} <a href="#" data-rm="${i}">✕</a></span>`).join('')}</div>` : ''; $$('[data-rm]', view).forEach(a => (a.onclick = e => { e.preventDefault(); sources.splice(+a.dataset.rm, 1); showSources(); })); };
  $('#dz2', view).onclick = () => srcInput.click();
  srcInput.onchange = () => { sources = [...sources, ...srcInput.files].slice(0, 40); srcInput.value = ''; showSources(); };
  $('#dz2', view).addEventListener('dragover', e => e.preventDefault());
  $('#dz2', view).addEventListener('drop', e => { e.preventDefault(); sources = [...sources, ...e.dataTransfer.files].slice(0, 40); showSources(); });

  $('#run', view).onclick = async () => {
    const text = $('#paste', view).value.trim();
    if (!manuscript && !text) return toast('Upload or paste the manuscript first.', 'error');
    const fd = new FormData();
    if (manuscript) fd.append('manuscript', manuscript); else fd.append('text', text);
    for (const s of sources) fd.append('sources', s);
    fd.append('title', $('#title', view).value);
    fd.append('manuscriptCode', $('#code', view).value);
    fd.append('authors', $('#authors', view).value);
    fd.append('claims', $('#claims', view).checked);
    fd.append('save', $('#save', view).checked);
    $('#form-area', view).hidden = true;
    try {
      const r = await startJob('/api/citations', { form: fd }, $('#progress', view), 'Checking citations');
      if (r) renderCitationsResult($('#result', view), r, { again: () => renderCitations(view) });
    } catch (e) {
      toast(e.message, 'error');
      $('#form-area', view).hidden = false;
    }
  };
}

const sec = (title, items, render, tone = 'warn') => `<div class="card"><div class="card-head"><h3>${title}</h3>${badge(items.length, items.length ? tone : 'good')}</div>${items.length ? render(items) : '<p class="muted">None found.</p>'}</div>`;

function consistencyTab(body, c, refs) {
  if (!c || c.error) { body.innerHTML = `<div class="alert alert-warn">${esc(c?.error || 'Not checked.')}</div>`; return; }
  const s = c.summary;
  const refText = i => esc((refs.find(r => r.index === i)?.raw || '').slice(0, 200));
  const ctx = (x, para) => (x ? `<div class="muted">${para ? `<b>Paragraph ${para}</b> · ` : ''}…${esc(x)}…</div>` : '');
  body.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="n">${s.system === 'numeric' ? 'Numbered' : 'Author–year'}</div><div class="l">Citation style</div></div>
      <div class="kpi"><div class="n">${s.citations}</div><div class="l">In-text citations</div></div>
      <div class="kpi good"><div class="n">${s.citedReferences}/${s.references}</div><div class="l">References cited</div></div>
      <div class="kpi ${s.missing ? 'bad' : ''}"><div class="n">${s.missing}</div><div class="l">Missing from list</div></div>
      <div class="kpi ${s.uncited ? 'warn' : ''}"><div class="n">${s.uncited}</div><div class="l">Never cited</div></div>
      <div class="kpi ${s.etAlIssues ? 'warn' : ''}"><div class="n">${s.etAlIssues || 0}</div><div class="l">“et al.” problems</div></div>
    </div>
    ${sec('Cited in the text but missing from the reference list', c.missing, items => `<table class="t">${items.map(m => `<tr><td><b>${esc(m.citation)}</b>${m.count > 1 ? ` <span class="muted">×${m.count}</span>` : ''}</td><td>${esc(m.reason)}${ctx(m.context, m.para)}</td></tr>`).join('')}</table>`, 'bad')}
    ${sec('In the reference list but never cited', c.uncited, items => `<table class="t">${items.map(u => `<tr><td class="num">${u.index}</td><td>${esc(u.raw)}</td></tr>`).join('')}</table>`)}
    ${c.yearMismatch ? sec('Year differs between the text and the list', c.yearMismatch, items => `<table class="t">${items.map(y => `<tr><td><b>${esc(y.citation)}</b></td><td>${esc(y.message)}${ctx(y.context, y.para)}</td></tr>`).join('')}</table>`) : ''}
    ${c.spelling?.length ? sec('Author name spelled differently in the text and the list', c.spelling, items => `<table class="t">${items.map(y => `<tr><td><b>${esc(y.citation)}</b></td><td>${esc(y.message)}${ctx(y.context, y.para)}</td></tr>`).join('')}</table>`, 'warn') : ''}
    ${sec('Ambiguous citations', c.ambiguous, items => `<table class="t">${items.map(a => `<tr><td><b>${esc(a.citation)}</b></td><td>${esc(a.message)}${a.candidates.map(i => `<div class="muted">[${i}] ${refText(i)}</div>`).join('')}</td></tr>`).join('')}</table>`)}
    ${sec('Wrong use of “et al.”', c.etAlIssues || [], items => `<table class="t">${items.map(e => `<tr><td><b>${esc(e.citation)}</b></td><td>${esc(e.message)}${ctx(e.context)}</td></tr>`).join('')}</table>`)}
    ${sec('Citation blocks (many references cited at once)', c.blocks || [], items => `<table class="t">${items.map(b => `<tr><td><b>${esc(b.citation)}</b></td><td>${esc(b.message)}${ctx(b.context)}</td></tr>`).join('')}</table>`)}
    ${sec(s.system === 'numeric' ? 'Numbering order (numbered in order of first citation)' : 'Alphabetical order of the reference list', c.orderIssues, items => `<ul>${items.map(o => `<li>${esc(o.message)}</li>`).join('')}</ul>`)}
    ${c.numberingIssues?.length ? sec('Reference list numbering', c.numberingIssues, items => `<ul>${items.map(o => `<li>${esc(o)}</li>`).join('')}</ul>`) : ''}`;
}

function patternTab(body, p) {
  const s = p.summary;
  body.innerHTML = `
    ${!p.manuscriptAuthors.length ? '<div class="alert alert-warn">No author names were found, so self-citation could not be measured. Enter the authors and run again.</div>' : ''}
    <div class="kpis">
      <div class="kpi ${s.selfCitationRate >= 25 ? 'bad' : s.selfCitationRate >= 15 ? 'warn' : 'good'}"><div class="n">${s.selfCitationRate}%</div><div class="l">Self-citation (${s.selfCitations})</div></div>
      <div class="kpi ${s.authorConcentration ? 'warn' : ''}"><div class="n">${s.authorConcentration}</div><div class="l">Author piles</div></div>
      <div class="kpi ${s.journalConcentration ? 'warn' : ''}"><div class="n">${s.journalConcentration}</div><div class="l">Journal piles</div></div>
      <div class="kpi"><div class="n">${s.homeJournalCitations}</div><div class="l">PJPS citations (${s.homeJournalRecent} recent)</div></div>
    </div>
    <div class="card"><h3>What to look at</h3>${p.flags.length ? p.flags.map(f => `<div class="flag ${f.severity}"><div><div class="msg">${esc(f.message)}</div><div class="guide">${esc(f.guidance)}</div></div></div>`).join('') : '<div class="alert alert-good">No unusual citation pattern found.</div>'}</div>
    ${p.selfCitation.refs.length ? `<div class="card"><h3>Self-citations</h3><table class="t"><tr><th>#</th><th>Reference</th><th>Manuscript author(s)</th></tr>${p.selfCitation.refs.map(x => `<tr><td class="num">${x.index}</td><td>${esc(x.title || '')}${x.year ? ` (${x.year})` : ''}</td><td>${esc(x.authors.join(', '))}</td></tr>`).join('')}</table></div>` : ''}`;
}

async function letterTab(body, r) {
  if (!r.id) { body.innerHTML = '<div class="alert alert-info">Save the report to prepare the author letter.</div>'; return; }
  if (!hasModule('reports')) { body.innerHTML = '<div class="alert alert-info">Author letters are prepared by editors.</div>'; return; }
  body.innerHTML = `<div class="card"><div class="row"><div class="seg"><button class="active" data-lang="en">English</button><button data-lang="ur">اردو</button></div><span class="spacer"></span><button class="btn btn-sm" id="l-copy">${ICONS.copy} Copy</button><button class="btn btn-sm" id="l-docx">${ICONS.download} Word</button></div>
    <p class="muted">Preview and edit the letter before sending it. Nothing is sent automatically.</p><textarea id="l-text" rows="22" class="mono" style="width:100%"></textarea></div>`;
  let lang = 'en';
  const load = async () => { const d = await api(`/api/checks/${r.id}/letter?lang=${lang}`); const t = $('#l-text', body); t.value = d.letter.text; t.dir = d.letter.rtl ? 'rtl' : 'ltr'; };
  $$('[data-lang]', body).forEach(b => (b.onclick = () => { lang = b.dataset.lang; $$('[data-lang]', body).forEach(x => x.classList.toggle('active', x === b)); load().catch(e => toast(e.message, 'error')); }));
  $('#l-copy', body).onclick = () => copyText($('#l-text', body).value);
  $('#l-docx', body).onclick = () => download(`/api/checks/${r.id}/letter?lang=${lang}&format=docx`).catch(e => toast(e.message, 'error'));
  load().catch(e => toast(e.message, 'error'));
}

export function renderCitationsResult(el, r, { again } = {}) {
  const s = r.summary;
  const refs = r.references?.results || [];
  el.innerHTML = `
    <div class="page-head"><div><h1>${esc(r.meta?.title || 'Citations')}</h1><p>${r.meta?.manuscriptCode ? `<b>${esc(r.meta.manuscriptCode)}</b> · ` : ''}${fmtDate(r.createdAt)} · ${s.references} references · ${s.citations} in-text citations</p></div>
      <div class="row no-print"><button class="btn btn-sm" id="docx">${ICONS.download} Word report</button><button class="btn btn-sm" id="pdf">${ICONS.download} PDF report</button><button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print / PDF</button>${again ? '<button class="btn btn-sm btn-ghost" id="again">Check another</button>' : ''}</div></div>
    ${datasetBanner(r)}
    <div class="kpis">
      <div class="kpi ${s.missing ? 'bad' : 'good'}"><div class="n">${s.missing}</div><div class="l">Missing from list</div></div>
      <div class="kpi ${s.uncited ? 'warn' : 'good'}"><div class="n">${s.uncited}</div><div class="l">Never cited</div></div>
      <div class="kpi ${s.yearMismatch + s.etAl ? 'warn' : 'good'}"><div class="n">${s.yearMismatch + s.etAl + s.ambiguous}</div><div class="l">Year / “et al.” / ambiguous</div></div>
      <div class="kpi ${s.unsupported ? 'bad' : ''}"><div class="n">${r.claims && !r.claims.error ? s.unsupported : '—'}</div><div class="l">Unsupported claims</div></div>
      <div class="kpi ${s.retractedEvidence ? 'bad' : ''}"><div class="n">${s.retractedEvidence}</div><div class="l">Claims on retracted work</div></div>
      <div class="kpi ${s.patternFlags ? 'warn' : 'good'}"><div class="n">${s.patternFlags}</div><div class="l">Pattern flags</div></div>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="a">A. Citations ↔ reference list<span class="count">${s.missing + s.uncited + s.yearMismatch + s.ambiguous + s.etAl}</span></button>
      <button class="tab" data-tab="b">B. Claim support${r.claims && !r.claims.error ? `<span class="count">${s.unsupported + s.partial}</span>` : ''}</button>
      <button class="tab" data-tab="c">C. Citation pattern<span class="count">${s.patternFlags}</span></button>
      <button class="tab" data-tab="d">Author letter</button>
    </div>
    <div id="tab-body"></div>`;
  const body = $('#tab-body', el);
  const show = k => {
    $$('.tab', el).forEach(t => t.classList.toggle('active', t.dataset.tab === k));
    if (k === 'a') consistencyTab(body, r.consistency, refs);
    else if (k === 'b') {
      if (!r.claims) body.innerHTML = '<div class="alert alert-info">Claim support was not checked in this run.</div>';
      else if (r.claims.error) body.innerHTML = `<div class="alert alert-warn">${esc(r.claims.error)}</div>`;
      else renderVerifyResult(body, r.claims, {});
    } else if (k === 'c') patternTab(body, r.pattern);
    else letterTab(body, r);
  };
  $$('.tab', el).forEach(t => (t.onclick = () => show(t.dataset.tab)));
  show('a');
  $('#pdf', el).onclick = () => download('/api/export/pdf', { kind: 'citations', data: r }).catch(e => toast(e.message, 'error'));
  $('#docx', el).onclick = () => download('/api/export/docx', { kind: 'citations', data: r }).catch(e => toast(e.message, 'error'));
  if (again) $('#again', el).onclick = again;
}
