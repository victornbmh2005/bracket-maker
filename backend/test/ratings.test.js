// HTTP tests for the ratings mode: rating-lists, rating-criteria,
// rating-items and ratings (Neon test branch).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApi, MISSING_ID } from './helpers.js';

let call, stop;
const created = [];   // list ids to clean up
before(async () => ({ call, stop } = await startApi()));
after(async () => {
  if (!stop) return;
  for (const id of created) await call('DELETE', `/rating-lists/${id}`);
  await stop();
});

async function newList(body = { name: 'Test list', criteria: ['Vocals', 'Lyrics'] }) {
  const r = await call('POST', '/rating-lists', body);
  assert.equal(r.status, 201);
  created.push(r.data.id);
  return r.data;
}
const score = (item, criterion, value) => call('PUT', '/ratings', { item_id: item.id, criterion_id: criterion.id, score: value });

test('rating lists: create with criteria, read, rename, list, delete', async () => {
  const list = await newList({ name: 'Songs', criteria: ['Instruments', 'Vocals', 'Lyrics'] });
  assert.deepEqual(list.criteria.map(c => c.name), ['Instruments', 'Vocals', 'Lyrics']);
  assert.deepEqual(list.items, []);
  assert.equal(list.summary.score, null);

  assert.equal((await call('GET', `/rating-lists/${list.id}`)).data.name, 'Songs');
  assert.equal((await call('PATCH', `/rating-lists/${list.id}`, { name: 'Best songs' })).data.name, 'Best songs');

  const summaries = (await call('GET', `/rating-lists?ids=${list.id},${MISSING_ID},nope`)).data;
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].criteria_count, 3);
  assert.deepEqual((await call('GET', '/rating-lists')).data, []);   // no "list everything"

  assert.equal((await call('DELETE', `/rating-lists/${list.id}`)).status, 204);
  assert.equal((await call('GET', `/rating-lists/${list.id}`)).status, 404);
});

test('rating lists: bad input', async () => {
  assert.equal((await call('POST', '/rating-lists', { name: 'x'.repeat(81) })).status, 400);
  assert.equal((await call('POST', '/rating-lists', { name: 'A', criteria: 'Vocals' })).status, 400);
  assert.equal((await call('POST', '/rating-lists', { name: 'A', criteria: ['x'.repeat(41)] })).status, 400);
  assert.equal((await call('POST', '/rating-lists', { name: 'A', criteria: Array(21).fill('C') })).status, 400);
  assert.equal((await call('GET', '/rating-lists/not-a-uuid')).status, 404);
  const list = await newList();
  assert.equal((await call('PATCH', `/rating-lists/${list.id}`, {})).status, 400);
});

test('criteria: create, list, read, rename, move, delete', async () => {
  const list = await newList({ name: 'Criteria', criteria: [] });
  const a = await call('POST', '/rating-criteria', { list_id: list.id, name: 'Story' });
  assert.equal(a.status, 201);
  assert.equal(a.data.position, 0);
  const b = (await call('POST', '/rating-criteria', { list_id: list.id, name: 'Acting' })).data;
  assert.equal(b.position, 1);

  assert.deepEqual((await call('GET', `/rating-criteria?list_id=${list.id}`)).data.map(c => c.name), ['Story', 'Acting']);
  assert.equal((await call('GET', `/rating-criteria/${b.id}`)).data.name, 'Acting');
  const moved = await call('PATCH', `/rating-criteria/${b.id}`, { name: 'Performances', position: -1 });
  assert.equal(moved.status, 400);
  assert.equal((await call('PATCH', `/rating-criteria/${b.id}`, { name: 'Performances', position: 0 })).data.name, 'Performances');

  assert.equal((await call('DELETE', `/rating-criteria/${a.data.id}`)).status, 204);
  assert.equal((await call('GET', `/rating-criteria/${a.data.id}`)).status, 404);
  assert.equal((await call('POST', '/rating-criteria', { list_id: MISSING_ID, name: 'X' })).status, 404);
  assert.equal((await call('POST', '/rating-criteria', { list_id: list.id })).status, 400);
  assert.equal((await call('GET', '/rating-criteria')).status, 400);
});

test('items: create, list, read, update, delete, bad input', async () => {
  const list = await newList();
  const r = await call('POST', '/rating-items', { list_id: list.id, name: 'Song A', link: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(r.status, 201);
  assert.equal(r.data.score, null);
  const b = (await call('POST', '/rating-items', { list_id: list.id, name: 'Song B' })).data;
  assert.equal(b.position, 1);

  assert.deepEqual((await call('GET', `/rating-items?list_id=${list.id}`)).data.map(i => i.name), ['Song A', 'Song B']);
  const updated = await call('PATCH', `/rating-items/${b.id}`, { name: 'Song B (live)', image: 'https://example.com/b.jpg' });
  assert.equal(updated.data.name, 'Song B (live)');

  assert.equal((await call('POST', '/rating-items', { list_id: list.id, name: 'Bad', link: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call('POST', '/rating-items', { list_id: MISSING_ID, name: 'X' })).status, 404);
  assert.equal((await call('PATCH', `/rating-items/${b.id}`, {})).status, 400);
  assert.equal((await call('DELETE', `/rating-items/${b.id}`)).status, 204);
  assert.equal((await call('GET', `/rating-items/${b.id}`)).status, 404);
});

test('scores: set, replace, clear, and the averages that come back', async () => {
  const list = await newList();
  const [vocals, lyrics] = list.criteria;
  const a = (await call('POST', '/rating-items', { list_id: list.id, name: 'A' })).data;
  const b = (await call('POST', '/rating-items', { list_id: list.id, name: 'B' })).data;

  let r = await score(a, vocals, 8);
  assert.equal(r.status, 200);
  assert.equal(r.data.item.score, 8);
  assert.equal(r.data.criterion.average, 8);
  assert.equal(r.data.summary.score, 8);

  r = await score(a, lyrics, 6);                    // A = 7
  assert.equal(r.data.item.score, 7);
  assert.equal(r.data.item.complete, true);
  r = await score(a, lyrics, 10);                   // replace: A = 9
  assert.equal(r.data.item.score, 9);
  r = await score(b, vocals, 4);                    // B = 4, vocals avg = 6, list = 6.5
  assert.equal(r.data.criterion.average, 6);
  assert.equal(r.data.summary.score, 6.5);
  assert.equal(r.data.summary.complete_items, 1);

  const full = (await call('GET', `/rating-lists/${list.id}`)).data;
  assert.equal(full.items.find(i => i.id === a.id).scores[lyrics.id], 10);
  assert.equal((await call('GET', `/rating-items/${a.id}`)).data.score, 9);
  assert.equal((await call('GET', `/ratings?list_id=${list.id}`)).data.length, 3);

  r = await call('DELETE', `/ratings?item_id=${b.id}&criterion_id=${vocals.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.item.score, null);
  assert.equal(r.data.summary.score, 9);
  assert.equal((await call('DELETE', `/ratings?item_id=${b.id}&criterion_id=${vocals.id}`)).status, 404);
});

test('scores: bad input', async () => {
  const list = await newList();
  const other = await newList();
  const item = (await call('POST', '/rating-items', { list_id: list.id, name: 'A' })).data;
  const c = list.criteria[0];
  for (const bad of [0, 11, 5.5, '7', null]) assert.equal((await score(item, c, bad)).status, 400);
  assert.equal((await score(item, other.criteria[0], 5)).status, 400);   // different lists
  assert.equal((await score({ id: MISSING_ID }, c, 5)).status, 404);
  assert.equal((await score(item, { id: MISSING_ID }, 5)).status, 404);
  assert.equal((await call('PUT', '/ratings', { criterion_id: c.id, score: 5 })).status, 400);
  assert.equal((await call('GET', '/ratings')).status, 400);
});

test('deleting a criterion or item removes its scores; deleting a list removes everything', async () => {
  const list = await newList();
  const [vocals, lyrics] = list.criteria;
  const a = (await call('POST', '/rating-items', { list_id: list.id, name: 'A' })).data;
  await score(a, vocals, 10);
  await score(a, lyrics, 2);                         // A = 6
  await call('DELETE', `/rating-criteria/${lyrics.id}`);
  assert.equal((await call('GET', `/rating-items/${a.id}`)).data.score, 10);

  await call('DELETE', `/rating-items/${a.id}`);
  assert.deepEqual((await call('GET', `/ratings?list_id=${list.id}`)).data, []);

  const b = (await call('POST', '/rating-items', { list_id: list.id, name: 'B' })).data;
  await call('DELETE', `/rating-lists/${list.id}`);
  assert.equal((await call('GET', `/rating-items/${b.id}`)).status, 404);
  assert.equal((await call('GET', `/rating-criteria/${vocals.id}`)).status, 404);
});

test('item imports reject bad links before contacting YouTube or Spotify', async () => {
  const list = await newList();
  assert.equal((await call('POST', '/rating-items/import/youtube', { list_id: list.id, url: 'https://example.com' })).status, 400);
  assert.equal((await call('POST', '/rating-items/import/spotify', { list_id: list.id, links: 'nothing' })).status, 400);
  assert.equal((await call('POST', '/rating-items/import/spotify', { list_id: MISSING_ID, links: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' })).status, 404);
});
