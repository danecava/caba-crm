'use strict';
/*
 * ai.js — Phase 6. The AI layer.
 *
 * Works with ZERO setup: every feature has a deterministic engine that runs
 * offline. Set ANTHROPIC_API_KEY (and optionally AI_MODEL) and the same
 * features upgrade to real natural-language generation — the deterministic
 * output becomes the grounding context handed to the model, so answers stay
 * factual. aiComplete() is the single swap point.
 */
const { db } = require('./../db');
const auth = require('./../auth');

const KEY = process.env.ANTHROPIC_API_KEY || null;
const MODEL = process.env.AI_MODEL || 'claude-3-5-haiku-latest';
const aiEnabled = () => !!KEY;

// Optional LLM call. Returns text, or null on any failure → caller uses fallback.
async function aiComplete(system, user, max = 500) {
  if (!KEY) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: max, system, messages: [{ role: 'user', content: user }] }),
    });
    const j = await r.json();
    return j && j.content && j.content[0] && j.content[0].text ? j.content[0].text.trim() : null;
  } catch { return null; }
}

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };
const hoursSince = (ts) => ts ? (Date.now() - new Date(ts.replace(' ', 'T')).getTime()) / 3.6e6 : 9999;
const money = (n) => '$' + (Number(n) || 0).toLocaleString();
const STAGE_WEIGHT = { 'New': 1.0, 'Contacted': 1.4, 'Quoted': 2.2, 'Application Submitted': 2.6, 'Underwriting': 1.6, 'Issued-Paid': 0.4, 'Retention': 0.3 };

function scoreLead(l) {
  const priorityW = l.priority === 1 ? 1.6 : l.priority === 2 ? 1.0 : 0.6;
  const stageW = STAGE_WEIGHT[l.stage] ?? 1;
  const premW = 0.5 + Math.min(2.5, (l.premium_potential || 0) / 1200);
  const h = hoursSince(l.last_contact_at);
  const staleW = l.stage === 'New' ? 1.8 : (h < 1 ? 0.3 : h < 24 ? 1.0 : h < 48 ? 1.6 : h < 96 ? 1.2 : 0.8);
  return +(priorityW * stageW * premW * staleW).toFixed(2);
}

// Why this lead is ranked where it is — short, human.
function explain(l) {
  const bits = [];
  if (l.stage === 'New') bits.push('brand-new — speed-to-lead window');
  else if (['Quoted', 'Application Submitted'].includes(l.stage)) bits.push(`${l.stage.toLowerCase()} — close to money`);
  const h = hoursSince(l.last_contact_at);
  if (l.stage !== 'New' && h >= 48) bits.push(`cold ${Math.round(h)}h — about to slip`);
  else if (l.stage !== 'New' && h >= 24) bits.push('aging into the danger zone');
  if (l.priority === 1) bits.push('hot priority');
  if ((l.premium_potential || 0) >= 1800) bits.push(`high AP (${money(l.premium_potential)})`);
  return bits.slice(0, 2).join(' · ') || 'steady follow-up';
}

function leadScope(user) { return auth.leadScope(user, 'l'); }

// ---------- Daily briefing ----------
async function briefing(user) {
  const scope = leadScope(user);
  const leads = db.prepare(`SELECT l.* FROM leads l WHERE ${scope.sql} AND l.stage NOT IN ('Issued-Paid','Retention') AND l.dnc=0`).all(...scope.params);
  leads.forEach((l) => (l._s = scoreLead(l)));
  leads.sort((a, b) => b._s - a._s);
  const cold = leads.filter((l) => l.stage !== 'New' && hoursSince(l.last_contact_at) >= 48).length;
  const fresh = leads.filter((l) => l.stage === 'New').length;
  const top = leads.slice(0, 5);

  const ms = monthStart();
  const ap = db.prepare("SELECT COALESCE(SUM(annual_premium),0) ap FROM policies WHERE status='issued_paid' AND issued_at>=? " +
    (auth.canSeeAllAgents(user) ? '' : 'AND agent_id=' + Number(user.id))).get(ms).ap;

  const lines = [];
  lines.push(`Good morning, ${user.name.split(' ')[0]}.`);
  lines.push(`${fresh} new lead${fresh === 1 ? '' : 's'} to hit first, ${cold} going cold (48h+), and ${money(ap)} issued AP so far this month.`);
  if (top.length) {
    lines.push('Your top calls today:');
    top.forEach((l, i) => lines.push(`${i + 1}. ${l.first_name} ${l.last_name} — ${explain(l)}.`));
  }
  lines.push(cold > 0 ? `Clear the ${cold} cold one${cold === 1 ? '' : 's'} before they die. Three by eleven.` : `Book is clean — go get new ones.`);
  const deterministic = lines.join('\n');

  const llm = await aiComplete(
    'You are a sharp, encouraging life-insurance sales coach. Rewrite the briefing in 4-6 punchy sentences. Keep every number and name exactly. No fluff.',
    deterministic, 350);
  return { text: llm || deterministic, ai: !!llm };
}

// ---------- Owner / agent assistant ----------
async function assistant(user, q) {
  const facts = gatherFacts(user, q);
  const llm = await aiComplete(
    'You are the CRM assistant for a virtual life-insurance agency. Answer the user\'s question ONLY from the FACTS provided. Be concise and specific, use the numbers. If the facts don\'t cover it, say what you do know.',
    `Question: ${q}\n\nFACTS:\n${facts.text}`, 400);
  return { text: llm || facts.text, ai: !!llm, topic: facts.topic };
}

function gatherFacts(user, q) {
  const s = (q || '').toLowerCase();
  const ms = monthStart();
  const team = auth.canSeeAllAgents(user);

  if (/pac(e|ing)|number|goal|on track|behind/.test(s)) {
    const agencyAP = db.prepare("SELECT COALESCE(SUM(annual_premium),0) ap FROM policies WHERE status='issued_paid' AND issued_at>=?").get(ms).ap;
    const goal = Number(process.env.AGENCY_GOAL_AP) || db.prepare("SELECT COALESCE(SUM(monthly_goal_ap),0) g FROM users WHERE role IN ('agent','manager')").get().g;
    const now = new Date(); const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const expected = Math.round(goal * (now.getDate() / dim));
    return { topic: 'pacing', text: `Agency issued AP month-to-date: ${money(agencyAP)} of ${money(goal)} goal. Expected by day ${now.getDate()}/${dim}: ${money(expected)}. Status: ${agencyAP >= expected ? 'ON pace' : 'BEHIND by ' + money(expected - agencyAP)}. Dials to close the gap (~$25 AP/dial): ${Math.max(0, Math.round((goal - agencyAP) / 25)).toLocaleString()}.` };
  }
  if (/top|best|leader|ahead|winning|rank/.test(s)) {
    const rows = db.prepare(`SELECT u.name, COALESCE(SUM(p.annual_premium),0) ap FROM users u
      LEFT JOIN policies p ON p.agent_id=u.id AND p.status='issued_paid' AND p.issued_at>=?
      WHERE u.role IN ('agent','manager') GROUP BY u.id ORDER BY ap DESC LIMIT 3`).all(ms);
    return { topic: 'leaderboard', text: 'Top producers MTD: ' + rows.map((r, i) => `${i + 1}) ${r.name} ${money(r.ap)}`).join('; ') + '.' };
  }
  if (/cold|stale|slip|forgot|neglect/.test(s)) {
    const scope = leadScope(user);
    const cold = db.prepare(`SELECT l.first_name, l.last_name, l.stage, l.last_contact_at FROM leads l WHERE ${scope.sql}
      AND l.stage NOT IN ('New','Issued-Paid','Retention') AND l.last_contact_at <= datetime('now','-48 hour')
      ORDER BY l.last_contact_at ASC LIMIT 5`).all(...scope.params);
    return { topic: 'cold', text: cold.length ? `${cold.length} leads cold 48h+: ` + cold.map((c) => `${c.first_name} ${c.last_name} (${c.stage})`).join(', ') + '.' : 'No leads are cold — book is clean.' };
  }
  if (/recruit|applicant|hir|agent count|grow/.test(s)) {
    const total = db.prepare('SELECT COUNT(*) c FROM applicants').get().c;
    const prod = db.prepare("SELECT COUNT(*) c FROM applicants WHERE stage='Producing'").get().c;
    const spend = db.prepare("SELECT COALESCE(SUM(spend),0) s FROM sources WHERE funnel='recruit'").get().s;
    return { topic: 'recruiting', text: `Recruiting pipeline: ${total} applicants, ${prod} producing. Applied→producing ${total ? Math.round(prod / total * 100) : 0}%. Recruit spend ${money(spend)}, cost per producing agent ${prod ? money(Math.round(spend / prod)) : 'n/a'}.` };
  }
  if (/persist|lapse|chargeback|retention/.test(s)) {
    const active = db.prepare("SELECT COUNT(*) c FROM policies WHERE status='issued_paid'").get().c;
    const lapsed = db.prepare("SELECT COUNT(*) c FROM policies WHERE status='lapsed'").get().c;
    return { topic: 'persistency', text: `Persistency: ${active} active vs ${lapsed} lapsed = ${active + lapsed ? Math.round(active / (active + lapsed) * 100) : 100}%. Under 85% means lapses are eating commission — chase month-2 retention.` };
  }
  if (/commission|override|money|paid|income/.test(s)) {
    const money_ = require('./money');
    const c = money_.commissions(user).agency;
    return { topic: 'commission', text: `Commission MTD (${team ? 'agency' : 'you'}): FYC ${money(c.fyc)}, override ${money(c.override)}, pending ${money(c.pending)}, chargebacks ${money(c.chargeback)}, net ${money(c.net)}.` };
  }
  // fallback
  const scope = leadScope(user);
  const open = db.prepare(`SELECT COUNT(*) c FROM leads l WHERE ${scope.sql} AND l.stage NOT IN ('Issued-Paid','Retention')`).get(...scope.params).c;
  return { topic: 'help', text: `I can answer questions about pacing to goal, your top producers, cold leads, recruiting, persistency, and commissions. (You currently have ${open} open leads in scope.) Try: "How are we pacing?", "Who's cold?", or "What's our cost per producing agent?"` };
}

// ---------- Call summary (transcript → CRM) ----------
async function callSummary(transcript) {
  const t = (transcript || '').toLowerCase();
  let outcome = 'connected';
  if (/not interested|don't want|no thanks|stop calling/.test(t)) outcome = 'not_interested';
  else if (/voicemail|left a message|no answer/.test(t)) outcome = 'voicemail';
  else if (/sold|approved|signed|submit(ted)? the app|took the policy/.test(t)) outcome = 'sold';
  else if (/call me|call back|next week|tomorrow|follow up|think about/.test(t)) outcome = 'callback';

  let next_step = '';
  const m = t.match(/(call back|follow up|callback)[^.]*(tomorrow|monday|tuesday|wednesday|thursday|friday|next week|this week|tonight|at \d)/);
  if (m) next_step = 'Follow up ' + m[2];
  else if (outcome === 'sold') next_step = 'Submit application + collect payment info';
  else if (outcome === 'callback') next_step = 'Scheduled callback';
  else if (outcome === 'not_interested') next_step = 'Mark lost or nurture';

  const clean = (transcript || '').replace(/\s+/g, ' ').trim();
  let summary = clean.length > 220 ? clean.slice(0, 217) + '…' : clean;

  const llm = await aiComplete(
    'Summarize this sales call transcript in 1-2 sentences for a CRM note. Then we already have outcome and next step separately, so just the summary. Be factual.',
    clean, 200);
  if (llm) summary = llm;
  return { summary, outcome, next_step };
}

// ---------- Suggested first-touch reply ----------
async function suggestReply(inbound, lead) {
  const t = (inbound || '').toLowerCase();
  const first = lead.first_name || 'there';
  let reply;
  if (/price|cost|how much|expensive|afford/.test(t)) reply = `Great question, ${first} — it depends on a couple of factors but most folks in your situation land around a dollar or two a day. Want me to run your exact rate real quick? Takes 3 minutes.`;
  else if (/not interested|stop|no thanks|remove/.test(t)) reply = `No problem, ${first} — I won't keep bugging you. If anything changes and you want to protect the family down the road, I'm one text away. Take care.`;
  else if (/busy|later|call back|tomorrow|not now/.test(t)) reply = `Totally understand, ${first}. When's a better time today or tomorrow for a quick 5-minute call? I'll make it fast.`;
  else if (/yes|interested|sounds good|okay|sure|ready/.test(t)) reply = `Love it, ${first}. I'll call you right now to lock in your options — answer when you see my number. If now's bad, what time works?`;
  else reply = `Thanks ${first}! Quick question so I can help — are you looking to cover a mortgage, replace income, or final expenses? I'll point you to the right option.`;

  const llm = await aiComplete(
    `You are a warm, compliant life-insurance agent texting a lead named ${first}. Write ONE short SMS reply (under 320 chars) to their message. No emojis, include a clear next step.`,
    `Lead said: "${inbound}"`, 160);
  return { reply: llm || reply, ai: !!llm };
}

module.exports = { aiEnabled, briefing, assistant, callSummary, suggestReply, explain, scoreLead };
