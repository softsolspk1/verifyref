// modules.js - the tools a user can be given access to, grouped as in the navigation, with role defaults.
// PJPS v4 scope: five modules plus the Full Screening Report; v5 adds the Integrity Suite. The earlier tools stay in the code base but are
// switched off (LEGACY): they are not shown, not granted and their API routes refuse access.

const MODULES = [
  { key: 'manuscript', label: 'Full Screening Report (all modules)', group: 'PJPS modules', editor: true },
  { key: 'references', label: 'Module 1 — Check Bibliography', group: 'PJPS modules' },
  { key: 'restyle', label: 'Module 2 — Reference Style Check & PJPS Converter', group: 'PJPS modules' },
  { key: 'citations', label: 'Module 3 — Citations (list matching, claim support, patterns)', group: 'PJPS modules' },
  { key: 'papermill', label: 'Module 4 — Paper Mill Detection', group: 'PJPS modules', editor: true },
  { key: 'images', label: 'Module 5 — Image Integrity Detection', group: 'PJPS modules', editor: true },
  { key: 'integrity', label: 'Integrity Screening (similarity, AI text, data, pharma, ethics, authors, network, risk score)', group: 'Integrity Suite', editor: true },
  { key: 'peer-review', label: 'Peer-Review Integrity (reviewer identity, conflicts, review patterns)', group: 'Integrity Suite', editor: true },
  { key: 'monitoring', label: 'Published Article Monitoring (retractions, corrections, archive rescreening)', group: 'Integrity Suite', editor: true },
  { key: 'cases', label: 'Editorial Dashboard & Case Management', group: 'Integrity Suite', editor: true },
  { key: 'reports', label: 'Editor report (decision summary, author letters, revisions)', group: 'Editor tools', editor: true },
  { key: 'alerts', label: 'Alerts (retraction monitoring)', group: 'My Activity' }
];

// Switched off for PJPS (code kept; can be re-enabled by moving an entry back into MODULES)
const LEGACY = [
  { key: 'verify', label: 'Verify Citations (now part of Module 3)' },
  { key: 'evidence', label: 'Find Evidence' },
  { key: 'format', label: 'Manuscript Format converter' },
  { key: 'journal-finder', label: 'Find a Journal' },
  { key: 'journal-check', label: 'Check a Journal' },
  { key: 'conferences', label: 'Find & Check a Conference' },
  { key: 'assistant', label: 'Thesis / Paper Assistant' },
  { key: 'authors', label: 'Find by Author' },
  { key: 'reviewers', label: 'Reviewer Finder' },
  { key: 'reviewer-report', label: 'Reviewer report check' },
  { key: 'issues', label: 'Issue report' }
];

// Module 3 includes claim support, so a user with Citations may use the claim-verification endpoint
const IMPLIES = { citations: ['verify'] };

// Modules added in v4 / v5: granted to editors whose permissions were customised before these existed
const ADDED_V4 = ['papermill', 'images'];
const ADDED_V5 = ['integrity', 'peer-review', 'monitoring', 'cases'];

const ROLES = {
  super_admin: { label: 'Super Admin' },
  editor: { label: 'Editor' },
  researcher: { label: 'Reviewer' }
};

const ALL = MODULES.map(m => m.key);

function defaultPermissions(role) {
  if (role === 'researcher') return MODULES.filter(m => !m.editor).map(m => m.key);
  return ALL.slice();
}

function expand(list) {
  const out = new Set(list);
  for (const k of list) for (const x of IMPLIES[k] || []) out.add(x);
  return [...out];
}

/** Effective module list for a user row */
function permissionsOf(u) {
  if (!u) return [];
  if (u.role === 'super_admin') return expand(ALL);
  const p = Array.isArray(u.permissions) ? u.permissions : null;
  let list = (p || defaultPermissions(u.role)).filter(k => ALL.includes(k));
  if (p && u.role === 'editor' && !p.includes('_v4')) list = [...new Set([...list, ...ADDED_V4])];
  if (p && u.role === 'editor' && !p.includes('_v5')) list = [...new Set([...list, ...ADDED_V5])];
  return expand(list);
}

/** Permissions as stored: the v4 / v5 markers record that the new modules were offered to this user */
function storePermissions(list) {
  return [...new Set([...(list || []).filter(k => ALL.includes(k)), '_v4', '_v5'])];
}

module.exports = { MODULES, LEGACY, ROLES, ALL, defaultPermissions, permissionsOf, storePermissions };
