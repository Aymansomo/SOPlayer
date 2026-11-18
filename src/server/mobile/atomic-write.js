'use strict';

/**
 * Windows-safe atomic file replace for the `mobile-*.json` state files.
 *
 * `fs.renameSync` over an existing file fails with EBUSY/EPERM while another
 * process (antivirus, the search indexer, a backup or sync tool) holds the old
 * file open. Retry with short waits, then fall back to writing in place, which
 * still works when the handle only blocks delete/rename.
 */

const fs = require('fs');
const path = require('path');

const RETRY_DELAYS_MS = [10, 25, 50, 100, 150, 200, 250, 300, 400];

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
  }
}

/**
 * Write `payload` to `file`, replacing it as atomically as the platform allows.
 *
 * @param {string} file
 * @param {string|Buffer} payload
 * @param {BufferEncoding} [encoding]
 * @returns {Error|null} the last error, or null on success
 */
function writeFileAtomic(file, payload, encoding) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (_) {}

  const stamp = `${process.pid}.${Date.now().toString(36)}`;
  let lastError = null;

  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const tmp = `${file}.${stamp}.${attempt}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, encoding);
      fs.renameSync(tmp, file);
      return null;
    } catch (err) {
      lastError = err;
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (attempt < RETRY_DELAYS_MS.length - 1) sleepSync(RETRY_DELAYS_MS[attempt]);
    }
  }

  try {
    fs.writeFileSync(file, payload, encoding);
    return null;
  } catch (err) {
    return err || lastError;
  }
}

module.exports = { writeFileAtomic };
