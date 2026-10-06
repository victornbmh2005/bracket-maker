// CRUD for the rating_items table (the songs/movies being rated).
//   POST   /api/rating-items                  create {list_id, name, image?, link?}
//   GET    /api/rating-items?list_id=…        list a list's items
//   GET    /api/rating-items/:id              read one, with its scores
//   PATCH  /api/rating-items/:id              update name, image, link and/or position
//   DELETE /api/rating-items/:id              delete (its scores go with it)
//   POST   /api/rating-items/import/youtube   add every video of a YouTube playlist
//   POST   /api/rating-items/import/spotify   add Spotify tracks from pasted links
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError, isUuid, requireUuid, cleanName, cleanImage, cleanLink, cleanPosition } from '../validate.js';
import { requirePlaylistId, requireTrackIds, fetchYoutubeItems, fetchSpotifyItems, bulkInsert } from '../imports.js';
import { MAX_ITEMS, touchList } from './rating-lists.js';
import { summarize } from '../scoring.js';

const router = Router();
const NOT_FOUND = 'Item not found';
const COLUMNS = 'id, list_id, name, image, link, position, created_at';
const COUNT = 'SELECT count(*)::int AS count, COALESCE(max(position) + 1, 0) AS next FROM rating_items WHERE list_id = $1';
const TOO_MANY = `A list can have at most ${MAX_ITEMS} items`;

async function findItem(db, id) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM rating_items WHERE id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return rows[0];
}

async function lockList(client, listId) {
  const { rows } = await client.query('SELECT id FROM rating_lists WHERE id = $1 FOR UPDATE', [listId]);
  if (!rows[0]) throw new HttpError(404, 'Rating list not found');
}

// Create. Goes to the end.
router.post('/', async (req, res) => {
  const body = req.body ?? {};
  if (!isUuid(body.list_id)) throw new HttpError(400, 'list_id is required');
  const data = [cleanName(body.name), cleanImage(body.image), cleanLink(body.link)];

  const item = await withTransaction(async client => {
    await lockList(client, body.list_id);
    const { rows: [{ count, next }] } = await client.query(COUNT, [body.list_id]);
    if (count >= MAX_ITEMS) throw new HttpError(400, TOO_MANY);
    const { rows } = await client.query(
      `INSERT INTO rating_items (list_id, name, image, link, position) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
      [body.list_id, ...data, next]
    );
    await touchList(client, body.list_id);
    return rows[0];
  });
  res.status(201).json({ ...item, scores: {}, score: null, rated: 0, complete: false });
});

// ---------- Imports (same inputs as the participant imports) ----------
async function roomLeft(listId) {
  if (!isUuid(listId)) throw new HttpError(400, 'list_id is required');
  const { rows: [l] } = await pool.query(
    'SELECT (SELECT count(*)::int FROM rating_items i WHERE i.list_id = l.id) AS count FROM rating_lists l WHERE l.id = $1',
    [listId]
  );
  if (!l) throw new HttpError(404, 'Rating list not found');
  if (l.count >= MAX_ITEMS) throw new HttpError(400, TOO_MANY);
  return MAX_ITEMS - l.count;
}

async function respondImport(res, listId, fetched) {
  const added = await withTransaction(async client => {
    await lockList(client, listId);
    const { rows: [{ count, next }] } = await client.query(COUNT, [listId]);
    const fit = fetched.items.slice(0, Math.max(0, MAX_ITEMS - count));
    if (!fit.length) throw new HttpError(400, TOO_MANY);
    const rows = await bulkInsert(client, {
      table: 'rating_items', parentColumn: 'list_id', parentId: listId, start: next, items: fit, columns: COLUMNS,
    });
    await touchList(client, listId);
    return rows;
  });
  res.status(201).json({
    playlist_title: fetched.title,
    added: added.map(i => ({ ...i, scores: {}, score: null, rated: 0, complete: false })),
    skipped_unavailable: fetched.unavailable,
    truncated: fetched.truncated || added.length < fetched.items.length,
  });
}

router.post('/import/youtube', async (req, res) => {
  const body = req.body ?? {};
  const playlistId = requirePlaylistId(body.url);
  const room = await roomLeft(body.list_id);
  await respondImport(res, body.list_id, await fetchYoutubeItems(playlistId, room));
});

router.post('/import/spotify', async (req, res) => {
  const body = req.body ?? {};
  const ids = requireTrackIds(body.links);
  const room = await roomLeft(body.list_id);
  await respondImport(res, body.list_id, await fetchSpotifyItems(ids, room));
});

// List.
router.get('/', async (req, res) => {
  const listId = req.query.list_id;
  if (!isUuid(listId)) throw new HttpError(400, 'list_id is required');
  const { rowCount } = await pool.query('SELECT 1 FROM rating_lists WHERE id = $1', [listId]);
  if (!rowCount) throw new HttpError(404, 'Rating list not found');
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM rating_items WHERE list_id = $1 ORDER BY position, created_at`, [listId]);
  res.json(rows);
});

// Read one, with its scores and average.
router.get('/:id', async (req, res) => {
  const item = await findItem(pool, requireUuid(req.params.id, NOT_FOUND));
  const [{ rows: criteria }, { rows: ratings }] = await Promise.all([
    pool.query('SELECT id FROM rating_criteria WHERE list_id = $1', [item.list_id]),
    pool.query('SELECT item_id, criterion_id, score FROM ratings WHERE item_id = $1', [item.id]),
  ]);
  res.json(summarize(criteria, [item], ratings).items[0]);
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

  const { rows } = await pool.query(`UPDATE rating_items SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`, values);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  await touchList(pool, rows[0].list_id);
  res.json(rows[0]);
});

// Delete.
router.delete('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const { rows } = await pool.query('DELETE FROM rating_items WHERE id = $1 RETURNING list_id', [id]);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  await touchList(pool, rows[0].list_id);
  res.status(204).end();
});

export default router;
