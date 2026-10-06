// CRUD for the runs table. A run is one bracket of a tournament; a
// tournament can be run many times, and stats add up across runs.
//   POST   /api/runs                    start a run (the server builds the bracket)
//   GET    /api/runs?tournament_id=…    list a tournament's runs (newest first, no brackets)
//   GET    /api/runs/:id                read one, with its bracket
//   PATCH  /api/runs/:id                save picks (only the latest run)
//   DELETE /api/runs/:id                delete (its results leave the stats)
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError, isUuid, requireUuid, cleanRounds } from '../validate.js';
import { createRun, championOf, sizeOptions } from '../bracket.js';
import { RUN_COLUMNS } from './tournaments.js';

const router = Router();
const NOT_FOUND = 'Run not found';

async function findRun(db, id, forUpdate = false) {
  const { rows } = await db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  return rows[0];
}

// Create. {tournament_id, size, shuffle}. size must be one of the options for
// the current number of participants; see GET /api/runs/options.
router.post('/', async (req, res) => {
  const body = req.body ?? {};
  if (!isUuid(body.tournament_id)) throw new HttpError(400, 'tournament_id is required');
  if (!Number.isInteger(body.size)) throw new HttpError(400, 'size is required (a whole number)');
  const shuffle = body.shuffle !== false;

  const run = await withTransaction(async client => {
    const { rows: [t] } = await client.query('SELECT id FROM tournaments WHERE id = $1 FOR UPDATE', [body.tournament_id]);
    if (!t) throw new HttpError(404, 'Tournament not found');
    const { rows: [state] } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM runs WHERE tournament_id = $1 AND finished_at IS NULL) AS running,
              COALESCE((SELECT max(number) FROM runs WHERE tournament_id = $1), 0) + 1 AS next`,
      [body.tournament_id]
    );
    if (state.running) throw new HttpError(409, 'A run is already in progress. Finish or delete it first.');

    const { rows: active } = await client.query(
      'SELECT id FROM participants WHERE tournament_id = $1 AND NOT archived ORDER BY position, created_at',
      [body.tournament_id]
    );
    const { rows: satOut } = await client.query(
      'SELECT s.pid AS id, count(*)::int AS times FROM runs r, unnest(r.sat_out) AS s(pid) WHERE r.tournament_id = $1 GROUP BY s.pid',
      [body.tournament_id]
    );
    const built = createRun(active.map(p => p.id), body.size, shuffle, new Map(satOut.map(r => [r.id, r.times])));

    const { rows } = await client.query(
      `INSERT INTO runs (tournament_id, number, mode, rounds, sat_out)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${RUN_COLUMNS}`,
      [body.tournament_id, state.next, built.mode, JSON.stringify(built.rounds), built.sat_out]
    );
    return rows[0];
  });

  res.status(201).json(run);
});

// The bracket sizes available right now: [{size, mode, sit_out, play_in}]
router.get('/options', async (req, res) => {
  const tournamentId = req.query.tournament_id;
  if (!isUuid(tournamentId)) throw new HttpError(400, 'tournament_id is required');
  const { rows: [t] } = await pool.query(
    `SELECT (SELECT count(*)::int FROM participants p WHERE p.tournament_id = t.id AND NOT p.archived) AS count
       FROM tournaments t WHERE t.id = $1`,
    [tournamentId]
  );
  if (!t) throw new HttpError(404, 'Tournament not found');
  res.json(t.count >= 2 ? sizeOptions(t.count) : []);
});

// List (without brackets, to keep it small).
router.get('/', async (req, res) => {
  const tournamentId = req.query.tournament_id;
  if (!isUuid(tournamentId)) throw new HttpError(400, 'tournament_id is required');
  const { rowCount } = await pool.query('SELECT 1 FROM tournaments WHERE id = $1', [tournamentId]);
  if (!rowCount) throw new HttpError(404, 'Tournament not found');
  const { rows } = await pool.query(
    `SELECT r.id, r.number, r.mode, r.created_at, r.finished_at,
            jsonb_array_length(r.rounds -> 0) * 2 AS size,
            cardinality(r.sat_out) AS sat_out_count,
            (SELECT row_to_json(c) FROM (SELECT id, name, image FROM participants p WHERE p.id = r.champion_id) c) AS champion
       FROM runs r WHERE r.tournament_id = $1
      ORDER BY r.number DESC`,
    [tournamentId]
  );
  res.json(rows);
});

// Read one.
router.get('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  res.json(await findRun(pool, id));
});

// Update: save picks. Who plays in round 1 can't change; only winners can.
// Only the latest run can be changed, so there's never more than one run in progress.
router.patch('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const body = req.body ?? {};
  if (body.rounds === undefined) throw new HttpError(400, 'Nothing to update: send rounds');

  const run = await withTransaction(async client => {
    const run = await findRun(client, id, true);
    const { rows: [{ latest }] } = await client.query(
      'SELECT max(number) AS latest FROM runs WHERE tournament_id = $1',
      [run.tournament_id]
    );
    if (run.number !== latest) throw new HttpError(409, 'Only the latest run can be changed');

    const entrants = run.rounds[0].flatMap(m => [m.a, m.b]).filter(Boolean);
    const rounds = cleanRounds(body.rounds, entrants);
    const sameDraw = rounds[0].every((m, i) => m.a === run.rounds[0][i].a && m.b === run.rounds[0][i].b);
    if (!sameDraw) throw new HttpError(400, "The first round's matchups can't be changed");

    const champion = championOf(rounds);
    const { rows } = await client.query(
      `UPDATE runs SET rounds = $2, champion_id = $3,
              finished_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE COALESCE(finished_at, now()) END
        WHERE id = $1 RETURNING ${RUN_COLUMNS}`,
      [id, JSON.stringify(rounds), champion]
    );
    await client.query('UPDATE tournaments SET updated_at = now() WHERE id = $1', [run.tournament_id]);
    return rows[0];
  });

  res.json(run);
});

// Delete.
router.delete('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const { rowCount } = await pool.query('DELETE FROM runs WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, NOT_FOUND);
  res.status(204).end();
});

export default router;
