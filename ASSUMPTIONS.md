# Decisions I made while you were asleep

You told me to default to action and note assumptions rather than stall. Here's every meaningful call I made, and why — so you can overrule any of them in the morning.

## Build vs. integrate
- **Built standalone, not on top of GHL.** Your North Star #1 is one source of truth. Stacking on GHL would mean two systems to reconcile. I built the spine as its own app and left WAVV/Twilio/GHL as documented integration seams. *Overrule if* you'd rather keep GHL as the system of record and have this be a dashboard layer only.

## Tech stack
- **Zero dependencies, Node 22 built-ins** (`node:sqlite`, `node:http`, `node:crypto`). Reason: the build sandbox blocks npm, but more importantly this means *you* can run it with nothing but Node installed — no `npm install`, no native compile, no version hell. It also makes the code trivially auditable.
- **SQLite, not Postgres.** Right call for 1–20 users and instant local run. README documents the exact path to Postgres for a 40-agent floor (only `db.js` changes).
- **JWT via HMAC + scrypt hashing** instead of a library. Same zero-dep reasoning; both are standard, vetted Node crypto primitives.

## Product scope tonight
- Shipped **Phase 0 + Phase 1 + the Scoreboard** as working code, because those prove the architecture and are the parts you'd feel immediately. Automation/cadences, full compliance enforcement, commissions UI, and the LLM layer are scaffolded with clear seams, not faked.
- **Call-Next scoring formula**: `priority × stage-weight × premium-potential × staleness`, with staleness peaking in the 24–48h danger window. Weights live at the top of `server.js` — tune them to your close data.
- **Dials-to-goal** uses a placeholder efficiency of **$25 AP per dial**. Replace with your real number once you have it; it's one constant.
- **Agency goal** defaults to the sum of agent goals, or set `AGENCY_GOAL_AP`. I seeded agent goals at $20–30k/mo.

## Data & seed
- Seeded a realistic team mirroring your real structure: you (owner), a manager (Marcus) with three downline agents, a fourth agent reporting to you, and a recruiter (Bianca). ~80 leads weighted toward top-of-funnel, 12 applicants, policies on advanced-stage leads.
- **Default password for all seed users is `changeme123`** — fine for a local demo, change immediately for anything real.
- Products seeded: mortgage protection, final expense, term, IUL. Carriers are placeholders (Americo, Mutual of Omaha, Foresters, etc.) — swap for your real carrier grid.

## Things I deliberately did NOT do
- **No automated outbound.** I did not wire live SMS/calls because that needs A2P 10DLC registration and consent enforcement first; sending without it risks your sender reputation and license.
- **No real money/commission posting** — comp tables exist but I didn't fabricate payout numbers.
- **Branding**: used "Caba Life" since that matched your data. You've been rebranding toward "Breakthrough Financial" — say the word and I'll sweep the name + retune `--accent` to the brand gold.

## First questions for you in the morning
1. Integrate GHL/WAVV, or replace them with this?
2. Telephony: WAVV or Twilio?
3. Real monthly AP goal and your actual AP-per-dial number, so the scoreboard math is yours, not my placeholders?
4. Brand: keep "Caba Life" or switch to "Breakthrough Financial"?
