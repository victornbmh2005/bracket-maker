# Bracket Maker

Make a tournament out of anything: movies, songs, foods. Add participants with a name, an image (a URL or an
uploaded file) and an optional link. Then pick the winner of each matchup until one champion is left.

- YouTube and Spotify links play right inside the matchup.
- There are no accounts. Each tournament has a private link, and anyone you send it to can view and play.
- When the number of participants isn't a power of 2, some get a "bye" and move on automatically.

## How it's organized

```
frontend/   Plain HTML + CSS + JavaScript (no build step)   → hosted on Vercel
backend/    Node.js + Express REST API                       → hosted on Render
            backend/db/schema.sql holds the database tables  → PostgreSQL on Neon
```

The browser only talks to the backend, and only the backend talks to the database.

### API

| Table | Create | Read (list) | Read (one) | Update | Delete |
|---|---|---|---|---|---|
| tournaments  | `POST /api/tournaments`  | `GET /api/tournaments?ids=a,b`              | `GET /api/tournaments/:id`  | `PATCH /api/tournaments/:id`  | `DELETE /api/tournaments/:id`  |
| participants | `POST /api/participants` | `GET /api/participants?tournament_id=…`     | `GET /api/participants/:id` | `PATCH /api/participants/:id` | `DELETE /api/participants/:id` |

Participants can't be created, changed or deleted while a tournament's bracket is running (the API returns 409).
Reset the bracket first.

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

## Run it on your computer

Needs Node.js 20.6 or newer.

1. **Database:** create a free project at [neon.tech](https://neon.tech) and copy its connection string.
2. **Backend:**
   ```sh
   cd backend
   cp .env.example .env        # then paste the connection string into DATABASE_URL
   npm install
   npm run migrate             # creates the tables
   npm run dev                 # API on http://localhost:3000
   ```
3. **Frontend**, in a second terminal:
   ```sh
   npx serve frontend -l 5173  # site on http://localhost:5173
   ```

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
