// views/assistant.js - Thesis / Paper Assistant: cited introduction, literature review or research-gap analysis
import { esc, $, $$, toast, startJob, styleOptions, download, copyText, modal, badge, hasModule, ICONS } from '../core.js';

export function renderAssistant(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Thesis / Paper Assistant</h1>
      <p>Enter a topic — rough keywords are fine. About 50 relevant abstracts are scanned (and the citation network of up to three key papers) to assemble a cited introduction, a literature review or a research-gap analysis. Every sentence comes from a real abstract: click a citation to see it. Output is in English.</p></div></div>
    <div id="form-area" class="card">
      <div class="field"><label for="topic">Topic or keywords</label><input id="topic" type="text" placeholder="e.g. antibacterial activity of medicinal plant extracts against MDR bacteria"></div>
      <div class="grid grid-3">
        <div class="field"><label>Draft</label><div class="seg" id="section"><button class="active" data-v="introduction">Introduction</button><button data-v="review">Literature review</button><button data-v="gap">Research gaps</button></div></div>
        <div class="field"><label>For</label><div class="seg" id="dtype"><button class="active" data-v="article">Article</button><button data-v="thesis">Thesis</button></div></div>
        <div class="field"><label for="style">Citation style</label><select id="style">${styleOptions('apa7')}</select></div>
      </div>
      <details><summary style="cursor:pointer;font-weight:600;margin-bottom:10px">Advanced options</summary>
        <div class="grid grid-2"><div class="field"><label for="yf">Sources from year</label><input id="yf" type="number" min="1950" max="2100"></div><div class="field"><label for="yt">to year</label><input id="yt" type="number" min="1950" max="2100"></div></div>
        <div class="field"><label for="kp">Key papers (up to 3 — DOI or title, one per line)</label><textarea id="kp" rows="3"></textarea><div class="hint">Their references and the works citing them are added to the sources.</div></div>
        <div class="field"><label for="focus">Your study's focus or contribution</label><textarea id="focus" rows="2" placeholder="e.g. evaluates five Pakistani medicinal plants against clinical MDR isolates"></textarea></div>
      </details>
      <button class="btn btn-primary" id="run">Generate draft</button>
    </div>
    <div id="progress"></div><div id="result"></div>`;
  const segVal = id => $(`#${id} .active`, view).dataset.v;
  $$('.seg', view).forEach(seg => $$('button', seg).forEach(b => (b.onclick = () => $$('button', seg).forEach(x => x.classList.toggle('active', x === b)))));
  $('#run', view).onclick = async () => {
    const topic = $('#topic', view).value.trim();
    if (topic.length < 4) return toast('Enter a topic.', 'error');
    $('#run', view).disabled = true;
    try {
      const r = await startJob('/api/assistant', { body: { topic, section: segVal('section'), draftType: segVal('dtype'), style: $('#style', view).value, yearFrom: $('#yf', view).value, yearTo: $('#yt', view).value, keyPapers: $('#kp', view).value, focus: $('#focus', view).value } }, $('#progress', view), 'Reading abstracts and assembling the draft');
      if (r) renderAssistantResult($('#result', view), r);
    } catch (e) { toast(e.message, 'error'); } finally { $('#run', view).disabled = false; }
  };
}

export function renderAssistantResult(el, r) {
  const sources = new Map(r.sources.map(s => [s.id, s]));
  let k = 0;
  const sentences = [];
  const sentence = x => {
    const i = k++;
    sentences[i] = x;
    return `${x.label ? `<span class="lbl">${badge(x.label, x.label === 'from data' ? 'info' : x.label === 'from review' ? 'good' : 'neutral')}</span>` : ''}<span class="${x.own ? 'own' : ''}" ${x.own ? 'title="Your own sentence — edit it"' : ''}>${esc(x.text)}</span>${x.citeLabel ? ` <span class="cite" data-s="${i}">${esc(x.citeLabel)}</span>` : ''}. `;
  };
  const section = (s, h) => `<${h}>${esc(s.heading)}</${h}>${(s.paragraphs || []).filter(p => p.sentences.length).map(p => `<p>${p.sentences.map(sentence).join('')}</p>`).join('')}${(s.subsections || []).map(x => section(x, 'h3')).join('')}`;
  const a = r.analysis;
  const maxT = a?.trend?.length ? Math.max(...a.trend.map(t => t.works)) : 1;
  el.innerHTML = `
    <div class="card-head"><h2 style="margin:0">${esc(r.topic)}</h2>
      <div class="row no-print"><span class="muted">${r.screened} sources screened</span><button class="btn btn-sm" id="copy">${ICONS.copy} Copy text</button><button class="btn btn-sm" id="docx">${ICONS.download} Word</button>${hasModule('references') ? '<button class="btn btn-sm" id="verify">Verify &amp; fix references</button>' : ''}</div></div>
    <div class="alert alert-warn">${esc(r.disclaimer)}</div>
    ${r.keyPapers?.length ? `<p class="muted">Citation network followed for: ${r.keyPapers.map(p => esc(`${p.title} (${p.year})`)).join('; ')}</p>` : ''}
    <div class="card draft">${r.sections.map(s => section(s, 'h2')).join('')}</div>
    ${a ? `<div class="grid grid-2">
      <div class="card"><h3>Publications per year</h3><div class="bars">${a.trend.map(t => `<div class="bar-row"><span>${t.year}</span><div class="bar-track"><span style="width:${Math.round(t.works / maxT * 100)}%"></span></div><span class="num">${t.works.toLocaleString()}</span></div>`).join('')}</div></div>
      <div class="card"><h3>Prominent sub-topics (last six years)</h3><table class="t"><tr><th>Sub-topic</th><th class="num">Papers</th><th class="num">Growth</th></tr>${a.topics.map(t => `<tr><td>${esc(t.name)}</td><td class="num">${t.works.toLocaleString()}</td><td class="num">${t.growth === null || t.growth === undefined ? '—' : `${t.growth > 0 ? '+' : ''}${t.growth}%`}</td></tr>`).join('')}</table>
        <p class="muted" style="margin:8px 0 0">Gap labels: <b>from review</b> — stated in a review article; <b>from data</b> — derived from publication counts; <b>inferred</b> — stated in a single study.</p></div>
    </div>` : ''}
    <div class="card"><h3>References</h3>${r.references.map(x => `<p style="margin:0 0 8px">${x.html}</p>`).join('')}</div>`;
  $$('.cite', el).forEach(c => (c.onclick = () => {
    const x = sentences[c.dataset.s];
    const src = sources.get(x.cites[0]);
    if (!src) return;
    const abs = esc(src.abstract);
    const basis = x.basis ? esc(x.basis) : '';
    modal(`<div class="card-head"><h3 style="margin:0">${esc(src.title)}</h3><button class="btn btn-sm btn-ghost" data-close>✕</button></div>
      <p class="muted">${esc(src.journal || '')} ${src.year || ''}${src.doi ? ` · <a href="https://doi.org/${esc(src.doi)}" target="_blank" rel="noopener">doi:${esc(src.doi)}</a>` : ''}</p>
      <p style="line-height:1.7">${basis && abs.includes(basis) ? abs.replace(basis, `<mark>${basis}</mark>`) : abs}</p>`);
  }));
  const plain = () => {
    const lines = [];
    const walk = s => { lines.push(s.heading); (s.paragraphs || []).forEach(p => p.sentences.length && lines.push(p.sentences.map(x => x.display).join(' '))); (s.subsections || []).forEach(walk); };
    r.sections.forEach(walk);
    lines.push('', 'References', ...r.references.map(x => x.text));
    return lines.join('\n\n');
  };
  $('#copy', el).onclick = () => copyText(plain());
  $('#docx', el).onclick = () => download('/api/export/docx', { kind: 'assistant', data: r }).catch(e => toast(e.message, 'error'));
  if ($('#verify', el)) $('#verify', el).onclick = () => {
    try { sessionStorage.setItem('prefill-references', r.references.map(x => x.text).join('\n')); } catch (e) { /* ignore */ }
    location.hash = '#/references';
  };
}
