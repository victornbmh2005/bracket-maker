# Bracket Maker

Two modes: **tournaments** (participants → repeated bracket "runs" → stats) and **ratings** (lists of items scored
1–10 per criterion). Monorepo, all JavaScript.

## Layout
- `frontend/`: plain HTML/CSS/JS, **no build step and no framework**. Classic `<script>` tags share one global scope:
  `config.js` (API URL) → `api.js` (one function per endpoint) → `core.js` (shared state, helpers, routing, add/import forms,
  event plumbing) → `tournaments.js` → `ratings.js`. Each mode file registers into `screens`, `actions` (data-action buttons),
  `forms` (by form id) and `changes` (data-onchange inputs) from `core.js`. Two files declaring the same top-level name
  breaks the page; check with `cat config.js api.js core.js tournaments.js ratings.js > /tmp/all.js && node --check /tmp/all.js`.
- `backend/`: Node 20 + Express 5 + `pg`. `src/app.js` builds the app, `src/server.js` listens. One route file per table in
  `src/routes/`. Rules live in `src/bracket.js` (building runs, stats), `src/scoring.js` (rating averages) and
  `src/validate.js`. YouTube/Spotify imports go through `src/imports.js`.
- `backend/db/migrations/NNN_*.sql`: numbered, each applied once (tracked in `schema_migrations`). Never edit an applied
  migration; add a new file. `npm start` runs migrations before the server, so a Render deploy migrates the live DB.

## Commands (in `backend/`)
- `npm test`: node:test, ~5 s. Uses `TEST_DATABASE_URL` (a Neon **test branch**) and refuses to run against `DATABASE_URL`.
  GitHub Actions runs it on every push.
- `npm run dev`: API on :3000 against `DATABASE_URL` (the **live** DB). To try changes locally without touching live data,
  run it against the test branch instead:
  `node --env-file=.env --input-type=module -e 'process.env.DATABASE_URL = process.env.TEST_DATABASE_URL; await import("./src/server.js")'`
- Frontend locally: `npx serve frontend -l 5173` from the repo root.

## Conventions
- Every route change also updates `backend/src/openapi.js` (Swagger at `/api/docs`), the README API table, and tests.
- SQL is always parameterized. Dynamic `SET` clauses only use column names from code.
- Frontend and backend URL rules match: `safeUrl` in `core.js` and `cleanImage`/`cleanLink` in `validate.js`.
- The user is learning. Explain steps plainly and give click-by-click instructions for dashboards (Render, Vercel, Neon).

## Gotchas
- Neon connection strings use the **pooler**: never use session-level advisory locks (they get stuck); use
  `pg_advisory_xact_lock` inside a transaction, as `src/migrate.js` does.
- Pushing to `main` auto-deploys the frontend on Vercel, but Render is deployed **manually**. Push, then deploy Render right
  away, or the live site runs a new frontend against the old API.
- Spotify's API can't read playlists for new apps (since Feb 2026), so the Spotify import takes pasted track links and uses
  the public oEmbed endpoint (titles have no artist).
- Secrets (`DATABASE_URL`, `TEST_DATABASE_URL`, `YOUTUBE_API_KEY`) live only in `backend/.env` (git-ignored) and in Render's
  environment settings. Check nothing secret is staged before committing.
- The user's PC is low on RAM: start local servers only when needed and stop them afterwards (port 5173 has had leftover
  `serve` processes; check with `Get-NetTCPConnection -LocalPort 5173`).
