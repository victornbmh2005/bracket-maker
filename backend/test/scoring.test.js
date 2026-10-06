// Average math for ratings. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/scoring.js';

const criteria = [{ id: 'voc' }, { id: 'lyr' }, { id: 'prod' }];
const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('item, criterion and list averages', () => {
  const ratings = [
    { item_id: 'a', criterion_id: 'voc', score: 8 },
    { item_id: 'a', criterion_id: 'lyr', score: 9 },
    { item_id: 'a', criterion_id: 'prod', score: 10 },   // a = 9.0, complete
    { item_id: 'b', criterion_id: 'voc', score: 5 },     // b = 5.0, 1 of 3 rated
    // c unrated
  ];
  const s = summarize(criteria, items, ratings);
  const byId = Object.fromEntries(s.items.map(i => [i.id, i]));
  assert.equal(byId.a.score, 9);
  assert.equal(byId.a.complete, true);
  assert.equal(byId.b.score, 5);
  assert.equal(byId.b.rated, 1);
  assert.equal(byId.b.complete, false);
  assert.equal(byId.c.score, null);
  assert.deepEqual(byId.a.scores, { voc: 8, lyr: 9, prod: 10 });

  const crit = Object.fromEntries(s.criteria.map(c => [c.id, c]));
  assert.equal(crit.voc.average, 6.5);
  assert.equal(crit.lyr.average, 9);
  assert.equal(crit.prod.rated, 1);

  assert.deepEqual(s.summary, { score: 7, item_count: 3, criteria_count: 3, rated_items: 2, complete_items: 1 });
});

test('averages round to 1 decimal, the list score uses unrounded item scores', () => {
  const ratings = [
    { item_id: 'a', criterion_id: 'voc', score: 7 },
    { item_id: 'a', criterion_id: 'lyr', score: 8 },
    { item_id: 'a', criterion_id: 'prod', score: 8 },   // 7.666… → 7.7
    { item_id: 'b', criterion_id: 'voc', score: 6 },
    { item_id: 'b', criterion_id: 'lyr', score: 6 },
    { item_id: 'b', criterion_id: 'prod', score: 7 },   // 6.333… → 6.3
  ];
  const s = summarize(criteria, items, ratings);
  assert.equal(s.items[0].score, 7.7);
  assert.equal(s.items[1].score, 6.3);
  assert.equal(s.summary.score, 7);   // (7.666… + 6.333…) / 2 = 7.0, not (7.7 + 6.3) / 2 rounded differently
});

test('empty lists and lists without criteria', () => {
  assert.deepEqual(summarize([], [], []).summary, { score: null, item_count: 0, criteria_count: 0, rated_items: 0, complete_items: 0 });
  const s = summarize([], [{ id: 'a' }], []);
  assert.equal(s.items[0].complete, false);   // nothing to rate on isn't "complete"
});

test('scores for unknown items or criteria are ignored', () => {
  const s = summarize(criteria, items, [
    { item_id: 'zzz', criterion_id: 'voc', score: 10 },
    { item_id: 'a', criterion_id: 'deleted', score: 1 },
    { item_id: 'a', criterion_id: 'voc', score: 6 },
  ]);
  assert.equal(s.items[0].score, 6);
  assert.equal(s.summary.score, 6);
});
