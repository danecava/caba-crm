'use strict';
/*
 * cadences.js — follow-up sequences + TCPA compliance helpers.
 * Edit the STANDARD steps freely; copy is pre-written for telesales life.
 * Channels: 'sms' | 'email' | 'call_task' (call_task = a human dial, shown in the agent's Today queue).
 * offsetMin = minutes after the lead enters the cadence.
 */

// {first}, {agent}, {agency}, {product} are filled at send time.
const STANDARD = {
  key: 'standard_life',
  name: 'Standard Telesales Life — 9 touch',
  steps: [
    { offsetMin: 0,        channel: 'sms',       body: "Hi {first}, this is {agent} with {agency} — you just requested info on {product} coverage. I can text you a quote in 2 min. Are you the best person to talk to? Reply STOP to opt out." },
    { offsetMin: 0,        channel: 'email',     subject: "Your {product} quote from {agency}", body: "Hi {first}, thanks for requesting coverage info. I'm {agent} with {agency}. Reply with your date of birth and I'll get your exact rate over today. Talk soon." },
    { offsetMin: 0,        channel: 'call_task', body: "Speed-to-lead call — dial within 60 seconds while the lead is hot." },
    { offsetMin: 120,      channel: 'call_task', body: "Second attempt — most contacts happen on dial 2-3." },
    { offsetMin: 60 * 24,  channel: 'sms',       body: "{first}, still want me to run that {product} quote? Takes 3 minutes and there's no obligation. — {agent}" },
    { offsetMin: 60 * 26,  channel: 'call_task', body: "Day-2 call attempt." },
    { offsetMin: 60 * 72,  channel: 'sms',       body: "Hey {first}, locking in rates for folks this week. Want me to hold one for you? — {agent}, {agency}" },
    { offsetMin: 60 * 120, channel: 'email',     subject: "Did your timing change, {first}?", body: "No problem if now isn't right. When you're ready to protect the family, I'm one text away. — {agent}" },
    { offsetMin: 60 * 168, channel: 'sms',       body: "Last check-in, {first} — should I close out your file or keep your quote open? Reply 1 to keep it. — {agent}" },
  ],
};

// Missed-payment SAVE sequence — recover the draft before the policy lapses
// (recover within ~30 days and you keep the advanced commission).
const SAVE_MISSED = {
  key: 'save_missed',
  name: 'Missed-Payment Save',
  steps: [
    { offsetMin: 0,        channel: 'call_task', body: "⚠ SAVE CALL — {first} missed a payment. Call NOW to get them back on draft before it lapses. Recover in 30 days = you keep the advance." },
    { offsetMin: 60,       channel: 'sms',       body: "Hi {first}, it's {agent} with {agency} — looks like your last payment didn't go through. Let's get your coverage back on track today so your family stays protected. Reply STOP to opt out." },
    { offsetMin: 60 * 24,  channel: 'call_task', body: "SAVE follow-up — day 2, {first} still not back on draft. Call." },
    { offsetMin: 60 * 72,  channel: 'sms',       body: "{first}, your policy is at risk of lapsing. A 2-minute call fixes the draft and keeps you covered. — {agent}" },
    { offsetMin: 60 * 120, channel: 'call_task', body: "SAVE final attempt — last chance before chargeback window pressure." },
  ],
};

const CADENCES = { [STANDARD.key]: STANDARD, [SAVE_MISSED.key]: SAVE_MISSED };

// ---- quiet hours (TCPA: 8:00am–9:00pm in the LEAD's local time) ----
// Standard UTC offsets. NOTE: DST is approximated (offsets are standard-time);
// fine for gating, tighten with a tz library before high-volume sending.
const STATE_TZ_OFFSET = {
  // Eastern -5
  FL:-5,GA:-5,NC:-5,OH:-5,SC:-5,VA:-5,NY:-5,NJ:-5,PA:-5,MI:-5,IN:-5,
  // Central -6
  TX:-6,TN:-6,MO:-6,IL:-6,AL:-6,MS:-6,LA:-6,WI:-6,MN:-6,IA:-6,AR:-6,OK:-6,KS:-6,
  // Mountain -7
  CO:-7,NM:-7,UT:-7,MT:-7,WY:-7,
  AZ:-7, // no DST
  // Pacific -8
  CA:-8,WA:-8,OR:-8,NV:-8,
};
const DEFAULT_OFFSET = -6;
const QUIET_START = 8;   // 8am
const QUIET_END = 21;    // before 9pm

function localHour(date, state) {
  const off = STATE_TZ_OFFSET[state] ?? DEFAULT_OFFSET;
  return (date.getUTCHours() + off + 24) % 24;
}
function isWithinQuietHours(date, state) {
  const h = localHour(date, state);
  return h >= QUIET_START && h < QUIET_END;
}
// Return a Date at/after `date` that falls inside the allowed window for the state.
function nextAllowed(date, state) {
  const d = new Date(date.getTime());
  for (let i = 0; i < 48; i++) {            // step forward in 30-min hops, max 24h
    if (isWithinQuietHours(d, state)) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 30);
  }
  return d;
}

function fill(tpl, ctx) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? '');
}

// Detect inbound opt-out / stop language
function isOptOut(body) {
  return /\b(stop|unsubscribe|quit|cancel|remove|opt\s?out)\b/i.test(String(body || ''));
}

module.exports = { CADENCES, STANDARD, isWithinQuietHours, nextAllowed, localHour, fill, isOptOut, QUIET_START, QUIET_END };
