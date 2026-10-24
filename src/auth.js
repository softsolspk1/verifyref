// auth.js - accounts created by the Super Admin, sessions (cookie), role / module / channel checks, audit log
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');
const { permissionsOf, ROLES } = require('./modules');

const COOKIE = 'pjps_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, maxAgeSec) {
  const secure = process.env.COOKIE_SECURE === 'true' || ['production', 'preview'].includes(process.env.VERCEL_ENV) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const days = cfg.SESSION_DAYS;
  await db.query(`INSERT INTO sessions(token, user_id, expires_at) VALUES($1, $2, now() + ($3 || ' days')::interval)`, [token, userId, String(days)]);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  setSessionCookie(res, token, days * 86400);
  return token;
}

const publicUser = u => u && ({
  id: u.id, email: u.email, name: u.name, role: u.role, roleLabel: ROLES[u.role]?.label || u.role, status: u.status,
  journal: u.journal, editorRole: u.editor_role, designation: u.designation, orcid: u.orcid,
  permissions: permissionsOf(u), allowWeb: u.allow_web, allowDesktop: u.allow_desktop, offlineDays: u.offline_days,
  mustChangePassword: !!u.must_change_password, offlineUntil: u.offline_until || null, emailAlerts: u.email_alerts !== false
});

const isSuper = u => u?.role === 'super_admin';

/** Can this account use the current channel (web server vs desktop app)? */
function channelAllowed(u) {
  if (u.status !== 'active') return false;
  if (isSuper(u)) return true;
  return cfg.DESKTOP ? !!u.allow_desktop : !!u.allow_web;
}

/** Attach req.user when a valid session cookie is present */
async function sessionMiddleware(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const u = await db.one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()`, [token]);
      if (u && channelAllowed(u)) { req.user = u; req.sessionToken = token; }
    }
  } catch (e) { /* treat as anonymous */ }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Please sign in.' });
  if (cfg.DESKTOP && req.user.offline_until && new Date(req.user.offline_until) < new Date() && !require('./http').isOnline()) {
    return res.status(401).json({ success: false, message: 'The offline period allowed for your account has ended. Connect to the internet and sign in again.' });
  }
  next();
}

/** Route guard: signed in and allowed to use the given module(s) (any of them) */
function requireModule(...keys) {
  return (req, res, next) => requireUser(req, res, () => {
    const perms = permissionsOf(req.user);
    if (!keys.some(k => perms.includes(k))) return res.status(403).json({ success: false, message: 'Your account does not have access to this tool. Ask the Super Admin to enable it.' });
    next();
  });
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || !isSuper(req.user)) return res.status(403).json({ success: false, message: 'Super Admin access required.' });
  next();
}

// Simple in-memory throttle for sign-in (per IP)
const attempts = new Map();
function throttle(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60000);
  if (list.length >= 20) return res.status(429).json({ success: false, message: 'Too many attempts. Please try again in 15 minutes.' });
  list.push(now);
  attempts.set(ip, list);
  next();
}

const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

/** Record an administrative or security event */
function audit(req, action, target = null, details = null) {
  const u = req?.user;
  return db.query('INSERT INTO audit_log(actor_id, actor_email, action, target, details, ip, channel) VALUES($1, $2, $3, $4, $5, $6, $7)',
    [u?.id || null, u?.email || details?.email || null, action, target, details ? JSON.stringify(details) : null, req?.ip || null, cfg.DESKTOP ? 'desktop' : 'web']).catch(() => {});
}

/** Check e-mail + password against the users table; returns { user } or { status, message } */
async function checkCredentials(email, password) {
  const u = await db.one('SELECT * FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
  if (!u || !verifyPassword(String(password || ''), u.password_hash)) return { status: 401, message: 'Incorrect email or password.' };
  if (u.status !== 'active') return { status: 403, message: 'This account is suspended. Contact the Super Admin.' };
  return { user: u };
}

async function login(req, res) {
  if (cfg.DESKTOP) return require('./desktop').login(req, res);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const r = await checkCredentials(email, req.body?.password);
  if (!r.user) {
    await audit(req, 'login-failed', email, { email });
    return res.status(r.status).json({ success: false, message: r.message });
  }
  if (!isSuper(r.user) && !r.user.allow_web) {
    return res.status(403).json({ success: false, message: 'Your account is enabled for the desktop application only. Ask the Super Admin for web access.' });
  }
  await createSession(res, r.user.id);
  req.user = r.user;
  await audit(req, 'login', email);
  res.json({ success: true, user: publicUser(r.user) });
}

async function logout(req, res) {
  if (req.sessionToken) await db.query('DELETE FROM sessions WHERE token = $1', [req.sessionToken]);
  setSessionCookie(res, '', 0);
  res.json({ success: true });
}

async function changePassword(req, res) {
  const { current, next } = req.body || {};
  if (!verifyPassword(String(current || ''), req.user.password_hash)) return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
  if (!next || String(next).length < 8) return res.status(400).json({ success: false, message: 'New password must be at least 8 characters.' });
  if (cfg.DESKTOP) return require('./desktop').changePassword(req, res, String(current), String(next));
  await db.query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [hashPassword(String(next)), req.user.id]);
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.user.id, req.sessionToken]);
  await audit(req, 'password-changed', req.user.email);
  res.json({ success: true });
}

/** Create the first Super Admin from ADMIN_EMAIL / ADMIN_PASSWORD when none exists (web/server edition only) */
async function seedAdmin() {
  if (cfg.DESKTOP) return;
  const admin = await db.one("SELECT id FROM users WHERE role = 'super_admin' LIMIT 1");
  if (admin || !cfg.ADMIN_EMAIL || !cfg.ADMIN_PASSWORD) return;
  const email = cfg.ADMIN_EMAIL.toLowerCase();
  const existing = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    await db.query("UPDATE users SET role = 'super_admin', status = 'active', allow_web = true, allow_desktop = true WHERE id = $1", [existing.id]);
  } else {
    await db.query(`INSERT INTO users(email, name, password_hash, role, status, journal, editor_role, designation, allow_web, allow_desktop, approved_at)
      VALUES($1, 'Super Admin', $2, 'super_admin', 'active', $3, 'Super Admin', 'Super Admin', true, true, now())`, [email, hashPassword(cfg.ADMIN_PASSWORD), cfg.HOME_JOURNAL.name]);
  }
  console.log(`Super Admin account ready: ${email}`);
}

module.exports = {
  sessionMiddleware, requireUser, requireModule, requireSuperAdmin, throttle, login, logout, changePassword, seedAdmin,
  publicUser, hashPassword, verifyPassword, checkCredentials, createSession, audit, validEmail, isSuper, sha256, channelAllowed, COOKIE
};
