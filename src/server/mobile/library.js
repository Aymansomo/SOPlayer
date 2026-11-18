'use strict';

/**
 * Music library for the phone / Subsonic listener.
 *
 * The library is built exclusively from the folders in `mobile.json`
 * (`config.folders`). Riff's own cache, Downloads folder and anything else are
 * intentionally *not* indexed.
 *
 * Scanning is incremental: a file is re-probed only when its path, size or
 * mtime changed. The index is cached in `mobile-library.json` so a restart does
 * not need to touch ffprobe unless the music actually changed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { DATA_DIR, resolveBinary } = require('../../shared/platform');
const { writeFileAtomic } = require('./atomic-write');
const config = require('./config');
const online = require('./online');

const LIBRARY_VERSION = 2;
const LIBRARY_PATH = path.join(DATA_DIR, 'mobile-library.json');
const COVERS_DIR = path.join(DATA_DIR, 'mobile-covers');
const FALLBACK_COVER = path.join(__dirname, '../../../assets/cover-placeholder.png');

const AUDIO_TYPES = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.m4b', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.wav', 'audio/wav'],
  ['.wma', 'audio/x-ms-wma'],
  ['.aiff', 'audio/aiff'],
  ['.aif', 'audio/aiff'],
  ['.mp4', 'audio/mp4'],
  ['.webm', 'audio/webm'],
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '$recycle.bin',
  'system volume information', '.trash', '@eadir', 'lost+found',
]);

const COVER_NAMES = [
  'cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp',
  'folder.jpg', 'folder.jpeg', 'folder.png', 'folder.webp',
  'front.jpg', 'front.jpeg', 'front.png',
  'album.jpg', 'albumart.jpg', 'albumartsmall.jpg',
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{version:number,generatedAt:number,folders:string[],songs:object[],albums:object[],artists:object[],folderSignature:string}|null} */
let state = null;
let loaded = false;

let indexes = null;
function emptyIndexes() {
  return {
    songById: new Map(),
    songIdByPath: new Map(),
    songSearch: new Map(),
    albumById: new Map(),
    albumSearch: new Map(),
    artistSearch: new Map(),
    artistById: new Map(),
    songsByAlbum: new Map(),
    songsByArtist: new Map(),
    albumsByArtist: new Map(),
  };
}

let scanning = false;
let scanPromise = null;
let scanStartedAt = 0;
let scanFinishedAt = 0;
let scanCount = 0;
let scanError = '';

const coverPromises = new Map();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hashId(kind, key) {
  return crypto.createHash('sha1').update(`${kind}\n${key}`, 'utf8').digest('hex').slice(0, 32);
}

function normalizeKey(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Windows paths are case-insensitive, so every path is compared in this shape. */
function normalizePathKey(value) {
  return String(value == null ? '' : value).replace(/\\/g, '/').toLowerCase();
}

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isoDate(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toISOString();
  } catch (_) {
    return null;
  }
}

function isAudioFile(file) {
  return AUDIO_TYPES.has(path.extname(file).toLowerCase());
}

function contentTypeFor(file) {
  return AUDIO_TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
}

function shouldSkipDir(name) {
  if (!name) return true;
  if (name.startsWith('.')) return true;
  return SKIP_DIRS.has(name.toLowerCase());
}

function normalizeTags(tags) {
  const out = {};
  if (!tags || typeof tags !== 'object') return out;
  for (const [key, value] of Object.entries(tags)) {
    if (!key) continue;
    const k = String(key).toLowerCase();
    if (out[k] === undefined && value !== undefined && value !== null) {
      out[k] = String(value);
    }
  }
  return out;
}

function tagValue(tags, keys) {
  for (const key of keys) {
    const value = tags[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function parseTrack(value) {
  if (value == null) return 0;
  const match = String(value).match(/^\s*(\d{1,4})/);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}

function parseYear(value) {
  const match = String(value == null ? '' : value).match(/(\d{4})/);
  return match ? Number.parseInt(match[1], 10) || 0 : 0;
}

function fallbackFromFilename(file) {
  const ext = path.extname(file);
  let base = path.basename(file, ext).replace(/_/g, ' ').trim();
  // Strip leading track numbers: "01 - ", "01. ", "01 ".
  base = base.replace(/^\s*\d{1,3}\s*[-.)]\s*/, '').trim();
  const dash = base.indexOf(' - ');
  if (dash > 0) {
    return {
      artist: base.slice(0, dash).trim(),
      title: base.slice(dash + 3).trim(),
    };
  }
  return { artist: '', title: base || 'Unknown Title' };
}

function indexLetter(name) {
  const first = String(name || '').trim().charAt(0);
  if (!first) return '#';
  if (/\p{L}/u.test(first)) return first.toUpperCase();
  return '#';
}

function folderSignature(folders) {
  return folders.map((f) => f.toLowerCase()).sort().join('|');
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readStateFromDisk() {
  try {
    const raw = fs.readFileSync(LIBRARY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (Number(parsed.version || 0) !== LIBRARY_VERSION) return null;
    if (!Array.isArray(parsed.songs) || !Array.isArray(parsed.albums) || !Array.isArray(parsed.artists)) {
      return null;
    }
    return {
      version: LIBRARY_VERSION,
      generatedAt: Number(parsed.generatedAt) || 0,
      folders: Array.isArray(parsed.folders) ? parsed.folders.filter((f) => typeof f === 'string') : [],
      folderSignature: typeof parsed.folderSignature === 'string' ? parsed.folderSignature : '',
      songs: parsed.songs,
      albums: parsed.albums,
      artists: parsed.artists,
    };
  } catch (_) {
    return null;
  }
}

function writeStateToDisk(data) {
  const payload = JSON.stringify(data);
  const err = writeFileAtomic(LIBRARY_PATH, payload, 'utf8');
  if (err) {
    console.warn('[mobile] could not save library index:', err && err.message);
  }
}

function cloneState(data) {
  return {
    version: LIBRARY_VERSION,
    generatedAt: data.generatedAt || 0,
    folders: Array.isArray(data.folders) ? data.folders.slice() : [],
    folderSignature: data.folderSignature || '',
    songs: Array.isArray(data.songs) ? data.songs : [],
    albums: Array.isArray(data.albums) ? data.albums : [],
    artists: Array.isArray(data.artists) ? data.artists : [],
  };
}

function buildIndexes() {
  const next = emptyIndexes();
  if (!state) {
    indexes = next;
    return;
  }

  for (const song of state.songs) {
    next.songById.set(song.id, song);
    if (typeof song.path === 'string' && song.path) {
      next.songIdByPath.set(normalizePathKey(song.path), song.id);
    }
    // Normalised once per scan instead of once per search request.
    next.songSearch.set(song.id, [
      normalizeKey(song.title),
      normalizeKey(song.artist),
      normalizeKey(song.album),
    ]);
    if (!next.songsByAlbum.has(song.albumId)) next.songsByAlbum.set(song.albumId, []);
    next.songsByAlbum.get(song.albumId).push(song);
    if (!next.songsByArtist.has(song.artistId)) next.songsByArtist.set(song.artistId, []);
    next.songsByArtist.get(song.artistId).push(song);
  }
  for (const album of state.albums) {
    next.albumById.set(album.id, album);
    next.albumSearch.set(album.id, [normalizeKey(album.name), normalizeKey(album.artist)]);
  }
  for (const artist of state.artists) {
    next.artistById.set(artist.id, artist);
    next.artistSearch.set(artist.id, normalizeKey(artist.name));
    next.albumsByArtist.set(artist.id, []);
  }
  for (const album of state.albums) {
    const list = next.albumsByArtist.get(album.artistId);
    if (list) list.push(album);
  }

  for (const list of next.songsByAlbum.values()) sortSongsInAlbum(list);
  for (const list of next.songsByArtist.values()) {
    list.sort((a, b) => compareText(a.title, b.title));
  }
  for (const list of next.albumsByArtist.values()) {
    list.sort((a, b) => {
      const year = (a.year || 0) - (b.year || 0);
      return year || compareText(a.name, b.name);
    });
  }

  indexes = next;
}

function sortSongsInAlbum(list) {
  list.sort((a, b) => {
    const disc = (a.discNumber || 0) - (b.discNumber || 0);
    if (disc) return disc;
    const track = (a.track || 0) - (b.track || 0);
    if (track) return track;
    return compareText(a.title, b.title);
  });
}

function ensureLoaded() {
  if (loaded) return state;
  const disk = readStateFromDisk();
  state = disk ? cloneState(disk) : null;
  loaded = true;
  buildIndexes();
  if (state && !scanFinishedAt) scanFinishedAt = state.generatedAt || 0;
  return state;
}

function getSnapshot() {
  ensureLoaded();
  if (!state) {
    return { version: LIBRARY_VERSION, generatedAt: 0, folders: [], songs: [], albums: [], artists: [] };
  }
  return state;
}

function getIndexes() {
  ensureLoaded();
  if (!indexes) buildIndexes();
  return indexes;
}

// ---------------------------------------------------------------------------
// Music folders
// ---------------------------------------------------------------------------

function configuredFolders() {
  const cfg = config.get();
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(cfg.folders) ? cfg.folders : []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    let resolved;
    try { resolved = path.resolve(raw.trim()); } catch (_) { continue; }
    let stat;
    try { stat = fs.statSync(resolved); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ffprobe / ffmpeg
// ---------------------------------------------------------------------------

function runProcess(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child) child.kill(); } catch (_) {}
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (_) {
      finish(null);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (stderr.length < 4000) stderr += chunk;
      });
    }
    child.on('error', () => finish(null));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

async function probeFile(file) {
  const bin = resolveBinary('ffprobe');
  if (!bin) return null;
  const result = await runProcess(bin, [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], 20000);
  if (!result || result.code !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (_) {
    return null;
  }
}

async function extractCover(file, output) {
  const bin = resolveBinary('ffmpeg');
  if (!bin) return false;
  try { fs.mkdirSync(path.dirname(output), { recursive: true }); } catch (_) {}
  try { fs.unlinkSync(output); } catch (_) {}

  const result = await runProcess(bin, [
    '-v', 'error',
    '-y',
    '-i', file,
    '-map', '0:v:0',
    '-an',
    '-frames:v', '1',
    '-c:v', 'mjpeg',
    '-q:v', '3',
    '-vf', 'scale=640:-2:force_original_aspect_ratio=decrease',
    output,
  ], 30000);

  if (!result || result.code !== 0) {
    try { fs.unlinkSync(output); } catch (_) {}
    return false;
  }
  try {
    const stat = fs.statSync(output);
    if (stat.isFile() && stat.size > 0) return true;
  } catch (_) {}
  return false;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

async function collectFiles(folders) {
  const files = [];
  const seen = new Set();

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) await walk(full);
      } else if (entry.isFile()) {
        if (!isAudioFile(entry.name)) continue;
        const key = full.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        files.push(full);
      }
    }
  }

  for (const folder of folders) await walk(folder);
  files.sort(compareText);
  return files;
}

function songFromProbe(file, stat, data, previous, rootFolders) {
  const format = (data && data.format) || {};
  const streams = Array.isArray(data && data.streams) ? data.streams : [];
  const audio = streams.find((s) => s && s.codec_type === 'audio') || {};
  const tags = normalizeTags(format.tags);

  const fallback = fallbackFromFilename(file);
  const title = tagValue(tags, ['title']) || fallback.title;
  const artist = tagValue(tags, ['artist', 'album_artist', 'albumartist']) || fallback.artist || 'Unknown Artist';
  const albumArtist = tagValue(tags, ['album_artist', 'albumartist', 'artist']) || artist;
  const parentDir = path.dirname(file);
  const parent = path.basename(parentDir);
  // Loose singles in the root of a music folder have no meaningful album name;
  // use the song title so they do not all show up as three albums called
  // "music". Real album folders keep using the folder name.
  const inRoot = !!(rootFolders && rootFolders.has(parentDir.toLowerCase()));
  const album = tagValue(tags, ['album']) || (inRoot ? title : parent) || 'Unknown Album';
  const genre = tagValue(tags, ['genre']) || '';
  const year = parseYear(tagValue(tags, ['date', 'year', 'originaldate']));
  const track = parseTrack(tagValue(tags, ['track', 'tracknumber']));
  const discNumber = parseTrack(tagValue(tags, ['disc', 'discnumber'])) || 1;

  let duration = Number(format.duration || audio.duration);
  if (!Number.isFinite(duration) || duration < 0) duration = 0;
  let bitRate = Number(format.bit_rate || audio.bit_rate);
  if (!Number.isFinite(bitRate) || bitRate < 0) bitRate = 0;

  const suffix = path.extname(file).replace(/^\./, '').toLowerCase();
  const song = {
    id: hashId('song', file.toLowerCase()),
    title,
    artist,
    artistId: hashId('artist', normalizeKey(artist)),
    albumArtist,
    album,
    albumId: hashId('album', `${normalizeKey(albumArtist)}\n${normalizeKey(album)}\n${path.dirname(file).toLowerCase()}`),
    genre,
    year,
    track,
    discNumber,
    duration: Math.round(duration * 1000) / 1000,
    bitRate: Math.round(bitRate / 1000),
    sampleRate: Number(audio.sample_rate) || 0,
    channels: Number(audio.channels) || 0,
    size: stat.size,
    suffix,
    contentType: contentTypeFor(file),
    path: file,
    folder: path.dirname(file),
    mtimeMs: Math.round(stat.mtimeMs),
    createdMs: Math.round(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs),
    coverArt: '',
    parent: '',
    isDir: false,
    type: 'music',
    isVideo: false,
  };
  song.coverArt = song.albumId;
  song.parent = song.albumId;

  // Reuse a previously cached cover hint if present (not required, but keeps
  // the shape stable across scans).
  if (previous && previous.coverArt) song.coverArt = previous.coverArt;
  return song;
}

function fallbackSongFromStat(file, stat, previous, rootFolders) {
  const fallback = fallbackFromFilename(file);
  const artist = fallback.artist || 'Unknown Artist';
  const parentDir = path.dirname(file);
  const inRoot = !!(rootFolders && rootFolders.has(parentDir.toLowerCase()));
  const album = (inRoot ? fallback.title : path.basename(parentDir)) || 'Unknown Album';
  const suffix = path.extname(file).replace(/^\./, '').toLowerCase();
  const id = hashId('song', file.toLowerCase());
  const albumId = hashId('album', `${normalizeKey(artist)}\n${normalizeKey(album)}\n${path.dirname(file).toLowerCase()}`);
  return {
    id,
    title: fallback.title,
    artist,
    artistId: hashId('artist', normalizeKey(artist)),
    albumArtist: artist,
    album,
    albumId,
    genre: '',
    year: 0,
    track: 0,
    discNumber: 1,
    duration: (previous && previous.duration) || 0,
    bitRate: (previous && previous.bitRate) || 0,
    sampleRate: (previous && previous.sampleRate) || 0,
    channels: (previous && previous.channels) || 0,
    size: stat.size,
    suffix,
    contentType: contentTypeFor(file),
    path: file,
    folder: path.dirname(file),
    mtimeMs: Math.round(stat.mtimeMs),
    createdMs: Math.round(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs),
    coverArt: albumId,
    parent: albumId,
    isDir: false,
    type: 'music',
    isVideo: false,
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function buildCollections(songs) {
  const albums = new Map();
  const artists = new Map();

  for (const song of songs) {
    // ---- album ----
    let album = albums.get(song.albumId);
    if (!album) {
      album = {
        id: song.albumId,
        name: song.album,
        artist: song.albumArtist,
        artistId: hashId('artist', normalizeKey(song.albumArtist)),
        coverArt: song.albumId,
        songCount: 0,
        duration: 0,
        year: 0,
        genre: '',
        createdMs: song.createdMs || 0,
        _genres: new Map(),
        _years: new Map(),
      };
      albums.set(song.albumId, album);
    }
    album.songCount += 1;
    album.duration += song.duration || 0;
    if (!album.createdMs || (song.createdMs && song.createdMs < album.createdMs)) {
      album.createdMs = song.createdMs || album.createdMs;
    }
    if (song.genre) album._genres.set(song.genre, (album._genres.get(song.genre) || 0) + 1);
    if (song.year) album._years.set(song.year, (album._years.get(song.year) || 0) + 1);

    // ---- artist ----
    const artistId = hashId('artist', normalizeKey(song.artist));
    let artist = artists.get(artistId);
    if (!artist) {
      artist = {
        id: artistId,
        name: song.artist,
        albumCount: 0,
        songCount: 0,
        coverArt: '',
        createdMs: song.createdMs || 0,
        _albums: new Set(),
      };
      artists.set(artistId, artist);
    }
    artist.songCount += 1;
    artist._albums.add(song.albumId);
    if (!artist.coverArt) artist.coverArt = song.albumId;
    if (!artist.createdMs || (song.createdMs && song.createdMs < artist.createdMs)) {
      artist.createdMs = song.createdMs || artist.createdMs;
    }
  }

  for (const album of albums.values()) {
    album.duration = Math.round(album.duration * 1000) / 1000;
    let bestYear = 0;
    let bestCount = 0;
    for (const [year, count] of album._years) {
      if (count > bestCount) { bestYear = year; bestCount = count; }
    }
    album.year = bestYear;
    let bestGenre = '';
    let bestGenreCount = 0;
    for (const [genre, count] of album._genres) {
      if (count > bestGenreCount) { bestGenre = genre; bestGenreCount = count; }
    }
    album.genre = bestGenre;
    delete album._genres;
    delete album._years;
    album.created = isoDate(album.createdMs) || undefined;
  }

  for (const artist of artists.values()) {
    artist.albumCount = artist._albums.size;
    delete artist._albums;
    artist.created = isoDate(artist.createdMs) || undefined;
  }

  return {
    albums: Array.from(albums.values()).sort((a, b) => compareText(a.name, b.name)),
    artists: Array.from(artists.values()).sort((a, b) => compareText(a.name, b.name)),
  };
}

// ---------------------------------------------------------------------------
// Cache maintenance (Phase 2)
// ---------------------------------------------------------------------------

const STALE_TEMP_MS = 60 * 60 * 1000;

/**
 * Drop cover files whose album is gone, plus temp files left behind by an
 * interrupted write. Online thumbnails (`online-*.img`) belong to online.js and
 * are never touched here.
 */
async function pruneCoverFiles() {
  let entries;
  try {
    entries = await fs.promises.readdir(COVERS_DIR);
  } catch (_) {
    return 0;
  }

  const albumIds = new Set(
    (state && Array.isArray(state.albums) ? state.albums : []).map((album) => `${album.id}.jpg`)
  );
  const now = Date.now();
  let removed = 0;

  for (const name of entries) {
    const lower = name.toLowerCase();
    const isCover = lower.endsWith('.jpg');
    const isTemp = lower.endsWith('.tmp');
    if (!isCover && !isTemp) continue;
    if (isCover && albumIds.has(name)) continue;

    const full = path.join(COVERS_DIR, name);
    try {
      if (isTemp) {
        const stat = await fs.promises.stat(full);
        if (now - stat.mtimeMs < STALE_TEMP_MS) continue;
      }
      await fs.promises.unlink(full);
      removed += 1;
    } catch (_) {}
  }
  return removed;
}

/** Remove `mobile-*.json.<pid>.tmp` files left by a crash or a power cut. */
async function pruneStaleTempFiles() {
  let entries;
  try { entries = await fs.promises.readdir(DATA_DIR); } catch (_) { return 0; }
  const now = Date.now();
  let removed = 0;
  for (const name of entries) {
    if (!/^mobile-.*\.tmp$/i.test(name)) continue;
    const full = path.join(DATA_DIR, name);
    try {
      const stat = await fs.promises.stat(full);
      if (now - stat.mtimeMs <= STALE_TEMP_MS) continue;
      await fs.promises.unlink(full);
      removed += 1;
    } catch (_) {}
  }
  return removed;
}

async function doScan() {
  ensureLoaded();
  const folders = configuredFolders();
  scanCount = 0;

  if (!folders.length) {
    state = {
      version: LIBRARY_VERSION,
      generatedAt: Date.now(),
      folders: [],
      folderSignature: '',
      songs: [],
      albums: [],
      artists: [],
    };
    buildIndexes();
    writeStateToDisk(state);
    pruneCoverFiles().catch(() => {});
    return state;
  }

  const previousSongs = new Map();
  if (state && Array.isArray(state.songs)) {
    for (const song of state.songs) {
      if (song && typeof song.path === 'string') previousSongs.set(song.path.toLowerCase(), song);
    }
  }

  const files = await collectFiles(folders);
  scanCount = files.length;
  const rootFolders = new Set(folders.map((folder) => folder.toLowerCase()));

  const songs = await mapLimit(files, 4, async (file) => {
    let stat;
    try {
      stat = await fs.promises.stat(file);
    } catch (_) {
      return null;
    }
    if (!stat.isFile() || stat.size <= 0) return null;

    const previous = previousSongs.get(file.toLowerCase());
    if (previous && previous.size === stat.size && previous.mtimeMs === Math.round(stat.mtimeMs)) {
      return previous;
    }

    const probed = await probeFile(file);
    if (!probed) return fallbackSongFromStat(file, stat, previous, rootFolders);
    try {
      return songFromProbe(file, stat, probed, previous, rootFolders);
    } catch (_) {
      return fallbackSongFromStat(file, stat, previous, rootFolders);
    }
  });

  const cleanSongs = songs.filter(Boolean);
  const collections = buildCollections(cleanSongs);

  state = {
    version: LIBRARY_VERSION,
    generatedAt: Date.now(),
    folders: folders.slice(),
    folderSignature: folderSignature(folders),
    songs: cleanSongs,
    albums: collections.albums,
    artists: collections.artists,
  };

  buildIndexes();
  writeStateToDisk(state);
  pruneCoverFiles().catch(() => {});
  return state;
}

/**
 * Scan the configured folders. Concurrent calls share the same promise.
 * @returns {Promise<object>} the new snapshot
 */
function startScan() {
  if (scanning && scanPromise) return scanPromise;
  scanning = true;
  scanStartedAt = Date.now();
  scanError = '';

  scanPromise = doScan()
    .catch((err) => {
      scanError = (err && err.message) || String(err);
      console.error('[mobile] library scan failed:', scanError);
      return getSnapshot();
    })
    .finally(() => {
      scanning = false;
      scanFinishedAt = Date.now();
      scanPromise = null;
    });

  return scanPromise;
}

/**
 * Load the cache and start a background scan when the index is missing or the
 * folder list changed. Never blocks startup.
 */
function init() {
  ensureLoaded();
  pruneStaleTempFiles().catch(() => {});
  const folders = configuredFolders();
  const signature = folderSignature(folders);
  const stale = !state || !state.generatedAt || state.folderSignature !== signature;
  if (stale) {
    // Defer so requiring this module never spawns ffprobe during startup.
    setImmediate(() => startScan());
  }
}

function getScanStatus() {
  ensureLoaded();
  const folderList = configuredFolders();
  const songs = scanning ? scanCount : (state ? state.songs.length : 0);
  return {
    scanning,
    count: songs,
    songs,
    albums: state ? state.albums.length : 0,
    artists: state ? state.artists.length : 0,
    folderCount: folderList.length,
    folders: folderList,
    lastScan: scanFinishedAt ? isoDate(scanFinishedAt) : null,
    startedAt: scanning && scanStartedAt ? isoDate(scanStartedAt) : null,
    error: scanError || '',
  };
}

// ---------------------------------------------------------------------------
// Queries used by the Subsonic API
// ---------------------------------------------------------------------------

function getSong(id) {
  const idx = getIndexes();
  return idx.songById.get(String(id)) || online.getSong(id) || null;
}

function getAlbum(id) {
  const idx = getIndexes();
  return idx.albumById.get(String(id)) || online.getAlbum(id) || null;
}

function getArtist(id) {
  const idx = getIndexes();
  return idx.artistById.get(String(id)) || online.getArtist(id) || null;
}

function albumSongs(albumId) {
  const idx = getIndexes();
  return idx.songsByAlbum.get(String(albumId)) || online.albumSongs(albumId);
}

function artistAlbums(artistId) {
  const idx = getIndexes();
  return idx.albumsByArtist.get(String(artistId)) || online.artistAlbums(artistId);
}

// The local index is the source of browsing; online songs (Phase 4) are merged
// in on every read so the two never fight over the cached index file.
function allAlbums() {
  ensureLoaded();
  const local = state ? state.albums : [];
  const extra = online.albums();
  return extra.length ? local.concat(extra) : local;
}

function allArtists() {
  ensureLoaded();
  const local = state ? state.artists : [];
  const extra = online.artists();
  return extra.length ? local.concat(extra) : local;
}

function allSongs() {
  ensureLoaded();
  return state ? state.songs : [];
}

/**
 * Album list in the order required by `getAlbumList` / `getAlbumList2`.
 */
function listAlbums(type, options) {
  const opts = options || {};
  const size = clamp(toPositiveInt(opts.size, 10), 0, 500);
  const offset = toPositiveInt(opts.offset, 0);
  const kind = String(type || 'newest').toLowerCase();

  let albums = allAlbums().slice();

  switch (kind) {
    case 'alphabeticalbyname':
      albums.sort((a, b) => compareText(a.name, b.name));
      break;
    case 'alphabeticalbyartist':
      albums.sort((a, b) => compareText(a.artist, b.artist) || compareText(a.name, b.name));
      break;
    case 'newest':
    case 'recent':
      albums.sort((a, b) => (b.createdMs || 0) - (a.createdMs || 0));
      break;
    case 'random':
      for (let i = albums.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [albums[i], albums[j]] = [albums[j], albums[i]];
      }
      break;
    case 'starred':
    case 'frequent':
    case 'highest':
    case 'byyear':
    case 'bygenre':
      albums = [];
      break;
    default:
      albums.sort((a, b) => compareText(a.name, b.name));
  }

  return albums.slice(offset, offset + size);
}

function randomSongs(options) {
  const opts = options || {};
  const size = clamp(toPositiveInt(opts.size, 10), 0, 500);
  const fromYear = toPositiveInt(opts.fromYear, 0);
  const toYear = toPositiveInt(opts.toYear, 0);
  const genre = normalizeKey(opts.genre || '');

  let songs = allSongs().filter((song) => {
    if (genre && normalizeKey(song.genre) !== genre) return false;
    if (fromYear && (song.year || 0) < fromYear) return false;
    if (toYear && (song.year || 0) > toYear) return false;
    return true;
  });
  songs = songs.slice();
  for (let i = songs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [songs[i], songs[j]] = [songs[j], songs[i]];
  }
  return songs.slice(0, size);
}

function songsByGenre(genre, options) {
  const opts = options || {};
  const size = clamp(toPositiveInt(opts.size, 50), 0, 500);
  const offset = toPositiveInt(opts.offset, 0);
  const wanted = normalizeKey(genre || '');
  const songs = allSongs()
    .filter((song) => normalizeKey(song.genre) === wanted)
    .sort((a, b) => compareText(a.artist, b.artist) || compareText(a.album, b.album) || compareText(a.title, b.title));
  return songs.slice(offset, offset + size);
}

function genres() {
  const map = new Map();
  for (const song of allSongs()) {
    const genre = String(song.genre || '').trim();
    if (!genre) continue;
    if (!map.has(genre)) {
      map.set(genre, { value: genre, songCount: 0, albumIds: new Set() });
    }
    const entry = map.get(genre);
    entry.songCount += 1;
    entry.albumIds.add(song.albumId);
  }
  return Array.from(map.values())
    .map((entry) => ({
      value: entry.value,
      songCount: entry.songCount,
      albumCount: entry.albumIds.size,
    }))
    .sort((a, b) => compareText(a.value, b.value));
}

function searchArtists(query, limit, offset) {
  const q = normalizeKey(query);
  const idx = getIndexes();
  const list = allArtists().filter((artist) => {
    if (!q) return true;
    const name = idx.artistSearch.get(artist.id);
    return (name === undefined ? normalizeKey(artist.name) : name).includes(q);
  });
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

function searchAlbums(query, limit, offset) {
  const q = normalizeKey(query);
  const idx = getIndexes();
  const list = allAlbums().filter((album) => {
    if (!q) return true;
    const keys = idx.albumSearch.get(album.id);
    const name = keys ? keys[0] : normalizeKey(album.name);
    const artist = keys ? keys[1] : normalizeKey(album.artist);
    return name.includes(q) || artist.includes(q);
  });
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

function searchSongs(query, limit, offset) {
  const q = normalizeKey(query);
  const idx = getIndexes();
  const list = allSongs().filter((song) => {
    if (!q) return true;
    const keys = idx.songSearch.get(song.id);
    if (!keys) {
      return normalizeKey(song.title).includes(q)
        || normalizeKey(song.artist).includes(q)
        || normalizeKey(song.album).includes(q);
    }
    return keys[0].includes(q) || keys[1].includes(q) || keys[2].includes(q);
  });
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

function search(query, options) {
  const opts = options || {};
  const count = (value, fallback) => clamp(toPositiveInt(value, fallback), 0, 500);
  const offset = (value) => toPositiveInt(value, 0);
  return {
    artists: searchArtists(query, count(opts.artistCount, 20), offset(opts.artistOffset)),
    albums: searchAlbums(query, count(opts.albumCount, 20), offset(opts.albumOffset)),
    songs: searchSongs(query, count(opts.songCount, 20), offset(opts.songOffset)),
  };
}

// ---------------------------------------------------------------------------
// Streaming / downloads
// ---------------------------------------------------------------------------

/**
 * @returns {{path:string,mime:string,size:number,name:string}|null}
 */
function streamInfo(songId) {
  const song = getSong(songId);
  if (!song) return null;
  let stat;
  try { stat = fs.statSync(song.path); } catch (_) { return null; }
  if (!stat.isFile()) return null;
  return {
    path: song.path,
    mime: song.contentType || contentTypeFor(song.path),
    size: stat.size,
    name: path.basename(song.path),
    song,
  };
}

/**
 * Find an indexed song by its file path (used by the favourite-sync bridge).
 * Windows paths are case-insensitive, so both sides are normalised.
 */
function songIdByPath(filePath) {
  const wanted = normalizePathKey(filePath);
  if (!wanted) return '';
  return getIndexes().songIdByPath.get(wanted) || '';
}

function downloadName(songId) {
  const song = getSong(songId);
  if (!song) return 'song';
  const ext = song.suffix || path.extname(song.path).replace(/^\./, '') || 'bin';
  const safe = `${song.artist || 'Unknown'} - ${song.title || 'song'}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${safe || 'song'}.${ext}`;
}

// ---------------------------------------------------------------------------
// Cover art
// ---------------------------------------------------------------------------

function mimeForImage(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.png': return 'image/png';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.bmp': return 'image/bmp';
    default: return 'image/jpeg';
  }
}

function fallbackCover() {
  try {
    const stat = fs.statSync(FALLBACK_COVER);
    if (stat.isFile() && stat.size > 0) {
      return { path: FALLBACK_COVER, mime: 'image/png', size: stat.size };
    }
  } catch (_) {}
  return null;
}

function albumForCoverId(id) {
  const idx = getIndexes();
  const key = String(id || '');
  if (idx.albumById.has(key)) return idx.albumById.get(key);
  const song = idx.songById.get(key);
  if (song) return idx.albumById.get(song.albumId) || null;
  const artist = idx.artistById.get(key);
  if (artist && artist.coverArt) return idx.albumById.get(artist.coverArt) || null;
  return null;
}

async function findFolderCover(album) {
  const songs = albumSongs(album.id);
  const folders = new Set();
  for (const song of songs) folders.add(song.folder);
  for (const folder of folders) {
    let entries;
    try { entries = await fs.promises.readdir(folder); } catch (_) { continue; }
    const byLower = new Map(entries.map((name) => [name.toLowerCase(), name]));
    for (const candidate of COVER_NAMES) {
      const actual = byLower.get(candidate);
      if (!actual) continue;
      const full = path.join(folder, actual);
      try {
        const stat = await fs.promises.stat(full);
        if (stat.isFile() && stat.size > 0) {
          return { path: full, mime: mimeForImage(full), size: stat.size };
        }
      } catch (_) {}
    }
  }
  return null;
}

/**
 * Resolve cover art for an album / song / artist id.
 * Extracted art is cached as `mobile-covers/<albumId>.jpg`.
 */
function ensureCoverArt(id) {
  const album = albumForCoverId(id);
  if (!album) return Promise.resolve(fallbackCover());

  const key = album.id;
  if (coverPromises.has(key)) return coverPromises.get(key);

  const cachePath = path.join(COVERS_DIR, `${album.id}.jpg`);

  const promise = (async () => {
    try {
      const stat = await fs.promises.stat(cachePath);
      if (stat.isFile() && stat.size > 0) {
        return { path: cachePath, mime: 'image/jpeg', size: stat.size };
      }
    } catch (_) {}

    const folderCover = await findFolderCover(album);
    if (folderCover) return folderCover;

    const songs = albumSongs(album.id);
    for (const song of songs.slice(0, 3)) {
      const ok = await extractCover(song.path, cachePath);
      if (ok) {
        try {
          const stat = await fs.promises.stat(cachePath);
          if (stat.isFile() && stat.size > 0) {
            return { path: cachePath, mime: 'image/jpeg', size: stat.size };
          }
        } catch (_) {}
      }
    }
    return fallbackCover();
  })().finally(() => {
    coverPromises.delete(key);
  });

  coverPromises.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  LIBRARY_PATH,
  COVERS_DIR,
  AUDIO_TYPES,
  ensureLoaded,
  init,
  getSnapshot,
  getSong,
  getAlbum,
  getArtist,
  albumSongs,
  artistAlbums,
  allAlbums,
  allArtists,
  allSongs,
  listAlbums,
  randomSongs,
  songsByGenre,
  genres,
  search,
  startScan,
  getScanStatus,
  streamInfo,
  songIdByPath,
  downloadName,
  ensureCoverArt,
  pruneCoverFiles,
  configuredFolders,
  isoDate,
};
