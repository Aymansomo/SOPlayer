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
const { Readable } = require('stream');

const config = require('./config');
const library = require('./library');
const online = require('./online');
const collection = require('./collection');
const transcode = require('./transcode');
const playlistCover = require('./playlist-cover');
const lyrics = require('./lyrics');
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
    type: 'SOPlayer',
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
  }, payload || {});
}

function errorResponse(code, message) {
  return {
    status: 'failed',
    version: API_VERSION,
    type: 'SOPlayer',
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
  const plays = collection.playCount(song);
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
    // Subsonic expects a timestamp here; `true` breaks client date parsing.
    starred: collection.starredAt(song) || undefined,
    playCount: plays > 0 ? plays : undefined,
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

function playlistPayload(pl) {
  const summary = collection.playlistSummary(pl);
  return {
    playlist: {
      id: summary.id,
      name: summary.name,
      owner: currentUsername(),
      public: false,
      songCount: summary.songCount,
      duration: Math.round(summary.duration),
      created: summary.created,
      changed: summary.changed,
      // A 2×2 mosaic of the first four songs, generated on demand.
      coverArt: playlistCover.coverIdFor(summary.id),
      entry: summary.entry.map(subsonicSong),
    },
  };
}

function playlistSummaryPayload(pl) {
  const summary = collection.playlistSummary(pl);
  return {
    id: summary.id,
    name: summary.name,
    owner: currentUsername(),
    public: false,
    songCount: summary.songCount,
    duration: Math.round(summary.duration),
    created: summary.created,
    changed: summary.changed,
    coverArt: playlistCover.coverIdFor(summary.id),
  };
}

function albumInfoPayload(album) {
  const details = [album.artist, album.year ? String(album.year) : '', album.genre]
    .filter(Boolean);
  return {
    notes: details.length ? `${album.name}\n${details.join(' · ')}` : String(album.name || ''),
    musicBrainzId: '',
    lastFmUrl: '',
    smallImageUrl: '',
    mediumImageUrl: '',
    largeImageUrl: '',
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
// Search (local library + online songs)
// ---------------------------------------------------------------------------

const SEARCH_MAX = 500;

function clampedCount(value, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, SEARCH_MAX);
}

function pageOf(items, offset, count) {
  return { total: items.length, items: items.slice(offset, offset + count) };
}

/**
 * Local search plus online (YouTube / SoundCloud) matches, paged together.
 * Online matches are appended after local ones, so a local song with the same
 * name still comes first, and only for real queries short enough for yt-dlp.
 */
async function mergedSearch(params) {
  const query = params.get('query') || '';
  const result = library.search(query, {
    artistCount: SEARCH_MAX,
    artistOffset: 0,
    albumCount: SEARCH_MAX,
    albumOffset: 0,
    songCount: SEARCH_MAX,
    songOffset: 0,
  });

  let artists = result.artists.items;
  let albums = result.albums.items;
  let songs = result.songs.items;

  if (query.trim().length >= 2 && online.isEnabled()) {
    const extraSongs = await online.searchSongs(query, { limit: 25 }).catch(() => []);
    if (extraSongs.length) {
      const seen = new Set(songs.map((song) => song.id));
      songs = songs.concat(extraSongs.filter((song) => !seen.has(song.id)));
    }
    const extraAlbums = online.searchAlbums(query)
      .filter((album) => !albums.some((existing) => existing.id === album.id));
    if (extraAlbums.length) albums = albums.concat(extraAlbums);
    const extraArtists = online.searchArtists(query)
      .filter((artist) => !artists.some((existing) => existing.id === artist.id));
    if (extraArtists.length) artists = artists.concat(extraArtists);
  }

  return {
    artists: pageOf(
      artists,
      clampedCount(params.get('artistOffset'), 0),
      clampedCount(params.get('artistCount'), 20)
    ),
    albums: pageOf(
      albums,
      clampedCount(params.get('albumOffset'), 0),
      clampedCount(params.get('albumCount'), 20)
    ),
    songs: pageOf(
      songs,
      clampedCount(params.get('songOffset'), 0),
      clampedCount(params.get('songCount'), 20)
    ),
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
  // Playlists get a composed mosaic, online songs their own thumbnail, and
  // anything else goes through the local library (embedded art, cover.jpg).
  const art = (playlistCover.isPlaylistCoverId(id)
    ? await playlistCover.ensureCover(id).catch(() => null)
    : null) ||
    (await online.ensureCoverArt(id)) ||
    (await library.ensureCoverArt(id));
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

/**
 * Parse a single `bytes=` range.
 *
 * Returns `null` when the header should be ignored (malformed or multi-range:
 * serving the whole file is the friendly behaviour), and
 * `{ unsatisfiable: true }` when the range cannot be satisfied (416).
 */
function parseRange(rangeHeader, total) {
  const header = String(rangeHeader || '').trim();
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
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
  if (start < 0) return null;
  // Out of bounds: 416 needs the total length, so report it before treating the
  // header as malformed.
  if (start >= total) return { unsatisfiable: true };
  if (end < start) return null;
  return { start, end: Math.min(end, total - 1) };
}

function contentDisposition(type, name) {
  const ascii = String(name || 'song').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(String(name || 'song'))}`;
}

function streamFilename(song, ext) {
  const base = `${(song && song.artist) || 'Unknown'} - ${(song && song.title) || 'song'}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'song';
  return `${base}.${ext}`;
}

function sendTranscodeHead(res, song) {
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Accept-Ranges': 'none',
    'Cache-Control': 'no-store',
    'Content-Disposition': contentDisposition('inline', streamFilename(song, 'mp3')),
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end();
}

async function handleStream(req, res, params, asDownload) {
  const id = requestPathParam(params, 'id');
  const info = library.streamInfo(id);
  const song = info ? info.song : online.getSong(id);

  // ---- Online songs (Phase 4) ----
  if (!info) {
    if (!song) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Song not found');
    }

    // `download` is always the untouched original; `stream` may transcode.
    const plan = asDownload ? { transcode: false } : transcode.plan(song, params);
    if (plan.transcode) {
      if (req.method === 'HEAD') return sendTranscodeHead(res, song);
      const opened = await online.openStream(id, { full: true }).catch(() => null);
      const body = opened && opened.response && opened.response.body;
      // Ranged chunks first: a single CDN connection is throttled badly.
      const readable = online.rangedBody(opened) || (body ? Readable.fromWeb(body) : null);
      if (readable) {
        const started = transcode.toMp3(res, { readable }, {
          bitRate: plan.bitRate,
          timeOffset: plan.timeOffset,
          name: streamFilename(song, 'mp3'),
        });
        if (started) return;
      }
      // ffmpeg could not start: relay the original stream instead.
    }

    const handled = await online.streamTrack(id, req, res, { download: asDownload });
    if (handled) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Song not found');
  }

  // ---- Local files (Phase 2 transcode support) ----
  const plan = asDownload ? { transcode: false } : transcode.plan(info.song, params);
  if (plan.transcode) {
    if (req.method === 'HEAD') return sendTranscodeHead(res, info.song);
    const started = transcode.toMp3(res, { path: info.path }, {
      bitRate: plan.bitRate,
      timeOffset: plan.timeOffset,
      name: streamFilename(info.song, 'mp3'),
    });
    if (started) return;
    // ffmpeg could not start: fall back to the original bytes.
  }

  const total = info.size;
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = total - 1;
  let status = 200;

  if (rangeHeader) {
    const range = parseRange(rangeHeader, total);
    if (range && range.unsatisfiable) {
      res.writeHead(416, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Range': `bytes */${total}`,
      });
      return res.end();
    }
    // A malformed header is ignored: serve the whole file.
    if (range) {
      start = range.start;
      end = range.end;
      status = 206;
    }
  }

  const length = Math.max(0, end - start + 1);
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

  // Navic asks for this whenever an album page opens (the ID3 variant), so a
  // missing endpoint surfaced as a GENERIC error over the album title. There is
  // no Last.fm data here, but the album's own details are a useful description.
  getalbuminfo(params) {
    const id = requestPathParam(params, 'id');
    const album = library.getAlbum(id) || online.getAlbum(id);
    if (!album) throw new SubsonicError(ERRORS.NOT_FOUND, 'Album not found');
    return { albumInfo: albumInfoPayload(album) };
  },

  getalbuminfo2(params) {
    return routes.getalbuminfo(params);
  },

  getalbumlist2(params) {
    const type = String(params.get('type') || '').toLowerCase();
    if (type === 'starred') {
      return { albumList2: { album: collection.starredAlbumList().map(subsonicAlbum) } };
    }
    if (type === 'frequent') {
      return { albumList2: { album: collection.frequentAlbums(params.get('size')).map(subsonicAlbum) } };
    }
    const albums = library.listAlbums(params.get('type'), {
      size: params.get('size'),
      offset: params.get('offset'),
    });
    return { albumList2: { album: albums.map(subsonicAlbum) } };
  },

  getalbumlist(params) {
    const type = String(params.get('type') || '').toLowerCase();
    if (type === 'starred') {
      return { albumList: { album: collection.starredAlbumList().map(subsonicAlbum) } };
    }
    if (type === 'frequent') {
      return { albumList: { album: collection.frequentAlbums(params.get('size')).map(subsonicAlbum) } };
    }
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

  async search3(params) {
    return searchResultPayload('searchResult3', await mergedSearch(params));
  },

  async search2(params) {
    return searchResultPayload('searchResult2', await mergedSearch(params));
  },

  async search(params) {
    return searchResultPayload('searchResult', await mergedSearch(params));
  },

  getstarred2(params) {
    return {
      starred2: {
        artist: collection.starredArtistList().map(subsonicArtist),
        album: collection.starredAlbumList().map(subsonicAlbum),
        song: collection.starredSongs().map(subsonicSong),
      },
    };
  },

  getstarred(params) {
    return {
      starred: {
        artist: collection.starredArtistList().map(subsonicArtist),
        album: collection.starredAlbumList().map(subsonicAlbum),
        song: collection.starredSongs().map(subsonicSong),
      },
    };
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

  // `ensureLyrics` also fetches (and saves) lyrics the PC never needed, so a
  // song downloaded on the phone still shows its lyrics offline.
  async getlyrics(params) {
    const artist = String(params.get('artist') || '');
    const title = String(params.get('title') || '');
    const found = title ? await lyrics.ensureLyrics({ title, artist }) : null;
    return { lyrics: { artist, title, value: found ? found.plain : '' } };
  },

  // OpenSubsonic: what Navic uses, timed lines included.
  async getlyricsbysongid(params) {
    const id = requestPathParam(params, 'id');
    const song = library.getSong(id) || online.getSong(id);
    const found = song ? await lyrics.ensureLyrics(song) : null;
    if (!song || !found) return { lyricsList: { structuredLyrics: [] } };
    return {
      lyricsList: {
        structuredLyrics: [{
          displayArtist: song.artist || '',
          displayTitle: song.title || '',
          lang: '',
          synced: found.synced,
          line: found.lines.map((line) => (
            found.synced
              ? { start: Math.max(0, Math.round(line.start)), value: line.value }
              : { value: line.value }
          )),
        }],
      },
    };
  },

  getplaylists(params) {
    return { playlists: { playlist: collection.playlists().map(playlistSummaryPayload) } };
  },

  getplaylist(params) {
    const pl = collection.getPlaylist(requestPathParam(params, 'id'));
    if (!pl) throw new SubsonicError(ERRORS.NOT_FOUND, 'Playlist not found');
    return playlistPayload(pl);
  },

  createplaylist(params) {
    const name = String(params.get('name') || '').trim();
    const existingId = requestPathParam(params, 'playlistId');
    const songIds = params.getAll('songId');
    const existing = existingId ? collection.getPlaylist(existingId) : null;
    let pl;
    if (existing) {
      // Subsonic: createPlaylist with an existing id replaces its track list.
      pl = collection.createPlaylist({ id: existingId, name: existing.name, songIds });
    } else {
      if (!name) throw new SubsonicError(ERRORS.MISSING_PARAM, 'Missing playlist name');
      pl = collection.createPlaylist({ name, songIds });
    }
    if (!pl) throw new SubsonicError(ERRORS.GENERIC, 'Could not save playlist');
    return playlistPayload(pl);
  },

  updateplaylist(params) {
    const id = requestPathParam(params, 'playlistId', 'id');
    const pl = collection.updatePlaylist(id, {
      name: params.get('name') || '',
      addSongIds: params.getAll('songIdToAdd'),
      removeIndexes: params.getAll('songIndexToRemove'),
    });
    if (!pl) throw new SubsonicError(ERRORS.NOT_FOUND, 'Playlist not found');
    return {};
  },

  deleteplaylist(params) {
    const id = requestPathParam(params, 'id');
    if (!collection.deletePlaylist(id)) {
      throw new SubsonicError(ERRORS.NOT_FOUND, 'Playlist not found');
    }
    return {};
  },

  scrobble(params) {
    const ids = params.getAll('id');
    const time = Number(params.get('time')) || Date.now();
    for (const id of ids) collection.scrobble(id, time);
    return {};
  },

  star(params) {
    for (const id of params.getAll('id')) collection.starSong(id);
    for (const id of params.getAll('albumId')) collection.setStarredAlbum(id, false);
    for (const id of params.getAll('artistId')) collection.setStarredArtist(id, false);
    return {};
  },

  unstar(params) {
    for (const id of params.getAll('id')) collection.unstarSong(id);
    for (const id of params.getAll('albumId')) collection.setStarredAlbum(id, true);
    for (const id of params.getAll('artistId')) collection.setStarredArtist(id, true);
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
    return Promise.resolve(handleStream(req, res, params, key === 'download')).catch((err) => {
      console.error(`[mobile] ${key} failed:`, err && err.message);
      sendEmpty(res, 500);
    });
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
