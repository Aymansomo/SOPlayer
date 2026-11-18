'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'riff-mobile-remote-test-'));
process.env.RIFF_DATA_DIR = tmpDir;

const config = require('../src/server/mobile/config');
const mobile = require('../src/server/mobile/index');

function request(port, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? null : options.body;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method: options.method || 'GET',
      timeout: 15000,
      headers: Object.assign(
        payload === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        options.headers || {}
      ),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function parseJson(res) {
  try { return JSON.parse(res.body); } catch (_) { return {}; }
}

test('remote page login, state and commands', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const cfg = config.update({
    enabled: true,
    port,
    bindHost: '127.0.0.1',
    folders: [],
    remoteEnabled: true,
  });

  await mobile.start();
  t.after(async () => {
    await mobile.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  // ---- Page is served ----
  const page = await request(port, '/remote');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /Remote control/);
  assert.match(String(page.headers['content-type']), /text\/html/);

  // ---- State requires a session ----
  const anonymous = await request(port, '/remote/api/state');
  assert.strictEqual(anonymous.status, 401);
  assert.strictEqual(parseJson(anonymous).needLogin, true);

  // ---- Login ----
  const wrong = await request(port, '/remote/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: cfg.username, password: 'nope' }),
  });
  assert.strictEqual(wrong.status, 401);

  const login = await request(port, '/remote/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  });
  assert.strictEqual(login.status, 200);
  const setCookie = String(login.headers['set-cookie'] || '');
  assert.match(setCookie, /riff_remote=/);
  assert.match(setCookie, /HttpOnly/);
  const cookie = setCookie.split(';')[0];
  assert.ok(cookie.startsWith('riff_remote='));

  // No renderer snapshot yet: the page must not claim control.
  const beforeState = await request(port, '/remote/api/state', { headers: { Cookie: cookie } });
  assert.strictEqual(beforeState.status, 200);
  const before = parseJson(beforeState);
  assert.strictEqual(before.canControl, false);
  assert.strictEqual(before.state, null);

  // ---- Renderer reports what is playing ----
  mobile.setRemoteState({
    track: { title: 'Test Song', artist: 'Test Artist', album: 'Album', duration: 200, thumbnail: 'http://example/x.jpg' },
    playing: true,
    position: 12.5,
    duration: 200,
    volume: 0.4,
    muted: false,
    liked: true,
  });
  const live = parseJson(await request(port, '/remote/api/state', { headers: { Cookie: cookie } }));
  assert.strictEqual(live.canControl, true);
  assert.strictEqual(live.state.track.title, 'Test Song');
  assert.strictEqual(live.state.playing, true);
  assert.strictEqual(live.state.liked, true);
  assert.strictEqual(live.state.volume, 0.4);

  // ---- Commands reach the renderer ----
  const received = [];
  mobile.onRemoteCommand((command) => {
    received.push(command);
    return { ok: true };
  });

  const seek = await request(port, '/remote/api/command', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'seek', value: 42.7 }),
  });
  assert.strictEqual(seek.status, 200);
  assert.deepStrictEqual(received[0], { action: 'seek', value: 42.7 });

  const volume = await request(port, '/remote/api/command', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'volume', value: 1.8 }),
  });
  assert.strictEqual(volume.status, 200);
  assert.deepStrictEqual(received[1], { action: 'volume', value: 1 }, 'volume is clamped');

  const like = await request(port, '/remote/api/command', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'like' }),
  });
  assert.strictEqual(like.status, 200);
  assert.strictEqual(parseJson(like).state.liked, true);

  // ---- "Play on PC": the phone chooses what the desktop plays ----
  const playOnPc = await request(port, '/remote/api/command', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({
      action: 'playtracks',
      index: 9,
      tracks: [
        { id: 'song-a', title: 'First', artist: 'A', album: 'X', duration: 210 },
        { id: 'song-b', title: 'Second', artist: 'B', album: 'X', duration: 180 },
      ],
    }),
  });
  assert.strictEqual(playOnPc.status, 200);
  assert.deepStrictEqual(received[3], {
    action: 'playtracks',
    index: 1,
    tracks: [
      { id: 'song-a', title: 'First', artist: 'A', album: 'X', duration: 210, platform: '' },
      { id: 'song-b', title: 'Second', artist: 'B', album: 'X', duration: 180, platform: '' },
    ],
  }, 'the start index is clamped to the queue the phone sent');

  const emptyQueue = await request(port, '/remote/api/command', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'playtracks', tracks: [] }),
  });
  assert.strictEqual(emptyQueue.status, 400);

  // ---- Rejections ----
  const unknown = await request(port, '/remote/api/command', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'rm -rf' }),
  });
  assert.strictEqual(unknown.status, 400);

  const crossOrigin = await request(port, '/remote/api/command', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'http://evil.example' },
    body: JSON.stringify({ action: 'playpause' }),
  });
  assert.strictEqual(crossOrigin.status, 403);

  const noSession = await request(port, '/remote/api/command', {
    method: 'POST',
    body: JSON.stringify({ action: 'playpause' }),
  });
  assert.strictEqual(noSession.status, 401);

  // ---- Remote can be turned off ----
  config.update({ remoteEnabled: false });
  const disabledState = parseJson(await request(port, '/remote/api/state', { headers: { Cookie: cookie } }));
  assert.strictEqual(disabledState.remoteEnabled, false);
  assert.strictEqual(disabledState.canControl, false);
  const disabledCommand = await request(port, '/remote/api/command', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: JSON.stringify({ action: 'playpause' }),
  });
  assert.strictEqual(disabledCommand.status, 403);
  const disabledLogin = await request(port, '/remote/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: cfg.username, password: cfg.password }),
  });
  assert.strictEqual(disabledLogin.status, 403);

  // ---- Logout invalidates the session ----
  config.update({ remoteEnabled: true });
  const logout = await request(port, '/remote/api/logout', {
    method: 'POST',
    headers: { Cookie: cookie },
    body: '{}',
  });
  assert.strictEqual(logout.status, 200);
  const afterLogout = await request(port, '/remote/api/state', { headers: { Cookie: cookie } });
  assert.strictEqual(afterLogout.status, 401);
});
