// CRUD for the rating_lists table.
//   POST   /api/rating-lists           create, optionally with criteria names
//   GET    /api/rating-lists?ids=a,b   list the given lists (summaries with scores)
//   GET    /api/rating-lists/:id       read one: criteria, items, scores and averages
//   PATCH  /api/rating-lists/:id       rename
//   DELETE /api/rating-lists/:id       delete (criteria, items and scores go with it)
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError, isUuid, requireUuid, cleanName } from '../validate.js';
import { summarize } from '../scoring.js';

const router = Router();
const NOT_FOUND = 'Rating list not found';
export const MAX_CRITERIA = 20;
export const MAX_ITEMS = 256;

export function cleanCriterionName(v) {
  const name = cleanName(v, 'Criterion name');
  if (name.length > 40) throw new HttpError(400, 'Criterion name must be 40 characters or less');
  return name;
}

// Everything the list page needs, with averages computed.
export async function loadList(db, id) {
  const { rows } = await db.query('SELECT id, name, created_at, updated_at FROM rating_lists WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  const [{ rows: criteria }, { rows: items }, { rows: ratings }] = await Promise.all([
    db.query('SELECT id, list_id, name, position FROM rating_criteria WHERE list_id = $1 ORDER BY position, created_at', [id]),
    db.query('SELECT id, list_id, name, image, link, position, created_at FROM rating_items WHERE list_id = $1 ORDER BY position, created_at', [id]),
    db.query(
      `SELECT r.item_id, r.criterion_id, r.score
         FROM ratings r JOIN rating_items i ON i.id = r.item_id
        WHERE i.list_id = $1`,
      [id]
    ),
  ]);
  return { ...rows[0], ...summarize(criteria, items, ratings) };
}

export const touchList = (db, id) => db.query('UPDATE rating_lists SET updated_at = now() WHERE id = $1', [id]);

// Create. {name, criteria: ['Vocals', 'Lyrics', …]}
router.post('/', async (req, res) => {
  const body = req.body ?? {};
  const name = cleanName(body.name ?? 'Untitled list');
  const criteria = body.criteria ?? [];
  if (!Array.isArray(criteria)) throw new HttpError(400, 'criteria must be a list of names');
  if (criteria.length > MAX_CRITERIA) throw new HttpError(400, `A list can have at most ${MAX_CRITERIA} criteria`);
  const names = criteria.map(cleanCriterionName);

  const id = await withTransaction(async client => {
    const { rows } = await client.query('INSERT INTO rating_lists (name) VALUES ($1) RETURNING id', [name]);
    if (names.length) {
      await client.query(
        `INSERT INTO rating_criteria (list_id, name, position)
         SELECT $1, n, p FROM unnest($2::text[], $3::int[]) AS x(n, p)`,
        [rows[0].id, names, names.map((n, i) => i)]
      );
    }
    return rows[0].id;
  });
  res.status(201).json(await loadList(pool, id));
});

// List. Only the ids asked for (like tournaments, the id is the access).
router.get('/', async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').map(s => s.trim()).filter(isUuid).slice(0, 100);
  if (!ids.length) return res.json([]);

  const [{ rows: lists }, { rows: criteria }, { rows: items }, { rows: ratings }] = await Promise.all([
    pool.query('SELECT id, name, created_at, updated_at FROM rating_lists WHERE id = ANY($1::uuid[]) ORDER BY created_at DESC', [ids]),
    pool.query('SELECT id, list_id FROM rating_criteria WHERE list_id = ANY($1::uuid[])', [ids]),
    pool.query('SELECT id, list_id, name, image, position FROM rating_items WHERE list_id = ANY($1::uuid[]) ORDER BY position, created_at', [ids]),
    pool.query(
      `SELECT r.item_id, r.criterion_id, r.score FROM ratings r
         JOIN rating_items i ON i.id = r.item_id WHERE i.list_id = ANY($1::uuid[])`,
      [ids]
    ),
  ]);
  res.json(lists.map(list => {
    const myItems = items.filter(i => i.list_id === list.id);
    const myItemIds = new Set(myItems.map(i => i.id));
    const { summary } = summarize(
      criteria.filter(c => c.list_id === list.id),
      myItems,
      ratings.filter(r => myItemIds.has(r.item_id))
    );
    return { ...list, ...summary, preview: myItems.slice(0, 4).map(({ id, name, image }) => ({ id, name, image })) };
  }));
});

// Read one.
router.get('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  res.json(await loadList(pool, id));
});

// Update (rename).
router.patch('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const body = req.body ?? {};
  if (body.name === undefined) throw new HttpError(400, 'Nothing to update: send name');
  const { rowCount } = await pool.query(
    'UPDATE rating_lists SET name = $2, updated_at = now() WHERE id = $1',
    [id, cleanName(body.name)]
  );
  if (!rowCount) throw new HttpError(404, NOT_FOUND);
  res.json(await loadList(pool, id));
});

// Delete.
router.delete('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const { rowCount } = await pool.query('DELETE FROM rating_lists WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, NOT_FOUND);
  res.status(204).end();
});

export default router;
