// HTTP tests for /api/participants (runs against the Neon test branch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, MISSING_ID } from './helpers.js';

let call, stop, tid;
before(async () => {
  ({ call, stop } = await startApi());
  tid = (await call('POST', '/tournaments', { name: 'Participants test' })).data.id;
});
after(async () => {
  if (!stop) return;   // startApi failed; nothing to clean up
  if (tid) await call('DELETE', `/tournaments/${tid}`);
  await stop();
});

const add = (name, extra = {}) => call('POST', '/participants', { tournament_id: tid, name, ...extra });

test('create, list, read, update and delete participants', async () => {
  const created = [];
  for (const name of ['One', 'Two', 'Three']) {
    const r = await add(name, { link: 'https://youtu.be/dQw4w9WgXcQ' });
    assert.equal(r.status, 201);
    assert.equal(r.data.position, created.length);   // added at the end
    created.push(r.data);
  }

  const list = await call('GET', `/participants?tournament_id=${tid}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.map(p => p.name), ['One', 'Two', 'Three']);

  const one = await call('GET', `/participants/${created[0].id}`);
  assert.equal(one.data.name, 'One');

  const updated = await call('PATCH', `/participants/${created[0].id}`, { name: 'Uno', image: 'https://example.com/a.jpg', position: 5 });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.name, 'Uno');
  assert.equal(updated.data.image, 'https://example.com/a.jpg');
  assert.equal(updated.data.position, 5);

  for (const p of created) assert.equal((await call('DELETE', `/participants/${p.id}`)).status, 204);
  assert.deepEqual((await call('GET', `/participants?tournament_id=${tid}`)).data, []);
});

test('bad input is rejected', async () => {
  assert.equal((await add('Bad', { link: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('POST', '/participants', { tournament_id: tid })).status, 400);
  assert.equal((await call('POST', '/participants', { name: 'No tournament' })).status, 400);
  assert.equal((await call('POST', '/participants', { tournament_id: MISSING_ID, name: 'X' })).status, 404);
  assert.equal((await call('GET', '/participants')).status, 400);
  assert.equal((await call('GET', `/participants/${MISSING_ID}`)).status, 404);
  const p = (await add('Fine')).data;
  assert.equal((await call('PATCH', `/participants/${p.id}`, {})).status, 400);
  assert.equal((await call('PATCH', `/participants/${p.id}`, { position: -1 })).status, 400);
  await call('DELETE', `/participants/${p.id}`);
});

test('participants are locked while a bracket is running', async () => {
  const a = (await add('A')).data;
  const b = (await add('B')).data;
  const rounds = [[{ a: a.id, b: b.id, winner: null }]];
  assert.equal((await call('PATCH', `/tournaments/${tid}`, { rounds })).status, 200);

  assert.equal((await add('Late')).status, 409);
  assert.equal((await call('PATCH', `/participants/${a.id}`, { name: 'x' })).status, 409);
  assert.equal((await call('DELETE', `/participants/${a.id}`)).status, 409);
  assert.equal((await call('POST', '/participants/import/spotify', { tournament_id: tid, links: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' })).status, 409);

  await call('PATCH', `/tournaments/${tid}`, { rounds: null });
  assert.equal((await call('PATCH', `/participants/${a.id}`, { name: 'Unlocked' })).status, 200);
  await call('DELETE', `/participants/${a.id}`);
  await call('DELETE', `/participants/${b.id}`);
});

test('imports reject bad links before contacting YouTube or Spotify', async () => {
  assert.equal((await call('POST', '/participants/import/youtube', { tournament_id: tid, url: 'https://example.com/nope' })).status, 400);
  assert.equal((await call('POST', '/participants/import/spotify', { tournament_id: tid, links: 'no links here' })).status, 400);
  assert.equal((await call('POST', '/participants/import/youtube', { tournament_id: MISSING_ID, url: 'https://youtube.com/playlist?list=PLabcdefghijkl12345' })).status, 404);
});
