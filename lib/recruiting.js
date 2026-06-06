'use strict';
/*
 * recruiting.js — Phase 3. The growth engine: treat agent recruiting exactly
 * like lead gen. Applicant speed-to-lead + nurture cadence, onboarding/ramp
 * tracking, funnel analytics, and the "agent-in-a-box" resource hub.
 *
 * Sends are SIMULATED (same as the client engine) — swap deliver() to go live.
 */
const { db } = require('../db');
const C = require('./cadences');

const AGENCY = process.env.AGENCY_NAME || 'Cava Life';
const toISO = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

// 5-touch recruiting nurture — "a day in the life at the agency".
const RECRUIT_CADENCE = [
  { offsetMin: 0,       channel: 'sms',          body: "Hey {first}, it's {recruiter} with {agency} — saw your application to join our agency. Got 10 min for a quick call about how our agents are writing $20K+/mo? Reply STOP to opt out." },
  { offsetMin: 0,       channel: 'email',        subject: "Your application to {agency}", body: "Hi {first}, thanks for applying. We hand our agents leads, a CRM that tells them who to call, scripts that handle every objection, and content that builds their name. Let's find 15 min to see if it's a fit. — {recruiter}" },
  { offsetMin: 0,       channel: 'recruit_call', body: "Speed-to-recruit call — call the applicant within minutes while interest is hot." },
  { offsetMin: 60 * 3,  channel: 'recruit_call', body: "Second attempt — book the interview." },
  { offsetMin: 60 * 24, channel: 'sms',          body: "{first}, still want to talk about joining {agency}? I can show you exactly what a producing agent's week looks like. — {recruiter}" },
  { offsetMin: 60 * 72, channel: 'sms',          body: "Last check-in {first} — should I hold an interview slot for you this week or close out your application? — {recruiter}" },
];

const ONBOARDING_TEMPLATE = [
  'Pre-licensing course', 'State exam passed', 'Carrier appointments',
  'E-signed agent agreement', 'CRM access + profile', 'Scripts certified',
  'First 10 supervised dials', 'First application submitted',
];

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS recruit_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant_id INTEGER REFERENCES applicants(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','done')),
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS recruit_touches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER REFERENCES recruit_runs(id) ON DELETE CASCADE,
    applicant_id INTEGER REFERENCES applicants(id) ON DELETE CASCADE,
    channel TEXT, due_at TEXT, status TEXT DEFAULT 'scheduled',
    reason TEXT, subject TEXT, body TEXT, sent_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS recruit_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    applicant_id INTEGER REFERENCES applicants(id) ON DELETE CASCADE,
    direction TEXT, channel TEXT, subject TEXT, body TEXT,
    status TEXT, block_reason TEXT, created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_rtouch_due ON recruit_touches(status, due_at);
  `);
  backfillOnboarding();
}

// Ensure every active agent has the standard onboarding checklist.
function backfillOnboarding() {
  const agents = db.prepare("SELECT id, created_at FROM users WHERE role='agent' AND active=1").all();
  const ins = db.prepare('INSERT INTO onboarding_steps (agent_id,step,done,done_at) VALUES (?,?,?,?)');
  for (const a of agents) {
    const have = db.prepare('SELECT COUNT(*) c FROM onboarding_steps WHERE agent_id=?').get(a.id).c;
    if (have) continue;
    // licensed agents: mark the early steps done; in-progress: fewer.
    const lic = db.prepare('SELECT license_status FROM users WHERE id=?').get(a.id).license_status;
    const doneCount = lic === 'licensed' ? 6 : 3;
    ONBOARDING_TEMPLATE.forEach((step, i) => ins.run(a.id, step, i < doneCount ? 1 : 0, i < doneCount ? a.created_at : null));
  }
}

function ctxFor(applicant) {
  const rec = applicant.recruiter_id ? db.prepare('SELECT name FROM users WHERE id=?').get(applicant.recruiter_id) : null;
  return { first: (applicant.name || '').split(' ')[0], recruiter: rec ? rec.name.split(' ')[0] : 'our team', agency: AGENCY };
}

function enqueue(applicantId) {
  const ap = db.prepare('SELECT * FROM applicants WHERE id=?').get(applicantId);
  if (!ap) return null;
  pause(applicantId, 'reset');
  const runId = db.prepare("INSERT INTO recruit_runs (applicant_id,status) VALUES (?, 'active')").run(applicantId).lastInsertRowid;
  const ctx = ctxFor(ap);
  const base = Date.now();
  const ins = db.prepare('INSERT INTO recruit_touches (run_id,applicant_id,channel,due_at,subject,body) VALUES (?,?,?,?,?,?)');
  RECRUIT_CADENCE.forEach((s) => {
    ins.run(runId, applicantId, s.channel, toISO(new Date(base + s.offsetMin * 60000)), C.fill(s.subject, ctx), C.fill(s.body, ctx));
  });
  return runId;
}

function deliver() { return { ok: true }; } // <-- swap for Twilio/WAVV to go live

function processDue(limit = 200) {
  const due = db.prepare(`SELECT t.* FROM recruit_touches t
    JOIN recruit_runs r ON r.id=t.run_id AND r.status='active'
    WHERE t.status='scheduled' AND t.channel IN ('sms','email') AND t.due_at <= datetime('now')
    ORDER BY t.due_at ASC LIMIT ?`).all(limit);
  let sent = 0;
  for (const t of due) {
    deliver();
    db.prepare("UPDATE recruit_touches SET status='sent', sent_at=datetime('now') WHERE id=?").run(t.id);
    db.prepare('INSERT INTO recruit_messages (applicant_id,direction,channel,subject,body,status) VALUES (?,?,?,?,?,?)')
      .run(t.applicant_id, 'out', t.channel, t.subject, t.body, 'sent');
    db.prepare("UPDATE applicants SET last_contact_at=datetime('now') WHERE id=?").run(t.applicant_id);
    sent++;
  }
  db.exec(`UPDATE recruit_runs SET status='done' WHERE status='active' AND id NOT IN (SELECT run_id FROM recruit_touches WHERE status='scheduled')`);
  return { sent, considered: due.length };
}

function speedToRecruit(applicantId) { enqueue(applicantId); return processDue(); }

function pause(applicantId, reason = 'paused') {
  db.prepare("UPDATE recruit_runs SET status='paused' WHERE applicant_id=? AND status='active'").run(applicantId);
  db.prepare("UPDATE recruit_touches SET status='canceled', reason=? WHERE applicant_id=? AND status='scheduled'").run(reason, applicantId);
}

// Recruiter "do now" queue: due call tasks across the recruiting pipeline.
function recruiterQueue() {
  return db.prepare(`SELECT t.id AS touch_id, t.due_at, t.body, a.id AS applicant_id, a.name, a.phone, a.email, a.stage, u.name AS recruiter_name
    FROM recruit_touches t JOIN applicants a ON a.id=t.applicant_id
    LEFT JOIN users u ON u.id=a.recruiter_id
    JOIN recruit_runs r ON r.id=t.run_id AND r.status='active'
    WHERE t.status='scheduled' AND t.channel='recruit_call' AND t.due_at <= datetime('now')
    ORDER BY t.due_at ASC LIMIT 100`).all();
}
function completeTouch(touchId) {
  const t = db.prepare('SELECT * FROM recruit_touches WHERE id=?').get(touchId);
  if (!t) return false;
  db.prepare("UPDATE recruit_touches SET status='done', sent_at=datetime('now') WHERE id=?").run(touchId);
  db.prepare("UPDATE applicants SET last_contact_at=datetime('now') WHERE id=?").run(t.applicant_id);
  return true;
}

function comms(applicantId) {
  const messages = db.prepare('SELECT * FROM recruit_messages WHERE applicant_id=? ORDER BY created_at DESC LIMIT 30').all(applicantId);
  const upcoming = db.prepare("SELECT * FROM recruit_touches WHERE applicant_id=? AND status='scheduled' ORDER BY due_at ASC LIMIT 10").all(applicantId);
  const run = db.prepare('SELECT status FROM recruit_runs WHERE applicant_id=? ORDER BY id DESC LIMIT 1').get(applicantId);
  return { messages, upcoming, cadence: run ? run.status : 'none' };
}

/* ---------- Onboarding ---------- */
function onboarding() {
  const agents = db.prepare("SELECT id,name,license_status,created_at FROM users WHERE role='agent' AND active=1 ORDER BY name").all();
  return agents.map((a) => {
    const steps = db.prepare('SELECT id,step,done,done_at FROM onboarding_steps WHERE agent_id=? ORDER BY id').all(a.id);
    const done = steps.filter((s) => s.done).length;
    const pct = steps.length ? Math.round(done / steps.length * 100) : 0;
    // time-to-first-app: created_at -> first issued/submitted application activity
    const firstApp = db.prepare(`SELECT MIN(created_at) m FROM activities WHERE agent_id=? AND outcome IN ('Application Submitted','sold')`).get(a.id).m
      || db.prepare(`SELECT MIN(issued_at) m FROM policies WHERE agent_id=?`).get(a.id).m;
    let ttfaDays = null;
    if (firstApp) ttfaDays = Math.max(0, Math.round((new Date(firstApp) - new Date(a.created_at)) / 86400000));
    return { id: a.id, name: a.name, license_status: a.license_status, steps, done, total: steps.length, pct, ttfaDays };
  });
}
function toggleStep(stepId) {
  const s = db.prepare('SELECT id,done FROM onboarding_steps WHERE id=?').get(stepId);
  if (!s) return false;
  const nd = s.done ? 0 : 1;
  db.prepare('UPDATE onboarding_steps SET done=?, done_at=? WHERE id=?').run(nd, nd ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null, stepId);
  return true;
}

/* ---------- Funnel analytics ---------- */
function funnel() {
  const STAGES = ['Applied','Interview Booked','Offer/Contract','Licensing In-Progress','Appointed','Onboarding','Producing','Dropped'];
  const counts = {}; STAGES.forEach((s) => (counts[s] = 0));
  db.prepare('SELECT stage, COUNT(*) c FROM applicants GROUP BY stage').all().forEach((r) => (counts[r.stage] = r.c));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const producing = counts['Producing'] || 0;
  const spend = db.prepare("SELECT COALESCE(SUM(spend),0) s FROM sources WHERE funnel='recruit'").get().s;
  const costPerProducing = producing ? Math.round(spend / producing) : null;
  const appliedToProducing = total ? Math.round(producing / total * 100) : 0;
  return { stages: STAGES, counts, total, producing, spend, costPerProducing, appliedToProducing };
}

/* ---------- Resource hub (agent-in-a-box) ---------- */
const RESOURCES = {
  scripts: [
    { title: 'Opening (first 10 seconds)', body: "Hi {first}, this is {agent} with {agency} — you reached out about protecting your family with life coverage. Did I catch you at an okay time? Great, this'll only take a few minutes." },
    { title: 'Quote framing', body: "Based on what you told me, I'm looking at three options. Most families in your situation go with the middle one — it covers the mortgage and replaces income without stretching the budget. Want me to walk you through it?" },
    { title: 'Assumptive close', body: "Okay, the only thing left is to get you approved. I just need to confirm a few health questions and your beneficiary. Who would you want this to protect first?" },
  ],
  objections: [
    { o: '“It’s too expensive.”', a: "I hear you. What's the number that would feel comfortable per month? … We can build coverage around that — the worst outcome is your family having nothing, so let's protect what matters most first and grow it later." },
    { o: '“I need to talk to my spouse.”', a: "Totally fair — this is a family decision. Let's get them on a quick 3-way so you're both protected and you're not stuck relaying numbers. Are they around now or better this evening?" },
    { o: '“Let me think about it.”', a: "Of course. Usually when someone wants to think, it's either the price or how it works — which one is it for you? Let's clear that up right now so you're deciding with all the facts." },
    { o: '“I already have coverage through work.”', a: "Smart that you have something. The catch is work coverage leaves when the job does, and it's usually only 1–2x salary. Let's make sure your family's covered even if your job changes. Mind if I show you the gap?" },
  ],
  hooks: [
    "Your mortgage doesn't stop when you do.",
    "There's one bill your death doesn't cancel.",
    "40% of families couldn't cover one missing paycheck.",
    "New homeowner with a mortgage? Read this before you regret it.",
    "You spend more on coffee than protecting your whole family.",
  ],
  cheatsheets: [
    { title: 'Mortgage Protection', body: "Sells on: protecting the home/family if the breadwinner dies. Best fit: new homeowners 25–55. Lead with the mortgage balance and monthly payment." },
    { title: 'Final Expense', body: "Sells on: not burdening family with burial costs ($8–12K). Best fit: 50–80, simplified issue. Lead with peace of mind and locking rate in now." },
    { title: 'Term Life', body: "Sells on: max coverage for lowest cost over a set period. Best fit: young families, income replacement. Lead with cost per day ('about a dollar a day')." },
  ],
};
function resources() { return RESOURCES; }

module.exports = {
  init, enqueue, processDue, speedToRecruit, pause, recruiterQueue, completeTouch, comms,
  onboarding, toggleStep, funnel, resources, RECRUIT_CADENCE,
};
