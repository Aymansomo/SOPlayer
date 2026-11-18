'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Writable } = require('stream');

const store = require('../src/server/mobile/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-store-'));
  return dir;
}

function touch(dir, name, size = 16) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  return file;
}

test('scan groups installers by app and sorts versions newest first', () => {
  const dir = tempStore();
  touch(dir, 'Navic-1.9.0.apk', 100);
  touch(dir, 'Navic-1.10.0.apk', 200);
  touch(dir, 'Riff Setup 0.7.5.exe', 300);
  touch(dir, 'notes.txt');

  const apps = store.scan(dir);
  assert.strictEqual(apps.length, 2);

  const navic = apps.find((app) => app.name === 'Navic');
  assert.ok(navic, 'Navic should be grouped');
  assert.strictEqual(navic.platform, 'Android');
  assert.deepStrictEqual(navic.versions.map((v) => v.version), ['1.10.0', '1.9.0']);
  assert.strictEqual(navic.latest.version, '1.10.0');

  const riff = apps.find((app) => app.name.startsWith('Riff'));
  assert.ok(riff);
  assert.strictEqual(riff.platform, 'Windows');
  assert.strictEqual(riff.latest.version, '0.7.5');
});

test('scan reads one level of sub-folders', () => {
  const dir = tempStore();
  touch(dir, 'android/Navic-2.0.0.apk');
  const apps = store.scan(dir);
  assert.strictEqual(apps.length, 1);
  assert.strictEqual(apps[0].versions[0].file, 'android/Navic-2.0.0.apk');
});

test('catalog page lists apps and links to the latest file', () => {
  const dir = tempStore();
  touch(dir, 'Navic-1.10.0.apk');
  touch(dir, 'Navic-1.9.0.apk');
  const html = store.page({ port: 6767 }, dir);
  assert.match(html, /Navic/);
  assert.match(html, /v1\.10\.0/);
  assert.match(html, /\/store\/files\/Navic-1\.10\.0\.apk/);
  assert.match(html, /1 earlier version/);
});

test('page explains an empty store', () => {
  const dir = tempStore();
  const html = store.page({}, dir);
  assert.match(html, /No apps yet/);
  assert.ok(html.includes(dir));
});

test('sendFile refuses paths outside the store folder', () => {
  const dir = tempStore();
  const statuses = [];
  class Res extends Writable {
    writeHead(code) { statuses.push(code); return this; }
    _write(chunk, enc, cb) { cb(); }
  }
  store.sendFile({ method: 'GET' }, new Res(), '../mobile.json', dir);
  store.sendFile({ method: 'GET' }, new Res(), '/etc/passwd', dir);
  assert.deepStrictEqual(statuses, [403, 403]);
});

test('sendFile streams a real file with the Android content type', async () => {
  const dir = tempStore();
  const file = touch(dir, 'Navic-1.0.0.apk', 32);
  const headers = {};
  const chunks = [];
  const res = new Writable({
    write(chunk, enc, cb) { chunks.push(chunk); cb(); },
  });
  res.writeHead = (code, h) => { headers.code = code; Object.assign(headers, h); return res; };
  store.sendFile({ method: 'GET' }, res, 'Navic-1.0.0.apk', dir);
  await new Promise((resolve) => res.on('finish', resolve));
  assert.strictEqual(headers.code, 200);
  assert.strictEqual(headers['Content-Type'], 'application/vnd.android.package-archive');
  assert.match(headers['Content-Disposition'], /Navic-1\.0\.0\.apk/);
  assert.strictEqual(Buffer.concat(chunks).length, fs.statSync(file).size);
});

test('sendFile honours a Range request so downloads can resume', async () => {
  const dir = tempStore();
  touch(dir, 'Navic-1.0.0.apk', 64);
  const headers = {};
  const chunks = [];
  const res = new Writable({
    write(chunk, enc, cb) { chunks.push(chunk); cb(); },
  });
  res.writeHead = (code, h) => { headers.code = code; Object.assign(headers, h); return res; };
  store.sendFile({ method: 'GET', headers: { range: 'bytes=10-19' } }, res, 'Navic-1.0.0.apk', dir);
  await new Promise((resolve) => res.on('finish', resolve));
  assert.strictEqual(headers.code, 206);
  assert.strictEqual(headers['Content-Range'], 'bytes 10-19/64');
  assert.strictEqual(Buffer.concat(chunks).length, 10);
});

test('compareVersions orders numerically, not lexically', () => {
  assert.ok(store.compareVersions('1.10.0', '1.9.0') > 0);
  assert.ok(store.compareVersions('1.9.0', '1.10.0') < 0);
  assert.strictEqual(store.compareVersions('2.0', '2.0.0'), 0);
});
