# Bracket Maker

Make a tournament out of anything: movies, songs, foods. Add participants with a name, an image (a URL or an
uploaded file) and an optional link. Then pick the winner of each matchup until one champion is left.

- YouTube and Spotify links play right inside the matchup.
- There are no accounts. Each tournament has a private link, and anyone you send it to can view and play.
- Play the same tournament many times ("runs"). Each run, choose a bracket size: **cut** to a smaller bracket
  (random participants sit out, and whoever sat out before plays first) or **everyone plays** (with a play-in
  round when the count isn't a power of 2).
- **Stats** add up across runs: titles, win rate, W–L, best finish, times sat out. **History** keeps every run.
- **Ratings mode:** make a list (e.g. a playlist), pick criteria (presets for songs and movies, all editable), and
  score each item 1–10 per criterion, in the list or full screen one by one with keyboard shortcuts. Each item
  gets an average, each criterion an average, and the whole list an overall rating.

## How it's organized

```
frontend/   Plain HTML + CSS + JavaScript (no build step)   → hosted on Vercel
            core.js (shared) · tournaments.js · ratings.js
backend/    Node.js + Express REST API                       → hosted on Render
            backend/db/migrations/ holds the database tables → PostgreSQL on Neon
```

The browser only talks to the backend, and only the backend talks to the database.

### API

| Table | Create | Read (list) | Read (one) | Update | Delete |
|---|---|---|---|---|---|
| tournaments  | `POST /api/tournaments`  | `GET /api/tournaments?ids=a,b`              | `GET /api/tournaments/:id`  | `PATCH /api/tournaments/:id`  | `DELETE /api/tournaments/:id`  |
| participants | `POST /api/participants` | `GET /api/participants?tournament_id=…`     | `GET /api/participants/:id` | `PATCH /api/participants/:id` | `DELETE /api/participants/:id` |
| runs         | `POST /api/runs`         | `GET /api/runs?tournament_id=…`             | `GET /api/runs/:id`         | `PATCH /api/runs/:id`         | `DELETE /api/runs/:id`         |
| rating_lists | `POST /api/rating-lists` | `GET /api/rating-lists?ids=a,b`             | `GET /api/rating-lists/:id` | `PATCH /api/rating-lists/:id` | `DELETE /api/rating-lists/:id` |
| rating_criteria | `POST /api/rating-criteria` | `GET /api/rating-criteria?list_id=…`  | `GET /api/rating-criteria/:id` | `PATCH /api/rating-criteria/:id` | `DELETE /api/rating-criteria/:id` |
| rating_items | `POST /api/rating-items` | `GET /api/rating-items?list_id=…`           | `GET /api/rating-items/:id` | `PATCH /api/rating-items/:id` | `DELETE /api/rating-items/:id` |
| ratings      | `PUT /api/ratings` (create or replace) | `GET /api/ratings?list_id=…`  | –                           | `PUT /api/ratings`            | `DELETE /api/ratings?item_id=…&criterion_id=…` |

Also: `GET /api/runs/options?tournament_id=…` (bracket sizes) and `GET /api/tournaments/:id/stats`.

Participants can't be created, changed or deleted while a run is in progress (the API returns 409). Finish or
delete the run first. Deleting someone who was in a run archives them instead, so history and stats keep them.

**YouTube playlist import:** `POST /api/participants/import/youtube` with `{tournament_id, url}` turns every video in a
public or unlisted playlist into a participant. It needs `YOUTUBE_API_KEY` set on the backend (locally in
`backend/.env`, and on Render under Environment). To get a key: Google Cloud Console → enable **YouTube Data API v3**
→ Credentials → Create API key.

**Spotify import:** `POST /api/participants/import/spotify` with `{tournament_id, links}`. Since February 2026,
Spotify's API doesn't let new apps read playlist contents, so users paste track links instead (Spotify desktop app →
open a playlist → click a song → Ctrl+A, Ctrl+C). Names and covers come from Spotify's public oEmbed endpoint, so
no key is needed. Names are the song title only, without the artist.

**Try the endpoints in Swagger:** with the backend running, open http://localhost:3000/api/docs. The spec is in
`backend/src/openapi.js`; update it whenever a route changes.

### Database migrations

Each change to the tables is a numbered SQL file in `backend/db/migrations/` (`001_initial.sql`, `002_runs.sql`, …).
`npm run migrate` applies the ones not applied yet (tracked in the `schema_migrations` table). On Render, `npm start`
runs the migrations before starting the server, so a deploy updates the live database automatically.

## Run it on your computer

Needs Node.js 20.6 or newer.

1. **Database:** create a free project at [neon.tech](https://neon.tech) and copy its connection string.
2. **Backend:**
   ```sh
   cd backend
   cp .env.example .env        # then paste the connection string into DATABASE_URL
   npm install
   npm run migrate             # creates/updates the tables
   npm run dev                 # API on http://localhost:3000
   ```
3. **Frontend**, in a second terminal:
   ```sh
   npx serve frontend -l 5173  # site on http://localhost:5173
   ```

## Tests

```sh
cd backend
npm test
```

The tests use a separate Neon **branch** so they never touch real data. Put its connection string in `backend/.env`
as `TEST_DATABASE_URL`; the tests refuse to run without it or if it matches `DATABASE_URL`. GitHub Actions runs the
same tests on every push (`.github/workflows/test.yml`), using the `TEST_DATABASE_URL` repository secret.

## Deploy

1. Push the repo to GitHub.
2. **Render → New → Web Service** from the repo:
   - Root Directory: `backend`
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables: `DATABASE_URL` (the Neon string) and `FRONTEND_ORIGIN` (your Vercel URL; you can fill this in after step 3)
3. Put the Render URL into `PRODUCTION_API_URL` in `frontend/config.js`, then commit and push.
4. **Vercel → Add New → Project** from the repo:
   - Root Directory: `frontend`
   - Framework preset: Other, with no build command
5. Set `FRONTEND_ORIGIN` on Render to the Vercel URL, e.g. `https://bracket-maker.vercel.app`.

Render's free plan sleeps when idle, so the first request after a while can take about 30–60 seconds.
