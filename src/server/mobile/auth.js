'use strict';

/**
 * Authentication helpers for the LAN listener.
 *
 * Two independent mechanisms share this file:
 *  - Subsonic token auth (used by Navic):  t = md5(password + salt), s = salt,
 *    or legacy plain p=..., or p=enc:<hex>, or an OpenSubsonic apiKey.
 *  - Cookie sessions for the small /remote page.
 */

const crypto = require('crypto');
const config = require('./config');

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bufB = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Still consume a comparison so the timing does not reveal length.
    try { crypto.timingSafeEqual(bufA, bufA); } catch (_) {}
    return false;
  }
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_) {
    return false;
  }
}

function md5Hex(value) {
  return crypto.createHash('md5').update(String(value), 'utf8').digest('hex');
}

function decodeLegacyPassword(p) {
  if (typeof p !== 'string' || !p) return '';
  if (p.startsWith('enc:')) {
    const hex = p.slice(4);
    try {
      return Buffer.from(hex, 'hex').toString('utf8');
    } catch (_) {
      return '';
    }
  }
  return p;
}

/**
 * Verify the credentials carried by a Subsonic request.
 * @param {URLSearchParams} params
 * @returns {{ ok: boolean, reason?: string, user?: string }}
 */
function verifySubsonicAuth(params) {
  const cfg = config.get();
  const username = params.get('u') || '';
  const apiKey = params.get('apiKey') || '';

  if (apiKey) {
    if (timingSafeEqualStr(apiKey, cfg.apiKey)) return { ok: true, user: cfg.username };
    return { ok: false, reason: 'invalid api key' };
  }

  if (!username) return { ok: false, reason: 'missing username' };
  if (!timingSafeEqualStr(username, cfg.username)) return { ok: false, reason: 'wrong username or password' };

  const token = params.get('t');
  const salt = params.get('s');
  if (token) {
    if (!salt) return { ok: false, reason: 'missing salt' };
    const expected = md5Hex(cfg.password + salt);
    if (!timingSafeEqualStr(token.toLowerCase(), expected.toLowerCase())) {
      return { ok: false, reason: 'wrong username or password' };
    }
    return { ok: true, user: cfg.username };
  }

  const p = params.get('p');
  if (p !== null) {
    if (timingSafeEqualStr(decodeLegacyPassword(p), cfg.password)) {
      return { ok: true, user: cfg.username };
    }
    return { ok: false, reason: 'wrong username or password' };
  }

  return { ok: false, reason: 'missing credentials' };
}

// ---------------------------------------------------------------------------
// Failed-login throttling (per client IP)
// ---------------------------------------------------------------------------

const MAX_FAILURES = 12;
const WINDOW_MS = 60 * 1000;
const failures = new Map(); // ip -> { count, resetAt }

function clientIp(req) {
  const addr = (req && req.socket && req.socket.remoteAddress) || '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

function isRateLimited(ip) {
  const entry = failures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    failures.delete(ip);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = failures.get(ip);
  if (!entry || now > entry.resetAt) {
    failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function resetFailures(ip) {
  failures.delete(ip);
}

/**
 * Combined guard used by the Subsonic router.
 * @returns {{ ok: boolean, reason?: string, limited?: boolean }}
 */
function checkRequestAuth(req, params) {
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return { ok: false, limited: true, reason: 'too many failed attempts' };
  }
  const result = verifySubsonicAuth(params);
  if (!result.ok) {
    recordFailure(ip);
    return result;
  }
  resetFailures(ip);
  return result;
}

// ---------------------------------------------------------------------------
// Remote-page cookie sessions
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const sessions = new Map(); // token -> { csrf, createdAt, lastSeen, ip }

function createSession(ip) {
  const token = crypto.randomBytes(24).toString('base64url');
  const csrf = crypto.randomBytes(18).toString('base64url');
  sessions.set(token, {
    csrf,
    ip: ip || '',
    createdAt: Date.now(),
    lastSeen: Date.now(),
  });
  return { token, csrf };
}

function getSession(token, ip) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  const now = Date.now();
  if (now - session.lastSeen > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  // The remote page is only meant for the same LAN client, but allow a phone
  // changing address (e.g. DHCP renew) without forcing a re-login.
  session.lastSeen = now;
  if (ip) session.ip = ip;
  return session;
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function verifyRemotePassword(username, password) {
  const cfg = config.get();
  return timingSafeEqualStr(username, cfg.username) && timingSafeEqualStr(password, cfg.password);
}

module.exports = {
  verifySubsonicAuth,
  checkRequestAuth,
  verifyRemotePassword,
  decodeLegacyPassword,
  timingSafeEqualStr,
  md5Hex,
  clientIp,
  isRateLimited,
  recordFailure,
  resetFailures,
  createSession,
  getSession,
  destroySession,
  parseCookies,
  SESSION_TTL_MS,
};
