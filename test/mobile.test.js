'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

// Keep the test isolated from the real Riff data folder.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-mobile-test-'));
process.env.RIFF_DATA_DIR = tmpDir;

const config = require('../src/server/mobile/config');
const library = require('../src/server/mobile/library');
const mobile = require('../src/server/mobile/index');

function get(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: urlPath,
      timeout: 15000,
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const md5 = (value) => crypto.createHash('md5').update(value).digest('hex');

/** Write a tiny valid PCM WAV so the scanner has something real to index. */
function writeWav(file, seconds = 0.2) {
  const sampleRate = 8000;
  const channels = 1;
  const bits = 16;
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 3000);
    buf.writeInt16LE(value, 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

test('Subsonic handshake and library over the LAN listener', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const musicDir = path.join(tmpDir, 'music');
  fs.mkdirSync(musicDir, { recursive: true });
  writeWav(path.join(musicDir, 'Test Artist - Test Song.wav'));

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

  assert.strictEqual(mobile.getStatus().running, true);

  const salt = 'test-salt';
  const token = md5(cfg.password + salt);
  const auth = `u=${encodeURIComponent(cfg.username)}&t=${token}&s=${salt}&v=1.16.1&c=test`;

  const ping = await get(port, `/rest/ping.view?${auth}&f=json`);
  assert.strictEqual(ping.status, 200);
  const pingBody = JSON.parse(ping.body)['subsonic-response'];
  assert.strictEqual(pingBody.status, 'ok');
  assert.strictEqual(pingBody.type, 'SOPlayer');
  assert.strictEqual(pingBody.version, '1.16.1');
  assert.strictEqual(pingBody.openSubsonic, true);

  const license = JSON.parse((await get(port, `/rest/getLicense.view?${auth}&f=json`)).body)['subsonic-response'];
  assert.strictEqual(license.license.valid, true);

  const folders = JSON.parse((await get(port, `/rest/getMusicFolders.view?${auth}&f=json`)).body)['subsonic-response'];
  assert.ok(Array.isArray(folders.musicFolders.musicFolder));
  assert.strictEqual(folders.musicFolders.musicFolder.length, 1);

  // Wait for the library index (start() kicks it off in the background).
  await library.startScan();
  assert.strictEqual(library.getScanStatus().scanning, false);
  assert.strictEqual(library.getScanStatus().songs, 1);

  const scan = JSON.parse((await get(port, `/rest/getScanStatus.view?${auth}&f=json`)).body)['subsonic-response'];
  assert.strictEqual(scan.scanStatus.scanning, false);
  assert.strictEqual(scan.scanStatus.count, 1);

  const artists = JSON.parse((await get(port, `/rest/getArtists.view?${auth}&f=json`)).body)['subsonic-response'];
  const artistList = artists.artists.index.flatMap((index) => index.artist);
  assert.strictEqual(artistList.length, 1);
  assert.strictEqual(artistList[0].name, 'Test Artist');

  const albums = JSON.parse(
    (await get(port, `/rest/getAlbumList2.view?type=alphabeticalByName&size=500&${auth}&f=json`)).body
  )['subsonic-response'];
  assert.strictEqual(albums.albumList2.album.length, 1);
  const albumSummary = albums.albumList2.album[0];
  assert.strictEqual(albumSummary.name, 'Test Song');
  assert.strictEqual(albumSummary.songCount, 1);

  const album = JSON.parse(
    (await get(port, `/rest/getAlbum.view?id=${albumSummary.id}&${auth}&f=json`)).body
  )['subsonic-response'].album;
  assert.strictEqual(album.song.length, 1);
  assert.strictEqual(album.song[0].title, 'Test Song');
  assert.strictEqual(album.song[0].artist, 'Test Artist');

  // Navic opens every album page with the ID3 variant; answer it instead of
  // surfacing a GENERIC "Endpoint not implemented" error over the album.
  for (const method of ['getAlbumInfo', 'getAlbumInfo2']) {
    const info = JSON.parse(
      (await get(port, `/rest/${method}.view?id=${albumSummary.id}&${auth}&f=json`)).body
    )['subsonic-response'];
    assert.strictEqual(info.status, 'ok', `${method} should succeed`);
    assert.match(info.albumInfo.notes, /Test Song/);
  }

  const song = JSON.parse(
    (await get(port, `/rest/getSong.view?id=${album.song[0].id}&${auth}&f=json`)).body
  )['subsonic-response'].song;
  assert.strictEqual(song.title, 'Test Song');
  assert.match(song.contentType, /audio\//);

  const search = JSON.parse(
    (await get(port, `/rest/search3.view?query=Test&${auth}&f=json`)).body
  )['subsonic-response'].searchResult3;
  assert.strictEqual(search.song.length, 1);
  assert.strictEqual(search.song[0].id, song.id);

  const xmlAlbums = await get(port, `/rest/getAlbumList2.view?type=alphabeticalByName&size=10&${auth}&f=xml`);
  assert.match(xmlAlbums.body, /<albumList2>/);
  assert.match(xmlAlbums.body, /<album /);

  const cover = await get(port, `/rest/getCoverArt.view?id=${albumSummary.id}&${auth}`);
  assert.strictEqual(cover.status, 200);
  assert.match(String(cover.headers['content-type']), /^image\//);

  const ranged = await get(port, `/rest/stream.view?id=${song.id}&${auth}`, {
    headers: { Range: 'bytes=0-99' },
  });
  assert.strictEqual(ranged.status, 206);
  assert.strictEqual(Number(ranged.headers['content-length']), 100);
  assert.match(String(ranged.headers['content-range']), /^bytes 0-99\//);

  const download = await get(port, `/rest/download.view?id=${song.id}&${auth}`);
  assert.strictEqual(download.status, 200);
  assert.match(String(download.headers['content-disposition']), /^attachment;/);

  const bad = await get(port, `/rest/ping.view?u=${cfg.username}&t=deadbeef&s=x&v=1.16.1&c=test&f=json`);
  assert.strictEqual(bad.status, 200, 'Subsonic errors must still return HTTP 200');
  const badBody = JSON.parse(bad.body)['subsonic-response'];
  assert.strictEqual(badBody.status, 'failed');
  assert.strictEqual(badBody.error.code, 40);

  const xml = await get(port, `/rest/ping.view?${auth}&f=xml`);
  assert.match(String(xml.headers['content-type']), /text\/xml/);
  assert.match(xml.body, /<subsonic-response[^>]*status="ok"/);

  const enc = Buffer.from(cfg.password, 'utf8').toString('hex');
  const legacy = JSON.parse(
    (await get(port, `/rest/ping.view?u=${cfg.username}&p=enc:${enc}&v=1.16.1&c=test&f=json`)).body
  )['subsonic-response'];
  assert.strictEqual(legacy.status, 'ok');

  const status = JSON.parse((await get(port, '/mobile/api/status')).body);
  assert.strictEqual(status.ok, true);
  assert.strictEqual(status.running, true);
});
