'use strict';
/*
 * db.js — single source of truth.
 * Zero-dependency persistence using Node 22's built-in node:sqlite.
 * Creates schema on first boot and seeds realistic telesales-life data.
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'caba-crm.db');
const db = new DatabaseSync(DB_PATH);
// WAL is faster but needs shared-memory the host FS may not support; the
// default rollback journal works everywhere. Override with DB_JOURNAL=WAL on
// a local disk (e.g. macOS APFS) for higher write throughput.
try { db.exec(`PRAGMA journal_mode = ${process.env.DB_JOURNAL || 'DELETE'};`); } catch {}
db.exec('PRAGMA foreign_keys = ON;');

// ---------- password hashing (scrypt, no external deps) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return { hash, salt };
}

// ---------- schema ----------
function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','manager','agent','recruiter','admin')),
    upline_id INTEGER REFERENCES users(id),
    license_status TEXT DEFAULT 'licensed',
    monthly_goal_ap INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    must_change_password INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    channel TEXT,            -- meta / manychat / referral / organic
    cta_keyword TEXT,        -- e.g. PROTECT (client) or RECRUIT (recruit funnel)
    funnel TEXT DEFAULT 'client' CHECK(funnel IN ('client','recruit')),
    spend REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    state TEXT,
    product_interest TEXT,            -- term / final_expense / mortgage_protection / iul
    stage TEXT NOT NULL DEFAULT 'New',
    owner_id INTEGER REFERENCES users(id),
    source_id INTEGER REFERENCES sources(id),
    priority INTEGER DEFAULT 2,       -- 1 hot, 2 warm, 3 cold
    premium_potential INTEGER DEFAULT 0, -- estimated annual premium $
    consent_tcpa INTEGER DEFAULT 0,
    consent_source TEXT,
    consent_at TEXT,
    dnc INTEGER DEFAULT 0,
    health_notes TEXT,
    beneficiaries TEXT,
    score REAL DEFAULT 0,
    last_contact_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES users(id),
    type TEXT NOT NULL,               -- call / sms / email / note / stage_change
    outcome TEXT,                     -- connected / no_answer / voicemail / dnc / sold ...
    body TEXT,
    next_step TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS applicants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    stage TEXT NOT NULL DEFAULT 'Applied',
    recruiter_id INTEGER REFERENCES users(id),
    source_id INTEGER REFERENCES sources(id),
    notes TEXT,
    last_contact_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id),
    agent_id INTEGER REFERENCES users(id),
    carrier TEXT,
    product TEXT,
    annual_premium INTEGER DEFAULT 0,
    status TEXT DEFAULT 'submitted' CHECK(status IN ('submitted','issued_paid','lapsed','declined')),
    persistency INTEGER DEFAULT 1,
    issued_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER REFERENCES leads(id),
    agent_id INTEGER REFERENCES users(id),
    scheduled_at TEXT,
    status TEXT DEFAULT 'scheduled'
  );

  CREATE TABLE IF NOT EXISTS onboarding_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER REFERENCES users(id),
    step TEXT,
    done INTEGER DEFAULT 0,
    done_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
  CREATE INDEX IF NOT EXISTS idx_act_lead ON activities(lead_id);
  CREATE INDEX IF NOT EXISTS idx_pol_agent ON policies(agent_id);
  `);
}

// ---------- seed ----------
function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (count > 0) return;

  const mk = db.prepare(`INSERT INTO users (name,email,password_hash,password_salt,role,upline_id,license_status,monthly_goal_ap)
                         VALUES (?,?,?,?,?,?,?,?)`);
  function addUser(name, email, role, upline, goal, license = 'licensed') {
    const { hash, salt } = hashPassword('changeme123');
    return mk.run(name, email, hash, salt, role, upline, license, goal).lastInsertRowid;
  }

  // Owner + team. Default password for everyone: changeme123
  const owner = addUser('Dane (Owner)', 'dane@cabalife.com', 'owner', null, 0);
  const mgr   = addUser('Marcus Lee (Manager)', 'marcus@cabalife.com', 'manager', owner, 30000);
  const a1 = addUser('Jasmine Cole', 'jasmine@cabalife.com', 'agent', mgr, 25000);
  const a2 = addUser('Tyrell Banks', 'tyrell@cabalife.com', 'agent', mgr, 25000);
  const a3 = addUser('Priya Nair', 'priya@cabalife.com', 'agent', mgr, 20000, 'in_progress');
  const a4 = addUser('Diego Ramos', 'diego@cabalife.com', 'agent', owner, 25000);
  const rec = addUser('Bianca Ford (Recruiter)', 'bianca@cabalife.com', 'recruiter', owner, 0);
  const agents = [a1, a2, a3, a4];

  const src = db.prepare(`INSERT INTO sources (name,channel,cta_keyword,funnel,spend) VALUES (?,?,?,?,?)`);
  const sMeta   = src.run('Meta — Mortgage Protection', 'meta', 'PROTECT', 'client', 1800).lastInsertRowid;
  const sFE     = src.run('Meta — Final Expense', 'meta', 'PEACE', 'client', 1200).lastInsertRowid;
  const sMany   = src.run('ManyChat — Term DM', 'manychat', 'QUOTE', 'client', 0).lastInsertRowid;
  const sRef    = src.run('Client Referral', 'referral', null, 'client', 0).lastInsertRowid;
  const sRecruit= src.run('Meta — Agent Recruiting', 'meta', 'RECRUIT', 'recruit', 900).lastInsertRowid;
  const clientSources = [sMeta, sFE, sMany, sRef];

  const stages = ['New','Contacted','Quoted','Application Submitted','Underwriting','Issued-Paid','Retention'];
  const products = ['mortgage_protection','final_expense','term','iul'];
  const states = ['TX','FL','GA','OH','NC','AZ','TN','MO'];
  const firsts = ['James','Maria','Robert','Linda','Michael','Patricia','David','Jennifer','William','Angela','Carlos','Tanya','Kevin','Denise','Brian','Latoya','Steven','Monica','Eric','Rachel','Andre','Crystal','Marcus','Shanice'];
  const lasts  = ['Johnson','Williams','Brown','Davis','Miller','Wilson','Moore','Taylor','Anderson','Thomas','Jackson','Harris','Martin','Garcia','Robinson','Clark','Lewis','Walker','Hall','Young'];

  const insLead = db.prepare(`INSERT INTO leads
    (first_name,last_name,phone,email,state,product_interest,stage,owner_id,source_id,priority,premium_potential,consent_tcpa,consent_source,consent_at,health_notes,last_contact_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insAct = db.prepare(`INSERT INTO activities (lead_id,agent_id,type,outcome,body,next_step,created_at) VALUES (?,?,?,?,?,?,?)`);
  const insPol = db.prepare(`INSERT INTO policies (lead_id,agent_id,carrier,product,annual_premium,status,issued_at) VALUES (?,?,?,?,?,?,?)`);

  const carriers = ['Americo','Mutual of Omaha','Foresters','GTL','SBLI','Transamerica'];
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString().replace('T',' ').slice(0,19);
  const daysAgo  = (d) => hoursAgo(d * 24);

  let made = 0;
  for (let i = 0; i < 80; i++) {
    const owner_id = rnd(agents);
    // weight pipeline toward the top of funnel
    const r = Math.random();
    let stage;
    if (r < 0.30) stage = 'New';
    else if (r < 0.50) stage = 'Contacted';
    else if (r < 0.68) stage = 'Quoted';
    else if (r < 0.80) stage = 'Application Submitted';
    else if (r < 0.88) stage = 'Underwriting';
    else if (r < 0.96) stage = 'Issued-Paid';
    else stage = 'Retention';

    const product = rnd(products);
    const premium = 400 + Math.floor(Math.random() * 2600); // $400–$3000 AP
    const priority = stage === 'Quoted' || stage === 'Application Submitted' ? 1 : (Math.random() < 0.4 ? 1 : 2);
    const ageH = Math.floor(Math.random() * 96); // touched within last 0–96h
    const last = stage === 'New' ? null : hoursAgo(ageH);
    const created = daysAgo(Math.floor(Math.random() * 21));
    const consent = Math.random() < 0.9 ? 1 : 0;
    const lid = insLead.run(
      rnd(firsts), rnd(lasts),
      '555' + String(1000000 + Math.floor(Math.random() * 8999999)).slice(0,7),
      'lead' + i + '@example.com',
      rnd(states), product, stage, owner_id, rnd(clientSources),
      priority, premium, consent, consent ? 'web_form' : null, consent ? created : null,
      'No major health flags noted', last, created
    ).lastInsertRowid;

    // a couple of activities for non-New leads
    if (stage !== 'New') {
      insAct.run(lid, owner_id, 'call', rnd(['connected','no_answer','voicemail']), 'Outbound dial', 'Follow up', hoursAgo(ageH + 2));
      if (Math.random() < 0.6) insAct.run(lid, owner_id, 'sms', 'sent', 'Speed-to-lead text', null, hoursAgo(ageH + 3));
    }
    // policies for advanced stages
    if (stage === 'Issued-Paid' || stage === 'Retention') {
      insPol.run(lid, owner_id, rnd(carriers), product, premium, 'issued_paid', daysAgo(Math.floor(Math.random() * 25)));
    } else if (stage === 'Application Submitted' || stage === 'Underwriting') {
      insPol.run(lid, owner_id, rnd(carriers), product, premium, 'submitted', daysAgo(Math.floor(Math.random() * 7)));
    }
    made++;
  }

  // Lapse a few issued policies so persistency + chargebacks have data
  const issuedIds = db.prepare("SELECT id FROM policies WHERE status='issued_paid'").all();
  for (let k = 0; k < Math.min(4, issuedIds.length); k++) {
    const pid = issuedIds[Math.floor(Math.random() * issuedIds.length)].id;
    db.prepare("UPDATE policies SET status='lapsed' WHERE id=?").run(pid);
  }

  // Recruiting pipeline
  const recStages = ['Applied','Interview Booked','Offer/Contract','Licensing In-Progress','Appointed','Onboarding','Producing'];
  const insApp = db.prepare(`INSERT INTO applicants (name,phone,email,stage,recruiter_id,source_id,notes,last_contact_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
  const recruitNames = ['Aaron Pierce','Nicole Tran','Devin Ward','Sasha Obi','Marcus Field','ELI Stone','Brooke Hayes','Carl Dunn','Mia Russo','Trent Cole','Kayla Brooks','Omar Haddad'];
  for (let i = 0; i < recruitNames.length; i++) {
    const st = recStages[Math.min(recStages.length - 1, Math.floor(Math.random() * recStages.length))];
    insApp.run(recruitNames[i], '555' + String(2000000 + i * 4321).slice(0,7), 'recruit' + i + '@example.com',
      st, rec, sRecruit, 'Inbound from recruiting ad', hoursAgo(Math.floor(Math.random() * 72)), daysAgo(Math.floor(Math.random() * 30)));
  }

  // Onboarding steps for the in-progress agent
  const obSteps = ['Pre-licensing course','State exam passed','Carrier appointments','CRM access','Scripts certified','First 10 supervised dials'];
  const insOb = db.prepare(`INSERT INTO onboarding_steps (agent_id,step,done,done_at) VALUES (?,?,?,?)`);
  obSteps.forEach((s, idx) => insOb.run(a3, s, idx < 3 ? 1 : 0, idx < 3 ? daysAgo(10 - idx) : null));

  console.log(`[seed] created team + ${made} leads + ${recruitNames.length} applicants. Default password: changeme123`);
}

// Migration: ensure must_change_password exists on databases created before
// auth hardening, and force every existing account to reset on next login.
function migrateAuth() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 1');
    db.exec('UPDATE users SET must_change_password = 1');
    console.log('[migrate] added must_change_password; all accounts must reset password on next login');
  }
}

init();
seedIfEmpty();
migrateAuth();

module.exports = { db, hashPassword };
