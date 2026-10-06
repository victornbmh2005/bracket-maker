// Turns pasted Spotify track links into participants.
// Spotify's Web API no longer lets new apps read playlists (Feb 2026), so the
// user copies the songs from the desktop app (Ctrl+A, Ctrl+C) and pastes the
// links. Each track's name and cover come from Spotify's public oEmbed
// endpoint, which needs no key or login.

const OEMBED = 'https://open.spotify.com/oembed';
const CONCURRENCY = 6;

// Finds track ids in any pasted text: open.spotify.com/track/… links (with or
// without /intl-xx/ and ?si=…) and spotify:track:… URIs. Keeps order, no repeats.
export function parseTrackIds(text) {
  const re = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/|spotify:track:)([A-Za-z0-9]{22})/g;
  const ids = [];
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(re)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

async function fetchTrack(id) {
  const link = `https://open.spotify.com/track/${id}`;
  try {
    const res = await fetch(`${OEMBED}?url=${encodeURIComponent(link)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json();
    const title = String(data.title ?? '').trim();
    if (!title) return null;
    const image = /^https:\/\//.test(data.thumbnail_url ?? '') ? data.thumbnail_url : '';
    return { name: title.length > 80 ? title.slice(0, 79).trimEnd() + '…' : title, image, link };
  } catch (e) {
    return null;
  }
}

// Looks up the tracks a few at a time. Returns { items, unavailable } in the
// pasted order; tracks Spotify doesn't know are counted in `unavailable`.
export async function fetchTracks(ids) {
  const results = new Array(ids.length);
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const i = next++;
      results[i] = await fetchTrack(ids[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
  const items = results.filter(Boolean);
  return { items, unavailable: ids.length - items.length };
}
