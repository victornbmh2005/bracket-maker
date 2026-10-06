// HTTP tests for /api/runs and /api/tournaments/:id/stats (Neon test branch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, MISSING_ID } from './helpers.js';

let call, stop, tid;
before(async () => {
  ({ call, stop } = await startApi());
  tid = (await call('POST', '/tournaments', { name: 'Runs test' })).data.id;
  for (let i = 1; i <= 5; i++) await call('POST', '/participants', { tournament_id: tid, name: `P${i}` });
});
after(async () => {
  if (!stop) return;
  if (tid) await call('DELETE', `/tournaments/${tid}`);
  await stop();
});

// Picks the "a" side of every undecided match until there's a champion.
function playOut(rounds) {
  const r = structuredClone(rounds);
  for (let k = 0; k < r.length; k++) r[k].forEach((m, i) => {
    if (m.winner === null) m.winner = m.a;
    if (k + 1 < r.length) r[k + 1][i >> 1][i % 2 ? 'b' : 'a'] = m.winner;
  });
  return r;
}

test('size options follow the participant count', async () => {
  const r = await call('GET', `/runs/options?tournament_id=${tid}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map(o => `${o.size}:${o.mode}`), ['8:all', '4:cut', '2:cut']);
});

test('start, play, finish, list, read and delete runs', async () => {
  const created = await call('POST', '/runs', { tournament_id: tid, size: 4 });
  assert.equal(created.status, 201);
  const run = created.data;
  assert.equal(run.number, 1);
  assert.equal(run.mode, 'cut');
  assert.equal(run.sat_out.length, 1);
  assert.equal(run.finished_at, null);

  // only one run in progress at a time
  assert.equal((await call('POST', '/runs', { tournament_id: tid, size: 4 })).status, 409);

  const played = await call('PATCH', `/runs/${run.id}`, { rounds: playOut(run.rounds) });
  assert.equal(played.status, 200);
  assert.ok(played.data.champion_id);
  assert.ok(played.data.finished_at);

  const run2 = (await call('POST', '/runs', { tournament_id: tid, size: 8 })).data;
  assert.equal(run2.number, 2);
  assert.equal(run2.mode, 'all');
  assert.deepEqual(run2.sat_out, []);

  // older runs are read-only
  assert.equal((await call('PATCH', `/runs/${run.id}`, { rounds: run.rounds })).status, 409);

  const list = await call('GET', `/runs?tournament_id=${tid}`);
  assert.deepEqual(list.data.map(r => r.number), [2, 1]);
  assert.equal(list.data[1].size, 4);
  assert.equal(list.data[1].sat_out_count, 1);
  assert.ok(list.data[1].champion.name);
  assert.equal(list.data[0].rounds, undefined);   // list stays small

  assert.equal((await call('GET', `/runs/${run2.id}`)).data.number, 2);
  const t = (await call('GET', `/tournaments/${tid}`)).data;
  assert.equal(t.latest_run.id, run2.id);
  assert.equal(t.run_count, 2);

  for (const r of [run2, run]) assert.equal((await call('DELETE', `/runs/${r.id}`)).status, 204);
  assert.equal((await call('GET', `/runs/${run.id}`)).status, 404);
});

test('picks are validated: same first-round draw, consistent bracket', async () => {
  const run = (await call('POST', '/runs', { tournament_id: tid, size: 4 })).data;
  const swapped = structuredClone(run.rounds);
  [swapped[0][0].a, swapped[0][1].a] = [swapped[0][1].a, swapped[0][0].a];
  assert.equal((await call('PATCH', `/runs/${run.id}`, { rounds: swapped })).status, 400);

  const inconsistent = structuredClone(run.rounds);
  inconsistent[0][0].winner = inconsistent[0][0].a;
  inconsistent[1][0].a = inconsistent[0][0].b;   // the loser advanced
  assert.equal((await call('PATCH', `/runs/${run.id}`, { rounds: inconsistent })).status, 400);

  // undoing the final reopens the run
  const done = (await call('PATCH', `/runs/${run.id}`, { rounds: playOut(run.rounds) })).data;
  const reopened = structuredClone(done.rounds);
  reopened[1][0].winner = null;
  const r = (await call('PATCH', `/runs/${run.id}`, { rounds: reopened })).data;
  assert.equal(r.finished_at, null);
  assert.equal(r.champion_id, null);
  await call('DELETE', `/runs/${run.id}`);
});

test('bad input is rejected', async () => {
  assert.equal((await call('POST', '/runs', { tournament_id: tid, size: 6 })).status, 400);
  assert.equal((await call('POST', '/runs', { tournament_id: tid })).status, 400);
  assert.equal((await call('POST', '/runs', { tournament_id: MISSING_ID, size: 4 })).status, 404);
  assert.equal((await call('GET', '/runs')).status, 400);
  assert.equal((await call('GET', `/runs/${MISSING_ID}`)).status, 404);
  assert.equal((await call('DELETE', `/runs/${MISSING_ID}`)).status, 404);
});

test('stats add up over finished runs', async () => {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const run = (await call('POST', '/runs', { tournament_id: tid, size: 4 })).data;
    await call('PATCH', `/runs/${run.id}`, { rounds: playOut(run.rounds) });
    runs.push(run);
  }
  const r = await call('GET', `/tournaments/${tid}/stats`);
  assert.equal(r.status, 200);
  assert.equal(r.data.runs_finished, 3);
  const s = r.data.participants;
  assert.equal(s.length, 5);
  assert.equal(s.reduce((n, p) => n + p.titles, 0), 3);
  assert.equal(s.reduce((n, p) => n + p.wins, 0), 9);   // 3 matches per 4-player run
  assert.equal(s.reduce((n, p) => n + p.sat_out, 0), 3);
  // with 5 people and 1 sitting out per run, nobody sits out twice before everyone sat out once
  assert.ok(s.every(p => p.sat_out <= 1));
  assert.equal(s[0].best_finish, 'Champion');

  const summary = (await call('GET', `/tournaments?ids=${tid}`)).data[0];
  assert.equal(summary.status, 'finished');
  assert.equal(summary.run_count, 3);
  assert.equal(summary.run_number, 3);
  assert.ok(summary.champion);
  for (const run of runs) await call('DELETE', `/runs/${run.id}`);
});
