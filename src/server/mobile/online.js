'use strict';

/**
 * Phase 4 — online songs for the phone / Subsonic listener.
 *
 * The PC resolves YouTube and SoundCloud tracks with yt-dlp and exposes them
 * through the same Subsonic API that already serves the local library:
 *
 *  - `search3` mixes local matches with online matches found by yt-dlp.
 *  - Every match is remembered in `mobile-online.json`, so online songs stay
 *    browsable like the rest of the library: their real artist and album (or
 *    "Singles" per artist and month when there is no album metadata) give
 *    artist and album pages, and they can be played or downloaded again later.
 *  - `stream` / `download` resolve the remote audio URL on the PC and relay the
 *    bytes (Range included) to the phone. Nothing is cached on disk.
 *
 * IDs are stable per provider + remote id, so a rescan/re-search never changes
 * them and Navic keeps its downloads/playlists working.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { writeFileAtomic } = require('./atomic-write');
const { spawn } = require('child_process');

const { DATA_DIR, resolveBinary } = require('../../shared/platform');
const config = require('./config');

const STATE_VERSION = 1;
const STATE_PATH = path.join(DATA_DIR, 'mobile-online.json');
const COVERS_DIR = path.join(DATA_DIR, 'mobile-covers');
const FALLBACK_COVER = path.join(__dirname, '../../../assets/cover-placeholder.png');

// Playlist entries adopted from the PC are pinned, so a few hundred of them must
// fit next to the songs found by search.
const MAX_TRACKS = 1000;
const MAX_SEARCH_LIMIT = 25;
const STREAM_TTL_MS = 3 * 60 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 15000;
const RESOLVE_TIMEOUT_MS = 20000;
const REMOTE_TIMEOUT_MS = 25000;
// Ranged chunks: googlevideo throttles one long connection to a few tens of
// kB/s, while 1 MiB ranges reach 0.5-1.2 MB/s.
const RANGED_CHUNK_BYTES = 1024 * 1024;
const RANGED_CONCURRENCY = 3;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * `format` is the preferred quality: the original m4a/webm audio for YouTube,
 * the progressive 128 kbps MP3 for SoundCloud. `fallbackFormat` is only tried
 * when the preferred selector fails (the "best audio, MP3 fallback" rule).
 */
const PROVIDERS = {
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    album: 'YouTube',
    prefix: 'ytsearch',
    defaultSuffix: 'm4a',
    defaultContentType: 'audio/mp4',
    format: 'ba[ext=m4a]/ba[ext=webm]/ba[ext=mp3]/18/best',
    fallbackFormat: 'ba[ext=mp3]/wa[ext=mp3]/18/best',
    fallbackExtractorArgs: 'youtube:player_client=default,android_vr',
  },
  soundcloud: {
    id: 'soundcloud',
    name: 'SoundCloud',
    album: 'SoundCloud',
    prefix: 'scsearch',
    defaultSuffix: 'mp3',
    defaultContentType: 'audio/mpeg',
    format: 'http_mp3_128/bestaudio[ext=mp3][protocol^=http]/bestaudio/best',
    fallbackFormat: 'bestaudio[ext=mp3]/bestaudio/best',
    fallbackExtractorArgs: '',
  },
};

const PROVIDER_ORDER = ['youtube', 'soundcloud'];

const MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

// ---------------------------------------------------------------------------
// Small helpers (kept in sync with library.js conventions)
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

function compareText(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function isoDate(ms) {
  if (!ms) return null;
  try {
    return new Date(ms).toISOString();
  } catch (_) {
    return null;
  }
}

function artistKeyFor(track) {
  return normalizeKey((track && track.artist) || '') || 'unknown artist';
}

/** Stable artist id, so a real artist page keeps working across searches. */
function artistIdFor(track) {
  return hashId('artist', `online\n${artistKeyFor(track)}`);
}

function albumNameFor(track) {
  const name = String((track && track.album) || '').trim();
  if (name) return name;
  const provider = PROVIDERS[track && track.provider] || PROVIDERS.youtube;
  return provider.id === 'soundcloud' ? 'SoundCloud' : 'Singles';
}

/**
 * Album identity. A real album name groups its songs (all of "Currents" under
 * one album, by Tame Impala); tracks without album metadata fall into that
 * artist's "Singles" instead of piling into one giant fake album.
 */
function albumIdForTrack(track) {
  return hashId('album', `online\n${artistKeyFor(track)}\n${normalizeKey(albumNameFor(track))}`);
}

function songIdFor(providerId, remoteId) {
  return hashId('song', `${providerId}\n${remoteId}`);
}

/** "Artist - Topic" is YouTube's auto-generated channel suffix. */
function cleanArtistName(value) {
  const name = String(value == null ? '' : value).trim();
  return name.replace(/\s*-\s*Topic$/i, '').trim();
}

/**
 * Split a title that already contains the artist, e.g.
 * "Daft Punk - One More Time" or "Daft Punk – One More Time (Official Video)".
 */
function splitTitleArtist(rawTitle) {
  const title = String(rawTitle == null ? '' : rawTitle).trim();
  const match = /^(.{1,80}?)\s+[-–—]\s+(.+)$/u.exec(title);
  if (!match) return { artist: '', title };
  const artist = match[1].trim();
  const rest = match[2].trim();
  if (!artist || !rest) return { artist: '', title };
  return { artist, title: rest };
}

// Upload noise the desktop app also strips, so online songs read the same in
// both places: "Let It Happen (Official Video)" -> "Let It Happen".
const TITLE_NOISE = /\s*[\(\[]\s*(?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visualizer)|lyrics?\s*video|lyrics?|visualizer|hd|hq|4k|remastered\s*\d*|mv|clip\s*officiel)\s*[\)\]]/gi;

function cleanTrackTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(TITLE_NOISE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Split "Artist - Title (Official Video)" the way the desktop app does and drop
 * upload-channel noise, so the phone shows a real artist instead of "YouTube".
 *
 * @param {string} rawTitle
 * @param {string} rawArtist
 * @returns {{title: string, artist: string}}
 */
function parseSmartArtistAndTitle(rawTitle, rawArtist) {
  let title = cleanTrackTitle(rawTitle);
  let artist = cleanArtistName(rawArtist || '');

  const split = splitTitleArtist(title);
  if (split.artist) {
    const key = normalizeKey(artist);
    const generic = !key || /unknown|various|records?|channels?|archive|vibes|lyrics?|topic|sounds?|audio|prod|beats|ost|music/.test(key);
    const sameArtist = !!key && key.includes(normalizeKey(split.artist));
    const artistInTitle = !!key && normalizeKey(split.title).includes(key);
    if (generic || sameArtist || !artistInTitle) {
      artist = split.artist;
      title = split.title;
    }
  }

  return { title: title || 'untitled', artist: artist || 'Unknown Artist' };
}

/** Highest quality thumbnail for an entry, never a 120px preview. */
function bestThumbnailUrl(providerId, entry, remoteId) {
  let url = '';
  let bestArea = -1;

  if (Array.isArray(entry.thumbnails)) {
    for (const thumb of entry.thumbnails) {
      const candidate = (thumb && (thumb.url || thumb.id)) || '';
      if (!candidate) continue;
      const area = (Number(thumb.width) || 0) * (Number(thumb.height) || 0);
      if (area > bestArea) {
        bestArea = area;
        url = candidate;
      }
    }
  }
  if (!url && typeof entry.thumbnail === 'string') url = entry.thumbnail;

  if (providerId === 'youtube') {
    if (!url) url = `https://i.ytimg.com/vi/${remoteId}/hqdefault.jpg`;
    // Flat playlist entries only carry the small preview variants.
    const ytimg = /^(https?:\/\/i\.ytimg\.com\/vi\/[^/]+)\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg/i.exec(url);
    if (ytimg) url = `${ytimg[1]}/maxresdefault.jpg`;
  }

  return url;
}

/** Same artwork at decreasing sizes, so a missing maxres still yields art. */
function thumbnailVariants(url) {
  const list = [url];
  const ytimg = /^(https?:\/\/i\.ytimg\.com\/vi\/[^/]+)\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg/i.exec(url);
  if (ytimg) {
    for (const name of ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault']) {
      const candidate = `${ytimg[1]}/${name}.jpg`;
      if (!list.includes(candidate)) list.push(candidate);
    }
  }
  return list;
}

/** Very small token-overlap score used to rank search hits and fallbacks. */
function relevance(query, text) {
  const tokens = normalizeKey(query).split(/[^a-z0-9\u0600-\u06ff]+/u).filter((t) => t.length > 1);
  const haystack = normalizeKey(text);
  if (!tokens.length || !haystack) return 0;
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / tokens.length;
}

function guessExtFromUrl(url) {
  try {
    const parsed = new URL(url);
    const mime = parsed.searchParams.get('mime') || '';
    if (/webm/i.test(mime)) return 'webm';
    if (/mp4|m4a/i.test(mime)) return 'm4a';
    if (/mpeg|mp3/i.test(mime)) return 'mp3';
    const ext = path.extname(parsed.pathname).replace(/^\./, '').toLowerCase();
    if (MIME_BY_EXT[ext]) return ext;
  } catch (_) {}
  return '';
}

function describeStream(streamUrl, provider) {
  const ext = guessExtFromUrl(streamUrl) || provider.defaultSuffix;
  return { ext, contentType: MIME_BY_EXT[ext] || provider.defaultContentType };
}

function safeFileBase(artist, title) {
  return `${artist || 'Unknown'} - ${title || 'song'}`
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'song';
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {{version:number,updatedAt:number,tracks:object[]}|null} */
let state = null;
let loaded = false;
let byId = null;
const streamCache = new Map(); // trackId -> { url, ext, contentType, provider, expiresAt }
const searchInflight = new Map(); // key -> promise
const coverInflight = new Map(); // id -> promise
const failures = new Map(); // provider -> { at, message }

function emptyState() {
  return { version: STATE_VERSION, updatedAt: 0, tracks: [] };
}

function sanitizeTrackForDisk(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const provider = PROVIDERS[raw.provider];
  if (!provider) return null;
  const remoteId = typeof raw.remoteId === 'string' ? raw.remoteId : '';
  if (!remoteId) return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : songIdFor(provider.id, remoteId);
  // Entries saved before titles/artwork were cleaned get upgraded on load, so
  // old "(Official Video)" rows and 120px preview art fix themselves.
  const smart = parseSmartArtistAndTitle(raw.title, raw.artist);
  let thumbnail = typeof raw.thumbnail === 'string' ? raw.thumbnail : '';
  if (provider.id === 'youtube') {
    thumbnail = thumbnail
      ? thumbnail.replace(/\/(default|mqdefault|hqdefault|sddefault)\.jpg/i, '/maxresdefault.jpg')
      : `https://i.ytimg.com/vi/${remoteId}/maxresdefault.jpg`;
  }
  return {
    id,
    provider: provider.id,
    remoteId,
    url: typeof raw.url === 'string' ? raw.url : '',
    title: String(smart.title || 'Unknown Title').slice(0, 300),
    artist: String(smart.artist || 'Unknown Artist').slice(0, 200),
    album: typeof raw.album === 'string' ? raw.album.trim().slice(0, 200) : '',
    duration: Number(raw.duration) > 0 ? Number(raw.duration) : 0,
    thumbnail,
    addedAt: Number(raw.addedAt) || Date.now(),
    lastSeenAt: Number(raw.lastSeenAt) || Number(raw.addedAt) || Date.now(),
    pinned: raw.pinned ? true : undefined,
    pinnedUntil: Number(raw.pinnedUntil) > Date.now() ? Number(raw.pinnedUntil) : undefined,
  };
}

function readStateFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (Number(parsed.version || 0) !== STATE_VERSION) return null;
    if (!Array.isArray(parsed.tracks)) return null;
    const tracks = [];
    const seen = new Set();
    for (const raw of parsed.tracks) {
      const track = sanitizeTrackForDisk(raw);
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      tracks.push(track);
    }
    return {
      version: STATE_VERSION,
      updatedAt: Number(parsed.updatedAt) || 0,
      tracks,
    };
  } catch (_) {
    return null;
  }
}

function writeStateToDisk() {
  if (!state) return;
  state.updatedAt = Date.now();
  const payload = JSON.stringify(state);
  const err = writeFileAtomic(STATE_PATH, payload, 'utf8');
  if (err) {
    console.warn('[mobile] could not save online songs:', err && err.message);
  }
}

function ensureLoaded() {
  if (loaded) return state;
  state = readStateFromDisk() || emptyState();
  loaded = true;
  buildIndex();
  return state;
}

function buildIndex() {
  const map = new Map();
  if (state) {
    for (const track of state.tracks) map.set(track.id, track);
  }
  byId = map;
}

function index() {
  ensureLoaded();
  if (!byId) buildIndex();
  return byId;
}

function findTrack(id) {
  return index().get(String(id || '')) || null;
}

function isEnabled() {
  const cfg = config.get();
  return cfg.onlineEnabled !== false;
}

function available() {
  return !!resolveBinary('yt-dlp');
}

// ---------------------------------------------------------------------------
// Mapping to Subsonic shapes
// ---------------------------------------------------------------------------

function songFromTrack(track) {
  const provider = PROVIDERS[track.provider] || PROVIDERS.youtube;
  const albumId = albumIdForTrack(track);
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    artistId: artistIdFor(track),
    albumArtist: track.artist,
    album: albumNameFor(track),
    albumId,
    genre: '',
    year: 0,
    track: 0,
    discNumber: 1,
    duration: track.duration || 0,
    bitRate: 0,
    sampleRate: 0,
    channels: 0,
    size: 0,
    suffix: provider.defaultSuffix,
    contentType: provider.defaultContentType,
    path: track.url || '',
    folder: `online://${provider.id}`,
    mtimeMs: track.lastSeenAt || 0,
    createdMs: track.addedAt || 0,
    // Songs share their album's artwork, so albums look right in every list.
    coverArt: albumId,
    parent: albumId,
    isDir: false,
    type: 'music',
    isVideo: false,
    online: true,
    provider: provider.id,
    remoteId: track.remoteId,
  };
}

function tracksForProvider(providerId) {
  ensureLoaded();
  return state.tracks.filter((track) => track.provider === providerId);
}

// Albums and artists are derived from the tracks themselves, like a normal
// library: a real album name groups its songs, and every artist gets a page.
let groupCache = { version: '', albums: null, artists: null };

function buildGroups() {
  ensureLoaded();
  const albumsById = new Map();
  for (const track of state.tracks) {
    const id = albumIdForTrack(track);
    const group = albumsById.get(id) || {
      id,
      name: albumNameFor(track),
      artist: track.artist,
      artistId: artistIdFor(track),
      provider: track.provider,
      tracks: [],
      coverArt: track.id,
      newest: 0,
    };
    group.tracks.push(track);
    group.newest = Math.max(group.newest, track.addedAt || 0);
    albumsById.set(id, group);
  }

  const artistsById = new Map();
  for (const album of albumsById.values()) {
    const artist = artistsById.get(album.artistId) || {
      id: album.artistId,
      name: album.artist,
      coverArt: album.coverArt,
      albums: [],
      newest: 0,
      songCount: 0,
    };
    artist.albums.push(album);
    artist.songCount += album.tracks.length;
    artist.newest = Math.max(artist.newest, album.newest);
    artistsById.set(album.artistId, artist);
  }

  return { albumsById, artistsById };
}

function groups() {
  ensureLoaded();
  const version = `${state.updatedAt}:${state.tracks.length}`;
  if (groupCache.version !== version || !groupCache.albums) {
    const built = buildGroups();
    groupCache = { version, albums: built.albumsById, artists: built.artistsById };
  }
  return groupCache;
}

function albumPayload(group) {
  let duration = 0;
  for (const track of group.tracks) duration += track.duration || 0;
  return {
    id: group.id,
    name: group.name,
    artist: group.artist,
    artistId: group.artistId,
    coverArt: group.coverArt,
    songCount: group.tracks.length,
    duration: Math.round(duration * 1000) / 1000,
    createdMs: group.newest,
    created: isoDate(group.newest) || undefined,
    year: 0,
    genre: '',
    isDir: true,
    online: true,
    provider: group.provider,
  };
}

function albums() {
  if (!isEnabled()) return [];
  return [...groups().albums.values()]
    .sort((a, b) => (b.newest || 0) - (a.newest || 0) || compareText(a.name, b.name))
    .map(albumPayload);
}

function artists() {
  if (!isEnabled()) return [];
  return [...groups().artists.values()]
    .sort((a, b) => compareText(a.name, b.name))
    .map((artist) => ({
      id: artist.id,
      name: artist.name,
      coverArt: artist.coverArt,
      albumCount: artist.albums.length,
      songCount: artist.songCount,
      createdMs: artist.newest,
      created: isoDate(artist.newest),
      online: true,
    }));
}

function newestTrack(tracks) {
  let best = null;
  for (const track of tracks) {
    if (!best || (track.addedAt || 0) > (best.addedAt || 0)) best = track;
  }
  return best;
}

function getSong(id) {
  if (!isEnabled()) return null;
  const track = findTrack(id);
  return track ? songFromTrack(track) : null;
}

function getAlbum(id) {
  if (!isEnabled()) return null;
  const group = groups().albums.get(String(id || ''));
  return group ? albumPayload(group) : null;
}

function getArtist(id) {
  if (!isEnabled()) return null;
  return artists().find((entry) => entry.id === String(id || '')) || null;
}

function albumSongs(albumId) {
  if (!isEnabled()) return [];
  const group = groups().albums.get(String(albumId || ''));
  if (!group) return [];
  return group.tracks
    .slice()
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .map(songFromTrack);
}

function artistAlbums(id) {
  if (!isEnabled()) return [];
  const artist = groups().artists.get(String(id || ''));
  if (!artist) return [];
  return artist.albums
    .slice()
    .sort((a, b) => (b.newest || 0) - (a.newest || 0))
    .map(albumPayload);
}

// ---------------------------------------------------------------------------
// Remembering search results (the browsable "Online" collection)
// ---------------------------------------------------------------------------

function coverPathFor(trackId) {
  // `-hq` marks the full-size artwork cache: older files held 120px previews.
  return path.join(COVERS_DIR, `online-${trackId}-hq.img`);
}

function prune() {
  ensureLoaded();
  pruneExpiredStreams();
  if (state.tracks.length <= MAX_TRACKS) return;
  const now = Date.now();
  // Pinned songs (playlists, trending) never go; mix recommendations are only
  // protected until their day is over.
  const held = (track) => (track.pinned || (track.pinnedUntil || 0) > now) ? 1 : 0;
  const keep = state.tracks
    .slice()
    .sort((a, b) => {
      const byPin = held(b) - held(a);
      return byPin || (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
    })
    .slice(0, MAX_TRACKS);
  const keepIds = new Set(keep.map((track) => track.id));
  for (const track of state.tracks) {
    if (keepIds.has(track.id)) continue;
    streamCache.delete(track.id);
    // Thumbnails of dropped songs have no owner any more.
    fs.promises.unlink(coverPathFor(track.id)).catch(() => {});
  }
  state.tracks = keep;
}

/** Keep the in-memory resolved-URL cache from growing without bound. */
function pruneExpiredStreams() {
  const now = Date.now();
  for (const [id, entry] of streamCache) {
    if (!entry || entry.expiresAt <= now) streamCache.delete(id);
  }
}

/**
 * Store candidates returned by a provider search. Existing songs are refreshed
 * instead of duplicated; the collection is capped so the file cannot grow
 * without bound.
 *
 * @param {string} providerId "youtube" | "soundcloud"
 * @param {Array<object>} candidates
 * @returns {object[]} stored tracks (in the order given)
 */
function addCandidates(providerId, candidates, options) {
  const provider = PROVIDERS[providerId];
  if (!provider || !Array.isArray(candidates) || !candidates.length) return [];
  // Pinned tracks belong to a playlist, so pruning must never drop them.
  const pinned = !!(options && options.pinned);
  const pinUntil = Number(options && options.pinUntil) || 0;
  ensureLoaded();
  const now = Date.now();
  const map = index();
  const stored = [];

  for (const candidate of candidates) {
    if (!candidate || !candidate.remoteId) continue;
    const id = songIdFor(provider.id, candidate.remoteId);
    const existing = map.get(id);
    if (existing) {
      if (candidate.title) existing.title = candidate.title;
      if (candidate.artist) existing.artist = candidate.artist;
      if (candidate.duration) existing.duration = candidate.duration;
      if (candidate.thumbnail) existing.thumbnail = candidate.thumbnail;
      if (candidate.url) existing.url = candidate.url;
      if (candidate.album) existing.album = candidate.album;
      if (pinned) existing.pinned = true;
      if (pinUntil > (existing.pinnedUntil || 0)) existing.pinnedUntil = pinUntil;
      existing.lastSeenAt = now;
      stored.push(existing);
      continue;
    }
    const track = {
      id,
      provider: provider.id,
      remoteId: String(candidate.remoteId),
      url: candidate.url || '',
      title: String(candidate.title || 'Unknown Title').slice(0, 300),
      artist: String(candidate.artist || 'Unknown Artist').slice(0, 200),
      album: String(candidate.album || '').slice(0, 200),
      duration: Number(candidate.duration) > 0 ? Number(candidate.duration) : 0,
      thumbnail: candidate.thumbnail || '',
      addedAt: now,
      lastSeenAt: now,
      pinned: pinned || undefined,
      pinnedUntil: pinUntil || undefined,
    };
    state.tracks.push(track);
    map.set(id, track);
    stored.push(track);
  }

  if (stored.length) {
    prune();
    writeStateToDisk();
  }
  return stored;
}

// ---------------------------------------------------------------------------
// yt-dlp
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

/**
 * Turn one yt-dlp entry into a provider-independent candidate.
 * Exported for tests.
 */
function candidateFromEntry(providerId, entry) {
  const provider = PROVIDERS[providerId];
  if (!provider || !entry || typeof entry !== 'object') return null;
  const remoteId = entry.id != null && String(entry.id).trim() ? String(entry.id).trim() : '';
  if (!remoteId) return null;

  const rawArtist = String(
    entry.artist ||
    (Array.isArray(entry.artists) ? entry.artists.join(', ') : '') ||
    entry.creator ||
    entry.channel ||
    entry.uploader ||
    ''
  ).trim();
  const rawTitle = String(entry.title || entry.track || entry.fulltitle || entry.name || '').trim();
  const smart = parseSmartArtistAndTitle(rawTitle, rawArtist);
  let artist = smart.artist;
  let title = smart.title;
  if (!title) title = remoteId;

  const url = providerId === 'soundcloud'
    ? String(entry.webpage_url || entry.url || entry.permalink_url || '')
    : `https://www.youtube.com/watch?v=${remoteId}`;

  const thumbnail = bestThumbnailUrl(providerId, entry, remoteId);

  const duration = Number(entry.duration);
  return {
    remoteId,
    url,
    title: title.trim(),
    artist: (artist || 'Unknown Artist').trim(),
    album: String(entry.album || entry.album_title || '').trim().slice(0, 200),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    thumbnail,
  };
}

// ---------------------------------------------------------------------------
// YouTube Music search (InnerTube)
// ---------------------------------------------------------------------------
//
// Plain `ytsearch` returns uploads: official videos with long intros, lyric
// videos and re-uploads. The desktop app searches YouTube Music instead and
// gets the released track, so the phone does the same: a WEB_REMIX InnerTube
// search with the "songs" filter, which also carries the real artist, the
// album and square artwork.

const YTM_SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';
const YTM_CLIENT_VERSION = '1.20250101.01.00';
const YTM_SONGS_PARAMS = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';
const YTM_TIMEOUT_MS = 9000;

function ytmDuration(text) {
  const value = String(text || '').trim();
  if (!/^\d+(:\d{1,2}){1,2}$/.test(value)) return 0;
  return value.split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0);
}

/** Square album art instead of YouTube Music's 60px preview. */
function ytmThumbnail(url) {
  return String(url || '').replace(/=w\d+-h\d+[^&]*$/, '=w544-h544');
}

/**
 * Pull song rows out of a YouTube Music search response.
 *
 * @param {object} json
 * @returns {Array<{id:string,title:string,artist:string,album:string,duration:number,thumbnail:string}>}
 */
function parseYtmSongs(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  const tabs = (json.contents && json.contents.tabbedSearchResultsRenderer &&
    json.contents.tabbedSearchResultsRenderer.tabs) || [];
  const first = tabs[0] && tabs[0].tabRenderer;
  const sections = (first && first.content && first.content.sectionListRenderer &&
    first.content.sectionListRenderer.contents) || [];

  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const rows = [];
    if (section.musicShelfRenderer && Array.isArray(section.musicShelfRenderer.contents)) {
      rows.push(...section.musicShelfRenderer.contents);
    }
    if (section.itemSectionRenderer && Array.isArray(section.itemSectionRenderer.contents)) {
      rows.push(...section.itemSectionRenderer.contents);
    }
    if (section.musicCardShelfRenderer && Array.isArray(section.musicCardShelfRenderer.contents)) {
      rows.push(...section.musicCardShelfRenderer.contents);
    }

    for (const row of rows) {
      const item = row && row.musicResponsiveListItemRenderer;
      if (!item) continue;
      const columns = item.flexColumns || [];
      const runsOf = (i) => {
        const column = columns[i] && columns[i].musicResponsiveListItemFlexColumnRenderer;
        return (column && column.text && column.text.runs) || [];
      };
      const overlay = item.overlay && item.overlay.musicItemThumbnailOverlayRenderer &&
        item.overlay.musicItemThumbnailOverlayRenderer.content &&
        item.overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer;
      const watch = overlay && overlay.playNavigationEndpoint && overlay.playNavigationEndpoint.watchEndpoint;
      const id = (item.playlistItemData && item.playlistItemData.videoId) ||
        (watch && watch.videoId) || '';
      if (!/^[\w-]{11}$/.test(id)) continue;

      const title = runsOf(0).map((run) => run.text).join('').trim();

      // Second column: "Artist • Album • 3:22" (a single "song" tag is noise).
      const segments = [];
      let current = '';
      for (const run of runsOf(1)) {
        if (run.text === ' • ') {
          segments.push(current.trim());
          current = '';
        } else {
          current += run.text;
        }
      }
      segments.push(current.trim());

      const parts = segments.filter((part) => part && !/^(song|video)$/i.test(part));
      let duration = 0;
      if (parts.length && ytmDuration(parts[parts.length - 1])) {
        duration = ytmDuration(parts.pop());
      }
      const artist = String(parts[0] || '').replace(/\s*-\s*Topic$/i, '').trim();
      const album = parts[1] || '';

      const thumbs = (item.thumbnail && item.thumbnail.musicThumbnailRenderer &&
        item.thumbnail.musicThumbnailRenderer.thumbnail &&
        item.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails) || [];
      const thumbnail = ytmThumbnail(thumbs.length
        ? thumbs[thumbs.length - 1].url
        : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);

      if (!title || (duration && duration < 30)) continue;
      out.push({ id, title, artist: artist || 'Unknown Artist', album, duration, thumbnail });
    }
  }
  return out;
}

async function fetchYtmSearch(query, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || YTM_TIMEOUT_MS);
  try {
    const response = await fetch(YTM_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://music.youtube.com',
        'Referer': 'https://music.youtube.com/',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'WEB_REMIX',
            clientVersion: YTM_CLIENT_VERSION,
            hl: 'en',
            gl: 'US',
          },
        },
        query,
        params: YTM_SONGS_PARAMS,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * YouTube Music hits as provider candidates (empty when the API is unreachable,
 * so the caller can fall back to a yt-dlp search).
 *
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array<object>>}
 */
async function searchYoutubeMusic(query, limit) {
  const json = await fetchYtmSearch(query);
  if (!json) return [];
  return parseYtmSongs(json)
    .slice(0, limit)
    .map((song) => ({
      remoteId: song.id,
      url: `https://www.youtube.com/watch?v=${song.id}`,
      title: song.title,
      artist: song.artist,
      album: song.album,
      duration: song.duration,
      thumbnail: song.thumbnail,
    }));
}

async function searchProvider(providerId, query, limit) {
  if (!available()) return [];
  const provider = PROVIDERS[providerId];
  if (!provider) return [];
  const bin = resolveBinary('yt-dlp');
  if (!bin) return [];

  const key = `${providerId}\n${normalizeKey(query)}\n${limit}`;
  if (searchInflight.has(key)) return searchInflight.get(key);

  const promise = (async () => {
    // The released track first (desktop parity); yt-dlp remains the fallback
    // for when YouTube Music rejects or rate-limits the request.
    if (providerId === 'youtube') {
      const musicHits = await searchYoutubeMusic(query, limit).catch(() => []);
      if (musicHits.length) {
        failures.delete(providerId);
        return musicHits;
      }
    }

    const args = [
      '--no-config',
      '--flat-playlist',
      '--ignore-errors',
      '--no-warnings',
      '--no-check-certificates',
      '--socket-timeout', '8',
      '--retries', '1',
      '-J',
      `${provider.prefix}${limit}:${query}`,
    ];
    const result = await runProcess(bin, args, SEARCH_TIMEOUT_MS);
    if (!result || !result.stdout) {
      if (result && result.stderr) {
        failures.set(providerId, { at: Date.now(), message: String(result.stderr).slice(0, 200) });
      }
      return [];
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (_) {
      return [];
    }
    const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
    const candidates = [];
    for (const entry of entries) {
      const candidate = candidateFromEntry(providerId, entry);
      if (candidate) candidates.push(candidate);
    }
    failures.delete(providerId);
    return candidates;
  })().finally(() => {
    searchInflight.delete(key);
  });

  searchInflight.set(key, promise);
  return promise;
}

function formatArgs(provider, streamUrl, { fallback }) {
  const args = [
    '--no-config',
    '-g',
    '--no-warnings',
    '--no-playlist',
    '--no-check-certificates',
    '--socket-timeout', '10',
    '--retries', '2',
    '-f', fallback ? provider.fallbackFormat : provider.format,
  ];
  if (fallback && provider.fallbackExtractorArgs) {
    args.push('--extractor-args', provider.fallbackExtractorArgs);
  } else if (!fallback && provider.id === 'youtube') {
    // Skip the default web client first: it is the most likely to be throttled.
    args.push('--extractor-args', 'youtube:player_client=default,android_vr');
  }
  args.push('--', streamUrl);
  return args;
}

async function resolveWithProvider(provider, streamUrl, options) {
  const opts = options || {};
  if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) return null;
  const bin = resolveBinary('yt-dlp');
  if (!bin) return null;

  const result = await runProcess(bin, formatArgs(provider, streamUrl, opts), RESOLVE_TIMEOUT_MS);
  if (!result || result.code !== 0 || !result.stdout) {
    if (result && result.stderr) {
      failures.set(provider.id, { at: Date.now(), message: String(result.stderr).slice(0, 200) });
    }
    return null;
  }
  const lines = String(result.stdout)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
  // SoundCloud can return DRM/preview fragments; never serve those.
  const url = lines.find((line) => !/preview|drm|cf-preview-media/i.test(line));
  if (!url) return null;
  const described = describeStream(url, provider);
  return {
    url,
    ext: described.ext,
    contentType: described.contentType,
    provider: provider.id,
    expiresAt: Date.now() + STREAM_TTL_MS,
  };
}

function scoreCandidateFor(track, candidate) {
  const wanted = `${track.title} ${track.artist}`;
  const found = `${candidate.title} ${candidate.artist}`;
  return relevance(wanted, found);
}

// Ids Riff gives to tracks from other catalogues (`sp_...` Spotify imports,
// Deezer, iTunes, ...). They are 11 characters too, but not video ids.
const IMPORTED_ID_PREFIX = /^(cand_|dz_|it_|sp_|ym_|alb_|local_|track_)/i;

function isYoutubeVideoId(value) {
  const id = String(value || '');
  return /^[\w-]{11}$/.test(id) && !IMPORTED_ID_PREFIX.test(id);
}

/** A watch URL for a YouTube track, also when only a bare video id was stored. */
function youtubeWatchUrl(track) {
  const url = String((track && track.url) || '');
  if (/^https?:\/\//i.test(url)) return url;
  const remoteId = String((track && track.remoteId) || '');
  return isYoutubeVideoId(remoteId) ? `https://www.youtube.com/watch?v=${remoteId}` : '';
}

/**
 * Playlists imported into Riff can carry ids that are not video ids (Spotify
 * `sp_...` imports) and no URL at all. Find the matching YouTube Music track.
 */
async function searchYoutubeWatchUrl(track) {
  const query = `${(track && track.artist) || ''} ${(track && track.title) || ''}`.trim();
  if (!query) return '';
  const hits = await searchProvider('youtube', query, 5).catch(() => []);
  let best = null;
  for (const candidate of hits) {
    const score = scoreCandidateFor(track, candidate);
    if (!best || score > best.score) best = { candidate, score };
  }
  return best && best.score >= 0.34 && best.candidate.url ? best.candidate.url : '';
}

/**
 * Resolve a playable remote URL for a stored track.
 * Tries the song's own provider, then the MP3 fallback selector, and finally
 * the other provider (same as the desktop player's fallback behaviour).
 *
 * @returns {Promise<{url:string,ext:string,contentType:string,provider:string,expiresAt:number}|null>}
 */
async function resolveStream(track, options) {
  const opts = options || {};
  if (!track) return null;

  if (!opts.force) {
    const cached = streamCache.get(track.id);
    if (cached && cached.expiresAt > Date.now()) return cached;
  } else {
    streamCache.delete(track.id);
  }

  const primary = PROVIDERS[track.provider] || PROVIDERS.youtube;
  let targetUrl = String(track.url || '');
  if (primary.id === 'youtube') {
    targetUrl = youtubeWatchUrl(track) || await searchYoutubeWatchUrl(track);
  }
  let resolved = targetUrl
    ? await resolveWithProvider(primary, targetUrl, { fallback: false })
    : null;
  if (!resolved && targetUrl) {
    resolved = await resolveWithProvider(primary, targetUrl, { fallback: true });
  }

  if (!resolved) {
    const otherId = PROVIDER_ORDER.find((id) => id !== primary.id);
    const other = PROVIDERS[otherId];
    const query = `${track.artist || ''} ${track.title || ''}`.trim();
    if (other && query) {
      const hits = await searchProvider(otherId, query, 5);
      const best = hits
        .map((candidate) => ({ candidate, score: scoreCandidateFor(track, candidate) }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score >= 0.34) {
        resolved = await resolveWithProvider(other, best.candidate.url, { fallback: false });
        if (!resolved) {
          resolved = await resolveWithProvider(other, best.candidate.url, { fallback: true });
        }
      }
    }
  }

  if (!resolved) return null;
  streamCache.set(track.id, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Search exposed to the Subsonic API
// ---------------------------------------------------------------------------

/**
 * Search both providers, remember the results and return Subsonic songs sorted
 * by how well they match the query.
 *
 * @param {string} query
 * @param {{limit?:number}} [options]
 * @returns {Promise<object[]>}
 */
async function searchSongs(query, options) {
  const opts = options || {};
  if (!isEnabled() || !available()) return [];
  const text = String(query || '').trim();
  if (text.length < 2) return [];

  const limit = clamp(toPositiveInt(opts.limit, 20), 1, MAX_SEARCH_LIMIT);
  const perProvider = clamp(limit, 1, 15);

  const results = await Promise.all(
    PROVIDER_ORDER.map((providerId) =>
      searchProvider(providerId, text, perProvider).catch(() => [])
    )
  );

  const tracks = [];
  for (let i = 0; i < PROVIDER_ORDER.length; i++) {
    const providerId = PROVIDER_ORDER[i];
    const stored = addCandidates(providerId, results[i]);
    for (const track of stored) tracks.push(track);
  }
  if (!tracks.length) return [];

  const ranked = tracks
    .map((track) => ({
      track,
      score: relevance(text, `${track.title} ${track.artist}`),
    }))
    .sort((a, b) => b.score - a.score);

  const out = [];
  const seen = new Set();
  for (const entry of ranked) {
    if (seen.has(entry.track.id)) continue;
    seen.add(entry.track.id);
    out.push(songFromTrack(entry.track));
    if (out.length >= limit) break;
  }
  return out;
}

function searchAlbums(query) {
  if (!isEnabled()) return [];
  const q = normalizeKey(query);
  return albums().filter((album) => {
    if (!q) return false;
    return normalizeKey(album.name).includes(q) || normalizeKey(album.artist).includes(q);
  });
}

function searchArtists(query) {
  if (!isEnabled()) return [];
  const q = normalizeKey(query);
  return artists().filter((artist) => {
    if (!q) return false;
    return normalizeKey(artist.name).includes(q);
  });
}

// ---------------------------------------------------------------------------
// Cover art (remote thumbnails, cached on disk)
// ---------------------------------------------------------------------------

function thumbnailFor(id) {
  const key = String(id || '');
  const track = findTrack(key);
  if (track) return track.thumbnail || '';
  // Album ids borrow the artwork of their most recent song.
  const group = groups().albums.get(key);
  if (group) {
    const newest = newestTrack(group.tracks);
    return newest ? newest.thumbnail || '' : '';
  }
  // Artist ids borrow the artwork of one of their albums, otherwise every
  // online artist fell through to the app icon placeholder.
  const artist = groups().artists.get(key);
  if (artist) {
    for (const album of artist.albums) {
      const newest = newestTrack(album.tracks);
      if (newest && newest.thumbnail) return newest.thumbnail;
    }
  }
  return '';
}

async function fetchImage(url, target) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'image/*' },
    });
    if (!response.ok) return null;
    const type = String(response.headers.get('content-type') || '');
    if (type && !/^image\//i.test(type)) return null;
    if (!type && !/\.(jpe?g|png|webp)(\?|$)/i.test(url)) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > 8 * 1024 * 1024) return null;
    const writeErr = writeFileAtomic(target, buffer);
    if (writeErr) return null;
    return { path: target, mime: type || 'image/jpeg', size: buffer.length };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cover for an online song id or online album id. Returns null when the id does
 * not belong to the online collection so the caller can fall back.
 */
function ensureCoverArt(id) {
  if (!isEnabled()) return Promise.resolve(null);
  const key = String(id || '');
  const thumbnail = thumbnailFor(key);
  if (!thumbnail) return Promise.resolve(null);

  // Thumbnails arrive as jpeg or webp; keep the raw bytes and report the mime
  // from the response, so the file extension carries no meaning.
  const cachePath = coverPathFor(key);
  try {
    const stat = fs.statSync(cachePath);
    if (stat.isFile() && stat.size > 0) {
      return Promise.resolve({ path: cachePath, mime: 'image/jpeg', size: stat.size });
    }
  } catch (_) {}

  if (coverInflight.has(key)) return coverInflight.get(key);
  const promise = (async () => {
    for (const candidate of thumbnailVariants(thumbnail)) {
      const art = await fetchImage(candidate, cachePath).catch(() => null);
      if (art) return art;
    }
    return fallbackCover();
  })().finally(() => { coverInflight.delete(key); });
  coverInflight.set(key, promise);
  return promise;
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

// ---------------------------------------------------------------------------
// Streaming relay
// ---------------------------------------------------------------------------

function relayHeaders(response, contentType, extra) {
  const headers = Object.assign({
    'Content-Type': contentType,
    'Accept-Ranges': response.headers.get('accept-ranges') || 'bytes',
    'Cache-Control': 'private, max-age=3600',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  }, extra || {});
  const length = response.headers.get('content-length');
  if (length) headers['Content-Length'] = length;
  const range = response.headers.get('content-range');
  if (range) headers['Content-Range'] = range;
  return headers;
}

function contentDisposition(attachment, filename) {
  const ascii = String(filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; ` +
    `filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Resolve an online song and open the upstream response (retrying once when a
 * cached URL expired). Returns null when the song cannot be played.
 *
 * `options.full` skips Range forwarding so the caller can transcode the whole
 * track; `options.head` asks the CDN for headers only.
 *
 * @returns {Promise<{response:Response,track:object,resolved:object}|null>}
 */
async function openUpstream(id, options) {
  const opts = options || {};
  if (!isEnabled() || !available()) return null;
  const track = findTrack(id);
  if (!track) return null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const resolved = await resolveStream(track, { force: attempt > 0 }).catch(() => null);
    if (!resolved) continue;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    const headers = { 'User-Agent': USER_AGENT, 'Accept': '*/*' };
    if (!opts.full && opts.range) headers.Range = opts.range;
    if (!opts.full && opts.ifRange) headers['If-Range'] = opts.ifRange;

    let response;
    try {
      response = await fetch(resolved.url, {
        method: opts.head ? 'HEAD' : 'GET',
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (_) {
      clearTimeout(timer);
      continue;
    }
    clearTimeout(timer);

    if (!response.ok) {
      // Drain so the socket can be reused, then try a fresh resolution.
      try { await response.arrayBuffer(); } catch (_) {}
      continue;
    }
    return { response, track, resolved };
  }
  return null;
}

async function relayResponse(req, res, opened, download) {
  const { response, resolved, track } = opened;
  const filename = `${safeFileBase(track.artist, track.title)}.${resolved.ext || 'mp3'}`;
  const extra = { 'Content-Disposition': contentDisposition(!!download, filename) };

  if (!res.headersSent) {
    res.writeHead(response.status, relayHeaders(response, resolved.contentType, extra));
  }

  if (req.method === 'HEAD' || !response.body) {
    res.end();
    return true;
  }

  // A single long CDN connection is throttled to a few tens of kB/s, so relay
  // ranged 1 MiB chunks instead; that is 15-30x faster for the same song.
  const ranged = rangedBody(opened);
  if (ranged && await pipeRangedResponse(ranged, res)) return true;

  const body = Readable.fromWeb(response.body);
  await new Promise((resolve) => {
    body.on('error', () => { try { res.destroy(); } catch (_) {} resolve(); });
    res.on('close', resolve);
    res.on('finish', resolve);
    body.pipe(res);
  });
  return true;
}

// ---------------------------------------------------------------------------
// Ranged relay
// ---------------------------------------------------------------------------

/** Byte span of an upstream response, when the CDN told us one. */
function upstreamBounds(response) {
  if (!response) return null;
  const range = response.headers.get('content-range');
  if (response.status === 206 && range) {
    const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(range);
    if (match && match[3] !== '*') {
      return { start: Number(match[1]), total: Number(match[3]) };
    }
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > 0) return { start: 0, total: length };
  return null;
}

async function fetchChunkBuffer(url, from, to) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Range': `bytes=${from}-${to}`,
      },
    });
    if (response.status !== 206 && response.status !== 200) {
      try { await response.arrayBuffer(); } catch (_) {}
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length ? buffer : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Yield the upstream bytes in ranged chunks.
 *
 * YouTube throttles one long connection hard, so ask for a few 1 MiB ranges at
 * a time and hand them out in order.
 */
async function* rangedChunks(url, start, total) {
  const pending = [];
  let next = start;

  const fill = () => {
    while (pending.length < RANGED_CONCURRENCY && next < total) {
      const from = next;
      const to = Math.min(from + RANGED_CHUNK_BYTES, total) - 1;
      next = to + 1;
      pending.push(fetchChunkBuffer(url, from, to));
    }
  };

  fill();
  while (pending.length) {
    const chunk = await pending.shift();
    if (!chunk) throw new Error('online stream chunk failed');
    fill();
    yield chunk;
  }
}

/**
 * Ranged body for an opened online stream, or null when the size is unknown.
 *
 * @param {{response?:Response,resolved?:object}} opened
 * @returns {import('stream').Readable|null}
 */
function rangedBody(opened) {
  if (!opened || !opened.response || !opened.resolved || !opened.resolved.url) return null;
  const bounds = upstreamBounds(opened.response);
  if (!bounds || bounds.total <= bounds.start) return null;
  return Readable.from(rangedChunks(opened.resolved.url, bounds.start, bounds.total));
}

/**
 * Write a ranged body to the response.
 *
 * @returns {Promise<boolean>} true when it was handled; false when the first
 *   chunk failed and the caller can still fall back to the original response.
 */
async function pipeRangedResponse(readable, res) {
  let wrote = false;
  try {
    for await (const chunk of readable) {
      wrote = true;
      if (res.destroyed || res.writableEnded) return true;
      if (!res.write(chunk)) {
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
        });
      }
    }
    if (!res.writableEnded) res.end();
    return true;
  } catch (_) {
    if (!wrote) return false;
    try { res.destroy(); } catch (_) {}
    return true;
  }
}

/**
 * Serve an online song over the LAN listener.
 *
 * @param {string} id Subsonic song id
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{download?:boolean}} [options]
 * @returns {Promise<boolean>} false when the id is not an online song
 */
async function streamTrack(id, req, res, options) {
  if (!isEnabled()) return false;
  const track = findTrack(id);
  if (!track) return false;
  const opts = options || {};

  if (!available()) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Online playback needs yt-dlp on the PC');
    return true;
  }

  const opened = await openUpstream(id, {
    head: req.method === 'HEAD',
    range: req.headers && req.headers.range,
    ifRange: req.headers && req.headers['if-range'],
  }).catch(() => null);

  if (opened && await relayResponse(req, res, opened, !!opts.download)) return true;

  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  try { res.end(); } catch (_) {}
  return true;
}

// ---------------------------------------------------------------------------
// Status (desktop settings + diagnostics)
// ---------------------------------------------------------------------------

function status() {
  const enabled = isEnabled();
  ensureLoaded();
  const items = enabled ? state.tracks : [];
  const perProvider = PROVIDER_ORDER.map((providerId) => ({
    id: providerId,
    name: PROVIDERS[providerId].name,
    tracks: items.filter((track) => track.provider === providerId).length,
  }));
  const lastFailure = PROVIDER_ORDER
    .map((providerId) => failures.get(providerId))
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)[0];
  return {
    enabled,
    available: available(),
    tracks: items.length,
    providers: perProvider,
    cachedStreams: streamCache.size,
    lastError: lastFailure ? lastFailure.message : '',
  };
}

module.exports = {
  STATE_PATH,
  MAX_TRACKS,
  PROVIDERS,
  available,
  isEnabled,
  status,
  albums,
  artists,
  albumSongs,
  artistAlbums,
  getSong,
  getAlbum,
  getArtist,
  searchSongs,
  searchAlbums,
  searchArtists,
  addCandidates,
  ensureCoverArt,
  streamTrack,
  rangedBody,
  openStream: openUpstream,
  resolveStream,
  // Exported for tests / reuse.
  songIdFor,
  albumIdForTrack,
  artistIdFor,
  splitTitleArtist,
  parseSmartArtistAndTitle,
  cleanTrackTitle,
  bestThumbnailUrl,
  candidateFromEntry,
  parseYtmSongs,
  searchYoutubeMusic,
  youtubeWatchUrl,
  thumbnailFor,
  relevance,
};
