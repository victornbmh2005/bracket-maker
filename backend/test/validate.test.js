import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, cleanImage, cleanLink, cleanPosition, cleanRounds, isUuid } from '../src/validate.js';

const fails = (fn, message) => assert.throws(fn, err => err.status === 400 && message.test(err.message));

test('cleanName trims and enforces length', () => {
  assert.equal(cleanName('  Alien  '), 'Alien');
  fails(() => cleanName(''), /required/);
  fails(() => cleanName('   '), /required/);
  fails(() => cleanName(42), /required/);
  fails(() => cleanName('x'.repeat(81)), /80 characters/);
});

test('cleanImage accepts http(s) and uploaded images only', () => {
  assert.equal(cleanImage(''), '');
  assert.equal(cleanImage(undefined), '');
  assert.equal(cleanImage('https://example.com/a.jpg'), 'https://example.com/a.jpg');
  assert.ok(cleanImage('data:image/jpeg;base64,AAAA').startsWith('data:image/'));
  fails(() => cleanImage('ftp://x'), /http\(s\) URL/);
  fails(() => cleanImage('javascript:alert(1)'), /http\(s\) URL/);
  fails(() => cleanImage('data:image/jpeg;base64,' + 'A'.repeat(200_001)), /too large/);
});

test('cleanLink only allows http(s)', () => {
  assert.equal(cleanLink('https://youtu.be/x'), 'https://youtu.be/x');
  assert.equal(cleanLink(null), '');
  fails(() => cleanLink('javascript:alert(1)'), /http\(s\) URL/);
  fails(() => cleanLink('data:text/html,hi'), /http\(s\) URL/);
});

test('cleanPosition needs a whole number ≥ 0', () => {
  assert.equal(cleanPosition(3), 3);
  fails(() => cleanPosition(-1), /whole number/);
  fails(() => cleanPosition(1.5), /whole number/);
  fails(() => cleanPosition('2'), /whole number/);
});

test('isUuid', () => {
  assert.ok(isUuid('00000000-0000-4000-8000-000000000000'));
  assert.ok(!isUuid('not-a-uuid'));
  assert.ok(!isUuid(undefined));
});

test('cleanRounds accepts a consistent bracket with a bye', () => {
  const ids = ['p0', 'p1', 'p2'];
  const rounds = [
    [{ a: 'p0', b: null, winner: 'p0' }, { a: 'p1', b: 'p2', winner: 'p2' }],
    [{ a: 'p0', b: 'p2', winner: null }],
  ];
  assert.deepEqual(cleanRounds(rounds, ids), rounds);
});

test('cleanRounds rejects broken brackets', () => {
  const ids = ['p0', 'p1', 'p2'];
  fails(() => cleanRounds([[{ a: 'p0', b: 'p1', winner: null }]], ids), /every participant exactly once/);
  fails(() => cleanRounds([[{ a: 'p0', b: null, winner: 'p0' }, { a: 'p1', b: 'zz', winner: null }], [{ a: 'p0', b: null, winner: null }]], ids), /not in this tournament/);
  fails(() => cleanRounds([[{ a: 'p0', b: null, winner: 'p0' }, { a: 'p1', b: 'p2', winner: 'p1' }], [{ a: 'p0', b: 'p2', winner: null }]], ids), /inconsistent/);
  fails(() => cleanRounds([[{ a: 'p0', b: null, winner: 'p1' }, { a: 'p1', b: 'p2', winner: null }], [{ a: 'p1', b: null, winner: null }]], ids), /one of the two/);
  fails(() => cleanRounds([[{}, {}, {}]], ids), /power-of-two/);
  fails(() => cleanRounds([[{ a: 'p0', b: null, winner: null }]], ['p0']), /at least 2/);
});
