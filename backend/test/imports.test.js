// Link parsing and title cleanup for the imports. No network calls (saves YouTube quota).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylistId, cleanTitle } from '../src/youtube.js';
import { parseTrackIds } from '../src/spotify.js';

test('parsePlaylistId understands YouTube playlist links', () => {
  const id = 'PLabcdefghijkl12345';
  assert.equal(parsePlaylistId(`https://www.youtube.com/playlist?list=${id}`), id);
  assert.equal(parsePlaylistId(`https://music.youtube.com/playlist?list=${id}`), id);
  assert.equal(parsePlaylistId(`https://youtube.com/watch?v=dQw4w9WgXcQ&list=${id}&index=2`), id);
  assert.equal(parsePlaylistId(`https://youtu.be/dQw4w9WgXcQ?list=${id}`), id);
  assert.equal(parsePlaylistId(`youtube.com/playlist?list=${id}`), id);
  assert.equal(parsePlaylistId(id), id);
});

test('parsePlaylistId rejects non-playlists and other sites', () => {
  assert.equal(parsePlaylistId('https://youtu.be/dQw4w9WgXcQ'), null);
  assert.equal(parsePlaylistId('https://evil.com/playlist?list=PLabcdefghijkl12345'), null);
  assert.equal(parsePlaylistId('hello'), null);
  assert.equal(parsePlaylistId(undefined), null);
});

test('cleanTitle strips "official video" style clutter', () => {
  assert.equal(cleanTitle('Rick Astley - Never Gonna Give You Up (Official Music Video)'), 'Rick Astley - Never Gonna Give You Up');
  assert.equal(cleanTitle('Queen – Bohemian Rhapsody [Official Video Remastered]'), 'Queen – Bohemian Rhapsody');
  assert.equal(cleanTitle('Daft Punk - Get Lucky (Official Audio) ft. Pharrell'), 'Daft Punk - Get Lucky ft. Pharrell');
  assert.equal(cleanTitle('Song (Live at Wembley)'), 'Song (Live at Wembley)');
  assert.equal(cleanTitle('(Official Video)'), '(Official Video)');
  assert.equal(cleanTitle('x'.repeat(100)).length, 80);
});

test('parseTrackIds finds Spotify tracks in pasted text, once each, in order', () => {
  const text = [
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc',
    'https://open.spotify.com/intl-pt/track/7ouMYWpwJ422jRcDASZB7P',
    'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp',
    'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3',
    'not a link',
  ].join('\n');
  assert.deepEqual(parseTrackIds(text), ['4uLU6hMCjMI75M1A2tKUQC', '7ouMYWpwJ422jRcDASZB7P', '3n3Ppam7vgaVa1iaRUc9Lp']);
  assert.deepEqual(parseTrackIds('nothing here'), []);
});
