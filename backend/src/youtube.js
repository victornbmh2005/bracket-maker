// Reads a public/unlisted YouTube playlist through the YouTube Data API v3.
// Needs YOUTUBE_API_KEY. Each page of 50 videos costs 1 unit of the free
// 10,000-units-per-day quota.
import { HttpError } from './validate.js';

const API = 'https://www.googleapis.com/youtube/v3';

// Accepts a playlist URL (youtube.com, music.youtube.com, a watch URL with
// &list=…) or a bare playlist id. Returns the id or null.
export function parsePlaylistId(input) {
  const s = String(input ?? '').trim();
  if (/^[\w-]{12,64}$/.test(s)) return s;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch (e) {
    return null;
  }
  if (!/(^|\.)youtube\.com$|^youtu\.be$/i.test(url.hostname)) return null;
  const list = url.searchParams.get('list');
  return list && /^[\w-]{12,64}$/.test(list) ? list : null;
}

// "Artist - Song (Official Music Video) [4K]" → "Artist - Song"
export function cleanTitle(title) {
  const cleaned = title
    .replace(/\s*[([][^)\]]*\b(official|lyrics?|audio|video|visuali[sz]er|hd|4k|remaster(ed)?|mv)\b[^)\]]*[)\]]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const name = cleaned || title.trim();
  return name.length > 80 ? name.slice(0, 79).trimEnd() + '…' : name;
}

function bestThumbnail(thumbnails = {}) {
  const t = thumbnails.high || thumbnails.medium || thumbnails.standard || thumbnails.default || thumbnails.maxres;
  return t?.url && /^https:\/\//.test(t.url) ? t.url : '';
}

async function call(path, params) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new HttpError(503, "YouTube import isn't set up on the server (YOUTUBE_API_KEY is missing)");

  const url = `${API}/${path}?` + new URLSearchParams({ ...params, key });
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new HttpError(502, "Couldn't reach YouTube. Try again in a moment.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;

  const reason = data.error?.errors?.[0]?.reason;
  if (res.status === 404 || reason === 'playlistNotFound') {
    throw new HttpError(404, 'Playlist not found. Make sure it is public or unlisted.');
  }
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    throw new HttpError(503, 'The daily YouTube import limit was reached. Try again tomorrow.');
  }
  console.error('YouTube API error:', res.status, reason, data.error?.message);
  throw new HttpError(502, 'YouTube refused the request. Check the server API key.');
}

// Returns { title, items: [{ name, image, link }], truncated, unavailable }
// with at most `max` items. Private and deleted videos are skipped and counted.
export async function fetchPlaylist(playlistId, max) {
  const meta = await call('playlists', { part: 'snippet', id: playlistId, maxResults: '1' });
  if (!meta.items?.length) throw new HttpError(404, 'Playlist not found. Make sure it is public or unlisted.');

  const items = [];
  const seen = new Set();
  let unavailable = 0;
  let pageToken;
  do {
    const page = await call('playlistItems', {
      part: 'snippet',
      playlistId,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of page.items ?? []) {
      const s = it.snippet ?? {};
      const videoId = s.resourceId?.videoId;
      if (!videoId || seen.has(videoId)) continue;
      if (s.title === 'Private video' || s.title === 'Deleted video' || !s.thumbnails || !Object.keys(s.thumbnails).length) {
        unavailable++;
        continue;
      }
      seen.add(videoId);
      items.push({
        name: cleanTitle(s.title),
        image: bestThumbnail(s.thumbnails),
        link: `https://www.youtube.com/watch?v=${videoId}`,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken && items.length < max);

  return {
    title: meta.items[0].snippet?.title ?? '',
    items: items.slice(0, max),
    truncated: items.length > max || Boolean(pageToken),   // more videos than room left
    unavailable,
  };
}
