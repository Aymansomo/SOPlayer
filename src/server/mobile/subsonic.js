'use strict';

/**
 * Minimal Subsonic / OpenSubsonic API surface.
 *
 * Phase 0 implements the handshake endpoints Navic needs to accept the server
 * plus a few harmless stubs. Library, streaming and collection endpoints are
 * added in later phases.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');
const library = require('./library');
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

const IGNORED_ARTICLES = 'The El La Los Las Le Les';

function indexLetter(name) {
  const first = String(name || '').trim().charAt(0);
  if (!first) return '#';
  if (/\p{L}/u.test(first)) return first.toUpperCase();
  return '#';
}

function subsonicSong(song) {
  if (!song) return null;
  return {
    id: song.id,
    parent: song.albumId,
    isDir: false,
    title: song.title,
    album: song.album,
    artist: song.artist,
    albumArtist: song.albumArtist || song.artist,
    track: song.track || undefined,
    year: song.year || undefined,
    genre: song.genre || undefined,
    coverArt: song.coverArt || song.albumId,
    size: song.size,
    contentType: song.contentType,
    suffix: song.suffix,
    duration: Math.round(song.duration || 0),
    bitRate: song.bitRate || undefined,
    path: song.path,
    discNumber: song.discNumber || 1,
    albumId: song.albumId,
    artistId: song.artistId,
    type: 'music',
    isVideo: false,
    created: library.isoDate(song.createdMs) || undefined,
  };
}

function subsonicAlbum(album) {
  if (!album) return null;
  return {
    id: album.id,
    name: album.name,
    artist: album.artist,
    artistId: album.artistId,
    coverArt: album.coverArt || album.id,
    songCount: album.songCount || 0,
    duration: Math.round(album.duration || 0),
    created: album.created,
    year: album.year || undefined,
    genre: album.genre || undefined,
    isDir: true,
  };
}

function subsonicArtist(artist) {
  if (!artist) return null;
  return {
    id: artist.id,
    name: artist.name,
    coverArt: artist.coverArt || undefined,
    albumCount: artist.albumCount || 0,
  };
}

function artistIndexGroups(artists) {
  const groups = new Map();
  for (const artist of artists) {
    const letter = indexLetter(artist.name);
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(subsonicArtist(artist));
  }
  return Array.from(groups.entries())
    .sort((a, b) => {
      if (a[0] === '#') return 1;
      if (b[0] === '#') return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([name, list]) => ({ name, artist: list }));
}

function subsonicGenres() {
  return library.genres().map((genre) => ({
    value: genre.value,
    songCount: genre.songCount,
    albumCount: genre.albumCount,
  }));
}

function searchResultPayload(key, result) {
  return {
    [key]: {
      artist: result.artists.items.map(subsonicArtist),
      album: result.albums.items.map(subsonicAlbum),
      song: result.songs.items.map(subsonicSong),
    },
  };
}

function scanStatusPayload() {
  const status = library.getScanStatus();
  return {
    scanStatus: {
      scanning: !!status.scanning,
      count: status.count,
      folderCount: status.folderCount,
      lastScan: status.lastScan || undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Binary endpoints (cover art, stream, download)
// ---------------------------------------------------------------------------

function sendEmpty(res, statusCode) {
  if (!res.headersSent) res.writeHead(statusCode);
  res.end();
}

function requestPathParam(params, ...names) {
  for (const name of names) {
    const value = params.get(name);
    if (value) return value;
  }
  return '';
}

async function handleCoverArt(req, res, params) {
  const id = requestPathParam(params, 'id', 'c');
  const art = await library.ensureCoverArt(id);
  if (!art) return sendEmpty(res, 404);

  const etag = `"cover-${id}-${art.size}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      'ETag': etag,
      'Cache-Control': 'public, max-age=86400',
    });
    return res.end();
  }

  const headers = {
    'Content-Type': art.mime || 'image/jpeg',
    'Content-Length': art.size,
    'Cache-Control': 'public, max-age=86400',
    'ETag': etag,
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  };

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }

  const stream = fs.createReadStream(art.path);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end();
  });
  res.writeHead(200, headers);
  stream.pipe(res);
}

function parseRange(rangeHeader, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader || '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start;
  let end;
  if (!rawStart) {
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd ? Number.parseInt(rawEnd, 10) : total - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start || start >= total) return null;
  return { start, end: Math.min(end, total - 1) };
}

function contentDisposition(type, name) {
  const ascii = String(name || 'song').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name || 'song'))}`;
}

function handleStream(req, res, params, asDownload) {
  const id = requestPathParam(params, 'id');
  const info = library.streamInfo(id);
  if (!info) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Song not found');
  }

  const total = info.size;
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = total - 1;
  let status = 200;

  if (rangeHeader) {
    const range = parseRange(rangeHeader, total);
    if (!range) {
      res.writeHead(416, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Range': `bytes */${total}`,
      });
      return res.end();
    }
    start = range.start;
    end = range.end;
    status = 206;
  }

  const length = end - start + 1;
  const headers = {
    'Content-Type': info.mime,
    'Content-Length': length,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Content-Disposition': contentDisposition(asDownload ? 'attachment' : 'inline', info.name),
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    return res.end();
  }

  const stream = fs.createReadStream(info.path, { start, end });
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end();
  });
  res.writeHead(status, headers);
  stream.pipe(res);
}

// ---------------------------------------------------------------------------
// JSON / XML routes
// ---------------------------------------------------------------------------

const routes = {
  ping(params) {
    return {};
  },

  getlicense(params) {
    return { license: { valid: true } };
  },

  getmusicfolders(params) {
    const folders = library.configuredFolders();
    const musicFolder = folders.map((folder, index) => ({
      id: String(index + 1),
      name: path.basename(folder) || 'Music',
    }));
    // Some clients dislike an empty list; keep a placeholder folder instead.
    if (!musicFolder.length) musicFolder.push({ id: '1', name: 'Music' });
    return { musicFolders: { musicFolder } };
  },

  getartists(params) {
    return {
      artists: {
        ignoredArticles: IGNORED_ARTICLES,
        index: artistIndexGroups(library.allArtists()),
      },
    };
  },

  getindexes(params) {
    const snapshot = library.getSnapshot();
    return {
      indexes: {
        lastModified: snapshot.generatedAt || 0,
        ignoredArticles: IGNORED_ARTICLES,
        index: artistIndexGroups(library.allArtists()),
      },
    };
  },

  getartist(params) {
    const id = requestPathParam(params, 'id');
    const artist = library.getArtist(id);
    if (!artist) throw new SubsonicError(ERRORS.NOT_FOUND, 'Artist not found');
    return {
      artist: Object.assign(subsonicArtist(artist), {
        album: library.artistAlbums(id).map(subsonicAlbum),
      }),
    };
  },

  getalbum(params) {
    const id = requestPathParam(params, 'id');
    const album = library.getAlbum(id);
    if (!album) throw new SubsonicError(ERRORS.NOT_FOUND, 'Album not found');
    return {
      album: Object.assign(subsonicAlbum(album), {
        song: library.albumSongs(id).map(subsonicSong),
      }),
    };
  },

  getalbumlist2(params) {
    const albums = library.listAlbums(params.get('type'), {
      size: params.get('size'),
      offset: params.get('offset'),
    });
    return { albumList2: { album: albums.map(subsonicAlbum) } };
  },

  getalbumlist(params) {
    const albums = library.listAlbums(params.get('type'), {
      size: params.get('size'),
      offset: params.get('offset'),
    });
    return { albumList: { album: albums.map(subsonicAlbum) } };
  },

  getsong(params) {
    const song = library.getSong(requestPathParam(params, 'id'));
    if (!song) throw new SubsonicError(ERRORS.NOT_FOUND, 'Song not found');
    return { song: subsonicSong(song) };
  },

  getrandomsongs(params) {
    const songs = library.randomSongs({
      size: params.get('size'),
      genre: params.get('genre'),
      fromYear: params.get('fromYear'),
      toYear: params.get('toYear'),
    });
    return { randomSongs: songs.map(subsonicSong) };
  },

  getsongsbygenre(params) {
    const songs = library.songsByGenre(params.get('genre'), {
      size: params.get('count'),
      offset: params.get('offset'),
    });
    return { songsByGenre: songs.map(subsonicSong) };
  },

  getgenres(params) {
    return { genres: { genre: subsonicGenres() } };
  },

  search3(params) {
    const result = library.search(params.get('query') || '', {
      artistCount: params.get('artistCount'),
      artistOffset: params.get('artistOffset'),
      albumCount: params.get('albumCount'),
      albumOffset: params.get('albumOffset'),
      songCount: params.get('songCount'),
      songOffset: params.get('songOffset'),
    });
    return searchResultPayload('searchResult3', result);
  },

  search2(params) {
    const result = library.search(params.get('query') || '', {
      artistCount: params.get('artistCount'),
      artistOffset: params.get('artistOffset'),
      albumCount: params.get('albumCount'),
      albumOffset: params.get('albumOffset'),
      songCount: params.get('songCount'),
      songOffset: params.get('songOffset'),
    });
    return searchResultPayload('searchResult2', result);
  },

  search(params) {
    const result = library.search(params.get('query') || '', {
      artistCount: params.get('artistCount'),
      artistOffset: params.get('artistOffset'),
      albumCount: params.get('albumCount'),
      albumOffset: params.get('albumOffset'),
      songCount: params.get('songCount'),
      songOffset: params.get('songOffset'),
    });
    return searchResultPayload('searchResult', result);
  },

  getstarred2(params) {
    return { starred2: { artist: [], album: [], song: [] } };
  },

  getstarred(params) {
    return { starred: { artist: [], album: [], song: [] } };
  },

  getscanstatus(params) {
    return scanStatusPayload();
  },

  startscan(params) {
    library.startScan().catch(() => {});
    return scanStatusPayload();
  },

  getartistinfo2(params) {
    return {
      artistInfo2: {
        biography: '',
        musicBrainzId: '',
        lastFmUrl: '',
        smallImageUrl: '',
        mediumImageUrl: '',
        largeImageUrl: '',
        similarArtist: [],
      },
    };
  },

  getartistinfo(params) {
    return { artistInfo: routes.getartistinfo2(params).artistInfo2 };
  },

  getlyrics(params) {
    return { lyrics: { artist: '', title: '', value: '' } };
  },

  getlyricsbysongid(params) {
    return { lyricsList: { structuredLyrics: [] } };
  },

  getplaylists(params) {
    return { playlists: { playlist: [] } };
  },

  getplaylist(params) {
    throw new SubsonicError(ERRORS.NOT_FOUND, 'Playlist not found');
  },

  scrobble(params) {
    return {};
  },

  star(params) {
    return {};
  },

  unstar(params) {
    return {};
  },

  getopensubsonicextensions(params) {
    // Advertise nothing yet; Navic handles an empty list fine.
    return { openSubsonicExtensions: [] };
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

  // These endpoints return raw bytes rather than a Subsonic envelope.
  if (key === 'getcoverart') {
    return Promise.resolve(handleCoverArt(req, res, params)).catch((err) => {
      console.error('[mobile] getCoverArt failed:', err && err.message);
      sendEmpty(res, 500);
    });
  }
  if (key === 'stream' || key === 'download') {
    try {
      return handleStream(req, res, params, key === 'download');
    } catch (err) {
      console.error(`[mobile] ${key} failed:`, err && err.message);
      return sendEmpty(res, 500);
    }
  }

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

  const handleError = (err) => {
    if (err instanceof SubsonicError) {
      return sendResponse(req, res, params, errorResponse(err.code, err.message));
    }
    console.error(`[mobile] ${method} failed:`, err && err.message);
    return sendResponse(req, res, params, errorResponse(
      ERRORS.GENERIC,
      (err && err.message) || 'Internal error'
    ));
  };

  try {
    const result = handler(params, req);
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result)
        .then((payload) => sendResponse(req, res, params, okResponse(payload || {})))
        .catch(handleError);
    }
    return sendResponse(req, res, params, okResponse(result || {}));
  } catch (err) {
    return handleError(err);
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
