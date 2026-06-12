'use strict';
/*
 * server.js — zero-dependency HTTP API + static host for the Caba Life CRM.
 * Run:  node server.js   (Node 22+, uses built-in node:sqlite / node:http / node:crypto)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('./db');
const auth = require('./auth');
const engine = require('./lib/engine');
engine.init();
const recruiting = require('./lib/recruiting');
recruiting.init();
const money = require('./lib/money');
money.init();
const ai = require('./lib/ai');
const insurance = require('./lib/insurance');
insurance.init();
const admin = require('./lib/admin');
const discord = require('./lib/discord');
const ingest = require('./lib/ingest');
const RECRUIT_ROLES = ['owner','admin','manager','recruiter'];

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');

const STAGES = ['New','Contacted','Quoted','Application Submitted','Underwriting','Issued-Paid','Retention'];
const STAGE_WEIGHT = { 'New':1.0,'Contacted':1.4,'Quoted':2.2,'Application Submitted':2.6,'Underwriting':1.6,'Issued-Paid':0.4,'Retention':0.3 };
const RECRUIT_STAGES = ['Applied','Interview Booked','Offer/Contract','Licensing In-Progress','Appointed','Onboarding','Producing','Dropped'];

// ---------- helpers ----------
const send = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
};
const readBody = (req) => new Promise((resolve) => {
  let d = ''; req.on('data', (c) => (d += c));
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
});
function userFromReq(req) {
  const hdr = req.headers['authorization'] || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const claims = auth.verify(token);
  if (!claims) return null;
  return db.prepare('SELECT id,name,email,role,upline_id,monthly_goal_ap,must_change_password FROM users WHERE id=?').get(claims.uid);
}
const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0,10); };
const hoursSince = (ts) => ts ? (Date.now() - new Date(ts.replace(' ','T')).getTime()) / 3.6e6 : 9999;

// Call-Next score: priority × stage value × premium potential × staleness
function scoreLead(l) {
  const priorityW = l.priority === 1 ? 1.6 : l.priority === 2 ? 1.0 : 0.6;
  const stageW = STAGE_WEIGHT[l.stage] ?? 1;
  const premW = 0.5 + Math.min(2.5, (l.premium_potential || 0) / 1200);
  const h = hoursSince(l.last_contact_at);
  // staleness peaks around the 24–48h danger zone, decays after
  const staleW = l.stage === 'New' ? 1.8 : (h < 1 ? 0.3 : h < 24 ? 1.0 : h < 48 ? 1.6 : h < 96 ? 1.2 : 0.8);
  return +(priorityW * stageW * premW * staleW).toFixed(2);
}

// ---------- API ----------
async function api(req, res, url, user) {
  const p = url.pathname;

  // ---- auth ----
  if (p === '/api/login' && req.method === 'POST') {
    const { email, password } = await readBody(req);
    const lockedMin = auth.loginLocked(email);
    if (lockedMin) return send(res, 429, { error: `Too many attempts. Try again in ${lockedMin} min.` });
    const u = db.prepare('SELECT * FROM users WHERE email=? AND active=1').get((email||'').toLowerCase().trim());
    if (!u || !auth.checkPassword(u, password || '')) { auth.recordFail(email); return send(res, 401, { error: 'Invalid credentials' }); }
    auth.recordSuccess(email);
    const token = auth.sign({ uid: u.id, role: u.role });
    return send(res, 200, { token, user: { id: u.id, name: u.name, role: u.role, email: u.email }, must_change_password: !!u.must_change_password });
  }

  // ---- Phase 2: carrier-email ingest (machine-to-machine, shared-secret auth) ----
  // The Gmail/Discord bot POSTs parsed carrier events here. Auth = INGEST_TOKEN
  // (Railway env), NOT a user session. Accepts {events:[...]} or a single event.
  if (p === '/api/ingest/carrier-event' && req.method === 'POST') {
    const expected = process.env.INGEST_TOKEN || '';
    const hdr = req.headers['authorization'] || '';
    const tok = (hdr.startsWith('Bearer ') ? hdr.slice(7) : '') || req.headers['x-ingest-token'] || '';
    if (!expected) return send(res, 503, { error: 'Ingest not configured (set INGEST_TOKEN).' });
    if (tok !== expected) return send(res, 401, { error: 'Bad ingest token' });
    const body = await readBody(req);
    const events = Array.isArray(body.events) ? body.events : (body.event_type ? [body] : []);
    const results = events.map((e) => { try { return ingest.applyEvent(e); } catch (err) { return { kind: 'skipped', message: 'error: ' + (err.message || err) }; } });
    return send(res, 200, { ok: true, results, summary: ingest.summarize(results) });
  }

  // everything below requires a valid session
  if (!user) return send(res, 401, { error: 'Unauthorized' });

  if (p === '/api/me') return send(res, 200, { user, ai_enabled: ai.aiEnabled() });

  if (p === '/api/change-password' && req.method === 'POST') {
    const { current_password, new_password } = await readBody(req);
    const full = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!auth.checkPassword(full, current_password || '')) return send(res, 400, { error: 'Current password is incorrect.' });
    const issue = auth.passwordIssue(new_password);
    if (issue) return send(res, 400, { error: issue });
    auth.setPassword(user.id, new_password);
    return send(res, 200, { ok: true });
  }

  // ---- pipeline (board) ----
  if (p === '/api/leads' && req.method === 'GET') {
    const scope = auth.leadScope(user, 'l');
    const rows = db.prepare(
      `SELECT l.*, u.name AS owner_name, s.name AS source_name
       FROM leads l LEFT JOIN users u ON u.id=l.owner_id LEFT JOIN sources s ON s.id=l.source_id
       WHERE ${scope.sql} ORDER BY l.created_at DESC`).all(...scope.params);
    for (const r of rows) { r.score = scoreLead(r); r.hours_since = Math.round(hoursSince(r.last_contact_at)); }
    return send(res, 200, { stages: STAGES, leads: rows });
  }

  // ---- Call-Next: SAVE calls first (chargeback risk), then top scored leads ----
  if (p === '/api/call-next' && req.method === 'GET') {
    const scope = auth.leadScope(user, 'l');

    // 1) Missed-payment policies = money already on the books walking out.
    //    These outrank every prospecting call, ordered by chargeback exposure.
    const saveRows = db.prepare(
      `SELECT l.*, u.name AS owner_name, pl.id AS policy_id, pl.carrier AS save_carrier,
              pl.policy_number, pl.comm_pct, pl.effective_date,
              COALESCE(pl.monthly_premium, pl.annual_premium/12.0)*12 AS save_annual
       FROM policies pl JOIN leads l ON l.id=pl.lead_id LEFT JOIN users u ON u.id=l.owner_id
       WHERE ${scope.sql} AND pl.status='issued_paid' AND pl.payment_status='missed' AND l.dnc=0`)
      .all(...scope.params);
    const CB = insurance.CHARGEBACK_MONTHS || 12;
    saveRows.forEach((r) => {
      let mob = null;
      if (r.effective_date) {
        const f = new Date(r.effective_date), n = new Date();
        if (!isNaN(f)) mob = Math.max(0, (n.getFullYear() - f.getFullYear()) * 12 + (n.getMonth() - f.getMonth()));
      }
      const monthsLeft = mob == null ? CB : Math.max(0, CB - mob);
      const exposure = Math.round((r.save_annual || 0) * ((r.comm_pct || 0) / 100) * (monthsLeft / CB));
      r.exposure = exposure;
      r.is_save = true;
      r.score = exposure; // exposure IS the score for saves
      r.hours_since = Math.round(hoursSince(r.last_contact_at));
      r.why = `🔥 SAVE CALL — missed payment · ${r.save_carrier || ''}${r.policy_number ? ' #' + r.policy_number : ''} · ~$${exposure} advance at risk${mob != null ? ' · ' + mob + ' mo on books' : ''}`;
    });
    saveRows.sort((a, b) => b.exposure - a.exposure);
    const saveLeadIds = new Set(saveRows.map((r) => r.id));

    // 2) Regular prospecting queue (excluding anyone already in the save list).
    const rows = db.prepare(
      `SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
       WHERE ${scope.sql} AND l.stage NOT IN ('Issued-Paid','Retention') AND l.dnc=0`).all(...scope.params)
      .filter((r) => !saveLeadIds.has(r.id));
    rows.forEach((r) => { r.score = scoreLead(r); r.hours_since = Math.round(hoursSince(r.last_contact_at)); });
    rows.sort((a, b) => b.score - a.score);

    const top = [...saveRows, ...rows].slice(0, Math.max(10, saveRows.length + 5));
    top.forEach((r) => { if (!r.why) r.why = ai.explain(r); });
    return send(res, 200, { leads: top, saves: saveRows.length, save_exposure: saveRows.reduce((s2, r) => s2 + r.exposure, 0) });
  }

  // ---- lead detail + timeline ----
  let m = p.match(/^\/api\/leads\/(\d+)$/);
  if (m && req.method === 'GET') {
    const id = +m[1];
    const scope = auth.leadScope(user, 'l');
    const lead = db.prepare(`SELECT l.*, u.name AS owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id
       WHERE l.id=? AND ${scope.sql}`).get(id, ...scope.params);
    if (!lead) return send(res, 404, { error: 'Not found or not in your book' });
    lead.score = scoreLead(lead);
    const acts = db.prepare('SELECT a.*, u.name AS agent_name FROM activities a LEFT JOIN users u ON u.id=a.agent_id WHERE a.lead_id=? ORDER BY a.created_at DESC').all(id);
    const pols = db.prepare('SELECT * FROM policies WHERE lead_id=? ORDER BY issued_at DESC').all(id);
    const comms = engine.leadComms(id);
    return send(res, 200, { lead, activities: acts, policies: pols, ...comms });
  }

  // ---- move stage (logged) ----
  m = p.match(/^\/api\/leads\/(\d+)\/stage$/);
  if (m && req.method === 'POST') {
    const id = +m[1]; const { stage } = await readBody(req);
    if (!STAGES.includes(stage)) return send(res, 400, { error: 'Bad stage' });
    const scope = auth.leadScope(user, 'l');
    const lead = db.prepare(`SELECT id,stage FROM leads l WHERE id=? AND ${scope.sql}`).get(id, ...scope.params);
    if (!lead) return send(res, 404, { error: 'Not in your book' });
    db.prepare("UPDATE leads SET stage=?, last_contact_at=datetime('now') WHERE id=?").run(stage, id);
    db.prepare('INSERT INTO activities (lead_id,agent_id,type,outcome,body) VALUES (?,?,?,?,?)')
      .run(id, user.id, 'stage_change', stage, `${lead.stage} → ${stage}`);
    // a human moved the lead forward — pause automated follow-up so we don't talk over the agent
    if (stage !== 'New') engine.pauseLead(id, 'stage_change');
    // simple disposition automation: issued-paid creates/updates a policy
    if (stage === 'Issued-Paid') {
      const L = db.prepare('SELECT * FROM leads WHERE id=?').get(id);
      const existing = db.prepare("SELECT id FROM policies WHERE lead_id=? AND status!='lapsed'").get(id);
      if (existing) db.prepare("UPDATE policies SET status='issued_paid', issued_at=datetime('now') WHERE id=?").run(existing.id);
      else db.prepare("INSERT INTO policies (lead_id,agent_id,carrier,product,annual_premium,status) VALUES (?,?,?,?,?,'issued_paid')")
            .run(id, L.owner_id, 'TBD', L.product_interest, L.premium_potential);
    }
    return send(res, 200, { ok: true });
  }

  // ---- log an activity (call/sms/email/note) ----
  m = p.match(/^\/api\/leads\/(\d+)\/activity$/);
  if (m && req.method === 'POST') {
    const id = +m[1]; const { type, outcome, body, next_step } = await readBody(req);
    const scope = auth.leadScope(user, 'l');
    const lead = db.prepare(`SELECT id FROM leads l WHERE id=? AND ${scope.sql}`).get(id, ...scope.params);
    if (!lead) return send(res, 404, { error: 'Not in your book' });
    db.prepare('INSERT INTO activities (lead_id,agent_id,type,outcome,body,next_step) VALUES (?,?,?,?,?,?)')
      .run(id, user.id, type || 'note', outcome || null, body || null, next_step || null);
    db.prepare("UPDATE leads SET last_contact_at=datetime('now') WHERE id=?").run(id);
    return send(res, 200, { ok: true });
  }

  // ---- recruiting pipeline ----
  if (p === '/api/applicants' && req.method === 'GET') {
    if (!['owner','admin','manager','recruiter'].includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    const rows = db.prepare('SELECT a.*, u.name AS recruiter_name FROM applicants a LEFT JOIN users u ON u.id=a.recruiter_id ORDER BY a.created_at DESC').all();
    rows.forEach((r) => (r.hours_since = Math.round(hoursSince(r.last_contact_at))));
    return send(res, 200, { stages: RECRUIT_STAGES, applicants: rows });
  }
  m = p.match(/^\/api\/applicants\/(\d+)\/stage$/);
  if (m && req.method === 'POST') {
    if (!['owner','admin','manager','recruiter'].includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    const id = +m[1]; const { stage } = await readBody(req);
    if (!RECRUIT_STAGES.includes(stage)) return send(res, 400, { error: 'Bad stage' });
    db.prepare("UPDATE applicants SET stage=?, last_contact_at=datetime('now') WHERE id=?").run(stage, id);
    return send(res, 200, { ok: true });
  }

  // ---- Phase 3: recruiting machine ----
  if (p === '/api/recruit-intake' && req.method === 'POST') {
    if (!RECRUIT_ROLES.includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    const b = await readBody(req);
    const rec = db.prepare("SELECT id FROM users WHERE role='recruiter' AND active=1 ORDER BY RANDOM() LIMIT 1").get()
             || db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get();
    const src = db.prepare("SELECT id FROM sources WHERE funnel='recruit' ORDER BY RANDOM() LIMIT 1").get();
    const id = db.prepare(`INSERT INTO applicants (name,phone,email,stage,recruiter_id,source_id,notes,last_contact_at)
       VALUES (?,?,?,'Applied',?,?,?,NULL)`).run(
        b.name || 'New Applicant', b.phone || '5550000000', b.email || null, rec && rec.id, src && src.id,
        'Inbound from recruiting funnel').lastInsertRowid;
    const result = recruiting.speedToRecruit(id);
    return send(res, 200, { ok: true, applicant_id: id, speed_to_recruit: result });
  }
  if (p === '/api/recruiter-queue' && req.method === 'GET') {
    if (!RECRUIT_ROLES.includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    return send(res, 200, { tasks: recruiting.recruiterQueue() });
  }
  m = p.match(/^\/api\/recruit-touches\/(\d+)\/done$/);
  if (m && req.method === 'POST') {
    if (!RECRUIT_ROLES.includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    recruiting.completeTouch(+m[1]);
    return send(res, 200, { ok: true });
  }
  m = p.match(/^\/api\/applicants\/(\d+)$/);
  if (m && req.method === 'GET') {
    if (!RECRUIT_ROLES.includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    const id = +m[1];
    const ap = db.prepare('SELECT a.*, u.name AS recruiter_name FROM applicants a LEFT JOIN users u ON u.id=a.recruiter_id WHERE a.id=?').get(id);
    if (!ap) return send(res, 404, { error: 'Not found' });
    return send(res, 200, { applicant: ap, ...recruiting.comms(id) });
  }
  if (p === '/api/onboarding' && req.method === 'GET') {
    if (!['owner','admin','manager','recruiter'].includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    return send(res, 200, { agents: recruiting.onboarding() });
  }
  m = p.match(/^\/api\/onboarding\/(\d+)\/toggle$/);
  if (m && req.method === 'POST') {
    if (!['owner','admin','manager'].includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    recruiting.toggleStep(+m[1]);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/recruiting-funnel' && req.method === 'GET') {
    if (!RECRUIT_ROLES.includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    return send(res, 200, recruiting.funnel());
  }
  if (p === '/api/resources' && req.method === 'GET') {
    return send(res, 200, recruiting.resources());
  }

  // ---- Phase 6: AI layer ----
  if (p === '/api/briefing' && req.method === 'GET') {
    return send(res, 200, await ai.briefing(user));
  }
  if (p === '/api/assistant' && req.method === 'POST') {
    const { q } = await readBody(req);
    return send(res, 200, await ai.assistant(user, q || ''));
  }
  m = p.match(/^\/api\/leads\/(\d+)\/call-summary$/);
  if (m && req.method === 'POST') {
    const id = +m[1]; const { transcript } = await readBody(req);
    const scope = auth.leadScope(user, 'l');
    if (!db.prepare(`SELECT id FROM leads l WHERE id=? AND ${scope.sql}`).get(id, ...scope.params)) return send(res, 404, { error: 'Not in your book' });
    const r = await ai.callSummary(transcript || '');
    db.prepare('INSERT INTO activities (lead_id,agent_id,type,outcome,body,next_step) VALUES (?,?,?,?,?,?)')
      .run(id, user.id, 'call', r.outcome, r.summary, r.next_step);
    db.prepare("UPDATE leads SET last_contact_at=datetime('now') WHERE id=?").run(id);
    return send(res, 200, r);
  }
  m = p.match(/^\/api\/leads\/(\d+)\/suggest-reply$/);
  if (m && req.method === 'POST') {
    const id = +m[1]; const { body } = await readBody(req);
    const scope = auth.leadScope(user, 'l');
    const lead = db.prepare(`SELECT * FROM leads l WHERE id=? AND ${scope.sql}`).get(id, ...scope.params);
    if (!lead) return send(res, 404, { error: 'Not in your book' });
    return send(res, 200, await ai.suggestReply(body || '', lead));
  }

  // ---- Phase 5: commissions / book / attribution ----
  if (p === '/api/commissions' && req.method === 'GET') {
    return send(res, 200, money.commissions(user));
  }
  if (p === '/api/book' && req.method === 'GET') {
    return send(res, 200, money.book(user));
  }
  if (p === '/api/attribution' && req.method === 'GET') {
    if (!auth.canSeeAllAgents(user)) return send(res, 403, { error: 'Forbidden' });
    return send(res, 200, money.attribution());
  }

  // ---- scoreboard ----
  if (p === '/api/scoreboard' && req.method === 'GET') {
    const range = (url.searchParams.get('range') || 'mtd').toLowerCase();
    const nowD = new Date();
    const iso = (d) => d.toISOString().slice(0, 10);
    let periodStart, priorStart, priorEnd;
    if (range === 'wtd') {
      const day = nowD.getDay(); const ws = new Date(nowD); ws.setDate(nowD.getDate() - day);
      periodStart = iso(ws); const pw = new Date(ws); pw.setDate(ws.getDate() - 7); priorStart = iso(pw); priorEnd = periodStart;
    } else if (range === 'ytd') {
      periodStart = iso(new Date(nowD.getFullYear(), 0, 1));
      priorStart = iso(new Date(nowD.getFullYear() - 1, 0, 1)); priorEnd = iso(new Date(nowD.getFullYear() - 1, nowD.getMonth(), nowD.getDate()));
    } else {
      periodStart = monthStart();
      priorStart = iso(new Date(nowD.getFullYear(), nowD.getMonth() - 1, 1)); priorEnd = periodStart;
    }
    const ms = periodStart;
    // agency goal = sum of agent goals (owner can override via env later)
    const agents = db.prepare("SELECT id,name,role,monthly_goal_ap FROM users WHERE active=1 AND role IN ('owner','agent','manager') ORDER BY name").all();
    const board = agents.map((a) => {
      const ap = db.prepare("SELECT COALESCE(SUM(annual_premium),0) ap FROM policies WHERE agent_id=? AND status='issued_paid' AND issued_at>=?").get(a.id, ms).ap;
      const dials = db.prepare("SELECT COUNT(*) c FROM activities WHERE agent_id=? AND type='call' AND created_at>=date('now','-7 day')").get(a.id).c;
      const appts = db.prepare("SELECT COUNT(*) c FROM activities WHERE agent_id=? AND type='call' AND outcome='connected' AND created_at>=date('now','-7 day')").get(a.id).c;
      const apps  = db.prepare("SELECT COUNT(*) c FROM activities WHERE agent_id=? AND type='stage_change' AND outcome='Application Submitted' AND created_at>=date('now','-30 day')").get(a.id).c;
      const goal = a.monthly_goal_ap || 0;
      return { id: a.id, name: a.name, role: a.role, ap, goal, pace: goal ? Math.round((ap / goal) * 100) : 0, dials, connects: appts, apps };
    }).sort((x, y) => y.ap - x.ap);

    const agencyAP = board.reduce((s, r) => s + r.ap, 0);
    // prior-period agency AP for %-delta
    const priorAP = db.prepare("SELECT COALESCE(SUM(annual_premium),0) ap FROM policies WHERE status='issued_paid' AND issued_at>=? AND issued_at<?").get(priorStart, priorEnd).ap;
    const apDelta = priorAP ? Math.round((agencyAP - priorAP) / priorAP * 100) : null;
    const agencyGoal = Number(process.env.AGENCY_GOAL_AP) || board.reduce((s, r) => s + r.goal, 0);
    const now = new Date();
    const dayOfMonth = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expectedByNow = Math.round(agencyGoal * (dayOfMonth / daysInMonth));
    const onPace = agencyAP >= expectedByNow;
    // dials needed: rough model — assume $25 AP per dial historical efficiency
    const remaining = Math.max(0, agencyGoal - agencyAP);
    const dialsNeeded = Math.round(remaining / 25);

    const scope = auth.leadScope(user, 'l');
    const goingCold = db.prepare(
      `SELECT COUNT(*) c FROM leads l WHERE ${scope.sql} AND l.stage NOT IN ('Issued-Paid','Retention')
       AND (l.last_contact_at IS NULL OR l.last_contact_at <= datetime('now','-48 hour'))`).get(...scope.params).c;

    if (!auth.canSeeAllAgents(user)) {
      // agents see only their own row + the agency number for motivation
      const mine = board.find((b) => b.id === user.id) || null;
      return send(res, 200, { scope: 'self', mine, agencyAP, agencyGoal, expectedByNow, onPace, goingCold, range, apDelta, priorAP });
    }
    return send(res, 200, { scope: 'team', board, agencyAP, agencyGoal, expectedByNow, onPace, dialsNeeded, daysInMonth, dayOfMonth, goingCold, range, apDelta, priorAP });
  }

  // ---- Phase 2: intake / speed-to-lead ----
  if (p === '/api/intake' && req.method === 'POST') {
    const b = await readBody(req);
    // round-robin to the agent with the fewest open leads
    const agent = db.prepare(`SELECT u.id, COUNT(l.id) c FROM users u
       LEFT JOIN leads l ON l.owner_id=u.id AND l.stage NOT IN ('Issued-Paid','Retention')
       WHERE u.role='agent' AND u.active=1 GROUP BY u.id ORDER BY c ASC, RANDOM() LIMIT 1`).get();
    const owner_id = b.owner_id || (agent && agent.id);
    const src = db.prepare("SELECT id FROM sources WHERE funnel='client' ORDER BY RANDOM() LIMIT 1").get();
    const id = db.prepare(`INSERT INTO leads
      (first_name,last_name,phone,email,state,product_interest,stage,owner_id,source_id,priority,premium_potential,consent_tcpa,consent_source,consent_at)
      VALUES (?,?,?,?,?,?, 'New', ?,?, 1, ?, 1, 'web_form', datetime('now'))`).run(
        b.first_name || 'New', b.last_name || 'Lead', b.phone || '5550000000', b.email || null,
        b.state || 'TX', b.product_interest || 'mortgage_protection', owner_id, src && src.id,
        b.premium_potential || (600 + Math.floor(Math.random() * 1800))).lastInsertRowid;
    const result = engine.speedToLead(id);
    return send(res, 200, { ok: true, lead_id: id, owner_id, speed_to_lead: result });
  }

  // ---- agent Today action queue (due call tasks) ----
  if (p === '/api/tasks' && req.method === 'GET') {
    const scope = auth.leadScope(user, 'l');
    const tasks = engine.tasksForScope(scope.sql, scope.params);
    tasks.forEach((t) => (t.hours_since = Math.round(hoursSince(t.last_contact_at))));
    return send(res, 200, { tasks });
  }
  m = p.match(/^\/api\/touches\/(\d+)\/done$/);
  if (m && req.method === 'POST') {
    engine.completeTouch(+m[1], user.id);
    return send(res, 200, { ok: true });
  }

  // ---- inbound reply (pauses cadence; STOP opts out) ----
  m = p.match(/^\/api\/leads\/(\d+)\/reply$/);
  if (m && req.method === 'POST') {
    const id = +m[1]; const { body } = await readBody(req);
    const scope = auth.leadScope(user, 'l');
    if (!db.prepare(`SELECT id FROM leads l WHERE id=? AND ${scope.sql}`).get(id, ...scope.params)) return send(res, 404, { error: 'Not in your book' });
    return send(res, 200, engine.recordReply(id, body || '', user.id));
  }
  m = p.match(/^\/api\/leads\/(\d+)\/optout$/);
  if (m && req.method === 'POST') {
    const id = +m[1];
    const scope = auth.leadScope(user, 'l');
    if (!db.prepare(`SELECT id FROM leads l WHERE id=? AND ${scope.sql}`).get(id, ...scope.params)) return send(res, 404, { error: 'Not in your book' });
    return send(res, 200, engine.optOut(id, user.id));
  }
  // ---- cadence controls ----
  m = p.match(/^\/api\/leads\/(\d+)\/cadence\/(pause|start)$/);
  if (m && req.method === 'POST') {
    const id = +m[1], action = m[2];
    const scope = auth.leadScope(user, 'l');
    if (!db.prepare(`SELECT id FROM leads l WHERE id=? AND ${scope.sql}`).get(id, ...scope.params)) return send(res, 404, { error: 'Not in your book' });
    if (action === 'pause') engine.pauseLead(id, 'manual');
    else { engine.enqueueCadence(id); engine.processDue(); }
    return send(res, 200, { ok: true });
  }

  // ---- Insurance: chargeback runway, earnings, carriers, comp grid ----
  if (p === '/api/insurance/at-risk' && req.method === 'GET') return send(res, 200, insurance.atRisk(user));
  if (p === '/api/insurance/earnings' && req.method === 'GET') return send(res, 200, insurance.earnings(user));
  if (p === '/api/insurance/by-carrier' && req.method === 'GET') return send(res, 200, insurance.byCarrier(user));
  if (p === '/api/insurance/comp-grid' && req.method === 'GET') return send(res, 200, { grid: insurance.compGrid() });
  if (p === '/api/insurance/comp-grid' && req.method === 'POST') {
    if (!['owner','admin','manager'].includes(user.role)) return send(res, 403, { error: 'Forbidden' });
    const { carrier, product, rate } = await readBody(req);
    insurance.setCompRate(carrier, product, Number(rate));
    return send(res, 200, { ok: true });
  }
  m = p.match(/^\/api\/policies\/(\d+)\/payment$/);
  if (m && req.method === 'POST') {
    const id = +m[1]; const { status } = await readBody(req);
    insurance.markPayment(id, status);
    // chargeback-save workflow + Discord alerts (shared with the carrier-email ingest)
    const pol = db.prepare(`SELECT pl.*, l.first_name, l.last_name, l.id AS lead_id FROM policies pl LEFT JOIN leads l ON l.id=pl.lead_id WHERE pl.id=?`).get(id);
    ingest.fireWorkflow(pol, status);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/admin/discord-test' && req.method === 'POST') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner only' });
    if (!discord.enabled()) return send(res, 200, { enabled: false, note: 'Set DISCORD_WEBHOOK_URL in Railway to enable.' });
    const r = await discord.notify('✅ **Cava Life CRM connected to Discord.** Missed-payment alerts, recoveries, and the daily at-risk digest will post here.');
    return send(res, 200, { enabled: true, posted: r.ok });
  }

  // ---- Admin (owner only): wipe demo + bulk import ----
  if (p === '/api/admin/wipe-demo' && req.method === 'POST') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner only' });
    return send(res, 200, admin.wipeDemo());
  }
  if (p === '/api/admin/import' && req.method === 'POST') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner only' });
    const payload = await readBody(req);
    return send(res, 200, admin.importData(payload, user.id));
  }

  if (p === '/api/admin/rerate' && req.method === 'POST') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner only' });
    return send(res, 200, admin.rerateBook());
  }

  // ---- Sprint 1: persistency + carrier reconciliation ----
  if (p === '/api/insurance/persistency' && req.method === 'GET') return send(res, 200, insurance.persistency(user));
  if (p === '/api/insurance/reconcile' && req.method === 'POST') {
    const { rows } = await readBody(req);
    return send(res, 200, insurance.reconcile(user, rows || []));
  }

  // ---- Sprint 1: user management (owner only) ----
  if (p === '/api/admin/users' && req.method === 'GET') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner only' });
    return send(res, 200, { users: admin.listUsers() });
  }
  if (p === '/api/admin/users' && req.method === 'POST') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner only' });
    const r = admin.createUser(await readBody(req));
    return send(res, r.error ? 400 : 200, r);
  }
  m = p.match(/^\/api\/admin\/users\/(\d+)$/);
  if (m && req.method === 'PATCH') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner only' });
    return send(res, 200, admin.updateUser(+m[1], await readBody(req)));
  }
  m = p.match(/^\/api\/admin\/users\/(\d+)\/active$/);
  if (m && req.method === 'POST') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner only' });
    const { active } = await readBody(req);
    return send(res, 200, admin.setActive(+m[1], active));
  }
  m = p.match(/^\/api\/admin\/users\/(\d+)\/reset-password$/);
  if (m && req.method === 'POST') {
    if (user.role !== 'owner') return send(res, 403, { error: 'Owner only' });
    const r = admin.resetPassword(+m[1]);
    return send(res, r.error ? 400 : 200, r);
  }

  return send(res, 404, { error: 'No such endpoint' });
}

// ---------- static ----------
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json' };
function serveStatic(req, res, url) {
  let fp = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(PUBLIC, path.normalize(fp).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(302, { Location: '/' }); return res.end();
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

// ---------- server ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const user = userFromReq(req);
      return await api(req, res, url, user);
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: 'Server error', detail: String(e.message || e) });
  }
}).listen(PORT, () => {
  console.log(`\n  Cava Life CRM running →  http://localhost:${PORT}`);
  console.log(`  Login: dane@cabalife.com / changeme123  (owner)`);
  console.log(`  Agent: jasmine@cabalife.com / changeme123\n`);

  // First boot: put a cadence on a sample of fresh leads so the Today queue
  // and comms log show real automation immediately.
  const hasRuns = db.prepare('SELECT COUNT(*) c FROM cadence_runs').get().c;
  if (!hasRuns) {
    const fresh = db.prepare("SELECT id FROM leads WHERE stage IN ('New','Contacted') ORDER BY created_at DESC LIMIT 14").all();
    fresh.forEach((l) => engine.enqueueCadence(l.id));
    const r = engine.processDue();
    console.log(`  [automation] seeded cadences on ${fresh.length} leads · first run: ${r.sent} sent, ${r.blocked} blocked, ${r.deferred} deferred for quiet hours`);
  }
  // First boot: enroll early-stage applicants in the recruiting nurture so the
  // recruiter queue and funnel show real data.
  const hasRecruitRuns = db.prepare('SELECT COUNT(*) c FROM recruit_runs').get().c;
  if (!hasRecruitRuns) {
    const apps = db.prepare("SELECT id FROM applicants WHERE stage IN ('Applied','Interview Booked') ORDER BY created_at DESC LIMIT 10").all();
    apps.forEach((a) => recruiting.enqueue(a.id));
    const rr = recruiting.processDue();
    console.log(`  [recruiting] seeded nurture on ${apps.length} applicants · ${rr.sent} sent`);
  }

  // Runners — fire due automated touches (client + recruit) through the gate.
  const every = Number(process.env.RUNNER_MS) || 30000;
  setInterval(() => {
    try { engine.processDue(); recruiting.processDue(); } catch (e) { console.error('runner', e.message); }
  }, every);

  // Daily Discord at-risk digest (posts once/day at DIGEST_HOUR UTC; default ~8am ET)
  let lastDigest = null;
  const DIGEST_HOUR = Number(process.env.DIGEST_HOUR ?? 13);
  setInterval(() => {
    try {
      if (!discord.enabled()) return;
      const now = new Date(); const today = now.toISOString().slice(0, 10);
      if (now.getUTCHours() !== DIGEST_HOUR || lastDigest === today) return;
      lastDigest = today;
      const owner = db.prepare("SELECT id, role FROM users WHERE role='owner' LIMIT 1").get();
      if (!owner) return;
      const ar = insurance.atRisk(owner); const t = ar.totals;
      const lines = ar.rows.filter((r) => r.risk === 'high').slice(0, 8)
        .map((r) => `• ${r.name} · ${r.carrier||''} · $${r.exposure} (${r.months_on_books==null?'?':r.months_on_books}mo)`);
      discord.notify(`🗓 **Daily at-risk digest**\n${t.in_window} policies in the 12-mo chargeback window · **${t.missed} missed** · $${t.exposure_total} total exposure ($${t.missed_exposure} at immediate risk)\n${lines.join('\n') || 'No missed payments — book is clean. 🎉'}`);
    } catch (e) { console.error('digest', e.message); }
  }, 5 * 60 * 1000);
});
