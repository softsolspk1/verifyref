// auth.js - editor accounts, access requests, sessions (cookie), role middleware
const crypto = require('crypto');
const db = require('./db');
const cfg = require('./config');

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

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, maxAgeSec) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const days = cfg.SESSION_DAYS;
  await db.query(`INSERT INTO sessions(token, user_id, expires_at) VALUES($1, $2, now() + ($3 || ' days')::interval)`, [token, userId, String(days)]);
  setSessionCookie(res, token, days * 86400);
}

const publicUser = u => u && ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, journal: u.journal, editorRole: u.editor_role, orcid: u.orcid });

/** Attach req.user when a valid session cookie is present */
async function sessionMiddleware(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const u = await db.one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()`, [token]);
      if (u) { req.user = u; req.sessionToken = token; }
    }
  } catch (e) { /* treat as anonymous */ }
  next();
}

function requireEditor(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, message: 'Please sign in with an editor account.' });
  if (req.user.status !== 'approved') return res.status(403).json({ success: false, message: 'Your editor access request is awaiting approval.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin' || req.user.status !== 'approved') return res.status(403).json({ success: false, message: 'Administrator access required.' });
  next();
}

// Simple in-memory throttle for login/register (per IP)
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

async function register(req, res) {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ success: false, message: 'A valid email address is required.' });
  if (!b.name || String(b.name).trim().length < 3) return res.status(400).json({ success: false, message: 'Please enter your full name.' });
  if (!b.password || String(b.password).length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  if (!b.journal || !b.editorRole) return res.status(400).json({ success: false, message: 'Journal name and editor role are required.' });
  const exists = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  if (exists) return res.status(409).json({ success: false, message: 'An account with this email already exists.' });

  // Co-editors named by an approved editor are approved automatically
  const sponsor = await db.one(`SELECT id FROM users WHERE status = 'approved' AND co_editors ILIKE $1`, [`%${email}%`]);
  const status = sponsor ? 'approved' : 'pending';
  const coEditors = String(b.coEditors || '').split(/[\s,;]+/).map(s => s.toLowerCase()).filter(validEmail).join(', ');
  const u = await db.one(`INSERT INTO users(email, name, password_hash, status, journal, editor_role, orcid, co_editors, note, approved_at)
    VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
  [email, String(b.name).trim(), hashPassword(String(b.password)), status, String(b.journal).trim(), String(b.editorRole).trim(), (b.orcid || '').trim() || null, coEditors || null, (b.note || '').trim() || null, sponsor ? new Date() : null]);
  if (status === 'approved') await createSession(res, u.id);
  res.json({ success: true, user: publicUser(u), message: status === 'approved' ? 'Your account is active (co-editor of an approved editor).' : 'Request received. An administrator will verify your editor role and approve access.' });
}

async function login(req, res) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const u = await db.one('SELECT * FROM users WHERE email = $1', [email]);
  if (!u || !verifyPassword(String(req.body?.password || ''), u.password_hash)) return res.status(401).json({ success: false, message: 'Incorrect email or password.' });
  if (u.status === 'rejected' || u.status === 'disabled') return res.status(403).json({ success: false, message: 'This account does not have access.' });
  await createSession(res, u.id);
  res.json({ success: true, user: publicUser(u) });
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
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(String(next)), req.user.id]);
  await db.query('DELETE FROM sessions WHERE user_id = $1 AND token <> $2', [req.user.id, req.sessionToken]);
  res.json({ success: true });
}

/** Create the first administrator from ADMIN_EMAIL / ADMIN_PASSWORD when none exists */
async function seedAdmin() {
  const admin = await db.one("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (admin || !cfg.ADMIN_EMAIL || !cfg.ADMIN_PASSWORD) return;
  const email = cfg.ADMIN_EMAIL.toLowerCase();
  const existing = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) {
    await db.query("UPDATE users SET role = 'admin', status = 'approved', approved_at = now() WHERE id = $1", [existing.id]);
  } else {
    await db.query(`INSERT INTO users(email, name, password_hash, role, status, journal, editor_role, approved_at)
      VALUES($1, 'Administrator', $2, 'admin', 'approved', $3, 'Administrator', now())`, [email, hashPassword(cfg.ADMIN_PASSWORD), cfg.HOME_JOURNAL.name]);
  }
  console.log(`Administrator account ready: ${email}`);
}

module.exports = { sessionMiddleware, requireEditor, requireAdmin, throttle, register, login, logout, changePassword, seedAdmin, publicUser, hashPassword };
