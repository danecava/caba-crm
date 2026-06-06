'use strict';
/*
 * auth.js — zero-dependency JWT (HMAC-SHA256) + scrypt password verify + RBAC.
 * Row-level book isolation lives in scopeForUser(): agents can only ever
 * see their own leads; managers see their downline; owner/admin see all.
 */
const crypto = require('node:crypto');
const { db } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload, ttlSeconds = 60 * 60 * 12) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let body;
  try { body = JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
  return body;
}

function checkPassword(user, pw) {
  const hash = crypto.scryptSync(pw, user.password_salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.password_hash));
}

// Set a new password for a user and clear the force-reset flag.
function setPassword(userId, newPassword) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(newPassword, salt, 32).toString('hex');
  db.prepare('UPDATE users SET password_hash=?, password_salt=?, must_change_password=0 WHERE id=?')
    .run(hash, salt, userId);
}

// Basic in-memory login rate limiting (per email). Resets on server restart.
const MAX_FAILS = 6, LOCK_MS = 15 * 60 * 1000;
const attempts = new Map(); // email -> { fails, lockedUntil }
function loginLocked(email) {
  const a = attempts.get((email || '').toLowerCase());
  if (a && a.lockedUntil && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 60000);
  return 0;
}
function recordFail(email) {
  const key = (email || '').toLowerCase();
  const a = attempts.get(key) || { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= MAX_FAILS) { a.lockedUntil = Date.now() + LOCK_MS; a.fails = 0; }
  attempts.set(key, a);
}
function recordSuccess(email) { attempts.delete((email || '').toLowerCase()); }

// Reject weak passwords.
function passwordIssue(pw) {
  if (!pw || pw.length < 10) return 'Password must be at least 10 characters.';
  if (/^changeme/i.test(pw)) return 'Choose a password that is not the default.';
  if (!/[a-z]/i.test(pw) || !/[0-9]/.test(pw)) return 'Use at least one letter and one number.';
  return null;
}

// downline ids (recursive) for a manager/owner
function downlineIds(userId) {
  const ids = new Set([userId]);
  let frontier = [userId];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      const rows = db.prepare('SELECT id FROM users WHERE upline_id = ?').all(id);
      for (const r of rows) if (!ids.has(r.id)) { ids.add(r.id); next.push(r.id); }
    }
    frontier = next;
  }
  return [...ids];
}

/*
 * Returns a SQL fragment + params that restrict a `leads` query to what the
 * user is allowed to see. This is the row-level security boundary.
 */
function leadScope(user, alias = 'leads') {
  if (user.role === 'owner' || user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'manager') {
    const ids = downlineIds(user.id);
    return { sql: `${alias}.owner_id IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  // agent / recruiter: only own book
  return { sql: `${alias}.owner_id = ?`, params: [user.id] };
}

function canSeeAllAgents(user) {
  return user.role === 'owner' || user.role === 'admin' || user.role === 'manager';
}

module.exports = { sign, verify, checkPassword, setPassword, downlineIds, leadScope, canSeeAllAgents,
  loginLocked, recordFail, recordSuccess, passwordIssue };
