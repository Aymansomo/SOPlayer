'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-mobile-lyrics-test-'));
process.env.RIFF_DATA_DIR = tmpDir;

const platform = require('../src/shared/platform');
const lyrics = require('../src/server/mobile/lyrics');

const LRC = [
  '[ar:Tame Impala]',
  '[ti:Let It Happen]',
  '[00:12.34]It\'s always around me, all this noise',
  '[00:19.00]But not nearly as loud as the voice',
  '[00:25.5]Saying let it happen',
  '[01:02.345]Let it happen',
].join('\n');

test.before(() => {
  fs.mkdirSync(platform.LYRICS_DIR, { recursive: true });
  fs.mkdirSync(platform.CUSTOM_LYRICS_DIR, { recursive: true });
  const key = lyrics.lyricsKey('Let It Happen', 'Tame Impala');
  fs.writeFileSync(path.join(platform.LYRICS_DIR, `${key}_strict_v2_lrc.lrc`), LRC, 'utf8');
});

test.after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('the key matches the desktop naming scheme', () => {
  const crypto = require('node:crypto');
  const expected = crypto.createHash('sha1')
    .update('tame impala\u0000let it happen')
    .digest('hex')
    .slice(0, 16);
  assert.strictEqual(lyrics.lyricsKey('Let It Happen', 'Tame Impala'), expected);
});

test('LRC timestamps become milliseconds', () => {
  const parsed = lyrics.parseLrc(LRC);
  assert.strictEqual(parsed.synced, true);
  assert.deepStrictEqual(
    parsed.lines.map((line) => line.start),
    [12340, 19000, 25500, 62345]
  );
  assert.strictEqual(parsed.lines[0].value, "It's always around me, all this noise");
  // Metadata tags are not lyric lines.
  assert.ok(!parsed.plain.includes('[ar:'));
});

test('downloaded lyrics are found for a song', () => {
  const found = lyrics.findLyrics({ title: 'Let It Happen', artist: 'Tame Impala' });
  assert.ok(found);
  assert.strictEqual(found.synced, true);
  assert.strictEqual(found.lines.length, 4);

  // Case and spacing do not matter, and unknown songs return null.
  assert.ok(lyrics.findLyrics({ title: 'let it happen ', artist: 'TAME IMPALA' }));
  assert.strictEqual(lyrics.findLyrics({ title: 'No Such Song', artist: 'Nobody' }), null);
});

test('unsynced lyrics are still served', () => {
  const plain = lyrics.parseLrc('First line\nSecond line');
  assert.strictEqual(plain.synced, false);
  assert.strictEqual(plain.plain, 'First line\nSecond line');
});
