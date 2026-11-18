'use strict';

/**
 * Phase 2 — on-the-fly MP3 transcoding for the phone listener.
 *
 * Subsonic clients can ask for a specific `format` or cap the bitrate with
 * `maxBitRate`. A client that cannot decode FLAC (or an old phone on a weak
 * Wi-Fi link) gets a live MP3 stream from ffmpeg instead of a broken file.
 *
 * Transcoding is only used when it is actually needed:
 *  - `format=raw` never transcodes,
 *  - a format equal to the file's own suffix never transcodes,
 *  - `maxBitRate` only transcodes when the file is above it,
 *  - `download` is always the untouched original.
 */

const { spawn } = require('child_process');
const { resolveBinary } = require('../../shared/platform');

const MIN_KBPS = 32;
const MAX_KBPS = 320;
const DEFAULT_KBPS = 128;
const FORMAT_KBPS = 192;

function available() {
  return !!resolveBinary('ffmpeg');
}

function clampBitRate(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_KBPS;
  return Math.min(MAX_KBPS, Math.max(MIN_KBPS, n));
}

/**
 * Decide what a `stream` request needs.
 *
 * @param {object} song library/online song object
 * @param {URLSearchParams} params request parameters
 * @returns {{ transcode: boolean, bitRate?: number, timeOffset?: number, reason?: string }}
 */
function plan(song, params) {
  const requested = String((params && params.get('format')) || '').trim().toLowerCase();
  const suffix = String((song && song.suffix) || '').toLowerCase();
  const rawOffset = Number.parseInt((params && params.get('timeOffset')) || '0', 10);
  const timeOffset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  if (requested === 'raw') return { transcode: false };

  const maxBitRateRaw = Number.parseInt((params && params.get('maxBitRate')) || '', 10);
  const hasBitRateCap = Number.isFinite(maxBitRateRaw) && maxBitRateRaw > 0;

  // Nothing was asked for and the file can be sent as-is.
  const formatDiffers = !!requested && requested !== suffix;
  if (!formatDiffers && !hasBitRateCap && !timeOffset) return { transcode: false };

  if (!available()) {
    return { transcode: false, reason: 'ffmpeg not found' };
  }

  let bitRate = hasBitRateCap ? clampBitRate(maxBitRateRaw) : (formatDiffers ? FORMAT_KBPS : DEFAULT_KBPS);

  if (hasBitRateCap) {
    const known = Number(song && song.bitRate) || 0;
    // `bitRate` in the index is kbps and rounded down; only transcode when the
    // source is meaningfully above the cap.
    if (known && known <= bitRate + 8 && !formatDiffers && !timeOffset) {
      return { transcode: false, bitRate, timeOffset };
    }
  }

  return { transcode: true, bitRate, timeOffset };
}

function disposition(attachment, name) {
  const base = String(name || 'song.mp3');
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${attachment ? 'attachment' : 'inline'}; filename="${ascii}"; ` +
    `filename*=UTF-8''${encodeURIComponent(base)}`;
}

/**
 * Start ffmpeg and pipe MP3 to the response.
 *
 * `input` is either `{ path }` (a local file) or `{ readable }` (an upstream
 * stream, e.g. an online song). Returns false when ffmpeg cannot start so the
 * caller can fall back to the original bytes.
 *
 * @param {import('http').ServerResponse} res
 * @param {{path?:string, readable?:import('stream').Readable}} input
 * @param {{bitRate?:number, timeOffset?:number, name?:string, attachment?:boolean}} [options]
 */
function toMp3(res, input, options) {
  const opts = options || {};
  const bin = resolveBinary('ffmpeg');
  if (!bin || !input || (!input.path && !input.readable)) return false;

  const bitRate = clampBitRate(opts.bitRate);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (opts.timeOffset > 0) args.push('-ss', String(opts.timeOffset));
  if (input.path) args.push('-i', input.path);
  else args.push('-i', 'pipe:0');
  args.push(
    '-vn',
    '-map_metadata', '-1',
    '-c:a', 'libmp3lame',
    '-b:a', `${bitRate}k`,
    '-f', 'mp3',
    'pipe:1'
  );

  let proc;
  try {
    proc = spawn(bin, args, { windowsHide: true });
  } catch (_) {
    return false;
  }

  if (!res.headersSent) {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'none',
      'Cache-Control': 'no-store',
      'Content-Disposition': disposition(!!opts.attachment, opts.name || 'stream.mp3'),
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    });
  }

  proc.stdout.pipe(res);

  proc.on('error', () => {
    try { if (!res.writableEnded) res.end(); } catch (_) {}
  });
  proc.on('close', () => {
    try { if (!res.writableEnded) res.end(); } catch (_) {}
  });

  if (input.readable) {
    input.readable.on('error', () => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      try { if (!res.writableEnded) res.end(); } catch (_) {}
    });
    input.readable.pipe(proc.stdin);
  } else {
    proc.stdin.end();
  }

  proc.stdin.on('error', () => {
    // The client disappeared or ffmpeg exited early; nothing to recover.
    try { proc.kill('SIGKILL'); } catch (_) {}
  });

  res.on('close', () => {
    try { proc.kill('SIGKILL'); } catch (_) {}
  });

  return true;
}

module.exports = {
  MIN_KBPS,
  MAX_KBPS,
  available,
  clampBitRate,
  plan,
  toMp3,
};
