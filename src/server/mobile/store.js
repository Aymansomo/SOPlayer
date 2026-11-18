'use strict';

/**
 * Tiny app store for the LAN listener: scans one folder for installers
 * (`.apk`, `.exe`, `.msi`, `.dmg`, `.AppImage`, `.deb`), groups them per app
 * and serves a phone-friendly page plus the files themselves.
 *
 * The point is the user's own apps (Navic, SOPlayer builds…), not a marketplace:
 * drop `Navic-1.9.0.apk` in the folder and it shows up with its other
 * versions. No accounts, no upload endpoint — everything is read-only.
 */

const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../shared/platform');
const config = require('./config');

const EXTENSIONS = new Map([
  ['.apk', { platform: 'Android', contentType: 'application/vnd.android.package-archive' }],
  ['.exe', { platform: 'Windows', contentType: 'application/vnd.microsoft.portable-executable' }],
  ['.msi', { platform: 'Windows', contentType: 'application/x-msi' }],
  ['.dmg', { platform: 'macOS', contentType: 'application/x-apple-diskimage' }],
  ['.appimage', { platform: 'Linux', contentType: 'application/x-executable' }],
  ['.deb', { platform: 'Linux', contentType: 'application/vnd.debian.binary-package' }],
  ['.zip', { platform: 'Archive', contentType: 'application/zip' }],
]);

const VERSION_RE = /^(.*?)[-_ ]v?(\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?)(?:[-_ ].*)?$/;

function defaultDir() {
  // <repo>/apps — three levels up from src/server/mobile.
  const projectApps = path.resolve(__dirname, '../../..', 'apps');
  const dataStore = path.join(DATA_DIR, 'store');
  for (const candidate of [projectApps, dataStore]) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch (_) {
      // not created yet
    }
  }
  return projectApps;
}

function effectiveDir() {
  const cfg = config.get();
  const custom = typeof cfg.storeDir === 'string' ? cfg.storeDir.trim() : '';
  return custom ? path.resolve(custom) : defaultDir();
}

function compareVersions(a, b) {
  const parse = (v) => {
    const parts = String(v || '0')
      .split(/[.+-]/)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
    // `2.0` and `2.0.0` are the same version.
    while (parts.length && (parts[parts.length - 1] === 0 || parts[parts.length - 1] === '0')) {
      parts.pop();
    }
    return parts;
  };
  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const x = left[i] === undefined ? 0 : left[i];
    const y = right[i] === undefined ? 0 : right[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    const xs = x === undefined ? '' : String(x);
    const ys = y === undefined ? '' : String(y);
    if (xs === ys) continue;
    return xs < ys ? -1 : 1;
  }
  return 0;
}

function prettyName(fileBase) {
  return fileBase
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Walk the store folder (one level of sub-folders is allowed, e.g. `android/`,
 * `windows/`) and group installers by app name.
 */
function scan(dir = effectiveDir()) {
  const apps = new Map();
  let rootEntries = [];
  try {
    rootEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const files = [];
  for (const entry of rootEntries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      files.push(full);
    } else if (entry.isDirectory()) {
      let nested = [];
      try { nested = fs.readdirSync(full, { withFileTypes: true }); } catch (_) { continue; }
      for (const child of nested) {
        if (child.isFile()) files.push(path.join(full, child.name));
      }
    }
  }

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const kind = EXTENSIONS.get(ext);
    if (!kind) continue;
    let stat;
    try { stat = fs.statSync(file); } catch (_) { continue; }
    if (!stat.isFile()) continue;

    const base = path.basename(file, path.extname(file));
    const match = VERSION_RE.exec(base);
    const name = match ? match[1].trim() : base;
    const version = match ? match[2] : '';
    const key = `${name.toLowerCase()}|${kind.platform}`;
    const app = apps.get(key) || {
      id: key.replace(/[^a-z0-9]+/g, '-'),
      name: prettyName(name),
      platform: kind.platform,
      versions: [],
    };
    app.versions.push({
      version,
      file: path.relative(dir, file).split(path.sep).join('/'),
      size: stat.size,
      modified: stat.mtimeMs,
    });
    apps.set(key, app);
  }

  const list = [...apps.values()];
  for (const app of list) {
    app.versions.sort((a, b) => compareVersions(b.version, a.version) || b.modified - a.modified);
    app.latest = app.versions[0];
  }
  list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function catalog(dir = effectiveDir()) {
  return { dir, apps: scan(dir) };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(ms) {
  try {
    return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) {
    return '';
  }
}

function fileUrl(relative) {
  return `/store/files/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

function page(status, dir = effectiveDir()) {
  const data = catalog(dir);
  const count = data.apps.reduce((sum, app) => sum + app.versions.length, 0);
  const cards = data.apps.map((app) => {
    const older = app.versions.slice(1).map((v) => `
        <li><a href="${fileUrl(v.file)}">${escapeHtml(v.version || 'no version')}</a>
        <span class="muted">${formatBytes(v.size)} · ${formatDate(v.modified)}</span></li>`).join('');
    const latest = app.latest;
    return `<section class="app">
      <div class="head">
        <div class="icon">${escapeHtml(app.name.slice(0, 1).toUpperCase())}</div>
        <div class="title">
          <h2>${escapeHtml(app.name)}</h2>
          <p class="muted">${escapeHtml(app.platform)}${latest.version ? ` · v${escapeHtml(latest.version)}` : ''}</p>
        </div>
      </div>
      <a class="btn" href="${fileUrl(latest.file)}">Download ${formatBytes(latest.size)}</a>
      <p class="muted small">Updated ${formatDate(latest.modified)}</p>
      ${older ? `<details><summary>${app.versions.length - 1} earlier version${app.versions.length === 2 ? '' : 's'}</summary><ul>${older}</ul></details>` : ''}
    </section>`;
  }).join('');

  const empty = `<section class="app"><h2>No apps yet</h2>
    <p class="muted">Drop installers in <code>${escapeHtml(data.dir)}</code> on the PC
    and reload this page. Names like <code>Navic-1.9.0.apk</code> give the version.</p></section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#101014">
<title>Apps · SOPlayer</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:20px 16px 40px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#101014;color:#e8e6f0;line-height:1.5}
main{max-width:620px;margin:0 auto}
h1{font-size:24px;margin:0 0 2px}
h2{font-size:17px;margin:0}
p{margin:0}
.muted{color:#9a96aa;font-size:13px}
.small{font-size:12px}
.app{background:#191922;border:1px solid #2a2a38;border-radius:16px;padding:16px;margin:14px 0}
.head{display:flex;gap:12px;align-items:center;margin-bottom:12px}
.icon{width:44px;height:44px;border-radius:12px;background:#2b2b3d;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:19px}
.title{min-width:0}
.btn{display:block;text-align:center;background:#7c5cff;color:#fff;text-decoration:none;font-weight:600;padding:12px;border-radius:12px;margin-bottom:6px}
.btn:active{background:#6a4ae8}
details{margin-top:8px}
summary{cursor:pointer;color:#b7b3c7;font-size:13px}
ul{padding-left:18px;margin:8px 0 0}
li{margin:4px 0;font-size:14px}
li a{color:#c9bfff}
code{background:#22222e;padding:1px 5px;border-radius:6px;font-size:12px;word-break:break-all}
.note{font-size:12px;color:#8a8699;margin-top:18px}
</style></head>
<body><main>
<h1>Apps</h1>
<p class="muted">${data.apps.length} app${data.apps.length === 1 ? '' : 's'} · ${count} file${count === 1 ? '' : 's'} · served by SOPlayer${status && status.port ? ` on port ${status.port}` : ''}</p>
${cards || empty}
<p class="note">Android asks once for permission to install apps from this browser or file manager. Tap Download, then Install.</p>
</main></body></html>`;
}

/** Send one store file; rejects traversal and anything outside the folder. */
function sendFile(req, res, relative, dir = effectiveDir()) {
  const decoded = String(relative || '');
  if (!decoded || decoded.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad request');
  }
  const target = path.resolve(dir, decoded);
  const root = path.resolve(dir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }

  const kind = EXTENSIONS.get(path.extname(target).toLowerCase());
  const name = path.basename(target);
  const headers = {
    'Content-Type': kind ? kind.contentType : 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };

  // Range support lets Android's downloader resume a half-finished APK.
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  const range = typeof req.headers?.range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null;
  if (range && stat.size > 0) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = Number(range[2]);
    if (!range[1] && range[2]) {
      start = Math.max(0, stat.size - Number(range[2]));
      end = stat.size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
  }

  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    return res.end();
  }

  res.writeHead(status, headers);
  const stream = fs.createReadStream(target, status === 206 ? { start, end } : undefined);
  stream.on('error', () => { try { res.destroy(); } catch (_) {} });
  stream.pipe(res);
  return res;
}

module.exports = {
  effectiveDir,
  defaultDir,
  scan,
  catalog,
  page,
  sendFile,
  compareVersions,
  EXTENSIONS,
};
