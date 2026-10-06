// CRUD for the rating_criteria table (Vocals, Lyrics…).
//   POST   /api/rating-criteria              create {list_id, name}
//   GET    /api/rating-criteria?list_id=…    list a list's criteria
//   GET    /api/rating-criteria/:id          read one
//   PATCH  /api/rating-criteria/:id          rename and/or move {name, position}
//   DELETE /api/rating-criteria/:id          delete (its scores go with it)
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError, isUuid, requireUuid, cleanPosition } from '../validate.js';
import { MAX_CRITERIA, cleanCriterionName, touchList } from './rating-lists.js';

const router = Router();
const NOT_FOUND = 'Criterion not found';
const COLUMNS = 'id, list_id, name, position, created_at';

async function findCriterion(db, id) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM rating_criteria WHERE id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return rows[0];
}

// Create. Goes to the end.
router.post('/', async (req, res) => {
  const body = req.body ?? {};
  if (!isUuid(body.list_id)) throw new HttpError(400, 'list_id is required');
  const name = cleanCriterionName(body.name);

  const criterion = await withTransaction(async client => {
    const { rows: [list] } = await client.query('SELECT id FROM rating_lists WHERE id = $1 FOR UPDATE', [body.list_id]);
    if (!list) throw new HttpError(404, 'Rating list not found');
    const { rows: [{ count, next }] } = await client.query(
      'SELECT count(*)::int AS count, COALESCE(max(position) + 1, 0) AS next FROM rating_criteria WHERE list_id = $1',
      [body.list_id]
    );
    if (count >= MAX_CRITERIA) throw new HttpError(400, `A list can have at most ${MAX_CRITERIA} criteria`);
    const { rows } = await client.query(
      `INSERT INTO rating_criteria (list_id, name, position) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [body.list_id, name, next]
    );
    await touchList(client, body.list_id);
    return rows[0];
  });
  res.status(201).json(criterion);
});

// List.
router.get('/', async (req, res) => {
  const listId = req.query.list_id;
  if (!isUuid(listId)) throw new HttpError(400, 'list_id is required');
  const { rowCount } = await pool.query('SELECT 1 FROM rating_lists WHERE id = $1', [listId]);
  if (!rowCount) throw new HttpError(404, 'Rating list not found');
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM rating_criteria WHERE list_id = $1 ORDER BY position, created_at`,
    [listId]
  );
  res.json(rows);
});

// Read one.
router.get('/:id', async (req, res) => {
  res.json(await findCriterion(pool, requireUuid(req.params.id, NOT_FOUND)));
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
  if (body.name !== undefined) set('name', cleanCriterionName(body.name));
  if (body.position !== undefined) set('position', cleanPosition(body.position));
  if (!sets.length) throw new HttpError(400, 'Nothing to update: send name and/or position');

  const { rows } = await pool.query(`UPDATE rating_criteria SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`, values);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  await touchList(pool, rows[0].list_id);
  res.json(rows[0]);
});

// Delete.
router.delete('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const { rows } = await pool.query('DELETE FROM rating_criteria WHERE id = $1 RETURNING list_id', [id]);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  await touchList(pool, rows[0].list_id);
  res.status(204).end();
});

export default router;
