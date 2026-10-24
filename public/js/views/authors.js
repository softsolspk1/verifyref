// views/authors.js - Find by Author: pick the right person, list their publications, copy them in any style
import { api, esc, $, $$, toast, styleOptions, download, copyText, badge, hasModule, ICONS } from '../core.js';

export function renderAuthors(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Find by Author</h1>
      <p>Find a researcher's verified publications (not AI-generated) and copy them into your bibliography in any style. Add a topic to tell apart people with the same name; follow an author for weekly notices of new work.</p></div></div>
    <div class="card"><form id="af" class="grid" style="grid-template-columns:2fr 2fr auto;align-items:end">
      <div class="field" style="margin:0"><label for="name">Author name or ORCID</label><input id="name" type="text" placeholder="e.g. Muhammad Iqbal Choudhary"></div>
      <div class="field" style="margin:0"><label for="topic">Topic <span class="muted">(optional)</span></label><input id="topic" type="text" placeholder="e.g. natural products"></div>
      <button class="btn btn-primary" type="submit">Search</button></form></div>
    <div id="cands"></div><div id="works"></div>`;
  $('#af', view).onsubmit = async e => {
    e.preventDefault();
    const name = $('#name', view).value.trim();
    if (name.length < 3) return toast('Enter the author’s name.', 'error');
    $('#works', view).innerHTML = '';
    $('#cands', view).innerHTML = '<div class="progress">Searching…</div>';
    try {
      const r = await api(`/api/authors?name=${encodeURIComponent(name)}&topic=${encodeURIComponent($('#topic', view).value)}`);
      $('#cands', view).innerHTML = r.candidates.length ? `<div class="card"><h3>Which ${esc(name)}?</h3><div class="table-wrap"><table class="t">
        <tr><th>Name</th><th>Institution</th><th>ORCID</th><th class="num">Works</th><th class="num">Citations</th><th>Topics</th><th></th></tr>
        ${r.candidates.map(c => `<tr><td><b>${esc(c.name)}</b>${c.topicMatch !== undefined ? `<div class="muted">topic match ${c.topicMatch}%</div>` : ''}</td><td>${esc(c.institution || '—')}${c.country ? ` <span class="muted">(${esc(c.country)})</span>` : ''}</td>
          <td>${c.orcid ? `<a href="https://orcid.org/${esc(c.orcid)}" target="_blank" rel="noopener">${esc(c.orcid)}</a>` : '—'}</td><td class="num">${c.works}</td><td class="num">${Number(c.citations || 0).toLocaleString()}</td>
          <td class="muted" style="font-size:12.5px">${esc(c.topics.join('; '))}</td><td><button class="btn btn-sm btn-primary" data-pick="${esc(c.id)}">Select</button></td></tr>`).join('')}</table></div></div>` : '<div class="card empty">No author found with this name.</div>';
      $$('[data-pick]', view).forEach(b => (b.onclick = () => loadWorks($('#works', view), b.dataset.pick, $('#topic', view).value, 'apa7')));
    } catch (err) { $('#cands', view).innerHTML = `<div class="alert alert-bad">${esc(err.message)}</div>`; }
  };
}

async function loadWorks(el, id, topic, style) {
  el.innerHTML = '<div class="progress">Loading publications…</div>';
  try {
    const r = await api(`/api/authors/${id}/works?style=${style}&topic=${encodeURIComponent(topic || '')}`);
    renderAuthorWorks(el, r, { topic, reload: s => loadWorks(el, id, topic, s) });
    el.scrollIntoView({ behavior: 'smooth' });
  } catch (e) { el.innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`; }
}

export function renderAuthorWorks(el, r, { reload } = {}) {
  const a = r.author || {};
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><div><h2 style="margin:0">${esc(a.name || '')}</h2><div class="muted">${esc(a.institution || '')}${a.orcid ? ` · ORCID ${esc(a.orcid)}` : ''} · ${r.total} works${a.hIndex ? ` · h-index ${a.hIndex}` : ''}</div></div>
        <div class="row no-print">${hasModule('alerts') && a.id ? `<button class="btn btn-sm" id="follow">Follow author</button>` : ''}<button class="btn btn-sm" id="save">Save</button></div></div>
      <div class="row no-print" style="margin-bottom:10px">
        ${reload ? `<select id="style" style="width:auto">${styleOptions(r.style)}</select>` : ''}
        <label class="check" style="margin:0"><input type="checkbox" id="all"> Select all</label>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="copy">${ICONS.copy} Copy selected</button>
        <button class="btn btn-sm" id="bib">BibTeX</button><button class="btn btn-sm" id="ris">RIS</button><button class="btn btn-sm" id="csv">CSV</button><button class="btn btn-sm" id="docx">Word</button>
      </div>
      <div>${r.works.map((w, i) => `<div class="entry" style="display:flex;gap:10px;border-left-color:${w.retracted ? 'var(--bad)' : 'var(--border-strong)'}"><input type="checkbox" data-w="${i}" style="margin-top:4px">
        <div style="flex:1"><div>${w.html}</div><div class="muted" style="font-size:12px;margin-top:4px">${w.citedBy ?? 0} citations${w.type ? ` · ${esc(w.type)}` : ''}${w.topicMatch !== null && w.topicMatch !== undefined ? ` · topic match ${w.topicMatch}%` : ''} ${w.retracted ? badge('Retracted', 'bad') : ''}</div></div></div>`).join('')}</div>
    </div>`;
  const picked = () => { const s = $$('[data-w]:checked', el).map(c => r.works[c.dataset.w]); return s.length ? s : r.works; };
  $('#all', el).onchange = e => $$('[data-w]', el).forEach(c => (c.checked = e.target.checked));
  $('#copy', el).onclick = () => copyText(picked().map(w => w.text).join('\n'));
  $('#bib', el).onclick = () => download('/api/export/csv', { kind: 'bibtex', data: { records: picked().map(w => w.record) } }).catch(e => toast(e.message, 'error'));
  $('#ris', el).onclick = () => download('/api/export/csv', { kind: 'ris', data: { records: picked().map(w => w.record) } }).catch(e => toast(e.message, 'error'));
  $('#csv', el).onclick = () => download('/api/export/csv', { kind: 'authors', data: { works: picked() } }).catch(e => toast(e.message, 'error'));
  $('#docx', el).onclick = () => download('/api/export/docx', { kind: 'authors', data: { ...r, works: picked() } }).catch(e => toast(e.message, 'error'));
  if ($('#style', el)) $('#style', el).onchange = e => reload(e.target.value);
  if ($('#follow', el)) $('#follow', el).onclick = () => api('/api/follows', { body: { kind: 'author', key: a.id, label: a.name } }).then(() => toast(`Following ${a.name} — weekly notices of new publications`)).catch(e => toast(e.message, 'error'));
  $('#save', el).onclick = () => api('/api/activity/save', { body: { kind: 'authors', title: `Publications of ${a.name}`, result: r } }).then(() => toast('Saved to My Activity')).catch(e => toast(e.message, 'error'));
}
