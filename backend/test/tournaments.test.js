// HTTP tests for /api/tournaments (runs against the Neon test branch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, MISSING_ID } from './helpers.js';

let call, stop;
before(async () => ({ call, stop } = await startApi()));
after(() => stop?.());

async function newTournament(name = 'Test tournament') {
  const r = await call('POST', '/tournaments', { name });
  assert.equal(r.status, 201);
  return r.data;
}

test('health check reaches the database', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('create, read, update and delete a tournament', async () => {
  const t = await newTournament('CRUD test');
  assert.equal(t.name, 'CRUD test');
  assert.deepEqual(t.participants, []);
  assert.equal(t.latest_run, null);
  assert.equal(t.run_count, 0);

  const read = await call('GET', `/tournaments/${t.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.data.id, t.id);

  const renamed = await call('PATCH', `/tournaments/${t.id}`, { name: 'Renamed' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.data.name, 'Renamed');

  assert.equal((await call('DELETE', `/tournaments/${t.id}`)).status, 204);
  assert.equal((await call('GET', `/tournaments/${t.id}`)).status, 404);
  assert.equal((await call('DELETE', `/tournaments/${t.id}`)).status, 404);
});

test('a new tournament without a name is called "Untitled tournament"', async () => {
  const r = await call('POST', '/tournaments', {});
  assert.equal(r.status, 201);
  assert.equal(r.data.name, 'Untitled tournament');
  await call('DELETE', `/tournaments/${r.data.id}`);
});

test('bad input is rejected', async () => {
  assert.equal((await call('POST', '/tournaments', { name: 'x'.repeat(81) })).status, 400);
  assert.equal((await call('GET', '/tournaments/not-a-uuid')).status, 404);
  assert.equal((await call('GET', `/tournaments/${MISSING_ID}`)).status, 404);
  const t = await newTournament();
  assert.equal((await call('PATCH', `/tournaments/${t.id}`, {})).status, 400);
  await call('DELETE', `/tournaments/${t.id}`);
});

test('list returns summaries only for the ids asked for', async () => {
  const a = await newTournament('List A');
  const b = await newTournament('List B');
  const r = await call('GET', `/tournaments?ids=${a.id},${b.id},not-a-uuid,${MISSING_ID}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.map(s => s.name).sort(), ['List A', 'List B']);
  assert.equal(r.data[0].status, 'setup');
  assert.deepEqual((await call('GET', '/tournaments')).data, []);   // no "list everything"
  await call('DELETE', `/tournaments/${a.id}`);
  await call('DELETE', `/tournaments/${b.id}`);
});

test('brackets are no longer set on the tournament', async () => {
  const t = await newTournament();
  assert.equal((await call('PATCH', `/tournaments/${t.id}`, { rounds: null })).status, 400);
  await call('DELETE', `/tournaments/${t.id}`);
});

test('import creates participants and remaps old ids inside rounds', async () => {
  const r = await call('POST', '/tournaments', {
    name: 'Imported',
    participants: [{ id: 'x1', name: 'A' }, { id: 'x2', name: 'B' }],
    rounds: [[{ a: 'x1', b: 'x2', winner: 'x2' }]],
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.participants.length, 2);
  const run = r.data.latest_run;
  assert.equal(run.number, 1);
  assert.equal(run.rounds[0][0].winner, r.data.participants[1].id);
  assert.equal(run.champion_id, r.data.participants[1].id);
  assert.ok(run.finished_at);
  await call('DELETE', `/tournaments/${r.data.id}`);
});

test('deleting a tournament deletes its participants', async () => {
  const t = await newTournament();
  const p = (await call('POST', '/participants', { tournament_id: t.id, name: 'Gone' })).data;
  await call('DELETE', `/tournaments/${t.id}`);
  assert.equal((await call('GET', `/participants/${p.id}`)).status, 404);
});

test('CORS only allows the configured frontend', async () => {
  const ok = await call('GET', '/health', undefined, { Origin: 'http://localhost:5173' });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const other = await call('GET', '/health', undefined, { Origin: 'https://evil.example' });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});
