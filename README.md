# ASD Project Hub

Team project tracker + calendar/scheduling app (React + Vite), built to sync live across your team via Supabase and deploy on Vercel.

## What's here

- `src/AppRoot.jsx` — the app (project cards, checklists, calendar, attachments)
- `src/useSyncedState.js` — syncs state to Supabase + live-updates every open browser tab
- `src/supabaseClient.js` — Supabase connection (reads env vars)
- `supabase.sql` — database schema to run once in Supabase

**Important:** without Supabase configured, the app still runs but each browser has its own separate copy of the data that resets on refresh — nothing is shared or saved. Steps 1–2 below fix that.

## 1. Create a Supabase project (free tier is enough)

1. Go to https://supabase.com → New project.
2. Once created, open **SQL Editor** → paste the contents of `supabase.sql` → Run.
3. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key.

## 2. Set environment variables

Copy `.env.example` to `.env` and fill in the values from step 1:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

(You'll add the same two values in Vercel in step 4 — Vercel doesn't read your local `.env` file.)

## 3. Push this folder to GitHub

```
cd asd-project-hub
git init
git add .
git commit -m "Initial commit"
```

Create a new empty repo on GitHub, then:

```
git remote add origin https://github.com/YOUR-USERNAME/asd-project-hub.git
git push -u origin main
```

## 4. Deploy on Vercel

1. Go to https://vercel.com → Add New → Project → import the GitHub repo.
2. Vercel auto-detects Vite — leave build settings as default.
3. Under **Environment Variables**, add:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Click Deploy. You'll get a live URL (e.g. `asd-project-hub.vercel.app`) to share with the team.

Every git push to `main` auto-redeploys.

## Notes / known limitations

- **Login is identity selection, not real security.** The PIN screen (in `AppRoot.jsx`, `MEMBER_PIN`) just lets each teammate pick who they are — the PINs are visible in the app's source code to anyone who looks. It's fine for an internal tool where the URL itself isn't public, but it won't stop a determined person. If you want real access control later, add Supabase Auth later and we can wire it in.
- **Database access is wide open by design for now** — the SQL schema grants the anon key full read/write on the `app_data` table (see the comment in `supabase.sql`). Anyone with your Supabase URL + anon key (which ships in the built JS bundle, as normal for this kind of app) can read/write your data. Reasonable for a 5–10 person internal tool; not something to expose publicly.
- **File attachments** (screenshots, PDFs, etc. in checklist items) are stored as base64 inside the synced JSON blob. Fine for occasional small files; if the team starts attaching lots of large files, ask to migrate attachment storage to Supabase Storage (cleaner and cheaper at scale).

## Local development

```
npm install
npm run dev
```
