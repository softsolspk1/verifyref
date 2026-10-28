// views/imageDatabases.js - Super Admin: the Module 5 image reference databases (published PJPS papers, papers retracted
// for image problems, PubMed Central open access, reference figures) and the datasets kept on Cloudflare R2.
import { api, esc, $, $$, badge, toast, fmtDate, runJob, modal } from '../core.js';

const mb = n => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const STATUS = { done: ['indexed', 'good'], 'no-figures': ['no figures', 'neutral'], missing: ['no article', 'neutral'], error: ['error', 'bad'] };

export async function renderImageDatabases(el, { desk = false } = {}) {
  el.innerHTML = '<div class="card-head"><h2>Image integrity databases</h2><span class="muted">Module 5</span></div><div class="muted">Loading…</div>';
  let st;
  try { st = await api('/api/admin/image-databases'); } catch (e) { el.innerHTML = ''; return; }
  const s = st.bySource;
  const row = (key, extra) => `<tr><td><b>${esc(s[key].name)}</b>${extra ? `<div class="muted">${extra}</div>` : ''}</td><td class="num">${s[key].papers.toLocaleString()}</td><td class="num">${s[key].figures.toLocaleString()}</td><td class="num">${s[key].panels.toLocaleString()}</td><td>${s[key].updated ? fmtDate(s[key].updated) : badge('empty', 'warn')}${s[key].errors ? `<div class="muted">${s[key].errors} failed</div>` : ''}</td></tr>`;
  el.innerHTML = `<div class="card-head"><div><h2>Image integrity databases</h2><p class="muted" style="margin:4px 0 0">Every figure panel of these papers is fingerprinted (in 8 orientations and as crops) with its chart data; each new manuscript in Module 5 is compared with all of them, and every match is verified pixel by pixel. Thumbnails: ${esc(st.thumbnails)}.</p></div></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Database</th><th class="num">Papers</th><th class="num">Figures</th><th class="num">Panels</th><th>Updated</th></tr></thead><tbody>
      ${row('pjps', `Article PDFs from pjps.pk; new articles are added every day${st.newestPjpsId ? ` (newest indexed: article ${st.newestPjpsId})` : ''}`)}
      ${row('retracted', 'Retraction Watch notices naming image problems, open-access figures from PubMed Central')}
      ${row('pmc', 'Newest first; each run continues where the previous one stopped')}
      ${row('rsiid', 'Pristine figures and figure templates of the RSIID benchmark (Zenodo)')}
      ${row('biofors', 'Panels of 1,031 papers; panels the experts marked as duplicated or spliced are labelled')}
      ${row('binder', 'Near-duplicate patches; the archive must be downloaded by hand (Dataverse guestbook)')}
      ${row('reference', 'Uploaded below: PJPS archive PDFs, known problem figures, figures from other investigations')}
    </tbody></table></div>
    ${desk ? '' : `<div class="grid grid-2" style="margin-top:12px">
      <div class="field"><label>Published PJPS papers</label>
        <div class="row" style="flex-wrap:wrap">Articles <input id="pj-from" type="number" min="1" placeholder="from" style="width:90px"> to <input id="pj-to" type="number" min="1" placeholder="latest" style="width:90px"> at most <input id="pj-limit" type="number" min="1" max="2000" value="100" style="width:80px"></div>
        <div class="hint">Empty “from”: the articles newer than the newest one indexed. Already indexed articles are skipped. The whole archive (about 8,000 articles) is best indexed with <code>npm run images:index -- --source pjps --from 1</code> on a computer.</div>
        <button class="btn btn-sm" id="pj-run" style="margin-top:6px">Index PJPS articles</button></div>
      <div class="field"><label>Other open-access figures</label>
        <div class="row" style="flex-wrap:wrap">Papers per run <input id="oa-limit" type="number" min="1" max="2000" value="100" style="width:80px"></div>
        <div class="hint">Retracted / corrected papers: strongest cases (duplication, manipulation, fabrication) first. PubMed Central: pharmacy, pharmacology and medicinal-plant papers, newest first.</div>
        <div class="row" style="margin-top:6px"><button class="btn btn-sm" id="rt-run">Index retracted papers</button><button class="btn btn-sm" id="pmc-run">Index PubMed Central papers</button></div>
        <div class="hint" style="margin-top:8px">Research datasets in the data folder (read from the archives on the server that holds them):</div>
        <div class="row" style="margin-top:4px"><button class="btn btn-sm" data-ds="rsiid">Index RSIID</button><button class="btn btn-sm" data-ds="biofors">Index BioFors</button><button class="btn btn-sm" data-ds="binder">Index BINDER</button></div></div>
    </div>
    <form id="ref-form" class="card" style="margin:12px 0 0;background:var(--bg-soft, transparent)">
      <h3 style="margin-top:0">Add reference figures</h3>
      <div class="grid grid-2">
        <div class="field"><label>Files (PDF, Word, PNG, JPEG, TIFF, WebP)</label><input type="file" name="files" multiple accept=".pdf,.docx,.png,.jpg,.jpeg,.tif,.tiff,.webp" required></div>
        <div class="field"><label>Title</label><input name="title" type="text" placeholder="Paper or case title"></div>
        <div class="field"><label>DOI <span class="muted">(optional)</span></label><input name="doi" type="text"></div>
        <div class="field"><label>Note <span class="muted">(optional, shown with every match)</span></label><input name="note" type="text" placeholder="e.g. Retracted 2024 for image duplication"></div>
      </div>
      <button class="btn btn-sm btn-primary" type="submit">Add to the reference library</button>
    </form>`}
    <div id="imgdb-progress"></div>
    <h3 style="margin:16px 0 6px">Indexed papers</h3>
    <div class="row" style="flex-wrap:wrap"><select id="db-src"><option value="">All databases</option>${Object.entries(st.sources).map(([k, v]) => `<option value="${k}">${esc(v.short)}</option>`).join('')}</select>
      <select id="db-status"><option value="">Any status</option><option value="done">Indexed</option><option value="no-figures">No figures</option><option value="missing">No article</option><option value="error">Error</option></select>
      <input id="db-q" type="text" placeholder="Title, DOI, article number or PMCID" style="flex:1;min-width:200px"><button class="btn btn-sm" id="db-go">Search</button></div>
    <div id="db-list" style="margin-top:8px"></div>`;

  const prog = $('#imgdb-progress', el);
  const job = async (url, body, title) => {
    try {
      const { jobId } = await api(url, { body });
      const r = await runJob(jobId, prog, title);
      const n = r.articles ?? r.papers ?? r.figures ?? r.patches ?? 0;
      toast(`${n} paper(s) indexed, ${r.panels} panel(s)${r.errors?.length ? `, ${r.errors.length} failed` : ''}${r.stoppedEarly ? ' — time limit reached, run again to continue' : ''}`);
      renderImageDatabases(el, { desk });
    } catch (e) { toast(e.message, 'error'); }
  };
  if (!desk) {
    $('#pj-run', el).onclick = () => job('/api/admin/image-databases/pjps', { from: $('#pj-from', el).value, to: $('#pj-to', el).value, limit: $('#pj-limit', el).value }, 'Indexing published PJPS papers');
    $('#rt-run', el).onclick = () => job('/api/admin/image-databases/retracted', { limit: $('#oa-limit', el).value }, 'Indexing papers retracted for image problems');
    $('#pmc-run', el).onclick = () => job('/api/admin/image-databases/pmc', { limit: $('#oa-limit', el).value }, 'Indexing PubMed Central open-access papers');
    $$('[data-ds]', el).forEach(b => (b.onclick = () => job(`/api/admin/image-databases/dataset/${b.dataset.ds}`, {}, `Indexing ${st.sources[b.dataset.ds].short}`)));
    $('#ref-form', el).onsubmit = async e => {
      e.preventDefault();
      const btn = $('button[type=submit]', e.target);
      btn.disabled = true;
      try {
        const r = await api('/api/admin/image-databases/upload', { form: new FormData(e.target) });
        toast(`${r.figures} figure(s), ${r.panels} panel(s) added${r.skipped.length ? ` · ${r.skipped.length} file(s) skipped` : ''}`);
        renderImageDatabases(el, { desk });
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    };
  }

  let page = 1;
  const load = async () => {
    const q = new URLSearchParams({ source: $('#db-src', el).value, status: $('#db-status', el).value, q: $('#db-q', el).value, page });
    const r = await api(`/api/admin/image-databases/docs?${q}`);
    $('#db-list', el).innerHTML = r.total ? `<div class="muted">${r.total.toLocaleString()} paper(s)</div><div class="table-wrap"><table class="t"><thead><tr><th>Paper</th><th>Database</th><th class="num">Figures / panels</th><th>Status</th><th></th></tr></thead><tbody>
      ${r.docs.map(d => `<tr><td>${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title || d.source_key)}</a>` : esc(d.title || d.source_key)}<div class="muted">${esc([d.journal, d.year, d.doi].filter(Boolean).join(' · '))}${d.note ? ` · ${esc(d.note)}` : ''}</div></td>
        <td>${esc(st.sources[d.source]?.short || d.source)}<div class="muted">${esc(d.source_key)}</div></td><td class="num">${d.figures} / ${d.panels}</td>
        <td>${badge(...(STATUS[d.status] || [d.status, 'neutral']))}${d.error ? `<div class="muted">${esc(d.error)}</div>` : ''}<div class="muted">${fmtDate(d.indexed_at)}</div></td>
        <td class="row" style="flex-wrap:nowrap">${d.panels ? `<button class="btn btn-sm" data-panels="${d.id}">Panels</button>` : ''}${desk ? '' : `<button class="btn btn-sm btn-ghost btn-danger" data-del="${d.id}" title="Remove from the database">✕</button>`}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="row"><button class="btn btn-sm" id="db-prev" ${page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn btn-sm" id="db-next" ${page * r.per >= r.total ? 'disabled' : ''}>Next</button></div>` : '<div class="muted">No papers.</div>';
    $('#db-prev', el) && ($('#db-prev', el).onclick = () => { page--; load(); });
    $('#db-next', el) && ($('#db-next', el).onclick = () => { page++; load(); });
    $$('[data-panels]', el).forEach(b => (b.onclick = async () => {
      const d = r.docs.find(x => String(x.id) === b.dataset.panels);
      const { panels } = await api(`/api/admin/image-databases/docs/${d.id}/panels`);
      modal(`<div class="card-head"><h2>${esc(d.title || d.source_key)}</h2><button class="btn btn-sm btn-ghost" data-close>✕</button></div>
        <div class="panel-grid">${panels.map(p => `<figure class="panel-cell">${p.has_thumb ? `<img src="/api/images/refs/${p.id}/thumb" alt="" loading="lazy">` : '<div class="muted">no thumbnail</div>'}<figcaption>${esc(p.panel || p.figure)}<br><span class="muted">${esc(p.type || '')} · ${p.w} × ${p.h}</span></figcaption></figure>`).join('')}</div>`);
    }));
    $$('[data-del]', el).forEach(b => (b.onclick = async () => {
      if (!confirm('Remove this paper and its figures from the image database?')) return;
      try { await api(`/api/admin/image-databases/docs/${b.dataset.del}`, { method: 'DELETE' }); toast('Removed'); load(); } catch (e) { toast(e.message, 'error'); }
    }));
  };
  $('#db-go', el).onclick = () => { page = 1; load(); };
  $('#db-q', el).onkeydown = e => { if (e.key === 'Enter') { page = 1; load(); } };
  $('#db-src', el).onchange = $('#db-status', el).onchange = () => { page = 1; load(); };
  load().catch(e => toast(e.message, 'error'));
}

export async function renderStorage(el, { desk = false } = {}) {
  let st;
  try { st = await api('/api/admin/storage'); } catch (e) { el.innerHTML = ''; return; }
  const AREA = { files: 'Data folder (journal lists, image knowledge base, public image data, ICLAC, benchmarks)', raw: 'Last good download of each refreshable dataset (used when the source is down)', lists: 'Journal index lists uploaded on this page' };
  el.innerHTML = `<div class="card-head"><div><h2>Dataset storage — Cloudflare R2</h2><p class="muted" style="margin:4px 0 0">${st.enabled ? `Bucket <b>${esc(st.bucket)}</b>: ${st.files.toLocaleString()} file(s), ${mb(st.bytes)}${st.updated ? `, last change ${fmtDate(st.updated)}` : ''}. The web platform reads its data files from here, and every dataset refresh saves its download here first.` : 'Cloudflare R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET): datasets are kept only in the database and the local data folder.'}</p></div>
    ${st.enabled && !desk ? '<button class="btn btn-sm" id="r2-sync">Copy data folder to R2</button>' : ''}</div>
    ${st.groups.length ? `<div class="table-wrap"><table class="t"><thead><tr><th>Area</th><th class="num">Files</th><th class="num">Size</th><th>Updated</th></tr></thead><tbody>${st.groups.map(g => `<tr><td><b>${esc(g.area)}/</b><div class="muted">${esc(AREA[g.area] || '')}</div></td><td class="num">${g.files}</td><td class="num">${mb(g.bytes)}</td><td>${fmtDate(g.updated)}</td></tr>`).join('')}</tbody></table></div>
    <details style="margin-top:8px"><summary>All ${st.files} files</summary><div class="table-wrap"><table class="t"><thead><tr><th>File</th><th class="num">Size</th><th>Updated</th><th>Source</th></tr></thead><tbody>
      ${st.list.map(f => `<tr><td><a href="/api/admin/storage/file?name=${encodeURIComponent(f.name)}" target="_blank" rel="noopener" class="mono">${esc(f.name)}</a></td><td class="num">${mb(Number(f.size))}</td><td>${fmtDate(f.updated_at)}</td><td class="muted">${esc(f.source || '')}</td></tr>`).join('')}
    </tbody></table></div></details>` : (st.enabled ? '<p class="muted">Nothing stored yet. Run <code>npm run datasets:push</code> on the computer that holds the data folder, or refresh the datasets.</p>' : '')}
    <div id="r2-progress"></div>`;
  const sync = $('#r2-sync', el);
  if (sync) sync.onclick = async () => {
    sync.disabled = true;
    try {
      const { jobId } = await api('/api/admin/storage/sync', { body: {} });
      const r = await runJob(jobId, $('#r2-progress', el), 'Copying the data folder to Cloudflare R2');
      toast(r.note || `${r.stored} file(s) stored, ${r.unchanged} unchanged${r.errors.length ? `, ${r.errors.length} failed` : ''}`);
      renderStorage(el, { desk });
    } catch (e) { toast(e.message, 'error'); sync.disabled = false; }
  };
}
