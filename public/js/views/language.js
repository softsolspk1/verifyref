// views/language.js - Module 6 Language Editing: the writer's documents and the editor. The text is checked as it is
// typed (only paragraphs that changed are sent), suggestions are underlined in the text and listed as cards by area
// (correctness, clarity, engagement, delivery, academic style), with the overall score, tone, statistics, research tools
// (manuscript structure, claims without citations, reviewer feedback, AI-writing indicator) and AI rewriting.
import { api, esc, $, $$, toast, modal, download, copyText, state } from '../core.js';

const AREAS = [
  ['correctness', 'Correctness', 'Spelling, grammar and punctuation'],
  ['clarity', 'Clarity', 'Concise, easy-to-follow writing'],
  ['engagement', 'Engagement', 'Vivid, varied word choice'],
  ['delivery', 'Delivery', 'Tone, confidence and inclusive language'],
  ['style', 'Academic style', 'Research writing and journal conventions']
];
const AREA_LABEL = Object.fromEntries(AREAS.map(a => [a[0], a[1]]));

const PRESETS = {
  research: { label: 'Research article (journal submission)', goals: { domain: 'academic', formality: 'formal', audience: 'expert', intent: 'inform', passive: 'allow', abstractWords: 250 } },
  thesis: { label: 'Thesis / dissertation', goals: { domain: 'academic', formality: 'formal', audience: 'knowledgeable', intent: 'describe', passive: 'allow', abstractWords: 350 } },
  review: { label: 'Review article', goals: { domain: 'academic', formality: 'formal', audience: 'knowledgeable', intent: 'inform', passive: 'allow', abstractWords: 250 } },
  letter: { label: 'Letter / e-mail to editor or reviewers', goals: { domain: 'business', formality: 'formal', audience: 'expert', intent: 'convince', passive: 'flag', abstractWords: 250 } },
  general: { label: 'General audience (lay summary, press release)', goals: { domain: 'general', formality: 'neutral', audience: 'general', intent: 'inform', passive: 'flag', abstractWords: 250 } }
};
const DEFAULT_SETTINGS = () => ({ variant: 'en-US', preset: 'research', goals: { ...PRESETS.research.goals }, dismissed: [], disabled: [] });

const REWRITES = [
  ['improve', 'Improve'], ['academic', 'Make academic'], ['shorten', 'Shorten'], ['paraphrase', 'Paraphrase'], ['simplify', 'Simplify'],
  ['clarity', 'Clarify'], ['formal', 'More formal'], ['confident', 'More confident'], ['expand', 'Expand'], ['fix', 'Fix grammar only'], ['friendly', 'Friendlier']
];
const PROMPTS = [
  'Write a structured abstract (Background, Objective, Methods, Results, Conclusion) of this manuscript in under 250 words',
  'Suggest five informative titles for this manuscript',
  'Suggest 5-6 keywords for this manuscript',
  'Summarise the key findings in three sentences',
  'Write a cover letter to the editor submitting this manuscript',
  'Write the limitations paragraph for the Discussion',
  'Improve the flow and transitions of the selected text',
  'Draft a polite response to this reviewer comment: '
];

let cfgCache = null;
const loadConfig = async () => (cfgCache = await api('/api/language/config'));

// ------------------------------------------------------------------ document library

export async function renderLanguage(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Language Editing</h1>
      <p>A writing assistant for research manuscripts: spelling, grammar and punctuation; clarity and conciseness; word choice and tone;
      academic and journal conventions (Methods tense, abbreviations, figure order, P values, units, claims that need a citation);
      AI rewriting, reviewer-style feedback and an overall writing score. Everything runs inside the portal — no browser extension.</p></div>
      <div class="row" style="gap:8px"><button class="btn" id="le-upload">Upload a file</button><button class="btn btn-primary" id="le-new">New document</button></div></div>
    <input type="file" id="le-file" accept=".docx,.doc,.pdf,.odt,.rtf,.txt" hidden>
    <div class="card le-paste">
      <div class="field"><label for="le-paste">Paste text to check</label><textarea id="le-paste" rows="5" placeholder="Paste a paragraph, an abstract or a whole manuscript…"></textarea></div>
      <button class="btn btn-primary" id="le-paste-go">Check this text</button>
    </div>
    <div id="le-docs"><div class="muted">Loading your documents…</div></div>`;
  const create = async (title, body) => {
    const d = await api('/api/language/docs', { body: { title, body, settings: DEFAULT_SETTINGS() } });
    location.hash = `#/language/${d.doc.id}`;
  };
  $('#le-new', view).onclick = () => create('Untitled document', '').catch(e => toast(e.message, 'error'));
  $('#le-paste-go', view).onclick = () => {
    const t = $('#le-paste', view).value.trim();
    if (!t) return toast('Paste some text first.', 'error');
    create(t.split('\n')[0].slice(0, 60) || 'Pasted text', t).catch(e => toast(e.message, 'error'));
  };
  const input = $('#le-file', view);
  $('#le-upload', view).onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files[0];
    input.value = '';
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    fd.append('settings', JSON.stringify(DEFAULT_SETTINGS()));
    try {
      toast(`Opening ${f.name}…`);
      const d = await api('/api/language/import', { form: fd });
      location.hash = `#/language/${d.doc.id}`;
    } catch (e) { toast(e.message, 'error'); }
  };
  // a manuscript already uploaded in another module this session
  if (state.sharedFile) {
    const bar = document.createElement('div');
    bar.className = 'alert alert-info';
    bar.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';
    bar.innerHTML = `<span>Manuscript uploaded in this session: <b>${esc(state.sharedFile.name)}</b></span><button class="btn btn-sm btn-primary" type="button">Open it here</button>`;
    bar.querySelector('button').onclick = () => { const dt = new DataTransfer(); dt.items.add(state.sharedFile); input.files = dt.files; input.onchange(); };
    $('.le-paste', view).before(bar);
  }

  const d = await api('/api/language/docs');
  const box = $('#le-docs', view);
  if (!d.docs.length) { box.innerHTML = '<div class="card empty">No documents yet. Upload a manuscript, paste text or start a new document.</div>'; return; }
  box.innerHTML = `<h2>Your documents</h2><div class="le-doclist">${d.docs.map(x => `
    <a class="le-doc card" href="#/language/${x.id}">
      <div class="le-doc-score ${scoreTone(x.score)}">${x.score ?? '–'}</div>
      <div class="le-doc-body"><b>${esc(x.title)}</b><div class="muted le-doc-prev">${esc((x.preview || '').slice(0, 140)) || '<i>Empty</i>'}</div>
      <div class="muted" style="font-size:12px">${x.words.toLocaleString()} words · edited ${new Date(x.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div></div>
      <button class="btn btn-sm btn-ghost le-del" data-id="${x.id}" title="Delete">Delete</button>
    </a>`).join('')}</div>`;
  box.onclick = async e => {
    const b = e.target.closest('.le-del');
    if (!b) return;
    e.preventDefault();
    if (!confirm('Delete this document? This cannot be undone.')) return;
    await api(`/api/language/docs/${b.dataset.id}`, { method: 'DELETE' });
    b.closest('.le-doc').remove();
  };
}

const scoreTone = s => (s == null ? '' : s >= 85 ? 'good' : s >= 65 ? 'warn' : 'bad');

// ------------------------------------------------------------------ editor

export async function renderLanguageEditor(view, id) {
  const [{ doc }] = await Promise.all([api(`/api/language/docs/${id}`), loadConfig()]);
  const S = { ...DEFAULT_SETTINGS(), ...(doc.settings || {}) };
  S.goals = { ...PRESETS.research.goals, ...(S.goals || {}) };
  const dismissed = new Set(S.dismissed || []);
  let personal = new Set((cfgCache.dictionary || []).map(w => w.toLowerCase()));

  view.innerHTML = `
    <div class="le-top no-print">
      <a href="#/language" class="btn btn-sm btn-ghost">← Documents</a>
      <input id="le-title" class="le-title" value="${esc(doc.title)}" aria-label="Document title">
      <span class="muted le-save" id="le-save"></span>
      <span class="spacer"></span>
      <select id="le-variant" class="btn btn-sm" title="English variety"><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option></select>
      <button class="btn btn-sm" id="le-goals" title="Writing goals">Goals: <span id="le-goal-label"></span></button>
      <button class="btn btn-sm" id="le-ask">✦ Ask AI</button>
      <div class="le-menu"><button class="btn btn-sm" id="le-dl">Download ▾</button>
        <div class="le-menu-list" hidden>
          <button data-f="docx">Word document (.docx)</button><button data-f="tracked">Word with tracked changes</button>
          <button data-f="report">Language report (.docx)</button><button data-f="txt">Plain text (.txt)</button><button data-f="copy">Copy all text</button>
          <button data-f="original">Keep this version as the original</button>
        </div></div>
    </div>
    <div class="le-selbar no-print" id="le-selbar" hidden><span class="muted">Selected text:</span>
      ${REWRITES.slice(0, 6).map(([k, l]) => `<button class="btn btn-sm" data-rw="${k}">${l}</button>`).join('')}
      <select class="btn btn-sm" id="le-rw-more"><option value="">More…</option>${REWRITES.slice(6).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}<option value="custom">Custom instruction…</option></select>
    </div>
    <div class="le-layout">
      <div class="le-main">
        <div class="le-paper card">
          <div class="le-wrap" id="le-wrap">
            <div class="le-hl" id="le-hl" aria-hidden="true"></div>
            <textarea id="le-ta" class="le-ta" spellcheck="false" placeholder="Type or paste your text here…"></textarea>
            <div class="le-pop" id="le-pop" hidden></div>
          </div>
        </div>
        <div class="le-foot muted no-print" id="le-foot"></div>
      </div>
      <aside class="le-side no-print">
        <div class="le-scorebox card">
          <button class="le-score" id="le-score" title="Performance and statistics"><span id="le-score-n">–</span><small>Overall score</small></button>
          <div class="le-score-side"><div id="le-count" class="le-count">Checking…</div><div class="muted" id="le-words"></div>
          <button class="btn btn-sm" id="le-ai-run" title="Sentence-level rewrites from the AI editor">✦ AI sentence suggestions</button></div>
        </div>
        <div class="tabs le-tabs" id="le-tabs">
          <button class="tab active" data-t="suggestions">Suggestions</button><button class="tab" data-t="research">Research tools</button><button class="tab" data-t="insights">Insights</button>
        </div>
        <div id="le-pane-suggestions">
          <div class="le-areas" id="le-areas"></div>
          <div id="le-bulk"></div>
          <div id="le-cards" class="le-cards"></div>
        </div>
        <div id="le-pane-research" hidden></div>
        <div id="le-pane-insights" hidden></div>
      </aside>
    </div>`;

  const ta = $('#le-ta', view), hl = $('#le-hl', view), pop = $('#le-pop', view);
  ta.value = doc.body || '';
  $('#le-variant', view).value = S.variant;
  let original = doc.original || '';
  let paraCache = new Map(), aiCache = new Map();
  let docResult = null, issues = [], activeId = null, area = 'all', engines = null;
  let lastText = ta.value, seq = 0, timer = null, saveTimer = null, checking = false, again = false;

  const goalLabel = () => { $('#le-goal-label', view).textContent = PRESETS[S.preset]?.label.split(' (')[0] || 'Custom'; };
  goalLabel();

  // ---------------------------------------------------------------- layout helpers
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; hl.style.height = ta.style.height; };
  const paragraphs = text => {
    const out = [];
    let pos = 0;
    for (const p of text.split('\n')) { out.push({ text: p, start: pos }); pos += p.length + 1; }
    return out;
  };
  const refStart = text => { const m = text.match(/(^|\n)\s*(?:\d+\.?\s*)?(?:references?|bibliography|literature cited|works cited)\s*:?\s*(?=\n|$)/i); return m ? m.index + m[1].length : Infinity; };
  const keyOf = (i, text) => `${i.rule}|${text.slice(Math.max(0, i.offset - 20), i.offset + i.length + 20)}`;

  /** Rebuild the positioned suggestion list from the paragraph caches and the last whole-document check */
  function compute() {
    const text = ta.value;
    const refs = refStart(text);
    const out = [];
    for (const p of paragraphs(text)) {
      if (!p.text.trim()) continue;
      for (const src of [paraCache.get(p.text), aiCache.get(p.text)]) {
        for (const i of src || []) {
          const off = p.start + i.offset;
          if (off >= refs) continue;
          out.push({ ...i, offset: off });
        }
      }
    }
    for (const i of docResult?.issues || []) {
      // still at the same place? otherwise find the text again nearby, or drop it until the next check
      if (text.substr(i.offset, i.length) === i.text) { out.push({ ...i, doc: true }); continue; }
      const at = text.indexOf(i.text, Math.max(0, i.offset - 200));
      if (at >= 0 && Math.abs(at - i.offset) < 400) out.push({ ...i, offset: at, doc: true });
    }
    issues = out.filter(i => !dismissed.has(keyOf(i, text)) && !(i.spelling && personal.has(i.text.toLowerCase())) && !(S.disabled || []).includes(i.rule))
      .sort((a, b) => a.offset - b.offset);
    issues.forEach((i, k) => { i.id = k + 1; });
    render();
  }

  // ---------------------------------------------------------------- highlighting
  function paint() {
    const text = ta.value;
    const marks = [];
    let end = -1;
    const active = issues.find(i => i.id === activeId);
    for (const i of issues) {
      if (i.whole && i !== active) continue;
      if (i.offset < end) continue;
      marks.push(i);
      end = i.offset + Math.max(i.length, 1);
    }
    let html = '', pos = 0;
    for (const m of marks) {
      html += esc(text.slice(pos, m.offset));
      const seg = text.slice(m.offset, m.offset + m.length) || ' ';
      html += `<mark class="le-m le-${m.category}${m.id === activeId ? ' on' : ''}${m.whole ? ' whole' : ''}${m.ai ? ' ai' : ''}" data-id="${m.id}">${esc(seg)}</mark>`;
      pos = m.offset + m.length;
    }
    html += `${esc(text.slice(pos))}\u200b\n`;
    hl.innerHTML = html;
  }

  // ---------------------------------------------------------------- suggestion cards
  const preview = i => {
    const rep = (i.replacements || [])[0];
    if (rep === undefined) return `<span class="le-q">${esc(clip(i.text, 70))}</span>`;
    return rep === '' ? `<span class="le-del-t">${esc(clip(i.text, 50))}</span>` : `<span class="le-del-t">${esc(clip(i.text, 40))}</span> → <b class="le-ins-t">${esc(clip(rep, 50))}</b>`;
  };
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  function cardBody(i) {
    const reps = (i.replacements || []).slice(0, 4);
    return `<div class="le-msg">${esc(i.message)}${i.ai ? ' <span class="badge b-info">AI</span>' : ''}${i.engine === 'languagetool' ? ' <span class="badge b-neutral">Grammar server</span>' : ''}</div>
      ${reps.length ? `<div class="le-reps">${reps.map((r, k) => `<button class="btn btn-sm ${k ? '' : 'btn-primary'}" data-act="accept" data-k="${k}">${r === '' ? `Remove “${esc(clip(i.text.trim(), 30))}”` : esc(clip(r, 80))}</button>`).join('')}</div>` : ''}
      <div class="le-acts">
        ${i.whole || i.ai === 'shorten' || (!reps.length && i.category !== 'correctness') ? '<button class="btn btn-sm" data-act="ai">✦ Rewrite with AI</button>' : ''}
        ${i.findSources ? '<button class="btn btn-sm" data-act="sources">Find sources</button>' : ''}
        ${i.spelling ? '<button class="btn btn-sm btn-ghost" data-act="dict">Add to dictionary</button>' : ''}
        <button class="btn btn-sm btn-ghost" data-act="dismiss">Dismiss</button>
        <button class="btn btn-sm btn-ghost" data-act="off" title="Stop showing this kind of suggestion">Turn off</button>
      </div>`;
  }

  function renderCards() {
    const counts = Object.fromEntries(AREAS.map(a => [a[0], 0]));
    for (const i of issues) counts[i.category] = (counts[i.category] || 0) + 1;
    $('#le-areas', view).innerHTML = `<button class="le-area ${area === 'all' ? 'on' : ''}" data-a="all"><b>${issues.length}</b><span>All</span></button>` +
      AREAS.map(([k, l, d]) => `<button class="le-area le-a-${k} ${area === k ? 'on' : ''}" data-a="${k}" title="${esc(d)}"><b>${counts[k]}</b><span>${l}</span><i class="le-bar"><i style="width:${Math.min(100, counts[k] * 8)}%"></i></i></button>`).join('');
    const list = issues.filter(i => area === 'all' || i.category === area);
    const simple = list.filter(i => i.category !== 'engagement' && i.replacements?.length === 1 && !i.ai && !i.whole);
    $('#le-bulk', view).innerHTML = simple.length >= 2 ? `<button class="btn btn-sm" id="le-accept-all">Accept all ${simple.length} quick fixes${area === 'all' ? '' : ` in ${AREA_LABEL[area]}`}</button>` : '';
    const box = $('#le-cards', view);
    box.innerHTML = list.length ? list.slice(0, 400).map(i => `
      <div class="le-card le-c-${i.category} ${i.id === activeId ? 'open' : ''}" data-id="${i.id}">
        <div class="le-card-h"><span class="le-dot"></span><span class="le-card-t">${esc(i.title)}</span><span class="le-card-p">${preview(i)}</span></div>
        ${i.id === activeId ? `<div class="le-card-b">${cardBody(i)}</div>` : ''}
      </div>`).join('') + (list.length > 400 ? `<div class="muted">${list.length - 400} more…</div>` : '')
      : `<div class="le-clean">${ta.value.trim() ? (checking ? 'Checking…' : '✓ No suggestions here. Nice work!') : 'Start writing or paste your text.'}</div>`;
  }

  function render() {
    paint();
    renderCards();
    const n = issues.length;
    $('#le-count', view).textContent = checking && !docResult ? 'Checking…' : `${n} suggestion${n === 1 ? '' : 's'}`;
    const sc = docResult?.score?.overall;
    const el = $('#le-score', view);
    $('#le-score-n', view).textContent = sc ?? '–';
    el.className = `le-score ${scoreTone(sc)}`;
    const st = docResult?.stats;
    $('#le-words', view).textContent = st ? `${st.words.toLocaleString()} words · ${Math.max(1, Math.round(st.readingTime / 60))} min read` : '';
    showPop();
    if (!$('#le-pane-insights', view).hidden) renderInsights();
  }

  // ---------------------------------------------------------------- popover on the text
  function showPop() {
    const i = issues.find(x => x.id === activeId);
    const m = i && hl.querySelector(`mark[data-id="${i.id}"]`);
    if (!i || !m) { pop.hidden = true; return; }
    pop.hidden = false;
    pop.className = `le-pop le-c-${i.category}`;
    pop.innerHTML = `<div class="le-pop-h"><span class="le-dot"></span><b>${esc(i.title)}</b><span class="muted">${AREA_LABEL[i.category] || ''}</span><button class="le-x" data-act="close" title="Close">×</button></div>${cardBody(i)}`;
    pop.dataset.id = i.id;
    const wrap = $('#le-wrap', view).getBoundingClientRect(), r = m.getClientRects()[m.getClientRects().length - 1] || m.getBoundingClientRect();
    pop.style.top = `${r.bottom - wrap.top + 6}px`;
    pop.style.left = `${Math.max(0, Math.min(r.left - wrap.left, wrap.width - 340))}px`;
  }

  function activate(id, { scroll = true } = {}) {
    activeId = id;
    render();
    const card = $(`.le-card[data-id="${id}"]`, view);
    if (card && scroll) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const m = hl.querySelector(`mark[data-id="${id}"]`);
    if (m && scroll) {
      const r = m.getBoundingClientRect();
      if (r.top < 80 || r.bottom > innerHeight - 40) window.scrollBy({ top: r.top - innerHeight / 3, behavior: 'smooth' });
    }
  }

  // ---------------------------------------------------------------- editing the text
  function replaceRange(start, end, text) {
    ta.focus();
    ta.setSelectionRange(start, end);
    // execCommand keeps the browser's undo (Ctrl+Z) working
    const ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text);
    if (!ok) ta.setRangeText(text, start, end, 'end');
    onInput();
  }

  function accept(i, k = 0) {
    const text = ta.value;
    let at = i.offset;
    if (text.substr(at, i.length) !== i.text) { at = text.indexOf(i.text, Math.max(0, i.offset - 100)); if (at < 0) return toast('The text has changed; the suggestion no longer applies.', 'error'); }
    let rep = i.replacements[k];
    let end = at + i.length;
    // removing a word: also remove one neighbouring space
    if (rep === '' && text[end] === ' ' && (at === 0 || text[at - 1] === ' ')) end++;
    activeId = null;
    replaceRange(at, end, rep);
  }

  async function acceptAll(list) {
    // from the end of the text backwards so earlier positions stay valid
    const text = ta.value;
    let out = text, n = 0;
    for (const i of [...list].sort((a, b) => b.offset - a.offset)) {
      if (out.substr(i.offset, i.length) !== i.text) continue;
      let end = i.offset + i.length;
      if (i.replacements[0] === '' && out[end] === ' ' && (i.offset === 0 || out[i.offset - 1] === ' ')) end++;
      out = out.slice(0, i.offset) + i.replacements[0] + out.slice(end);
      n++;
    }
    ta.focus();
    ta.select();
    if (!document.execCommand('insertText', false, out)) ta.value = out;
    onInput();
    toast(`${n} suggestion${n === 1 ? '' : 's'} accepted. Ctrl+Z undoes them.`);
  }

  /** Shift positions after an edit so underlines stay in place until the next check */
  function shift(oldT, newT) {
    let a = 0;
    while (a < oldT.length && a < newT.length && oldT[a] === newT[a]) a++;
    let b = 0;
    while (b < oldT.length - a && b < newT.length - a && oldT[oldT.length - 1 - b] === newT[newT.length - 1 - b]) b++;
    const delta = newT.length - oldT.length, endOld = oldT.length - b;
    issues = issues.filter(i => i.offset + i.length <= a || i.offset >= endOld).map(i => (i.offset >= endOld ? { ...i, offset: i.offset + delta } : i));
    if (docResult) docResult.issues = docResult.issues.filter(i => i.offset + i.length <= a || i.offset >= endOld).map(i => (i.offset >= endOld ? { ...i, offset: i.offset + delta } : i));
  }

  function onInput() {
    const t = ta.value;
    if (t !== lastText) { shift(lastText, t); lastText = t; }
    grow();
    paint();
    pop.hidden = true;
    clearTimeout(timer);
    timer = setTimeout(check, 650);
    scheduleSave();
  }

  // ---------------------------------------------------------------- checking
  const body = extra => ({ variant: S.variant, goals: S.goals, disabled: S.disabled || [], ...extra });
  async function check() {
    if (checking) { again = true; return; }
    checking = true;
    const my = ++seq;
    try {
      const text = ta.value;
      const missing = [...new Set(paragraphs(text).map(p => p.text).filter(p => p.trim() && !paraCache.has(p)))];
      for (let k = 0; k < missing.length; k += 120) {
        const chunk = missing.slice(k, k + 120);
        const r = await api('/api/language/check', { body: body({ paragraphs: chunk }) });
        chunk.forEach((p, j) => paraCache.set(p, r.paragraphs[j]));
        engines = r.engines;
        if (missing.length > 120) { compute(); $('#le-count', view).textContent = `Checking… ${Math.min(100, Math.round((k + 120) / missing.length * 100))}%`; }
      }
      compute();
      const counts = {};
      for (const i of issues) if (!i.doc) counts[i.category] = (counts[i.category] || 0) + 1;
      const d = await api('/api/language/check', { body: body({ paragraphs: [], text: ta.value, counts }) });
      if (my === seq) { docResult = d.document; engines = d.engines || engines; }
      // the cache must not grow without limit while someone types for hours
      if (paraCache.size > 5000) { const keep = new Set(paragraphs(ta.value).map(p => p.text)); for (const k of paraCache.keys()) if (!keep.has(k)) paraCache.delete(k); }
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      checking = false;
      compute();
      renderFoot();
      if (!$('#le-pane-research', view).hidden) renderResearch();
      if (again) { again = false; check(); }
    }
  }

  function renderFoot() {
    const e = engines || {};
    $('#le-foot', view).innerHTML = `Checks: <b>writing rules</b> ✓ · grammar server ${e.languagetool === 'ok' ? '✓' : e.languagetool === 'unavailable' ? '(not answering)' : '(not configured)'} · AI ${cfgCache.ai ? '✓ available' : '(not switched on)'}${cfgCache.usage ? ` · ${cfgCache.usage.used}/${cfgCache.usage.limit} AI requests today` : ''}`;
  }

  // ---------------------------------------------------------------- saving
  const saveState = t => { $('#le-save', view).textContent = t; };
  function scheduleSave() { saveState('Editing…'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 1200); }
  async function save(extra = {}) {
    clearTimeout(saveTimer);
    try {
      S.dismissed = [...dismissed].slice(-3000);
      await api(`/api/language/docs/${id}`, { method: 'PUT', body: { title: $('#le-title', view).value, body: ta.value, settings: S, score: docResult?.score?.overall ?? null, ...extra } });
      saveState('Saved');
    } catch (e) { saveState('Not saved'); toast(e.message, 'error'); }
  }

  // ---------------------------------------------------------------- AI helpers
  const aiOff = () => { if (!cfgCache.ai) { toast(state.app.desktop ? 'AI features need this computer to be linked to the web platform (sign in online once) and an internet connection.' : 'AI writing features are not switched on for this platform. The administrator sets ANTHROPIC_API_KEY.', 'error'); return true; } return false; };

  function resultModal(title, r, { onReplace, onInsert } = {}) {
    const opts = r.options || [];
    modal(`<h2>${esc(title)}</h2>${r.note ? `<p class="muted">${esc(r.note)}</p>` : ''}
      ${opts.map((o, k) => `<div class="le-opt"><div class="le-opt-t">${esc(o).replace(/\n/g, '<br>')}</div><div class="row" style="gap:6px;margin-top:8px">
        ${onReplace ? `<button class="btn btn-sm btn-primary" data-r="${k}">Replace</button>` : ''}${onInsert ? `<button class="btn btn-sm ${onReplace ? '' : 'btn-primary'}" data-i="${k}">Insert at cursor</button>` : ''}
        <button class="btn btn-sm btn-ghost" data-c="${k}">Copy</button></div></div>`).join('')}
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-close>Close</button></div>`, {
      onMount(m, close) {
        m.classList.add('le-modal');
        m.addEventListener('click', e => {
          const b = e.target.closest('button');
          if (!b) return;
          if (b.dataset.r) { onReplace(opts[+b.dataset.r]); close(); }
          if (b.dataset.i) { onInsert(opts[+b.dataset.i]); close(); }
          if (b.dataset.c) copyText(opts[+b.dataset.c]);
        });
      }
    });
  }

  async function rewrite(mode, start, end, instruction = '') {
    if (aiOff()) return;
    const text = ta.value.slice(start, end);
    if (!text.trim()) return toast('Select the text to rewrite first.', 'error');
    toast('Rewriting…');
    try {
      const r = await api('/api/language/rewrite', { body: body({ text, mode, instruction }) });
      resultModal(`${(REWRITES.find(x => x[0] === mode) || [mode, 'Rewrite'])[1]}`, r.result, {
        onReplace: t => { if (ta.value.slice(start, end) === text) replaceRange(start, end, t); else toast('The text changed meanwhile; copy the rewrite instead.', 'error'); }
      });
      refreshUsage();
    } catch (e) { toast(e.message, 'error'); }
  }

  const refreshUsage = () => loadConfig().then(renderFoot).catch(() => {});

  // ---------------------------------------------------------------- research tools
  function renderResearch() {
    const pane = $('#le-pane-research', view);
    const st = docResult?.structure;
    const claims = issues.filter(i => i.rule === 'needs-citation');
    const sections = st?.sections || [];
    pane.innerHTML = `
      <div class="card le-tool"><h3>Manuscript structure</h3>
        ${sections.length ? `<table class="le-mini"><tbody>${sections.map(s => `<tr><td><a href="#" data-goto="${s.start}">${esc(s.heading)}</a></td><td class="num">${s.words.toLocaleString()} words</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No section headings found (Abstract, Introduction, Methods, Results, Discussion, References). Put each heading on its own line.</p>'}
        ${st?.missing?.length ? `<p class="txt-bad" style="margin-top:6px">Not found: ${st.missing.map(esc).join(', ')}</p>` : ''}
      </div>
      <div class="card le-tool"><h3>Claims without a citation <span class="badge b-${claims.length ? 'warn' : 'good'}">${claims.length}</span></h3>
        <p class="muted">Sentences in the Introduction and Discussion that refer to earlier work but cite nothing.</p>
        ${claims.slice(0, 12).map(c => `<div class="le-claim"><a href="#" data-issue="${c.id}">${esc(clip(c.text, 140))}</a> <button class="btn btn-sm" data-src="${c.id}">Find sources</button></div>`).join('')}
      </div>
      <div class="card le-tool"><h3>Reviewer-style feedback <span class="badge b-info">AI</span></h3>
        <p class="muted">How a peer reviewer is likely to read the manuscript: clarity, structure, academic tone, whether claims match the evidence, and the questions to expect.</p>
        <input id="le-focus" class="le-input" placeholder="Optional: what should the feedback focus on?">
        <button class="btn btn-primary btn-sm" id="le-review">Get feedback</button><div id="le-review-out"></div>
      </div>
      <div class="card le-tool"><h3>AI-written content indicator</h3>
        <p class="muted">The in-house measures used by the Paper Mill module: vocabulary favoured by AI tools, uniform sentence rhythm, stock transitions and chatbot leftovers. An indicator, not proof.</p>
        <button class="btn btn-sm" id="le-aidet">Check the text</button><div id="le-aidet-out"></div>
      </div>
      <div class="card le-tool"><h3>More checks in the portal</h3>
        <div class="le-links">
          ${state.user.permissions.includes('references') ? '<a href="#/references">Module 1 · Check the bibliography</a>' : ''}
          ${state.user.permissions.includes('restyle') ? '<a href="#/restyle">Module 2 · Format references in the journal style</a>' : ''}
          ${state.user.permissions.includes('citations') ? '<a href="#/citations">Module 3 · Do the citations support the claims?</a>' : ''}
          ${state.user.permissions.includes('manuscript') ? '<a href="#/manuscript">Similarity / full screening report</a>' : ''}
        </div>
      </div>`;
    pane.onclick = async e => {
      const g = e.target.closest('[data-goto]'), is = e.target.closest('[data-issue]'), src = e.target.closest('[data-src]');
      if (g) { e.preventDefault(); ta.focus(); ta.setSelectionRange(+g.dataset.goto, +g.dataset.goto); const m = hl.textContent; void m; scrollToOffset(+g.dataset.goto); }
      if (is) { e.preventDefault(); $('#le-tabs [data-t="suggestions"]', view).click(); activate(+is.dataset.issue); }
      if (src) findSources(issues.find(i => i.id === +src.dataset.src));
    };
    $('#le-review', pane).onclick = () => runReview();
    $('#le-aidet', pane).onclick = () => runAiDetect();
  }

  function scrollToOffset(off) {
    // a temporary marker at the offset in the highlight layer gives its position on the page
    const text = ta.value;
    hl.innerHTML = `${esc(text.slice(0, off))}<span id="le-anchor"></span>${esc(text.slice(off))}\u200b\n`;
    const a = $('#le-anchor', hl);
    if (a) window.scrollBy({ top: a.getBoundingClientRect().top - 120, behavior: 'smooth' });
    paint();
  }

  async function runReview() {
    if (aiOff()) return;
    const out = $('#le-review-out', view);
    out.innerHTML = '<p class="muted">Reading the manuscript… (up to a minute)</p>';
    try {
      const r = (await api('/api/language/review', { body: body({ text: ta.value, focus: $('#le-focus', view).value }) })).result;
      out.innerHTML = `<p>${esc(r.summary)}</p>
        <table class="le-mini"><tbody>${r.scores.map(s => `<tr><td>${esc(s.criterion)}</td><td class="num"><b>${s.score}/5</b></td></tr><tr><td colspan="2" class="muted" style="font-size:12px">${esc(s.comment)}</td></tr>`).join('')}</tbody></table>
        ${r.strengths.length ? `<h4>Strengths</h4><ul>${r.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
        ${r.comments.length ? `<h4>Comments</h4>${r.comments.map(c => `<div class="le-rc"><span class="badge b-${c.severity === 'major' ? 'bad' : 'neutral'}">${esc(c.severity)}</span> <b>${esc(c.section)}</b>${c.quote ? ` — <a href="#" data-quote="${esc(c.quote)}">“${esc(clip(c.quote, 90))}”</a>` : ''}<div>${esc(c.comment)}</div></div>`).join('')}` : ''}
        ${r.questions.length ? `<h4>Questions reviewers may ask</h4><ul>${r.questions.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}`;
      out.onclick = e => { const q = e.target.closest('[data-quote]'); if (!q) return; e.preventDefault(); const at = ta.value.indexOf(q.dataset.quote); if (at >= 0) { ta.focus(); ta.setSelectionRange(at, at + q.dataset.quote.length); scrollToOffset(at); } };
      refreshUsage();
    } catch (e) { out.innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`; }
  }

  async function runAiDetect() {
    const out = $('#le-aidet-out', view);
    out.innerHTML = '<p class="muted">Measuring…</p>';
    try {
      const r = (await api('/api/language/ai-detect', { body: { text: ta.value } })).result;
      const tone = r.score >= 55 ? 'bad' : r.score >= 25 ? 'warn' : 'good';
      out.innerHTML = `<div class="le-aiscore ${tone}"><b>${r.score}</b>/100 <span>${r.score >= 55 ? 'Strong AI-writing pattern' : r.score >= 25 ? 'Some AI-writing pattern' : 'No marked AI-writing pattern'}</span></div>
        ${r.parts.length ? `<ul>${r.parts.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
        ${r.vocabulary?.top?.length ? `<p class="muted">Most frequent AI-favoured words: ${r.vocabulary.top.slice(0, 8).map(([w, n]) => `${esc(w)} ×${n}`).join(', ')}</p>` : ''}
        ${r.leftovers.length ? `<div class="alert alert-bad">Chatbot text left in the document: ${r.leftovers.map(l => esc(l.example || l.label)).join('; ')}</div>` : ''}
        ${!r.checked ? '<p class="muted">Fewer than 300 words: the indicator is unreliable on short texts.</p>' : ''}`;
    } catch (e) { out.innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`; }
  }

  async function findSources(i) {
    if (!i) return;
    const close = modal(`<h2>Sources for this claim</h2><p class="le-q">${esc(i.text)}</p><div id="le-src-out"><p class="muted">Searching Europe PMC and Crossref…</p></div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-close>Close</button></div>`);
    void close;
    const out = $('#le-src-out');
    try {
      const r = await api('/api/language/sources', { body: { claim: i.text } });
      out.innerHTML = r.sources.length ? `<p class="muted">Candidates found with: ${r.terms.map(esc).join(', ')}. Read the source before citing it.</p>` + r.sources.map(s => {
        const first = (s.authors || '').split(',')[0].trim().split(' ')[0] || 'Anon';
        const cite = `(${first}${/,/.test(s.authors || '') ? ' et al.' : ''}, ${s.year || 'n.d.'})`;
        const ref = `${s.authors}${s.authors ? '. ' : ''}${s.title}. ${s.journal}${s.year ? `. ${s.year}` : ''}${s.doi ? `. doi:${s.doi}` : ''}`;
        return `<div class="le-src">${s.retracted ? '<span class="badge b-bad">Retracted</span> ' : ''}<b>${esc(s.title)}</b><div class="muted">${esc(s.authors)} · ${esc(s.journal)} · ${s.year || ''} ${s.doi ? `· <a href="https://doi.org/${esc(s.doi)}" target="_blank" rel="noopener">${esc(s.doi)}</a>` : ''}</div>
          <div class="row" style="gap:6px;margin-top:6px"><button class="btn btn-sm" data-cite="${esc(cite)}">Insert ${esc(cite)}</button><button class="btn btn-sm btn-ghost" data-copy="${esc(ref)}">Copy reference</button></div></div>`;
      }).join('') : '<p>No candidates found. Try the bibliography search in Module 1 or a database search.</p>';
      out.onclick = e => {
        const c = e.target.closest('[data-cite]'), cp = e.target.closest('[data-copy]');
        if (cp) copyText(cp.dataset.copy);
        if (c) {
          const text = ta.value;
          const at = text.indexOf(i.text);
          if (at < 0) return toast('The sentence has changed.', 'error');
          // before the sentence's final full stop
          const end = at + i.text.length - (/[.!?]$/.test(i.text) ? 1 : 0);
          replaceRange(end, end, ` ${c.dataset.cite}`);
          toast('Citation inserted. Add the reference to the reference list.');
        }
      };
    } catch (e) { out.innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`; }
  }

  // ---------------------------------------------------------------- insights: tone, statistics, readability
  function renderInsights() {
    const pane = $('#le-pane-insights', view);
    const d = docResult;
    if (!d) { pane.innerHTML = '<p class="muted">Checking…</p>'; return; }
    const st = d.stats, r = st.readability, sc = d.score;
    const fmt = s => (s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
    pane.innerHTML = `
      <div class="card le-tool"><h3>Tone</h3>
        ${d.tone.tones.length ? d.tone.tones.map(t => `<div class="le-tone"><span>${esc(t.label)}</span><i class="le-bar"><i style="width:${t.score}%" class="${t.good === false ? 'neg' : ''}"></i></i></div>`).join('') : '<p class="muted">Not enough text to read the tone.</p>'}
        <p class="muted" style="margin-top:6px">Formality: <b>${esc(d.tone.formality)}</b> · goal: ${esc(S.goals.formality)}</p>
        <div id="le-tone-ai"></div><button class="btn btn-sm" id="le-tone-btn">✦ Detailed tone (AI)</button>
      </div>
      <div class="card le-tool"><h3>Score by area</h3>
        <table class="le-mini"><tbody>${AREAS.map(([k, l]) => `<tr><td>${l}</td><td>${esc(sc.areas[k])}</td><td class="num">${sc.counts[k]}</td></tr>`).join('')}</tbody></table>
      </div>
      <div class="card le-tool"><h3>Readability</h3>
        <table class="le-mini"><tbody>
          <tr><td>Flesch reading ease</td><td class="num"><b>${r.flesch}</b></td></tr><tr><td colspan="2" class="muted" style="font-size:12px">${esc(r.label)}. Research articles usually score 10-40.</td></tr>
          <tr><td>Flesch-Kincaid grade</td><td class="num">${r.grade}</td></tr><tr><td>Gunning fog index</td><td class="num">${r.fog}</td></tr>
          <tr><td>SMOG index</td><td class="num">${r.smog}</td></tr><tr><td>Coleman-Liau index</td><td class="num">${r.coleman}</td></tr>
          <tr><td>Average sentence length</td><td class="num">${st.avgSentenceLength} words</td></tr><tr><td>Sentences over 30 words</td><td class="num">${st.longSentences}</td></tr>
          <tr><td>Average word length</td><td class="num">${st.avgWordLength} letters</td></tr><tr><td>Complex words (3+ syllables)</td><td class="num">${st.complexWordsPct}%</td></tr>
        </tbody></table>
      </div>
      <div class="card le-tool"><h3>Counts</h3>
        <table class="le-mini"><tbody>
          <tr><td>Words</td><td class="num">${st.words.toLocaleString()}</td></tr><tr><td>Characters</td><td class="num">${st.characters.toLocaleString()}</td></tr>
          <tr><td>Characters without spaces</td><td class="num">${st.charactersNoSpaces.toLocaleString()}</td></tr><tr><td>Sentences</td><td class="num">${st.sentences}</td></tr>
          <tr><td>Paragraphs</td><td class="num">${st.paragraphs}</td></tr><tr><td>Unique words</td><td class="num">${st.uniqueWords.toLocaleString()} (${st.uniqueWordsPct}%)</td></tr>
          <tr><td>Reading time</td><td class="num">${fmt(st.readingTime)}</td></tr><tr><td>Speaking time</td><td class="num">${fmt(st.speakingTime)}</td></tr>
        </tbody></table>
      </div>
      <div class="card le-tool"><h3>Personal dictionary</h3>
        <p class="muted">Words you added are never marked as misspelled, in any document.</p>
        <div class="chips">${[...personal].sort().map(w => `<span class="chip">${esc(w)} <a href="#" data-unword="${esc(w)}" title="Remove">×</a></span>`).join('') || '<span class="muted">Empty</span>'}</div>
      </div>`;
    $('#le-tone-btn', pane).onclick = async () => {
      if (aiOff()) return;
      const box = $('#le-tone-ai', pane);
      box.innerHTML = '<p class="muted">Reading…</p>';
      try {
        const t = (await api('/api/language/tone', { body: body({ text: ta.value }) })).result;
        box.innerHTML = `<p>${esc(t.summary)}</p>${t.tones.map(x => `<div class="le-tone"><span>${esc(x.label)}</span><i class="le-bar"><i style="width:${x.score}%" class="${x.good ? '' : 'neg'}"></i></i></div>`).join('')}`;
        refreshUsage();
      } catch (e) { box.innerHTML = `<div class="alert alert-bad">${esc(e.message)}</div>`; }
    };
    pane.onclick = async e => {
      const u = e.target.closest('[data-unword]');
      if (!u) return;
      e.preventDefault();
      const r = await api(`/api/language/dictionary/${encodeURIComponent(u.dataset.unword)}`, { method: 'DELETE' });
      personal = new Set(r.words);
      paraCache.clear();
      check();
    };
  }

  // ---------------------------------------------------------------- goals
  function goalsModal() {
    const g = S.goals;
    const sel = (id, label, opts, v) => `<div class="field"><label for="${id}">${label}</label><select id="${id}">${opts.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
    modal(`<h2>Writing goals</h2><p class="muted">Suggestions are tailored to what you are writing and who will read it.</p>
      ${sel('g-preset', 'Document type', [...Object.entries(PRESETS).map(([k, p]) => [k, p.label]), ['custom', 'Custom']], S.preset)}
      <div class="grid grid-2">
        ${sel('g-domain', 'Domain', [['academic', 'Academic / research'], ['business', 'Business'], ['general', 'General'], ['email', 'E-mail'], ['casual', 'Casual'], ['creative', 'Creative']], g.domain)}
        ${sel('g-formality', 'Formality', [['formal', 'Formal'], ['neutral', 'Neutral'], ['informal', 'Informal']], g.formality)}
        ${sel('g-audience', 'Audience', [['expert', 'Expert (specialists, reviewers)'], ['knowledgeable', 'Knowledgeable'], ['general', 'General public']], g.audience)}
        ${sel('g-intent', 'Intent', [['inform', 'Inform'], ['describe', 'Describe'], ['convince', 'Convince'], ['tell', 'Tell a story']], g.intent)}
        ${sel('g-passive', 'Passive voice', [['allow', 'Accept it (normal in Methods and Results)'], ['flag', 'Suggest the active voice']], g.passive)}
        <div class="field"><label for="g-abs">Abstract word limit</label><input id="g-abs" type="number" min="50" max="1000" value="${g.abstractWords || 250}"></div>
      </div>
      ${(S.disabled || []).length ? `<div class="field"><label>Checks turned off</label><div class="chips">${S.disabled.map(r => `<span class="chip">${esc(r)} <a href="#" data-on="${esc(r)}">turn on</a></span>`).join('')}</div></div>` : ''}
      <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="g-save">Apply</button></div>`, {
      onMount(m, close) {
        const preset = $('#g-preset', m);
        preset.onchange = () => {
          const p = PRESETS[preset.value];
          if (!p) return;
          for (const k of ['domain', 'formality', 'audience', 'intent', 'passive']) $(`#g-${k}`, m).value = p.goals[k];
          $('#g-abs', m).value = p.goals.abstractWords;
        };
        m.addEventListener('click', e => { const on = e.target.closest('[data-on]'); if (on) { e.preventDefault(); S.disabled = S.disabled.filter(r => r !== on.dataset.on); on.closest('.chip').remove(); } });
        $('#g-save', m).onclick = () => {
          S.goals = { domain: $('#g-domain', m).value, formality: $('#g-formality', m).value, audience: $('#g-audience', m).value, intent: $('#g-intent', m).value, passive: $('#g-passive', m).value, abstractWords: +$('#g-abs', m).value || 250 };
          const p = PRESETS[preset.value];
          S.preset = p && Object.keys(p.goals).every(k => String(p.goals[k]) === String(S.goals[k])) ? preset.value : 'custom';
          goalLabel();
          close();
          paraCache.clear(); aiCache.clear();
          check();
          save();
        };
      }
    });
  }

  function askModal() {
    if (aiOff()) return;
    const selStart = ta.selectionStart, selEnd = ta.selectionEnd;
    const selection = ta.value.slice(selStart, selEnd);
    modal(`<h2>✦ Ask AI</h2><p class="muted">Ask for new text from your document: an abstract, titles, keywords, a cover letter, a reply to a reviewer.${selection ? ' The selected text is included.' : ''} Facts are taken only from your document; missing details are left as [placeholders].</p>
      <textarea id="ask-p" rows="3" class="le-input" placeholder="What would you like written?"></textarea>
      <div class="chips" style="margin:8px 0">${PROMPTS.map(p => `<button class="chip le-chip" type="button">${esc(p)}</button>`).join('')}</div>
      <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="ask-go">Write</button></div>`, {
      onMount(m, close) {
        m.classList.add('le-modal');
        const p = $('#ask-p', m);
        p.focus();
        m.addEventListener('click', e => { const c = e.target.closest('.le-chip'); if (c) { p.value = c.textContent; p.focus(); } });
        $('#ask-go', m).onclick = async () => {
          if (!p.value.trim()) return;
          const b = $('#ask-go', m);
          b.disabled = true; b.textContent = 'Writing…';
          try {
            const r = (await api('/api/language/generate', { body: body({ prompt: p.value, text: ta.value, selection }) })).result;
            close();
            resultModal('AI draft', r, {
              onInsert: t => replaceRange(selEnd, selEnd, `${selEnd && ta.value[selEnd - 1] !== '\n' ? '\n\n' : ''}${t}\n`),
              onReplace: selection ? t => { if (ta.value.slice(selStart, selEnd) === selection) replaceRange(selStart, selEnd, t); } : null
            });
            refreshUsage();
          } catch (e) { toast(e.message, 'error'); b.disabled = false; b.textContent = 'Write'; }
        };
      }
    });
  }

  async function runAiSuggestions() {
    if (aiOff()) return;
    const paras = [...new Set(paragraphs(ta.value).map(p => p.text).filter(p => p.trim().split(/\s+/).length >= 6 && !aiCache.has(p)))];
    const refs = refStart(ta.value);
    const prose = paras.filter(p => ta.value.indexOf(p) < refs);
    if (!prose.length) return toast('AI suggestions are already shown for every paragraph.');
    const btn = $('#le-ai-run', view);
    btn.disabled = true;
    try {
      for (let k = 0; k < prose.length; k += 8) {
        btn.textContent = `✦ AI reading… ${Math.round(k / prose.length * 100)}%`;
        const chunk = prose.slice(k, k + 8);
        const r = await api('/api/language/check', { body: body({ paragraphs: chunk, ai: true }) });
        if (r.engines?.ai === 'unavailable') { toast(r.engines.aiError || 'AI suggestions are unavailable.', 'error'); break; }
        chunk.forEach((p, j) => aiCache.set(p, (r.paragraphs[j] || []).filter(i => i.ai)));
        compute();
      }
      refreshUsage();
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false;
    btn.textContent = '✦ AI sentence suggestions';
  }

  // ---------------------------------------------------------------- events
  ta.addEventListener('input', onInput);
  const caretCheck = () => {
    const s = ta.selectionStart, e = ta.selectionEnd;
    $('#le-selbar', view).hidden = e - s < 2;
    if (s !== e) return;
    const hit = issues.find(i => !i.whole && s >= i.offset && s <= i.offset + i.length);
    if (hit && hit.id !== activeId) activate(hit.id, { scroll: false });
    else if (!hit && activeId) { activeId = null; render(); }
  };
  ta.addEventListener('click', caretCheck);
  ta.addEventListener('keyup', e => { if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) caretCheck(); });
  ta.addEventListener('select', caretCheck);
  ta.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { activeId = null; render(); }
  });

  const onCardAction = (el, e) => {
    const card = e.target.closest('[data-id]');
    if (!card) return;
    const i = issues.find(x => x.id === +card.dataset.id);
    if (!i) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) { if (el === 'cards') activate(i.id === activeId ? null : i.id); return; }
    e.stopPropagation();
    if (act === 'close') { activeId = null; render(); }
    if (act === 'accept') accept(i, +e.target.closest('[data-k]').dataset.k);
    if (act === 'dismiss') { dismissed.add(keyOf(i, ta.value)); activeId = null; compute(); scheduleSave(); }
    if (act === 'off') { S.disabled = [...new Set([...(S.disabled || []), i.rule])]; activeId = null; compute(); scheduleSave(); toast(`“${i.title}” suggestions turned off. Turn them on again under Goals.`); }
    if (act === 'dict') {
      api('/api/language/dictionary', { body: { word: i.text } }).then(r => { personal = new Set(r.words); activeId = null; compute(); toast(`“${i.text}” added to your dictionary.`); }).catch(err => toast(err.message, 'error'));
    }
    if (act === 'ai') {
      // the sentence around the suggestion
      const t = ta.value;
      let s = i.offset, en = i.offset + i.length;
      if (!i.whole) { while (s > 0 && !/[.!?\n]/.test(t[s - 1])) s--; while (en < t.length && !/[.!?\n]/.test(t[en])) en++; if (/[.!?]/.test(t[en])) en++; }
      while (/\s/.test(t[s])) s++;
      rewrite(i.ai === 'shorten' || i.rule === 'long-sentence' ? 'shorten' : 'improve', s, en);
    }
    if (act === 'sources') findSources(i);
  };
  $('#le-cards', view).addEventListener('click', e => onCardAction('cards', e));
  pop.addEventListener('click', e => onCardAction('pop', e));
  $('#le-areas', view).addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (b) { area = b.dataset.a; renderCards(); } });
  $('#le-bulk', view).addEventListener('click', e => {
    if (!e.target.closest('#le-accept-all')) return;
    acceptAll(issues.filter(i => (area === 'all' || i.category === area) && i.category !== 'engagement' && i.replacements?.length === 1 && !i.ai && !i.whole));
  });
  $('#le-tabs', view).addEventListener('click', e => {
    const t = e.target.closest('[data-t]');
    if (!t) return;
    $$('#le-tabs .tab', view).forEach(x => x.classList.toggle('active', x === t));
    for (const k of ['suggestions', 'research', 'insights']) $(`#le-pane-${k}`, view).hidden = k !== t.dataset.t;
    if (t.dataset.t === 'research') renderResearch();
    if (t.dataset.t === 'insights') renderInsights();
  });
  $('#le-score', view).onclick = () => $('#le-tabs [data-t="insights"]', view).click();
  $('#le-ai-run', view).onclick = runAiSuggestions;
  $('#le-goals', view).onclick = goalsModal;
  $('#le-ask', view).onclick = askModal;
  $('#le-variant', view).onchange = e => { S.variant = e.target.value; paraCache.clear(); aiCache.clear(); check(); save(); };
  $('#le-title', view).addEventListener('input', scheduleSave);
  $('#le-selbar', view).addEventListener('click', e => { const b = e.target.closest('[data-rw]'); if (b) rewrite(b.dataset.rw, ta.selectionStart, ta.selectionEnd); });
  $('#le-rw-more', view).onchange = e => {
    const mode = e.target.value;
    e.target.value = '';
    if (!mode) return;
    const s = ta.selectionStart, en = ta.selectionEnd;
    if (mode === 'custom') { const ins = prompt('How should the selected text be rewritten?'); if (ins) rewrite('custom', s, en, ins); return; }
    rewrite(mode, s, en);
  };
  const menu = $('.le-menu-list', view);
  $('#le-dl', view).onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; }, { once: false });
  menu.addEventListener('click', async e => {
    const f = e.target.closest('[data-f]')?.dataset.f;
    if (!f) return;
    menu.hidden = true;
    const title = $('#le-title', view).value || 'Document';
    try {
      if (f === 'copy') return copyText(ta.value);
      if (f === 'original') { await save({ resetOriginal: true }); original = ta.value; return toast('This version is now the original: tracked changes will start from here.'); }
      if (f === 'tracked' && original === ta.value) return toast('No changes since the original text yet.', 'error');
      await download('/api/language/export', { format: f, title, text: ta.value, original, score: docResult?.score, stats: docResult?.stats, tone: docResult?.tone, structure: docResult?.structure,
        issues: f === 'report' ? issues.map(i => ({ category: i.category, title: i.title, message: i.message, text: i.text, replacements: i.replacements })) : undefined });
    } catch (err) { toast(err.message, 'error'); }
  });
  window.addEventListener('resize', () => { grow(); showPop(); });
  // save on leaving the page
  const leave = () => { if ($('#le-save', view)?.textContent === 'Editing…') save(); };
  window.addEventListener('hashchange', leave, { once: true });

  grow();
  renderFoot();
  render();
  check();
}
