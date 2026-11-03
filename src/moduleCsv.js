// moduleCsv.js - CSV exports of Modules 2-5 (the specification: "Exports: Word, PDF, CSV" for every module), one row per
// finding, for the editorial file or a spreadsheet. Module 1's CSV is in routes/core.js (/checks/:id/export).
const { toCsv } = require('./format');

const join = list => (list || []).filter(Boolean).join('; ');

/** Module 2: one row per style deviation (compliant references get one row too), then the in-text citation problems */
function compliance(c, entries = []) {
  if (!c) return toCsv(['Note'], [['Style compliance was not checked.']]);
  const converted = new Map((entries || []).map(e => [e.number, e]));
  const rows = [];
  for (const e of c.entries || []) {
    const conv = converted.get(e.index);
    const devs = (e.deviations || []).filter(d => d.severity !== 'info');
    const base = [e.index, e.compliant ? 'yes' : 'no', e.original];
    if (!devs.length) rows.push([...base, '', '', '', '', '', e.expected || '', conv?.text || '']);
    for (const d of devs) rows.push([...base, d.rule, d.message, d.found || '', d.expected || '', d.severity, e.expected || '', conv?.text || '']);
  }
  for (const i of c.inText?.issues || []) rows.push(['in-text', 'no', i.citation || '', 'in-text', i.message, i.found || '', i.expected || '', i.severity || '', '', '']);
  return toCsv(['#', 'Compliant', 'Reference as submitted', 'Rule', 'Deviation', 'Found', 'Expected form', 'Severity', 'Expected reference (PJPS)', 'Converted reference'], rows);
}

/** Module 3: citation <-> list problems, then every checked claim with its verdict, then the citation pattern flags */
function citations(r) {
  const c = r.consistency || r;
  const rows = [];
  const add = (section, problem, cite, detail, where = '') => rows.push([section, problem, cite || '', detail || '', where]);
  for (const m of c.missing || []) add('A. Consistency', 'Missing from the reference list', m.citation, m.reason, m.para ? `paragraph ${m.para}` : '');
  for (const u of c.uncited || []) add('A. Consistency', 'Never cited', `[${u.index}]`, u.raw);
  for (const y of c.yearMismatch || []) add('A. Consistency', 'Year mismatch', y.citation, y.message, y.para ? `paragraph ${y.para}` : '');
  for (const y of c.spelling || []) add('A. Consistency', 'Name spelling', y.citation, y.message);
  for (const a of c.ambiguous || []) add('A. Consistency', 'Ambiguous citation', a.citation, a.message);
  for (const e of c.etAlIssues || []) add('A. Consistency', '"et al." use', e.citation, e.message);
  for (const b of c.blocks || []) add('A. Consistency', 'Citation block', b.citation, b.message);
  for (const o of c.orderIssues || []) add('A. Consistency', 'Order', '', o.message);
  for (const n of c.numberingIssues || []) add('A. Consistency', 'Numbering', '', typeof n === 'string' ? n : n.message);
  if (r.claims && !r.claims.error) {
    for (const cl of r.claims.claims || []) for (const x of cl.citations || []) {
      add('B. Claim support', x.verdictLabel || x.verdict, `[${x.refIndex}] ${x.refStatusLabel || ''}`.trim(),
        `${cl.claim}${x.evidence ? ` | evidence: "${x.evidence.quote}"` : x.notes?.length ? ` | ${join(x.notes)}` : ''}`, x.evidence ? `${x.evidence.origin || ''}${x.evidence.page ? ` p. ${x.evidence.page}` : ''}` : '');
    }
  }
  for (const f of r.pattern?.flags || []) add('C. Citation pattern', f.severity || 'flag', '', `${f.message}${f.guidance ? ` - ${f.guidance}` : ''}`);
  return toCsv(['Section', 'Problem / verdict', 'Citation / reference', 'Detail', 'Location / evidence source'], rows);
}

const SEV = { high: 'Strong', medium: 'Moderate', low: 'Weak' };
const evidence = e => `${e.text || ''}${e.quote ? ` - "${e.quote}"` : ''}${e.note ? ` (${e.note})` : ''}${e.link ? ` - ${e.link}` : ''}`;

/** Module 4 (confidential): the risk, then one row per signal with its weight and evidence */
function papermill(r) {
  const rows = [['Risk', r.risk?.level || '', '', r.risk?.score ?? '', 'Overall paper-mill risk (LOW / MEDIUM / HIGH); a screening aid, the editor decides', '', '']];
  for (const s of r.signals || []) rows.push([s.group || '', s.title || s.code, SEV[s.severity] || s.severity || '', s.weight ?? '', join((s.evidence || []).map(evidence)), s.guidance || '', s.code || '']);
  return toCsv(['Area', 'Signal', 'Strength', 'Weight', 'Evidence', 'Guidance', 'Code'], rows);
}

/** Module 5 (confidential): one row per finding inside the manuscript, then the matches with published / retracted figures */
function images(r) {
  const marks = new Map((r.findingMarks || []).map(m => [m.id, m.mark]));
  const MARK = { confirmed: 'Confirmed by editor', false: 'False alarm', ask: 'Ask the authors' };
  const loc = f => (f.a && f.b && f.a.panel !== f.b.panel ? `${f.a.label || f.a.panel} vs ${f.b.label || f.b.panel}` : f.a?.label || f.a?.panel || '');
  const rows = [];
  for (const f of r.findings || []) rows.push(['Finding', f.id ?? '', f.category || 'duplication', f.kind || '', f.level === 'high' ? 'Strong' : 'To check', f.confidence ?? '', loc(f), f.description || '', MARK[marks.get(f.id)] || '', '', '', '']);
  for (const m of r.references || []) rows.push(['Published / retracted figure', '', 'reuse', m.kind || '', m.level === 'high' ? 'Strong' : 'To check', m.confidence ?? '', m.panelLabel || m.panel || '', m.description || '', '', m.title || m.sourceName || '', m.doi || '', [m.journal, m.year].filter(Boolean).join(', ')]);
  return toCsv(['Type', 'Finding no.', 'Category', 'Kind', 'Level', 'Confidence %', 'Figure / panel', 'Description', 'Editor mark', 'Source paper', 'DOI', 'Journal, year'], rows);
}

module.exports = { compliance, citations, papermill, images };
