// Bracket rules: building a run, and turning finished runs into stats.
// rounds = [[{a, b, winner}, ...], ...]: round 1 first, the final last.
import { HttpError } from './validate.js';

export const isPowerOfTwo = n => Number.isInteger(n) && n >= 1 && (n & (n - 1)) === 0;
export const nextPowerOfTwo = n => { let s = 1; while (s < n) s *= 2; return s; };

function shuffled(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Put `val` into the next-round slot fed by match (r, i), clearing later
// results that depended on the old value. Same rules as the frontend.
function feedNext(rounds, r, i, val) {
  if (r + 1 >= rounds.length) return;
  const next = rounds[r + 1][i >> 1];
  const slot = i % 2 ? 'b' : 'a';
  if (next[slot] === val) return;
  next[slot] = val;
  if (next.winner !== null) {
    next.winner = null;
    feedNext(rounds, r + 1, i >> 1, null);
  }
}

// Builds empty rounds for these entrants (in seeding order). If the count
// isn't a power of two, some first-round matches have one player; they
// advance automatically, and the first round is shown as a "play-in".
export function buildRounds(entrants) {
  const size = Math.max(2, nextPowerOfTwo(entrants.length));
  const firstCount = size / 2;
  const byes = size - entrants.length;
  // Spread the one-player matches evenly so none has two empty sides
  const byeAt = new Set();
  for (let j = 0; j < byes; j++) byeAt.add(Math.floor(j * firstCount / byes));

  const first = [];
  let k = 0;
  for (let i = 0; i < firstCount; i++) {
    if (byeAt.has(i)) first.push({ a: entrants[k++], b: null, winner: null });
    else first.push({ a: entrants[k++], b: entrants[k++], winner: null });
  }
  const rounds = [first];
  for (let n = firstCount / 2; n >= 1; n /= 2) {
    rounds.push(Array.from({ length: n }, () => ({ a: null, b: null, winner: null })));
  }
  first.forEach((m, i) => {
    if (m.b === null) {
      m.winner = m.a;
      feedNext(rounds, 0, i, m.a);
    }
  });
  return rounds;
}

// The bracket sizes you can pick for n participants: every power of two
// below n (cut: the rest sit out), plus the size where everyone plays.
export function sizeOptions(n) {
  const options = [];
  for (let s = 2; s < n; s *= 2) options.push({ size: s, mode: 'cut', sit_out: n - s });
  options.push({ size: nextPowerOfTwo(n), mode: 'all', sit_out: 0, play_in: !isPowerOfTwo(n) });
  return options.reverse();
}

// Creates a run's bracket.
//   active:      participant ids in their seeding order (position)
//   size:        chosen bracket size (see sizeOptions)
//   shuffle:     random seeding instead of position order
//   satOutCount: Map id → times sat out before. Who sits out is random, but
//                people who sat out more often get to play first.
export function createRun(active, size, shuffle, satOutCount = new Map()) {
  const n = active.length;
  if (n < 2) throw new HttpError(400, 'A run needs at least 2 participants');
  const option = sizeOptions(n).find(o => o.size === size);
  if (!option) {
    throw new HttpError(400, `For ${n} participants the size must be one of: ${sizeOptions(n).map(o => o.size).join(', ')}`);
  }

  let players = active;
  let satOut = [];
  if (option.mode === 'cut') {
    const priority = shuffled(active).sort((x, y) => (satOutCount.get(y) ?? 0) - (satOutCount.get(x) ?? 0));
    const playing = new Set(priority.slice(0, size));
    players = active.filter(id => playing.has(id));   // keep seeding order
    satOut = active.filter(id => !playing.has(id));
  }
  const entrants = shuffle ? shuffled(players) : players;
  return { mode: option.mode, rounds: buildRounds(entrants), sat_out: satOut };
}

export const championOf = rounds => rounds[rounds.length - 1][0].winner ?? null;
export const hasPlayIn = rounds => rounds[0].some(m => m.a === null || m.b === null);

// Name of a round, counted from the final: 0 = Final, 1 = Semifinals, …
export function stageName(fromEnd, isPlayIn = false) {
  if (isPlayIn) return 'Play-in';
  if (fromEnd === -1) return 'Champion';
  if (fromEnd === 0) return 'Runner-up';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return 'Round of ' + 2 ** (fromEnd + 1);
}

// Per-participant stats over all runs.
//   participants: [{id, name, image, archived}]
//   runs:         [{rounds, sat_out, finished_at}]
// Finishes only count for finished runs. A finish is measured from the
// final (Champion > Runner-up > Semifinals…), so runs of different sizes compare fairly.
export function computeStats(participants, runs) {
  const stats = new Map(participants.map(p => [p.id, {
    id: p.id, name: p.name, image: p.image, archived: p.archived,
    runs_played: 0, sat_out: 0, wins: 0, losses: 0, titles: 0, finishes: [],
  }]));
  const get = id => stats.get(id);

  for (const run of runs) {
    const { rounds } = run;
    const last = rounds.length - 1;
    const playIn = hasPlayIn(rounds);
    for (const id of run.sat_out ?? []) if (get(id)) get(id).sat_out++;
    for (const m of rounds[0]) for (const id of [m.a, m.b]) if (id && get(id)) get(id).runs_played++;

    const eliminated = new Map();   // id → round index where they lost
    rounds.forEach((round, r) => round.forEach(m => {
      if (m.a === null || m.b === null || m.winner === null) return;   // byes aren't wins
      const loser = m.winner === m.a ? m.b : m.a;
      if (get(m.winner)) get(m.winner).wins++;
      if (get(loser)) get(loser).losses++;
      eliminated.set(loser, r);
    }));

    if (!run.finished_at) continue;
    const champion = championOf(rounds);
    if (get(champion)) {
      get(champion).titles++;
      get(champion).finishes.push({ fromEnd: -1, playIn: false });
    }
    for (const [id, r] of eliminated) {
      if (get(id)) get(id).finishes.push({ fromEnd: last - r, playIn: playIn && r === 0 });
    }
  }

  return [...stats.values()].map(({ finishes, ...s }) => {
    const best = finishes.reduce((b, f) => (b === null || f.fromEnd < b.fromEnd ? f : b), null);
    const games = s.wins + s.losses;
    return {
      ...s,
      win_rate: games ? Math.round((s.wins / games) * 1000) / 10 : null,   // percent, 1 decimal
      best_finish: best ? stageName(best.fromEnd, best.playIn) : null,
      best_finish_rank: best ? best.fromEnd : null,                       // lower is better (-1 = champion)
      avg_wins: s.runs_played ? Math.round((s.wins / s.runs_played) * 100) / 100 : 0,
    };
  }).sort((x, y) =>
    y.titles - x.titles ||
    (x.best_finish_rank ?? 99) - (y.best_finish_rank ?? 99) ||
    (y.win_rate ?? -1) - (x.win_rate ?? -1) ||
    x.name.localeCompare(y.name));
}
