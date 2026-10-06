// Bracket rules: sizes, cut vs everyone plays, sit-out rotation, stats. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeOptions, createRun, buildRounds, computeStats, stageName } from '../src/bracket.js';
import { cleanRounds } from '../src/validate.js';

const ids = n => Array.from({ length: n }, (_, i) => `p${i}`);
const entrantsOf = rounds => rounds[0].flatMap(m => [m.a, m.b]).filter(Boolean);

test('size options for 13: everyone (16 with play-in), or cut to 8, 4, 2', () => {
  assert.deepEqual(sizeOptions(13), [
    { size: 16, mode: 'all', sit_out: 0, play_in: true },
    { size: 8, mode: 'cut', sit_out: 5 },
    { size: 4, mode: 'cut', sit_out: 9 },
    { size: 2, mode: 'cut', sit_out: 11 },
  ]);
  assert.deepEqual(sizeOptions(8)[0], { size: 8, mode: 'all', sit_out: 0, play_in: false });
  assert.deepEqual(sizeOptions(2), [{ size: 2, mode: 'all', sit_out: 0, play_in: false }]);
});

test('cut run: exactly `size` play, the rest sit out, bracket is valid', () => {
  const people = ids(13);
  const run = createRun(people, 8, true);
  assert.equal(run.mode, 'cut');
  assert.equal(run.sat_out.length, 5);
  const entrants = entrantsOf(run.rounds);
  assert.equal(entrants.length, 8);
  assert.deepEqual([...entrants, ...run.sat_out].sort(), [...people].sort());
  assert.equal(run.rounds.length, 3);   // quarterfinals, semifinals, final
  assert.ok(run.rounds[0].every(m => m.a && m.b && m.winner === null));   // no byes
  cleanRounds(run.rounds, entrants);   // throws if inconsistent
});

test('everyone-plays run with 13: 16-bracket, 3 skip the play-in and are already through', () => {
  const run = createRun(ids(13), 16, false);
  assert.equal(run.mode, 'all');
  assert.deepEqual(run.sat_out, []);
  const oneSided = run.rounds[0].filter(m => m.b === null);
  assert.equal(oneSided.length, 3);
  assert.ok(oneSided.every(m => m.winner === m.a));
  assert.equal(run.rounds[0].filter(m => m.a && m.b).length, 5);   // 5 play-in matches
  cleanRounds(run.rounds, entrantsOf(run.rounds));
});

test('without shuffle, entrants keep their seeding order', () => {
  assert.deepEqual(entrantsOf(createRun(ids(8), 8, false).rounds), ids(8));
});

test('invalid sizes are rejected', () => {
  assert.throws(() => createRun(ids(13), 12, true), err => err.status === 400 && /16, 8, 4, 2/.test(err.message));
  assert.throws(() => createRun(ids(13), 32, true), err => err.status === 400);
  assert.throws(() => createRun(ids(1), 2, true), err => err.status === 400);
});

test('people who sat out more often get to play first', () => {
  const people = ids(5);
  const satOutBefore = new Map([['p0', 2], ['p1', 2], ['p2', 1], ['p3', 1]]);   // p4 never sat out
  for (let i = 0; i < 20; i++) {
    const run = createRun(people, 4, true, satOutBefore);
    assert.deepEqual(run.sat_out, ['p4']);
  }
});

test('stage names count from the final', () => {
  assert.equal(stageName(-1), 'Champion');
  assert.equal(stageName(0), 'Runner-up');
  assert.equal(stageName(1), 'Semifinals');
  assert.equal(stageName(2), 'Quarterfinals');
  assert.equal(stageName(3), 'Round of 16');
  assert.equal(stageName(3, true), 'Play-in');
});

test('stats add up across runs', () => {
  const people = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id, name: id, image: '', archived: false }));
  // Run 1 (finished): A beats B, C beats D, final A beats C. E sat out.
  const run1 = {
    sat_out: ['E'], finished_at: 'x',
    rounds: [
      [{ a: 'A', b: 'B', winner: 'A' }, { a: 'C', b: 'D', winner: 'C' }],
      [{ a: 'A', b: 'C', winner: 'A' }],
    ],
  };
  // Run 2 (finished): E beats A, B beats C, final B beats E. D sat out.
  const run2 = {
    sat_out: ['D'], finished_at: 'x',
    rounds: [
      [{ a: 'E', b: 'A', winner: 'E' }, { a: 'B', b: 'C', winner: 'B' }],
      [{ a: 'E', b: 'B', winner: 'B' }],
    ],
  };
  // Run 3 (in progress): A beat D so far. Counts W–L, but no finishes.
  const run3 = {
    sat_out: [], finished_at: null,
    rounds: [
      [{ a: 'A', b: 'D', winner: 'A' }, { a: 'B', b: 'C', winner: null }],
      [{ a: 'A', b: null, winner: null }],
    ],
  };
  const stats = Object.fromEntries(computeStats(people, [run1, run2, run3]).map(s => [s.id, s]));

  assert.equal(stats.A.titles, 1);
  assert.equal(stats.A.wins, 3);
  assert.equal(stats.A.losses, 1);
  assert.equal(stats.A.win_rate, 75);
  assert.equal(stats.A.best_finish, 'Champion');
  assert.equal(stats.A.runs_played, 3);

  assert.equal(stats.B.titles, 1);
  assert.equal(stats.B.wins, 2);
  assert.equal(stats.B.losses, 1);

  assert.equal(stats.C.best_finish, 'Runner-up');
  assert.equal(stats.E.best_finish, 'Runner-up');
  assert.equal(stats.E.sat_out, 1);
  assert.equal(stats.D.sat_out, 1);
  assert.equal(stats.D.best_finish, 'Semifinals');
  assert.equal(stats.D.win_rate, 0);

  // Champions first, then by best finish
  assert.deepEqual(computeStats(people, [run1, run2, run3]).map(s => s.id).slice(0, 2).sort(), ['A', 'B']);
});

test('byes in a play-in round are not counted as wins', () => {
  const rounds = buildRounds(['A', 'B', 'C']);   // one play-in match, one bye
  const stats = computeStats([{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }], [{ rounds, sat_out: [], finished_at: null }]);
  assert.ok(stats.every(s => s.wins === 0 && s.losses === 0));
});
