'use strict';
/*
 * insurance.js — the insurance depth: chargeback runway, AP vs IP, monthly
 * deposit forecast, in-force by carrier, and an editable comp grid.
 * Operates on an enriched `policies` table (extra columns added in init()).
 */
const { db } = require('./../db');
const auth = require('./../auth');

const CHARGEBACK_MONTHS = 12; // policies are "on the books" until 12 months in-force

function init() {
  const cols = db.prepare('PRAGMA table_info(policies)').all().map((c) => c.name);
  const add = (name, type) => { if (!cols.includes(name)) db.exec(`ALTER TABLE policies ADD COLUMN ${name} ${type}`); };
  add('policy_number', 'TEXT');
  add('state', 'TEXT');
  add('monthly_premium', 'REAL');
  add('comm_pct', 'REAL');           // commission rate %
  add('effective_date', 'TEXT');
  add('date_sold', 'TEXT');
  add('payment_mode', 'TEXT');       // Monthly / Annual
  add('payment_status', "TEXT DEFAULT 'active'"); // active / missed / chargeback
  add('sub_status', 'TEXT');
  add('renewal_date', 'TEXT');

  db.exec(`CREATE TABLE IF NOT EXISTS comp_grid (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carrier TEXT, product TEXT, rate REAL,
    UNIQUE(carrier, product)
  )`);
}

const monthsBetween = (from, to = new Date()) => {
  if (!from) return null;
  const f = new Date(from);
  if (isNaN(f)) return null;
  return (to.getFullYear() - f.getFullYear()) * 12 + (to.getMonth() - f.getMonth()) + (to.getDate() >= f.getDate() ? 0 : -1);
};
const ann = (p) => Math.round((p.monthly_premium || (p.annual_premium ? p.annual_premium / 12 : 0)) * 12);

// Scope policies to the user's book (agent → own; manager → downline; owner → all).
function scope(user) {
  if (user.role === 'owner' || user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'manager') { const ids = auth.downlineIds(user.id); return { sql: `agent_id IN (${ids.map(() => '?').join(',')})`, params: ids }; }
  return { sql: 'agent_id=?', params: [user.id] };
}

// ---------- Chargeback runway ----------
function atRisk(user) {
  const s = scope(user);
  const rows = db.prepare(`SELECT p.*, l.first_name, l.last_name FROM policies p
    LEFT JOIN leads l ON l.id=p.lead_id
    WHERE ${s.sql} AND p.status='issued_paid'`).all(...s.params);
  const out = rows.map((p) => {
    const m = monthsBetween(p.effective_date);
    const onBooks = m == null ? null : m;
    const inWindow = onBooks != null && onBooks < CHARGEBACK_MONTHS;
    const annual = ann(p);
    // chargeback exposure ~ unearned portion of advanced commission
    const monthsLeft = onBooks == null ? CHARGEBACK_MONTHS : Math.max(0, CHARGEBACK_MONTHS - onBooks);
    const advanced = annual * ((p.comm_pct || 0) / 100);
    const exposure = Math.round(advanced * (monthsLeft / CHARGEBACK_MONTHS));
    return {
      id: p.id, name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), carrier: p.carrier, product: p.product,
      policy_number: p.policy_number, state: p.state, annual, comm_pct: p.comm_pct, payment_status: p.payment_status,
      months_on_books: onBooks, months_left: monthsLeft, in_window: inWindow, exposure,
      effective_date: p.effective_date,
      risk: p.payment_status === 'missed' || p.payment_status === 'chargeback' ? 'high' : (inWindow ? 'watch' : 'safe'),
    };
  });
  out.sort((a, b) => (b.payment_status === 'missed' ? 1 : 0) - (a.payment_status === 'missed' ? 1 : 0) || b.exposure - a.exposure);
  const missed = out.filter((r) => r.risk === 'high');
  return {
    rows: out,
    totals: {
      in_window: out.filter((r) => r.in_window).length,
      missed: missed.length,
      exposure_total: out.filter((r) => r.in_window).reduce((s2, r) => s2 + r.exposure, 0),
      missed_exposure: missed.reduce((s2, r) => s2 + r.exposure, 0),
    },
  };
}

function markPayment(policyId, status) {
  if (!['active', 'missed', 'chargeback'].includes(status)) return false;
  db.prepare('UPDATE policies SET payment_status=? WHERE id=?').run(status, policyId);
  return true;
}

// ---------- AP vs IP + deposit forecast ----------
function earnings(user) {
  const s = scope(user);
  const pols = db.prepare(`SELECT * FROM policies p WHERE ${s.sql} AND p.status IN ('issued_paid','submitted')`).all(...s.params);
  const sold = pols; // everything written
  const inforce = pols.filter((p) => p.status === 'issued_paid' && p.payment_status !== 'chargeback' && p.payment_status !== 'lapsed');
  const paying = inforce.filter((p) => p.payment_status === 'active');
  const AP = sold.reduce((a, p) => a + ann(p), 0);
  const IP = inforce.reduce((a, p) => a + ann(p), 0);
  const payingIP = paying.reduce((a, p) => a + ann(p), 0);

  // monthly commission run-rate from actively-paying in-force business
  const monthlyComm = paying.reduce((a, p) => a + (ann(p) / 12) * ((p.comm_pct || 0) / 100), 0);
  const now = new Date();
  const forecast = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    forecast.push({ month: d.toLocaleString('en-US', { month: 'short', year: '2-digit' }), deposit: Math.round(monthlyComm) });
  }
  return {
    AP: Math.round(AP), IP: Math.round(IP), payingIP: Math.round(payingIP),
    ip_ratio: AP ? Math.round(IP / AP * 100) : 0,
    monthly_commission: Math.round(monthlyComm),
    annual_run_rate: Math.round(monthlyComm * 12),
    forecast,
    counts: { sold: sold.length, inforce: inforce.length, paying: paying.length },
  };
}

// ---------- In-force by carrier ----------
function byCarrier(user) {
  const s = scope(user);
  const rows = db.prepare(`SELECT carrier,
      COUNT(*) policies,
      SUM(CASE WHEN status='issued_paid' THEN 1 ELSE 0 END) inforce,
      COALESCE(SUM(CASE WHEN status='issued_paid' THEN COALESCE(monthly_premium,annual_premium/12.0)*12 ELSE 0 END),0) ip,
      COALESCE(SUM(COALESCE(monthly_premium,annual_premium/12.0)*12),0) ap
    FROM policies p WHERE ${s.sql} GROUP BY carrier ORDER BY ip DESC`).all(...s.params);
  rows.forEach((r) => { r.ip = Math.round(r.ip); r.ap = Math.round(r.ap); });
  return { carriers: rows };
}

// ---------- Comp grid ----------
function compGrid() {
  return db.prepare('SELECT * FROM comp_grid ORDER BY carrier, product').all();
}
function setCompRate(carrier, product, rate) {
  db.prepare('INSERT INTO comp_grid (carrier,product,rate) VALUES (?,?,?) ON CONFLICT(carrier,product) DO UPDATE SET rate=excluded.rate')
    .run(carrier, product, rate);
}
// Build the grid from whatever policies exist (distinct carrier/product → typical rate).
function seedCompGridFromPolicies() {
  const rows = db.prepare(`SELECT carrier, product, ROUND(AVG(comm_pct),1) rate FROM policies
    WHERE carrier IS NOT NULL AND comm_pct IS NOT NULL GROUP BY carrier, product`).all();
  for (const r of rows) if (r.carrier && r.product) setCompRate(r.carrier, r.product, r.rate);
  return rows.length;
}

// ---------- Persistency (count + premium; 13-mo cohort if mature enough) ----------
function persistency(user) {
  const s = scope(user);
  const pols = db.prepare(`SELECT * FROM policies p WHERE ${s.sql} AND status IN ('issued_paid','lapsed','declined')`).all(...s.params);
  // "placed" = ever issued; active = issued_paid & still paying; terminated = lapsed/chargeback
  const placed = pols.filter((p) => p.status === 'issued_paid' || p.status === 'lapsed');
  const active = placed.filter((p) => p.status === 'issued_paid' && p.payment_status !== 'chargeback' && p.payment_status !== 'lapsed');
  const term = placed.filter((p) => !(p.status === 'issued_paid' && p.payment_status !== 'chargeback' && p.payment_status !== 'lapsed'));
  const byCount = placed.length ? Math.round(active.length / placed.length * 100) : null;
  const activeAP = active.reduce((a, p) => a + ann(p), 0);
  const placedAP = placed.reduce((a, p) => a + ann(p), 0);
  const byPremium = placedAP ? Math.round(activeAP / placedAP * 100) : null;

  // 13-month cohort: policies effective >=13 months ago
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 13);
  const cohort = placed.filter((p) => p.effective_date && new Date(p.effective_date) <= cutoff);
  const cohortActive = cohort.filter((p) => p.status === 'issued_paid');
  const p13 = cohort.length >= 5 ? Math.round(cohortActive.length / cohort.length * 100) : null;

  return {
    by_count: byCount, by_premium: byPremium,
    placed: placed.length, active: active.length, terminated: term.length,
    p13, cohort_size: cohort.length,
    cohort_note: p13 == null ? 'Book too young for 13-month persistency — populates as policies cross 13 months on the books.' : null,
  };
}

// ---------- Carrier in-force reconciliation ----------
// rows: [{ policy_number, monthly_premium?, status? }] from a carrier in-force/commission file.
function reconcile(user, rows) {
  const s = scope(user);
  const pols = db.prepare(`SELECT p.*, l.first_name, l.last_name FROM policies p LEFT JOIN leads l ON l.id=p.lead_id
    WHERE ${s.sql} AND p.status='issued_paid'`).all(...s.params);
  const norm = (x) => String(x || '').replace(/\s+/g, '').toUpperCase();
  const carrierMap = new Map();
  (rows || []).forEach((r) => { const k = norm(r.policy_number); if (k) carrierMap.set(k, r); });
  const crmMap = new Map(); pols.forEach((p) => { const k = norm(p.policy_number); if (k) crmMap.set(k, p); });

  const matched = [], premium_mismatch = [], not_in_carrier_file = [], missing_in_crm = [];
  for (const p of pols) {
    const k = norm(p.policy_number);
    const c = k && carrierMap.get(k);
    if (!c) { not_in_carrier_file.push({ name: `${p.first_name||''} ${p.last_name||''}`.trim(), policy_number: p.policy_number, carrier: p.carrier, annual: ann(p) }); continue; }
    const cp = c.monthly_premium != null ? Number(c.monthly_premium) : null;
    if (cp != null && p.monthly_premium != null && Math.abs(cp - p.monthly_premium) > 0.5) {
      premium_mismatch.push({ name: `${p.first_name||''} ${p.last_name||''}`.trim(), policy_number: p.policy_number, crm_monthly: p.monthly_premium, carrier_monthly: cp });
    } else matched.push(p.policy_number);
  }
  for (const [k, r] of carrierMap) if (!crmMap.has(k)) missing_in_crm.push({ policy_number: r.policy_number, monthly_premium: r.monthly_premium ?? null });

  return {
    summary: { crm_in_force: pols.length, carrier_rows: carrierMap.size, matched: matched.length,
      premium_mismatch: premium_mismatch.length, not_in_carrier_file: not_in_carrier_file.length, missing_in_crm: missing_in_crm.length },
    premium_mismatch, not_in_carrier_file, missing_in_crm,
  };
}

module.exports = { init, atRisk, markPayment, earnings, byCarrier, compGrid, setCompRate, seedCompGridFromPolicies, persistency, reconcile, CHARGEBACK_MONTHS };
