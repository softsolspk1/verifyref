// scripts/create-test-users.js - one active test account per user type (Super Admin, Editor, Reviewer) with web and
// desktop access and the role's default tools. Run again to reset their passwords. The credentials are written to
// test-users.local.txt (git-ignored), not printed.
// Usage: node scripts/create-test-users.js [--domain verifyref.test]
require('../src/config');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../src/db');
const auth = require('../src/auth');

const args = process.argv.slice(2);
const domain = args.includes('--domain') ? args[args.indexOf('--domain') + 1] : 'verifyref.test';
const OUT = path.join(__dirname, '..', 'test-users.local.txt');

const USERS = [
  { role: 'super_admin', email: `test.superadmin@${domain}`, name: 'Test Super Admin', designation: 'Test account — Super Admin' },
  { role: 'editor', email: `test.editor@${domain}`, name: 'Test Editor', designation: 'Test account — Editor' },
  { role: 'researcher', email: `test.reviewer@${domain}`, name: 'Test Reviewer', designation: 'Test account — Reviewer' }
];

const password = () => `Pjps-${crypto.randomBytes(6).toString('base64url')}-${crypto.randomInt(10, 99)}`;

(async () => {
  await db.init();
  const admin = await db.one("SELECT id FROM users WHERE role = 'super_admin' AND created_by IS NULL ORDER BY id LIMIT 1");
  const lines = [`PJPS Data Integrity System — test accounts (${new Date().toISOString()})`, 'Web: https://verifyref.vercel.app   Desktop: same e-mail and password', ''];
  for (const u of USERS) {
    const pw = password();
    const existing = await db.one('SELECT id FROM users WHERE email = $1', [u.email]);
    if (existing) {
      await db.query(`UPDATE users SET name = $1, role = $2, status = 'active', designation = $3, journal = 'PJPS (test)', permissions = NULL, allow_web = true, allow_desktop = true,
        must_change_password = false, password_hash = $4 WHERE id = $5`, [u.name, u.role, u.designation, auth.hashPassword(pw), existing.id]);
    } else {
      await db.query(`INSERT INTO users(email, name, password_hash, role, status, journal, designation, allow_web, allow_desktop, offline_days, must_change_password, created_by, approved_at)
        VALUES($1, $2, $3, $4, 'active', 'PJPS (test)', $5, true, true, 14, false, $6, now())`, [u.email, u.name, auth.hashPassword(pw), u.role, u.designation, admin?.id || null]);
    }
    await db.query("INSERT INTO audit_log(actor_id, action, target, details, channel) VALUES($1, $2, $3, $4, 'script')",
      [admin?.id || null, existing ? 'test-user-reset' : 'test-user-created', u.email, JSON.stringify({ role: u.role })]).catch(() => {});
    lines.push(`${u.name.padEnd(18)} ${u.email.padEnd(34)} ${pw}`);
    console.log(`${existing ? 'reset  ' : 'created'} ${u.email} (${u.role})`);
  }
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`Credentials written to ${OUT}`);
  await db.close();
})().catch(e => { console.error(e.message); process.exit(1); });
