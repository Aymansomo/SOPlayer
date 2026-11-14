'use strict';

/**
 * Minimal Subsonic / OpenSubsonic API surface.
 *
 * Phase 0 implements the handshake endpoints Navic needs to accept the server
 * plus a few harmless stubs. Library, streaming and collection endpoints are
 * added in later phases.
 */

const config = require('./config');
const { checkRequestAuth } = require('./auth');

const API_VERSION = '1.16.1';
const SERVER_VERSION = (() => {
  try {
    return require('../../../package.json').version || '0';
  } catch (_) {
    return '0';
  }
})();

const XMLNS = 'http://subsonic.org/restapi';

class SubsonicError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubsonicError';
    this.code = code;
  }
}

const ERRORS = {
  GENERIC: 0,
  MISSING_PARAM: 10,
  WRONG_CREDENTIALS: 40,
  NOT_AUTHORIZED: 50,
  NOT_FOUND: 70,
};

// ---------------------------------------------------------------------------
// Response envelope
// ---------------------------------------------------------------------------

function okResponse(payload) {
  return Object.assign({
    status: 'ok',
    version: API_VERSION,
    type: 'Riff',
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
  }, payload || {});
}

function errorResponse(code, message) {
  return {
    status: 'failed',
    version: API_VERSION,
    type: 'Riff',
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
    error: { code, message },
  };
}

// ---------------------------------------------------------------------------
// XML serialization
// ---------------------------------------------------------------------------

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Subsonic wraps list results in a named container whose children are the
// singular form of the container. A few names do not follow that rule.
const ARRAY_ITEM_NAMES = {
  albumList: 'album',
  albumList2: 'album',
  randomSongs: 'song',
  songsByGenre: 'song',
  topSongs: 'song',
  similarSongs: 'song',
  similarSongs2: 'song',
  videos: 'video',
};

function arrayItemName(key) {
  if (ARRAY_ITEM_NAMES[key]) return ARRAY_ITEM_NAMES[key];
  if (key.endsWith('s')) return key.slice(0, -1);
  return key;
}

function renderAttributes(attrs) {
  let out = '';
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    out += ` ${key}="${xmlEscape(value)}"`;
  }
  return out;
}

function renderValue(name, value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    const itemName = arrayItemName(name);
    return value.map((item) => renderValue(itemName, item)).join('');
  }
  if (typeof value === 'object') {
    const attrs = {};
    const children = [];
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined || child === null) continue;
      if (typeof child === 'object') children.push(renderValue(key, child));
      else attrs[key] = child;
    }
    const attrText = renderAttributes(attrs);
    if (!children.length) return `<${name}${attrText}/>`;
    return `<${name}${attrText}>${children.join('')}</${name}>`;
  }
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

function serializeXml(root) {
  const attrs = {};
  const children = [];
  for (const [key, value] of Object.entries(root)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') children.push(renderValue(key, value));
    else attrs[key] = value;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<subsonic-response xmlns="${XMLNS}"${renderAttributes(attrs)}>` +
    `${children.join('')}</subsonic-response>`;
}

function serializeJson(root) {
  return JSON.stringify({ 'subsonic-response': root });
}

function sendResponse(req, res, params, root) {
  const format = String(params.get('f') || 'xml').toLowerCase();
  const isJson = format === 'json' || format === 'jsonp';
  const body = isJson ? serializeJson(root) : serializeXml(root);
  const contentType = isJson
    ? 'application/json; charset=utf-8'
    : 'text/xml; charset=utf-8';
  const headers = {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  };
  if (res.headersSent) {
    try { res.end(body); } catch (_) {}
    return;
  }
  res.writeHead(200, headers);
  // Subsonic requires HTTP 200 even for errors.
  res.end(req && req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

function currentUsername() {
  return config.get().username;
}

const routes = {
  ping(params) {
    return {};
  },

  getlicense(params) {
    return { license: { valid: true } };
  },

  getmusicfolders(params) {
    return {
      musicFolders: {
        musicFolder: [{ id: '1', name: 'Riff' }],
      },
    };
  },

  getopensubsonicextensions(params) {
    // Advertise nothing yet; Navic handles an empty list fine.
    return { openSubsonicExtensions: [] };
  },

  getscanstatus(params) {
    return { scanStatus: { scanning: false, count: 0 } };
  },

  getuser(params) {
    return {
      user: {
        username: currentUsername(),
        email: '',
        scrobblingEnabled: true,
        adminRole: true,
        settingsRole: true,
        downloadRole: true,
        uploadRole: false,
        playlistRole: true,
        coverArtRole: true,
        commentRole: false,
        podcastRole: false,
        shareRole: false,
        videoConversionRole: false,
        folder: [1],
      },
    };
  },

  getnowplaying(params) {
    return { nowPlaying: { entry: [] } };
  },

  getplayqueue(params) {
    return { playQueue: { entry: [] } };
  },

  saveplayqueue(params) {
    return {};
  },

  getbookmarks(params) {
    return { bookmarks: { bookmark: [] } };
  },

  getpodcasts(params) {
    return { podcasts: { channel: [] } };
  },

  getinternetradiostations(params) {
    return { internetRadioStations: { internetRadioStation: [] } };
  },

  getshares(params) {
    return { shares: { share: [] } };
  },

  getchatmessages(params) {
    return { chatMessages: { chatMessage: [] } };
  },
};

const unknownLogged = new Set();

// ---------------------------------------------------------------------------
// Router entry point
// ---------------------------------------------------------------------------

/**
 * Handle one `/rest/<method>` request.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} method  Subsonic method name, e.g. "ping"
 * @param {URLSearchParams} params
 */
function handleSubsonic(req, res, method, params) {
  const auth = checkRequestAuth(req, params);
  if (!auth.ok) {
    const code = auth.limited ? ERRORS.NOT_AUTHORIZED : ERRORS.WRONG_CREDENTIALS;
    const message = auth.limited
      ? 'Too many failed login attempts, try again later'
      : (auth.reason || 'Wrong username or password');
    return sendResponse(req, res, params, errorResponse(code, message));
  }

  const key = String(method || '').toLowerCase();
  const handler = routes[key];
  if (!handler) {
    if (!unknownLogged.has(key)) {
      unknownLogged.add(key);
      console.warn(`[mobile] Subsonic endpoint not implemented yet: ${method}`);
    }
    return sendResponse(req, res, params, errorResponse(
      ERRORS.GENERIC,
      `Endpoint not implemented: ${method}`
    ));
  }

  try {
    const payload = handler(params, req) || {};
    return sendResponse(req, res, params, okResponse(payload));
  } catch (err) {
    if (err instanceof SubsonicError) {
      return sendResponse(req, res, params, errorResponse(err.code, err.message));
    }
    console.error(`[mobile] ${method} failed:`, err && err.message);
    return sendResponse(req, res, params, errorResponse(
      ERRORS.GENERIC,
      (err && err.message) || 'Internal error'
    ));
  }
}

module.exports = {
  API_VERSION,
  SERVER_VERSION,
  ERRORS,
  SubsonicError,
  handleSubsonic,
  okResponse,
  errorResponse,
  serializeXml,
  serializeJson,
  sendResponse,
  routes,
};
