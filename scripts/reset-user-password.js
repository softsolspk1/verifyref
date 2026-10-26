// scripts/reset-user-password.js - set a new password for one user (hashed with the portal's scrypt) and force a change at next login.
// Usage: node scripts/reset-user-password.js <email> <new-password>
require('../src/config');
const db = require('../src/db');
const auth = require('../src/auth');

(async () => {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) throw new Error('Usage: node scripts/reset-user-password.js <email> <new-password>');
  const u = await db.one('SELECT id, email, role, status FROM users WHERE lower(email) = lower($1)', [email]);
  if (!u) throw new Error(`No user with e-mail ${email}`);
  await db.query('UPDATE users SET password_hash = $1, must_change_password = true WHERE id = $2', [auth.hashPassword(password), u.id]);
  console.log(`Password reset for ${u.email} (${u.role}, ${u.status}); change required at next login.`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
