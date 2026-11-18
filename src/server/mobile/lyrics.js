'use strict';

/**
 * Lyrics for the phone.
 *
 * Riff already downloads lyrics to disk (LRCLIB / Genius, plus anything the
 * user pasted) while you listen on the PC. The files are named by a hash of
 * "artist\0title", so the phone server can serve the very same lyrics.
 *
 * When a song was never played on the PC there is no file yet: the server asks
 * the same provider chain the desktop uses (LRCLIB first) and saves the result
 * in the shared lyrics folder. That is what makes downloading a song on the
 * phone also bring its lyrics, instead of an empty player.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { writeFileAtomic } = require('./atomic-write');

const { LYRICS_DIR, CUSTOM_LYRICS_DIR } = require('../../shared/platform');

/** Same key the desktop uses in `getCustomLyricsPath` / `getFetchedLyricsPath`. */
function lyricsKey(title, artist) {
  return crypto
    .createHash('sha1')
    .update(`${String(artist || '').trim().toLowerCase()}\u0000${String(title || '').trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
}

function safeName(value, fallback) {
  return String(value || fallback)
    .replace(/[^\w\s-]/g, '_')
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/** Files worth trying, most specific first (same order as the desktop). */
function candidatePaths(title, artist) {
  const key = lyricsKey(title, artist);
  return [
    path.join(CUSTOM_LYRICS_DIR, `${key}.lrc`),
    path.join(LYRICS_DIR, `${key}_strict_v2_lrc.lrc`),
    path.join(LYRICS_DIR, `${key}_strict_v2_genius.lrc`),
    // Older custom lyrics used readable names.
    path.join(CUSTOM_LYRICS_DIR, `${safeName(artist, 'unknown')}_${safeName(title, 'untitled')}.lrc`),
  ];
}

const TIME_TAG = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/**
 * Parse LRC text into timed lines. Lines without a timestamp are kept as plain
 * lines so unsynced lyrics still show.
 *
 * @param {string} text
 * @returns {{synced: boolean, plain: string, lines: Array<{start:number,value:string}>}}
 */
function parseLrc(text) {
  const lines = [];
  let synced = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // LRC metadata: [ar:...], [ti:...], [length:...], [offset:...].
    if (/^\[[a-z#]+:[^\]]*\]$/i.test(line)) continue;

    const times = [];
    TIME_TAG.lastIndex = 0;
    let match;
    while ((match = TIME_TAG.exec(line)) !== null) {
      const minutes = Number(match[1]) || 0;
      const seconds = Number(match[2]) || 0;
      // [mm:ss], [mm:ss.xx] (centiseconds) and [mm:ss.xxx] (milliseconds).
      const fractionRaw = match[3] || '';
      const fractionMs = fractionRaw
        ? Number(fractionRaw) * (fractionRaw.length === 3 ? 1 : fractionRaw.length === 2 ? 10 : 100)
        : 0;
      times.push(Math.round(minutes * 60000 + seconds * 1000 + fractionMs));
    }

    const value = line.replace(TIME_TAG, '').trim();
    if (!times.length) {
      // Metadata tags like [ar:...] carry no text and are skipped.
      if (value) lines.push({ start: 0, value });
      continue;
    }
    synced = true;
    for (const start of times) {
      if (value) lines.push({ start, value });
    }
  }

  lines.sort((a, b) => a.start - b.start);
  return {
    synced,
    plain: lines.map((line) => line.value).join('\n'),
    lines,
  };
}

/**
 * Lyrics for a song, from the files the desktop already saved.
 *
 * @param {{title?:string, artist?:string}} song
 * @returns {{synced:boolean, plain:string, lines:Array<{start:number,value:string}>}|null}
 */
function findLyrics(song) {
  if (!song || !song.title) return null;
  for (const file of candidatePaths(song.title, song.artist)) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    const parsed = parseLrc(text);
    if (parsed.lines.length) return parsed;
  }
  return null;
}

const REMOTE_RETRY_MS = 60 * 60 * 1000;
const failedFetches = new Map(); // key -> when the lookup failed

function remoteLyricsFile(song) {
  // Same slot the desktop fills for "strict" LRCLIB lyrics.
  return candidatePaths(song.title, song.artist)[1];
}

async function fetchRemoteLyrics(song) {
  const key = lyricsKey(song.title, song.artist);
  const failedAt = failedFetches.get(key);
  if (failedAt && Date.now() - failedAt < REMOTE_RETRY_MS) return '';

  let text = '';
  try {
    // Reuse the desktop's provider chain (LRCLIB + its matchers) instead of
    // teaching the phone server a second lyrics source.
    const desktop = require('../server');
    const result = await desktop.fetchLyricsDirect(song.title, song.artist);
    text = typeof result === 'string' ? result.trim() : '';
  } catch (_) {
    text = '';
  }

  if (!text) {
    if (failedFetches.size > 500) failedFetches.clear();
    failedFetches.set(key, Date.now());
    return '';
  }

  try {
    const file = remoteLyricsFile(song);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, text, 'utf8');
  } catch (err) {
    console.warn('[mobile] could not save lyrics:', err && err.message);
  }
  return text;
}

/**
 * Lyrics for a song, downloading them when the PC never had a reason to.
 *
 * @param {{title?:string, artist?:string}} song
 * @returns {Promise<object|null>} parsed lyrics
 */
async function ensureLyrics(song) {
  const found = findLyrics(song);
  if (found) return found;
  if (!song || !song.title) return null;
  const text = await fetchRemoteLyrics(song);
  if (!text) return null;
  const parsed = parseLrc(text);
  return parsed.lines.length ? parsed : null;
}

module.exports = {
  lyricsKey,
  parseLrc,
  findLyrics,
  ensureLyrics,
  candidatePaths,
};
