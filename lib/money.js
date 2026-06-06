'use strict';
/*
 * money.js — Phase 5. Commissions, overrides, persistency, and the
 * content→lead→attribution ROI loop.
 *
 * Comp model (first-year commission, simplified but directionally real):
 *   writing agent FYC   = issued AP × agent.comp_rate
 *   upline override     = telescoping spread up the hierarchy: at each step
 *                         from person P to their upline Q, Q earns
 *                         AP × (Q.comp_rate − P.comp_rate)  (when positive).
 * That makes total commission on a policy = AP × topRate, split correctly
 * across every level — exactly how IMO/agency override hierarchies pay.
 */
const { db } = require('./../db');
const auth = require('./../auth');

// Default contract levels (% of first-year AP). Tune to your real carrier grid.
const DEFAULT_COMP = { owner: 1.15, manager: 1.00, agent: 0.80, recruiter: 0.0, admin: 0.0 };
const CHARGEBACK_FACTOR = 0.75; // share of advanced FYC clawed back on an early lapse

function init() {
  // add comp_rate column if missing
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('comp_rate')) db.exec('ALTER TABLE users ADD COLUMN comp_rate REAL DEFAULT 0');
  const rows = db.prepare('SELECT id, role, comp_rate FROM users').all();
  const upd = db.prepare('UPDATE users SET comp_rate=? WHERE id=?');
  for (const r of rows) if (!r.comp_rate) upd.run(DEFAULT_COMP[r.role] ?? 0, r.id);
}

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };

function userMap() {
  const m = {};
  db.prepare('SELECT id,name,role,upline_id,comp_rate FROM users').all().forEach((u) => (m[u.id] = u));
  return m;
}

// Compute commissions for everyone, then filter by scope.
function commissions(user) {
  const ms = monthStart();
  const U = userMap();
  const totals = {}; // id -> {fyc, override, pending, chargeback, lapsed}
  const ensure = (id) => (totals[id] = totals[id] || { fyc: 0, override: 0, pending: 0, chargeback: 0, lapsed: 0 });

  // issued-paid policies this month -> FYC + telescoping overrides
  const issued = db.prepare("SELECT agent_id, annual_premium FROM policies WHERE status='issued_paid' AND issued_at>=?").all(ms);
  for (const p of issued) {
    const writer = U[p.agent_id]; if (!writer) continue;
    ensure(writer.id).fyc += p.annual_premium * (writer.comp_rate || 0);
    // walk up the chain distributing the spread
    let lower = writer;
    let guard = 0;
    while (lower.upline_id && U[lower.upline_id] && guard++ < 12) {
      const upper = U[lower.upline_id];
      const spread = (upper.comp_rate || 0) - (lower.comp_rate || 0);
      if (spread > 0) ensure(upper.id).override += p.annual_premium * spread;
      lower = upper;
    }
  }
  // pending (submitted, not yet issued) -> potential FYC for the writer
  db.prepare("SELECT agent_id, annual_premium FROM policies WHERE status='submitted'").all().forEach((p) => {
    const w = U[p.agent_id]; if (w) ensure(w.id).pending += p.annual_premium * (w.comp_rate || 0);
  });
  // lapses -> chargeback
  db.prepare("SELECT agent_id, annual_premium FROM policies WHERE status='lapsed'").all().forEach((p) => {
    const w = U[p.agent_id]; if (w) { ensure(w.id).lapsed += 1; ensure(w.id).chargeback += p.annual_premium * (w.comp_rate || 0) * CHARGEBACK_FACTOR; }
  });

  // build rows for producing roles
  let rows = Object.keys(U).map((id) => {
    const u = U[id]; const t = totals[id] || { fyc: 0, override: 0, pending: 0, chargeback: 0, lapsed: 0 };
    const net = t.fyc + t.override - t.chargeback;
    return { id: +id, name: u.name, role: u.role, comp_rate: u.comp_rate,
      fyc: Math.round(t.fyc), override: Math.round(t.override), pending: Math.round(t.pending),
      chargeback: Math.round(t.chargeback), lapsed: t.lapsed, net: Math.round(net) };
  }).filter((r) => ['owner', 'manager', 'agent'].includes(r.role) && (r.fyc || r.override || r.pending || r.chargeback || r.comp_rate));

  // scope
  if (user.role === 'agent' || user.role === 'recruiter') rows = rows.filter((r) => r.id === user.id);
  else if (user.role === 'manager') { const ids = auth.downlineIds(user.id); rows = rows.filter((r) => ids.includes(r.id)); }
  rows.sort((a, b) => b.net - a.net);

  const agency = rows.reduce((s, r) => ({ fyc: s.fyc + r.fyc, override: s.override + r.override, pending: s.pending + r.pending, chargeback: s.chargeback + r.chargeback, net: s.net + r.net }), { fyc: 0, override: 0, pending: 0, chargeback: 0, net: 0 });
  return { rows, agency, persistency: persistency(), chargebackFactor: CHARGEBACK_FACTOR };
}

function persistency() {
  const active = db.prepare("SELECT COUNT(*) c FROM policies WHERE status IN ('issued_paid')").get().c;
  const lapsed = db.prepare("SELECT COUNT(*) c FROM policies WHERE status='lapsed'").get().c;
  const denom = active + lapsed;
  return { active, lapsed, rate: denom ? Math.round(active / denom * 100) : 100 };
}

// Book of business summary (scope-aware on the writing agent).
function book(user) {
  const scope = user.role === 'owner' || user.role === 'admin' ? { sql: '1=1', params: [] }
    : user.role === 'manager' ? (() => { const ids = auth.downlineIds(user.id); return { sql: `agent_id IN (${ids.map(() => '?').join(',')})`, params: ids }; })()
    : { sql: 'agent_id=?', params: [user.id] };
  const byStatus = db.prepare(`SELECT status, COUNT(*) c, COALESCE(SUM(annual_premium),0) ap FROM policies WHERE ${scope.sql} GROUP BY status`).all(...scope.params);
  const byCarrier = db.prepare(`SELECT carrier, COUNT(*) c, COALESCE(SUM(annual_premium),0) ap FROM policies WHERE ${scope.sql} GROUP BY carrier ORDER BY ap DESC LIMIT 8`).all(...scope.params);
  const total = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(annual_premium),0) ap FROM policies WHERE ${scope.sql}`).get(...scope.params);
  return { total, byStatus, byCarrier };
}

// Source ROI — the content→lead→attribution loop.
function attribution() {
  const client = db.prepare(`
    SELECT s.id, s.name, s.channel, s.cta_keyword, s.spend,
      (SELECT COUNT(*) FROM leads l WHERE l.source_id=s.id) AS leads,
      (SELECT COUNT(*) FROM policies p JOIN leads l ON l.id=p.lead_id WHERE l.source_id=s.id AND p.status='issued_paid') AS issued,
      (SELECT COALESCE(SUM(p.annual_premium),0) FROM policies p JOIN leads l ON l.id=p.lead_id WHERE l.source_id=s.id AND p.status='issued_paid') AS issued_ap
    FROM sources s WHERE s.funnel='client' ORDER BY issued_ap DESC`).all();
  client.forEach((r) => {
    r.cpa = r.issued ? Math.round(r.spend / r.issued) : null;        // cost per issued client
    r.apPerDollar = r.spend ? +(r.issued_ap / r.spend).toFixed(2) : null; // AP returned per $ spent
    r.closeRate = r.leads ? Math.round(r.issued / r.leads * 100) : 0;
  });
  const recruit = db.prepare(`
    SELECT s.id, s.name, s.channel, s.cta_keyword, s.spend,
      (SELECT COUNT(*) FROM applicants a WHERE a.source_id=s.id) AS applicants,
      (SELECT COUNT(*) FROM applicants a WHERE a.source_id=s.id AND a.stage='Producing') AS producing
    FROM sources s WHERE s.funnel='recruit' ORDER BY producing DESC`).all();
  recruit.forEach((r) => { r.costPerProducing = r.producing ? Math.round(r.spend / r.producing) : null; });
  return { client, recruit };
}

module.exports = { init, commissions, attribution, book, persistency, DEFAULT_COMP };
