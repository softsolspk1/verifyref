// views/journalFinder.js - Find a Journal: evidence-based suggestions with a decision bar
import { api, esc, $, $$, toast, startJob, download, badge, modal, ICONS } from '../core.js';
import { journalCard } from './journal.js';

export function renderJournalFinder(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Find a Journal</h1>
      <p>Suggestions based on where papers like yours were actually published in the last three years — not on keyword matching. Use the decision bar to filter by indexing, quartile, access and APC; journals just outside your filters are listed with the reason.</p></div></div>
    <div id="form-area" class="card">
      <div class="field"><label for="title">Paper title</label><input id="title" type="text"></div>
      <div class="field"><label for="abs">Abstract <span class="muted">(recommended)</span></label><textarea id="abs" rows="5"></textarea></div>
      <button class="btn btn-primary" id="run">Find journals</button>
    </div>
    <div id="progress"></div><div id="result"></div>`;
  $('#run', view).onclick = async () => {
    const title = $('#title', view).value.trim();
    if (title.length < 10) return toast('Enter the paper title.', 'error');
    $('#run', view).disabled = true;
    try {
      const r = await startJob('/api/journal-finder', { body: { title, abstract: $('#abs', view).value } }, $('#progress', view), 'Finding journals that publish papers like yours');
      if (r) renderJournalFinderResult($('#result', view), r);
    } catch (e) { toast(e.message, 'error'); } finally { $('#run', view).disabled = false; }
  };
}

const FILTERS = {
  index: { label: 'Indexing', options: [['any', 'Any'], ['scopus', 'Scopus'], ['wos', 'Web of Science'], ['medline', 'MEDLINE'], ['doaj', 'DOAJ'], ['ebsco', 'EBSCO'], ['hjrs', 'HEC HJRS (any)'], ['hjrs-wx', 'HJRS W or X'], ['hjrs-w', 'HJRS W']] },
  quartile: { label: 'Minimum quartile', options: [['any', 'Any'], ['1', 'Q1'], ['2', 'Q2 or better'], ['3', 'Q3 or better']] },
  access: { label: 'Access', options: [['any', 'Any'], ['oa', 'Open access'], ['diamond', 'Diamond OA (no fee)'], ['sub', 'Subscription / hybrid']] },
  apc: { label: 'Maximum APC', options: [['any', 'Any'], ['0', 'No fee'], ['500', '≤ $500'], ['1000', '≤ $1,000'], ['2000', '≤ $2,000'], ['3000', '≤ $3,000']] },
  sort: { label: 'Sort by', options: [['evidence', 'Evidence (similar papers)'], ['quartile', 'Quartile'], ['speed', 'Shortest process'], ['apc', 'Lowest APC']] }
};

/** Reasons a journal fails the current filters (empty = passes) */
function reasons(j, f) {
  const out = [];
  const ix = j.indexing;
  const idx = {
    scopus: [ix.scopus === true, 'not in the uploaded Scopus/SJR list'], wos: [ix.wos.length > 0, 'not in Web of Science lists'],
    medline: [ix.medline === true, 'not MEDLINE-indexed'], doaj: [j.doaj, 'not in DOAJ'], ebsco: [!!ix.ebsco, 'not in the EBSCO lists'], hjrs: [!!ix.hjrs, 'not in HEC HJRS'], 'hjrs-wx': [['W', 'X'].includes(ix.hjrs), `HJRS ${ix.hjrs || 'none'}`], 'hjrs-w': [ix.hjrs === 'W', `HJRS ${ix.hjrs || 'none'}`]
  };
  if (f.index !== 'any' && !idx[f.index][0]) out.push(idx[f.index][1]);
  if (f.quartile !== 'any' && !(j.quartile && j.quartile <= +f.quartile)) out.push(j.quartile ? `Q${j.quartile}` : 'no quartile');
  if (f.access === 'oa' && !j.oa) out.push('not open access');
  if (f.access === 'diamond' && !j.diamond) out.push('charges an APC or not Diamond');
  if (f.access === 'sub' && j.oa) out.push('fully open access');
  if (f.apc !== 'any' && j.apcUsd !== null && j.apcUsd > +f.apc) out.push(`APC $${j.apcUsd}`);
  if (f.hideFlagged && j.flags.some(x => x.severity === 'high')) out.push('risk signal');
  return out;
}

function jRow(j, why) {
  const ix = j.indexing;
  const tags = [ix.scopus ? badge('Scopus', 'good') : '', ...ix.wos.map(w => badge(w, 'good')), ix.medline ? badge('MEDLINE', 'good') : '', j.doaj ? badge('DOAJ', 'good') : '', ix.ebsco ? badge('EBSCO', 'good') : '', ix.hjrs ? badge(`HJRS ${ix.hjrs}`, 'good') : '',
    j.quartile ? badge(`Q${j.quartile}`, 'info') : '', j.diamond ? badge('Diamond OA', 'info') : j.oa ? badge('Open access', 'info') : '', j.apcUsd ? badge(`APC $${j.apcUsd.toLocaleString()}`, 'neutral') : j.apcUsd === 0 ? badge('No APC', 'good') : '',
    j.weeksToPublication ? badge(`~${j.weeksToPublication} weeks`, 'neutral') : ''].filter(Boolean).join(' ');
  return `<div class="jcard ${why ? 'excluded' : ''}">
    <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">
      <div><h3>${esc(j.name)}</h3><div class="muted">${esc(j.publisher || '')}${j.issns.length ? ` · ISSN ${esc(j.issns.join(', '))}` : ''}</div></div>
      <div class="row" style="flex:none"><button class="btn btn-sm" data-check="${esc(j.id)}">Check journal</button></div></div>
    <div style="margin:8px 0"><b>Published ${j.similar} paper${j.similar === 1 ? '' : 's'} like yours</b> in the last three years ${j.scopeMatch === 'weak' ? badge('Scope match — weak evidence', 'warn') : ''}${j.pakistaniPapers ? ` <span class="muted">· ${j.pakistaniPapers} by Pakistan-based authors</span>` : ''}</div>
    <div class="row" style="gap:5px">${tags}</div>
    ${j.flags.length ? j.flags.map(f => `<div class="flag ${f.severity}" style="margin:8px 0 0"><div class="msg">${esc(f.message)}</div></div>`).join('') : ''}
    ${why ? `<div class="alert alert-warn" style="margin:8px 0 0">Excluded by your filters: ${esc(why.join('; '))}</div>` : ''}
    <details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Why suggested?</summary><ul>${j.samples.map(s => `<li>${esc(s.title)} (${s.year})${s.doi ? ` <a href="https://doi.org/${esc(s.doi)}" target="_blank" rel="noopener">doi</a>` : ''}</li>`).join('')}</ul></details>
  </div>`;
}

export function renderJournalFinderResult(el, r) {
  const f = { index: 'any', quartile: 'any', access: 'any', apc: 'any', sort: 'evidence', hideFlagged: false };
  el.innerHTML = `
    <div class="card-head"><h2 style="margin:0">${r.journals.length} journals for “${esc(r.title.slice(0, 100))}”</h2>
      <div class="row no-print"><span class="muted">${r.screened} similar papers screened</span><button class="btn btn-sm" id="csv">${ICONS.download} CSV</button><button class="btn btn-sm" id="docx">${ICONS.download} Word</button></div></div>
    ${r.note ? `<div class="alert alert-info">${esc(r.note)}</div>` : ''}
    <div class="decision no-print">${Object.entries(FILTERS).map(([k, d]) => `<div class="field"><label>${d.label}</label><select data-f="${k}">${d.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>`).join('')}
      <label class="check" style="margin:0 0 6px"><input type="checkbox" id="hide"> Hide risk signals</label></div>
    <div id="list"></div>`;
  const draw = () => {
    const pass = [], fail = [];
    for (const j of r.journals) { const why = reasons(j, f); (why.length ? fail : pass).push({ j, why }); }
    const sorters = { evidence: (a, b) => b.j.relevance - a.j.relevance, quartile: (a, b) => (a.j.quartile || 9) - (b.j.quartile || 9) || b.j.relevance - a.j.relevance, speed: (a, b) => (a.j.weeksToPublication || 999) - (b.j.weeksToPublication || 999), apc: (a, b) => (a.j.apcUsd ?? 99999) - (b.j.apcUsd ?? 99999) };
    pass.sort(sorters[f.sort]);
    fail.sort((a, b) => a.why.length - b.why.length || b.j.relevance - a.j.relevance);
    $('#list', el).innerHTML = (pass.length ? pass.map(x => jRow(x.j)).join('') : '<div class="card empty">No journal matches all your filters.</div>')
      + (fail.length ? `<h3 style="margin-top:22px">Journals closest to your filters</h3>${fail.slice(0, 6).map(x => jRow(x.j, x.why)).join('')}` : '');
    $$('[data-check]', el).forEach(b => (b.onclick = () => checkModal(r.journals.find(j => j.id === b.dataset.check))));
    el._visible = pass.map(x => x.j);
  };
  $$('[data-f]', el).forEach(s => (s.onchange = () => { f[s.dataset.f] = s.value; draw(); }));
  $('#hide', el).onchange = e => { f.hideFlagged = e.target.checked; draw(); };
  $('#csv', el).onclick = () => download('/api/journal-finder/export', { journals: el._visible?.length ? el._visible : r.journals }).catch(e => toast(e.message, 'error'));
  $('#docx', el).onclick = () => download('/api/export/docx', { kind: 'journal-finder', data: { ...r, journals: el._visible?.length ? el._visible : r.journals } }).catch(e => toast(e.message, 'error'));
  draw();
}

function checkModal(j) {
  modal(`<div class="card-head"><h2 style="margin:0">Journal Check</h2><button class="btn btn-sm btn-ghost" data-close>✕</button></div><div id="jc"><div class="progress">Checking ${esc(j.name)}…</div></div>`, {
    onMount: async m => {
      try {
        const { journal } = await api('/api/journal-check', { body: { name: j.name, issn: j.issns[0] || '' } });
        $('#jc', m).innerHTML = journalCard(journal);
      } catch (e) { $('#jc', m).innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`; }
    }
  });
}
