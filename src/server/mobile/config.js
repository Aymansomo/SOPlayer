'use strict';

/**
 * Persistent configuration for the phone / Subsonic listener.
 *
 * The file lives next to the rest of Riff's data (metadata.json, library.json,
 * tracks/) so a data-dir move carries it along.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { DATA_DIR } = require('../../shared/platform');

const DEFAULT_PORT = 6767;
const DEFAULT_USERNAME = 'riff';
const DEFAULT_BIND_HOST = '0.0.0.0';

/**
 * Candidate folders used exactly once, when the config has never had a folder
 * list. The user's project keeps music in `Music_app/project/music`; a normal
 * Riff install may only have the managed `library/` folder.
 */
function defaultMusicFolders() {
  const candidates = [
    path.resolve(__dirname, '../../../../music'),
    path.resolve(DATA_DIR, '..', '..', 'project', 'music'),
    path.join(DATA_DIR, 'library'),
  ];
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    let stat;
    try { stat = fs.statSync(candidate); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path.resolve(candidate));
  }
  return out;
}

function configPath() {
  return path.join(DATA_DIR, 'mobile.json');
}

function generatePassword() {
  // 13 bytes -> 18 base64url characters, easy to type on a phone.
  return crypto.randomBytes(13).toString('base64url');
}

function generateApiKey() {
  return crypto.randomBytes(24).toString('hex');
}

function defaults() {
  return {
    enabled: false,
    port: DEFAULT_PORT,
    bindHost: DEFAULT_BIND_HOST,
    username: DEFAULT_USERNAME,
    password: generatePassword(),
    apiKey: generateApiKey(),
    // Music folders scanned for the phone library. This is the ONLY source of
    // songs; it is seeded once with `project/music` (or `library/`) and then
    // controlled by the user.
    folders: [],
    foldersSeeded: false,
    remoteEnabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

let cached = null;

function readFromDisk() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function sanitize(input, base) {
  const out = Object.assign({}, base);
  if (!input || typeof input !== 'object') return out;

  if (typeof input.enabled === 'boolean') out.enabled = input.enabled;

  const port = Number(input.port);
  if (Number.isFinite(port) && port >= 1024 && port <= 65535) out.port = Math.floor(port);

  if (typeof input.bindHost === 'string' && input.bindHost.trim()) {
    out.bindHost = input.bindHost.trim();
  }

  if (typeof input.username === 'string' && input.username.trim()) {
    out.username = input.username.trim().slice(0, 64);
  }

  if (typeof input.password === 'string' && input.password.length >= 4) {
    out.password = input.password;
  }

  if (typeof input.apiKey === 'string') out.apiKey = input.apiKey;

  if (Array.isArray(input.folders)) {
    const seen = new Set();
    out.folders = input.folders
      .map((f) => (typeof f === 'string' ? f.trim() : ''))
      .filter((f) => {
        if (!f) return false;
        const key = path.resolve(f).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  if (typeof input.foldersSeeded === 'boolean') out.foldersSeeded = input.foldersSeeded;

  if (typeof input.remoteEnabled === 'boolean') out.remoteEnabled = input.remoteEnabled;

  const createdAt = Number(input.createdAt);
  if (Number.isFinite(createdAt) && createdAt > 0) out.createdAt = createdAt;

  out.updatedAt = Date.now();
  return out;
}

function writeToDisk(cfg) {
  const file = configPath();
  const payload = JSON.stringify(cfg, null, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Atomic replace where possible. On Windows an antivirus or indexer can hold
  // the target for a few milliseconds, so retry before falling back.
  for (let attempt = 0; attempt < 5; attempt++) {
    const tmp = `${file}.${process.pid}.${attempt}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (attempt === 4) {
        try {
          fs.writeFileSync(file, payload, 'utf8');
          return true;
        } catch (writeErr) {
          console.warn('[mobile] could not write config:', writeErr.message);
          return false;
        }
      }
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      } catch (_) {}
    }
  }
  return false;
}

function load() {
  if (cached) return cached;
  const disk = readFromDisk();
  if (disk) {
    cached = sanitize(disk, defaults());
  } else {
    cached = defaults();
    writeToDisk(cached);
  }
  // Always make sure we have a usable password/api key, even if the file was
  // hand-edited or created by an older version.
  if (!cached.password) cached.password = generatePassword();
  if (!cached.apiKey) cached.apiKey = generateApiKey();

  // One-time folder seed. Existing configs (like the user's) already contain
  // the project music folder, so this mainly helps fresh installs.
  if (!cached.foldersSeeded) {
    if (!Array.isArray(cached.folders) || !cached.folders.length) {
      const seed = defaultMusicFolders();
      if (seed.length) cached.folders = seed;
    }
    cached.foldersSeeded = true;
    writeToDisk(cached);
  }
  return cached;
}

function get() {
  return Object.assign({}, load());
}

function update(patch) {
  const next = sanitize(patch, load());
  cached = next;
  writeToDisk(next);
  return Object.assign({}, next);
}

function regeneratePassword() {
  return update({ password: generatePassword() });
}

function setFolders(folders) {
  return update({ folders });
}

/**
 * Public-safe view: includes the credentials because the desktop UI needs to
 * show them to the user. Never send this over the LAN listener.
 */
function publicConfig() {
  const cfg = get();
  return {
    enabled: cfg.enabled,
    port: cfg.port,
    bindHost: cfg.bindHost,
    username: cfg.username,
    password: cfg.password,
    apiKey: cfg.apiKey,
    folders: cfg.folders.slice(),
    foldersSeeded: !!cfg.foldersSeeded,
    remoteEnabled: cfg.remoteEnabled,
    updatedAt: cfg.updatedAt,
    configPath: configPath(),
  };
}

/**
 * Candidate LAN URLs the phone can use. Skips loopback, link-local and
 * virtual adapters that cannot be reached from another device.
 */
function lanUrls(cfg) {
  const conf = cfg || get();
  const urls = [];
  const seen = new Set();
  const ifaces = os.networkInterfaces();
  const order = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!Array.isArray(addrs)) continue;
    for (const addr of addrs) {
      if (!addr || addr.family !== 'IPv4' || addr.internal) continue;
      if (!addr.address || addr.address.startsWith('169.254.')) continue;
      // VirtualBox/VMware host-only adapters are not reachable from the phone.
      if (/^192\.168\.56\./u.test(addr.address)) continue;
      const key = `${name}:${addr.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      order.push({ iface: name, address: addr.address });
    }
  }

  // Prefer Wi-Fi / Ethernet over VPN-ish adapters.
  order.sort((a, b) => {
    const score = (x) => (/wi-?fi|wlan|ethernet|eth/i.test(x.iface) ? 0 : 1);
    return score(a) - score(b);
  });

  for (const entry of order) {
    urls.push({
      iface: entry.iface,
      address: entry.address,
      url: `http://${entry.address}:${conf.port}`,
    });
  }

  return urls;
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_USERNAME,
  defaultMusicFolders,
  configPath,
  get,
  update,
  load,
  regeneratePassword,
  setFolders,
  publicConfig,
  lanUrls,
};
