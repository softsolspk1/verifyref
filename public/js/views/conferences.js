// views/conferences.js - Find a Conference / Check a Conference, follow conferences, community-added conferences
import { api, esc, $, $$, toast, startJob, download, badge, modal, hasModule, ICONS } from '../core.js';

export function renderConferences(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Find &amp; Check a Conference</h1>
      <p>Find proceedings where papers like yours were actually published, or check a conference's year-by-year index coverage by name, acronym or ISBN. Dates, venues and deadlines are not listed — open the conference website for those.</p></div></div>
    <div class="seg" style="margin-bottom:14px"><button class="active" data-mode="find">Find a conference</button><button data-mode="check">Check a conference</button></div>
    <div id="pane"></div>`;
  const show = mode => {
    $$('.seg button', view).forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    (mode === 'find' ? findPane : checkPane)($('#pane', view));
  };
  $$('.seg button', view).forEach(b => (b.onclick = () => show(b.dataset.mode)));
  show('find');
}

function findPane(el) {
  el.innerHTML = `
    <div class="card" id="form-area">
      <div class="field"><label for="title">Paper title</label><input id="title" type="text" placeholder="One complete sentence works best"></div>
      <div class="field"><label for="abs">Abstract <span class="muted">(optional)</span></label><textarea id="abs" rows="4"></textarea></div>
      <button class="btn btn-primary" id="run">Find conferences</button>
    </div>
    <div id="progress"></div><div id="result"></div>`;
  $('#run', el).onclick = async () => {
    const title = $('#title', el).value.trim();
    if (title.length < 10) return toast('Enter the paper title.', 'error');
    try {
      const r = await startJob('/api/conferences/find', { body: { title, abstract: $('#abs', el).value } }, $('#progress', el), 'Finding conferences with similar papers');
      if (r) renderConferenceResult($('#result', el), r);
    } catch (e) { toast(e.message, 'error'); }
  };
}

function checkPane(el) {
  el.innerHTML = `
    <div class="card"><form id="cf" class="row"><input id="q" type="text" placeholder="Conference name, acronym or ISBN" style="flex:1;min-width:240px"><button class="btn btn-primary" type="submit">Check</button></form></div>
    <div id="result"></div>`;
  $('#cf', el).onsubmit = async e => {
    e.preventDefault();
    const q = $('#q', el).value.trim();
    if (q.length < 2) return;
    $('#result', el).innerHTML = '<div class="progress">Checking coverage…</div>';
    try {
      const r = await api(`/api/conferences/check?q=${encodeURIComponent(q)}`);
      renderConferenceResult($('#result', el), r);
    } catch (err) { $('#result', el).innerHTML = `<div class="alert alert-bad">${esc(err.message)}</div>`; }
  };
}

const scopusBadge = s => (s.known ? (s.indexed ? badge(`Scopus${s.years.length ? ` ${s.years[0]}–${s.years[s.years.length - 1]}` : ''}`, 'good') : badge('Scopus discontinued', 'bad')) : badge('Scopus: not in uploaded list', 'neutral'));

function follow(c) {
  return api('/api/follows', { body: { kind: 'conference', key: c.id, label: c.name } }).then(() => toast('Following — you will be notified when a new edition is indexed.')).catch(e => toast(e.message, 'error'));
}

export function renderConferenceResult(el, r) {
  if (r.mode === 'check') {
    el.innerHTML = `<div class="alert alert-info">${esc(r.note)}</div>${r.isbnTitle ? `<p>ISBN belongs to: <b>${esc(r.isbnTitle)}</b></p>` : ''}
      ${r.candidates.length ? r.candidates.map((c, i) => `
        <div class="card"><div class="card-head"><div><h3>${esc(c.name)}</h3><div class="muted">${esc(c.publisher || '')}${c.acronym ? ` · ${esc(c.acronym)}` : ''}${c.issns.length ? ` · ISSN ${esc(c.issns.join(', '))}` : ''}</div></div>
          <div class="row">${scopusBadge(c.scopus)} ${c.annual ? badge('Annual', 'info') : badge(c.regularity, 'neutral')} ${hasModule('alerts') ? `<button class="btn btn-sm" data-follow="${i}">Follow</button>` : ''}</div></div>
          ${c.yearByYear?.length ? `<div class="table-wrap"><table class="t"><tr><th>Year</th><th class="num">Papers (OpenAlex)</th><th>Scopus coverage</th></tr>${c.yearByYear.slice().reverse().map(y => `<tr><td>${y.year}</td><td class="num">${y.works}</td><td>${y.scopus === null ? '<span class="muted">unknown — upload the Scopus source list</span>' : y.scopus ? badge('Covered', 'good') : badge('Not covered', 'warn')}</td></tr>`).join('')}</table></div>` : ''}
          ${c.homepage ? `<p><a href="${esc(c.homepage)}" target="_blank" rel="noopener">Conference / series website</a></p>` : ''}
        </div>`).join('') : '<div class="card empty">No conference proceedings matched. Try the full name or the acronym.</div>'}
      ${communityList(r.community)}`;
    $$('[data-follow]', el).forEach(b => (b.onclick = () => follow(r.candidates[b.dataset.follow])));
    return;
  }
  const f = { pk: false, recent: false, noGeneral: false };
  el.innerHTML = `
    <div class="card-head"><h2 style="margin:0">${r.conferences.length} conferences for “${esc(r.title.slice(0, 90))}”</h2><div class="row no-print"><button class="btn btn-sm" id="docx">${ICONS.download} Word</button></div></div>
    <div class="alert alert-info">${esc(r.note)}</div>
    <div class="filters no-print"><button class="filter" data-f="pk">With Pakistan-based authors</button><button class="filter" data-f="recent">Recent editions only</button><button class="filter" data-f="noGeneral">Exclude general series</button></div>
    <div id="list"></div>
    ${communityList(r.community, true)}`;
  const year = new Date().getFullYear();
  const draw = () => {
    const list = r.conferences.filter(c => (!f.pk || c.pakistaniPapers) && (!f.recent || (c.lastYear || 0) >= year - 1) && (!f.noGeneral || !c.generalSeries));
    $('#list', el).innerHTML = list.length ? list.map(c => `
      <div class="jcard"><div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap"><div><h3>${esc(c.name)}</h3><div class="muted">${esc(c.publisher || '')}</div></div>
        <div class="row" style="flex:none">${hasModule('alerts') ? `<button class="btn btn-sm" data-follow="${esc(c.id)}">Follow</button>` : ''}${c.homepage ? `<a class="btn btn-sm" href="${esc(c.homepage)}" target="_blank" rel="noopener">Website</a>` : ''}</div></div>
        <div style="margin:8px 0"><b>${c.similar} paper${c.similar === 1 ? '' : 's'} on this topic</b>${c.pakistaniPapers ? ` <span class="muted">· ${c.pakistaniPapers} by Pakistan-based authors</span>` : ''}</div>
        <div class="row" style="gap:5px">${scopusBadge(c.scopus)} ${c.annual ? badge('Held annually', 'info') : badge(c.regularity, 'neutral')} ${c.lastYear ? badge(`Last indexed edition ${c.lastYear}`, 'neutral') : ''} ${c.upcomingRegistered ? badge('Upcoming proceedings registered', 'good') : ''} ${c.generalSeries ? badge('General series', 'warn') : ''}</div>
        <details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Why suggested?</summary><ul>${c.samples.map(s => `<li>${esc(s.title)} (${s.year})</li>`).join('')}</ul></details>
      </div>`).join('') : '<div class="card empty">No conference matches these filters.</div>';
    $$('[data-follow]', el).forEach(b => (b.onclick = () => follow(r.conferences.find(c => c.id === b.dataset.follow))));
  };
  $$('[data-f]', el).forEach(b => (b.onclick = () => { f[b.dataset.f] = !f[b.dataset.f]; b.classList.toggle('active', f[b.dataset.f]); draw(); }));
  $('#docx', el).onclick = () => download('/api/export/docx', { kind: 'conferences', data: r }).catch(e => toast(e.message, 'error'));
  const add = $('#add-conf', el);
  if (add) add.onclick = addCommunityConference;
  draw();
}

function communityList(list = [], withAdd = false) {
  return `<div class="card" style="margin-top:18px"><div class="card-head"><h3>Regional conferences added by users</h3>${withAdd ? '<button class="btn btn-sm" id="add-conf">+ Add a conference</button>' : ''}</div>
    ${list.length ? `<table class="t">${list.map(c => `<tr><td><b>${esc(c.name)}</b>${c.acronym ? ` (${esc(c.acronym)})` : ''}<div class="muted">${esc([c.country, c.topics].filter(Boolean).join(' · '))}</div></td><td>${esc(c.indexed_in || '')}</td><td>${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">website</a>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted" style="margin:0">None matching yet. Add regional conferences that international databases do not cover, so colleagues in your field can find them. Entries are marked as user-contributed.</p>'}</div>`;
}

function addCommunityConference() {
  modal(`<h2>Add a regional conference</h2>
    <form id="cc"><div class="field"><label>Name</label><input name="name" type="text" required></div>
    <div class="grid grid-2"><div class="field"><label>Acronym</label><input name="acronym" type="text"></div><div class="field"><label>Country</label><input name="country" type="text" value="Pakistan"></div></div>
    <div class="field"><label>Website</label><input name="url" type="text" placeholder="https://"></div>
    <div class="field"><label>Topics / keywords</label><input name="topics" type="text"></div>
    <div class="field"><label>Proceedings indexed in (if known)</label><input name="indexedIn" type="text" placeholder="e.g. HEC-recognised journal special issue"></div>
    <div class="row"><button class="btn btn-primary" type="submit">Add</button><button class="btn btn-ghost" type="button" data-close>Cancel</button></div></form>`, {
    onMount: (m, close) => {
      $('#cc', m).onsubmit = async e => {
        e.preventDefault();
        try { await api('/api/community-conferences', { body: Object.fromEntries(new FormData(e.target)) }); toast('Added — thank you'); close(); } catch (err) { toast(err.message, 'error'); }
      };
    }
  });
}
