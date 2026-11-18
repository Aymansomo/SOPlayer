'use strict';

/**
 * "Trending now" for the phone.
 *
 * The desktop app already builds this list from live YouTube Music searches —
 * the same data its own home screen shows. Instead of inventing a second
 * ranking, the phone server asks the desktop over loopback, adopts the tracks
 * into the online collection so they can be streamed, and keeps the last good
 * list around when the desktop is busy or offline.
 */

const online = require('./online');

const DEFAULT_PORT = 38472;
const TTL_MS = 30 * 60 * 1000;
const MAX_TRACKS = 24;

// Only the desktop app knows the real port, and only it has a feed to share;
// without it (a standalone server, the test suite) there is nothing to fetch.
let desktopPort = Number(process.env.RIFF_DESKTOP_PORT) > 0
  ? Number(process.env.RIFF_DESKTOP_PORT)
  : null;

let lastIds = [];
let lastFetchAt = 0;
let inflight = null;

function setDesktopPort(port) {
  const value = Number(port);
  if (Number.isFinite(value) && value > 0) desktopPort = value;
}

function normalizeTrack(track) {
  if (!track || !track.id) return null;
  const id = String(track.id).trim();
  if (!id) return null;
  return {
    remoteId: id,
    url: typeof track.url === 'string' && /^https?:/i.test(track.url) ? track.url : '',
    title: String(track.title || '').slice(0, 300),
    artist: String(track.artist || '').slice(0, 200),
    album: String(track.album || '').slice(0, 200),
    duration: Number(track.duration) || 0,
    thumbnail: typeof track.thumbnail === 'string' ? track.thumbnail : '',
  };
}

async function fetchFromDesktop(artists) {
  const seeds = (artists || []).filter(Boolean).slice(0, 3);
  const query = seeds.length ? `&artists=${encodeURIComponent(seeds.join(','))}` : '';
  const url = `http://127.0.0.1:${desktopPort}/api/trending?region=us${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return [];
    const json = await response.json();
    return Array.isArray(json && json.tracks) ? json.tracks : [];
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the desktop for a fresh trending list and remember the songs.
 *
 * @param {string[]} [artists] seeds from the phone's own listening history
 * @returns {Promise<string[]>} online song ids (possibly the previous list)
 */
async function refresh(artists) {
  if (!desktopPort) return lastIds;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const tracks = (await fetchFromDesktop(artists))
        .map(normalizeTrack)
        .filter(Boolean)
        .slice(0, MAX_TRACKS);
      if (!tracks.length) return lastIds;
      const stored = online.addCandidates('youtube', tracks, { pinned: true });
      lastIds = stored.map((track) => track.id);
      lastFetchAt = Date.now();
      return lastIds;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Song ids from the last successful fetch; empty until one succeeds. */
function currentIds() {
  return lastIds.slice();
}

function isStale() {
  return Date.now() - lastFetchAt > TTL_MS;
}

/** Forget fetched tracks (tests). */
function reset() {
  lastIds = [];
  lastFetchAt = 0;
  inflight = null;
}

module.exports = {
  DEFAULT_PORT,
  setDesktopPort,
  normalizeTrack,
  refresh,
  currentIds,
  isStale,
  reset,
};
