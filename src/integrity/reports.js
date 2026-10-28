// integrity/reports.js - Automated integrity reports (Word and PDF through the same blocks as docx.js / pdf.js):
//   integrityBlocks  - Integrity Screening: risk score with its explanation, every signal with its evidence and source link
//   peerReviewBlocks - Peer-Review Integrity
//   caseBlocks       - an integrity case: linked reports with their key findings, author queries and responses, outcome,
//                      and the complete audit trail (case events + audit-log entries)
const cfg = require('../config');

const day = d => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const stamp = d => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
const SEV = { high: 'Strong', medium: 'Moderate', low: 'Weak' };
const link = id => (cfg.PUBLIC_URL ? `${cfg.PUBLIC_URL}/app#/check/${id}` : `report #${id}`);

const evidenceText = s => (s.evidence || []).slice(0, 10).map(e => `${e.text}${e.quote ? ` — “${e.quote}”` : ''}${e.note ? ` (${e.note})` : ''}${e.link ? ` [${e.link}]` : ''}${e.checkId ? ` [${link(e.checkId)}]` : ''}`).join('\n');

function signalTable(signals) {
  return { table: { headers: ['Signal', 'Strength', 'Evidence (source records)'], rows: signals.map(s => [`${s.title}${s.note ? ` — ${s.note}` : ''}`, `${SEV[s.severity] || s.severity} (${s.weight})`, evidenceText(s) || '—']) } };
}

function integrityBlocks(r) {
  const k = r.risk;
  const meta = r.meta || {};
  const blocks = [
    { h1: 'CONFIDENTIAL — Module 4 Paper Mill & Integrity Report' },
    { p: r.disclaimer, italics: true },
    { kv: [['Manuscript', `${meta.manuscriptCode ? meta.manuscriptCode + ' — ' : ''}${meta.title || '—'}`], ['Authors', (meta.authors || []).map(a => a.name).join(', ') || '—'], ['Screened', stamp(r.createdAt)], ['Report', r.id ? link(r.id) : '—'],
      ['Integrity risk', `${k.level} — ${k.score}/100 (${k.strongSignals} strong signal(s))`], ['Recommendation', k.recommendation], ['Coverage', `${k.coverage.checked} of ${k.coverage.total} dimensions`]] },
    { h2: 'Why this score' },
    { bullets: k.explanation },
    { p: k.method, italics: true },
    { h2: 'Score by dimension' },
    { table: { headers: ['Dimension', 'Signals', 'Points', 'Source'], rows: k.dimensions.map(d => [d.label, String(d.signals), `${d.points}${d.capped ? ' (capped)' : ''}`, d.source?.checkId ? link(d.source.checkId) : 'this screening']) } }
  ];
  for (const d of r.dimensions || []) {
    blocks.push({ h2: d.label });
    if (d.checked === false && !d.signals?.length) blocks.push({ p: 'Not enough material in the manuscript to check this dimension.', italics: true });
    blocks.push(d.signals?.length ? signalTable(d.signals) : { p: 'No signal found.' });
    if (d.key === 'similarity' && d.details?.fullTextLiterature) blocks.push({ p: d.details.fullTextLiterature, italics: true });
  }
  if (r.decision) blocks.push({ h2: 'Editor decision' }, { kv: [['Decision', r.decision.label || '—'], ['Notes', r.decision.notes || '—'], ['By', `${r.decision.by}, ${day(r.decision.at)}`]] });
  if ((r.decisionHistory || []).length) blocks.push({ h2: 'Decision history' }, { table: { headers: ['When', 'Who', 'Decision', 'Notes'], rows: r.decisionHistory.map(h => [stamp(h.at), h.by, h.label || '—', h.notes || '']) } });
  return blocks;
}

function peerReviewBlocks(r) {
  const d = (r.dimensions || [])[0] || { signals: [], details: {} };
  return [
    { h1: 'CONFIDENTIAL — Module 4 Peer-Review Integrity Report' },
    { p: r.disclaimer, italics: true },
    { kv: [['Manuscript', `${r.meta?.manuscriptCode ? r.meta.manuscriptCode + ' — ' : ''}${r.meta?.title || '—'}`], ['Checked', stamp(r.createdAt)], ['Reviewers', String((d.details.reviewers || []).length)], ['Risk', `${r.risk.level} — ${r.risk.score}/100`], ['Recommendation', r.risk.recommendation]] },
    { h2: 'Why this score' }, { bullets: r.risk.explanation },
    ...(d.details.reviewers || []).flatMap(rv => [
      { h2: `Reviewer: ${rv.name || rv.email || '—'}` },
      { kv: [['E-mail', rv.email || '—'], ['ORCID', rv.orcid || '—'], ['Institution', rv.institution || rv.coauthorship?.institution || '—'], ['Report', rv.reportStats ? `${rv.reportStats.words} words${rv.reportStats.specificity ? `, ${rv.reportStats.specificity.specific} manuscript-specific terms` : ''}` : 'not provided']] },
      rv.findings.length ? { table: { headers: ['Finding', 'Strength', 'Note'], rows: rv.findings.map(f => [f.text, `${SEV[f.severity]} (${f.weight})`, `${f.note || ''}${f.link ? ` [${f.link}]` : ''}`]) } } : { p: 'No concern found.' }
    ])
  ];
}

const EVENT_LABEL = { created: 'Case opened', note: 'Note', status: 'Status changed', assign: 'Assigned', priority: 'Priority changed', query: 'Author query sent', response: 'Author response received', decision: 'Decision', link: 'Reports linked', report: 'Report generated' };

function eventText(e, labels) {
  const d = e.data || {};
  if (e.kind === 'status') return `${labels.statuses[d.from] || d.from} → ${labels.statuses[d.to] || d.to}${d.outcomeLabel ? ` (outcome: ${d.outcomeLabel})` : ''}${e.body ? ` — ${e.body}` : ''}`;
  if (e.kind === 'assign') return `to ${d.name}`;
  if (e.kind === 'priority') return `${d.from} → ${d.to}`;
  if (e.kind === 'link') return `reports ${(d.checkIds || []).map(x => '#' + x).join(', ')}`;
  if (e.kind === 'query') return `${d.subject || ''}${d.to ? ` (to ${d.to})` : ''}${d.dueAt ? `, reply due ${day(d.dueAt)}` : ''}\n${e.body || ''}`;
  if (e.kind === 'created') return `${e.body || ''}${(d.checkIds || []).length ? ` reports ${d.checkIds.map(x => '#' + x).join(', ')}` : ''}${d.risk ? `, risk ${d.risk}` : ''}`;
  return e.body || '';
}

/** c: case from cases.getCase, reports: [{ row, result }] of the linked checks, audit: audit-log rows for this case */
function caseBlocks(c, reports, audit, labels) {
  const blocks = [
    { h1: `CONFIDENTIAL — Integrity Case #${c.id}` },
    { kv: [['Manuscript', `${c.manuscript_code ? c.manuscript_code + ' — ' : ''}${c.title}`], ['Status', labels.statuses[c.status] || c.status], ['Outcome', labels.outcomes[c.outcome] || '—'], ['Priority', labels.priorities[c.priority] || c.priority],
      ['Risk level', c.risk_level || '—'], ['Assigned to', c.assigned_name || '—'], ['Opened', `${stamp(c.created_at)} by ${c.created_name || '—'}`], ['Closed', c.closed_at ? stamp(c.closed_at) : '—'], ['Report generated', stamp(new Date())]] },
    { h2: 'Evidence: linked screening reports' }
  ];
  if (!reports.length) blocks.push({ p: 'No report is linked to this case.' });
  for (const { row, result: r } of reports) {
    blocks.push({ p: `${row.kindLabel || row.kind} #${row.id} — ${row.title || ''} (${day(row.created_at)}) [${link(row.id)}]`, bold: true });
    const key = r?.risk?.contributions ? r.risk.contributions.filter(x => x.severity !== 'low').slice(0, 10).map(x => `${x.dimension}: ${x.title} (${SEV[x.severity]})`)
      : r?.signals ? r.signals.filter(x => x.severity !== 'low').slice(0, 10).map(x => `${x.title} (${SEV[x.severity]})`)
      : r?.findings ? r.findings.filter(f => f.level === 'high').slice(0, 10).map(f => `${f.a?.label || 'Figure'}: ${f.description}`) : [];
    const level = r?.risk ? `Risk ${r.risk.level}${r.risk.score !== undefined ? ` (${r.risk.score}${r.kind === 'integrity' || r.kind === 'peer-review' ? '/100' : ''})` : ''}` : r?.summary?.level ? `Image risk ${r.summary.level}` : '';
    if (level) blocks.push({ p: level });
    blocks.push(key.length ? { bullets: key } : { p: 'No moderate or strong finding.', italics: true });
    if (r?.decision) blocks.push({ p: `Decision on this report: ${r.decision.label || '—'} — ${r.decision.notes || ''} (${r.decision.by}, ${day(r.decision.at)})`, italics: true });
  }
  if (c.queries.length) {
    blocks.push({ h2: 'Author queries and responses' });
    for (const q of c.queries) {
      blocks.push({ p: `${stamp(q.created_at)} — ${q.data?.subject || 'Query'} (sent by ${q.actor_name})`, bold: true }, { p: q.body || '' });
      if (q.responses.length) for (const a of q.responses) blocks.push({ p: `Response received ${day(a.data?.receivedAt || a.created_at)} (logged by ${a.actor_name}):`, italics: true }, { p: a.body || '' });
      else blocks.push({ p: 'No response logged yet.', italics: true });
    }
  }
  blocks.push({ h2: 'Audit trail' }, { table: { headers: ['When', 'Who', 'Action', 'Details'], rows: c.events.map(e => [stamp(e.created_at), e.actor_name || '—', EVENT_LABEL[e.kind] || e.kind, eventText(e, labels).slice(0, 1500)]) } });
  if (audit.length) blocks.push({ h2: 'System audit log (this case and its reports)' }, { table: { headers: ['When', 'User', 'Action', 'Target'], rows: audit.map(a => [stamp(a.created_at), a.actor_email || '—', a.action, a.target || '']) } });
  blocks.push({ p: `Generated by ${cfg.APP_NAME} (${cfg.APP_VENDOR}). Every finding links to the screening report that holds its evidence and source records.`, italics: true });
  return blocks;
}

module.exports = { integrityBlocks, peerReviewBlocks, caseBlocks };
