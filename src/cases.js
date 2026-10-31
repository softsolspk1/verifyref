// cases.js - Editorial case management for integrity concerns. A case gathers the screening reports of one manuscript,
// moves through an investigation workflow and keeps every step as an event (the case's audit trail):
//   open → investigating → awaiting_author → committee → closed (any order; closing records the outcome)
// Author queries are drafted from the findings, recorded when sent, and the authors' responses are logged against them.
const db = require('./db');

const STATUSES = { open: 'Open', investigating: 'Under investigation', awaiting_author: 'Awaiting author response', committee: 'With the integrity committee', closed: 'Closed' };
const PRIORITIES = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const OUTCOMES = {
  'no-issue': 'No integrity issue found', 'corrected': 'Resolved — authors corrected the manuscript', 'rejected': 'Manuscript rejected',
  'retracted': 'Published article retracted', 'correction': 'Correction published', 'eoc': 'Expression of concern published',
  'institution': 'Referred to the authors\' institution', 'withdrawn': 'Withdrawn by the authors'
};
const PRIORITY_OF = { CRITICAL: 'urgent', HIGH: 'high', MODERATE: 'normal', LOW: 'low' };

const KIND_LABEL = { integrity: 'Module 4 Paper Mill Detection', papermill: 'Module 4 Paper Mill Detection (earlier version)', images: 'Image Integrity', manuscript: 'Full Screening Report', references: 'Check Bibliography', 'peer-review': 'Module 4 Peer-review integrity' };

async function event(caseId, user, kind, body = '', data = null) {
  await db.query('INSERT INTO case_events(case_id, kind, body, data, actor_id, actor_name) VALUES($1,$2,$3,$4,$5,$6)', [caseId, kind, body || null, data ? JSON.stringify(data) : null, user?.id || null, user?.name || 'System']);
  await db.query('UPDATE cases SET updated_at = now() WHERE id = $1', [caseId]);
}

async function createCase(user, b) {
  const checkIds = [...new Set((b.checkIds || []).map(Number).filter(Boolean))];
  let risk = b.riskLevel || null, title = String(b.title || '').trim(), code = String(b.manuscriptCode || '').trim() || null;
  if (checkIds.length) {
    const first = await db.one('SELECT kind, title, manuscript_code, result FROM checks WHERE id = $1', [checkIds[0]]);
    if (first) {
      title = title || first.title || 'Integrity case';
      code = code || first.manuscript_code;
      risk = risk || first.result?.risk?.level || first.result?.summary?.level || null;
    }
  }
  if (!title) throw Object.assign(new Error('Give the case a title or link a report.'), { status: 400 });
  const row = await db.one(`INSERT INTO cases(manuscript_code, title, status, priority, risk_level, category, assigned_to, created_by, check_ids, due_at)
    VALUES($1,$2,'open',$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [code, title.slice(0, 300), PRIORITIES[b.priority] ? b.priority : PRIORITY_OF[risk] || 'normal', risk, b.category || null,
    b.assignedTo || user.id, user.id, JSON.stringify(checkIds), b.dueAt || null]);
  await event(row.id, user, 'created', b.note || '', { checkIds, risk });
  return row;
}

async function getCase(id) {
  const c = await db.one(`SELECT c.*, a.name AS assigned_name, u.name AS created_name FROM cases c LEFT JOIN users a ON a.id = c.assigned_to LEFT JOIN users u ON u.id = c.created_by WHERE c.id = $1`, [id]);
  if (!c) return null;
  c.events = await db.all('SELECT * FROM case_events WHERE case_id = $1 ORDER BY created_at, id', [id]);
  const ids = (c.check_ids || []).map(Number);
  c.reports = ids.length ? await db.all(`SELECT id, kind, title, manuscript_code, problems, created_at, result->'risk'->>'level' AS risk_level, result->'risk'->>'score' AS risk_score, result->'summary'->>'level' AS image_level
    FROM checks WHERE id = ANY($1::int[]) ORDER BY created_at`, [ids]) : [];
  c.reports.forEach(r => { r.kindLabel = KIND_LABEL[r.kind] || r.kind; });
  // other reports for the same manuscript that are not linked yet
  c.suggested = c.manuscript_code ? await db.all('SELECT id, kind, title, created_at FROM checks WHERE manuscript_code = $1 AND result IS NOT NULL AND embedded_in IS NULL AND NOT (id = ANY($2::int[])) ORDER BY created_at DESC LIMIT 10', [c.manuscript_code, ids]) : [];
  c.queries = c.events.filter(e => e.kind === 'query').map(q => ({ ...q, responses: c.events.filter(e => e.kind === 'response' && e.data?.queryId === q.id) }));
  return c;
}

async function updateCase(id, user, b) {
  const c = await db.one('SELECT * FROM cases WHERE id = $1', [id]);
  if (!c) return null;
  if (b.status && STATUSES[b.status] && b.status !== c.status) {
    if (b.status === 'closed' && !OUTCOMES[b.outcome]) throw Object.assign(new Error('Choose the outcome to close the case.'), { status: 400 });
    await db.query(`UPDATE cases SET status = $2, closed_at = ${b.status === 'closed' ? 'now()' : 'NULL'}, outcome = $3 WHERE id = $1`, [id, b.status, b.status === 'closed' ? b.outcome : c.outcome]);
    await event(id, user, 'status', b.note || '', { from: c.status, to: b.status, outcome: b.status === 'closed' ? b.outcome : null, outcomeLabel: OUTCOMES[b.outcome] || null });
  }
  if (b.priority && PRIORITIES[b.priority] && b.priority !== c.priority) { await db.query('UPDATE cases SET priority = $2 WHERE id = $1', [id, b.priority]); await event(id, user, 'priority', '', { from: c.priority, to: b.priority }); }
  if (b.assignedTo !== undefined && Number(b.assignedTo || 0) !== Number(c.assigned_to || 0)) {
    const to = b.assignedTo ? await db.one('SELECT id, name FROM users WHERE id = $1', [b.assignedTo]) : null;
    await db.query('UPDATE cases SET assigned_to = $2 WHERE id = $1', [id, to?.id || null]);
    await event(id, user, 'assign', '', { to: to?.id || null, name: to?.name || 'nobody' });
    if (to && to.id !== user.id) await require('./alerts').notify(to.id, { kind: 'system', title: `Integrity case assigned to you: ${c.title.slice(0, 80)}`, body: `Case #${id} — assigned by ${user.name}.`, link: `#/papermill/cases/${id}` }).catch(() => {});
  }
  if (b.dueAt !== undefined) await db.query('UPDATE cases SET due_at = $2 WHERE id = $1', [id, b.dueAt || null]);
  if (Array.isArray(b.linkChecks) && b.linkChecks.length) {
    const ids = [...new Set([...(c.check_ids || []), ...b.linkChecks.map(Number).filter(Boolean)])];
    await db.query('UPDATE cases SET check_ids = $2 WHERE id = $1', [id, JSON.stringify(ids)]);
    await event(id, user, 'link', '', { checkIds: b.linkChecks });
  }
  return getCase(id);
}

async function addEvent(id, user, b) {
  const kind = ['note', 'query', 'response', 'decision'].includes(b.kind) ? b.kind : 'note';
  const body = String(b.body || '').trim().slice(0, 20000);
  if (!body) throw Object.assign(new Error('Write the note, query or response first.'), { status: 400 });
  const data = kind === 'query' ? { subject: String(b.subject || 'Query about your manuscript').slice(0, 200), to: String(b.to || '').slice(0, 300), dueAt: b.dueAt || null }
    : kind === 'response' ? { queryId: Number(b.queryId) || null, receivedAt: b.receivedAt || new Date().toISOString() }
    : kind === 'decision' ? { decision: String(b.decision || '').slice(0, 100) } : null;
  await event(id, user, kind, body, data);
  if (kind === 'query') await db.query("UPDATE cases SET status = 'awaiting_author', due_at = COALESCE($2, due_at) WHERE id = $1 AND status <> 'closed'", [id, b.dueAt || null]);
  return getCase(id);
}

/** Dashboard: counts per status / priority / risk, overdue author queries, recent high-risk screenings without a case */
async function dashboard() {
  const byStatus = await db.all('SELECT status, COUNT(*)::int AS n FROM cases GROUP BY status');
  const byRisk = await db.all("SELECT COALESCE(risk_level, 'none') AS risk, COUNT(*)::int AS n FROM cases WHERE status <> 'closed' GROUP BY 1");
  const open = await db.all(`SELECT c.id, c.title, c.manuscript_code, c.status, c.priority, c.risk_level, c.due_at, c.updated_at, a.name AS assigned_name
    FROM cases c LEFT JOIN users a ON a.id = c.assigned_to WHERE c.status <> 'closed'
    ORDER BY CASE c.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, c.updated_at DESC LIMIT 200`);
  const overdue = open.filter(c => c.due_at && new Date(c.due_at) < new Date());
  const closed = await db.all(`SELECT c.id, c.title, c.manuscript_code, c.outcome, c.closed_at FROM cases c WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 20`);
  const linked = new Set((await db.all('SELECT check_ids FROM cases')).flatMap(r => (r.check_ids || []).map(Number)));
  const unhandled = (await db.all(`SELECT id, kind, title, manuscript_code, created_at, COALESCE(result->'risk'->>'level', result->'summary'->>'level') AS level FROM checks
    WHERE kind IN ('integrity', 'papermill', 'images', 'peer-review') AND embedded_in IS NULL AND created_at > now() - interval '120 days'
      AND COALESCE(result->'risk'->>'level', result->'summary'->>'level') IN ('HIGH', 'CRITICAL') ORDER BY created_at DESC LIMIT 100`)).filter(r => !linked.has(r.id)).slice(0, 25);
  const screenings = await db.all(`SELECT result->'risk'->>'level' AS level, COUNT(*)::int AS n FROM checks WHERE kind = 'integrity' AND created_at > now() - interval '90 days' GROUP BY 1`);
  const monitoring = await db.all('SELECT status, COUNT(*)::int AS n FROM monitored_articles GROUP BY status');
  return { byStatus, byRisk, open, overdue, closed, unhandled, screenings, monitoring, labels: { statuses: STATUSES, priorities: PRIORITIES, outcomes: OUTCOMES } };
}

/** Draft author query from the linked reports' moderate and strong findings (editor edits before sending) */
async function draftQuery(id) {
  const c = await getCase(id);
  if (!c) return null;
  const items = [];
  for (const r of c.reports) {
    const full = await db.one('SELECT kind, result FROM checks WHERE id = $1', [r.id]);
    const res = (full?.result && await require('./reportStore').load(full.result)) || {};
    if (res.risk?.contributions) items.push(...res.risk.contributions.filter(x => x.severity !== 'low').map(x => x.title));
    else if (res.signals) items.push(...res.signals.filter(x => x.severity !== 'low').map(x => x.title));
    else if (res.findings) items.push(...res.findings.filter(f => f.level === 'high').map(f => `${f.a?.label || 'Figure'}: ${f.description}`));
  }
  const uniq = [...new Set(items)].slice(0, 15);
  return {
    subject: `${c.manuscript_code || 'Your manuscript'} — request for clarification`,
    body: `Dear Author,\n\nDuring the editorial integrity checks of your manuscript${c.manuscript_code ? ` ${c.manuscript_code}` : ''} “${c.title}”, the following points need your clarification:\n\n${uniq.map((x, i) => `${i + 1}. ${x}`).join('\n') || '1. …'}\n\nPlease reply within 14 days with an explanation for each point and, where applicable, the original data, images, ethics approval letter or registration record. These checks are part of the journal's standard procedure and do not imply misconduct.\n\nYours sincerely,\nEditorial Office\nPakistan Journal of Pharmaceutical Sciences`
  };
}

module.exports = { createCase, getCase, updateCase, addEvent, dashboard, draftQuery, STATUSES, PRIORITIES, OUTCOMES, KIND_LABEL };
