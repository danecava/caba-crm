'use strict';
/*
 * admin.js — owner-only data operations: wipe demo seed data, and bulk-import
 * Dane's real book (clients -> leads+policies, recruits -> applicants).
 */
const { db, hashPassword } = require('./../db');
const insurance = require('./insurance');

// ---------- User management (owner-only) ----------
function tempPassword() { return 'Cava' + Math.floor(1000 + Math.random() * 8999) + 'x'; }

function listUsers() {
  return db.prepare(`SELECT u.id,u.name,u.email,u.role,u.upline_id,u.comp_rate,u.monthly_goal_ap,u.active,u.license_status,
    up.name AS upline_name FROM users u LEFT JOIN users up ON up.id=u.upline_id ORDER BY u.active DESC, u.role, u.name`).all();
}
function createUser(b) {
  const email = (b.email || '').toLowerCase().trim();
  if (!email || !b.name) return { error: 'Name and email required.' };
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return { error: 'A user with that email already exists.' };
  const role = ['manager', 'agent', 'recruiter', 'admin'].includes(b.role) ? b.role : 'agent';
  const tmp = tempPassword();
  const { hash, salt } = hashPassword(tmp);
  const id = db.prepare(`INSERT INTO users (name,email,password_hash,password_salt,role,upline_id,comp_rate,monthly_goal_ap,license_status,must_change_password,active)
    VALUES (?,?,?,?,?,?,?,?,?,1,1)`).run(b.name, email, hash, salt, role, b.upline_id || null,
      b.comp_rate != null ? Number(b.comp_rate) : 0, b.monthly_goal_ap != null ? Number(b.monthly_goal_ap) : 0,
      b.license_status || 'licensed').lastInsertRowid;
  return { id, email, temp_password: tmp };
}
function updateUser(id, b) {
  const fields = [], vals = [];
  for (const k of ['role', 'upline_id', 'comp_rate', 'monthly_goal_ap', 'license_status', 'name']) {
    if (b[k] !== undefined) { fields.push(`${k}=?`); vals.push(b[k]); }
  }
  if (!fields.length) return { ok: true };
  vals.push(id);
  db.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=? AND role!='owner'`).run(...vals);
  return { ok: true };
}
function setActive(id, active) {
  db.prepare("UPDATE users SET active=? WHERE id=? AND role!='owner'").run(active ? 1 : 0, id);
  return { ok: true };
}
function resetPassword(id) {
  const u = db.prepare('SELECT id,role FROM users WHERE id=?').get(id);
  if (!u || u.role === 'owner') return { error: 'Cannot reset this account here.' };
  const tmp = tempPassword();
  const { hash, salt } = hashPassword(tmp);
  db.prepare('UPDATE users SET password_hash=?,password_salt=?,must_change_password=1 WHERE id=?').run(hash, salt, id);
  return { temp_password: tmp };
}

// Remove all seeded demo data and demo user accounts, keeping the owner.
function wipeDemo() {
  const tables = ['activities','scheduled_touches','cadence_runs','messages','recruit_touches','recruit_runs',
    'recruit_messages','policies','appointments','onboarding_steps','leads','applicants','comp_grid'];
  db.exec('BEGIN');
  try {
    for (const t of tables) { try { db.exec(`DELETE FROM ${t}`); } catch {} }
    try { db.exec("DELETE FROM users WHERE role != 'owner'"); } catch {}
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  return { ok: true, remaining_users: db.prepare('SELECT COUNT(*) c FROM users').get().c };
}

const LEAD_STAGE = { 'Issued': 'Issued-Paid', 'Missed Payment': 'Issued-Paid', 'App Submitted': 'Application Submitted', 'Lost': 'Contacted' };
const POL_STATUS = { 'Issued': 'issued_paid', 'Missed Payment': 'issued_paid', 'App Submitted': 'submitted', 'Lost': 'declined' };
const PAY_STATUS = { 'Missed Payment': 'missed' };
const RECRUIT_STAGE = { 'Scheduled Call': 'Interview Booked', 'Pre-Licensing': 'Licensing In-Progress', 'Licensed': 'Appointed', 'Onboarded/Active': 'Producing', 'Dropped': 'Dropped' };

function importData(payload, ownerId) {
  const clients = payload.clients || [];
  const recruits = payload.recruits || [];
  const num = (v) => (v == null || v === '' ? null : Number(v));

  const insLead = db.prepare(`INSERT INTO leads
    (first_name,last_name,phone,email,state,product_interest,stage,owner_id,priority,premium_potential,consent_tcpa,consent_source,consent_at,last_contact_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,2,?,1,'import',?, ?, ?)`);
  const insPol = db.prepare(`INSERT INTO policies
    (lead_id,agent_id,carrier,product,policy_number,state,monthly_premium,annual_premium,comm_pct,effective_date,date_sold,payment_mode,status,payment_status,sub_status,issued_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insApp = db.prepare(`INSERT INTO applicants (name,phone,email,stage,recruiter_id,notes,last_contact_at,created_at)
    VALUES (?,?,?,?,?,?,?,?)`);

  let nClients = 0, nPolicies = 0, nRecruits = 0;
  db.exec('BEGIN');
  try {
    for (const c of clients) {
      const monthly = num(c.monthly_premium);
      const annual = monthly ? Math.round(monthly * 12) : 0;
      const stage = LEAD_STAGE[c.stage] || 'Issued-Paid';
      const lid = insLead.run(c.first_name || 'Client', c.last_name || '', null, null, c.state || null,
        c.product || null, stage, ownerId, annual, c.date_sold || null, c.date_sold || c.effective_date || null,
        c.date_sold || null).lastInsertRowid;
      nClients++;
      insPol.run(lid, ownerId, c.carrier || null, c.product || null, c.policy_number || null, c.state || null,
        monthly, annual, num(c.custom_rate), c.effective_date || null, c.date_sold || null, c.payment_mode || null,
        POL_STATUS[c.stage] || 'issued_paid', PAY_STATUS[c.stage] || 'active', c.sub_status || null,
        c.effective_date || c.date_sold || null);
      nPolicies++;
    }
    for (const r of recruits) {
      const notes = [r.notes, r.license_state ? `License: ${r.license_state}` : null].filter(Boolean).join(' · ');
      insApp.run(`${r.first_name || ''} ${r.last_name || ''}`.trim(), r.phone || null, r.email || null,
        RECRUIT_STAGE[r.stage] || 'Applied', ownerId, notes || null, null, null);
      nRecruits++;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  const gridRows = insurance.seedCompGridFromPolicies();
  return { clients: nClients, policies: nPolicies, recruits: nRecruits, comp_grid_rows: gridRows };
}

module.exports = { wipeDemo, importData, listUsers, createUser, updateUser, setActive, resetPassword };
