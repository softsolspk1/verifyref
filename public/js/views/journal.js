// views/journal.js - Journal Check: single journal lookup
import { api, esc, $, badge, sevTone, toast, copyText, ICONS } from '../core.js';

export function renderJournalCheck(view) {
  view.innerHTML = `
    <div class="page-head"><div><h1>Journal Check</h1>
      <p>Scopus and Web of Science indexing, quartiles, HEC HJRS category, MEDLINE and DOAJ status, ISSN registry, retraction history, and predatory or hijacked-journal warnings. Enter an ISSN for a precise match — different journals can share a name.</p></div></div>
    <div class="card">
      <form id="jform" class="grid" style="grid-template-columns:2fr 1fr auto;align-items:end">
        <div class="field" style="margin:0"><label for="j-name">Journal name or abbreviation</label><input id="j-name" type="text" placeholder="e.g. Pak J Pharm Sci"></div>
        <div class="field" style="margin:0"><label for="j-issn">ISSN</label><input id="j-issn" type="text" placeholder="1011-601X"></div>
        <button class="btn btn-primary" type="submit">Check journal</button>
      </form>
    </div>
    <div id="jres"></div>`;
  $('#jform', view).onsubmit = async e => {
    e.preventDefault();
    const name = $('#j-name', view).value.trim(), issn = $('#j-issn', view).value.trim();
    if (!name && !issn) return toast('Enter a journal name or ISSN', 'error');
    const out = $('#jres', view);
    out.innerHTML = '<div class="progress"><h3>Checking journal…</h3><div class="muted">OpenAlex · NLM Catalog · DOAJ · ISSN registry · Wikidata · Retraction Watch · predatory lists · uploaded index lists</div></div>';
    try {
      const { journal } = await api('/api/journal-check', { body: { name, issn } });
      out.innerHTML = journalCard(journal);
      const cp = $('#j-copy', out);
      if (cp) cp.onclick = () => copyText(journalText(journal));
    } catch (err) { out.innerHTML = `<div class="alert alert-bad">${esc(err.message)}</div>`; }
  };
}

const yes = (v, label = 'Yes') => (v === true ? badge(label, 'good') : v === false ? badge('No', 'neutral') : badge('Unknown', 'neutral'));

export function journalCard(j) {
  if (!j.found && !j.flags?.length) return '<div class="alert alert-warn">This journal was not found in OpenAlex, the NLM Catalog or Crossref. Check the spelling or try the ISSN.</div>';
  const ix = j.indexing;
  const verdict = { 'high-risk': ['High risk', 'bad'], caution: ['Use caution', 'warn'], ok: ['No red flags', 'good'] }[j.verdict] || ['Unknown', 'neutral'];
  const oa = j.openalex;
  const maxW = Math.max(1, ...(oa?.worksByYear || []).map(w => w.works));
  return `
    <div class="card">
      <div class="card-head">
        <div><h2>${esc(j.title)}</h2><div class="muted">${esc(j.publisher || '')}${j.country ? ` · ${esc(j.country)}` : ''}${j.issns.length ? ` · ISSN ${esc(j.issns.join(', '))}` : ''}</div></div>
        <div class="row">${badge(verdict[0], verdict[1])}<button class="btn btn-sm" id="j-copy">${ICONS.copy} Copy report</button></div>
      </div>
      ${j.offline ? '<div class="alert alert-info"><b>Offline check.</b> Compared with the local copies of the uploaded journal lists, Beall’s list, hijacked journals and Retraction Watch only. DOAJ, MEDLINE, the ISSN registry and the publication profile need a connection.</div>' : ''}
      ${j.flags.length ? j.flags.map(f => `<div class="flag ${f.severity}"><div class="msg">${esc(f.message)}</div></div>`).join('') : j.offline ? '' : '<div class="alert alert-good">No predatory, hijacked or registry red flags found.</div>'}
      <div class="grid grid-2" style="margin-top:12px">
        <table class="t">
          <tr><th colspan="2">Indexing</th></tr>
          <tr><td>Scopus</td><td>${yes(ix.scopus.indexed, 'Indexed')} ${ix.scopus.quartile ? badge(`SJR ${ix.scopus.quartile}`, 'info') : ''} <div class="muted">${esc(ix.scopus.source || 'Upload the Scopus/SJR list for certainty')}${ix.scopus.sjr ? ` · SJR ${esc(ix.scopus.sjr)}` : ''}${ix.scopus.citeScore ? ` · CiteScore ${esc(ix.scopus.citeScore)}` : ''}</div>${ix.scopus.categories ? `<div class="muted">${esc(String(ix.scopus.categories).slice(0, 200))}</div>` : ''}</td></tr>
          <tr><td>Web of Science</td><td>${ix.wos.collections.length ? ix.wos.collections.map(c => badge(c.index, 'good')).join(' ') : '<span class="muted">Not found in the Web of Science lists loaded</span>'} ${ix.wos.jcrQuartile ? badge(`JCR ${ix.wos.jcrQuartile}`, 'info') : ix.scopus.quartile ? badge(`SJR ${ix.scopus.quartile}`, 'info') : ''}${ix.wos.jif ? ` <span class="muted">JIF ${esc(ix.wos.jif)}</span>` : `<div class="muted">${ix.wos.jcrQuartile ? '' : 'Impact factor and JCR quartile need a JCR subscription (not loaded)'}${!ix.wos.jcrQuartile && ix.scopus.quartile ? '; SJR quartile (Scopus) shown instead' : ''}</div>`}</td></tr>
          <tr><td>HEC HJRS</td><td>${ix.hjrs?.category ? badge(`Category ${ix.hjrs.category}`, 'good') : '<span class="muted">Not in the HEC lists loaded (these cover Pakistani journals only)</span>'}${ix.hjrs?.subject ? ` <span class="muted">${esc(ix.hjrs.subject)}</span>` : ''}</td></tr>
          <tr><td>EBSCO</td><td>${ix.ebsco ? `${badge('Covered', 'good')} ${ix.ebsco.peerReviewed ? badge('Peer reviewed', 'info') : ''}<div class="muted">${[ix.ebsco.database, ix.ebsco.indexStart ? `indexed ${ix.ebsco.indexStart}–${ix.ebsco.indexStop || 'present'}` : '', ix.ebsco.fullTextStart ? `full text ${ix.ebsco.fullTextStart}–${ix.ebsco.fullTextStop || 'present'}` : '', ix.ebsco.embargoMonths && +ix.ebsco.embargoMonths ? `${ix.ebsco.embargoMonths}-month embargo` : ''].filter(Boolean).map(esc).join(' · ')}</div>` : '<span class="muted">Not in the EBSCO title lists loaded</span>'}</td></tr>
          <tr><td>MEDLINE</td><td>${yes(ix.medline, 'Indexed')}${j.nlm?.abbrev ? ` <span class="muted">${esc(j.nlm.abbrev)}</span>` : ''}</td></tr>
          <tr><td>DOAJ</td><td>${yes(ix.doaj.inDoaj, 'Listed')} ${ix.doaj.seal ? badge('DOAJ Seal', 'good') : ''}${ix.doaj.apc ? `<div class="muted">APC: ${esc(ix.doaj.apc)}${ix.doaj.review ? ` · ${esc(ix.doaj.review)}` : ''}${ix.doaj.weeksToPublication ? ` · ~${ix.doaj.weeksToPublication} weeks to publication (journal's declaration)` : ''}</div>` : ''}</td></tr>
          <tr><td>ISSN registry</td><td>${yes(j.issnRegistry.registered, 'Registered')}</td></tr>
          <tr><td>Other lists</td><td>${(oa?.listedIn || []).map(l => `<span class="chip">${esc(l)}</span>`).join(' ') || '—'}</td></tr>
        </table>
        <table class="t">
          <tr><th colspan="2">Profile</th></tr>
          ${oa ? `
          <tr><td>Articles indexed</td><td class="num">${Number(oa.works).toLocaleString()} (${oa.firstYear}–${oa.lastYear})</td></tr>
          <tr><td>Citations / h-index</td><td class="num">${Number(oa.citedBy).toLocaleString()} / ${oa.hIndex}</td></tr>
          <tr><td>2-year mean citedness</td><td class="num">${oa.twoYearMeanCitedness ? oa.twoYearMeanCitedness.toFixed(2) : '—'}</td></tr>
          <tr><td>Open access / APC</td><td>${oa.isOa ? 'Open access' : 'Subscription / hybrid'}${oa.apcUsd ? ` · $${oa.apcUsd}` : ''}</td></tr>
          <tr><td>Retraction Watch</td><td>${j.retractions.retractions} retractions · ${j.retractions.concerns} expressions of concern</td></tr>
          <tr><td>Homepage</td><td>${j.homepage ? `<a href="${esc(j.homepage)}" target="_blank" rel="noopener">${esc(j.homepage)}</a>` : '—'}</td></tr>
          <tr><td>Main topics</td><td>${esc((oa.topics || []).join(', '))}</td></tr>` : '<tr><td colspan="2" class="muted">No OpenAlex profile found.</td></tr>'}
        </table>
      </div>
      ${oa?.worksByYear?.length ? `<h3 style="margin-top:16px">Articles per year</h3><div class="bars">${oa.worksByYear.map(w => `<div class="bar-row"><span>${w.year}</span><div class="bar-track"><span style="width:${Math.round(w.works / maxW * 100)}%"></span></div><span class="num">${w.works}</span></div>`).join('')}</div>` : ''}
      ${j.predatory.length ? `<h3 style="margin-top:16px">List matches</h3><table class="t">${j.predatory.map(p => `<tr><td>${badge(p.kind, p.kind === 'hijacked' ? 'warn' : 'bad')}</td><td>${esc(p.name)}<div class="muted">${esc(p.url || '')}${p.genuine_url ? ` · genuine: ${esc(p.genuine_url)}` : ''}</div></td><td class="muted">${esc(p.source)} · matched by ${esc(p.matchedBy)}</td></tr>`).join('')}</table>` : ''}
    </div>`;
}

function journalText(j) {
  const ix = j.indexing;
  return [
    `Journal Check — ${j.title}`,
    `Publisher: ${j.publisher || '—'} | ISSN: ${j.issns.join(', ') || '—'}`,
    `Verdict: ${j.verdict}`,
    `Scopus: ${ix.scopus.indexed ? 'indexed' : ix.scopus.indexed === false ? 'no' : 'unknown'}${ix.scopus.quartile ? ` (${ix.scopus.quartile})` : ''}`,
    `Web of Science: ${ix.wos.collections.map(c => c.index).join(', ') || '—'}${ix.wos.jcrQuartile ? ` (JCR ${ix.wos.jcrQuartile})` : ''}`,
    `HEC HJRS: ${ix.hjrs?.category || '—'} | EBSCO: ${ix.ebsco ? ix.ebsco.database || 'yes' : 'no'} | MEDLINE: ${ix.medline ? 'yes' : 'no'} | DOAJ: ${ix.doaj.inDoaj ? 'yes' : 'no'}`,
    `Retractions (Retraction Watch): ${j.retractions.retractions}`,
    ...j.flags.map(f => `[${f.severity}] ${f.message}`)
  ].join('\n');
}
