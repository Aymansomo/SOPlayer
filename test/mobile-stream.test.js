'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');

/**
 * ffmpeg lives next to Riff's data dir, which this test replaces, so resolve the
 * real binary first (in a child process without RIFF_DATA_DIR) and hand it to
 * the resolver through its env override.
 */
function findRealFfmpeg() {
  try {
    return execFileSync(
      process.execPath,
      ['-e', "process.stdout.write(require('./src/shared/platform').resolveBinary('ffmpeg') || '')"],
      { cwd: root, encoding: 'utf8', timeout: 20000 }
    ).trim();
  } catch (_) {
    return '';
  }
}

const realFfmpeg = findRealFfmpeg();
if (realFfmpeg) process.env.RIFF_FFMPEG = realFfmpeg;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-mobile-stream-test-'));
process.env.RIFF_DATA_DIR = tmpDir;

const config = require('../src/server/mobile/config');
const library = require('../src/server/mobile/library');
const transcode = require('../src/server/mobile/transcode');
const mobile = require('../src/server/mobile/index');

function writeWav(file, seconds = 0.5) {
  const sampleRate = 8000;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 4000), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return buf.length;
}

function request(port, urlPath, headers, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: method || 'GET',
      timeout: 30000,
      headers: headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

test('streaming robustness, downloads and cache maintenance', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const musicDir = path.join(tmpDir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });
  const filePath = path.join(musicDir, 'Test Artist - Test Song.wav');
  const fileSize = writeWav(filePath);

  const cfg = config.update({
    enabled: true,
    port,
    bindHost: '127.0.0.1',
    folders: [musicDir],
  });

  await mobile.start();
  t.after(async () => {
    await mobile.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  await library.startScan();
  // The scan prunes covers in the background; let that settle first.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const songs = library.allSongs();
  assert.strictEqual(songs.length, 1);
  const songId = songs[0].id;

  const salt = 'stream';
  const auth = `u=${cfg.username}&t=${md5(cfg.password + salt)}&s=${salt}&v=1.16.1&c=test`;
  const streamUrl = (extra) => `/rest/stream.view?id=${encodeURIComponent(songId)}&${auth}${extra || ''}`;
  const downloadUrl = (extra) => `/rest/download.view?id=${encodeURIComponent(songId)}&${auth}${extra || ''}`;

  // ---- Download is always the untouched original, even with a bitrate cap ----
  const download = await request(port, downloadUrl('&maxBitRate=64'));
  assert.strictEqual(download.status, 200);
  assert.match(String(download.headers['content-type']), /audio\/wav/);
  assert.strictEqual(download.body.length, fileSize);
  assert.match(String(download.headers['content-disposition']), /^attachment;/);

  // ---- format=raw never transcodes ----
  const raw = await request(port, streamUrl('&format=raw'));
  assert.strictEqual(raw.status, 200);
  assert.match(String(raw.headers['content-type']), /audio\/wav/);
  assert.strictEqual(raw.body.length, fileSize);

  // ---- A malformed / multi-range header is ignored: whole file, 200 ----
  const multi = await request(port, streamUrl(), { Range: 'bytes=0-1,5-6' });
  assert.strictEqual(multi.status, 200);
  assert.strictEqual(multi.body.length, fileSize);
  assert.strictEqual(multi.headers['content-range'], undefined);

  // ---- An unsatisfiable range is 416 with the total length ----
  const beyond = await request(port, streamUrl(), { Range: 'bytes=999999-' });
  assert.strictEqual(beyond.status, 416);
  assert.strictEqual(beyond.headers['content-range'], `bytes */${fileSize}`);

  // ---- A valid range still works ----
  const ranged = await request(port, streamUrl(), { Range: 'bytes=0-99' });
  assert.strictEqual(ranged.status, 206);
  assert.strictEqual(ranged.body.length, 100);

  // ---- Transcoding to MP3 ----
  if (!transcode.available()) {
    t.diagnostic('ffmpeg not found: skipping transcoding checks');
    return;
  }

  const capped = await request(port, streamUrl('&maxBitRate=64'));
  assert.strictEqual(capped.status, 200);
  assert.match(String(capped.headers['content-type']), /audio\/mpeg/);
  assert.strictEqual(capped.headers['accept-ranges'], 'none');
  assert.ok(capped.body.length > 0, 'transcoded body should not be empty');
  assert.ok(
    capped.body.slice(0, 3).toString('latin1') === 'ID3' || (capped.body[0] === 0xff && (capped.body[1] & 0xe0) === 0xe0),
    'body should look like an MP3 stream'
  );

  const head = await request(port, streamUrl('&maxBitRate=64'), {}, 'HEAD');
  assert.strictEqual(head.status, 200);
  assert.match(String(head.headers['content-type']), /audio\/mpeg/);
  assert.strictEqual(head.body.length, 0);

  // ---- An explicit container request transcodes too ----
  const flacWanted = await request(port, streamUrl('&format=flac'));
  assert.strictEqual(flacWanted.status, 200);
  assert.match(String(flacWanted.headers['content-type']), /audio\/mpeg/);

  // ---- Cache maintenance removes orphaned covers only ----
  const coversDir = library.COVERS_DIR;
  fs.mkdirSync(coversDir, { recursive: true });
  const orphan = path.join(coversDir, 'deadbeefdeadbeefdeadbeefdeadbeef.jpg');
  const onlineThumb = path.join(coversDir, 'online-abc123.img');
  const freshTemp = path.join(coversDir, 'online-abc123.img.tmp');
  fs.writeFileSync(orphan, 'orphan');
  fs.writeFileSync(onlineThumb, 'thumb');
  fs.writeFileSync(freshTemp, 'tmp');

  const removed = await library.pruneCoverFiles();
  assert.strictEqual(removed, 1);
  assert.strictEqual(fs.existsSync(orphan), false);
  assert.strictEqual(fs.existsSync(onlineThumb), true, 'online thumbnails are owned by online.js');
  assert.strictEqual(fs.existsSync(freshTemp), true, 'fresh temp files are not pruned');
});
