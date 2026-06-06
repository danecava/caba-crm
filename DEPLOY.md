# Make Caba Life CRM a live website (Render)

Total time ~10 minutes. You do the two logins; everything else is point-and-click. The repo already contains `render.yaml` and a `Dockerfile`, so Render deploys it automatically.

## Step 1 — Get the code onto GitHub (one of these)

**Easiest (no terminal): drag-and-drop**
1. Sign in / sign up at https://github.com (free).
2. Click **New** → name it `caba-crm` → **Create repository**.
3. On the empty repo page, click **uploading an existing file**.
4. **Unzip `caba-crm.zip`**, then drag the *contents* of the `caba-crm` folder (server.js, db.js, the `lib` and `public` folders, etc.) onto the upload area. GitHub preserves the folder structure.
5. Click **Commit changes**.

**Or, if you use Terminal (30 seconds):**
```bash
cd path/to/caba-crm
git init && git add . && git commit -m "Caba Life CRM"
gh repo create caba-crm --private --source=. --push   # needs GitHub CLI
# (or create the repo on github.com first, then: git remote add origin <url> && git push -u origin main)
```

## Step 2 (Railway — recommended for real use, data persists)
1. Go to https://railway.com → **Login** → **Login with GitHub** (one click).
2. **New Project** → **Deploy from GitHub repo** → pick `caba-crm`. Railway reads the `Dockerfile` / `railway.json` and builds automatically.
3. Open the service → **Variables** → add:
   - `JWT_SECRET` = a long random string
   - `AGENCY_GOAL_AP` = `125000` (your monthly AP goal)
   - `AGENCY_NAME` = `Caba Life`
   - `DB_PATH` = `/app/data/caba-crm.db`
   - *(optional)* `ANTHROPIC_API_KEY` to make the AI layer live
4. **Add a Volume** (this is why Railway: your data persists). Service → **Volume** → mount path `/app/data`. ~1 GB is plenty.
5. **Settings → Networking → Generate Domain** → you get `https://caba-crm-production.up.railway.app`.
6. Open it, log in as `dane@cabalife.com` / `changeme123`, **change your password immediately**, then add your real agents under Team.

Cost: one-time $5 credit (30 days, no card), then Hobby $5/mo which covers a small app like this.

## Step 2 (Render — alternative, free but data resets)
1. Go to https://render.com → **Get Started** → **Sign in with GitHub** (one click).
2. **New** → **Blueprint** → pick your `caba-crm` repo → Render reads `render.yaml` and fills everything in.
3. It auto-sets `JWT_SECRET`. Confirm `AGENCY_GOAL_AP` (your monthly AP goal) and `AGENCY_NAME`. Optional: add `ANTHROPIC_API_KEY` to turn the AI layer to live natural language.
4. Click **Apply** / **Create**. First build takes 2–4 minutes.
5. Render gives you a public URL like `https://caba-life-crm.onrender.com`. Open it, log in as `dane@cabalife.com` / `changeme123`, and **change your password immediately**.

## Notes
- **Free tier** spins the service down after inactivity (first hit after idle is slow ~30s) and the SQLite file resets on redeploy. Fine for showing the team. For real daily use, add a Render **Disk** (mount at `/app/data`, set `DB_PATH=/app/data/caba-crm.db`) or move to Postgres — both noted in `README.md`.
- Don't deploy automated SMS/calls until A2P 10DLC is registered (see README).
