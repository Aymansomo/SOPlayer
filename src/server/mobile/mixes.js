'use strict';

/**
 * Daily Mixes and "For you" for the phone.
 *
 * These are recommendations, not a reshuffle of music the phone already has:
 * the desktop's own engine (`POST /api/vibe`, the one behind Riff's Daily
 * Mixes) is asked for songs that fit the listening taste, seeded by the artists
 * played and starred on either side. The tracks it returns are added to the
 * online collection so they stream like any other song, and the day's mixes are
 * remembered in `mobile-mixes.json` so they stay put until tomorrow.
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');
const { DATA_DIR } = require('../../shared/platform');
const online = require('./online');

const MIXES_PATH = path.join(DATA_DIR, 'mobile-mixes.json');
const VERSION = 1;
const MIX_SIZE = 16;
const MAX_DAILY = 4;
const MAX_SEED_ARTISTS = 28;
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_MS = 10 * 60 * 1000;
// Recommendation tracks are pinned so a day's mixes stay playable, but only for
// a few days: tomorrow's mixes must not keep yesterday's songs forever.
const PIN_MS = 3 * 24 * 60 * 60 * 1000;

let desktopPort = Number(process.env.RIFF_DESKTOP_PORT) > 0
  ? Number(process.env.RIFF_DESKTOP_PORT)
  : null;
// `/api/vibe` is token-protected; the main process hands the mobile server the
// same per-run token it gives the renderer.
let desktopToken = process.env.RIFF_DESKTOP_TOKEN || '';

let plan = emptyPlan();
let loaded = false;
let inflight = null;
let lastAttemptAt = 0;

function emptyPlan() {
  return { day: '', at: 0, forYou: null, mixes: [] };
}

function dayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function normalizeKey(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function setDesktopPort(port) {
  const value = Number(port);
  if (Number.isFinite(value) && value > 0) desktopPort = value;
}

function setDesktopToken(token) {
  if (typeof token === 'string' && token) desktopToken = token;
}

function loadPlan() {
  if (loaded) return plan;
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(MIXES_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Number(parsed.version) !== VERSION) return plan;
    plan = {
      day: typeof parsed.day === 'string' ? parsed.day : '',
      at: Number(parsed.at) || 0,
      forYou: sanitizeEntry(parsed.forYou),
      mixes: Array.isArray(parsed.mixes) ? parsed.mixes.map(sanitizeEntry).filter(Boolean) : [],
      desktopSignature: typeof parsed.desktopSignature === 'string' ? parsed.desktopSignature : '',
    };
  } catch (_) {
    // No saved mixes yet.
  }
  return plan;
}

function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = typeof entry.id === 'string' ? entry.id : '';
  if (!id) return null;
  return {
    id,
    name: String(entry.name || 'Mix').slice(0, 100),
    artists: Array.isArray(entry.artists) ? entry.artists.map(String).slice(0, 8) : [],
    songIds: Array.isArray(entry.songIds) ? entry.songIds.map(String).filter(Boolean) : [],
  };
}

function writePlan() {
  const payload = JSON.stringify({
    version: VERSION,
    day: plan.day,
    at: plan.at,
    forYou: plan.forYou,
    mixes: plan.mixes,
    desktopSignature: plan.desktopSignature,
  });
  const err = writeFileAtomic(MIXES_PATH, payload, 'utf8');
  if (err) console.warn('[mobile] could not save mixes:', err && err.message);
}

/** The saved plan, whether or not it is for today. */
function current() {
  return loadPlan();
}

function isStale() {
  const p = current();
  if (!p.at) return true;
  if (p.day !== dayKey()) return true;
  return !p.forYou && !(p.mixes && p.mixes.length);
}

function trackKey(track) {
  return normalizeKey(`${(track && track.artist) || ''} ${(track && track.title) || ''}`);
}

function seedFromSong(song) {
  return {
    artist: String((song && song.artist) || '').slice(0, 200),
    title: String((song && song.title) || '').slice(0, 300),
    id: '',
    duration: Number(song && song.duration) || 0,
    platform: 'youtube',
    weight: 1,
  };
}

/**
 * Group the artists of the taste rows into a "For you" list and up to four
 * Daily Mixes, the way the desktop plans its own mixes.
 */
function planBuckets(rows) {
  const artists = new Map();
  for (const row of rows || []) {
    const song = row && row.song;
    if (!song || !song.artist) continue;
    const key = normalizeKey(song.artist);
    if (!key) continue;
    const entry = artists.get(key) || { name: String(song.artist), weight: 0, songs: [] };
    entry.weight += Number(row.weight) || 1;
    entry.songs.push(song);
    artists.set(key, entry);
  }

  const ranked = [...artists.values()]
    .map((artist) => ({
      name: artist.name,
      weight: artist.weight,
      songs: artist.songs,
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_SEED_ARTISTS);

  if (!ranked.length) return { forYou: null, mixes: [] };

  const bucketCount = Math.min(MAX_DAILY, ranked.length);
  const buckets = Array.from({ length: bucketCount }, () => ({ artists: [], seeds: [] }));
  ranked.forEach((artist, rank) => {
    const bucket = buckets[rank % bucketCount];
    const key = normalizeKey(artist.name);
    if (!bucket.artists.some((name) => normalizeKey(name) === key)) bucket.artists.push(artist.name);
    for (const song of artist.songs.slice(0, 2)) {
      if (bucket.seeds.length >= 6) break;
      bucket.seeds.push(seedFromSong(song));
    }
  });

  const forYouSeeds = [];
  for (const artist of ranked.slice(0, 10)) {
    if (artist.songs[0]) forYouSeeds.push(seedFromSong(artist.songs[0]));
  }

  const forYou = forYouSeeds.length
    ? {
      id: 'smart_for_you',
      name: 'For you',
      artists: ranked.slice(0, 8).map((artist) => artist.name),
      seeds: forYouSeeds,
    }
    : null;

  const mixes = buckets
    .filter((bucket) => bucket.seeds.length)
    .map((bucket, index) => ({
      id: `smart_daily_${index + 1}`,
      name: `Daily Mix ${index + 1}`,
      artists: bucket.artists,
      seeds: bucket.seeds,
    }));

  return { forYou, mixes };
}

/** A recommendation as a candidate for the online collection. */
function normalizeTrack(track) {
  if (!track) return null;
  const remoteId = String(track.id || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(remoteId)) return null;
  const title = String(track.title || '').trim();
  if (!title) return null;
  const thumbnail = String(track.thumbnail || track.cover || '').trim();
  return {
    remoteId,
    url: `https://www.youtube.com/watch?v=${remoteId}`,
    title: title.slice(0, 300),
    artist: String(track.artist || 'Unknown Artist').slice(0, 200),
    album: String(track.album || '').slice(0, 200),
    duration: Number(track.duration) > 0 ? Number(track.duration) : 0,
    thumbnail: /^https?:/i.test(thumbnail)
      ? thumbnail
      : `https://i.ytimg.com/vi/${remoteId}/maxresdefault.jpg`,
  };
}

async function askDesktop(entry, rows) {
  if (!desktopPort) return [];
  const avoidKeys = [...new Set((rows || []).map((row) => trackKey(row && row.song)).filter(Boolean))];
  const durations = (rows || [])
    .map((row) => Number(row && row.song && row.song.duration) || 0)
    .filter((value) => value > 0);
  const body = JSON.stringify({
    platform: 'youtube',
    limit: MIX_SIZE,
    seeds: entry.seeds,
    avoid: { keys: avoidKeys, artists: [], ids: [] },
    clientProfile: {
      topArtists: entry.artists,
      avgDuration: durations.length
        ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
        : 210,
      dominantScript: 'Latin',
      trackCount: (rows || []).length,
    },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (desktopToken) headers['x-riff-token'] = desktopToken;
    const response = await fetch(`http://127.0.0.1:${desktopPort}/api/vibe`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const json = await response.json();
    return json && Array.isArray(json.tracks) ? json.tracks : [];
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMix(entry, rows, used) {
  const tracks = await askDesktop(entry, rows);
  const fresh = [];
  for (const track of tracks) {
    const candidate = normalizeTrack(track);
    if (!candidate) continue;
    const key = trackKey(candidate);
    if (!key || used.has(key)) continue;
    used.add(key);
    fresh.push(candidate);
  }
  if (fresh.length < 4) return null;
  const stored = online.addCandidates('youtube', fresh, { pinUntil: Date.now() + PIN_MS });
  if (stored.length < 4) return null;
  return {
    id: entry.id,
    name: entry.name,
    artists: entry.artists,
    songIds: stored.map((track) => track.id),
  };
}

/**
 * Ask the desktop for this day's mixes. Falls back to the saved plan when the
 * desktop is not reachable, so the phone never loses its mixes over a hiccup.
 *
 * @param {Array<{song: object, weight: number}>} rows taste rows
 * @param {{onDone?: Function}} [options]
 */
async function refresh(rows, options) {
  if (!desktopPort) return current();
  if (inflight) return inflight;
  const buckets = planBuckets(rows);
  if (!buckets.forYou && !buckets.mixes.length) return current();

  lastAttemptAt = Date.now();
  inflight = (async () => {
    try {
      const used = new Set();
      const result = { day: dayKey(), at: Date.now(), forYou: null, mixes: [] };
      const tasks = [];
      if (buckets.forYou) tasks.push({ entry: buckets.forYou, target: 'forYou' });
      for (const mix of buckets.mixes) tasks.push({ entry: mix, target: 'mix' });

      for (const task of tasks) {
        const entry = await fetchMix(task.entry, rows, used);
        if (!entry) continue;
        if (task.target === 'forYou') result.forYou = entry;
        else result.mixes.push(entry);
      }

      // Nothing came back (offline, desktop busy): keep yesterday's mixes.
      if (!result.forYou && !result.mixes.length) return current();

      plan = result;
      writePlan();
      return current();
    } catch (_) {
      return current();
    } finally {
      inflight = null;
      if (options && typeof options.onDone === 'function') {
        try { options.onDone(); } catch (_) {}
      }
    }
  })();
  return inflight;
}

/**
 * Adopt the Daily Mixes the PC generated (renderer `riff_daily_mixes`). The PC
 * is where most listening happens, so its own mixes are what the phone shows;
 * the tracks are added to the online collection and pinned like our own.
 *
 * @param {{day?:string, mixes?:Array<{name?:string,artists?:string[],tracks?:object[]}>}} payload
 * @returns {boolean} whether a same-day plan was stored (false when unchanged)
 */
function setDesktopMixes(payload) {
  if (!payload || !Array.isArray(payload.mixes) || !payload.mixes.length) return false;
  const day = String(payload.day || '');
  // A cached mix set from an older day is not what the PC shows now.
  if (day && day !== dayKey()) return false;

  // The renderer pushes this every 15 s; only re-adopt when the mixes changed.
  const signature = payload.mixes
    .map((mix) => (Array.isArray(mix && mix.tracks) ? mix.tracks : []).map((track) => String((track && track.id) || '')))
    .flat()
    .join(',');
  if (plan.day === (day || dayKey()) && plan.desktopSignature === signature) return false;

  const entries = [];
  for (const mix of payload.mixes) {
    const candidates = (Array.isArray(mix && mix.tracks) ? mix.tracks : [])
      .map(normalizeTrack)
      .filter(Boolean);
    if (candidates.length < 2) continue;
    const stored = online.addCandidates('youtube', candidates, { pinUntil: Date.now() + PIN_MS });
    if (stored.length < 2) continue;
    entries.push({
      id: `smart_daily_${entries.length + 1}`,
      name: String((mix && mix.name) || `Daily Mix ${entries.length + 1}`).slice(0, 100),
      artists: Array.isArray(mix && mix.artists) ? mix.artists.map(String).slice(0, 8) : [],
      songIds: stored.map((track) => track.id),
    });
  }
  if (!entries.length) return false;

  plan = {
    day: day || dayKey(),
    at: Date.now(),
    forYou: null,
    mixes: entries.slice(0, MAX_DAILY),
    desktopSignature: signature,
  };
  loaded = true;
  writePlan();
  return true;
}

/** Kill-and-forget warm-up used from the request path. */
function refreshInBackground(rows, onDone) {
  if (inflight) return;
  if (Date.now() - lastAttemptAt < RETRY_MS) return;
  refresh(rows, { onDone }).catch(() => {});
}

function playlistFromEntry(entry) {
  if (!entry) return null;
  const songs = (entry.songIds || [])
    .map((id) => online.getSong(id))
    .filter(Boolean);
  if (songs.length < 2) return null;
  return { id: entry.id, name: entry.name, artists: entry.artists, songs };
}

/** The saved mixes with their songs resolved, newest taste first. */
function currentPlaylists() {
  const p = current();
  const out = [];
  const forYou = playlistFromEntry(p.forYou);
  if (forYou) out.push(forYou);
  for (const mix of p.mixes || []) {
    const playlist = playlistFromEntry(mix);
    if (playlist) out.push(playlist);
  }
  return out;
}

/** Forget everything (tests). */
function reset() {
  plan = emptyPlan();
  loaded = true;
  inflight = null;
  lastAttemptAt = 0;
  try { fs.unlinkSync(MIXES_PATH); } catch (_) {}
}

module.exports = {
  MIXES_PATH,
  PIN_MS,
  dayKey,
  setDesktopPort,
  setDesktopToken,
  current,
  currentPlaylists,
  setDesktopMixes,
  isStale,
  planBuckets,
  normalizeTrack,
  refresh,
  refreshInBackground,
  reset,
};
