'use strict';
/*
 * engine.js — Phase 2 automation: speed-to-lead, cadence scheduling, the
 * runner that fires due touches through a compliance gate, opt-out / pause.
 *
 * SEND IS SIMULATED. Every outbound is written to the `messages` table and the
 * lead timeline with status 'sent' (or 'blocked' + reason). To go live, replace
 * deliver() with a Twilio/WAVV call — that's the only line that changes.
 */
const { db } = require('../db');
const C = require('./cadences');

const AGENCY = process.env.AGENCY_NAME || 'Caba Life';
const nowISO = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const toISO = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const titleize = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS cadence_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    cadence_key TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','done')),
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS scheduled_touches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES cadence_runs(id) ON DELETE CASCADE,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    step_index INTEGER,
    channel TEXT,                 -- sms / email / call_task
    due_at TEXT,
    status TEXT DEFAULT 'scheduled', -- scheduled / sent / done / skipped / canceled
    reason TEXT,
    subject TEXT,
    body TEXT,
    sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    direction TEXT,               -- out / in
    channel TEXT,
    subject TEXT,
    body TEXT,
    status TEXT,                  -- sent / blocked / received
    block_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_touch_due ON scheduled_touches(status, due_at);
  CREATE INDEX IF NOT EXISTS idx_touch_lead ON scheduled_touches(lead_id);
  CREATE INDEX IF NOT EXISTS idx_msg_lead ON messages(lead_id);
  `);
}

function ctxFor(lead) {
  const agent = lead.owner_id ? db.prepare('SELECT name FROM users WHERE id=?').get(lead.owner_id) : null;
  return {
    first: lead.first_name,
    agent: agent ? agent.name.split(' ')[0] : 'your agent',
    agency: AGENCY,
    product: titleize(lead.product_interest || 'life insurance'),
  };
}

// Enqueue a full cadence for a lead (cancels any existing active run first).
function enqueueCadence(leadId, key = C.STANDARD.key) {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(leadId);
  if (!lead) return null;
  const cad = C.CADENCES[key]; if (!cad) return null;
  // pause/cancel prior runs so we never double-fire
  pauseLead(leadId, 'reset');
  const runId = db.prepare("INSERT INTO cadence_runs (lead_id,cadence_key,status) VALUES (?,?,'active')").run(leadId, key).lastInsertRowid;
  const ctx = ctxFor(lead);
  const base = Date.now();
  const ins = db.prepare(`INSERT INTO scheduled_touches (run_id,lead_id,step_index,channel,due_at,subject,body) VALUES (?,?,?,?,?,?,?)`);
  cad.steps.forEach((s, i) => {
    let due = new Date(base + s.offsetMin * 60000);
    if (s.channel !== 'email') due = C.nextAllowed(due, lead.state); // quiet-hours align sms + calls
    ins.run(runId, leadId, i, s.channel, toISO(due), C.fill(s.subject, ctx), C.fill(s.body, ctx));
  });
  return runId;
}

// Simulated delivery. <-- swap this body for Twilio/WAVV to go live.
function deliver(lead, channel, subject, body) {
  // returns {ok, reason}
  return { ok: true };
}

// Compliance gate — returns {allow, reason}
function gate(lead, channel, when = new Date()) {
  if (lead.dnc) return { allow: false, reason: 'dnc' };
  if ((channel === 'sms' || channel === 'email') && !lead.consent_tcpa) return { allow: false, reason: 'no_consent' };
  if ((channel === 'sms' || channel === 'call_task') && !C.isWithinQuietHours(when, lead.state)) return { allow: false, reason: 'quiet_hours' };
  return { allow: true };
}

function logMessage(leadId, direction, channel, subject, body, status, reason) {
  db.prepare(`INSERT INTO messages (lead_id,direction,channel,subject,body,status,block_reason) VALUES (?,?,?,?,?,?,?)`)
    .run(leadId, direction, channel, subject || null, body || null, status, reason || null);
}
function logActivity(leadId, agentId, type, outcome, body) {
  db.prepare('INSERT INTO activities (lead_id,agent_id,type,outcome,body) VALUES (?,?,?,?,?)').run(leadId, agentId, type, outcome, body);
}

// Process all due automated touches (sms/email). call_task touches are left for
// the agent's Today queue. Returns a summary for logging/testing.
function processDue(limit = 200) {
  const due = db.prepare(`
    SELECT t.*, l.* , t.id AS touch_id, t.channel AS t_channel, t.body AS t_body, t.subject AS t_subject
    FROM scheduled_touches t
    JOIN leads l ON l.id = t.lead_id
    JOIN cadence_runs r ON r.id = t.run_id AND r.status='active'
    WHERE t.status='scheduled' AND t.channel IN ('sms','email') AND t.due_at <= datetime('now')
    ORDER BY t.due_at ASC LIMIT ?`).all(limit);
  let sent = 0, blocked = 0, deferred = 0;
  const now = new Date();
  for (const row of due) {
    const lead = { id: row.lead_id, dnc: row.dnc, consent_tcpa: row.consent_tcpa, state: row.state, owner_id: row.owner_id };
    const g = gate(lead, row.t_channel, now);
    if (!g.allow) {
      if (g.reason === 'quiet_hours') {
        const next = C.nextAllowed(now, row.state);
        db.prepare("UPDATE scheduled_touches SET due_at=? WHERE id=?").run(toISO(next), row.touch_id);
        deferred++;
        continue;
      }
      db.prepare("UPDATE scheduled_touches SET status='skipped', reason=? WHERE id=?").run(g.reason, row.touch_id);
      logMessage(row.lead_id, 'out', row.t_channel, row.t_subject, row.t_body, 'blocked', g.reason);
      blocked++;
      continue;
    }
    const res = deliver(lead, row.t_channel, row.t_subject, row.t_body);
    db.prepare("UPDATE scheduled_touches SET status='sent', sent_at=datetime('now') WHERE id=?").run(row.touch_id);
    logMessage(row.lead_id, 'out', row.t_channel, row.t_subject, row.t_body, res.ok ? 'sent' : 'blocked', res.reason);
    logActivity(row.lead_id, row.owner_id, row.t_channel, 'auto_sent', (row.t_channel === 'email' ? '[email] ' : '[sms] ') + (row.t_body || ''));
    sent++;
  }
  // close out runs whose touches are all resolved
  db.exec(`UPDATE cadence_runs SET status='done' WHERE status='active' AND id NOT IN
           (SELECT run_id FROM scheduled_touches WHERE status='scheduled')`);
  return { sent, blocked, deferred, considered: due.length };
}

// Speed-to-lead: start the cadence and immediately fire the instant touches.
function speedToLead(leadId) {
  enqueueCadence(leadId);
  return processDue();
}

// Agent action queue: due call tasks (+ overdue), newest first.
function tasksForScope(scopeSql, params) {
  return db.prepare(`
    SELECT t.id AS touch_id, t.due_at, t.body, t.channel, l.id AS lead_id, l.first_name, l.last_name,
           l.phone, l.email, l.stage, l.product_interest, l.premium_potential, l.priority, l.state,
           l.last_contact_at, l.owner_id, u.name AS owner_name
    FROM scheduled_touches t
    JOIN leads l ON l.id=t.lead_id
    LEFT JOIN users u ON u.id=l.owner_id
    JOIN cadence_runs r ON r.id=t.run_id AND r.status='active'
    WHERE t.status='scheduled' AND t.channel='call_task' AND t.due_at <= datetime('now')
      AND ${scopeSql}
    ORDER BY t.due_at ASC LIMIT 100`).all(...params);
}

function completeTouch(touchId, agentId) {
  const t = db.prepare('SELECT * FROM scheduled_touches WHERE id=?').get(touchId);
  if (!t) return false;
  db.prepare("UPDATE scheduled_touches SET status='done', sent_at=datetime('now') WHERE id=?").run(touchId);
  logActivity(t.lead_id, agentId, t.channel === 'call_task' ? 'call' : t.channel, 'completed', t.body);
  db.prepare("UPDATE leads SET last_contact_at=datetime('now') WHERE id=?").run(t.lead_id);
  return true;
}

// Pause cadence + cancel future scheduled touches (reply / stage-change / opt-out).
function pauseLead(leadId, reason = 'paused') {
  db.prepare("UPDATE cadence_runs SET status='paused' WHERE lead_id=? AND status='active'").run(leadId);
  db.prepare("UPDATE scheduled_touches SET status='canceled', reason=? WHERE lead_id=? AND status='scheduled'").run(reason, leadId);
}

function recordReply(leadId, body, agentId) {
  logMessage(leadId, 'in', 'sms', null, body, 'received', null);
  if (C.isOptOut(body)) return optOut(leadId, agentId);
  pauseLead(leadId, 'lead_replied');
  logActivity(leadId, agentId, 'note', 'inbound', 'Lead replied — cadence paused: ' + body);
  return { optedOut: false, paused: true };
}

function optOut(leadId, agentId) {
  db.prepare('UPDATE leads SET dnc=1, consent_tcpa=0 WHERE id=?').run(leadId);
  pauseLead(leadId, 'opt_out');
  logActivity(leadId, agentId, 'note', 'opt_out', 'Lead opted out (STOP) — DNC set, all automation halted.');
  return { optedOut: true };
}

function leadComms(leadId) {
  const messages = db.prepare('SELECT * FROM messages WHERE lead_id=? ORDER BY created_at DESC LIMIT 50').all(leadId);
  const upcoming = db.prepare("SELECT * FROM scheduled_touches WHERE lead_id=? AND status='scheduled' ORDER BY due_at ASC LIMIT 20").all(leadId);
  const run = db.prepare("SELECT * FROM cadence_runs WHERE lead_id=? ORDER BY id DESC LIMIT 1").get(leadId);
  return { messages, upcoming, cadence: run ? run.status : 'none' };
}

module.exports = {
  init, enqueueCadence, processDue, speedToLead, tasksForScope, completeTouch,
  pauseLead, recordReply, optOut, leadComms, AGENCY,
};
