'use strict';
/*
 * ingest.js — Phase 2: carrier-email auto-tracking.
 * Accepts parsed carrier events (from the Discord/Gmail bot, or any source),
 * matches them to a Cava policy, updates status/payment_status, and fires the
 * SAME chargeback-save workflow + Discord alerts as a manual mark (Phase 1).
 *
 * Auth for the HTTP route is a shared secret (INGEST_TOKEN) — see server.js.
 * Expected event shape (matches the bot's email-parser output):
 *   { event_type, client_first_name, client_last_name, carrier,
 *     policy_number, effective_date, summary, confidence }
 */
const { db } = require('./../db');
const insurance = require('./insurance');
const engine = require('./engine');
const discord = require('./discord');

// event_type -> effect.  polStatus = policies.status ; pay = payment_status (via markPayment) ; flow = which alert
const EVENT_MAP = {
  issued:               { polStatus: 'issued_paid', pay: 'active',     flow: 'issued',     label: 'Issued + first draft' },
  application_received: { polStatus: 'submitted',                      flow: null,         label: 'Application received' },
  underwriting_update:  {                                              flow: null,         label: 'Underwriting update' },
  payment_failed:       {                           pay: 'missed',     flow: 'missed',     label: 'Payment failed' },
  payment_received:     {                           pay: 'active',     flow: 'recovered',  label: 'Payment received (recovered)' },
  chargeback:           {                           pay: 'chargeback', flow: 'chargeback', label: 'Chargeback' },
  denied:               { polStatus: 'declined',                       flow: 'denied',     label: 'Application denied' },
  lapsed:               { polStatus: 'lapsed',      pay: 'chargeback', flow: 'chargeback', label: 'Lapsed (non-payment)' },
  cancelled:            { polStatus: 'lapsed',                         flow: null,         label: 'Cancelled' },
};

const POLICY_JOIN = `SELECT pl.*, l.first_name, l.last_name, l.id AS lead_id
  FROM policies pl LEFT JOIN leads l ON l.id = pl.lead_id`;

function reloadPolicy(id) {
  return db.prepare(`${POLICY_JOIN} WHERE pl.id=?`).get(id);
}

// Match a parsed event to a policy: policy number first (most reliable),
// then first+last name (+ carrier) with a preference for the most recent sale.
function findPolicy(ev) {
  const pn = String(ev.policy_number || '').trim();
  if (pn) {
    const r = db.prepare(`${POLICY_JOIN} WHERE pl.policy_number = ? LIMIT 1`).get(pn);
    if (r) return r;
  }
  const fn = String(ev.client_first_name || '').trim();
  const ln = String(ev.client_last_name || '').trim();
  if (fn && ln) {
    let rows = db.prepare(`${POLICY_JOIN}
      WHERE LOWER(l.first_name)=LOWER(?) AND LOWER(l.last_name)=LOWER(?)`).all(fn, ln);
    const car = String(ev.carrier || '').trim().toLowerCase();
    if (car && car !== 'unknown' && rows.length > 1) {
      const c = rows.filter((r) => {
        const rc = String(r.carrier || '').toLowerCase();
        return rc && (rc.includes(car) || car.includes(rc));
      });
      if (c.length) rows = c;
    }
    rows.sort((a, b) => String(b.date_sold || '').localeCompare(String(a.date_sold || '')));
    if (rows.length) return rows[0];
  }
  return null;
}

// The Phase 1 chargeback-save workflow — identical alerts for manual + auto.
// status ∈ 'missed' | 'active'(recovered) | 'chargeback'
function fireWorkflow(pol, status) {
  if (!pol) return;
  const name = `${pol.first_name || ''} ${pol.last_name || ''}`.trim() || 'Client';
  const annual = Math.round((pol.monthly_premium || (pol.annual_premium ? pol.annual_premium / 12 : 0)) * 12);
  const m2 = pol.effective_date ? Math.max(0, Math.round((Date.now() - new Date(pol.effective_date)) / 2.63e9)) : null;
  const exposure = Math.round(annual * ((pol.comm_pct || 0) / 100) * (m2 == null ? 1 : Math.max(0, (12 - m2) / 12)));
  if (status === 'missed' && pol.lead_id) {
    try { engine.enqueueCadence(pol.lead_id, 'save_missed'); engine.processDue(); } catch {}
    discord.notify(`⚠️ **Missed payment — SAVE NOW**\n${name} · ${pol.carrier || ''}${pol.policy_number ? ' · ' + pol.policy_number : ''}\n$${annual}/yr · ~$${exposure} chargeback exposure${m2 != null ? ' · ' + m2 + ' mo on books' : ''}\nSave task created — recover the draft within 30 days to keep your advance.`);
  } else if (status === 'active' && pol.lead_id) {
    try { engine.pauseLead(pol.lead_id, 'recovered'); } catch {}
    discord.notify(`✅ **Recovered** — ${name} · ${pol.carrier || ''} is back on draft. Advance protected. Nice save. 💰`);
  } else if (status === 'chargeback') {
    discord.notify(`🔻 **Chargeback** — ${name} · ${pol.carrier || ''}${pol.policy_number ? ' · ' + pol.policy_number : ''} lapsed past the save window. ~$${exposure} clawed back.`);
  }
}

// Apply one parsed carrier event. Returns { kind, message } for the bot summary.
function applyEvent(ev) {
  const type = String(ev.event_type || '').trim();
  if (type === 'marketing' || type === 'other' || !EVENT_MAP[type]) {
    return { kind: 'skipped', message: `Skipped (${type || 'no type'}): ${ev.summary || ''}`.trim() };
  }
  const map = EVENT_MAP[type];
  const pol = findPolicy(ev);
  if (!pol) {
    return {
      kind: 'unmatched',
      message: `Couldn't match: ${ev.client_first_name || ''} ${ev.client_last_name || ''} (${ev.carrier || '?'}) — policy ${ev.policy_number || 'n/a'} [${map.label}]`.trim(),
    };
  }

  const before = { status: pol.status, pay: pol.payment_status };

  // Fill effective date if the carrier gave one and we didn't have it.
  if (ev.effective_date && !pol.effective_date) {
    try { db.prepare('UPDATE policies SET effective_date=? WHERE id=?').run(ev.effective_date, pol.id); } catch {}
  }
  // Apply policy-status change (issued / submitted / declined / lapsed).
  if (map.polStatus && map.polStatus !== pol.status) {
    db.prepare('UPDATE policies SET status=? WHERE id=?').run(map.polStatus, pol.id);
  }
  // Apply payment-status change via the canonical setter (active/missed/chargeback).
  if (map.pay) {
    try { insurance.markPayment(pol.id, map.pay); } catch {}
  }

  const after = reloadPolicy(pol.id) || pol;
  const name = `${after.first_name || ''} ${after.last_name || ''}`.trim() || 'Client';

  // No-op if nothing actually changed.
  if (after.status === before.status && after.payment_status === before.pay && !ev.effective_date) {
    return { kind: 'noop', message: `${name} already ${before.status}/${before.pay} — no change` };
  }

  // Fire the alert/automation for this flow.
  if (map.flow === 'missed') fireWorkflow(after, 'missed');
  else if (map.flow === 'recovered') fireWorkflow(after, 'active');
  else if (map.flow === 'chargeback') fireWorkflow(after, 'chargeback');
  else if (map.flow === 'issued') {
    discord.notify(`🆕 **Issued & paid** — ${name} · ${after.carrier || ''}${after.policy_number ? ' · ' + after.policy_number : ''} is on the books${after.effective_date ? ' (eff ' + after.effective_date + ')' : ''}. 💪`);
  } else if (map.flow === 'denied') {
    discord.notify(`❌ **Denied** — ${name} · ${after.carrier || ''}${after.policy_number ? ' · ' + after.policy_number : ''}. Re-quote / replace.`);
  }

  return {
    kind: 'updated',
    policy_id: after.id,
    message: `${name}: ${before.status}/${before.pay} → ${after.status}/${after.payment_status} (${map.label})`,
  };
}

function summarize(results) {
  const c = { updated: 0, unmatched: 0, noop: 0, skipped: 0 };
  for (const r of results) c[r.kind] = (c[r.kind] || 0) + 1;
  return c;
}

module.exports = { applyEvent, fireWorkflow, findPolicy, summarize, EVENT_MAP };
