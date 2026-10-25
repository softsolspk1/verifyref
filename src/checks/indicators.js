// checks/indicators.js - Module 1 extra quality indicators: self-citation, PJPS citations, predatory / hijacked
// journals, duplicate references and the reference-age rule set by PJPS.
const cfg = require('../config');
const db = require('../db');
const { titleSimilarity, normalizeJournal, cleanIssn, cleanDoi } = require('../text');
const { analyzeCitationPattern } = require('../editor/pattern');

const DEFAULT_RECENT = { years: 5, minShare: 30 }; // warn when fewer than 30% of references are from the last 5 years

async function ageRule() {
  try {
    const v = await db.getMeta('recent_rule');
    if (v) return { ...DEFAULT_RECENT, ...JSON.parse(v) };
  } catch (e) { /* default */ }
  return { ...DEFAULT_RECENT };
}

async function setAgeRule(rule) {
  const r = { years: Math.min(Math.max(parseInt(rule.years, 10) || 5, 1), 20), minShare: Math.min(Math.max(parseInt(rule.minShare, 10) || 0, 0), 100) };
  await db.setMeta('recent_rule', JSON.stringify(r));
  return r;
}

const isHomeJournal = (r, home = cfg.HOME_JOURNAL) => {
  const ok = !!r.record && (['verified', 'retracted'].includes(r.status) || (r.status === 'miscited' && (r.confidence || 0) >= 85));
  const name = (ok && r.record?.journal) || r.parsed?.journal || r.record?.journal || '';
  const issns = (ok ? r.record?.issn || [] : []).map(cleanIssn);
  return issns.some(i => (home.issn || []).map(cleanIssn).includes(i)) || normalizeJournal(name) === normalizeJournal(home.name)
    || /pak(istan)?\.?\s*j(ournal)?\.?\s*(of\s*)?pharm(aceutical)?\.?\s*sci/i.test(name);
};

/** Same work listed more than once: same DOI or near-identical title + year */
function duplicates(results) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      const a = results[i], b = results[j];
      const da = cleanDoi(a.record?.doi || a.parsed?.doi || ''), dbb = cleanDoi(b.record?.doi || b.parsed?.doi || '');
      const ta = a.record?.title || a.parsed?.title || '', tb = b.record?.title || b.parsed?.title || '';
      const ya = a.record?.year || a.parsed?.year, yb = b.record?.year || b.parsed?.year;
      const sameDoi = da && dbb && da === dbb;
      const sameTitle = ta.length > 20 && tb.length > 20 && titleSimilarity(ta, tb) >= 0.93 && (!ya || !yb || ya === yb);
      if ((sameDoi || sameTitle) && !seen.has(`${a.index}-${b.index}`)) {
        seen.add(`${a.index}-${b.index}`);
        out.push({ indexes: [a.index, b.index], by: sameDoi ? 'same DOI' : 'same title and year', title: ta || tb });
      }
    }
  }
  // Group the pairs by work: three copies of one reference are one group, not three pairs
  const groups = [];
  for (const p of out) {
    const g = groups.find(x => x.indexes.some(i => p.indexes.includes(i)));
    if (g) { for (const i of p.indexes) if (!g.indexes.includes(i)) g.indexes.push(i); if (!g.by.includes(p.by)) g.by += ' / ' + p.by; } else groups.push({ ...p, indexes: [...p.indexes] });
  }
  return groups.map(g => ({ ...g, indexes: g.indexes.sort((x, y) => x - y) }));
}

/**
 * meta: manuscript meta (authors needed for self-citation); results: reference results; journals: cited-journal check
 */
async function bibliographyIndicators(meta, results, journals) {
  const rule = await ageRule();
  const aged = results.filter(r => r.age !== null && r.age !== undefined);
  const recent = aged.filter(r => r.age <= rule.years).length;
  const within10 = aged.filter(r => r.age <= 10).length;
  const recentShare = aged.length ? Math.round(recent / aged.length * 100) : null;
  const byYear = {};
  for (const r of results) { const y = r.record?.year || r.parsed?.year; if (y) byYear[y] = (byYear[y] || 0) + 1; }

  const hasAuthors = (meta?.authors || []).length > 0;
  const pattern = hasAuthors ? analyzeCitationPattern(meta, results) : null;
  const self = pattern ? pattern.selfCitation.refs.map(s => ({ index: s.index, authors: s.authors, title: s.title })) : [];
  const home = results.filter(r => isHomeJournal(r)).map(r => r.index);

  const risky = [];
  for (const j of journals?.journals || []) {
    const pred = (j.predatory || []);
    const hijacked = pred.some(p => p.kind === 'hijacked');
    const listed = pred.some(p => p.kind !== 'hijacked');
    const blacklisted = (j.flags || []).some(f => /blacklist|predatory|hijack/i.test(f.code || f.message || ''));
    if (hijacked || listed || blacklisted) {
      risky.push({ journal: j.title || j.citedName, refs: j.refs, kind: hijacked ? 'hijacked' : 'predatory', sources: [...new Set(pred.map(p => p.source))].filter(Boolean), verdict: j.verdict });
    }
  }

  const dups = duplicates(results);
  const flags = [];
  if (recentShare !== null && rule.minShare && recentShare < rule.minShare) flags.push({ severity: 'medium', code: 'few-recent', message: `Only ${recentShare}% of references are from the last ${rule.years} years (PJPS minimum: ${rule.minShare}%)` });
  if (pattern && pattern.summary.selfCitationRate >= 15) flags.push({ severity: pattern.summary.selfCitationRate >= 25 ? 'high' : 'medium', code: 'self-citation', message: `Self-citation ${pattern.summary.selfCitationRate}% (${self.length} of ${results.length} references)` });
  if (risky.length) flags.push({ severity: 'high', code: 'predatory', message: `${risky.reduce((a, r) => a + r.refs.length, 0)} reference(s) to predatory or hijacked journals` });
  if (dups.length) flags.push({ severity: 'low', code: 'duplicates', message: `${dups.length} reference(s) listed twice` });

  return {
    age: { rule, recent, recentShare, within10, within10Share: aged.length ? Math.round(within10 / aged.length * 100) : null, aged: aged.length, olderThan10: aged.filter(r => r.age > 10).map(r => r.index), byYear },
    selfCitation: { measured: hasAuthors, count: self.length, rate: pattern ? pattern.summary.selfCitationRate : null, refs: self },
    homeJournal: { name: cfg.HOME_JOURNAL.name, count: home.length, refs: home },
    riskyJournals: risky,
    duplicates: dups,
    flags
  };
}

module.exports = { bibliographyIndicators, duplicates, ageRule, setAgeRule, isHomeJournal };
