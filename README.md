# Marina Smashers — self-hosted on your own domain

This is your badminton app as a normal website, with a real database so games
are stored permanently and shared across everyone in the group.

## How it works (the 30-second version)
- **Frontend** (what people see): a React site, hosted free on Vercel.
- **Database** ("dedicated memory"): a free Supabase Postgres project. All shared
  game data lives in one small table called `kv`.
- **Your domain**: pointed at Vercel with a couple of DNS records.

Your code already routed every save/load through two functions. Those now talk to
Supabase for shared data (games, standings, history) and to the device's own
localStorage for personal preferences (light/dark theme). Nothing else changed.

---

## Prerequisites
- A computer with **Node.js 18+** installed (https://nodejs.org — "LTS").
- A free **Supabase** account (https://supabase.com).
- A free **Vercel** account (https://vercel.com).
- Your **domain** (from wherever you bought it — GoDaddy, Namecheap, etc.).

---

## Step 1 — Create the database (Supabase)
1. Go to supabase.com, sign in, click **New project**. Name it `marina-smashers`,
   set a database password (save it), pick the region closest to Dubai, create.
2. Wait ~2 min for it to provision.
3. Open **SQL Editor -> New query**, paste the entire contents of `supabase.sql`
   (included in this project), and click **Run**. This creates the `kv` table.
4. Open **Project Settings -> API** and copy two values:
   - **Project URL**
   - **anon public** key
   You'll paste these in Step 2 and Step 3.

## Step 2 — Run it on your computer (to test)
1. Open a terminal in this project folder.
2. Copy `.env.example` to `.env` and paste in your two Supabase values:
   ```
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-public-key
   ```
3. Install and run:
   ```
   npm install
   npm run dev
   ```
4. Open the URL it prints (usually http://localhost:5173). Add a couple of players,
   generate a round, enter a score. Refresh the page — the data should still be there.
   If it is, Supabase is wired up correctly.

## Step 3 — Put it on the internet (Vercel)
Easiest path (no command line):
1. Push this folder to a **GitHub** repo (or use "Deploy from local" — see note below).
2. On vercel.com click **Add New -> Project**, import the repo.
3. Vercel auto-detects Vite. Before deploying, open **Environment Variables** and add:
   - `VITE_SUPABASE_URL` = your project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon public key
4. Click **Deploy**. In ~1 minute you get a live URL like
   `smashallah.vercel.app`. Test it on your phone.

No GitHub? Install the CLI instead: `npm i -g vercel`, then run `vercel` in this
folder and follow the prompts (add the two env vars when asked, or in the dashboard).

## Step 4 — Connect your custom domain
1. In your Vercel project: **Settings -> Domains -> Add**, type your domain
   (e.g. `smashallah.com` or a subdomain like `play.yourdomain.com`).
2. Vercel shows you the DNS records to create. Typically:
   - For a **subdomain** (recommended, simplest): a **CNAME** record
     `play` -> `cname.vercel-dns.com`.
   - For a **root domain**: an **A** record to the IP Vercel gives you.
3. Log in to your domain registrar, open its DNS settings, and add exactly those
   records. Save.
4. Back in Vercel, wait for the domain to show **Valid** (minutes to an hour).
   HTTPS is issued automatically. Done — share that URL with the group.

## Step 5 — Share
Send the group the domain link. No accounts, no login: everyone who opens it sees
the same live scoreboard, exactly like before. One person keeps score; others tap
the sync button to refresh.

---

## Security (please read)
This uses the Supabase **anon public** key in the browser, and the table policies
allow anyone who has the site to read and write. That's fine for a small private
group tool, but the URL is effectively the password. To lock it down later you can:
- Keep the domain unadvertised (simplest).
- Add a shared passcode gate in the app.
- Turn on Supabase Auth and restrict the policies to signed-in users.
Ask and I can add any of these.

## Moving last week's data over (optional)
Your Claude version has a **Backup & restore** panel (History tab). On the Claude
app tap **Copy backup**, then on your new site open the same panel, paste it into
**Restore**, and confirm. Done.

## Troubleshooting
- **Data doesn't persist / doesn't sync:** the env vars are missing or wrong.
  Check `.env` locally and the Environment Variables in Vercel, then redeploy.
- **Blank page after deploy:** open the browser console; a Supabase key typo is the
  usual cause.
- **"new row violates row-level security":** re-run `supabase.sql` — the policies
  didn't get created.
