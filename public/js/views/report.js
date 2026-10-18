// views/report.js - renders a check result: References, Citations, Journals, Citation pattern, Editor report
import { api, esc, $, $$, badge, sevTone, toast, download, copyText, fmtDate, pct, ICONS, issueOptions, state } from '../core.js';

export async function renderSavedReport(view, id) {
  view.innerHTML = '<div class="empty">Loading report…</div>';
  const d = await api(`/api/checks/${id}`);
  view.innerHTML = '';
  if (d.result.kind === 'reviewer-report') {
    const { renderReviewerReportResult } = await import('./reviewerReport.js');
    view.innerHTML = '<div id="rr"></div>';
    renderReviewerReportResult($('#rr', view), d.result);
    return;
  }
  renderReport(view, d.result, { kind: d.result.kind, saved: true });
}

const STATUS_ORDER = ['suspicious', 'retracted', 'miscited', 'unverified', 'verified'];
const statusTone = s => ({ verified: 'good', miscited: 'warn', retracted: 'bad', suspicious: 'bad', unverified: 'neutral' }[s] || 'neutral');

export function renderReport(el, result, { kind } = {}) {
  const refs = result.references?.results || [];
  const s = result.references?.summary || {};
  const meta = result.meta || {};
  const id = result.id;
  const tabs = [];
  if (kind !== 'citations') tabs.push(['references', 'References', s.total]);
  if (result.citations) tabs.push(['citations', 'Citations', result.citations.summary ? (result.citations.summary.missing + result.citations.summary.uncited) : null]);
  if (result.journals) tabs.push(['journals', 'Journals', result.journals.summary?.journals]);
  if (result.pattern) tabs.push(['pattern', 'Citation pattern', result.pattern.flags?.length]);
  if (id && kind !== 'citations') tabs.push(['editor', 'Editor report', null]);

  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>${esc(meta.title || (kind === 'citations' ? 'Citation Check' : 'Reference Check'))}</h1>
        <p>${meta.manuscriptCode ? `<b>${esc(meta.manuscriptCode)}</b> · version ${meta.version || 1} · ` : ''}${fmtDate(result.createdAt)}${result.truncated ? ` · <span class="badge b-warn">Only the first ${refs.length} of ${result.totalFound} references were checked</span>` : ''}</p>
      </div>
      <div class="row no-print">
        ${id ? `<select id="issue-assign" class="btn-sm" style="width:auto" title="Issue">${issueOptions(result.issueId)}</select>` : ''}
        ${id && kind !== 'citations' ? `
          <div style="position:relative">
            <button class="btn btn-sm" id="export-btn">${ICONS.download} Export ▾</button>
            <div id="export-menu" class="card" hidden style="position:absolute;right:0;top:36px;z-index:20;padding:6px;min-width:230px">
              ${[['csv', 'Audit report (CSV)'], ['docx', 'Reference report (Word)'], ['corrected', 'Corrected reference list (.txt)'], ['bibtex', 'BibTeX (.bib)'], ['ris', 'RIS (.ris)']].map(([f, l]) => `<button class="btn btn-ghost btn-sm" style="width:100%;justify-content:flex-start" data-export="${f}">${l}</button>`).join('')}
            </div>
          </div>` : ''}
        <button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print / PDF</button>
      </div>
    </div>
    ${kind !== 'citations' ? kpis(s) : ''}
    ${s.suspicious || s.retracted ? `<div class="alert alert-bad"><b>Publication integrity alert:</b> ${s.suspicious ? `${s.suspicious} reference(s) could not be found in any of the 12 databases (possibly fabricated)` : ''}${s.suspicious && s.retracted ? '; ' : ''}${s.retracted ? `${s.retracted} retracted work(s) cited` : ''}.</div>` : ''}
    <div class="tabs">${tabs.map(([k, l, c], i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-tab="${k}">${esc(l)}${c !== null && c !== undefined ? `<span class="count">${c}</span>` : ''}</button>`).join('')}</div>
    <div id="tab-body"></div>`;

  const body = $('#tab-body', el);
  const show = k => {
    $$('.tab', el).forEach(t => t.classList.toggle('active', t.dataset.tab === k));
    if (k === 'references') referencesTab(body, refs, s);
    else if (k === 'citations') citationsTab(body, result.citations, refs);
    else if (k === 'journals') journalsTab(body, result.journals);
    else if (k === 'pattern') patternTab(body, result.pattern, refs);
    else if (k === 'editor') editorTab(body, result);
  };
  $$('.tab', el).forEach(t => (t.onclick = () => show(t.dataset.tab)));
  $$('.kpi.clickable', el).forEach(k => (k.onclick = () => { show('references'); const f = $(`.filter[data-f="${k.dataset.f}"]`, el); if (f) f.click(); }));
  show(tabs[0][0]);

  const eb = $('#export-btn', el);
  if (eb) {
    const menu = $('#export-menu', el);
    eb.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('click', () => (menu.hidden = true), { once: true });
    $$('[data-export]', el).forEach(b => (b.onclick = () => download(`/api/checks/${id}/export?format=${b.dataset.export}`).catch(e => toast(e.message, 'error'))));
  }
  const ia = $('#issue-assign', el);
  if (ia) ia.onchange = () => api(`/api/checks/${id}`, { method: 'PATCH', body: { issueId: ia.value || null } }).then(() => toast(ia.value ? 'Added to issue' : 'Removed from issue')).catch(e => toast(e.message, 'error'));
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
    ${k(s.doiSuggested, 'DOIs found', 'info', 'doi')}
  </div>`;
}

// ------------------------------------------------------------------ References tab

function referencesTab(body, refs, s) {
  const ages = s.ages || {};
  const totalAged = (ages.last5 || 0) + (ages.y6to10 || 0) + (ages.y11to20 || 0) + (ages.older || 0);
  const bar = (label, n) => `<div class="bar-row"><span>${label}</span><div class="bar-track"><span style="width:${pct(n, totalAged)}%"></span></div><span class="num">${n || 0}</span></div>`;
  body.innerHTML = `
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
      ${[['all', 'All', refs.length], ...STATUS_ORDER.map(st => [st, st[0].toUpperCase() + st.slice(1), refs.filter(r => r.status === st).length]), ['doi', 'DOI found', refs.filter(r => !r.parsed?.doi && r.record?.doi).length], ['broken', 'Broken links', refs.filter(r => r.links?.some(l => l.status === 'broken')).length]]
        .map(([f, l, c]) => `<button class="filter ${f === 'all' ? 'active' : ''}" data-f="${f}">${l} (${c})</button>`).join('')}
      <span class="spacer"></span>
      <button class="filter" id="expand-all">Expand all</button>
    </div>
    <div id="ref-list"></div>`;

  const list = $('#ref-list', body);
  const draw = f => {
    const shown = refs.filter(r => f === 'all' || r.status === f || (f === 'doi' && !r.parsed?.doi && r.record?.doi) || (f === 'broken' && r.links?.some(l => l.status === 'broken')));
    list.innerHTML = shown.length ? shown.map(refRow).join('') : '<div class="empty">No references in this category.</div>';
    $$('.ref-head', list).forEach(h => (h.onclick = () => h.parentElement.classList.toggle('open')));
    $$('[data-copy]', list).forEach(b => (b.onclick = e => { e.stopPropagation(); copyText(b.dataset.copy); }));
  };
  $$('.filter[data-f]', body).forEach(b => (b.onclick = () => { $$('.filter[data-f]', body).forEach(x => x.classList.remove('active')); b.classList.add('active'); draw(b.dataset.f); }));
  $('#expand-all', body).onclick = () => { const open = !$('.ref.open', list); $$('.ref', list).forEach(r => r.classList.toggle('open', open)); };
  $$('[data-goto]', body).forEach(a => (a.onclick = e => { e.preventDefault(); const r = $(`#ref-${a.dataset.goto}`, list); if (r) { r.classList.add('open'); r.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }));
  draw('all');
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
  const title = i => esc((refs.find(r => r.index === i)?.record?.title || refs.find(r => r.index === i)?.parsed?.title || '').slice(0, 140));
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
  const id = result.id;
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
