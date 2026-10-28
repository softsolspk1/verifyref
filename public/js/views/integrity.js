// views/integrity.js - Integrity Screening (editor only): one upload checked for text similarity, AI-written content,
// research data integrity, pharmaceutical validation, research ethics, authors & affiliations and submission-network
// patterns, combined with Module 4 / 5 / 1 findings into one explained risk score.
import { api, esc, $, $$, toast, runJob, badge, download, fmtDate, ICONS, hasModule } from '../core.js';
import { decisionCard } from './decision.js';
import { riskBanner, explanationCard, signalList, openCase } from './integrityCommon.js';

const ABOUT = {
  similarity: 'Sentence-level overlap with every earlier submission screened here, repeated text, paraphrasing-tool traces, and published papers with the same subject (OpenAlex): duplicate publication, salami slicing, copied abstracts.',
  ai: 'Definite chatbot leftovers, and writing patterns typical of AI tools: favoured vocabulary, uniform sentence length, stacked transitions. Patterns are indicators only.',
  data: 'p-values recalculated, percentages from counts, GRIM test, identical mean ± SD values, repeated SDs, duplicated table rows, terminal digits, primers, cell lines.',
  pharma: 'Doses (OECD limits, abstract vs methods), administration volumes, CAS check digits, formula vs molecular weight, group sizes, species, impossible percentages, PubChem and FDA Orange Book.',
  ethics: 'Ethics approval and number, informed consent, Helsinki / animal-welfare guideline, trial registration in 16 registries (ClinicalTrials.gov verified), declarations.',
  authors: 'ORCID check digit, registration and owner name; CRediT contributions naming every author; affiliations in the Research Organization Registry; e-mail domains.',
  network: 'Across all submissions: shared e-mail addresses, reviewer rings, prolific authors with changing teams, templated titles, citation rings.',
  papermill: 'Module 4 signals not covered above: fabricated or mill-retracted references, author retractions, templates, SCIgen text, predatory journals.',
  images: 'Module 5 Image Integrity report for this manuscript ID.',
  references: 'Module 1 reference verification for this manuscript ID.'
};

export function renderIntegrity(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Integrity Screening</h1>
      <p>One upload checks plagiarism and text similarity, AI-written content, research data, pharmaceutical details, research ethics, authors and affiliations, and paper-mill patterns across submissions — then combines them with the Paper Mill, Image Integrity and Bibliography reports for the same manuscript ID into one risk score with a transparent explanation.</p></div></div>
    <div class="alert alert-warn">Screening aid only — it never rejects a paper by itself. The manuscript text stays on this server; only titles, abstracts, names and identifiers are looked up in public registries.</div>
    <div id="form-area">
      <div class="card">
        <div class="dropzone" id="dz">
          <input type="file" id="file" accept=".docx,.doc,.pdf,.txt,.odt,.rtf" hidden>
          <div><strong>Upload the full manuscript</strong> (title page, text, declarations and references) — drag &amp; drop or click</div>
          <div class="muted" style="margin-top:4px">Word (.docx) or PDF</div>
        </div>
        <div id="file-info" class="alert alert-info" hidden style="margin-top:12px"></div>
        <div class="field" style="margin-top:12px"><label for="paste">Or paste the complete manuscript text</label><textarea id="paste" rows="6" class="mono"></textarea></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Manuscript details</h2><span class="muted">Detected from the file when left empty</span></div>
        <div class="grid grid-2">
          <div class="field"><label for="m-code">Manuscript ID</label><input id="m-code" type="text" placeholder="e.g. PJPS-2026-0412"><div class="hint">Links the Paper Mill, Image Integrity and Bibliography reports with the same ID into the score.</div></div>
          <div class="field"><label for="m-title">Title</label><input id="m-title" type="text"></div>
        </div>
        <div class="grid grid-2">
          <div class="field"><label for="m-authors">Authors (one per line)</label><textarea id="m-authors" rows="4"></textarea></div>
          <div class="field"><label for="m-aff">Affiliations (one per line)</label><textarea id="m-aff" rows="4"></textarea></div>
        </div>
        <div class="grid grid-2">
          <div class="field"><label for="m-rev">Suggested reviewers <span class="muted">(names and e-mails)</span></label><textarea id="m-rev" rows="3"></textarea></div>
          <div class="field"><label for="m-img">Image Integrity report <span class="muted">(optional)</span></label><select id="m-img"><option value="">— latest for this manuscript ID —</option></select>
            <label class="check" style="margin-top:12px"><input type="checkbox" id="m-deep"> Verify every reference online (slower; adds Module 1 evidence)</label>
            <label class="check"><input type="checkbox" id="m-ext" checked> Look up public registries (ORCID, ROR, ClinicalTrials.gov, PubChem, OpenAlex)</label></div>
        </div>
        <div class="row"><button class="btn btn-primary" id="run">Run Integrity Screening</button></div>
      </div>
    </div>
    <div id="progress"></div>
    <div id="result"></div>`;

  let file = null;
  const info = $('#file-info', view), input = $('#file', view), zone = $('#dz', view);
  const take = f => { file = f; info.hidden = false; info.textContent = f.name; const code = (f.name.match(/PJPS[-_\s]?\d{4}[-_\s]?\d{2,5}/i) || [])[0]; if (code && !$('#m-code', view).value) $('#m-code', view).value = code.toUpperCase().replace(/[_\s]/g, '-'); };
  zone.onclick = () => input.click();
  zone.ondragover = e => { e.preventDefault(); zone.classList.add('over'); };
  zone.ondragleave = () => zone.classList.remove('over');
  zone.ondrop = e => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files[0]) take(e.dataTransfer.files[0]); };
  input.onchange = () => { if (input.files[0]) take(input.files[0]); input.value = ''; };
  if (hasModule('images')) api('/api/checks?kind=images').then(d => { $('#m-img', view).innerHTML += d.checks.slice(0, 50).map(c => `<option value="${c.id}">${esc(c.manuscript_code || '')} ${esc(c.title || '')} · ${fmtDate(c.created_at)}</option>`).join(''); }).catch(() => {});

  $('#run', view).onclick = async () => {
    const text = $('#paste', view).value.trim();
    if (!file && text.length < 300) return toast('Upload the manuscript or paste its full text.', 'error');
    const fd = new FormData();
    if (file) fd.append('file', file); else fd.append('text', text);
    for (const [k, id] of [['manuscriptCode', 'm-code'], ['title', 'm-title'], ['authors', 'm-authors'], ['affiliations', 'm-aff'], ['suggestedReviewers', 'm-rev'], ['imagesCheckId', 'm-img']]) fd.append(k, $(`#${id}`, view).value);
    fd.append('deep', $('#m-deep', view).checked ? 'true' : 'false');
    fd.append('external', $('#m-ext', view).checked ? 'true' : 'false');
    $('#form-area', view).hidden = true;
    try {
      const { jobId } = await api('/api/integrity', { form: fd });
      const result = await runJob(jobId, $('#progress', view), 'Integrity Screening');
      renderIntegrityResult($('#result', view), result);
    } catch (e) {
      toast(e.message, 'error');
      $('#form-area', view).hidden = false;
    }
  };
}

export function renderIntegrityResult(el, r) {
  const dims = r.dimensions || [];
  const scoreOf = key => r.risk.dimensions.find(d => d.key === key) || { points: 0 };
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(r.meta?.title || 'Integrity Screening')}</h1>
        <p>${r.meta?.manuscriptCode ? `<b>${esc(r.meta.manuscriptCode)}</b> · ` : ''}${fmtDate(r.createdAt)} · <span class="badge b-bad">Confidential — editor only</span></p></div>
      <div class="row no-print">${r.id ? `<button class="btn btn-sm" id="x-docx">${ICONS.download} Report (Word)</button><button class="btn btn-sm" id="x-pdf">${ICONS.download} PDF</button>${hasModule('cases') ? '<button class="btn btn-sm btn-primary" id="x-case">Open integrity case</button>' : ''}` : ''}<button class="btn btn-sm" onclick="window.print()">${ICONS.print} Print</button></div>
    </div>
    ${riskBanner(r.risk, 'Integrity risk', r.disclaimer)}
    <div class="dim-grid">${dims.map((d, i) => { const s = scoreOf(d.key); const cap = s.points ? Math.min(100, s.points * 10) : 0; return `<button class="dim ${d.signals.some(x => x.severity === 'high') ? 'hot' : d.signals.length ? '' : 'clear'} ${i === 0 ? 'active' : ''}" data-i="${i}">
      <div class="dim-name">${esc(d.label)}</div><div class="dim-meta">${d.checked === false && !d.signals.length ? 'not enough material' : `${d.signals.length} signal(s) · ${s.points} pts`}${d.source?.checkId ? ' · linked report' : ''}</div><div class="dim-bar"><span style="width:${d.signals.length ? Math.max(6, cap) : 100}%"></span></div></button>`; }).join('')}</div>
    <div class="card" id="dim-card"></div>
    ${explanationCard(r.risk)}
    <div class="card"><h3>Linked reports</h3><ul class="checked">
      <li>${r.linked?.papermill ? `✓ Paper Mill Detection — ${esc(r.linked.papermill.level || '')}${r.linked.papermill.checkId ? ` · <a href="#/check/${r.linked.papermill.checkId}">open</a>` : ' (run as part of this screening)'}` : '— Paper Mill Detection'}</li>
      <li>${r.linked?.images ? `✓ Image Integrity — ${esc(r.linked.images.level || '')} · <a href="#/check/${r.linked.images.checkId}">open</a>` : '— Image Integrity: no report for this manuscript ID (run Module 5 to include figures)'}</li>
      <li>${r.linked?.references ? `✓ Reference verification — ${r.linked.references.summary.total} references${r.linked.references.checkId ? ` · <a href="#/check/${r.linked.references.checkId}">open</a>` : ''}` : '— Reference verification: not run (tick “Verify every reference online”, or run Module 1 / the Full Screening Report)'}</li>
    </ul></div>
    <div id="decision" class="no-print"></div>`;

  const show = i => {
    const d = dims[i];
    $$('.dim', el).forEach(b => b.classList.toggle('active', +b.dataset.i === i));
    $('#dim-card', el).innerHTML = `<div class="card-head"><h3>${esc(d.label)}</h3>${d.source?.checkId ? `<a href="#/check/${d.source.checkId}">open the full report →</a>` : badge(d.signals.length ? `${d.signals.length} signal(s)` : 'None', d.signals.length ? 'warn' : 'good')}</div>
      <p class="muted">${esc(ABOUT[d.key] || '')}</p>${signalList(d.signals)}${detailsOf(d)}`;
  };
  $$('.dim', el).forEach(b => { b.onclick = () => show(+b.dataset.i); });
  if (dims.length) show(0);
  if (r.id) {
    $('#x-docx', el).onclick = () => download(`/api/checks/${r.id}/integrity-report`).catch(e => toast(e.message, 'error'));
    $('#x-pdf', el).onclick = () => download(`/api/checks/${r.id}/integrity-report?format=pdf`).catch(e => toast(e.message, 'error'));
    const c = $('#x-case', el);
    if (c) c.onclick = () => openCase(r.id);
  }
  decisionCard($('#decision', el), r, 'integrity');
}

/** What was measured, per dimension (so a clean result is visibly a checked result) */
function detailsOf(d) {
  const x = d.details || {};
  const li = items => `<details style="margin-top:10px"><summary class="muted">What was checked</summary><ul class="checked">${items.filter(Boolean).map(i => `<li>${i}</li>`).join('')}</ul></details>`;
  if (d.key === 'similarity') return li([`${x.sentences || 0} sentences compared with ${x.archive?.compared || 0} earlier submission(s)`, `${(x.paraphrase || []).length} tortured phrase(s)`, x.published?.checked ? `${x.published.compared} published paper(s) on the same subject compared (OpenAlex)` : 'Published papers: not checked (registry lookups off or unavailable)', esc(x.fullTextLiterature || '')]);
  if (d.key === 'ai') return li([`AI-writing indicator: <b>${x.score ?? 0}/100</b>`, `LLM-favoured vocabulary: ${x.vocabulary?.per1000 ?? 0} per 1,000 words (${x.vocabulary?.count ?? 0} in ${x.vocabulary?.words ?? 0} words)`, `Sentence-length variation: ${x.rhythm?.cv ?? '—'} over ${x.rhythm?.sentences ?? 0} sentences`, `Sentences opening with a stock transition: ${Math.round((x.rhythm?.openerShare || 0) * 100)}%`, `Lexical diversity (MATTR): ${x.lexicalDiversity ?? '—'}`, (x.bySection || []).length ? `By section: ${x.bySection.map(s => `${esc(s.section)} ${s.per1000}`).join(' · ')}` : '']);
  if (d.key === 'data') return li([`${(x.statistics?.checked?.pTests || 0)} test statistics and ${(x.statistics?.checked?.percentages || 0)} percentages recalculated`, `${x.grim?.tested || 0} means GRIM-tested (${x.grim?.inconsistent || 0} inconsistent)`, `${x.meanSdPairs || 0} mean ± SD values compared`, x.terminalDigits?.tested ? `Terminal digits of ${x.terminalDigits.n} values: χ² = ${x.terminalDigits.chi}` : `Terminal digits: too few values (${x.terminalDigits?.n || 0})`, `${x.primers || 0} primer sequence(s)`]);
  if (d.key === 'pharma') return li([`${(x.doses || []).length} dose(s): ${(x.doses || []).slice(0, 8).map(z => esc(z.raw)).join(', ') || '—'}`, `${(x.groups || []).length} group-size statement(s) checked`, `${(x.formulaClaims || []).length} formula / molecular-weight pair(s)`, `${(x.cas || []).length} CAS number(s)`, `${(x.fdaApplications || []).length} FDA application number(s)`, x.online ? `${(x.pubchem || []).length} PubChem lookup(s)` : 'PubChem: not looked up']);
  if (d.key === 'ethics') { const s = x.studyType || {}; return li([`Study type: ${[s.human && 'human', s.animal && 'animal', s.trial && 'clinical trial', s.inVitroOnly && 'in vitro only'].filter(Boolean).join(', ') || 'not determined'}`, `Ethics approval: ${x.approval ? '✓' : '—'}${x.approvalNo ? ' with number' : ''} · consent: ${x.consent ? '✓' : '—'} · Helsinki: ${x.helsinki ? '✓' : '—'} · animal guideline: ${x.animalGuide ? '✓' : '—'}`, `Registrations: ${(x.registrations || []).map(r => `${esc(r.id)} (${esc(r.registry)})`).join(', ') || 'none'}`, (x.trials || []).length ? `ClinicalTrials.gov: ${x.trials.map(t => `${esc(t.id)} ${t.exists === false ? 'not found' : t.exists ? `${esc(t.status)}, registered ${esc(t.submitted || '?')}` : 'error'}`).join('; ')}` : '', `Declarations: ${Object.entries(x.declarations || {}).map(([k, v]) => `${k} ${v ? '✓' : '—'}`).join(' · ')}`]); }
  if (d.key === 'authors') return li([`${(x.authors || []).length} author(s) · ${(x.orcids || []).length} ORCID iD(s)${(x.orcids || []).length ? ': ' + x.orcids.map(o => `${esc(o.id)}${o.name ? ` (${esc(o.name)})` : ''}`).join(', ') : ''}`, `Contributions statement: ${x.contributions?.found ? `✓${x.contributions.credit ? ' CRediT roles' : ''}` : '—'}`, x.online ? `ROR: ${(x.ror || []).map(r => `${esc(r.affiliation.slice(0, 50))} → ${r.matched ? esc(r.name) : 'no match'}`).join('; ') || 'no affiliations'}` : 'ROR: not looked up']);
  if (d.key === 'network') return li([`Compared with ${x.compared || 0} submission(s), ${x.otherTeams || 0} by other author teams`, `${(x.emails || []).length} e-mail address(es), ${(x.reviewerEmails || []).length} suggested-reviewer address(es), ${x.citedDois || 0} cited DOI(s)`]);
  return '';
}
