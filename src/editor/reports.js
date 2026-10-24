// editor/reports.js - Decision summary, author correction letter (English/Urdu), revision comparison, issue report
const { titleSimilarity, normalize } = require('../text');
const cfg = require('../config');

// ------------------------------------------------------------------ problems list (shared by summary / issue report)

function problemsOf(result) {
  const p = [];
  const s = result.references?.summary || {};
  if (s.suspicious) p.push(`${s.suspicious} suspicious (possibly fabricated)`);
  if (s.retracted) p.push(`${s.retracted} retracted`);
  if (s.miscited) p.push(`${s.miscited} miscited`);
  if (s.unverified) p.push(`${s.unverified} unverified`);
  const c = result.citations?.summary;
  if (c?.missing) p.push(`${c.missing} cited but not in list`);
  if (c?.uncited) p.push(`${c.uncited} listed but never cited`);
  if (c?.ambiguous) p.push(`${c.ambiguous} ambiguous citations`);
  const j = result.journals?.summary;
  if (j?.highRisk) p.push(`${j.highRisk} high-risk/predatory journals`);
  const pat = result.pattern;
  for (const f of pat?.flags || []) if (f.severity !== 'low') p.push(f.message);
  if (s.links?.broken) p.push(`${s.links.broken} broken links`);
  return p;
}

// ------------------------------------------------------------------ decision summary (desk review)

function decisionSummary(result) {
  const s = result.references?.summary || { total: 0 };
  const c = result.citations?.summary || null;
  const j = result.journals?.summary || null;
  const pat = result.pattern || null;
  const total = s.total || 0;
  const bad = (s.suspicious || 0) + (s.retracted || 0);
  const badRate = total ? bad / total : 0;
  const selfRate = pat?.summary?.selfCitationRate || 0;

  const reasons = [];
  let recommendation, level;
  const suspRate = total ? (s.suspicious || 0) / total : 0;
  if ((s.suspicious >= 3 && suspRate >= 0.1) || s.suspicious >= 5) {
    level = 'reject';
    recommendation = 'Consider desk rejection — a substantial share of references could not be verified (possible fabricated references).';
    reasons.push(`${bad} of ${total} references are suspicious or retracted (${Math.round(badRate * 100)}%).`);
  } else if (bad > 0 || (s.miscited || 0) >= Math.max(3, total * 0.1) || (c && (c.missing + c.uncited) >= 5) || pat?.flags?.some(f => f.severity === 'high') || j?.highRisk) {
    level = 'revise';
    recommendation = 'Return to the author for reference corrections before peer review.';
  } else {
    level = 'proceed';
    recommendation = 'References are in good order — proceed to peer review.';
  }
  if (s.suspicious) reasons.push(`${s.suspicious} reference(s) were not found in any of the 12 databases.`);
  if (s.retracted) reasons.push(`${s.retracted} retracted work(s) are cited.`);
  if (s.miscited) reasons.push(`${s.miscited} reference(s) contain wrong details (year, journal, volume, pages or DOI).`);
  if (c?.missing) reasons.push(`${c.missing} in-text citation(s) have no entry in the reference list.`);
  if (c?.uncited) reasons.push(`${c.uncited} reference(s) are never cited in the text.`);
  if (j?.highRisk) reasons.push(`${j.highRisk} cited journal(s) are on predatory/hijacked lists or otherwise high-risk (${j.refsInHighRisk} references).`);
  if (selfRate >= 15) reasons.push(`Self-citation rate is ${selfRate}%.`);
  for (const f of (pat?.flags || []).filter(f => f.code !== 'self-citation' && f.severity === 'high')) reasons.push(f.message + '.');

  return {
    manuscript: { code: result.meta?.manuscriptCode || '', title: result.meta?.title || '', authors: (result.meta?.authors || []).map(a => a.name || `${a.given} ${a.family}`.trim()), version: result.meta?.version || 1 },
    checkedAt: result.createdAt || new Date().toISOString(),
    level,
    recommendation,
    reasons,
    references: { total, verified: s.verified || 0, miscited: s.miscited || 0, unverified: s.unverified || 0, suspicious: s.suspicious || 0, retracted: s.retracted || 0, doiSuggested: s.doiSuggested || 0, ages: s.ages, links: s.links },
    citations: c,
    journals: j,
    pattern: pat ? pat.summary : null,
    topProblems: (result.references?.results || []).filter(r => ['suspicious', 'retracted', 'miscited'].includes(r.status)).slice(0, 12).map(r => ({ index: r.index, status: r.statusLabel, reason: r.reason, raw: r.raw.slice(0, 220) }))
  };
}

// ------------------------------------------------------------------ author correction letter

const T = {
  en: {
    subject: (code, title) => `Reference corrections required — ${code ? code + ': ' : ''}${title}`,
    greeting: 'Dear Author(s),',
    intro: (n, journal) => `Thank you for submitting your manuscript to ${journal}. Before peer review, every reference was checked against international scholarly databases (Crossref, PubMed, OpenAlex, Europe PMC, DataCite and others). ${n} item(s) need your attention. Please correct them and resubmit the manuscript with a point-by-point response.`,
    sections: {
      suspicious: 'References that could not be found in any scholarly database (please provide a verifiable source — DOI, PMID or URL — or remove them):',
      retracted: 'Retracted works (please remove them or explain explicitly why a retracted work is cited):',
      miscited: 'References with incorrect details (suggested correction shown):',
      unverified: 'References we could not verify with certainty (please check and add a DOI where available):',
      missing: 'In-text citations without a matching entry in the reference list:',
      uncited: 'References that are never cited in the text (cite them or remove them):',
      ambiguous: 'Ambiguous citations (same author and year — please add a/b suffixes):',
      doi: 'Missing DOIs we found for you (please add them):',
      selfcite: 'Self-citations that appear weakly related to the topic (please justify or remove):',
      yearMismatch: 'Citations whose year differs between the text and the reference list:',
      etal: 'Incorrect use of “et al.” in in-text citations:',
      unsupported: 'Cited sources that do not appear to support the statement they are cited for (please check the citation or the wording):',
      style: 'References not in PJPS style (the expected form is shown):'
    },
    suggested: 'Suggested:',
    found: 'Registered record:',
    closing: 'Please make sure the corrected reference list follows the journal\'s reference style. The revised manuscript will be checked again automatically.',
    regards: 'Kind regards,',
    office: journal => `Editorial Office, ${journal}`
  },
  ur: {
    subject: (code, title) => `حوالہ جات میں درستگی درکار — ${code ? code + ': ' : ''}${title}`,
    greeting: 'محترم مصنف/مصنفین،',
    intro: (n, journal) => `${journal} میں اپنا مسودہ جمع کرانے کا شکریہ۔ ہم مرتبہ جائزے سے پہلے ہر حوالے کو بین الاقوامی علمی ڈیٹا بیسز (Crossref، PubMed، OpenAlex، Europe PMC، DataCite وغیرہ) سے جانچا گیا۔ ${n} نکات پر آپ کی توجہ درکار ہے۔ براہِ کرم انہیں درست کر کے نکتہ بہ نکتہ جواب کے ساتھ مسودہ دوبارہ جمع کرائیں۔`,
    sections: {
      suspicious: 'وہ حوالہ جات جو کسی بھی علمی ڈیٹا بیس میں نہیں ملے (براہِ کرم قابلِ تصدیق ماخذ — DOI، PMID یا URL — فراہم کریں یا انہیں حذف کریں):',
      retracted: 'واپس لیے گئے (Retracted) مقالات (براہِ کرم انہیں حذف کریں یا واضح کریں کہ انہیں کیوں حوالہ دیا گیا):',
      miscited: 'غلط تفصیلات والے حوالہ جات (تجویز کردہ درستگی ساتھ دی گئی ہے):',
      unverified: 'وہ حوالہ جات جن کی مکمل تصدیق نہ ہو سکی (براہِ کرم جانچ کر DOI شامل کریں):',
      missing: 'متن میں دیے گئے وہ حوالے جن کا اندراج فہرستِ حوالہ جات میں موجود نہیں:',
      uncited: 'فہرست کے وہ حوالہ جات جن کا متن میں کہیں ذکر نہیں (متن میں حوالہ دیں یا حذف کریں):',
      ambiguous: 'مبہم حوالے (ایک ہی مصنف اور سال — براہِ کرم a/b کا اضافہ کریں):',
      doi: 'وہ DOI جو موجود نہیں تھے اور ہم نے تلاش کیے (براہِ کرم شامل کریں):',
      selfcite: 'خود حوالگی (Self-citation) جو موضوع سے کمزور تعلق رکھتی ہے (براہِ کرم جواز دیں یا حذف کریں):',
      yearMismatch: 'وہ حوالے جن کا سال متن اور فہرستِ حوالہ جات میں مختلف ہے:',
      etal: 'متن کے حوالوں میں “et al.” کا غلط استعمال:',
      unsupported: 'وہ ماخذ جو اس بیان کی تائید کرتے نظر نہیں آتے جس کے لیے ان کا حوالہ دیا گیا (براہِ کرم حوالہ یا عبارت کی جانچ کریں):',
      style: 'وہ حوالہ جات جو PJPS اسلوب کے مطابق نہیں (درست صورت ساتھ دی گئی ہے):'
    },
    suggested: 'تجویز:',
    found: 'رجسٹرڈ ریکارڈ:',
    closing: 'براہِ کرم یقینی بنائیں کہ درست شدہ فہرستِ حوالہ جات جریدے کے اسلوب کے مطابق ہو۔ نظرثانی شدہ مسودے کی خودکار جانچ دوبارہ کی جائے گی۔',
    regards: 'نیک خواہشات کے ساتھ،',
    office: journal => `ادارتی دفتر، ${journal}`
  }
};

function correctionLetter(result, lang = 'en') {
  const t = T[lang] || T.en;
  const journal = cfg.HOME_JOURNAL.name;
  const refs = result.references?.results || [];
  const cit = result.citations || result.consistency || {};
  const sections = [];
  const sec = (key, items) => { if (items.length) sections.push({ key, heading: t.sections[key], items }); };

  sec('suspicious', refs.filter(r => r.status === 'suspicious').map(r => ({ ref: r.index, text: r.raw, note: r.reason })));
  sec('retracted', refs.filter(r => r.status === 'retracted').map(r => ({ ref: r.index, text: r.raw, note: r.retraction ? `${r.retraction.nature || 'Retraction'}${r.retraction.date ? ` (${r.retraction.date})` : ''}${r.retraction.doi ? ` — https://doi.org/${r.retraction.doi}` : ''}` : r.reason })));
  sec('miscited', refs.filter(r => r.status === 'miscited').map(r => ({
    ref: r.index, text: r.raw,
    note: (r.issues || []).filter(i => i.severity !== 'info').map(i => `${i.message}${i.cited !== undefined && i.registered !== undefined ? ` (${i.cited} → ${i.registered})` : ''}`).join('; '),
    suggestion: r.suggestion
  })));
  sec('unverified', refs.filter(r => r.status === 'unverified').map(r => ({ ref: r.index, text: r.raw, note: r.reason, suggestion: r.suggestion })));
  sec('missing', (cit.missing || []).map(m => ({ text: m.citation, note: m.reason + (m.context ? ` — “…${m.context}…”` : '') })));
  sec('uncited', (cit.uncited || []).map(u => ({ ref: u.index, text: u.raw })));
  sec('ambiguous', (cit.ambiguous || []).map(a => ({ text: a.citation, note: a.message })));
  sec('yearMismatch', (cit.yearMismatch || []).map(y => ({ text: y.citation, note: y.message })));
  sec('etal', (cit.etAlIssues || []).map(e => ({ text: e.citation, note: e.message })));
  sec('unsupported', (result.claims?.claims || []).flatMap(c => c.citations.filter(x => x.verdict === 'unsupported').map(x => ({ ref: x.refIndex, text: `“${c.claim.slice(0, 220)}”`, note: x.refRaw.slice(0, 160) }))));
  sec('style', (result.compliance?.entries || []).filter(e => !e.compliant).map(e => ({ ref: e.index, text: e.original.slice(0, 200), note: e.deviations.filter(d => d.severity !== 'info').map(d => d.message).join('; '), suggestion: e.expected })));
  sec('doi', refs.filter(r => r.status === 'verified' && !r.parsed?.doi && r.record?.doi).map(r => ({ ref: r.index, text: r.raw.slice(0, 140), suggestion: `https://doi.org/${r.record.doi}` })));
  const weakSelf = (result.pattern?.selfCitation?.refs || []).filter(s => s.relevance?.level === 'weak');
  sec('selfcite', weakSelf.map(s => ({ ref: s.index, text: s.title || '' })));

  const count = sections.reduce((a, s) => a + s.items.length, 0);
  const title = result.meta?.title || '';
  const code = result.meta?.manuscriptCode || '';
  const lines = [t.subject(code, title), '', t.greeting, '', t.intro(count, journal), ''];
  sections.forEach((s, si) => {
    lines.push(`${si + 1}. ${s.heading}`);
    for (const it of s.items) {
      lines.push(`   • ${it.ref ? `[${it.ref}] ` : ''}${it.text}`);
      if (it.note) lines.push(`     – ${it.note}`);
      if (it.suggestion) lines.push(`     ${t.suggested} ${it.suggestion}`);
    }
    lines.push('');
  });
  lines.push(t.closing, '', t.regards, t.office(journal));
  return { lang, rtl: lang === 'ur', subject: t.subject(code, title), count, sections, text: lines.join('\n') };
}

// ------------------------------------------------------------------ revision comparison

function refKey(r) {
  return (r.record?.doi || r.parsed?.doi || '').toLowerCase() || null;
}

function sameRef(a, b) {
  const ka = refKey(a), kb = refKey(b);
  if (ka && kb) return ka === kb;
  const ta = a.record?.title || a.parsed?.title || a.raw, tb = b.record?.title || b.parsed?.title || b.raw;
  return titleSimilarity(ta, tb) >= 0.85;
}

const isProblem = r => ['suspicious', 'retracted', 'miscited', 'unverified'].includes(r.status);

/**
 * Compare the previous check (v1) with the revised manuscript's check (v2).
 */
function compareRevisions(prev, next) {
  const A = prev.references?.results || [], B = next.references?.results || [];
  const usedB = new Set();
  const rows = [];
  for (const a of A) {
    const bi = B.findIndex((b, i) => !usedB.has(i) && sameRef(a, b));
    if (bi === -1) {
      rows.push({ change: isProblem(a) ? 'removed-problem' : 'removed', before: a, after: null });
      continue;
    }
    usedB.add(bi);
    const b = B[bi];
    let change;
    if (isProblem(a) && !isProblem(b)) change = 'fixed';
    else if (isProblem(a) && isProblem(b)) change = 'still-problem';
    else if (!isProblem(a) && isProblem(b)) change = 'new-problem';
    else change = 'unchanged';
    rows.push({ change, before: a, after: b });
  }
  B.forEach((b, i) => { if (!usedB.has(i)) rows.push({ change: isProblem(b) ? 'added-problem' : 'added', before: null, after: b }); });

  const slim = r => r && { index: r.index, status: r.status, statusLabel: r.statusLabel, raw: r.raw.slice(0, 240), reason: r.reason };
  const count = c => rows.filter(r => r.change === c).length;

  // Citation-check items resolved
  const ca = prev.citations?.summary, cb = next.citations?.summary;
  const citations = ca && cb ? {
    missing: { before: ca.missing, after: cb.missing },
    uncited: { before: ca.uncited, after: cb.uncited },
    ambiguous: { before: ca.ambiguous, after: cb.ambiguous }
  } : null;

  // Requested fixes = problems flagged in v1 (what the correction letter asked for)
  const requested = A.filter(isProblem).length + (ca ? ca.missing + ca.uncited + ca.ambiguous : 0);
  const addressed = count('fixed') + count('removed-problem') + (citations ? Math.max(0, ca.missing - cb.missing) + Math.max(0, ca.uncited - cb.uncited) + Math.max(0, ca.ambiguous - cb.ambiguous) : 0);

  return {
    before: { version: prev.meta?.version, checkedAt: prev.createdAt, total: A.length, problems: A.filter(isProblem).length },
    after: { version: next.meta?.version, checkedAt: next.createdAt, total: B.length, problems: B.filter(isProblem).length },
    summary: {
      fixed: count('fixed'), removedProblem: count('removed-problem'), stillProblem: count('still-problem'),
      newProblem: count('new-problem') + count('added-problem'), added: count('added') + count('added-problem'),
      removed: count('removed') + count('removed-problem'), unchanged: count('unchanged'),
      requested, addressed, completion: requested ? Math.round(Math.min(addressed, requested) / requested * 100) : 100
    },
    citations,
    selfCitation: prev.pattern && next.pattern ? { before: prev.pattern.summary.selfCitationRate, after: next.pattern.summary.selfCitationRate } : null,
    verdict: count('still-problem') + count('new-problem') + count('added-problem') === 0 ? 'All requested reference fixes were made.' : 'Some requested fixes are missing or new problems were introduced.',
    rows: rows.filter(r => r.change !== 'unchanged').map(r => ({ change: r.change, before: slim(r.before), after: slim(r.after) }))
  };
}

// ------------------------------------------------------------------ issue report

function issueReport(checks) {
  const rows = checks.map(c => ({
    id: c.id,
    manuscriptCode: c.manuscript_code || '',
    version: c.version,
    title: c.title || '',
    date: c.created_at,
    references: c.ref_total,
    verified: c.verified,
    suspicious: c.suspicious,
    retracted: c.retracted,
    miscited: c.miscited,
    unverified: c.unverified,
    missingCitations: c.missing_citations,
    uncited: c.uncited_references,
    journalFlags: c.journal_flags,
    selfCitationRate: c.self_citation_rate,
    problems: c.problems || []
  }));
  const sum = k => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const problemFreq = {};
  for (const r of rows) for (const p of r.problems) {
    const k = p.replace(/^\d+\s+/, '').replace(/\d+/g, 'N');
    problemFreq[k] = (problemFreq[k] || 0) + 1;
  }
  return {
    rows,
    totals: {
      manuscripts: rows.length,
      references: sum('references'),
      suspicious: sum('suspicious'),
      retracted: sum('retracted'),
      miscited: sum('miscited'),
      unverified: sum('unverified'),
      missingCitations: sum('missingCitations'),
      uncited: sum('uncited'),
      journalFlags: sum('journalFlags'),
      manuscriptsWithSuspicious: rows.filter(r => r.suspicious > 0).length,
      avgSelfCitation: rows.length ? Math.round(rows.reduce((a, r) => a + (r.selfCitationRate || 0), 0) / rows.length * 10) / 10 : 0
    },
    frequentProblems: Object.entries(problemFreq).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([problem, manuscripts]) => ({ problem, manuscripts }))
  };
}

module.exports = { problemsOf, decisionSummary, correctionLetter, compareRevisions, issueReport };
