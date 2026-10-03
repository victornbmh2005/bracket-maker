# Bracket Maker

Make a tournament out of anything: movies, songs, foods. Add participants with a name, an image (a URL or an
uploaded file) and an optional link. Then pick the winner of each matchup until one champion is left.

- YouTube and Spotify links play right inside the matchup, and any other link opens in a new tab.
- When the number of participants isn't a power of 2, some get a "bye" and move on automatically.
- Tournaments are saved in your browser (localStorage). They don't sync between devices or browsers.

## Run it
It's a single `index.html` with no build step and no backend.

- Quick look: double-click `index.html`.
- YouTube embeds can show "Error 153" when the page is opened as a file. To avoid that, serve the folder instead,
  for example with `npx serve .`, and open the URL it prints.

## Deploy
- **Vercel:** import the GitHub repo (Framework preset: "Other", no build command), or run `npx vercel` in this folder.
- **Netlify / GitHub Pages / Render Static Site** also work. Just publish the repo root.
