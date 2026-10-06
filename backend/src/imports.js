// Shared by the participant and rating-item imports: read the YouTube/Spotify
// input, fetch the items, and insert them in one statement.
import { HttpError } from './validate.js';
import { parsePlaylistId, fetchPlaylist } from './youtube.js';
import { parseTrackIds, fetchTracks } from './spotify.js';

// Checked before anything else, so bad links fail fast (400).
export function requirePlaylistId(url) {
  const id = parsePlaylistId(url);
  if (!id) throw new HttpError(400, 'That is not a YouTube playlist link (it should contain "list=")');
  return id;
}

export function requireTrackIds(links) {
  if (typeof links !== 'string' || links.length > 200_000) {
    throw new HttpError(400, 'links must be text with Spotify track links');
  }
  const ids = parseTrackIds(links);
  if (!ids.length) throw new HttpError(400, 'No Spotify track links found. They look like https://open.spotify.com/track/…');
  return ids;
}

// → { title, items: [{name, image, link}], unavailable, truncated }
export async function fetchYoutubeItems(playlistId, room) {
  const playlist = await fetchPlaylist(playlistId, room);
  if (!playlist.items.length) throw new HttpError(400, 'That playlist has no available videos');
  return playlist;
}

export async function fetchSpotifyItems(ids, room) {
  const tracks = await fetchTracks(ids.slice(0, room));
  if (!tracks.items.length) throw new HttpError(400, "Spotify didn't recognize any of those tracks");
  return { title: '', items: tracks.items, unavailable: tracks.unavailable, truncated: ids.length > room };
}

// Inserts [{name, image, link}] into `table` (participants or rating_items)
// with positions start, start+1, … Returns the new rows in order.
// `table`, `parentColumn` and `columns` come from our code, never from users.
export async function bulkInsert(client, { table, parentColumn, parentId, start, items, columns }) {
  const { rows } = await client.query(
    `INSERT INTO ${table} (${parentColumn}, name, image, link, position)
     SELECT $1, n, i, l, p FROM unnest($2::text[], $3::text[], $4::text[], $5::int[]) AS x(n, i, l, p)
     RETURNING ${columns}`,
    [
      parentId,
      items.map(it => it.name),
      items.map(it => it.image),
      items.map(it => it.link),
      items.map((it, k) => start + k),
    ]
  );
  return rows.sort((a, b) => a.position - b.position);
}
