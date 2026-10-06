// CRUD for the ratings table (one 1–10 score per item per criterion).
//   GET    /api/ratings?list_id=…                     every score in a list
//   PUT    /api/ratings                               set a score {item_id, criterion_id, score} (create or update)
//   DELETE /api/ratings?item_id=…&criterion_id=…      clear a score
// PUT and DELETE answer with the updated averages, so the page can refresh
// its numbers without reloading everything.
import { Router } from 'express';
import { pool } from '../db.js';
import { HttpError, isUuid } from '../validate.js';
import { loadList, touchList } from './rating-lists.js';

const router = Router();

function cleanScore(v) {
  if (!Number.isInteger(v) || v < 1 || v > 10) throw new HttpError(400, 'score must be a whole number from 1 to 10');
  return v;
}

// The item and criterion must exist and belong to the same list.
async function listOf(itemId, criterionId) {
  if (!isUuid(itemId)) throw new HttpError(400, 'item_id is required');
  if (!isUuid(criterionId)) throw new HttpError(400, 'criterion_id is required');
  const { rows: [r] } = await pool.query(
    `SELECT i.list_id AS item_list, c.list_id AS criterion_list
       FROM (SELECT list_id FROM rating_items WHERE id = $1) i
       FULL JOIN (SELECT list_id FROM rating_criteria WHERE id = $2) c ON true`,
    [itemId, criterionId]
  );
  if (!r?.item_list) throw new HttpError(404, 'Item not found');
  if (!r.criterion_list) throw new HttpError(404, 'Criterion not found');
  if (r.item_list !== r.criterion_list) throw new HttpError(400, 'The item and the criterion belong to different lists');
  return r.item_list;
}

// The numbers that change when one score changes.
async function changes(listId, itemId, criterionId) {
  const list = await loadList(pool, listId);
  const item = list.items.find(i => i.id === itemId);
  const criterion = list.criteria.find(c => c.id === criterionId);
  return {
    item: { id: item.id, scores: item.scores, score: item.score, rated: item.rated, complete: item.complete },
    criterion: { id: criterion.id, average: criterion.average, rated: criterion.rated },
    summary: list.summary,
  };
}

// List every score in a list.
router.get('/', async (req, res) => {
  const listId = req.query.list_id;
  if (!isUuid(listId)) throw new HttpError(400, 'list_id is required');
  const { rowCount } = await pool.query('SELECT 1 FROM rating_lists WHERE id = $1', [listId]);
  if (!rowCount) throw new HttpError(404, 'Rating list not found');
  const { rows } = await pool.query(
    `SELECT r.item_id, r.criterion_id, r.score, r.updated_at
       FROM ratings r JOIN rating_items i ON i.id = r.item_id
      WHERE i.list_id = $1`,
    [listId]
  );
  res.json(rows);
});

// Set a score (creates it, or replaces the old one).
router.put('/', async (req, res) => {
  const body = req.body ?? {};
  const score = cleanScore(body.score);
  const listId = await listOf(body.item_id, body.criterion_id);
  const { rows: [rating] } = await pool.query(
    `INSERT INTO ratings (item_id, criterion_id, score) VALUES ($1, $2, $3)
     ON CONFLICT (item_id, criterion_id) DO UPDATE SET score = EXCLUDED.score, updated_at = now()
     RETURNING item_id, criterion_id, score, updated_at`,
    [body.item_id, body.criterion_id, score]
  );
  await touchList(pool, listId);
  res.json({ rating, ...(await changes(listId, body.item_id, body.criterion_id)) });
});

// Clear a score.
router.delete('/', async (req, res) => {
  const { item_id: itemId, criterion_id: criterionId } = req.query;
  const listId = await listOf(itemId, criterionId);
  const { rowCount } = await pool.query('DELETE FROM ratings WHERE item_id = $1 AND criterion_id = $2', [itemId, criterionId]);
  if (!rowCount) throw new HttpError(404, 'That item has no score for that criterion');
  await touchList(pool, listId);
  res.json(await changes(listId, itemId, criterionId));
});

export default router;
