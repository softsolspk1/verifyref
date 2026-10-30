// views/check.js - input forms for the Full Screening Report and Module 1 (Check Bibliography)
import { api, esc, $, toast, runJob, dropzone, fmtDate, modal } from '../core.js';
import { renderReport } from './report.js';

const MODES = {
  manuscript: {
    title: 'Full Screening Report',
    intro: 'One upload runs the PJPS modules: Check Bibliography (every reference searched in all databases: Crossref, PubMed, Europe PMC, OpenAlex, Semantic Scholar, CORE, Google Books and more, plus Google Scholar and Google when set up; retractions, quality indicators), PJPS style compliance, Citations (list matching and citation pattern) and Paper Mill Detection — plus the findings of a Module 5 image report if you attach one. The front page gives a summary per module and a desk-review recommendation; an author version (Modules 1–3) can be sent after your approval. Claim support is checked in Module 3.',
    needsBody: true, meta: true, screening: true
  },
  references: {
    title: 'Module 1 — Check Bibliography',
    intro: 'Confirms that every reference is real, correct and not retracted: every reference is searched in all 13 scholarly databases at once (Crossref, the DOI registry, DataCite, OpenAlex, PubMed with its citation matcher, Europe PMC, Semantic Scholar, arXiv, DBLP, Open Library, Google Books, ERIC, CORE), and in Google Scholar and Google when none of them can verify it and a SerpApi key is configured, Retraction Watch, fabrication checks, link checks, reference age against the PJPS rule, self-citation, PJPS citations, predatory / hijacked journals and duplicate references. Regional journals that the databases do not cover are shown as “Not indexed”, not as fake.',
    needsBody: false, meta: false, authors: true
  },
  citations: {
    title: 'Citation Check',
    intro: 'Matches in-text citations with the reference list and shows citations missing from the list, references never cited, ambiguous author–year citations and numbering-order problems. Works with numbered (Vancouver) and author–year (APA/Harvard) styles.',
    needsBody: true, meta: false
  }
};

export function renderCheckForm(view, kind) {
  const m = MODES[kind];
  const doc = { referencesText: '', bodyText: '', structured: null, filename: '', edited: null };

  view.innerHTML = `
    <div class="page-head"><div><h1>${esc(m.title)}</h1><p>${esc(m.intro)}</p></div></div>
    <div id="form-area">
      <div class="card">
        <div class="dropzone" id="dz">
          <input type="file" id="file" accept=".pdf,.docx,.doc,.txt,.bib,.ris,.rtf,.odt" hidden>
          <div><strong>Upload ${m.needsBody ? 'the manuscript' : 'a manuscript or reference file'}</strong> — drag &amp; drop or click</div>
          <div class="muted" style="margin-top:4px">Word (.docx), PDF, plain text${m.needsBody ? '' : ', BibTeX (.bib) or RIS (.ris)'} · up to 500 MB</div>
        </div>
        <div id="file-info" class="alert alert-info" hidden style="margin-top:12px"></div>

        <div class="field" style="margin-top:16px">
          <label for="paste">${m.needsBody ? 'Or paste the full manuscript text (including the References section)' : 'Or paste the reference list'}</label>
          <textarea id="paste" class="mono" rows="${m.needsBody ? 10 : 12}" placeholder="${m.needsBody ? 'Title, authors, abstract, main text… References…' : '1. Author A, Author B. Title. Journal. 2020;12(3):45-67. doi:10.xxxx/yyyy\n2. …'}"></textarea>
        </div>
      </div>

      ${m.meta ? `
      <div class="card">
        <div class="card-head"><h2>Manuscript details</h2><span class="muted">Detected automatically — please confirm</span></div>
        <div class="grid grid-2">
          <div class="field"><label for="m-code">Manuscript ID</label><input id="m-code" type="text" placeholder="e.g. PJPS-2026-0412"><div class="hint">Use the same ID for revisions — versions are numbered automatically and compared.</div></div>
          <div class="field"><label for="m-kw">Keywords</label><input id="m-kw" type="text" placeholder="separated by commas"></div>
        </div>
        <div class="field"><label for="m-title">Title</label><input id="m-title" type="text"></div>
        <div class="grid grid-2">
          <div class="field"><label for="m-authors">Authors</label><textarea id="m-authors" rows="3" placeholder="One per line, e.g.&#10;Muhammad Ali Khan&#10;Ayesha Siddiqui"></textarea><div class="hint">Needed for self-citation analysis.</div></div>
          <div class="field"><label for="m-aff">Affiliations</label><textarea id="m-aff" rows="3" placeholder="One per line"></textarea></div>
        </div>
        <div class="field"><label for="m-abs">Abstract</label><textarea id="m-abs" rows="4"></textarea><div class="hint">Used to judge whether references and self-citations are on topic.</div></div>
      </div>` : `
      <div class="card">
        <div class="grid grid-2">
          <div class="field"><label for="m-code">Manuscript ID <span class="muted">(optional)</span></label><input id="m-code" type="text" placeholder="e.g. PJPS-2026-0412"></div>
          <div class="field"><label for="m-title">Title <span class="muted">(optional)</span></label><input id="m-title" type="text"></div>
        </div>
        ${m.authors ? '<div class="field"><label for="m-authors">Manuscript authors, one per line <span class="muted">(optional — needed for the self-citation count)</span></label><textarea id="m-authors" rows="3"></textarea></div>' : ''}
      </div>`}
      ${m.screening ? `
      <div class="card">
        <div class="card-head"><h2>Paper mill &amp; image checks</h2><span class="muted">Editor only — never shown to authors</span></div>
        <div class="grid grid-2">
          <div class="field"><label for="m-rev">Suggested reviewers <span class="muted">(names and e-mails, optional)</span></label><textarea id="m-rev" rows="3"></textarea></div>
          <div class="field"><label for="m-img">Module 5 image report for this manuscript <span class="muted">(optional)</span></label><select id="m-img"><option value="">— none —</option></select><div class="hint">Run Image Integrity first (it works in your browser), then attach its report here.</div></div>
        </div>
      </div>` : ''}

      <div class="card">
        <div class="grid grid-2">
          <div class="field" hidden><select id="issue"><option value=""></option></select>
            <input type="radio" name="save" value="full" checked></div>
        </div>
        <div class="row">
          <button class="btn btn-primary" id="run">Run ${esc(m.title)}</button>
          <button class="btn btn-ghost" id="clear">Clear</button>
          <button class="btn" id="review" title="See how the reference list was split; correct, split, merge or delete entries before checking">Review detected references</button>
          <span class="muted" id="ref-count"></span>
        </div>
      </div>
    </div>
    <div id="progress"></div>
    <div id="result"></div>`;

  if (m.screening) api('/api/checks?kind=images').then(d => { $('#m-img', view).innerHTML += d.checks.slice(0, 60).map(c => `<option value="${c.id}">${esc(c.manuscript_code || '')} ${esc((c.title || '').slice(0, 60))} · ${fmtDate(c.created_at)}</option>`).join(''); }).catch(() => {});
  const paste = $('#paste', view);
  const info = $('#file-info', view);
  // A reference list handed over by another tool (e.g. the Thesis/Paper Assistant's "Verify & fix references")
  try {
    const pre = sessionStorage.getItem('prefill-references');
    if (pre && kind === 'references') { paste.value = pre; sessionStorage.removeItem('prefill-references'); }
  } catch (e) { /* storage unavailable */ }

  dropzone($('#dz', view), $('#file', view), async file => {
    info.hidden = false;
    info.className = 'alert alert-info';
    info.textContent = `Reading ${file.name}…`;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const d = await api('/api/extract', { form: fd });
      Object.assign(doc, { referencesText: d.referencesText, bodyText: d.bodyText, structured: d.structured || null, filename: d.filename, edited: null });
      paste.value = '';
      paste.placeholder = `Using ${d.filename}`;
      const warn = m.needsBody && !d.fullManuscript ? ' — no manuscript body detected; in-text citations cannot be checked.' : '';
      info.className = `alert ${warn ? 'alert-warn' : 'alert-good'}`;
      info.textContent = `${d.filename}: ${d.referenceCount} references found${d.fullManuscript ? ' and the manuscript text was detected' : ''}${warn}`;
      const meta = d.meta || {};
      if ($('#m-title', view) && meta.title) $('#m-title', view).value = meta.title;
      if ($('#m-authors', view) && meta.authors?.length) $('#m-authors', view).value = meta.authors.map(a => a.name).join('\n');
      if ($('#m-aff', view) && meta.affiliations?.length) $('#m-aff', view).value = meta.affiliations.join('\n');
      if ($('#m-abs', view) && meta.abstract) $('#m-abs', view).value = meta.abstract;
      if ($('#m-kw', view) && meta.keywords?.length) $('#m-kw', view).value = meta.keywords.join(', ');
      if ($('#m-code', view) && !$('#m-code', view).value) {
        const code = (file.name.match(/PJPS[-_\s]?\d{4}[-_\s]?\d{2,5}/i) || [])[0];
        if (code) $('#m-code', view).value = code.toUpperCase().replace(/[_\s]/g, '-');
      }
    } catch (e) {
      info.className = 'alert alert-bad';
      info.textContent = e.message;
    }
  });

  paste.addEventListener('input', () => { if (paste.value.trim()) Object.assign(doc, { referencesText: '', bodyText: '', structured: null, filename: '', edited: null }); });

  // Module 1.1 - edit / split / merge the detected reference list before it is checked
  $('#review', view).onclick = async () => {
    const text = paste.value.trim();
    if (!text && !doc.referencesText && !doc.structured) return toast('Upload a file or paste the text first.', 'error');
    let items = doc.edited;
    if (!items) {
      try {
        const d = await api('/api/parse', { body: doc.structured ? { text: doc.structured.map(e => e.raw).join('\n'), strategy: 'one-per-line' } : { text: text || doc.referencesText, full: !!text && m.needsBody } });
        items = d.references.map(r => r.raw);
        if (text && d.bodyText) doc.pastedBody = d.bodyText;
      } catch (e) { return toast(e.message, 'error'); }
    }
    openReferenceEditor(items, list => {
      doc.edited = list;
      $('#ref-count', view).textContent = `${list.length} references (edited list will be used)`;
    });
  };

  $('#clear', view).onclick = () => renderCheckForm(view, kind);

  $('#run', view).onclick = async () => {
    const text = paste.value.trim();
    if (!text && !doc.referencesText && !doc.structured) return toast('Upload a file or paste the text first.', 'error');
    const body = {
      kind,
      issueId: $('#issue', view).value || null,
      saveMode: view.querySelector('input[name=save]:checked').value,
      meta: {
        manuscriptCode: $('#m-code', view)?.value || '',
        title: $('#m-title', view)?.value || '',
        authors: ($('#m-authors', view)?.value || '').split('\n').map(s => s.trim()).filter(Boolean),
        affiliations: ($('#m-aff', view)?.value || '').split('\n').map(s => s.trim()).filter(Boolean),
        abstract: $('#m-abs', view)?.value || '',
        keywords: ($('#m-kw', view)?.value || '').split(',').map(s => s.trim()).filter(Boolean)
      },
      suggestedReviewers: $('#m-rev', view)?.value || '',
      imagesCheckId: $('#m-img', view)?.value || null
    };
    if (doc.edited) {
      body.entries = doc.edited;
      body.bodyText = text ? (doc.pastedBody || '') : doc.bodyText;
    } else if (text) {
      if (kind === 'references') body.referencesText = text;
      else body.text = text;
    } else if (doc.structured) {
      body.entries = doc.structured;
    } else {
      body.referencesText = doc.referencesText;
      body.bodyText = doc.bodyText;
    }
    if (kind === 'manuscript' && !body.meta.authors.length) {
      if (!confirm('No authors entered — self-citation and the author checks of Paper Mill Detection cannot run. Continue anyway?')) return;
    }
    const btn = $('#run', view);
    btn.disabled = true;
    $('#form-area', view).hidden = true;
    try {
      const { jobId } = await api('/api/checks', { body });
      const result = await runJob(jobId, $('#progress', view), `Running ${m.title}`);
      renderReport($('#result', view), result, { kind });
      toast(result.queuedForOnline ? `Check complete — ${result.queuedForOnline} reference(s) will be verified automatically when you are back online` : 'Check complete');
    } catch (e) {
      toast(e.message, 'error');
      $('#form-area', view).hidden = false;
    } finally {
      btn.disabled = false;
    }
  };
}

/** Editable list of the detected references: correct the text, split one entry in two at the cursor, merge with the previous, delete or add */
function openReferenceEditor(initial, onApply) {
  const items = initial.map(s => String(s));
  modal(`<div class="card-head"><h2>Detected references <span class="muted" id="re-count"></span></h2><button class="btn btn-ghost btn-sm" data-close>✕</button></div>
    <p class="muted">Check how the list was split. Put the cursor inside an entry and press <b>Split here</b> if two references were joined; use <b>Merge up</b> if one reference was cut in two.</p>
    <div id="re-list" style="max-height:55vh;overflow:auto;display:grid;gap:8px"></div>
    <div class="row" style="margin-top:12px"><button class="btn" id="re-add">+ Add an entry</button><span style="flex:1"></span><button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="re-ok">Use this list</button></div>`, {
    onMount: (el, close) => {
      const list = el.querySelector('#re-list');
      const sync = () => { el.querySelector('#re-count').textContent = `(${items.filter(s => s.trim()).length})`; };
      const paint = () => {
        list.innerHTML = '';
        items.forEach((text, i) => {
          const row = document.createElement('div');
          row.style.cssText = 'display:grid;grid-template-columns:34px 1fr;gap:8px;align-items:start';
          row.innerHTML = `<div class="muted" style="text-align:right;padding-top:6px">${i + 1}</div><div><textarea class="mono" rows="2" style="width:100%"></textarea>
            <div class="row" style="gap:6px;margin-top:2px"><button class="btn btn-sm" data-a="split">Split here</button>${i ? '<button class="btn btn-sm" data-a="merge">Merge up</button>' : ''}<button class="btn btn-sm" data-a="del">Delete</button></div></div>`;
          const ta = row.querySelector('textarea');
          ta.value = text;
          ta.oninput = () => { items[i] = ta.value; sync(); };
          row.querySelector('[data-a=split]').onclick = () => {
            const at = ta.selectionStart;
            if (!at || at >= ta.value.length) return toast('Click inside the entry, at the place where the second reference starts.', 'error');
            items.splice(i, 1, ta.value.slice(0, at).trim(), ta.value.slice(at).trim());
            paint();
          };
          const merge = row.querySelector('[data-a=merge]');
          if (merge) merge.onclick = () => { items.splice(i - 1, 2, `${items[i - 1].trim()} ${items[i].trim()}`); paint(); };
          row.querySelector('[data-a=del]').onclick = () => { items.splice(i, 1); paint(); };
          list.appendChild(row);
        });
        sync();
      };
      paint();
      el.querySelector('#re-add').onclick = () => { items.push(''); paint(); list.lastChild?.querySelector('textarea').focus(); };
      el.querySelector('#re-ok').onclick = () => {
        const out = items.map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length > 5);
        if (!out.length) return toast('The list is empty.', 'error');
        onApply(out);
        close();
      };
    }
  });
}
