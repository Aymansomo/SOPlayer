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
const mobile = require('../src/server/mobile/index');

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 5000 }, (res) => {
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

test('Subsonic handshake over the LAN listener', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const cfg = config.update({ enabled: true, port, bindHost: '127.0.0.1' });

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
  assert.strictEqual(pingBody.type, 'Riff');
  assert.strictEqual(pingBody.version, '1.16.1');
  assert.strictEqual(pingBody.openSubsonic, true);

  const license = JSON.parse((await get(port, `/rest/getLicense.view?${auth}&f=json`)).body)['subsonic-response'];
  assert.strictEqual(license.license.valid, true);

  const folders = JSON.parse((await get(port, `/rest/getMusicFolders.view?${auth}&f=json`)).body)['subsonic-response'];
  assert.strictEqual(folders.musicFolders.musicFolder[0].name, 'Riff');

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
