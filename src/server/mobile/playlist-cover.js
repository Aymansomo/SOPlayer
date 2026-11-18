'use strict';

/**
 * Playlist covers.
 *
 * Subsonic gives a playlist exactly one cover id, and the desktop app shows a
 * playlist as a 2×2 mosaic of its first four songs. The phone does the same:
 * the server composes that mosaic once with ffmpeg and caches it, so every
 * Navic screen (playlist row, grid card, playlist header) shows it with no
 * client change.
 *
 * The cache key includes the playlist's `changedAt` and the artwork ids, so an
 * edited playlist gets a fresh mosaic and the old file is removed.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { DATA_DIR, resolveBinary } = require('../../shared/platform');
const collection = require('./collection');
const library = require('./library');
const online = require('./online');

const COVERS_DIR = path.join(DATA_DIR, 'mobile-covers');
const PREFIX = 'plcover_';
const TILE = 300;
const MOSAIC_TIMEOUT_MS = 20000;

function coverIdFor(playlistId) {
  return `${PREFIX}${playlistId}`;
}

function isPlaylistCoverId(id) {
  return String(id || '').startsWith(PREFIX);
}

function playlistIdForCover(id) {
  return String(id || '').slice(PREFIX.length);
}

/**
 * Artwork ids of the first four *different* covers in the playlist. Songs of
 * one album (or online tracks that share a thumbnail) would otherwise fill the
 * mosaic with the same picture several times.
 */
function artIdsFor(playlist) {
  const ids = [];
  const seen = new Set();
  for (const song of collection.playlistSummary(playlist).entry) {
    const artId = song.coverArt || song.albumId || song.id;
    if (!artId) continue;
    const key = song.online
      ? (online.thumbnailFor(song.id) || artId)
      : (song.albumId || artId);
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(artId);
    if (ids.length === 4) break;
  }
  return ids;
}

async function artFilesFor(ids) {
  const files = [];
  for (const id of ids) {
    const art = (await online.ensureCoverArt(id).catch(() => null)) ||
      (await library.ensureCoverArt(id).catch(() => null));
    if (art && art.path) files.push(art);
  }
  return files;
}

function fileSize(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 ? stat.size : 0;
  } catch (_) {
    return 0;
  }
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const bin = resolveBinary('ffmpeg');
    if (!bin) return resolve(false);
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (_) {
      return resolve(false);
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (child) child.kill(); } catch (_) {}
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), MOSAIC_TIMEOUT_MS);
    if (child.stderr) child.stderr.resume();
    if (child.stdout) child.stdout.resume();
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * 2×2 tile: each cover is scaled to fill its square, cropped, then stacked.
 * Two or three covers repeat to fill the grid, like the desktop card.
 */
async function buildMosaic(files, target) {
  const tiles = [0, 1, 2, 3].map((index) => files[index % files.length]);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const file of tiles) args.push('-i', file);
  const scale = (index) =>
    `[${index}:v]scale=${TILE}:${TILE}:force_original_aspect_ratio=increase,` +
    `crop=${TILE}:${TILE},setsar=1[t${index}]`;
  args.push(
    '-filter_complex',
    [
      scale(0), scale(1), scale(2), scale(3),
      '[t0][t1]hstack=inputs=2[top]',
      '[t2][t3]hstack=inputs=2[bottom]',
      '[top][bottom]vstack=inputs=2[out]',
    ].join(';'),
    '-map', '[out]',
    '-frames:v', '1',
    '-q:v', '4',
    target
  );

  try {
    fs.mkdirSync(COVERS_DIR, { recursive: true });
  } catch (_) {
    return null;
  }
  const ok = await runFfmpeg(args);
  const size = ok ? fileSize(target) : 0;
  if (!size) {
    try { fs.unlinkSync(target); } catch (_) {}
    return null;
  }
  return size;
}

/** Drop mosaics of earlier versions of this playlist. */
function removeSiblings(playlistId, keep) {
  const prefix = `playlist-${playlistId}-`;
  let names = [];
  try {
    names = fs.readdirSync(COVERS_DIR);
  } catch (_) {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || name === keep) continue;
    try { fs.unlinkSync(path.join(COVERS_DIR, name)); } catch (_) {}
  }
}

/**
 * Image for a `<prefix><playlist id>` cover id.
 *
 * @param {string} id
 * @returns {Promise<{path:string,mime:string,size:number}|null>}
 */
async function ensureCover(id) {
  if (!isPlaylistCoverId(id)) return null;
  const playlist = collection.getPlaylist(playlistIdForCover(id));
  if (!playlist) return null;

  const artIds = artIdsFor(playlist);
  if (!artIds.length) return null;

  const key = crypto.createHash('sha1')
    .update(JSON.stringify({ id: playlist.id, changedAt: playlist.changedAt, artIds }))
    .digest('hex')
    .slice(0, 16);
  const target = path.join(COVERS_DIR, `playlist-${playlist.id}-${key}.jpg`);

  const cachedSize = fileSize(target);
  if (cachedSize) return { path: target, mime: 'image/jpeg', size: cachedSize };

  const files = await artFilesFor(artIds);
  if (!files.length) return null;
  // One distinct cover needs no mosaic.
  if (files.length === 1) {
    return { path: files[0].path, mime: files[0].mime || 'image/jpeg', size: files[0].size };
  }

  const size = await buildMosaic(files.map((file) => file.path), target);
  if (!size) {
    // ffmpeg missing or the artwork unreadable: show the first cover.
    return { path: files[0].path, mime: files[0].mime || 'image/jpeg', size: files[0].size };
  }
  removeSiblings(playlist.id, path.basename(target));
  return { path: target, mime: 'image/jpeg', size };
}

module.exports = {
  coverIdFor,
  isPlaylistCoverId,
  playlistIdForCover,
  artIdsFor,
  ensureCover,
};
