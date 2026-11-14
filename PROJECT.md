# Riff + Navic — Phone Music Project

This file is the single source of truth for the **Riff → Navic** work: what we are
building, why, how it is wired, where every file lives, and what is done so far.
Read this first before continuing any phase.

---

## 1. Goal

Turn the user's fork of the **Riff** desktop music player into a small
**Subsonic / OpenSubsonic server** on the local network, so the Android app
**Navic** can:

- browse the PC music library (artists, albums, songs, genres, search),
- stream and download songs from the PC,
- keep **likes (favourites) and playlists synced two-way**,
- play everything on the phone (local files + online YouTube/SoundCloud),
- **remote-control** playback on the PC (play/pause/next/seek/volume/like).

The PC is not always on. When it is off, the phone must keep working with the
songs it has already downloaded/cached in Navic.

---

## 2. Hard requirements and decisions

| Topic | Decision |
|---|---|
| Phone app | **Navic** (Android, Subsonic/OpenSubsonic client). |
| Navic source | `project\Riff\Navic` is **reference only**. **No Navic files are changed.** Riff does all server-side work. |
| Music folder | **Only** `E:\ayman\Development\My_progicte\ME\Music_app\project\music`. The user adds music there manually. Do **not** index `script\audio` root files. |
| Port | The originally requested **67676 is impossible** (TCP max 65535). We use **6767**. |
| Desktop API | The existing desktop server stays on `127.0.0.1:38472` and is **never exposed** to the LAN. |
| Phone listener | A separate HTTP server binds `0.0.0.0:6767`. |
| Offline | Navic downloads songs itself; the server does not need to be online for offline playback. |
| Likes / playlists | Must sync both ways (phone ↔ PC). Planned in Phase 3 using Riff's existing `localStorage` collections. |

---

## 3. Architecture

```
┌──────────────────────────── PC (Riff / Electron) ───────────────────────────┐
│                                                                             │
│  Renderer (src/renderer)                                                    │
│    Settings → Phone & Navic  ──IPC──┐                                       │
│    localStorage favourites/playlists│                                       │
│                                     ▼                                       │
│  Main process (src/main/main.js)                                            │
│    ├── desktop server  src/server/server.js   127.0.0.1:38472  (private)    │
│    └── phone server    src/server/mobile/     0.0.0.0:6767     (LAN)        │
│            ├── config.js     mobile.json                                    │
│            ├── auth.js       Subsonic token auth + remote sessions          │
│            ├── library.js    music scan / index / cover art                 │
│            └── subsonic.js   /rest/* API                                    │
│                                                                             │
│  Music library: E:\...\Music_app\project\music  (only this folder)          │
└─────────────────────────────────────────────────────────────────────────────┘
                                   │ Wi-Fi LAN
                                   ▼
                    ┌──────────────────────────────┐
                    │ Navic (Android)              │
                    │  http://<PC-LAN-IP>:6767     │
                    │  browse / stream / download  │
                    │  likes / playlists (2-way)   │
                    └──────────────────────────────┘
```

Why a separate server: the desktop server trusts localhost and exposes routes
that run `yt-dlp`/`ffmpeg` with user-supplied URLs. It must never be reachable
from another device. The phone server only exposes `/rest/*`, `/remote` and a
tiny status route.

---

## 4. Files added / changed for this project

### Server (new)

| File | Purpose |
|---|---|
| `src/server/mobile/config.js` | Persistent `mobile.json`, defaults, credential generation, LAN URL detection, folder seeding. |
| `src/server/mobile/auth.js` | Subsonic auth (`t`/`s`, `p`, `enc:`, `apiKey`), login throttling, remote-page cookie sessions. |
| `src/server/mobile/library.js` | Recursive scan of the configured music folders, `ffprobe` tags, stable IDs, artist/album/song indexes, cover art, stream file lookup, persistence (`mobile-library.json`). |
| `src/server/mobile/subsonic.js` | Subsonic/OpenSubsonic envelope (XML + JSON), endpoint router, browse/search/cover/stream handlers. |
| `src/server/mobile/index.js` | LAN HTTP listener (`0.0.0.0:6767`), routing, landing page, `/mobile/api/status`, `/remote`. |
| `src/server/mobile/public/remote.html` | Phone remote-control page (Phase 5; currently a placeholder). |
| `scripts/riff-mobile-firewall.ps1` | Windows firewall helper (needs admin once). |
| `MOBILE.md` | User-facing setup / firewall / troubleshooting guide (English + Arabic). |
| `PROJECT.md` | This file. |
| `test/mobile.test.js` | Handshake, auth, XML/JSON, browse and cover-art tests. |

### Desktop integration (edited)

| File | Change |
|---|---|
| `src/main/main.js` | Starts/stops the phone listener; IPC handlers for mobile config/status/password/folders/test/library scan. |
| `src/main/preload.js` | Exposes the mobile IPC methods to the renderer. |
| `src/renderer/index.html` | **Settings → Phone & Navic** section and nav entry. |
| `src/renderer/app.js` | Phone settings logic (toggle, URLs, credentials, folders, test, library status/reindex). |

### Reference only

- `Navic/` — Android client source, **unmodified**.

---

## 5. Configuration

### `mobile.json`

Location: Riff **data folder** (usually `%LOCALAPPDATA%\Riff\mobile.json`; on this
machine `E:\ayman\Development\My_progicte\ME\Music_app\script\audio\mobile.json`).

```json
{
  "enabled": true,
  "port": 6767,
  "bindHost": "0.0.0.0",
  "username": "riff",
  "password": "<generated>",
  "apiKey": "<generated>",
  "folders": [
    "E:\\ayman\\Development\\My_progicte\\ME\\Music_app\\project\\music"
  ],
  "remoteEnabled": true,
  "foldersSeeded": true,
  "createdAt": 0,
  "updatedAt": 0
}
```

- `folders` is the **only** music source list. The app seeds it once with
  `project\music` when that folder exists; after that the user controls it.
- `password` and `apiKey` are generated on first run and can be regenerated from
  the UI. Changing the password requires updating Navic.

### Generated data files (same data folder)

| File | Purpose |
|---|---|
| `mobile-library.json` | Cached library index (songs/albums/artists + file `mtime`/`size`). |
| `mobile-covers/<albumId>.jpg` | Extracted/cached album covers. |
| `mobile-collection.json` | Two-way favourites/playlists (Phase 3). |

---

## 6. Stable IDs

All IDs are derived from content/paths, so they survive rescans and do not
change between app restarts:

| Entity | Key | Example |
|---|---|---|
| Song | SHA-1 of `song\n<absolute file path>` | `9f2c...` |
| Album | SHA-1 of `album\n<album artist>\n<album>\n<folder>` | `4a71...` |
| Artist | SHA-1 of `artist\n<normalized name>` | `c0de...` |

Covers use the album ID. Song and artist objects point their `coverArt` at the
album ID, so Navic asks for one image per album.

---

## 7. Subsonic API status

Base URL: `http://<PC-LAN-IP>:6767/rest/<method>.view`
Credentials: Subsonic token auth (`u`, `t`, `s`) or plain/`enc:` password, or
`apiKey=` (OpenSubsonic). Responses: XML by default, JSON with `f=json`.

### Implemented (Phase 0 + 1)

| Endpoint | Notes |
|---|---|
| `ping`, `getLicense` | Handshake. |
| `getOpenSubsonicExtensions` | Empty list. |
| `getMusicFolders` | Configured music folders. |
| `getUser` | User roles (admin/download/playlist/cover). |
| `getArtists` | Artists grouped by letter (`index`). |
| `getIndexes` | Same artist index + `lastModified`. |
| `getArtist` | Artist with albums. |
| `getAlbum` | Album with songs. |
| `getAlbumList2` | `alphabeticalByName`, `alphabeticalByArtist`, `newest`, `random`, `recent`; paging with `size`/`offset`. |
| `getAlbumList` | ID3 alias of `getAlbumList2`. |
| `getSong` | One song by ID. |
| `getRandomSongs` | Optional `genre`, year range. |
| `getSongsByGenre` | Paged. |
| `getGenres` | Song/album counts per genre. |
| `search3`, `search2` | Artists, albums, songs. |
| `getCoverArt` | Cached/extracted album art, falls back to `assets/icon.png`. |
| `getScanStatus`, `startScan` | Library scan state / trigger rescan. |
| `getStarred2` | Empty until Phase 3. |
| `getPlaylists`, `getPlaylist` | Empty until Phase 3. |
| `stream`, `download` | Local files with HTTP Range support (Phase 1.5). |
| `scrobble`, `star`, `unstar` | Accepted no-ops until Phase 3. |

### Not implemented yet

- Online YouTube/SoundCloud songs (Phase 4).
- Remote-control actions (`/remote` UI + IPC bridge, Phase 5).
- Play queue, lyrics, artist info beyond basics.

---

## 8. Library scanning

1. Source folders come only from `mobile.json → folders`.
2. Recursive walk; supported extensions: `mp3 m4a aac flac ogg oga opus wav wma
   aiff aif m4b mp4 webm`.
3. Tags via `ffprobe -show_format -show_streams` (`title`, `artist`,
   `album`, `album_artist`, `track`, `disc`, `date`, `genre`). Missing tags fall
   back to filename / parent folder.
4. Files unchanged by `mtime` + `size` are reused from the cache (incremental).
5. Albums are grouped by album artist + album name + folder; artists by name.
6. Cover art is extracted lazily with `ffmpeg` from the first song of an album,
   or taken from `cover.jpg`/`folder.jpg` in the album folder.
7. `ffprobe`/`ffmpeg` are resolved with `src/shared/platform.js`
   (`resolveBinary`); on this machine they live in
   `E:\ayman\Development\My_progicte\ME\Music_app\script\audio\bin`.
8. Scans run asynchronously; the API keeps answering with the previous index
   until the new one is ready.

---

## 9. Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Persistent config, LAN listener, Subsonic auth, handshake, settings UI, firewall helper | **Done** |
| 1 | Library index (music folder only), artists/albums/songs, search, genres, cover art, scan status UI, local `stream`/`download` with Range | **Done** |
| 2 | Robust streaming (transcoding if needed), download edge cases, cache maintenance | Planned |
| 3 | Two-way favourites, playlists, scrobbles (`star`/`unstar`/`scrobble`, collection file) | Planned |
| 4 | Online YouTube/SoundCloud songs resolved server-side and exposed as Subsonic entries | Planned |
| 5 | `/remote` page: play/pause, next/prev, seek, volume, like, now playing | Planned |
| 6 | Polish, tests, installer notes, docs | Planned |

---

## 10. Security model

- Phone listener is **off by default**; enabling it is an explicit user action.
- Only `/rest/*`, `/remote`, `/remote/*`, `/mobile/api/status` and the landing
  page are served on the LAN port.
- Auth: Subsonic token auth (MD5 of password + salt) preferred; legacy plain
  and `enc:` passwords supported; OpenSubsonic `apiKey` supported.
- Failed logins throttled: 12 failures per minute per client IP.
- Credentials are independent from every other Riff credential and can be
  regenerated.
- **Never port-forward 6767 on the router.** For remote access use a private VPN
  such as Tailscale.
- The desktop server (`127.0.0.1:38472`) remains localhost-only.

---

## 11. Running and testing

### Start the app

```powershell
cd "E:\ayman\Development\My_progicte\ME\Music_app\project\Riff"
npm start
```

Then **Settings → Phone & Navic → Phone access (Subsonic)** on.

### Manual checks

```powershell
# from the PC
curl "http://127.0.0.1:6767/rest/ping.view?u=riff&p=enc:<hex>&v=1.16.1&c=test&f=json"

# from the phone browser
http://<PC-LAN-IP>:6767/
http://<PC-LAN-IP>:6767/remote
```

### Automated tests

```powershell
node --test test/mobile.test.js
```

`test/mobile.test.js` uses a temporary data dir and a random port, so it never
touches the real library. It covers auth (token, `enc:`, bad password), XML and
JSON envelopes, the browse endpoints and cover art.

> Note: the full `node --test` suite has two pre-existing unrelated failures
> (`server-search-cleanup.test.js`, `spotify-auth.test.js`).

---

## 12. Navic setup

1. PC and phone on the same Wi-Fi.
2. Riff running, **Phone access** enabled, firewall allows the port.
3. Navic → **Servers → Add server**:
   - **Server URL:** `http://<PC-LAN-IP>:6767` (shown in Riff settings)
   - **Username / password:** shown in Riff settings
   - Defaults for everything else.
4. Tap **Test server** in Riff if unsure.
5. Navic syncs artists/albums/songs automatically. Downloads made in Navic keep
   working when the PC is off.

No Navic source files are modified at any point.

---

## 13. Troubleshooting

| Symptom | Check |
|---|---|
| Phone times out | Same Wi-Fi; Riff running; phone access enabled. |
| Connection refused | Wrong port or listener stopped — use **Test server**. |
| Works on PC, not phone | Windows Firewall / network profile is Public (see `MOBILE.md`). |
| Wrong password | Re-copy credentials after **New password**; update Navic. |
| Library empty | Music folder is empty or not configured; press **Rescan library**. |
| No cover art | Files have no embedded art and no `cover.jpg`; fallback icon is used. |
| Songs missing | Unsupported extension or nested inside a skipped hidden folder. |

---

## 14. ملخص بالعربي

- الهدف: تشغيل Riff كسيرفر **Subsonic** على الشبكة المحلية حتى يتصل تطبيق
  **Navic** على الهاتف ويستعرض ويشغّل ويحمّل الأغاني، ويزامن الإعجابات
  وقوائم التشغيل، ويتحكم بتشغيل الموسيقى على الكمبيوتر.
- مصدر الموسيقى الوحيد هو مجلد
  `E:\ayman\Development\My_progicte\ME\Music_app\project\music`، وتضيف أنت
  الأغاني فيه بنفسك.
- تطبيق Navic **لا يُعدّل إطلاقاً**؛ كل العمل داخل Riff (السيرفر).
- المنفذ المطلوب 67676 غير صالح (أقصى منفذ 65535)، لذلك نستخدم **6767**.
- سيرفر الكمبيوتر الداخلي يبقى على `127.0.0.1:38472` ولا يُفتح للشبكة.
- عند إطفاء الكمبيوتر تعمل الأغاني المحمّلة مسبقاً في Navic بدون سيرفر.
- الإعدادات: **Settings → Phone & Navic**، ثم فعّل **Phone access**.
- لا تفتح المنفذ على الراوتر؛ للوصول من خارج المنزل استخدم VPN مثل Tailscale.
