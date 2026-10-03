// Input checks shared by the routes. Anything invalid throws an HttpError,
// which the error handler in server.js turns into a JSON response.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = message => new HttpError(400, message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

// Ids in the URL: anything that isn't a UUID can't exist, so it's a 404.
export function requireUuid(v, notFoundMessage) {
  if (!isUuid(v)) throw new HttpError(404, notFoundMessage);
  return v;
}

export function cleanName(v, field = 'name') {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${field} is required`);
  const s = v.trim();
  if (s.length > 80) throw bad(`${field} must be 80 characters or less`);
  return s;
}

const MAX_IMAGE_DATA = 200_000;   // ~150 KB image once decoded
const MAX_URL = 2000;

export function cleanImage(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw bad('image must be a string');
  const s = v.trim();
  if (/^data:image\/[a-z+.-]+;base64,/i.test(s)) {
    if (s.length > MAX_IMAGE_DATA) throw bad('Uploaded image is too large');
    return s;
  }
  if (/^https?:\/\//i.test(s) && s.length <= MAX_URL) return s;
  throw bad('image must be an http(s) URL or an uploaded image');
}

export function cleanLink(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string') throw bad('link must be a string');
  const s = v.trim();
  if (/^https?:\/\//i.test(s) && s.length <= MAX_URL) return s;
  throw bad('link must be an http(s) URL');
}

export function cleanPosition(v) {
  if (!Number.isInteger(v) || v < 0 || v > 100_000) throw bad('position must be a whole number ≥ 0');
  return v;
}

// rounds = [[{a, b, winner}, ...], ...]: round 1 first, the final last.
// Checks the shape, that every id belongs to this tournament, that round 1
// holds every participant exactly once, and that each later match is fed by
// the winners of the two matches before it.
export function cleanRounds(value, participantIds) {
  const ids = new Set(participantIds);
  if (ids.size < 2) throw bad('A bracket needs at least 2 participants');
  if (!Array.isArray(value) || !Array.isArray(value[0])) throw bad('rounds must be an array of rounds');

  const firstSize = value[0].length;
  if (firstSize === 0 || (firstSize & (firstSize - 1)) !== 0) {
    throw bad('The first round must have a power-of-two number of matches');
  }
  if (value.length !== Math.log2(firstSize) + 1) throw bad('Wrong number of rounds for this bracket size');

  const slot = v => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' || !ids.has(v)) throw bad('rounds refers to a participant that is not in this tournament');
    return v;
  };

  const rounds = value.map((round, r) => {
    const size = firstSize / 2 ** r;
    if (!Array.isArray(round) || round.length !== size) throw bad(`Round ${r + 1} must have ${size} matches`);
    return round.map(m => {
      const match = { a: slot(m?.a), b: slot(m?.b), winner: slot(m?.winner) };
      if (match.winner !== null && match.winner !== match.a && match.winner !== match.b) {
        throw bad('A winner must be one of the two participants in its match');
      }
      return match;
    });
  });

  const seen = rounds[0].flatMap(m => [m.a, m.b]).filter(v => v !== null);
  if (seen.length !== ids.size || new Set(seen).size !== seen.length) {
    throw bad('The first round must contain every participant exactly once');
  }

  for (let r = 1; r < rounds.length; r++) {
    rounds[r].forEach((m, i) => {
      if (m.a !== rounds[r - 1][2 * i].winner || m.b !== rounds[r - 1][2 * i + 1].winner) {
        throw bad('Bracket is inconsistent: a match does not hold the winners of the matches before it');
      }
    });
  }
  return rounds;
}
