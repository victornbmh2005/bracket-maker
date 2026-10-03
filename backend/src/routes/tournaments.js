// CRUD for the tournaments table.
//   POST   /api/tournaments          create (or import, when participants are sent too)
//   GET    /api/tournaments?ids=a,b  list the given tournaments (summaries)
//   GET    /api/tournaments/:id      read one, with its participants
//   PATCH  /api/tournaments/:id      update name and/or rounds
//   DELETE /api/tournaments/:id      delete (participants go with it)
import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import { HttpError, isUuid, requireUuid, cleanName, cleanImage, cleanLink, cleanRounds } from '../validate.js';

const router = Router();
const NOT_FOUND = 'Tournament not found';
const MAX_PARTICIPANTS = 256;

async function loadTournament(db, id) {
  const { rows } = await db.query(
    'SELECT id, name, rounds, created_at, updated_at FROM tournaments WHERE id = $1',
    [id]
  );
  if (!rows[0]) throw new HttpError(404, NOT_FOUND);
  const { rows: participants } = await db.query(
    `SELECT id, tournament_id, name, image, link, position, created_at
       FROM participants WHERE tournament_id = $1
      ORDER BY position, created_at`,
    [id]
  );
  return { ...rows[0], participants };
}

// Matches decided / total. Byes (round 1 with an empty side) don't count.
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
// imports one (e.g. from the old browser-only version): participants get new
// ids, and the old ids inside rounds are swapped for the new ones.
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
      await client.query('UPDATE tournaments SET rounds = $2 WHERE id = $1', [tid, JSON.stringify(rounds)]);
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
    `SELECT t.id, t.name, t.rounds, t.created_at, t.updated_at,
            (SELECT count(*)::int FROM participants p WHERE p.tournament_id = t.id) AS participant_count,
            COALESCE((SELECT json_agg(x) FROM (
                SELECT id, name, image FROM participants p
                 WHERE p.tournament_id = t.id ORDER BY position, created_at LIMIT 4
              ) x), '[]') AS preview,
            (SELECT row_to_json(c) FROM (
                SELECT id, name, image FROM participants p
                 WHERE p.id::text = t.rounds -> -1 -> 0 ->> 'winner'
              ) c) AS champion
       FROM tournaments t
      WHERE t.id = ANY($1::uuid[])
      ORDER BY t.created_at DESC`,
    [ids]
  );

  res.json(rows.map(({ rounds, ...t }) => {
    const { done, total } = rounds ? progress(rounds) : { done: 0, total: 0 };
    const status = !rounds ? 'setup' : t.champion ? 'finished' : 'in_progress';
    return { ...t, status, matches_done: done, matches_total: total };
  }));
});

// Read one.
router.get('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  res.json(await loadTournament(pool, id));
});

// Update. Send name and/or rounds (null resets the bracket).
router.patch('/:id', async (req, res) => {
  const id = requireUuid(req.params.id, NOT_FOUND);
  const body = req.body ?? {};
  if (body.name === undefined && body.rounds === undefined) {
    throw new HttpError(400, 'Nothing to update: send name and/or rounds');
  }

  await withTransaction(async client => {
    const { rows } = await client.query('SELECT id FROM tournaments WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new HttpError(404, NOT_FOUND);

    const sets = ['updated_at = now()'];
    const values = [id];
    if (body.name !== undefined) {
      values.push(cleanName(body.name));
      sets.push(`name = $${values.length}`);
    }
    if (body.rounds !== undefined) {
      let rounds = null;
      if (body.rounds !== null) {
        const { rows: ps } = await client.query('SELECT id FROM participants WHERE tournament_id = $1', [id]);
        rounds = JSON.stringify(cleanRounds(body.rounds, ps.map(p => p.id)));
      }
      values.push(rounds);
      sets.push(`rounds = $${values.length}::jsonb`);
    }
    await client.query(`UPDATE tournaments SET ${sets.join(', ')} WHERE id = $1`, values);
  });

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
