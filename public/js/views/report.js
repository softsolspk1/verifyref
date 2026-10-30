// views/report.js - renders a check result: References, Citations, Journals, Citation pattern, Editor report
import { api, esc, $, $$, badge, sevTone, toast, download, copyText, fmtDate, pct, ICONS, runJob, hasModule, datasetBanner } from '../core.js';
import { decisionCard } from './decision.js';

export async function renderSavedReport(view, id) {
  view.innerHTML = '<div class="empty">Loading report…</div>';
  const d = await api(`/api/checks/${id}`);
  view.innerHTML = '';
  const kind = d.kind || d.result.kind;
  if (kind === 'citations' && d.result.module === 3) {
    const { renderCitationsResult } = await import('./citations.js');
    view.innerHTML = `<p class="muted no-print"><a href="#/activity">← My Activity</a> · saved ${fmtDate(d.result.createdAt)}</p><div id="saved"></div>`;
    renderCitationsResult($('#saved', view), d.result, {});
    return;
  }
  if (kind === 'reviewer-report') {
    const { renderReviewerReportResult } = await import('./reviewerReport.js');
    view.innerHTML = '<div id="rr"></div>';
    renderReviewerReportResult($('#rr', view), d.result);
    return;
  }
  const other = KIND_VIEWS[kind];
  if (other) {
    const mod = await import(other[0]);
    view.innerHTML = `<p class="muted no-print"><a href="#/activity">← My Activity</a> · saved ${fmtDate(d.result.createdAt)}</p><div id="saved"></div>`;
    mod[other[1]]($('#saved', view), d.result, {});
    return;
  }
  renderReport(view, d.result, { kind, saved: true });
}

// Saved results of the other tools are shown with that tool's own result view
const KIND_VIEWS = {
  restyle: ['./restyle.js', 'renderRestyleResult'], format: ['./format.js', 'renderFormatResult'], verify: ['./verify.js', 'renderVerifyResult'],
  evidence: ['./evidence.js', 'renderEvidenceResult'], 'journal-finder': ['./journalFinder.js', 'renderJournalFinderResult'],
  conferences: ['./conferences.js', 'renderConferenceResult'], assistant: ['./assistant.js', 'renderAssistantResult'], authors: ['./authors.js', 'renderAuthorWorks'],
  papermill: ['./papermill.js', 'renderPaperMillResult'], images: ['./images.js', 'renderImagesResult'],
  integrity: ['./integrity.js', 'renderIntegrityResult'], 'peer-review': ['./peerReview.js', 'renderPeerReviewResult']
};

const STATUS_ORDER = ['suspicious', 'retracted', 'miscited', 'pending', 'unverified', 'verified'];
const statusTone = s => ({ verified: 'good', miscited: 'warn', retracted: 'bad', suspicious: 'bad', unverified: 'neutral', pending: 'info' }[s] || 'neutral');

export function renderReport(el, result, { kind } = {}) {
  const refs = result.references?.results || [];
  const s = result.references?.summary || {};
  const meta = result.meta || {};
  const id = result.id;
  const tabs = [];
  if (result.screening) tabs.push(['summary', 'Screening summary', null]);
  if (kind !== 'citations') tabs.push(['references', 'References', s.total]);
  if (result.compliance) tabs.push(['style', 'PJPS style', result.compliance.summary.nonCompliant]);
  if (result.citations) tabs.push(['citations', 'Citations', result.citations.summary ? (result.citations.summary.missing + result.citations.summary.uncited) : null]);
  if (result.journals) tabs.push(['journals', 'Journals', result.journals.summary?.journals]);
  if (result.pattern) tabs.push(['pattern', 'Citation pattern', result.pattern.flags?.length]);
  if (result.papermill && hasModule('papermill')) tabs.push(['papermill', 'Paper mill', result.papermill.signals.length]);
  if (result.images && hasModule('images')) tabs.push(['images', 'Images', result.images.summary.findings]);
  if (result.plagiarism) tabs.push(['plagiarism', 'Similarity report', result.plagiarism.error ? null : `${Math.round(result.plagiarism.summary.similarity)}%`]);
  if (result.novelty) tabs.push(['novelty', 'Novelty & outlook', result.novelty.error ? null : result.novelty.summary.score]);
  if (result.authorIdentity) tabs.push(['authors', 'Authors (ORCID)', result.authorIdentity.error ? null : `${result.authorIdentity.summary.verified}/${result.authorIdentity.summary.authors}`]);
  if (id && kind !== 'citations') tabs.push(['editor', 'Editor report', null]);

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(meta.title || (kind === 'citations' ? 'Citation Check' : kind === 'manuscript' ? 'Full Screening Report' : 'Check Bibliography'))}</h1>
        <p>${meta.manuscriptCode ? `<b>${esc(meta.manuscriptCode)}</b> · version ${meta.version || 1} · ` : ''}${fmtDate(result.createdAt)}${result.truncated ? ` · <span class="badge b-warn">Only the first ${refs.length} of ${result.totalFound} references were checked</span>` : ''}</p>
      </div>
      <div class="row no-print">

        ${id && kind !== 'citations' ? `
          <div style="position:relative">
            <button class="btn btn-sm" id="export-btn">${ICONS.download} Export ▾</button>
            <div id="export-menu" class="card" hidden style="position:absolute;right:0;top:36px;z-index:20;padding:6px;min-width:230px">
              ${result.screening ? [['editor', 'Screening report — editor version (Word)'], ['editor&format=pdf', 'Screening report — editor version (PDF)'], ...(hasModule('reports') ? [['author', 'Screening report — author version (Word)']] : [])].map(([v, l]) => `<button class="btn btn-ghost btn-sm" style="width:100%;justify-content:flex-start" data-screen="${v}">${l}</button>`).join('') : ''}
              ${[['csv', 'Audit report (CSV)'], ['docx', 'Reference report (Word)'], ['pdf', 'Reference report (PDF)'], ['corrected', 'Corrected reference list, PJPS style (.txt)'], ['bibtex', 'BibTeX (.bib)'], ['ris', 'RIS (.ris)']].map(([f, l]) => `<button class="btn btn-ghost btn-sm" style="width:100%;justify-content:flex-start" data-export="${f}">${l}</button>`).join('')}
            </div>
          </div>` : ''}
        ${id && ['references', 'manuscript'].includes(kind) ? `<button class="btn btn-sm" id="recheck" title="Run the same reference list again and show only what changed">↻ Re-check</button>` : ''}
        <button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print / PDF</button>
      </div>
    </div>
    ${datasetBanner(result)}
    ${result.changes ? changesBanner(result.changes) : ''}
    ${kind !== 'citations' ? kpis(s) : ''}
    ${s.suspicious || s.retracted ? `<div class="alert alert-bad"><b>Publication integrity alert:</b> ${s.suspicious ? `${s.suspicious} reference(s) could not be found in any of the databases searched (possibly fabricated)` : ''}${s.suspicious && s.retracted ? '; ' : ''}${s.retracted ? `${s.retracted} retracted work(s) cited` : ''}.</div>` : ''}
    <div class="tabs">${tabs.map(([k, l, c], i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-tab="${k}">${esc(l)}${c !== null && c !== undefined ? `<span class="count">${c}</span>` : ''}</button>`).join('')}</div>
    <div id="tab-body"></div>`;

  const body = $('#tab-body', el);
  const show = k => {
    $$('.tab', el).forEach(t => t.classList.toggle('active', t.dataset.tab === k));
    if (k === 'summary') summaryTab(body, result);
    else if (k === 'style') styleTab(body, result.compliance);
    else if (k === 'papermill') import('./papermill.js').then(m => { body.innerHTML = '<div id="pm"></div>'; m.renderPaperMillResult($('#pm', body), { ...result.papermill, id: null }); });
    else if (k === 'images') body.innerHTML = `<div class="card"><h3>Image Integrity (Module 5)</h3><p>Image risk <b>${esc(result.images.summary.level)}</b> — ${result.images.summary.findings} finding(s) in ${result.images.summary.panels} panels${result.images.summary.earlier ? `, ${result.images.summary.earlier} match(es) with earlier PJPS manuscripts` : ''}.</p><a class="btn btn-sm" href="#/check/${result.images.checkId}">Open the image report</a></div>`;
    else if (k === 'references') referencesTab(body, refs, s, result.indicators);
    else if (k === 'citations') citationsTab(body, result.citations, refs);
    else if (k === 'journals') journalsTab(body, result.journals);
    else if (k === 'pattern') patternTab(body, result.pattern, refs);
    else if (k === 'editor') editorTab(body, result);
    else if (k === 'plagiarism') plagiarismTab(body, result.plagiarism);
    else if (k === 'novelty') noveltyTab(body, result.novelty);
    else if (k === 'authors') authorsTab(body, result.authorIdentity);
  };
  $$('.tab', el).forEach(t => (t.onclick = () => show(t.dataset.tab)));
  $$('.kpi.clickable', el).forEach(k => (k.onclick = () => { show('references'); const f = $(`.filter[data-f="${k.dataset.f}"]`, el); if (f) f.click(); }));
  show(tabs[0][0]);

  const eb = $('#export-btn', el);
  if (eb) {
    const menu = $('#export-menu', el);
    // the next click anywhere (a menu item included) closes the menu again
    eb.onclick = e => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      if (!menu.hidden) document.addEventListener('click', () => (menu.hidden = true), { once: true });
    };
    $$('[data-export]', el).forEach(b => (b.onclick = () => download(`/api/checks/${id}/export?format=${b.dataset.export}${b.dataset.export === 'corrected' ? '&style=pjps' : ''}`).catch(e => toast(e.message, 'error'))));
    $$('[data-screen]', el).forEach(b => (b.onclick = () => download(`/api/checks/${id}/screening?version=${b.dataset.screen}`).catch(e => toast(e.message, 'error'))));
  }
  const rc = $('#recheck', el);
  if (rc) rc.onclick = async () => {
    rc.disabled = true;
    try {
      const { jobId } = await api(`/api/checks/${id}/recheck`, { body: {} });
      const holder = document.createElement('div');
      el.prepend(holder);
      const fresh = await runJob(jobId, holder, 'Re-checking the reference list');
      holder.remove();
      location.hash = `#/check/${fresh.id}`;
      toast(fresh.changes?.rows?.length ? `${fresh.changes.rows.length} change(s) since the last run` : 'No changes since the last run');
    } catch (e) { toast(e.message, 'error'); rc.disabled = false; }
  };
  const ia = $('#issue-assign', el);
  if (ia) ia.onchange = () => api(`/api/checks/${id}`, { method: 'PATCH', body: { issueId: ia.value || null } }).then(() => toast(ia.value ? 'Added to issue' : 'Removed from issue')).catch(e => toast(e.message, 'error'));
}

function changesBanner(c) {
  if (!c.rows.length) return `<div class="alert alert-good">Re-check: nothing changed since the run of ${fmtDate(c.previousDate)}. <a href="#/check/${c.previousId}">Earlier report</a></div>`;
  return `<div class="card"><div class="card-head"><h3>Changes since the run of ${fmtDate(c.previousDate)}</h3><a href="#/check/${c.previousId}">Earlier report</a></div><table class="t"><tr><th>#</th><th>Change</th><th>Reference</th></tr>
    ${c.rows.map(r => `<tr><td class="num">${r.index}</td><td>${r.change === 'status' ? `${esc(r.before)} → <b>${esc(r.after)}</b>` : r.change === 'new' ? `New: ${esc(r.after)}` : `Removed (${esc(r.before)})`}</td><td>${esc(r.raw.slice(0, 180))}${r.reason ? `<div class="muted">${esc(r.reason)}</div>` : ''}</td></tr>`).join('')}</table></div>`;
}


function summaryTab(body, r) {
  const sc = r.screening;
  const row = (n, label, line, tone) => `<tr><td class="num">${n}</td><td><b>${label}</b></td><td>${badge(tone === 'good' ? 'OK' : tone === 'bad' ? 'Problem' : tone === 'warn' ? 'Check' : '—', tone || 'neutral')}</td><td>${esc(line)}</td></tr>`;
  const s = r.references.summary, c = r.citations?.summary, cp = r.compliance?.summary, pm = r.papermill?.risk, im = r.images?.summary;
  body.innerHTML = `
    <div class="risk-banner risk-${sc.recommendation === 'proceed' ? 'low' : sc.recommendation === 'return' ? 'medium' : 'high'}"><div class="risk-level">${sc.recommendation === 'proceed' ? '✓' : sc.recommendation === 'return' ? '↩' : '!'}</div><div><b>Desk-review recommendation: ${esc(sc.recommendationLabel)}</b><div class="muted">${sc.reasons.length ? sc.reasons.map(esc).join(' · ') : 'No blocking problems were found.'} The editor decides.</div></div></div>
    <div class="card"><table class="t"><tr><th>#</th><th>Module</th><th>Status</th><th>Summary</th></tr>
      ${row(1, 'Check Bibliography', sc.lines.bibliography, s.suspicious || s.retracted ? 'bad' : s.miscited ? 'warn' : 'good')}
      ${row(2, 'PJPS style', sc.lines.style, !cp ? '' : cp.score >= 90 ? 'good' : cp.score >= 60 ? 'warn' : 'bad')}
      ${row(3, 'Citations', sc.lines.citations, !c ? '' : c.missing || c.uncited > 3 ? 'warn' : 'good')}
      ${hasModule('papermill') ? row(4, 'Paper mill risk', sc.lines.papermill, !pm ? '' : pm.level === 'HIGH' ? 'bad' : pm.level === 'MEDIUM' ? 'warn' : 'good') : ''}
      ${hasModule('images') ? row(5, 'Image integrity', sc.lines.images, !im ? '' : im.level === 'HIGH' ? 'bad' : im.level === 'MEDIUM' ? 'warn' : 'good') : ''}
      ${r.plagiarism ? row(6, 'Plagiarism', r.plagiarism.error || sc.lines.plagiarism || '', r.plagiarism.error ? '' : { ok: 'good', warn: 'warn', bad: 'bad' }[r.plagiarism.summary.level]) : ''}
      ${r.novelty ? row(7, 'Novelty &amp; citation outlook', r.novelty.error || sc.lines.novelty || '', r.novelty.error ? '' : r.novelty.summary.band === 'low' ? 'warn' : 'good') : ''}
      ${r.authorIdentity ? row(8, 'Author identity (ORCID)', r.authorIdentity.error || sc.lines.authors || '', r.authorIdentity.error ? '' : { ok: 'good', warn: 'warn', bad: 'bad' }[r.authorIdentity.summary.level]) : ''}
    </table>
    <p class="muted" style="margin:10px 0 0">Author version: Modules 1–3 only, after your approval. Editor version: all modules. Claim support (does each source support its claim?) is checked in Module 3.</p></div>
    ${r.indicators?.flags?.length ? `<div class="card"><h3>Bibliography indicators</h3>${r.indicators.flags.map(f => `<div class="flag ${f.severity}"><div class="msg">${esc(f.message)}</div></div>`).join('')}</div>` : ''}
    <div id="scr-decision"></div>`;
  decisionCard($('#scr-decision', body), r, 'manuscript');
}

// Turnitin-style similarity report colours: one per primary source (cycled), readable on light and dark backgrounds
const SRC_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42a5a5', '#f032e6', '#9a6324', '#808000', '#000075', '#e6a700', '#008080', '#800000', '#469990', '#aa6e28'];
const srcColor = no => SRC_COLORS[(no - 1) % SRC_COLORS.length];
const pctText = p => (p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`);
const TYPE_LABEL = { internet: 'Internet source', publication: 'Publication', submission: 'Submitted to PJPS' };

function plagiarismTab(body, pl) {
  if (pl.error) { body.innerHTML = `<div class="card"><h3>Similarity report</h3><p class="muted">${esc(pl.error)}</p></div>`; return; }
  const s = pl.summary;
  const tone = { ok: 'low', warn: 'medium', bad: 'high' }[s.level];
  // reports saved before version 2 (no primary-source attribution or highlighted text)
  if (!pl.version) {
    body.innerHTML = `<div class="risk-banner risk-${tone}"><div class="risk-level">${s.similarity}%</div><div><b>Text overlap with published papers: ${s.similarity}% of the manuscript</b><div class="muted">Report made with the earlier method; run the screening again for the full similarity report.</div></div></div>
      <div class="card"><h3>Sources</h3>${(pl.sources || []).map(x => `<p><b>${x.similarity}%</b> ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || 'Source')}</a>` : esc(x.title || 'Source')}</p>`).join('') || '<p class="muted">No overlapping text found.</p>'}</div>`;
    return;
  }
  const typeBox = (label, v) => `<div class="kpi"><div class="n">${pctText(v)}</div><div class="l">${label}</div></div>`;
  body.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>Originality report — Similarity Index</h3>${badge(`${s.sources} primary source(s)`, s.sources ? 'warn' : 'good')}</div>
      <div class="row" style="gap:24px;align-items:center;flex-wrap:wrap">
        <div class="risk-banner risk-${tone}" style="margin:0;min-width:180px"><div class="risk-level">${pctText(s.similarity)}</div><div><b>Similarity Index</b><div class="muted">${s.words.toLocaleString()} words compared</div></div></div>
        <div class="kpis" style="flex:1;margin:0">${typeBox('Internet sources', s.internet)}${typeBox('Publications', s.publications)}${typeBox('Submitted to PJPS', s.submissions)}</div>
      </div>
      <p class="muted" style="margin:10px 0 0">Filters: bibliography ${esc(pl.filters.bibliography)} · quotes ${esc(pl.filters.quotes)} · small matches ${esc(pl.filters.smallMatches)}</p>
    </div>
    ${pl.earlierSubmissions?.length ? `<div class="alert alert-bad"><b>Earlier PJPS submission with the same text (Module 4):</b> ${pl.earlierSubmissions.map(esc).join('; ')}</div>` : ''}
    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr);gap:16px;align-items:start">
      <div class="card"><h3>Match overview — manuscript text</h3>
        <div id="pl-doc" style="max-height:640px;overflow:auto;white-space:pre-wrap;line-height:1.7;font-size:14px;padding-right:8px">${(pl.document || []).map(seg => seg.s
          ? `<span class="pl-m" data-src="${seg.s}" style="background:${srcColor(seg.s)}26;border-bottom:2px solid ${srcColor(seg.s)}"><sup style="color:${srcColor(seg.s)};font-weight:700">${seg.s}</sup>${esc(seg.t)}</span>`
          : esc(seg.t)).join('')}</div></div>
      <div class="card"><h3>Primary sources</h3>${pl.sources.length ? `<ol style="list-style:none;padding:0;margin:0">${pl.sources.map(x => `
        <li class="pl-src" data-src="${x.no}" style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid var(--line,#e3e8ee);cursor:pointer">
          <span style="flex:none;width:26px;height:26px;border-radius:4px;background:${srcColor(x.no)};color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center">${x.no}</span>
          <span style="flex:1;min-width:0"><b>${pctText(x.percent)}</b> <span class="muted">${esc(TYPE_LABEL[x.type] || x.type)}</span><br>
            ${x.checkId ? `<a href="#/check/${x.checkId}">${esc(x.title || 'Earlier submission')}</a>` : x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || 'Source')}</a>` : esc(x.title || 'Source')}
            <div class="muted" style="font-size:12px">${[x.journal, x.year, x.via, x.compared ? `compared: ${x.compared}` : ''].filter(Boolean).map(esc).join(' · ')}</div></span>
        </li>`).join('')}</ol>` : '<p class="muted">No matching text was found in the sources searched.</p>'}
        ${pl.selfMatches?.length ? `<p class="muted" style="margin-top:10px">Not counted — the manuscript's own published version or preprint: ${pl.selfMatches.map(x => esc(x.title)).join('; ')}</p>` : ''}
      </div>
    </div>
    <div class="card"><h3>What was searched</h3>
      <p class="muted" style="margin-top:0">${pl.checked.passages} passages searched (${pl.checked.queries} searches${pl.checked.webSearches ? `, ${pl.checked.webSearches} on the web` : ''}), ${pl.checked.candidates} candidate sources, ${pl.checked.sourcesCompared} compared in full; ${pl.checked.submissionsCompared} earlier PJPS submissions compared.${pl.checked.searchErrors ? ` ${pl.checked.searchErrors} search(es) failed.` : ''}</p>
      <p class="muted">Repositories: ${pl.checked.databases.map(esc).join('; ')}.</p>
      <p class="muted">${esc(pl.method)}</p><p class="muted"><b>Coverage:</b> ${esc(pl.coverage)}</p></div>`;
  // clicking a source highlights only its matches in the text and scrolls to the first one
  let active = null;
  $$('.pl-src', body).forEach(li => li.addEventListener('click', () => {
    const no = li.dataset.src;
    active = active === no ? null : no;
    $$('.pl-m', body).forEach(m => { m.style.opacity = !active || m.dataset.src === active ? '1' : '0.25'; });
    $$('.pl-src', body).forEach(x => { x.style.background = active && x.dataset.src === active ? 'var(--bg-soft,#eef2f5)' : ''; });
    if (active) $(`.pl-m[data-src="${no}"]`, body)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }));
}

function noveltyTab(body, nv) {
  if (nv.error) { body.innerHTML = `<div class="card"><h3>Novelty &amp; citation outlook</h3><p class="muted">${esc(nv.error)}</p></div>`; return; }
  const s = nv.summary, f = nv.forecast;
  const bar = (label, v) => `<div style="margin:6px 0"><div class="row" style="justify-content:space-between"><span>${label}</span><b>${v ?? '—'}</b></div><div style="height:8px;background:var(--bg-soft,#eef2f5);border-radius:4px"><div style="height:8px;width:${Math.max(0, Math.min(100, v || 0))}%;background:var(--brand,#0f4c5c);border-radius:4px"></div></div></div>`;
  const years = nv.momentum?.worksByYear || [];
  const maxW = Math.max(1, ...years.map(y => y.works));
  body.innerHTML = `
    <div class="risk-banner risk-${s.band === 'high' ? 'low' : s.band === 'moderate' ? 'medium' : 'high'}"><div class="risk-level">${s.score}</div><div><b>Novelty ${s.score}/100 — ${esc(s.band)}</b>
      <div class="muted">Closest published work: similarity ${s.maxSimilarity}; ${s.closeRecent} close work(s) in the last five years; ${nv.checked.works} related works compared (${esc(nv.checked.database)}). 5-year citation outlook: <b>${esc(s.outlook)}</b>.</div></div></div>
    <div class="grid grid-2">
      <div class="card"><h3>Novelty components</h3>${bar('Distance from the closest published work', nv.components.distance)}${bar('Uncrowded field (last 5 years)', 100 - nv.components.crowding)}${nv.components.rarity === null ? '' : bar('Rare combination of the key concepts', nv.components.rarity)}
        ${nv.concepts?.pairs?.length ? `<table class="t" style="margin-top:10px"><tr><th>Concepts studied together</th><th class="num">Works</th></tr>${nv.concepts.pairs.map(p => `<tr><td>${esc(p.a)} + ${esc(p.b)}</td><td class="num">${p.works === null || p.works === undefined ? '—' : Number(p.works).toLocaleString()}</td></tr>`).join('')}</table>` : ''}</div>
      <div class="card"><h3>Citation outlook</h3>
        <table class="t"><tr><th>After</th><th class="num">Median</th><th class="num">Likely range</th><th class="num">Basis</th></tr>${f.horizon.map(h => `<tr><td>${h.years} year${h.years > 1 ? 's' : ''}</td><td class="num">${h.median ?? '—'}</td><td class="num">${h.median === null ? '—' : `${h.low} – ${h.high}`}</td><td class="num">${h.basis}</td></tr>`).join('')}</table>
        ${f.journalNote ? `<p class="muted" style="margin-top:8px">${esc(f.journalNote)}</p>` : ''}
        ${nv.momentum ? `<h3 style="margin-top:14px">${esc(nv.momentum.topic)}</h3><div class="muted">${esc(nv.momentum.trend)}${nv.momentum.growthPerYear !== null ? ` (${nv.momentum.growthPerYear > 0 ? '+' : ''}${nv.momentum.growthPerYear}% works per year)` : ''}</div>
          <div class="row" style="align-items:flex-end;gap:4px;height:90px;margin-top:8px">${years.map(y => `<div title="${y.year}: ${y.works.toLocaleString()} works" style="flex:1;text-align:center"><div style="height:${Math.round(y.works / maxW * 70)}px;background:var(--brand,#0f4c5c);border-radius:3px 3px 0 0"></div><div class="muted" style="font-size:11px">${String(y.year).slice(2)}</div></div>`).join('')}</div>` : ''}</div>
    </div>
    <div class="card"><h3>Closest published works</h3><table class="t"><tr><th>Work</th><th class="num">Year</th><th class="num">Similarity</th><th class="num">Cited by</th></tr>
      ${nv.closest.map(w => `<tr><td><a href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.title)}</a>${w.journal ? `<div class="muted">${esc(w.journal)}</div>` : ''}</td><td class="num">${w.year || ''}</td><td class="num">${w.similarity}</td><td class="num">${w.citedBy}</td></tr>`).join('')}</table>
      <p class="muted" style="margin-top:10px">${esc(nv.method)} ${esc(f.method)}</p></div>`;
}

function authorsTab(body, ai) {
  if (ai.error) { body.innerHTML = `<div class="card"><h3>Author identity (ORCID)</h3><p class="muted">${esc(ai.error)}</p></div>`; return; }
  const s = ai.summary;
  const orcidLink = id => `<a href="https://orcid.org/${esc(id)}" target="_blank" rel="noopener" class="mono">${esc(id)}</a>`;
  body.innerHTML = `
    <div class="risk-banner risk-${{ ok: 'low', warn: 'medium', bad: 'high' }[s.level]}"><div class="risk-level">${s.verified}/${s.authors}</div><div><b>${s.verified} of ${s.authors} author(s) identified in the ORCID registry</b>
      <div class="muted">${s.idsInManuscript} ORCID iD(s) written in the manuscript; ${s.flags} problem(s). A missing ORCID record is not evidence of misconduct.</div></div></div>
    ${ai.flags.length ? `<div class="card"><h3>Problems</h3>${ai.flags.map(f => `<div class="flag ${f.severity}"><div class="msg">${esc(f.text)}</div></div>`).join('')}</div>` : ''}
    <div class="card"><h3>Authors</h3><table class="t"><tr><th>Author</th><th>ORCID</th><th>Institutions (ORCID)</th><th class="num">Publications</th><th>Field</th></tr>
      ${ai.authors.map(a => `<tr><td><b>${esc(a.author)}</b><div class="muted">${esc(a.status === 'verified' ? a.source : a.note || a.status)}</div>
          <div style="font-size:12px;margin-top:3px"><a href="https://scholar.google.com/citations?view_op=search_authors&mauthors=${encodeURIComponent(a.author)}" target="_blank" rel="noopener">Scholar profile ↗</a>${a.orcid ? '' : ` · <a href="https://orcid.org/orcid-search/search?searchQuery=${encodeURIComponent(a.author)}" target="_blank" rel="noopener">ORCID search ↗</a>`}</div></td>
        <td>${a.orcid ? orcidLink(a.orcid) : a.candidates?.length ? `<span class="muted">candidates:</span><br>${a.candidates.map(c => `${orcidLink(c.id)}${c.institutions.length ? ` <span class="muted">${esc(c.institutions[0])}</span>` : ''}`).join('<br>')}` : '—'}
          ${a.record ? `<div class="muted">record since ${a.record.created || '?'}${a.record.verifiedEmail ? ' · verified e-mail' : ''}</div>` : ''}</td>
        <td>${a.record ? esc([...new Set(a.record.employments.map(e => `${e.organization}${e.end ? ` (to ${e.end})` : ''}`))].slice(0, 3).join('; ') || '—') : '—'}${a.institutionAgrees === false ? ' ' + badge('differs', 'warn') : a.institutionAgrees ? ' ' + badge('agrees', 'good') : ''}</td>
        <td class="num">${a.record ? `${Math.max(a.record.works, a.openalex?.works || 0)}${a.openalex?.hIndex != null ? `<div class="muted">h-index ${a.openalex.hIndex}</div>` : ''}` : '—'}</td>
        <td>${a.record ? `${a.claimsThisWork ? badge('this manuscript in record', 'good') + ' ' : ''}${a.field?.relatedWorks ? `${a.field.relatedWorks} related work(s)` : ''}${a.field?.topicMatch ? ' · topic match' : ''}${a.field?.examples?.length ? `<div class="muted">${esc(a.field.examples[0])}</div>` : ''}` : '—'}${a.flags.length ? a.flags.map(f => `<div class="flag ${f.severity}" style="margin-top:4px"><div class="msg">${esc(f.text)}</div></div>`).join('') : ''}</td></tr>`).join('')}
    </table><p class="muted" style="margin-top:10px">${esc(ai.method)}</p></div>`;
}

function styleTab(body, cp) {
  const s = cp.summary;
  const bad = cp.entries.filter(e => !e.compliant);
  body.innerHTML = `
    <div class="kpis"><div class="kpi ${s.score >= 90 ? 'good' : s.score >= 60 ? 'warn' : 'bad'}"><div class="n">${s.score}%</div><div class="l">PJPS compliant (${s.compliant}/${s.total})</div></div><div class="kpi"><div class="n">${s.deviations}</div><div class="l">Deviations</div></div><div class="kpi"><div class="n">${s.inTextIssues}</div><div class="l">In-text problems</div></div></div>
    <p class="muted">To convert the manuscript to PJPS format with Track Changes, use Module 2.</p>
    ${cp.inText.issues.length ? `<div class="card"><h3>In-text citations</h3><table class="t">${cp.inText.issues.map(i => `<tr><td><b>${esc(i.citation || '—')}</b></td><td>${esc(i.message)}</td></tr>`).join('')}</table></div>` : ''}
    ${bad.map(e => `<div class="entry kept"><div><b>[${e.index}]</b> ${esc(e.original)}</div><ul class="issue-list">${e.deviations.map(d => `<li>${esc(d.message)}${d.found ? ` — <span class="diff-old">${esc(d.found)}</span>` : ''}${d.expected ? ` → <span class="diff-new">${esc(d.expected)}</span>` : ''}</li>`).join('')}</ul>${e.expected ? `<div class="suggest"><b>PJPS form:</b> ${esc(e.expected)}</div>` : ''}</div>`).join('') || '<div class="alert alert-good">All references follow the PJPS house style.</div>'}`;
}

function indicatorsCard(ind) {
  if (!ind) return '';
  const a = ind.age;
  const years = Object.keys(a.byYear).map(Number).sort((x, y) => x - y);
  const maxN = Math.max(1, ...Object.values(a.byYear));
  const y0 = years.length ? Math.max(years[0], new Date().getFullYear() - 30) : 0;
  const span = years.length ? years.filter(y => y >= y0) : [];
  return `<div class="grid grid-2">
    <div class="card"><h3>References by year</h3>
      ${span.length ? `<div class="year-chart">${span.map(y => `<div class="yc-col" title="${y}: ${a.byYear[y]}"><span style="height:${Math.round(a.byYear[y] / maxN * 100)}%" class="${y >= new Date().getFullYear() - a.rule.years ? 'recent' : ''}"></span></div>`).join('')}</div><div class="row" style="justify-content:space-between"><span class="muted">${span[0]}</span><span class="muted">${span[span.length - 1]}</span></div>` : '<p class="muted">No years found.</p>'}
      <div class="stat-line"><span><b>${a.recentShare ?? '—'}%</b> from the last ${a.rule.years} years</span><span><b>${a.within10Share ?? '—'}%</b> from the last 10 years</span></div>
      ${a.rule.minShare && a.recentShare !== null && a.recentShare < a.rule.minShare ? `<div class="alert alert-warn" style="margin:8px 0 0">Below the PJPS minimum of ${a.rule.minShare}% recent references.</div>` : ''}
    </div>
    <div class="card"><h3>Quality indicators</h3>
      <div class="stat-line"><span>Self-citation</span><b>${ind.selfCitation.measured ? `${ind.selfCitation.count} (${ind.selfCitation.rate}%)` : 'enter the authors to measure'}</b></div>
      <div class="stat-line"><span>${esc(ind.homeJournal.name)} citations</span><b>${ind.homeJournal.count}</b></div>
      <div class="stat-line"><span>Predatory / hijacked journals</span><b class="${ind.riskyJournals.length ? 'txt-bad' : ''}">${ind.riskyJournals.reduce((n, j) => n + j.refs.length, 0)}</b></div>
      <div class="stat-line"><span>Duplicate references</span><b>${ind.duplicates.length}</b></div>
      ${ind.riskyJournals.length ? `<ul class="issue-list">${ind.riskyJournals.map(j => `<li>${badge(j.kind, 'bad')} ${esc(j.journal)} — ${j.refs.map(i => `<a href="#" data-goto="${i}">[${i}]</a>`).join(' ')}</li>`).join('')}</ul>` : ''}
      ${ind.duplicates.length ? `<ul class="issue-list">${ind.duplicates.map(d => `<li>${d.indexes.map(i => `<a href="#" data-goto="${i}">[${i}]</a>`).join(' = ')} ${esc(d.by)}</li>`).join('')}</ul>` : ''}
    </div>
  </div>`;
}

function kpis(s) {
  const k = (n, l, tone, f) => `<div class="kpi ${tone} ${f ? 'clickable' : ''}" ${f ? `data-f="${f}"` : ''}><div class="n">${n ?? 0}</div><div class="l">${l}</div></div>`;
  return `<div class="kpis">
    ${k(s.total, 'References', '', 'all')}
    ${k(s.verified, 'Verified', 'good', 'verified')}
    ${k(s.miscited, 'Miscited', 'warn', 'miscited')}
    ${k(s.unverified, 'Unverified', '', 'unverified')}
    ${k(s.suspicious, 'Suspicious', 'bad', 'suspicious')}
    ${k(s.retracted, 'Retracted', 'bad', 'retracted')}
    ${s.pending ? k(s.pending, 'Pending — online', 'info', 'pending') : ''}
    ${k(s.doiSuggested, 'DOIs found', 'info', 'doi')}
  </div>
  ${s.pending ? `<div class="alert alert-info"><b>${s.pending} reference(s) could not be checked offline.</b> They were checked against the local Retraction Watch and predatory-journal datasets only, and will be verified against all databases automatically when the connection returns.</div>` : ''}`;
}

// ------------------------------------------------------------------ References tab

function referencesTab(body, refs, s, indicators) {
  const ages = s.ages || {};
  const totalAged = (ages.last5 || 0) + (ages.y6to10 || 0) + (ages.y11to20 || 0) + (ages.older || 0);
  const bar = (label, n) => `<div class="bar-row"><span>${label}</span><div class="bar-track"><span style="width:${pct(n, totalAged)}%"></span></div><span class="num">${n || 0}</span></div>`;
  body.innerHTML = `
    ${indicatorsCard(indicators)}
    <div class="grid grid-2">
      <div class="card"><h3>Reference age</h3><div class="bars">
        ${bar('Last 5 years', ages.last5)}${bar('6–10 years', ages.y6to10)}${bar('11–20 years', ages.y11to20)}${bar('Older than 20', ages.older)}
      </div>${s.olderThan10?.length ? `<p class="muted" style="margin:10px 0 0">Older than 10 years: ${s.olderThan10.map(i => `<a href="#" data-goto="${i}">[${i}]</a>`).join(' ')}</p>` : ''}</div>
      <div class="card"><h3>Links &amp; identifiers</h3>
        <div class="stat-line"><span><b>${s.withDoi || 0}</b> with DOI</span><span><b>${s.doiSuggested || 0}</b> DOIs found for you</span></div>
        <div class="stat-line"><span class="badge b-good">${s.links?.works || 0} links work</span><span class="badge b-bad">${s.links?.broken || 0} broken</span><span class="badge b-neutral">${s.links?.unchecked || 0} could not be checked</span></div>
        <p class="muted" style="margin:10px 0 0">Searched: ${(s.databases || []).join(' · ')}</p>
      </div>
    </div>
    <div class="filters no-print">
      ${[['all', 'All', refs.length], ...STATUS_ORDER.filter(st => st !== 'pending' || refs.some(r => r.status === 'pending')).map(st => [st, st[0].toUpperCase() + st.slice(1), refs.filter(r => r.status === st).length]), ['doi', 'DOI found', refs.filter(r => !r.parsed?.doi && r.record?.doi).length], ['notindexed', 'Not indexed', refs.filter(r => r.notIndexed).length], ['broken', 'Broken links', refs.filter(r => r.links?.some(l => l.status === 'broken')).length]]
        .map(([f, l, c]) => `<button class="filter ${f === 'all' ? 'active' : ''}" data-f="${f}">${l} (${c})</button>`).join('')}
      <span class="spacer"></span>
      <button class="filter" id="expand-all">Expand all</button>
    </div>
    <div id="ref-list"></div>`;

  const list = $('#ref-list', body);
  const draw = f => {
    const shown = refs.filter(r => f === 'all' || r.status === f || (f === 'doi' && !r.parsed?.doi && r.record?.doi) || (f === 'notindexed' && r.notIndexed) || (f === 'broken' && r.links?.some(l => l.status === 'broken')));
    list.innerHTML = shown.length ? shown.map(refRow).join('') : '<div class="empty">No references in this category.</div>';
    $$('.ref-head', list).forEach(h => (h.onclick = () => h.parentElement.classList.toggle('open')));
    $$('[data-copy]', list).forEach(b => (b.onclick = e => { e.stopPropagation(); copyText(b.dataset.copy); }));
  };
  $$('.filter[data-f]', body).forEach(b => (b.onclick = () => { $$('.filter[data-f]', body).forEach(x => x.classList.remove('active')); b.classList.add('active'); draw(b.dataset.f); }));
  $('#expand-all', body).onclick = () => { const open = !$('.ref.open', list); $$('.ref', list).forEach(r => r.classList.toggle('open', open)); };
  $$('[data-goto]', body).forEach(a => (a.onclick = e => { e.preventDefault(); const r = $(`#ref-${a.dataset.goto}`, list); if (r) { r.classList.add('open'); r.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }));
  draw('all');
}

// Free one-click searches opened in the editor's own browser (Google Scholar has no free API; ORCID search is public)
const enc = encodeURIComponent;
function scholarQuery(r) {
  const p = r.parsed || {};
  const title = (p.title || '').replace(/["“”]/g, '').trim();
  if (title.length >= 12) return `"${title}"${p.authors?.[0]?.family ? ` author:"${p.authors[0].family}"` : ''}`;
  return String(r.raw || '').replace(/^\s*\[?\d+[\].)]?\s*/, '').slice(0, 250);
}
/**
 * PubMed, Google Books, Google Scholar and Google are searched automatically; this shows what each one found. A source
 * that could not run (no SerpApi key for the two Google searches, offline, a source error) keeps a link to search it by hand.
 */
function autoSearch(r) {
  const p = r.parsed || {};
  const q = scholarQuery(r);
  const plain = (p.title || r.raw || '').slice(0, 250);
  const sources = [
    ['PubMed', `https://pubmed.ncbi.nlm.nih.gov/?term=${enc(plain)}`],
    ['Google Books', `https://www.google.com/search?tbm=bks&q=${enc(plain)}`],
    ['Google Scholar', `https://scholar.google.com/scholar?q=${enc(q)}`],
    ['Google', `https://www.google.com/search?q=${enc(`"${plain}"`)}`]
  ];
  const state = name => (r.checked || {})[name];
  const item = ([name, url]) => {
    const o = state(name);
    if (o === 'found' && name === 'Google' && (r.web || []).length) return `${badge(name, 'good')} found on the web`;
    if (o === 'found') return `${badge(name, (r.matchedIn || []).includes(name) ? 'good' : 'neutral')} ${(r.matchedIn || []).includes(name) ? 'matched' : 'similar record, not the same work'}`;
    if (o === 'not-found') return `${badge(name, 'neutral')} no match`;
    const why = o === 'error' ? 'could not be searched' : 'not searched';
    return `${badge(name, 'warn')} ${why} · <a href="${esc(url)}" target="_blank" rel="noopener">search yourself ↗</a>`;
  };
  const web = (r.web || []).map(h => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a> <span class="muted">${esc(h.host)} · title match ${Math.round(h.sim * 100)}%</span>${h.snippet ? `<div class="muted" style="font-size:12px">${esc(h.snippet)}</div>` : ''}</li>`).join('');
  return `<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:4px">Searched automatically</div>
    <div class="row" style="gap:12px;flex-wrap:wrap;font-size:13px">${sources.map(x => `<span>${item(x)}</span>`).join('')}</div>
    ${web ? `<div style="margin-top:6px"><div class="muted" style="font-size:12px">Found by Google</div><ul class="evidence" style="margin:4px 0 0">${web}</ul></div>` : ''}</div>`;
}

function refRow(r) {
  const rec = r.record;
  const authors = list => (list || []).slice(0, 8).map(a => `${a.family}${a.given ? ' ' + a.given : ''}`).join(', ') + ((list || []).length > 8 ? ', et al.' : '');
  const issues = (r.issues || []).filter(i => i.severity !== 'info');
  const chips = Object.entries(r.checked || {}).map(([db, o]) => `<span class="chip ${o === 'found' && (r.matchedIn || []).includes(db) ? 'found' : o === 'error' ? 'error' : ''}" title="${esc(o)}">${esc(db)}${o === 'error' ? ' ⚠' : ''}</span>`).join('');
  return `<div class="ref tone-${r.tone || statusTone(r.status)}" id="ref-${r.index}">
    <div class="ref-head">
      <div class="ref-idx">${r.index}</div>
      <div class="ref-text">
        <div class="ref-raw">${esc(r.raw)}</div>
        <div class="ref-reason">${esc(r.reason || '')}${issues.length > 1 ? ` · ${issues.length} issues` : ''}</div>
      </div>
      <div class="ref-side">
        ${badge(r.statusLabel || r.status, r.tone || statusTone(r.status))}
        ${r.confidence !== undefined ? `<div class="conf">Confidence ${r.confidence}</div><div class="conf-bar"><span style="width:${r.confidence}%"></span></div>` : ''}
      </div>
    </div>
    <div class="ref-body">
      ${r.retraction ? `<div class="alert alert-bad"><b>Retracted</b>${r.retraction.date ? ` on ${esc(r.retraction.date)}` : ''}${r.retraction.reason ? ` — ${esc(r.retraction.reason.split(';').slice(0, 4).join('; '))}` : ''}${r.retraction.doi ? ` · <a href="https://doi.org/${esc(r.retraction.doi)}" target="_blank" rel="noopener">Retraction notice</a>` : ''}</div>` : ''}
      ${(r.notices || []).filter(n => !/retraction/i.test(n.type)).map(n => `<div class="alert alert-warn">${esc(n.type)}: ${esc(n.label)}${n.doi ? ` · <a href="https://doi.org/${esc(n.doi)}" target="_blank" rel="noopener">notice</a>` : ''}</div>`).join('')}
      ${issues.length ? `<ul class="issue-list">${issues.map(i => `<li>${badge(i.severity, sevTone(i.severity))} ${esc(i.message)}${i.cited !== undefined && i.registered !== undefined && i.cited !== null ? ` — <span class="diff-old">${esc(i.cited)}</span> → <span class="diff-new">${esc(i.registered)}</span>` : i.cited ? ` — <span class="diff-old">${esc(i.cited)}</span>` : ''}</li>`).join('')}</ul>` : ''}
      ${rec ? `<dl>
        <dt>Registered title</dt><dd>${esc(rec.title)}</dd>
        <dt>Authors</dt><dd>${esc(authors(rec.authors))}</dd>
        <dt>Journal / source</dt><dd>${esc(rec.journal || rec.publisher || '—')}${rec.volume ? `, ${esc(rec.volume)}` : ''}${rec.issue ? `(${esc(rec.issue)})` : ''}${rec.pages ? `: ${esc(rec.pages)}` : ''}</dd>
        <dt>Year</dt><dd>${esc(rec.year || '—')}</dd>
        ${rec.doi ? `<dt>DOI</dt><dd><a href="https://doi.org/${esc(rec.doi)}" target="_blank" rel="noopener">${esc(rec.doi)}</a></dd>` : rec.url ? `<dt>Record</dt><dd><a href="${esc(rec.url)}" target="_blank" rel="noopener">${esc(rec.url)}</a></dd>` : ''}
        <dt>Matched in</dt><dd>${esc((r.matchedIn || []).join(', ') || rec.source)}</dd>
      </dl>` : `<p class="muted">No matching record was found. Parsed as: <i>${esc(r.parsed?.title || '—')}</i>${r.parsed?.journal ? ` · ${esc(r.parsed.journal)}` : ''}${r.parsed?.year ? ` · ${r.parsed.year}` : ''}</p>`}
      ${r.journalProfile ? `<p class="muted">${esc(r.journalProfile.name)} has ${Number(r.journalProfile.works).toLocaleString()} indexed articles (${r.journalProfile.first}–${r.journalProfile.last}), but this article was not found.</p>` : ''}
      ${(r.links || []).length ? `<p>${r.links.map(l => `${badge(l.status === 'works' ? 'Link works' : l.status === 'broken' ? 'Broken link' : 'Not checked', l.status === 'works' ? 'good' : l.status === 'broken' ? 'bad' : 'neutral')} <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.url.slice(0, 80))}</a>${l.archived ? ` · <a href="${esc(l.archived)}" target="_blank" rel="noopener">archived copy</a>` : ''}`).join('<br>')}</p>` : ''}
      ${r.suggestion ? `<div class="suggest"><b>Suggested reference:</b> ${esc(r.suggestion)} <button class="btn btn-sm btn-ghost" data-copy="${esc(r.suggestion)}">${ICONS.copy}</button></div>` : ''}
      ${chips ? `<div style="margin-top:10px"><div class="muted" style="font-size:12px;margin-bottom:4px">Databases checked</div><div class="chips">${chips}</div></div>` : ''}
      ${r.status !== 'verified' || r.web?.length ? autoSearch(r) : `<div style="margin-top:8px"><a class="muted" style="font-size:12px" href="https://scholar.google.com/scholar?q=${enc(scholarQuery(r))}" target="_blank" rel="noopener">Find in Google Scholar ↗</a></div>`}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ Citations tab

function citationsTab(body, c, refs) {
  if (!c || c.error) { body.innerHTML = `<div class="alert alert-warn">${esc(c?.error || 'Citation Check was not run.')}</div>`; return; }
  const s = c.summary;
  const refText = i => esc((refs.find(r => r.index === i)?.raw || '').slice(0, 200));
  const sec = (title, items, render, tone = 'warn') => `<div class="card"><div class="card-head"><h3>${title}</h3>${badge(items.length, items.length ? tone : 'good')}</div>${items.length ? render(items) : '<p class="muted">None found.</p>'}</div>`;
  body.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="n">${esc(s.system === 'numeric' ? 'Numbered' : 'Author–year')}</div><div class="l">Citation style</div></div>
      <div class="kpi"><div class="n">${s.citations}</div><div class="l">In-text citations</div></div>
      <div class="kpi good"><div class="n">${s.citedReferences}/${s.references}</div><div class="l">References cited</div></div>
      <div class="kpi ${s.missing ? 'bad' : ''}"><div class="n">${s.missing}</div><div class="l">Missing from list</div></div>
      <div class="kpi ${s.uncited ? 'warn' : ''}"><div class="n">${s.uncited}</div><div class="l">Never cited</div></div>
      <div class="kpi ${s.ambiguous ? 'warn' : ''}"><div class="n">${s.ambiguous}</div><div class="l">Ambiguous</div></div>
    </div>
    ${sec('Cited in the text but missing from the reference list', c.missing, items => `<table class="t"><tr><th>Citation</th><th>Problem</th><th>Context</th></tr>${items.map(m => `<tr><td><b>${esc(m.citation)}</b>${m.count > 1 ? ` <span class="muted">×${m.count}</span>` : ''}</td><td>${esc(m.reason)}</td><td class="muted">…${esc(m.context || '')}…</td></tr>`).join('')}</table>`, 'bad')}
    ${sec('In the reference list but never cited', c.uncited, items => `<table class="t">${items.map(u => `<tr><td class="num">${u.index}</td><td>${esc(u.raw)}</td></tr>`).join('')}</table>`)}
    ${sec('Ambiguous citations', c.ambiguous, items => `<table class="t"><tr><th>Citation</th><th>Problem</th><th>Candidates</th></tr>${items.map(a => `<tr><td><b>${esc(a.citation)}</b></td><td>${esc(a.message)}</td><td>${a.candidates.map(i => `<div>[${i}] ${refText(i)}</div>`).join('')}</td></tr>`).join('')}</table>`)}
    ${c.yearMismatch ? sec('Year differs between text and list', c.yearMismatch, items => `<table class="t">${items.map(y => `<tr><td><b>${esc(y.citation)}</b></td><td>${esc(y.message)}</td></tr>`).join('')}</table>`) : ''}
    ${sec(s.system === 'numeric' ? 'Numbering order (references must be numbered in order of first citation)' : 'Alphabetical order of the reference list', c.orderIssues, items => `<ul>${items.map(o => `<li>${esc(o.message)}</li>`).join('')}</ul>`)}
    ${c.numberingIssues?.length ? sec('Reference list numbering', c.numberingIssues, items => `<ul>${items.map(o => `<li>${esc(o)}</li>`).join('')}</ul>`) : ''}`;
}

// ------------------------------------------------------------------ Journals tab

function journalsTab(body, j) {
  if (!j) { body.innerHTML = '<div class="empty">Journal Check was not run.</div>'; return; }
  const s = j.summary;
  body.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="n">${s.journals}</div><div class="l">Cited journals</div></div>
      <div class="kpi bad"><div class="n">${s.highRisk}</div><div class="l">High-risk</div></div>
      <div class="kpi warn"><div class="n">${s.caution}</div><div class="l">Caution</div></div>
      <div class="kpi good"><div class="n">${s.scopus}</div><div class="l">Scopus</div></div>
      <div class="kpi good"><div class="n">${s.wos}</div><div class="l">Web of Science</div></div>
      <div class="kpi good"><div class="n">${s.medline}</div><div class="l">MEDLINE</div></div>
    </div>
    <div class="table-wrap"><table class="t">
      <tr><th>Journal</th><th class="num">Refs</th><th>Indexing</th><th>Quartile</th><th>Verdict</th><th>Flags</th></tr>
      ${j.journals.map((x, i) => journalRow(x, i)).join('')}
    </table></div>
    <p class="muted" style="margin-top:10px">Scopus quartiles, WoS collections, JCR quartiles and HEC HJRS categories appear when the administrator has uploaded the current lists (Users &amp; data → Journal lists). Without them, Scopus coverage is taken from Wikidata.</p>`;
}

export function journalRow(x) {
  const ix = x.indexing || {};
  const verdictTone = { 'high-risk': 'bad', caution: 'warn', ok: 'good' }[x.verdict] || 'neutral';
  const tags = (x.indexed || []).map(t => badge(t, 'info')).join(' ');
  const quart = [ix.scopus?.quartile ? `SJR ${ix.scopus.quartile}` : '', ix.wos?.jcrQuartile ? `JCR ${ix.wos.jcrQuartile}` : ''].filter(Boolean).join(' · ') || '—';
  return `<tr>
    <td><b>${esc(x.title || x.citedName)}</b>${x.citedName && x.title && x.citedName !== x.title ? `<div class="muted">cited as “${esc(x.citedName)}”</div>` : ''}<div class="muted">${esc((x.issns || []).join(', '))}${x.publisher ? ` · ${esc(x.publisher)}` : ''}</div></td>
    <td class="num">${x.refs ? `${x.refs.length}<div class="muted" style="font-size:11px">${x.refs.slice(0, 8).map(r => `[${r}]`).join(' ')}</div>` : ''}</td>
    <td>${tags || '<span class="muted">Not found in major indexes</span>'}</td>
    <td>${esc(quart)}</td>
    <td>${badge(x.verdict === 'high-risk' ? 'High risk' : x.verdict === 'caution' ? 'Caution' : x.verdict === 'ok' ? 'OK' : 'Unknown', verdictTone)}</td>
    <td>${(x.flags || []).map(f => `<div>${badge(f.severity, sevTone(f.severity))} ${esc(f.message)}</div>`).join('') || '<span class="muted">—</span>'}</td>
  </tr>`;
}

// ------------------------------------------------------------------ Citation pattern tab

function patternTab(body, p, refs) {
  if (!p) { body.innerHTML = '<div class="empty">Citation pattern was not analysed.</div>'; return; }
  const s = p.summary;
  body.innerHTML = `
    ${!p.manuscriptAuthors.length ? '<div class="alert alert-warn">No manuscript authors were given, so self-citation could not be measured. Re-run with the author names.</div>' : ''}
    ${p.basis ? `<p class="muted">Relevance is estimated from the manuscript's ${esc(p.basis)} against each reference's title and subject topics.</p>` : ''}
    <div class="kpis">
      <div class="kpi ${s.selfCitationRate >= 25 ? 'bad' : s.selfCitationRate >= 15 ? 'warn' : 'good'}"><div class="n">${s.selfCitationRate}%</div><div class="l">Self-citation (${s.selfCitations})</div></div>
      <div class="kpi ${s.irrelevantSelfCitations ? 'bad' : ''}"><div class="n">${s.irrelevantSelfCitations}</div><div class="l">Irrelevant self-citations</div></div>
      <div class="kpi ${s.authorConcentration ? 'warn' : ''}"><div class="n">${s.authorConcentration}</div><div class="l">Author piles</div></div>
      <div class="kpi ${s.journalConcentration ? 'warn' : ''}"><div class="n">${s.journalConcentration}</div><div class="l">Journal piles</div></div>
      <div class="kpi"><div class="n">${s.homeJournalCitations}</div><div class="l">${esc(p.homeJournal.name.split(' ').filter(w => w.length > 2).map(w => w[0]).join(''))} citations (${s.homeJournalRecent} recent)</div></div>
      <div class="kpi ${s.offTopic ? 'warn' : ''}"><div class="n">${s.offTopic}</div><div class="l">Weakly related</div></div>
    </div>
    <div class="card"><h3>What to look at</h3>
      ${p.flags.length ? p.flags.map(f => `<div class="flag ${f.severity}"><div><div class="msg">${esc(f.message)}</div><div class="guide">${esc(f.guidance)}</div></div></div>`).join('') : '<div class="alert alert-good">No unusual citation pattern found.</div>'}
    </div>
    ${p.selfCitation.refs.length ? `<div class="card"><h3>Self-citations</h3><div class="table-wrap"><table class="t"><tr><th>#</th><th>Reference</th><th>Manuscript author(s)</th><th>Relevance</th></tr>
      ${p.selfCitation.refs.map(x => `<tr><td class="num">${x.index}</td><td>${esc(x.title || '')}${x.year ? ` (${x.year})` : ''}</td><td>${esc(x.authors.join(', '))}<div class="muted">matched by ${esc([...new Set(x.matchedBy)].join(', '))}</div></td><td>${badge(x.relevance?.level || 'unknown', x.relevance?.level === 'weak' ? 'bad' : x.relevance?.level === 'moderate' ? 'warn' : 'good')}</td></tr>`).join('')}
    </table></div></div>` : ''}
    ${p.authorConcentration.length ? `<div class="card"><h3>References piled on one author</h3><table class="t"><tr><th>Author</th><th class="num">Refs</th><th class="num">Share</th><th>Weakly related</th><th>References</th></tr>
      ${p.authorConcentration.map(a => `<tr><td><b>${esc(a.name)}</b>${a.orcid ? `<div class="muted">ORCID ${esc(a.orcid)}</div>` : ''}</td><td class="num">${a.refs.length}</td><td class="num">${Math.round(a.share * 100)}%</td><td>${a.weakRelevance}</td><td class="muted">${a.refs.map(i => `[${i}]`).join(' ')}</td></tr>`).join('')}
    </table></div>` : ''}
    ${p.journalConcentration.length ? `<div class="card"><h3>References piled on one journal</h3><table class="t"><tr><th>Journal</th><th class="num">Refs</th><th class="num">Share</th><th>Weakly related</th><th>References</th></tr>
      ${p.journalConcentration.map(j => `<tr><td><b>${esc(j.journal)}</b>${j.isHome ? ' ' + badge('submission journal', 'warn') : ''}</td><td class="num">${j.refs.length}</td><td class="num">${Math.round(j.share * 100)}%</td><td>${j.weakRelevance}</td><td class="muted">${j.refs.map(i => `[${i}]`).join(' ')}</td></tr>`).join('')}
    </table></div>` : ''}
    ${p.offTopic.length ? `<div class="card"><h3>Weakly related references</h3><table class="t">${p.offTopic.map(o => `<tr><td class="num">${o.index}</td><td>${esc(o.title)}${o.isSelf ? ' ' + badge('self-citation', 'bad') : ''}</td></tr>`).join('')}</table></div>` : ''}`;
}

// ------------------------------------------------------------------ Editor report tab

function editorTab(body, result) {
  body.innerHTML = `
    <div class="tabs" style="margin-top:-4px">
      <button class="tab active" data-sub="summary">Decision summary</button>
      <button class="tab" data-sub="letter">Correction letter</button>
      <button class="tab" data-sub="revision">Revision comparison</button>
    </div>
    <div id="sub"></div>`;
  const sub = $('#sub', body);
  const go = k => {
    $$('[data-sub]', body).forEach(t => t.classList.toggle('active', t.dataset.sub === k));
    ({ summary: summaryView, letter: letterView, revision: revisionView })[k](sub, result).catch(e => (sub.innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`));
  };
  $$('[data-sub]', body).forEach(t => (t.onclick = () => go(t.dataset.sub)));
  go('summary');
}

async function summaryView(el, result) {
  el.innerHTML = '<div class="empty">Preparing summary…</div>';
  const { summary: ds } = await api(`/api/checks/${result.id}/summary`);
  const tone = { reject: 'bad', revise: 'warn', proceed: 'good' }[ds.level];
  const r = ds.references;
  el.innerHTML = `
    <div class="row no-print" style="margin-bottom:12px">
      <button class="btn btn-sm" id="ds-docx">${ICONS.download} Word</button>
      <button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print / PDF</button>
    </div>
    <div class="card">
      <h2>Desk review — reference decision summary</h2>
      <p class="muted">${esc(ds.manuscript.code || '')}${ds.manuscript.code ? ' · ' : ''}Version ${ds.manuscript.version} · ${fmtDate(ds.checkedAt)}</p>
      <p><b>${esc(ds.manuscript.title || 'Untitled manuscript')}</b><br><span class="muted">${esc(ds.manuscript.authors.join(', '))}</span></p>
      <div class="alert alert-${tone}"><b>Recommendation:</b> ${esc(ds.recommendation)}</div>
      ${ds.reasons.length ? `<ul>${ds.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <div class="grid grid-2" style="margin-top:12px">
        <table class="t"><tr><th colspan="2">References</th></tr>
          ${[['Total', r.total], ['Verified', r.verified], ['Miscited', r.miscited], ['Unverified', r.unverified], ['Suspicious', r.suspicious], ['Retracted', r.retracted], ['DOIs found', r.doiSuggested]].map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('')}
        </table>
        <table class="t"><tr><th colspan="2">Citations, journals &amp; pattern</th></tr>
          ${ds.citations ? `<tr><td>Missing from list / never cited</td><td class="num">${ds.citations.missing} / ${ds.citations.uncited}</td></tr><tr><td>Ambiguous citations</td><td class="num">${ds.citations.ambiguous}</td></tr>` : '<tr><td colspan="2" class="muted">Citation Check not available</td></tr>'}
          ${ds.journals ? `<tr><td>High-risk cited journals</td><td class="num">${ds.journals.highRisk} of ${ds.journals.journals}</td></tr>` : ''}
          ${ds.pattern ? `<tr><td>Self-citation</td><td class="num">${ds.pattern.selfCitationRate}%</td></tr><tr><td>Author / journal piles</td><td class="num">${ds.pattern.authorConcentration} / ${ds.pattern.journalConcentration}</td></tr>` : ''}
        </table>
      </div>
      ${ds.topProblems.length ? `<h3 style="margin-top:16px">References needing attention</h3><table class="t">${ds.topProblems.map(p => `<tr><td class="num">${p.index}</td><td>${badge(p.status, statusTone(p.status.toLowerCase()))}</td><td>${esc(p.raw)}<div class="muted">${esc(p.reason)}</div></td></tr>`).join('')}</table>` : ''}
    </div>`;
  $('#ds-docx', el).onclick = () => download(`/api/checks/${result.id}/summary?format=docx`).catch(e => toast(e.message, 'error'));
}

async function letterView(el, result, lang = 'en') {
  el.innerHTML = '<div class="empty">Preparing letter…</div>';
  const { letter } = await api(`/api/checks/${result.id}/letter?lang=${lang}`);
  el.innerHTML = `
    <div class="row no-print" style="margin-bottom:12px">
      <div class="filters" style="margin:0"><button class="filter ${lang === 'en' ? 'active' : ''}" data-lang="en">English</button><button class="filter ${lang === 'ur' ? 'active' : ''}" data-lang="ur">اردو Urdu</button></div>
      <span class="spacer"></span>
      <button class="btn btn-sm" id="l-copy">${ICONS.copy} Copy</button>
      <button class="btn btn-sm" id="l-docx">${ICONS.download} Word</button>
      <button class="btn btn-sm" id="l-txt">${ICONS.download} Text</button>
    </div>
    ${letter.count ? '' : '<div class="alert alert-good">No corrections are needed — all references verified.</div>'}
    <div class="letter ${letter.rtl ? 'urdu' : ''}">${esc(letter.text)}</div>`;
  $$('[data-lang]', el).forEach(b => (b.onclick = () => letterView(el, result, b.dataset.lang)));
  $('#l-copy', el).onclick = () => copyText(letter.text);
  $('#l-docx', el).onclick = () => download(`/api/checks/${result.id}/letter?lang=${lang}&format=docx`).catch(e => toast(e.message, 'error'));
  $('#l-txt', el).onclick = () => download(`/api/checks/${result.id}/letter?lang=${lang}&format=txt`).catch(e => toast(e.message, 'error'));
}

async function revisionView(el, result) {
  const code = result.meta?.manuscriptCode;
  if (!code) {
    el.innerHTML = '<div class="alert alert-info">Give the manuscript an ID when you run the check. When the author resubmits, run the revised version with the same ID — the versions are then compared here (added, removed, fixed and newly problematic references).</div>';
    return;
  }
  const { checks } = await api(`/api/checks?code=${encodeURIComponent(code)}`);
  const others = checks.filter(c => c.id !== result.id && c.has_result && ['manuscript', 'references'].includes(c.kind));
  if (!others.length) {
    el.innerHTML = `<div class="alert alert-info">This is the only saved version of <b>${esc(code)}</b>. Run the revised manuscript with the same Manuscript ID to compare.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="row no-print" style="margin-bottom:12px">
      <label style="margin:0">Compare with</label>
      <select id="rv-other" style="width:auto">${others.map(c => `<option value="${c.id}">Version ${c.version} · ${fmtDate(c.created_at)}</option>`).join('')}</select>
      <button class="btn btn-sm" id="rv-docx">${ICONS.download} Word</button>
    </div>
    <div id="rv-body"></div>`;
  const load = async () => {
    const other = $('#rv-other', el).value;
    const o = others.find(c => String(c.id) === other);
    const [older, newer] = o.version < (result.meta.version || 1) ? [other, result.id] : [result.id, other];
    const { comparison: c } = await api(`/api/checks/${newer}/compare/${older}`);
    const s = c.summary;
    const changeLabel = { fixed: ['Fixed', 'good'], 'removed-problem': ['Problem removed', 'good'], 'still-problem': ['Still a problem', 'bad'], 'new-problem': ['New problem', 'bad'], 'added-problem': ['Added — problem', 'bad'], added: ['Added', 'info'], removed: ['Removed', 'neutral'] };
    $('#rv-body', el).innerHTML = `
      <div class="alert alert-${s.stillProblem + s.newProblem ? 'warn' : 'good'}"><b>${esc(c.verdict)}</b> Requested fixes addressed: ${s.addressed} of ${s.requested} (${s.completion}%).</div>
      <div class="kpis">
        <div class="kpi good"><div class="n">${s.fixed}</div><div class="l">Fixed</div></div>
        <div class="kpi good"><div class="n">${s.removedProblem}</div><div class="l">Problem refs removed</div></div>
        <div class="kpi bad"><div class="n">${s.stillProblem}</div><div class="l">Still problematic</div></div>
        <div class="kpi bad"><div class="n">${s.newProblem}</div><div class="l">New problems</div></div>
        <div class="kpi"><div class="n">${s.added} / ${s.removed}</div><div class="l">Added / removed</div></div>
      </div>
      ${c.citations ? `<p>Citations missing from list: <b>${c.citations.missing.before} → ${c.citations.missing.after}</b> · never cited: <b>${c.citations.uncited.before} → ${c.citations.uncited.after}</b> · ambiguous: <b>${c.citations.ambiguous.before} → ${c.citations.ambiguous.after}</b>${c.selfCitation ? ` · self-citation: <b>${c.selfCitation.before}% → ${c.selfCitation.after}%</b>` : ''}</p>` : ''}
      <div class="table-wrap"><table class="t"><tr><th>Change</th><th>Version ${c.before.version}</th><th>Version ${c.after.version}</th></tr>
        ${c.rows.map(r => `<tr><td>${badge(...(changeLabel[r.change] || [r.change, 'neutral']))}</td><td>${r.before ? `[${r.before.index}] ${badge(r.before.statusLabel, statusTone(r.before.status))} ${esc(r.before.raw)}` : '—'}</td><td>${r.after ? `[${r.after.index}] ${badge(r.after.statusLabel, statusTone(r.after.status))} ${esc(r.after.raw)}` : '—'}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No differences.</td></tr>'}
      </table></div>`;
    $('#rv-docx', el).onclick = () => download(`/api/checks/${newer}/compare/${older}?format=docx`).catch(e => toast(e.message, 'error'));
  };
  $('#rv-other', el).onchange = () => load().catch(e => toast(e.message, 'error'));
  await load();
}
