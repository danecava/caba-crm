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

module.exports = { sign, verify, checkPassword, downlineIds, leadScope, canSeeAllAgents };
