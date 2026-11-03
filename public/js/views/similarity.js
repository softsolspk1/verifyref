// views/similarity.js - the similarity (originality) report, laid out like Turnitin's viewer: the manuscript on the left
// with every match highlighted in its source's colour, the Similarity Index and the primary sources on the right. A
// source opens to show each match next to the source's own wording, with the words that differ marked; sources can be
// excluded, the minimum match length raised, sections (abstract, methods ...) left out and small sources dropped,
// recomputed with the same code as the server (shared/similarity.js) and saved with the report for the export.
import { api, esc, $, $$, toast, download, ICONS } from '../core.js';
import { recompute, tokenize, MIN_MATCH } from '../shared/similarity.js';

// one colour per primary source (cycled), readable on light and dark backgrounds
const COLORS = ['#d7263d', '#1b998b', '#3a50d9', '#f46036', '#8e44ad', '#2e86ab', '#c2185b', '#8d6e63', '#6b8e23', '#283593', '#e0a100', '#00897b', '#7b1fa2', '#5d4037', '#455a64'];
export const srcColor = no => COLORS[(no - 1) % COLORS.length];
const pctText = p => (p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`);
const TYPE = { internet: 'Internet source', publication: 'Publication', submission: 'Submitted work' };
const LEVEL = { ok: ['Low similarity', 'good'], warn: ['Moderate similarity', 'warn'], bad: ['High similarity', 'bad'] };
const PERCENTS = [0, 0.5, 1, 2, 3, 5];

/**
 * The manuscript wording of a match next to the source's, with the words that differ marked (longest common word
 * sequence, compared as the report compares words); source words before the first and after the last shared word are
 * left out, as the source excerpt runs a few words past the match.
 */
export function diffPassage(mine, theirs) {
  const a = tokenize(mine), b = tokenize(theirs);
  if (!a.length || !b.length || a.length * b.length > 250000) return null;
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i].n === b[j].n ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const sa = new Uint8Array(a.length), sb = new Uint8Array(b.length);
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i].n === b[j].n) { sa[i++] = 1; sb[j++] = 1; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  const first = sb.indexOf(1), last = sb.lastIndexOf(1);
  const show = (w, same) => w.map((x, k) => (same[k] ? esc(x.raw) : `<span class="sim-diff">${esc(x.raw)}</span>`)).join(' ');
  return { mine: show(a, sa), theirs: first < 0 ? show(b, sb) : show(b.slice(first, last + 1), sb.slice(first, last + 1)), changed: sa.reduce((n, v) => n + (v ? 0 : 1), 0) };
}

/** Similarity Index ring */
function ring(p, level) {
  const r = 52, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, p));
  return `<svg class="sim-ring" viewBox="0 0 128 128" role="img" aria-label="Similarity Index ${pctText(p)}">
    <circle cx="64" cy="64" r="${r}" class="sim-ring-track"/>
    <circle cx="64" cy="64" r="${r}" class="sim-ring-val sim-${level}" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 64 64)"/>
    <text x="64" y="62" text-anchor="middle" class="sim-ring-n">${pctText(p)}</text><text x="64" y="82" text-anchor="middle" class="sim-ring-l">SIMILARITY</text></svg>`;
}

// titles from the databases carry markup (<i>in vitro</i>)
const plain = t => String(t || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const sourceLink = x => (x.checkId ? `<a href="#/check/${x.checkId}">${esc(plain(x.title) || 'Earlier submission')}</a>`
  : x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(plain(x.title) || 'Source')}</a>` : esc(plain(x.title) || 'Source'));
const metaLine = x => [x.journal, x.year, x.doi ? `doi:${x.doi}` : ''].filter(Boolean).map(esc).join(' · ');

export function renderSimilarity(body, original, { checkId = null } = {}) {
  const text = (original.document || []).map(d => d.t).join('');
  const tokens = tokenize(text);
  const all = [...(original.sources || []), ...(original.alsoMatched || [])].map(x => ({ ...x, excluded: undefined }));
  const st = original.settings || {};
  const saved = { excluded: [...(st.excluded || [])], minWords: st.minWords || MIN_MATCH, excludeSections: [...(st.excludeSections || [])], minPercent: st.minPercent || 0, includeQuotes: !!st.includeQuotes };
  const state = { excluded: new Set(saved.excluded), minWords: saved.minWords, excludeSections: new Set(saved.excludeSections), minPercent: saved.minPercent, includeQuotes: saved.includeQuotes, open: null, focus: null, panel: 'overview', at: -1 };
  const quoted = original.quoted || null; // reports made before quotations could be included have no quoted ranges
  const quotedWords = (quoted || []).reduce((a, [p, q]) => a + q - p, 0);
  let pl = original;

  const sameSet = (set, list) => set.size === list.length && list.every(k => set.has(k));
  const dirty = () => state.minWords !== saved.minWords || state.minPercent !== saved.minPercent || state.includeQuotes !== saved.includeQuotes || !sameSet(state.excluded, saved.excluded) || !sameSet(state.excludeSections, saved.excludeSections);
  const filtered = () => state.excluded.size || state.minWords > MIN_MATCH || state.excludeSections.size || state.minPercent > 0 || state.includeQuotes;
  const compute = () => {
    const v = recompute(all, text, { tokens, total: original.summary.words, excluded: [...state.excluded], minWords: state.minWords, excludeSections: [...state.excludeSections], minPercent: state.minPercent, quoted: quoted || [], includeQuotes: state.includeQuotes });
    pl = { ...original, ...v };
  };

  const header = () => {
    const s = pl.summary;
    const [label, tone] = LEVEL[s.level] || LEVEL.ok;
    const bar = (lbl, v, cls, note = '') => `<div class="sim-break"><div class="sim-break-head"><span>${lbl}</span><b>${note || pctText(v)}</b></div><div class="sim-bar"><span class="${cls}" style="width:${note ? 0 : Math.min(100, v)}%"></span></div></div>`;
    return `<div class="card sim-head">
      <div class="sim-head-ring">${ring(s.similarity, s.level)}<span class="badge b-${tone}">${label}</span></div>
      <div class="sim-head-body">
        <div class="card-head" style="margin-bottom:6px"><h3 style="margin:0">Similarity Report</h3>
          <div class="row no-print" style="gap:6px">${checkId ? `<button class="btn btn-sm" data-dl="docx">${ICONS.download} Word</button><button class="btn btn-sm" data-dl="pdf">${ICONS.download} PDF</button><button class="btn btn-sm" data-dl="csv" title="Primary sources as a spreadsheet">${ICONS.download} CSV</button>` : ''}</div></div>
        <div class="sim-facts"><span><b>${(s.compared ?? s.words).toLocaleString()}</b> words compared${s.compared !== undefined && s.compared < s.words ? ` <span class="muted">of ${s.words.toLocaleString()} (sections excluded)</span>` : ''}</span><span><b>${s.sources}</b> primary source${s.sources === 1 ? '' : 's'}</span><span>largest source <b>${pctText(s.largestSource)}</b></span></div>
        ${bar('Publications', s.publications, 'pub')}
        ${bar('Internet sources', s.internet, 'web')}
        ${pl.aiWriting ? `<div class="sim-ai" title="${esc((pl.aiWriting.parts || []).join(' · ') || 'No AI writing pattern found')}"><b>AI-writing indicator:</b> ${pl.aiWriting.leftovers ? `<span class="badge b-bad">chatbot text left in the manuscript (${pl.aiWriting.leftovers})</span> ` : ''}<span class="badge b-${pl.aiWriting.score >= 55 ? 'bad' : pl.aiWriting.score >= 25 ? 'warn' : 'good'}">${pl.aiWriting.score}/100</span> <span class="muted">an indicator, not proof (vocabulary, sentence rhythm, stock transitions); details in Module 4</span></div>` : ''}
        ${pl.submissions?.compared ? bar('Submitted works (earlier PJPS submissions)', s.submissions, 'sub') : bar('Submitted works', 0, '', 'not compared')}
        <div class="sim-private" title="${esc(pl.privacy?.statement || pl.repository || '')}">🔒 <b>Not stored · no repository.</b> ${esc(pl.submissions?.compared ? `This manuscript was not saved to any database. At your request it was compared with ${pl.submissions.candidates} earlier PJPS submission(s) sharing text.` : pl.privacy ? 'This manuscript was not saved to any database. Earlier PJPS submissions were not compared (opt-in on the Full Screening form).' : 'This manuscript was not added to any repository.')}</div>
      </div></div>`;
  };

  const toolbar = () => {
    const n = $$('.sim-m', body).length;
    return `<div class="sim-toolbar no-print">
      <label>Exclude matches under <select id="sim-min">${[8, 10, 12, 15, 20, 30, 50].map(v => `<option value="${v}" ${v === state.minWords ? 'selected' : ''}>${v}</option>`).join('')}</select> words</label>
      <label title="Leave out sources whose share of the manuscript stays under this percentage">Sources under <select id="sim-pct">${PERCENTS.map(v => `<option value="${v}" ${v === state.minPercent ? 'selected' : ''}>${v ? `${v}%` : 'off'}</option>`).join('')}</select></label>
      <span class="sim-sep"></span>
      <button class="btn btn-sm btn-ghost" id="sim-prev" title="Previous match">◀</button><span class="muted" id="sim-pos">${n ? `${state.at >= 0 ? state.at + 1 : '–'} / ${n}` : 'no matches'}</span><button class="btn btn-sm btn-ghost" id="sim-next" title="Next match">▶</button>
      ${state.focus ? `<span class="chip">Showing source ${state.focus} only <a href="#" id="sim-all">show all</a></span>` : ''}
      <span style="flex:1"></span>
      ${dirty() ? `<span class="muted">Filters changed</span>${checkId ? '<button class="btn btn-sm btn-primary" id="sim-save">Save with report</button>' : ''}<button class="btn btn-sm" id="sim-reset">Undo</button>` : filtered() ? '<span class="muted">Saved filters applied</span>' : ''}
    </div>`;
  };

  const doc = () => (pl.document || []).map(seg => (seg.s
    ? `<mark class="sim-m${state.focus && +state.focus !== seg.s ? ' dim' : ''}" data-src="${seg.s}" style="--c:${srcColor(seg.s)}"><sup>${seg.s}</sup>${esc(seg.t)}</mark>`
    : seg.x ? `<span class="sim-x" title="Section excluded from the comparison">${esc(seg.t)}</span>` : esc(seg.t))).join('');

  const passage = (p, no) => {
    const d = p.source ? diffPassage(p.text, p.source) : null;
    return `<div class="sim-pass">
      <div class="sim-pass-head"><span class="muted">${p.words} words${d ? d.changed ? ` · ${d.changed} word${d.changed === 1 ? '' : 's'} changed` : ' · identical' : ''}</span><button class="btn btn-sm btn-ghost" data-goto="${p.from}">Show in text ↗</button></div>
      <div class="sim-pass-grid"><div><div class="sim-pass-l">Manuscript</div><div class="sim-pass-t" style="--c:${srcColor(no || 1)}">${d ? d.mine : esc(p.text)}</div></div>
      <div><div class="sim-pass-l">Source</div><div class="sim-pass-t src">${d ? d.theirs : p.source ? esc(p.source) : '<span class="muted">The exact passage was found in this source (paywalled full text: the wording is not shown).</span>'}</div></div></div></div>`;
  };

  const sourceItem = x => {
    const open = state.open === x.key;
    const no = x.no;
    const listed = (x.passages || []).filter(p => p.words >= state.minWords);
    return `<li class="sim-src${open ? ' open' : ''}${no ? '' : ' off'}" data-key="${esc(x.key)}">
      <div class="sim-src-row" data-toggle="${esc(x.key)}">
        <span class="sim-no" style="${no ? `background:${srcColor(no)}` : ''}">${no || '–'}</span>
        <span class="sim-src-main"><span class="sim-src-title">${sourceLink(x)}</span>
          <span class="sim-src-meta">${esc(TYPE[x.type] || x.type)}${metaLine(x) ? ` · ${metaLine(x)}` : ''}</span>
          ${no ? `<span class="sim-bar sm"><span style="width:${Math.min(100, x.percent * 4)}%;background:${srcColor(no)}"></span></span>` : `<span class="sim-src-meta">${x.excluded ? 'Excluded by the editor' : x.small ? `Under ${state.minPercent}% of the manuscript (source filter)` : `${x.matchedWords || 0} matched words, all credited to larger sources`}</span>`}</span>
        <span class="sim-pct">${no ? pctText(x.percent) : ''}</span>
      </div>
      ${open ? `<div class="sim-src-body">
        <div class="muted" style="font-size:12px;margin-bottom:6px">Found via ${esc(x.via || '—')} · compared: ${esc(x.compared || '—')}${x.matchedWords ? ` · ${x.matchedWords} matched words` : ''}</div>
        ${listed.map(p => passage(p, no)).join('') || '<p class="muted">No match of this length.</p>'}
        <div class="row" style="gap:6px;margin-top:8px">${no ? `<button class="btn btn-sm" data-focus="${no}">Highlight only this source</button>` : ''}
          <button class="btn btn-sm ${x.excluded ? '' : 'btn-ghost btn-danger'}" data-exclude="${esc(x.key)}">${x.excluded ? 'Include again' : 'Exclude source'}</button></div>
      </div>` : ''}
    </li>`;
  };

  const panel = () => {
    const credited = pl.sources || [];
    const others = pl.alsoMatched || [];
    const secs = pl.sections || [];
    const tabs = [['overview', `Matches (${credited.length})`], ['all', `All sources (${credited.length + others.length})`], ...(secs.length > 1 ? [['sections', 'Sections']] : []), ['filters', 'Filters']];
    const list = state.panel === 'all' ? [...credited, ...others] : credited;
    return `<div class="sim-tabs">${tabs.map(([k, l]) => `<button class="${state.panel === k ? 'active' : ''}" data-panel="${k}">${l}</button>`).join('')}</div>
      ${state.panel === 'sections' ? `<div class="sim-filters">
          <p class="muted">Similarity of each section. Overlap in Materials and methods is often standard wording; untick a section to leave it out of the comparison (its words then count neither as matched nor in the total).</p>
          <table class="sim-secs"><thead><tr><th>Include</th><th>Section</th><th>Words</th><th>Similarity</th></tr></thead><tbody>
          ${secs.map(x => `<tr class="${x.excluded ? 'off' : ''}"><td><input type="checkbox" data-section="${esc(x.key)}" ${x.excluded ? '' : 'checked'} aria-label="Include ${esc(x.label)}"></td><td>${esc(x.label)}</td><td>${x.words.toLocaleString()}</td>
            <td>${x.excluded ? '<span class="muted">excluded</span>' : `<span class="sim-bar sm sim-secbar"><span style="width:${Math.min(100, x.similarity)}%"></span></span> ${pctText(x.similarity)}`}</td></tr>`).join('')}
          </tbody></table>
          <p class="muted" style="margin-top:8px">Sections are found from the manuscript's headings (Abstract, Introduction, Materials and methods, Results, Discussion, Conclusion, Declarations).</p>
        </div>`
      : state.panel === 'filters' ? `<div class="sim-filters">
          <p><b>Bibliography</b> — ${esc(pl.filters.bibliography)}</p>
          <p><b>Quotations</b> — ${quoted ? `<label class="row" style="display:inline-flex;gap:6px;margin:0"><input type="checkbox" id="sim-quotes" ${state.includeQuotes ? '' : 'checked'}> exclude quoted text (${quotedWords} words in quotation marks)</label>` : esc(pl.filters.quotes)}</p>
          ${pl.filters.citations ? `<p><b>In-text citations</b> — ${esc(pl.filters.citations)}</p>` : ''}
          <p><b>Small matches</b> — excluded (fewer than ${state.minWords} words)</p>
          <p><b>Small sources</b> — ${state.minPercent ? `sources under ${state.minPercent}% left out (${others.filter(x => x.small).length})` : 'all counted'}</p>
          <p><b>Excluded sources</b> — ${state.excluded.size ? [...state.excluded].map(k => esc(plain(all.find(x => x.key === k)?.title) || k)).join('; ') : 'none'}</p>
          <p><b>Excluded sections</b> — ${state.excludeSections.size ? secs.filter(x => x.excluded).map(x => esc(x.label)).join('; ') : 'none'}</p>
          ${pl.selfMatches?.length ? `<p><b>Not counted</b> — the manuscript's own published version or preprint: ${pl.selfMatches.map(x => esc(x.title)).join('; ')}</p>` : ''}
        </div>`
      : list.length ? `<ol class="sim-srcs">${list.map(sourceItem).join('')}</ol>` : '<p class="muted" style="padding:12px">No matching text was found in the sources searched.</p>'}`;
  };

  const searched = () => {
    const c = pl.checked || {};
    return `<details class="card sim-method"><summary><b>What was searched and how</b> <span class="muted">— ${c.passages} passages, ${c.queries} literature searches${c.webSearches ? `, ${c.webSearches} web searches` : ''}</span></summary>
      <p class="muted">${c.passages} passages searched${c.passagesFound !== undefined ? ` (${c.passagesFound} found elsewhere${c.commonPhrases ? `, ${c.commonPhrases} of them stock wording found in many papers` : ''})` : ''}: ${c.queries} literature searches${c.openalexSearches ? `, ${c.openalexSearches} in publisher full texts (OpenAlex)` : ''}${c.webSearches ? `, ${c.webSearches} on the web` : ''}; ${c.neighbours ? `${c.neighbours} papers on the same subject read in full; ` : ''}${c.candidates} candidate sources, ${c.sourcesCompared} compared in full.${c.searchErrors ? ` ${c.searchErrors} search(es) failed.` : ''}</p>
      <p class="muted"><b>Databases:</b> ${(c.databases || []).map(esc).join('; ')}.</p>
      <p class="muted"><b>Method:</b> ${esc(pl.method)}</p><p class="muted"><b>Coverage:</b> ${esc(pl.coverage)}</p>
      ${pl.privacy ? `<p class="muted"><b>Privacy:</b> ${esc(pl.privacy.statement)}</p>` : ''}</details>`;
  };

  const paint = () => {
    compute();
    const scroll = $('#sim-doc', body)?.scrollTop || 0;
    body.innerHTML = `${header()}
      ${pl.earlierSubmissions?.length ? `<div class="alert alert-bad"><b>Earlier PJPS submission with the same text (Module 4):</b> ${pl.earlierSubmissions.map(esc).join('; ')}</div>` : ''}
      <div class="sim-layout">
        <div class="card sim-docwrap"><div id="sim-tools"></div><div class="sim-doc" id="sim-doc">${doc()}</div></div>
        <div class="card sim-side">${panel()}</div>
      </div>
      ${searched()}`;
    $('#sim-tools', body).innerHTML = toolbar();
    $('#sim-doc', body).scrollTop = scroll;
    wire();
  };

  const marks = () => $$('.sim-m', body).filter(m => !m.classList.contains('dim'));
  const goMark = i => {
    const list = marks();
    if (!list.length) return;
    state.at = (i + list.length) % list.length;
    $$('.sim-m.cur', body).forEach(m => m.classList.remove('cur'));
    const m = list[state.at];
    m.classList.add('cur');
    m.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const pos = $('#sim-pos', body);
    if (pos) pos.textContent = `${state.at + 1} / ${list.length}`;
  };
  // the highlighted run that contains word position `from`
  const goWord = from => {
    let k = 0;
    const segs = pl.document || [];
    let words = 0;
    for (; k < segs.length; k++) { const n = tokenize(segs[k].t).length; if (words + n > from) break; words += n; }
    const seg = segs[k];
    if (!seg?.s) return;
    const idx = segs.slice(0, k + 1).filter(x => x.s).length - 1;
    const m = $$('.sim-m', body)[idx];
    if (!m) return;
    $$('.sim-m.cur', body).forEach(x => x.classList.remove('cur'));
    m.classList.add('cur');
    m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  function wire() {
    $$('[data-dl]', body).forEach(b => (b.onclick = () => download(`/api/checks/${checkId}/similarity?format=${b.dataset.dl}`).catch(e => toast(e.message, 'error'))));
    $('#sim-min', body).onchange = e => { state.minWords = +e.target.value; state.at = -1; paint(); };
    $('#sim-pct', body).onchange = e => { state.minPercent = +e.target.value; state.at = -1; paint(); };
    const q = $('#sim-quotes', body);
    if (q) q.onchange = () => { state.includeQuotes = !q.checked; state.at = -1; paint(); };
    $$('[data-section]', body).forEach(b => (b.onchange = () => {
      if (b.checked) state.excludeSections.delete(b.dataset.section); else state.excludeSections.add(b.dataset.section);
      state.at = -1; state.focus = null;
      paint();
    }));
    $('#sim-prev', body).onclick = () => goMark(state.at - 1);
    $('#sim-next', body).onclick = () => goMark(state.at + 1);
    const allBtn = $('#sim-all', body);
    if (allBtn) allBtn.onclick = e => { e.preventDefault(); state.focus = null; paint(); };
    $$('[data-panel]', body).forEach(b => (b.onclick = () => { state.panel = b.dataset.panel; paint(); }));
    $$('[data-toggle]', body).forEach(r => (r.onclick = e => {
      if (e.target.closest('a')) return;
      state.open = state.open === r.dataset.toggle ? null : r.dataset.toggle;
      paint();
    }));
    $$('[data-focus]', body).forEach(b => (b.onclick = () => { state.focus = state.focus === b.dataset.focus ? null : b.dataset.focus; state.at = -1; paint(); goMark(0); }));
    $$('[data-goto]', body).forEach(b => (b.onclick = () => goWord(+b.dataset.goto)));
    $$('[data-exclude]', body).forEach(b => (b.onclick = () => {
      const k = b.dataset.exclude;
      if (state.excluded.has(k)) state.excluded.delete(k); else state.excluded.add(k);
      state.focus = null;
      paint();
    }));
    // clicking a highlight opens its source in the panel
    $$('.sim-m', body).forEach(m => (m.onclick = () => {
      const x = (pl.sources || []).find(s => String(s.no) === m.dataset.src);
      if (!x) return;
      state.open = x.key; state.panel = 'overview';
      paint();
      $(`.sim-src[data-key="${CSS.escape(x.key)}"]`, body)?.scrollIntoView({ block: 'nearest' });
    }));
    const save = $('#sim-save', body);
    if (save) save.onclick = async () => {
      save.disabled = true;
      try {
        const d = await api(`/api/checks/${checkId}/similarity`, { method: 'PATCH', body: { excluded: [...state.excluded], minWords: state.minWords, excludeSections: [...state.excludeSections], minPercent: state.minPercent, includeQuotes: state.includeQuotes } });
        const ns = d.plagiarism.settings;
        saved.excluded = [...ns.excluded];
        saved.minWords = ns.minWords;
        saved.excludeSections = [...(ns.excludeSections || [])];
        saved.minPercent = ns.minPercent || 0;
        saved.includeQuotes = !!ns.includeQuotes;
        toast('Filters saved — the Word / PDF report uses them');
        paint();
      } catch (e) { toast(e.message, 'error'); save.disabled = false; }
    };
    const reset = $('#sim-reset', body);
    if (reset) reset.onclick = () => { state.excluded = new Set(saved.excluded); state.minWords = saved.minWords; state.excludeSections = new Set(saved.excludeSections); state.minPercent = saved.minPercent; state.includeQuotes = saved.includeQuotes; paint(); };
  }

  paint();
}
