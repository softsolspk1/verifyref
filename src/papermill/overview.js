// papermill/overview.js - Module 4 check overview with a traffic light per check, as the STM Integrity Hub's Papermill
// Checker shows its signals: red = a strong signal, amber = a moderate or weak one, green = checked and nothing found,
// grey = could not be checked (and why). The same rows go on screen and into the Word / PDF report.

/** [label, signal codes, done(r), result text(r)] */
const CHECKS = [
  ['Tortured phrases, computer-generated (SCIgen / Mathgen) text, suspect expressions', ['tortured', 'scigen', 'suspect'], () => true, r => `${(r.details?.tortured || []).length} tortured phrase(s)`],
  ['AI-tool leftovers and template wording', ['ai-leftover', 'template'], () => true, r => `${(r.details?.aiLeftovers || []).length} leftover(s), ${(r.details?.templates || []).length} template phrase(s)`],
  ['AI-written text (vocabulary, sentence rhythm, stock phrases)', ['ai-writing'], r => !!r.checked?.aiWriting, r => (r.checked?.aiWriting && r.details?.aiWriting ? `indicator ${r.details.aiWriting.score}/100` : 'Not checked — fewer than 300 words of text')],
  ['Paper-mill profiles: templates, off-scope buzzwords, titles resembling papers retracted for paper-mill reasons (as the Papermill Alarm)', ['mill-template', 'off-scope', 'mill-lookalike'], r => !!r.checked?.millLookalike, r => (r.checked?.millLookalike ? `${(r.details?.millLookalikes || []).length} look-alike title(s) among the Retraction Watch paper-mill retractions` : 'Templates checked; title comparison not run — no title found')],
  ['Methods detail and hidden text', ['methods', 'hidden-text'], () => true, () => 'Checked'],
  ['References against the scholarly databases and Retraction Watch', ['fabricated', 'retracted', 'mill-retraction', 'flagged-refs', 'stacking'], r => !!r.checked?.references, r => (r.checked?.references ? `${r.details?.references?.total || 0} checked: ${r.details?.references?.fabricated || 0} not found, ${r.details?.references?.retracted || 0} retracted` : 'Not checked — no reference list found')],
  ['Cited journals: paper-mill affected, predatory, hijacked, citejacked, discontinued from Scopus', ['mill-journals', 'predatory', 'hijacked-clone', 'citejacked', 'scopus-discontinued'], r => !!r.checked?.references, r => (r.checked?.references ? `${(r.details?.millJournals || []).reduce((n, j) => n + (j.refs || []).length, 0)} reference(s) to mill-affected journals` : 'Not checked — no reference list found')],
  ['Authors against Retraction Watch (by name)', ['author-retraction', 'author-mill-retraction', 'author-retraction-name'], r => !!r.checked?.authors, r => (r.checked?.authors ? 'Checked' : 'Not checked — no author names found')],
  ['ORCID iDs and their publications', ['orcid-invalid', 'orcid-empty', 'orcid-retraction', 'orcid-mill-retraction', 'no-orcid'], r => !!r.checked?.orcid, r => (r.checked?.orcid ? `${(r.details?.orcids || []).length} iD(s); ${(r.details?.orcidRetractions || []).length} retracted publication(s)` : 'Not checked — no ORCID iD in the manuscript')],
  ['E-mail addresses and affiliations', ['free-mail', 'disposable-mail', 'affiliation'], r => !!(r.details?.emails || []).length, r => ((r.details?.emails || []).length ? `${r.details.emails.length} address(es)` : 'Not checked — no e-mail address found')],
  ['Editorial watchlist (e-mails, domains, names, ORCID iDs, institutions, phones, phrases)', ['watchlist'], r => (r.checked?.watchlist || 0) > 0, r => ((r.checked?.watchlist || 0) > 0 ? `${r.checked.watchlist} entr${r.checked.watchlist > 1 ? 'ies' : 'y'} compared, ${r.details?.watchlist?.matches || 0} found` : 'Not checked — the watchlist is empty')],
  ['Suggested reviewers', ['reviewers'], r => !!r.checked?.reviewers, r => (r.checked?.reviewers ? 'Checked' : 'Not checked — none given')],
  ['Statistics recalculated (p-values, percentages)', ['statistics', 'statistics-minor'], r => !!r.checked?.statistics, r => (r.checked?.statistics ? `${r.checked.statistics} value(s), ${(r.details?.statistics?.findings || []).length} inconsistent` : 'Not checked — no test statistics found')],
  ['Primer sequences (NCBI BLAST)', ['primers', 'primer-gene'], r => !!r.checked?.primers, r => (r.checked?.primers ? `${r.checked.primers} found${r.checked.primersBlasted ? `, ${r.checked.primersBlasted} checked in BLAST` : ', BLAST not run'}` : 'Not checked — no primer sequences')],
  ['Cell lines (ICLAC, Cellosaurus)', ['cell-lines', 'cellosaurus-problematic', 'cellosaurus-misclassified', 'cellosaurus-unknown'], () => true, r => `${(r.details?.cellLines || []).length} misidentified line(s) named`],
  ['microRNAs (miRBase)', ['mirna-species', 'mirna-unknown'], () => true, () => 'Checked'],
  ['Earlier version of this manuscript (author changes)', ['authorship-change'], r => !!r.checked?.previousVersion, r => (r.checked?.previousVersion ? 'Compared' : 'Not checked — no earlier version with this manuscript ID')],
  ['Duplicate submission (earlier PJPS submissions: title and text) and prior publication', ['duplicate', 'duplicate-partial', 'published'], () => true, r => `${r.checked?.earlierSubmissions || 0} earlier submission(s) compared`],
  ['Image Integrity (Module 5)', ['images'], r => !!r.checked?.images, r => (r.checked?.images ? 'Included' : 'Not checked — no Module 5 report attached')]
];

const LIGHT = { red: 'Red', amber: 'Amber', green: 'Green', grey: 'Not checked' };

/** [{ check, result, light, signals }] - light: red | amber | green | grey */
function overview(r) {
  const signals = r.signals || [];
  return CHECKS.map(([check, codes, done, text]) => {
    const hits = signals.filter(s => codes.includes(s.code));
    const light = hits.some(s => s.severity === 'high') ? 'red' : hits.some(s => s.weight > 0) ? 'amber' : done(r) ? 'green' : 'grey';
    // "Not checked — no ORCID iD" with a signal: the missing item is itself the finding
    const result = light === 'grey' ? text(r) : text(r).replace(/^Not checked — (.)/, (m, c) => c.toUpperCase());
    return { check, result, light, signals: hits.length };
  });
}

module.exports = { overview, LIGHT, CHECKS };
