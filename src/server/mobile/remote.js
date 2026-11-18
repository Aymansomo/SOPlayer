'use strict';

/**
 * Phase 5 — `/remote`: phone browser control of the PC player.
 *
 * The mobile listener only *relays*. The renderer owns playback, so:
 *   1. the phone posts a command here,
 *   2. `commandHandler` forwards it over IPC to the renderer,
 *   3. the renderer applies it and pushes a state snapshot back every second,
 *   4. the phone polls the snapshot.
 *
 * Auth is a cookie session (separate from Subsonic credentials, same
 * username/password) with failed-login throttling. Commands must be same-origin
 * JSON, and everything is refused when `remoteEnabled` is off.
 */

const config = require('./config');
const {
  createSession,
  getSession,
  destroySession,
  parseCookies,
  verifyRemotePassword,
  clientIp,
  isRateLimited,
  recordFailure,
  resetFailures,
} = require('./auth');

const COOKIE_NAME = 'riff_remote';
const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
// A phone sending a whole playlist to the PC carries every song id, so the body
// is larger than the transport commands it used to accept.
const MAX_BODY_BYTES = 256 * 1024;
const MAX_QUEUE_TRACKS = 500;
const STATE_STALE_MS = 15000;
const MAX_SEEK_S = 24 * 60 * 60;

const ACTIONS = new Set([
  'playtracks',
  'playpause',
  'play',
  'pause',
  'next',
  'prev',
  'seek',
  'volume',
  'mute',
  'like',
  'unlike',
]);

let remoteState = null;
let commandHandler = null;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function numberIn(value, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? clamp(n, min, max) : min;
}

function sendJson(res, status, payload, extraHeaders) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, extraHeaders || {}));
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function authToken(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  return cookies[COOKIE_NAME] || '';
}

function hasSession(req) {
  const token = authToken(req);
  if (!token) return false;
  return !!getSession(token, clientIp(req));
}

function isSameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true; // same-origin form posts and local curl omit it
  try {
    return new URL(origin).host === (req.headers && req.headers.host);
  } catch (_) {
    return false;
  }
}

function remoteEnabled() {
  return config.get().remoteEnabled !== false;
}

/** A song the phone wants the desktop to play, not what is playing now. */
function sanitizeQueueTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const out = {
    id: String(track.id || '').slice(0, 200),
    title: String(track.title || '').slice(0, 300),
    artist: String(track.artist || '').slice(0, 200),
    album: String(track.album || '').slice(0, 200),
    duration: numberIn(track.duration, 0, MAX_SEEK_S),
    platform: String(track.platform || '').slice(0, 40),
  };
  return out.id || out.title ? out : null;
}

function sanitizeTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const out = {
    title: String(track.title || '').slice(0, 300),
    artist: String(track.artist || '').slice(0, 200),
    album: String(track.album || '').slice(0, 200),
    thumbnail: typeof track.thumbnail === 'string' ? track.thumbnail.slice(0, 1000) : '',
    duration: numberIn(track.duration, 0, MAX_SEEK_S),
    platform: String(track.platform || '').slice(0, 40),
  };
  return out.title || out.artist ? out : null;
}

// ---------------------------------------------------------------------------
// state shared with the renderer
// ---------------------------------------------------------------------------

function setState(input) {
  const snapshot = input && typeof input === 'object' ? input : {};
  remoteState = {
    track: sanitizeTrack(snapshot.track),
    playing: !!snapshot.playing,
    position: numberIn(snapshot.position, 0, MAX_SEEK_S),
    duration: numberIn(snapshot.duration, 0, MAX_SEEK_S),
    volume: numberIn(snapshot.volume, 0, 1),
    muted: !!snapshot.muted,
    liked: !!snapshot.liked,
    updatedAt: Date.now(),
  };
  return remoteState;
}

function statePayload() {
  const enabled = remoteEnabled();
  const fresh = !!remoteState && (Date.now() - remoteState.updatedAt < STATE_STALE_MS);
  const canControl = enabled && fresh;
  return {
    ok: true,
    remoteEnabled: enabled,
    canControl,
    stale: !!remoteState && !fresh,
    state: remoteState ? Object.assign({}, remoteState, { canControl }) : null,
  };
}

function setCommandHandler(handler) {
  commandHandler = typeof handler === 'function' ? handler : null;
}

/**
 * Validate a command and forward it to the renderer.
 * @returns {{ok:boolean,error?:string}}
 */
function dispatchCommand(action, value, options) {
  const name = String(action || '').trim().toLowerCase();
  if (!ACTIONS.has(name)) return { ok: false, error: 'Unknown action' };
  if (!commandHandler) return { ok: false, error: 'Riff is not running' };

  const command = { action: name };
  if (name === 'seek') command.value = numberIn(value, 0, MAX_SEEK_S);
  else if (name === 'volume') command.value = numberIn(value, 0, 1);
  else if (name === 'playtracks') {
    const input = options && Array.isArray(options.tracks) ? options.tracks : [];
    const tracks = input.slice(0, MAX_QUEUE_TRACKS).map(sanitizeQueueTrack).filter(Boolean);
    if (!tracks.length) return { ok: false, error: 'No songs to play' };
    command.tracks = tracks;
    command.index = Math.min(
      Math.max(0, Math.trunc(Number(options && options.index) || 0)),
      tracks.length - 1
    );
  }

  try {
    const result = commandHandler(command);
    if (result && result.ok === false) return { ok: false, error: result.error || 'Command failed' };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Command failed' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * Handle `/remote/api/*`. Returns false for unknown paths.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname
 * @returns {Promise<boolean>}
 */
async function handle(req, res, pathname) {
  const prefix = '/remote/api/';
  if (!pathname.startsWith(prefix)) return false;

  const route = pathname.slice(prefix.length).replace(/\/+$/, '');
  const ip = clientIp(req);
  const method = String(req.method || 'GET').toUpperCase();

  if (route === 'login') {
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST required' }), true;
    if (!remoteEnabled()) {
      return sendJson(res, 403, { ok: false, error: 'Remote control is off in Riff settings' }), true;
    }
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { ok: false, error: 'Too many attempts, try again later' }), true;
    }
    const body = (await readJsonBody(req)) || {};
    if (!verifyRemotePassword(String(body.username || ''), String(body.password || ''))) {
      recordFailure(ip);
      return sendJson(res, 401, { ok: false, error: 'Wrong username or password' }), true;
    }
    resetFailures(ip);
    const { token } = createSession(ip);
    return sendJson(res, 200, Object.assign({ ok: true }, statePayload()), {
      'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/remote; HttpOnly; SameSite=Strict; ` +
        `Max-Age=${SESSION_MAX_AGE_S}`,
    }), true;
  }

  if (route === 'logout') {
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST required' }), true;
    destroySession(authToken(req));
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `${COOKIE_NAME}=; Path=/remote; HttpOnly; SameSite=Strict; Max-Age=0`,
    }), true;
  }

  if (route === 'state') {
    if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET required' }), true;
    if (!hasSession(req)) return sendJson(res, 401, { ok: false, needLogin: true }), true;
    return sendJson(res, 200, statePayload()), true;
  }

  if (route === 'command') {
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST required' }), true;
    if (!hasSession(req)) return sendJson(res, 401, { ok: false, needLogin: true }), true;
    if (!isSameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Cross-origin command refused' }), true;
    if (!remoteEnabled()) return sendJson(res, 403, { ok: false, error: 'Remote control is off' }), true;

    const body = (await readJsonBody(req)) || {};
    const result = dispatchCommand(body.action, body.value, {
      tracks: body.tracks,
      index: body.index,
    });
    if (!result.ok) return sendJson(res, 400, result), true;

    // Optimistically reflect instant toggles so the page feels responsive even
    // before the renderer's next snapshot arrives.
    if (remoteState) {
      if (body.action === 'playpause') remoteState.playing = !remoteState.playing;
      else if (body.action === 'play') remoteState.playing = true;
      else if (body.action === 'pause') remoteState.playing = false;
      else if (body.action === 'like') remoteState.liked = true;
      else if (body.action === 'unlike') remoteState.liked = false;
      else if (body.action === 'mute') remoteState.muted = !remoteState.muted;
      else if (body.action === 'volume') remoteState.volume = numberIn(body.value, 0, 1);
      else if (body.action === 'seek') remoteState.position = numberIn(body.value, 0, MAX_SEEK_S);
    }
    return sendJson(res, 200, Object.assign({ ok: true }, statePayload())), true;
  }

  return sendJson(res, 404, { ok: false, error: 'Unknown remote endpoint' }), true;
}

module.exports = {
  COOKIE_NAME,
  ACTIONS,
  handle,
  setState,
  statePayload,
  setCommandHandler,
  dispatchCommand,
  remoteEnabled,
};
