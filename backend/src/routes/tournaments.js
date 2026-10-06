// CRUD for the tournaments table.
//   POST   /api/tournaments            create (or import, when participants are sent too)
//   GET    /api/tournaments?ids=a,b    list the given tournaments (summaries)
//   GET    /api/tournaments/:id        read one, with its participants and latest run
//   PATCH  /api/tournaments/:id        rename
//   DELETE /api/tournaments/:id        delete (participants and runs go with it)
//   GET    /api/tournaments/:id/stats  per-participant stats over all runs
// Brackets live in runs (routes/runs.js).
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError, isUuid, requireUuid, cleanName, cleanImage, cleanLink, cleanRounds } from '../validate.js';
import { championOf, computeStats } from '../bracket.js';

const router = Router();
const NOT_FOUND = 'Tournament not found';
const MAX_PARTICIPANTS = 256;

export const RUN_COLUMNS = 'id, tournament_id, number, mode, rounds, sat_out, champion_id, created_at, finished_at';

async function loadTournament(db, id) {
  const { rows } = await db.query('SELECT id, name, created_at, updated_at FROM tournaments WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  const [{ rows: participants }, { rows: runs }, { rows: [{ count }] }] = await Promise.all([
    db.query(
      `SELECT id, tournament_id, name, image, link, position, archived, created_at
         FROM participants WHERE tournament_id = $1
        ORDER BY position, created_at`,
      [id]
    ),
    db.query(`SELECT ${RUN_COLUMNS} FROM runs WHERE tournament_id = $1 ORDER BY number DESC LIMIT 1`, [id]),
    db.query('SELECT count(*)::int AS count FROM runs WHERE tournament_id = $1', [id]),
  ]);
  return { ...rows[0], participants, latest_run: runs[0] ?? null, run_count: count };
}

// Matches decided / total in a run. One-player (play-in bye) matches don't count.
function progress(rounds) {
  let done = 0, total = 0;
  rounds.forEach((round, r) => round.forEach(m => {
    if (r === 0 && (m.a === null || m.b === null)) return;
    total++;
    if (m.winner !== null) done++;
  }));
  return { done, total };
}

// Create. {name} makes an empty tournament. {name, participants, rounds}
// imports one from the old browser-only version: participants get new ids,
// and the bracket (with old ids swapped for new ones) becomes run #1.
router.post('/', async (req, res) => {
  const body = req.body ?? {};
  const name = cleanName(body.name ?? 'Untitled tournament');

  if (body.participants === undefined) {
    if (body.rounds != null) throw new HttpError(400, 'rounds can only be sent together with participants');
    const { rows } = await pool.query('INSERT INTO tournaments (name) VALUES ($1) RETURNING id', [name]);
    return res.status(201).json(await loadTournament(pool, rows[0].id));
  }

  if (!Array.isArray(body.participants)) throw new HttpError(400, 'participants must be an array');
  if (body.participants.length > MAX_PARTICIPANTS) {
    throw new HttpError(400, `A tournament can have at most ${MAX_PARTICIPANTS} participants`);
  }
  const people = body.participants.map(p => ({
    oldId: p?.id == null ? null : String(p.id),
    name: cleanName(p?.name, 'Participant name'),
    image: cleanImage(p?.image),
    link: cleanLink(p?.link),
  }));

  const id = await withTransaction(async client => {
    const { rows } = await client.query('INSERT INTO tournaments (name) VALUES ($1) RETURNING id', [name]);
    const tid = rows[0].id;
    const newIds = [];
    const idMap = new Map();
    for (const [i, p] of people.entries()) {
      const { rows: [row] } = await client.query(
        'INSERT INTO participants (tournament_id, name, image, link, position) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [tid, p.name, p.image, p.link, i]
      );
      newIds.push(row.id);
      if (p.oldId !== null) idMap.set(p.oldId, row.id);
    }

    if (body.rounds != null) {
      if (!Array.isArray(body.rounds)) throw new HttpError(400, 'rounds must be an array of rounds');
      const remap = v => {
        if (v === null || v === undefined) return null;
        const newId = idMap.get(String(v));
        if (!newId) throw new HttpError(400, 'rounds refers to an unknown participant');
        return newId;
      };
      const remapped = body.rounds.map(round => {
        if (!Array.isArray(round)) throw new HttpError(400, 'rounds must be an array of rounds');
        return round.map(m => ({ a: remap(m?.a), b: remap(m?.b), winner: remap(m?.winner) }));
      });
      const rounds = cleanRounds(remapped, newIds);
      const champion = championOf(rounds);
      await client.query(
        `INSERT INTO runs (tournament_id, number, mode, rounds, champion_id, finished_at)
         VALUES ($1, 1, 'all', $2, $3, CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END)`,
        [tid, JSON.stringify(rounds), champion]
      );
    }
    return tid;
  });

  res.status(201).json(await loadTournament(pool, id));
});

// List. Only the ids asked for. There's deliberately no "list everything",
// because knowing a tournament's id is what gives you access to it.
router.get('/', async (req, res) => {
  const ids = String(req.query.ids ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(isUuid)
    .slice(0, 100);
  if (!ids.length) return res.json([]);

  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.created_at, t.updated_at,
            (SELECT count(*)::int FROM participants p WHERE p.tournament_id = t.id AND NOT p.archived) AS participant_count,
            COALESCE((SELECT json_agg(x) FROM (
                SELECT id, name, image FROM participants p
                 WHERE p.tournament_id = t.id AND NOT p.archived ORDER BY position, created_at LIMIT 4
              ) x), '[]') AS preview,
            (SELECT count(*)::int FROM runs r WHERE r.tournament_id = t.id) AS run_count,
            lr.number AS run_number, lr.rounds AS run_rounds, lr.finished_at AS run_finished_at,
            (SELECT row_to_json(c) FROM (
                SELECT id, name, image FROM participants p WHERE p.id = lr.champion_id
              ) c) AS champion
       FROM tournaments t
       LEFT JOIN LATERAL (
         SELECT number, rounds, finished_at, champion_id FROM runs r
          WHERE r.tournament_id = t.id ORDER BY number DESC LIMIT 1
       ) lr ON true
      WHERE t.id = ANY($1::uuid[])
      ORDER BY t.created_at DESC`,
    [ids]
  );

  res.json(rows.map(({ run_rounds, run_finished_at, ...t }) => {
    const { done, total } = run_rounds ? progress(run_rounds) : { done: 0, total: 0 };
    const status = !run_rounds ? 'setup' : run_finished_at ? 'finished' : 'in_progress';
    return { ...t, status, matches_done: done, matches_total: total };
  }));
});

// Read one.
router.get('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  res.json(await loadTournament(pool, id));
});

// Stats over all runs (finishes count once a run is finished).
router.get('/:id/stats', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const { rowCount } = await pool.query('SELECT 1 FROM tournaments WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, NOT_FOUND);
  const [{ rows: participants }, { rows: runs }] = await Promise.all([
    pool.query('SELECT id, name, image, archived FROM participants WHERE tournament_id = $1 ORDER BY position', [id]),
    pool.query('SELECT rounds, sat_out, finished_at FROM runs WHERE tournament_id = $1 ORDER BY number', [id]),
  ]);
  res.json({
    runs_total: runs.length,
    runs_finished: runs.filter(r => r.finished_at).length,
    participants: computeStats(participants, runs),
  });
});

// Update (rename). Brackets are changed through /api/runs.
router.patch('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const body = req.body ?? {};
  if (body.rounds !== undefined) throw new HttpError(400, 'Brackets are now runs: use /api/runs');
  if (body.name === undefined) throw new HttpError(400, 'Nothing to update: send name');
  const { rowCount } = await pool.query(
    'UPDATE tournaments SET name = $2, updated_at = now() WHERE id = $1',
    [id, cleanName(body.name)]
  );
  if (!rowCount) throw new HttpError(404, NOT_FOUND);
  res.json(await loadTournament(pool, id));
});

// Delete.
router.delete('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const { rowCount } = await pool.query('DELETE FROM tournaments WHERE id = $1', [id]);
  if (!rowCount) throw new HttpError(404, NOT_FOUND);
  res.status(204).end();
});

export default router;
