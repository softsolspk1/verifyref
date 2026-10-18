// views/check.js - input forms for Full manuscript check, Reference Check and Citation Check
import { api, esc, $, toast, runJob, dropzone, issueOptions } from '../core.js';
import { renderReport } from './report.js';

const MODES = {
  manuscript: {
    title: 'Full manuscript check',
    intro: 'Upload the manuscript. Every reference is checked against 12 academic databases, in-text citations are matched with the reference list, cited journals are checked for indexing and predatory status, and the citation pattern (self-citation, author and journal piles) is analysed.',
    needsBody: true, meta: true
  },
  references: {
    title: 'Reference Check',
    intro: 'Checks every reference against 12 academic databases — Crossref, the DOI registry, DataCite, OpenAlex, PubMed, Europe PMC, Semantic Scholar, arXiv, DBLP, Open Library, Google Books and ERIC — and flags fabricated, retracted or miscited works. Cited journals are checked too.',
    needsBody: false, meta: false
  },
  citations: {
    title: 'Citation Check',
    intro: 'Matches in-text citations with the reference list and shows citations missing from the list, references never cited, ambiguous author–year citations and numbering-order problems. Works with numbered (Vancouver) and author–year (APA/Harvard) styles.',
    needsBody: true, meta: false
  }
};

export function renderCheckForm(view, kind) {
  const m = MODES[kind];
  const doc = { referencesText: '', bodyText: '', structured: null, filename: '' };

  view.innerHTML = `
    <div class="page-head"><div><h1>${esc(m.title)}</h1><p>${esc(m.intro)}</p></div></div>
    <div id="form-area">
      <div class="card">
        <div class="dropzone" id="dz">
          <input type="file" id="file" accept=".pdf,.docx,.txt,.bib,.ris,.rtf,.odt" hidden>
          <div><strong>Upload ${m.needsBody ? 'the manuscript' : 'a manuscript or reference file'}</strong> — drag &amp; drop or click</div>
          <div class="muted" style="margin-top:4px">Word (.docx), PDF, plain text${m.needsBody ? '' : ', BibTeX (.bib) or RIS (.ris)'} · up to 25 MB</div>
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
      </div>`}

      <div class="card">
        <div class="grid grid-2">
          <div class="field"><label for="issue">Add to issue</label><select id="issue">${issueOptions()}</select><div class="hint">Manuscripts in an issue appear in the Issue report.</div></div>
          <div class="field"><label>Saving</label>
            <label class="check"><input type="radio" name="save" value="full" checked> Save the full report (needed for letters and revision comparison)</label>
            <label class="check"><input type="radio" name="save" value="counts"> Save counts only — no manuscript content is stored</label>
          </div>
        </div>
        <div class="row">
          <button class="btn btn-primary" id="run">Run ${esc(m.title)}</button>
          <button class="btn btn-ghost" id="clear">Clear</button>
          <span class="muted" id="ref-count"></span>
        </div>
      </div>
    </div>
    <div id="progress"></div>
    <div id="result"></div>`;

  const paste = $('#paste', view);
  const info = $('#file-info', view);

  dropzone($('#dz', view), $('#file', view), async file => {
    info.hidden = false;
    info.className = 'alert alert-info';
    info.textContent = `Reading ${file.name}…`;
    try {
      const fd = new FormData();
      fd.append('file', file);
      const d = await api('/api/extract', { form: fd });
      Object.assign(doc, { referencesText: d.referencesText, bodyText: d.bodyText, structured: d.structured || null, filename: d.filename });
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

  paste.addEventListener('input', () => { if (paste.value.trim()) Object.assign(doc, { referencesText: '', bodyText: '', structured: null, filename: '' }); });

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
      }
    };
    if (text) {
      if (kind === 'references') body.referencesText = text;
      else body.text = text;
    } else if (doc.structured) {
      body.entries = doc.structured;
    } else {
      body.referencesText = doc.referencesText;
      body.bodyText = doc.bodyText;
    }
    if (kind === 'manuscript' && !body.meta.authors.length) {
      if (!confirm('No authors entered — self-citation cannot be analysed. Continue anyway?')) return;
    }
    const btn = $('#run', view);
    btn.disabled = true;
    $('#form-area', view).hidden = true;
    try {
      const { jobId } = await api('/api/checks', { body });
      const result = await runJob(jobId, $('#progress', view), `Running ${m.title}`);
      renderReport($('#result', view), result, { kind });
      toast('Check complete');
    } catch (e) {
      toast(e.message, 'error');
      $('#form-area', view).hidden = false;
    } finally {
      btn.disabled = false;
    }
  };
}
