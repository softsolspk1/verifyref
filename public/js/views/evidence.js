// views/evidence.js - Find Evidence: sources that support a sentence, with the verbatim evidence
import { esc, $, $$, toast, startJob, styleOptions, download, copyText, badge, ICONS } from '../core.js';

export function renderEvidence(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Find Evidence</h1>
      <p>Paste a sentence that needs a source. Scholarly indexes are searched, open full texts and abstracts are read, and each suggestion shows the formatted citation, the verbatim evidence passage and the evidence level. When your sentence says more than the source, a more cautious wording is suggested. Retracted papers are excluded.</p></div></div>
    <div id="form-area" class="card">
      <div class="field"><label for="claim">Sentence needing a source</label><textarea id="claim" rows="3" placeholder="e.g. Thymoquinone reduces oxidative stress markers in diabetic rats."></textarea>
        <div class="hint">Include the population, the relationship and any figures — specific sentences find better evidence.</div></div>
      <div class="field"><label for="ctx">Context <span class="muted">(optional)</span></label><input id="ctx" type="text" placeholder="e.g. hepatoprotective effect, animal studies"></div>
      <div class="grid grid-2">
        <div class="field"><label for="style">Citation style</label><select id="style">${styleOptions('apa7')}</select></div>
        <div class="field"><label for="scope">Scope</label><select id="scope"><option value="any">No preference</option><option value="international">International literature</option><option value="pakistan">Pakistan-based studies</option></select></div>
      </div>
      <button class="btn btn-primary" id="run">Find evidence</button>
    </div>
    <div id="progress"></div><div id="result"></div>`;
  $('#run', view).onclick = async () => {
    const claim = $('#claim', view).value.trim();
    if (claim.length < 15) return toast('Enter a full sentence.', 'error');
    $('#run', view).disabled = true;
    try {
      const r = await startJob('/api/evidence', { body: { claim, context: $('#ctx', view).value, style: $('#style', view).value, scope: $('#scope', view).value } }, $('#progress', view), 'Searching for evidence (20–45 seconds)');
      if (r) renderEvidenceResult($('#result', view), r);
    } catch (e) { toast(e.message, 'error'); } finally { $('#run', view).disabled = false; }
  };
}

const SUPPORT = { full: ['Strong support', 'good'], partial: ['Partial support', 'warn'], unsupported: ['Weak support', 'neutral'] };

export function renderEvidenceResult(el, r) {
  el.innerHTML = `
    <div class="card-head" style="margin-top:8px"><h2 style="margin:0">${r.results.length} source(s) for “${esc(r.claim.slice(0, 120))}${r.claim.length > 120 ? '…' : ''}”</h2>
      <div class="row no-print"><span class="muted">${r.screened || 0} screened</span>${r.results.length ? `<button class="btn btn-sm" id="docx">${ICONS.download} Word</button><button class="btn btn-sm" id="allcopy">${ICONS.copy} Copy all citations</button>` : ''}</div></div>
    ${r.note ? `<div class="alert alert-warn">${esc(r.note)}</div>` : ''}
    ${r.results.map((x, i) => `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">
          <div><div style="font-size:14px">${x.citation.html}</div><div class="muted" style="margin-top:4px">In-text: <b>${esc(x.citation.inText)}</b></div></div>
          <div class="row" style="flex:none">${badge(SUPPORT[x.support]?.[0] || x.support, SUPPORT[x.support]?.[1] || 'neutral')} ${badge(x.level === 'full text' ? 'Full text' : 'Abstract', x.level === 'full text' ? 'info' : 'neutral')}</div>
        </div>
        <div class="quote">“${esc(x.quote)}”<span class="src">${esc(x.origin)}${x.url ? ` · <a href="${esc(x.url)}" target="_blank" rel="noopener">source</a>` : ''} · match ${x.score}%</span></div>
        ${x.wording ? `<div class="suggest"><b>Suggested wording:</b> ${esc(x.wording.wording)} <span class="muted">— ${esc(x.wording.changes.join('; '))}</span> <button class="btn btn-ghost btn-sm" data-wc="${i}">${ICONS.copy}</button></div>` : ''}
        ${x.notes?.length ? `<div class="muted" style="font-size:12.5px;margin-top:6px">${x.notes.map(esc).join(' · ')}</div>` : ''}
        <div class="row" style="margin-top:10px"><button class="btn btn-sm" data-copy="${i}">${ICONS.copy} Copy citation</button></div>
      </div>`).join('')}`;
  $$('[data-copy]', el).forEach(b => (b.onclick = () => copyText(r.results[b.dataset.copy].citation.text)));
  $$('[data-wc]', el).forEach(b => (b.onclick = () => copyText(r.results[b.dataset.wc].wording.wording)));
  if ($('#docx', el)) $('#docx', el).onclick = () => download('/api/export/docx', { kind: 'evidence', data: r }).catch(e => toast(e.message, 'error'));
  if ($('#allcopy', el)) $('#allcopy', el).onclick = () => copyText(r.results.map(x => x.citation.text).join('\n'));
}
