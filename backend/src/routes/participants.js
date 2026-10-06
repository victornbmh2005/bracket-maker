// CRUD for the participants table.
//   POST   /api/participants                  create
//   GET    /api/participants?tournament_id=…  list a tournament's participants
//   GET    /api/participants/:id              read one
//   PATCH  /api/participants/:id              update name, image, link and/or position
//   DELETE /api/participants/:id              delete
//   POST   /api/participants/import/youtube   add every video of a YouTube playlist
//   POST   /api/participants/import/spotify   add Spotify tracks from pasted links
// Create, update, delete and imports are refused (409) while the tournament's
// bracket is running, because the bracket refers to the participants.
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError, isUuid, requireUuid, cleanName, cleanImage, cleanLink, cleanPosition } from '../validate.js';
import { parsePlaylistId, fetchPlaylist } from '../youtube.js';
import { parseTrackIds, fetchTracks } from '../spotify.js';

const router = Router();
const NOT_FOUND = 'Participant not found';
const MAX_PARTICIPANTS = 256;
const COLUMNS = 'id, tournament_id, name, image, link, position, created_at';

// Locks the tournament row so the bracket can't start mid-change.
async function lockEditableTournament(client, tournamentId) {
  const { rows } = await client.query(
    'SELECT rounds IS NOT NULL AS started FROM tournaments WHERE id = $1 FOR UPDATE',
    [tournamentId]
  );
  if (!rows[0]) throw new HttpError(404, 'Tournament not found');
  if (rows[0].started) {
    throw new HttpError(409, 'The bracket has already started. Reset it to change participants.');
  }
}

async function findParticipant(db, id) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM participants WHERE id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return rows[0];
}

// Create. Goes to the end of the list.
router.post('/', async (req, res) => {
  const body = req.body ?? {};
  if (!isUuid(body.tournament_id)) throw new HttpError(400, 'tournament_id is required');
  const name = cleanName(body.name);
  const image = cleanImage(body.image);
  const link = cleanLink(body.link);

  const participant = await withTransaction(async client => {
    await lockEditableTournament(client, body.tournament_id);
    const { rows: [{ count, next }] } = await client.query(
      'SELECT count(*)::int AS count, COALESCE(max(position) + 1, 0) AS next FROM participants WHERE tournament_id = $1',
      [body.tournament_id]
    );
    if (count >= MAX_PARTICIPANTS) {
      throw new HttpError(400, `A tournament can have at most ${MAX_PARTICIPANTS} participants`);
    }
    const { rows } = await client.query(
      `INSERT INTO participants (tournament_id, name, image, link, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      [body.tournament_id, name, image, link, next]
    );
    return rows[0];
  });

  res.status(201).json(participant);
});

// ---------- Imports ----------
// How many participants the tournament still has room for. Checked before
// calling YouTube/Spotify so we don't fetch things we can't store.
async function roomLeft(tournamentId) {
  if (!isUuid(tournamentId)) throw new HttpError(400, 'tournament_id is required');
  const { rows: [t] } = await pool.query(
    `SELECT t.rounds IS NOT NULL AS started,
            (SELECT count(*)::int FROM participants p WHERE p.tournament_id = t.id) AS count
       FROM tournaments t WHERE t.id = $1`,
    [tournamentId]
  );
  if (!t) throw new HttpError(404, 'Tournament not found');
  if (t.started) throw new HttpError(409, 'The bracket has already started. Reset it to change participants.');
  if (t.count >= MAX_PARTICIPANTS) {
    throw new HttpError(400, `A tournament can have at most ${MAX_PARTICIPANTS} participants`);
  }
  return MAX_PARTICIPANTS - t.count;
}

// Adds [{name, image, link}] after the existing participants, in one INSERT.
// Returns the created rows, ordered.
async function insertMany(tournamentId, items) {
  return withTransaction(async client => {
    await lockEditableTournament(client, tournamentId);
    const { rows: [{ count, next }] } = await client.query(
      'SELECT count(*)::int AS count, COALESCE(max(position) + 1, 0) AS next FROM participants WHERE tournament_id = $1',
      [tournamentId]
    );
    const fit = items.slice(0, Math.max(0, MAX_PARTICIPANTS - count));
    if (!fit.length) throw new HttpError(400, `A tournament can have at most ${MAX_PARTICIPANTS} participants`);
    const { rows } = await client.query(
      `INSERT INTO participants (tournament_id, name, image, link, position)
       SELECT $1, n, i, l, p FROM unnest($2::text[], $3::text[], $4::text[], $5::int[]) AS x(n, i, l, p)
       RETURNING ${COLUMNS}`,
      [
        tournamentId,
        fit.map(it => it.name),
        fit.map(it => it.image),
        fit.map(it => it.link),
        fit.map((it, k) => next + k),
      ]
    );
    return rows.sort((a, b) => a.position - b.position);
  });
}

// Import a YouTube playlist: every available video becomes a participant.
router.post('/import/youtube', async (req, res) => {
  const body = req.body ?? {};
  const playlistId = parsePlaylistId(body.url);
  if (!playlistId) throw new HttpError(400, 'That is not a YouTube playlist link (it should contain "list=")');
  const room = await roomLeft(body.tournament_id);

  const playlist = await fetchPlaylist(playlistId, room);
  if (!playlist.items.length) throw new HttpError(400, 'That playlist has no available videos');
  const added = await insertMany(body.tournament_id, playlist.items);

  res.status(201).json({
    playlist_title: playlist.title,
    added,
    skipped_unavailable: playlist.unavailable,
    truncated: playlist.truncated || added.length < playlist.items.length,
  });
});

// Import Spotify tracks from pasted links (copied from a playlist in the
// Spotify desktop app with Ctrl+A, Ctrl+C).
router.post('/import/spotify', async (req, res) => {
  const body = req.body ?? {};
  if (typeof body.links !== 'string' || body.links.length > 200_000) {
    throw new HttpError(400, 'links must be text with Spotify track links');
  }
  const ids = parseTrackIds(body.links);
  if (!ids.length) {
    throw new HttpError(400, 'No Spotify track links found. They look like https://open.spotify.com/track/…');
  }
  const room = await roomLeft(body.tournament_id);

  const tracks = await fetchTracks(ids.slice(0, room));
  if (!tracks.items.length) throw new HttpError(400, "Spotify didn't recognize any of those tracks");
  const added = await insertMany(body.tournament_id, tracks.items);

  res.status(201).json({
    playlist_title: '',
    added,
    skipped_unavailable: tracks.unavailable,
    truncated: ids.length > room || added.length < tracks.items.length,
  });
});

// List (one tournament's participants).
router.get('/', async (req, res) => {
  const tournamentId = req.query.tournament_id;
  if (!isUuid(tournamentId)) throw new HttpError(400, 'tournament_id is required');
  const { rowCount } = await pool.query('SELECT 1 FROM tournaments WHERE id = $1', [tournamentId]);
  if (!rowCount) throw new HttpError(404, 'Tournament not found');
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM participants WHERE tournament_id = $1 ORDER BY position, created_at`,
    [tournamentId]
  );
  res.json(rows);
});

// Read one.
router.get('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  res.json(await findParticipant(pool, id));
});

// Update.
router.patch('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const body = req.body ?? {};

  const sets = [];
  const values = [id];
  const set = (column, value) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (body.name !== undefined) set('name', cleanName(body.name));
  if (body.image !== undefined) set('image', cleanImage(body.image));
  if (body.link !== undefined) set('link', cleanLink(body.link));
  if (body.position !== undefined) set('position', cleanPosition(body.position));
  if (!sets.length) throw new HttpError(400, 'Nothing to update: send name, image, link and/or position');

  const participant = await withTransaction(async client => {
    const current = await findParticipant(client, id);
    await lockEditableTournament(client, current.tournament_id);
    const { rows } = await client.query(
      `UPDATE participants SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
      values
    );
    return rows[0];
  });

  res.json(participant);
});

// Delete.
router.delete('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  await withTransaction(async client => {
    const current = await findParticipant(client, id);
    await lockEditableTournament(client, current.tournament_id);
    await client.query('DELETE FROM participants WHERE id = $1', [id]);
  });
  res.status(204).end();
});

export default router;
