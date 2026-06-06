# Caba Life CRM — Revenue & Recruiting Engine

A production-shaped CRM purpose-built for a **virtual (telesales) life insurance agency**. It exists to move two numbers up and to the right: **issued-paid annualized premium (AP)** and **producing-agent count**. Built zero-dependency on Node 22's built-ins — no `npm install`, no native build, no cloud account required to run it.

---

## Run it in 30 seconds

You need **Node 22 or newer** (check with `node --version`).

```bash
cd caba-crm
node server.js
```

Then open **http://localhost:3000** and sign in:

| Role | Email | What they see |
|------|-------|---------------|
| Owner | `dane@cabalife.com` | Everything — full scoreboard, all books, recruiting |
| Manager | `marcus@cabalife.com` | His downline's books + team scoreboard |
| Agent | `jasmine@cabalife.com` | Only her own book + her own number |
| Recruiter | `bianca@cabalife.com` | The recruiting pipeline |

Password for all demo users: **`changeme123`**

The first launch creates `caba-crm.db` and seeds a realistic team, ~80 leads, and 12 recruiting applicants. Delete that file to reset to a clean seed.

> **Change the JWT secret before real use:** `JWT_SECRET="$(openssl rand -hex 32)" node server.js`

---

## What's actually built (working today)

This is **Phases 0, 1, 2, 3, 5, 6 + the Scoreboard** — the full spine of the build prompt except live telephony — running and tested end-to-end.

### Phase 6 — the AI layer (new)

Every AI feature works with **zero setup** via a built-in deterministic engine, and upgrades to real natural-language generation the moment you set `ANTHROPIC_API_KEY` (the computed facts become the model's grounding context, so answers stay accurate either way).

- **Assistant tab** — ask in plain English ("how are we pacing?", "who's cold?", "what's our cost per producing agent?", "how much commission this month?") and get answers computed from live data. Scope-aware: an agent's answers cover only their own book.
- **Daily AI briefing** — top of the Assistant tab: new leads to hit, count going cold, AP MTD, and your ranked top-5 calls *with the reason each made the list*.
- **Call transcript → CRM** — paste a call transcript in any lead's AI tools; it extracts outcome + next step, writes the summary to the timeline, and updates last-contact. No manual note-taking.
- **Draft reply** — suggests a compliant first-touch SMS based on the lead's inbound message (price / not-now / interested / opt-out intents handled).
- **Scored "why"** — the Call Next list now shows a one-line reason under each lead ("application submitted — close to money · aging into the danger zone").

To go live: `ANTHROPIC_API_KEY=sk-... AI_MODEL=claude-3-5-haiku-latest node server.js`. Without it, everything still works.

### Phase 5 — commissions, book & attribution

- **Commission engine with real override math** (Commissions tab). Writing agents earn FYC = issued AP × their contract rate; uplines earn the **telescoping spread** (`AP × (your rate − your downline's rate)`) at every level. Verified: overrides land only on uplines, agents get zero. This is the engine of owner income at scale — your pen goes to zero, override goes up.
- **Pending, chargebacks & persistency.** Submitted policies show as pending commission; lapses trigger chargebacks; the persistency rate is surfaced with a warning under 85% (in life insurance, lapse rate is a survival metric). Scope-aware: agents see only their own line, managers their downline, owner everything.
- **Content → lead → attribution loop** (on the Scoreboard). Per-source ROI: leads, issued, AP, spend, **AP-per-dollar**, and CPA for client sources; **cost-per-producing-agent** for recruit sources — split by the two tracked CTAs. Put spend behind anything returning > 1× AP/$, kill the rest.
- **Book of business** summary (Scoreboard) — total policies and AP, broken out by status and carrier.

### Phase 3 — the recruiting machine + ramp

Agents are the constraint to $1M, so recruiting gets the same machine as lead gen.

- **Recruit speed-to-lead + nurture.** A new applicant (the **⚡ New applicant** button on the Recruiting tab, or POST `/api/recruit-intake`) instantly gets an SMS + email and drops a call task into the **recruiter queue** — then runs a 6-touch "day in the life at the agency" nurture sequence. STOP opt-out and pause logic apply, same as the client engine.
- **Recruiting funnel analytics.** The Recruiting tab now shows in-pipeline count, applied→producing conversion, recruit ad spend, and **cost-per-producing-agent** — the number that tells you if recruiting is healthy.
- **Onboarding / ramp tracker** (Onboarding tab). Every agent has the standard checklist (pre-licensing → first app submitted) with a live completion % and **time-to-first-app** — the key ramp metric. Owners/managers tick steps off; the bar updates.
- **The Playbook** (agent-in-a-box) — scripts, objection handling, hook bank, and product cheat-sheets served to every agent on day one. This is the tooling that makes your recruiting offer hard to say no to.

### Phase 2 — automation

- **Speed-to-lead.** A new lead (POST `/api/intake`, or the **⚡ Test new lead** button on the Today tab) is auto-assigned round-robin to the agent with the lightest book, then *instantly* gets an SMS + email and a call task dropped into that agent's queue. Verified: intake fires the instant touches in the same request.
- **The Today action queue.** The agent's "do this now" screen — due call tasks ranked and ready, with Call / Text / Open / Done. This is the zero-decision start to the day.
- **8–12 touch cadence engine.** Each new lead is enrolled in an editable telesales-life sequence (`lib/cadences.js`) spanning ~7 days of SMS / email / call tasks. A background runner (every 30s) fires due automated touches.
- **Compliance gate (enforced).** Every automated send passes through: TCPA consent check (no consent → blocked + logged), DNC check, and **quiet-hours gating by the lead's state timezone** (8am–9pm local; out-of-window SMS/calls auto-defer to the next legal window). Nothing sends silently — blocks are written to the comms log with a reason.
- **Opt-out + pause logic.** An inbound "STOP" sets DNC, kills consent, and halts all automation. Any other reply — or the agent advancing the stage — **pauses the cadence** so automation never talks over a live conversation.
- **Comms log + cadence panel.** The lead drawer shows cadence status, the next scheduled touches, and the full inbound/outbound message log with send/blocked status. Buttons to pause/start the cadence, simulate an inbound reply, or opt the lead out.

> **Sending is simulated.** Every outbound is written to the `messages` table and timeline as if sent. Going live = replacing the one-line `deliver()` function in `lib/engine.js` with a Twilio/WAVV call. The compliance gate, scheduling, and pause logic are already real.

### Phase 0 / 1 / Scoreboard

- **Auth + RBAC with row-level book isolation.** Agents physically cannot query another agent's leads (verified: an agent requesting a teammate's lead gets a 404). Managers see their downline; owner/admin see all. JWT via HMAC, passwords hashed with scrypt — both Node built-ins.
- **Sales pipeline** — Kanban across the 7 telesales-life stages (New → Contacted → Quoted → Application Submitted → Underwriting → Issued-Paid → Retention). Drag-and-drop between columns (with a move-dropdown fallback for mobile). Every stage change is timestamped and written to the activity log.
- **Lead aging** — cards get an amber left border at 24h untouched, red at 48h. "Going cold" count surfaced on the dashboard.
- **"Call Next" widget** — server-side scoring (`priority × stage value × premium potential × staleness`) ranks every actionable lead and surfaces the top 8 with one-tap Call/Text.
- **Click-to-call / click-to-text everywhere** — every phone number is a `tel:`/`sms:` link that opens the dialer on desktop softphone or phone, and auto-logs the attempt.
- **Lead drawer** — full record, beneficiaries/health notes, policies, TCPA consent flag, full activity timeline, and a log-activity form.
- **Disposition automation (starter)** — moving a lead to Issued-Paid auto-creates/updates its policy so AP flows to the scoreboard with no double entry.
- **Recruiting pipeline** — the parallel applicant board (Applied → … → Producing), the growth engine.
- **Owner scoreboard** — "The Number" tile (agency AP vs. goal, expected-by-today pace, gap, dials-to-goal) and a **ranked producer leaderboard** (AP MTD, pace %, dials 7d, connects, apps). Agents see only their own number.

## What's scaffolded for later phases

Clearly marked seams, not yet wired to live providers:

- **Live telephony / SMS**: click-to-call uses `tel:`/`sms:` and the cadence engine *simulates* sends. The single swap point is `deliver()` in `lib/engine.js` — wire it to Twilio/WAVV and post call dispositions back to `/api/leads/:id/activity`. Missed-call text-back is a small addition on the same path.
- **AI layer**: lead scoring is live (deterministic); the LLM hooks (first-touch responder, call-summary, daily briefing) attach to the same endpoints.
- **Commissions/overrides, content attribution**: tables exist (`policies`, `sources`); reporting UI is Phase 5.

See `ASSUMPTIONS.md` for every decision I made while you were asleep.

---

## Architecture

```
caba-crm/
├── server.js      # zero-dep HTTP API + static host (node:http)
├── db.js          # schema + seed (node:sqlite)
├── auth.js        # JWT (HMAC) + scrypt + row-level lead scoping
├── lib/
│   ├── cadences.js # follow-up sequences + TCPA quiet-hours helpers
│   ├── engine.js   # speed-to-lead, cadence runner, compliance gate, opt-out
│   ├── recruiting.js # recruit nurture, onboarding tracker, funnel, playbook
│   ├── money.js    # commissions, overrides, persistency, source attribution
│   └── ai.js       # briefing, assistant, call-summary, suggest-reply (offline + LLM)
├── public/
│   ├── index.html # single-accent dark UI shell
│   └── app.js     # vanilla-JS SPA (pipeline, call-next, recruiting, scoreboard)
├── Dockerfile     # Railway/Render one-click
└── package.json
```

- **One source of truth**: a single SQLite database. No second system to reconcile.
- **The whole theme is one CSS variable** (`--accent` in `index.html`) — retune the brand in one line.
- **Mobile-first**: the board scrolls horizontally, cards stay usable, dialer links work on phones.

---

## Deploy to the web (Railway)

1. Push this folder to a GitHub repo.
2. On [railway.app](https://railway.app), New Project → Deploy from repo. It detects Node and runs `node server.js`.
3. Set variables: `JWT_SECRET` (a long random string) and `AGENCY_GOAL_AP` (your monthly AP target, e.g. `125000`).
4. **Persist the database**: SQLite is a file, so attach a Railway **Volume** mounted at `/app/data` and set `DB_PATH=/app/data/caba-crm.db`. Without a volume the data resets on redeploy.
5. Generate a domain, log in as owner, change your password, add your real agents under Team.

> For a large, high-write team (40+ agents hammering it), graduate the storage layer from SQLite to Postgres. The data model is written to port cleanly — `db.js` is the only file that changes.

---

## Honest limitations (read before going live)

- **Compliance is enforced in the engine, but you still owe the carrier paperwork.** Consent checks, DNC/opt-out, and quiet-hours gating are live in `lib/engine.js`. What's *not* here: A2P 10DLC brand/campaign registration (a Twilio/carrier step) and an integration to a national DNC scrubbing service. Wire those alongside live `deliver()` before sending real traffic. The timezone map uses standard offsets (DST approximated) — tighten with a tz library at high volume.
- **SQLite suits a small team.** It's perfect for 1–20 users; move to Postgres before you scale the floor.
- **Telephony is link-based** until you connect WAVV/Twilio.
- This is a **strong foundation to build on or hand to a developer**, not a finished 40-agent platform. It proves the architecture and gives you a working spine.
