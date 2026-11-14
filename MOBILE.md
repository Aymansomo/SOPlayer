# Riff → Phone (Navic / Subsonic)

Riff can act as a small **Subsonic / OpenSubsonic server** on your local network so
the Android app [Navic](https://navic.app) can browse and stream your music.

This is an early implementation. The connection handshake works today; library
browsing, streaming, downloads and two‑way likes/playlists are being added in
the next steps (see [Roadmap](#roadmap)).

---

## Quick start

1. Start Riff on the PC.
2. Open **Settings → Phone & Navic**.
3. Turn **Phone access (Subsonic)** on.
4. If Windows asks to allow Riff through the firewall, click **Allow**
   (or use **Add firewall rule** in the settings, which asks for administrator
   permission once).
5. Copy the **server URL**, **username** and **password** shown in the settings.
6. On the phone open Navic → **Servers → Add server** and paste:
   - **Server URL:** `http://192.168.x.x:6767`
   - **Username** and **password** from Riff
   - Leave the rest at default.

Tap **Test server** in Riff settings to verify the listener answers.

---

## About the port

You originally asked for **67676**, but TCP ports only go up to **65535**, so
Windows/Node cannot bind it. Riff uses **6767** instead.

To change it:

1. Close Riff.
2. Edit `mobile.json` in Riff's data folder (shown at the bottom of
   **Settings → Phone & Navic**, usually
   `%LOCALAPPDATA%\Riff\mobile.json`, or the custom data folder if you moved it).
3. Set `"port": 6767` to any free port between 1024 and 65535.
4. Start Riff again and update the URL in Navic.

If you change the port, also add a firewall rule for the new port.

---

## Where the data lives

| File / folder | Purpose |
|---|---|
| `mobile.json` | Phone-access settings, username, password, API key, extra folders |
| `mobile-collection.json` | Two‑way favourites / playlists (added in a later step) |
| `mobile-tags.json` | Cached audio tags for indexed files (added in a later step) |

These live in Riff's **data folder**, the same place as `metadata.json`,
`library.json`, `tracks/` and `thumbnails/`.

---

## Security model

- The phone listener is **off by default** and only starts when you enable it.
- It is a **separate HTTP server** from the desktop API. The desktop server
  (`127.0.0.1:38472`) stays bound to localhost and is never exposed.
- Only the Subsonic endpoints (`/rest/*`), the remote page (`/remote`) and a
  tiny status route are served on the LAN port.
- Credentials are independent from anything else in Riff and can be regenerated
  at any time (**New password**).
- Failed logins are throttled (12 attempts per minute per device).
- **Do not forward this port on your router.** It is intended for your home
  network only.

If you want access while away from home, use a private VPN such as
**Tailscale** instead of opening a router port.

---

## Firewall and administrator rights

Windows blocks inbound connections by default, especially when the Wi‑Fi is
classified as **Public**.

Two options:

1. **Approve the prompt** — the first time the listener starts, Windows may show
   “Allow Riff to communicate on these networks”. Tick **Private networks** and
   allow.
2. **Run the helper script as Administrator**:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\riff-mobile-firewall.ps1
   ```

   To also switch your current Wi‑Fi from Public to Private:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\riff-mobile-firewall.ps1 -SetPrivate
   ```

The **Add firewall rule** button in Settings launches the same script with a UAC
prompt, so it only works if you can approve administrator requests on your
account. The script does not need Riff to be run as administrator.

### How to check whether you are an administrator

Open PowerShell and run:

```powershell
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
```

- `True` → your current window is elevated.
- `False` → the window is not elevated, but you may still be able to approve a
  UAC prompt. Try the **Add firewall rule** button; if UAC asks for a password
  you do not have, ask the PC owner or use the “Allow” prompt instead.

### Manual firewall command (elevated PowerShell)

```powershell
New-NetFirewallRule -DisplayName "Riff Mobile (Subsonic)" `
  -Direction Inbound -Action Allow -Protocol TCP -LocalPort 6767 -Profile Private,Domain
```

To check the current Wi‑Fi profile:

```powershell
Get-NetConnectionProfile
```

If `NetworkCategory` is `Public`, either set it to `Private`:

```powershell
Set-NetConnectionProfile -InterfaceIndex <index> -NetworkCategory Private
```

or add `Public` to the firewall rule's `-Profile` list (less safe on shared
Wi‑Fi).

---

## Troubleshooting

| Symptom | Check |
|---|---|
| Navic times out | PC and phone on the same Wi‑Fi; Riff running; phone access enabled |
| “Connection refused” | Wrong port or listener not running — use **Test server** in Riff |
| Works on PC but not phone | Windows Firewall rule / network profile Public (see above) |
| “Wrong username or password” | Copy credentials again; if you used **New password**, update Navic |
| Nothing happens after enabling | Look at Riff’s logs; the port may be taken by another app |
| Phone can’t see the PC after sleep | Windows may have disconnected Wi‑Fi; wake the PC and retry |

---

## Roadmap

- [x] Phase 0 — persistent config, LAN listener, Subsonic auth, `ping`,
  `getLicense`, `getMusicFolders`, `getOpenSubsonicExtensions`, settings UI,
  firewall helper
- [ ] Phase 1 — library index (local library, cache, Downloads, extra folders),
  artists / albums / songs, search, cover art
- [ ] Phase 2 — `stream` + `download` with HTTP Range, on‑demand download
- [ ] Phase 3 — two‑way favourites, playlists, scrobbles
- [ ] Phase 4 — online YouTube/SoundCloud songs via server-side resolve
- [ ] Phase 5 — `/remote` page: play/pause, next/prev, seek, volume, like
- [ ] Phase 6 — polish, tests, installer notes

---

## باختصار بالعربي

- شغّل Riff ثم اذهب إلى **Settings → Phone & Navic** وفعّل **Phone access**.
- افتح تطبيق **Navic** في الهاتف وأضف سيرفراً جديداً بالعنوان والمستخدم وكلمة
  المرور الظاهرين في الإعدادات.
- المنفذ **67676 غير صالح** لأن أقصى رقم منفذ هو 65535، لذلك نستخدم **6767**.
- إذا لم يتصل الهاتف، اسمح لـ Riff في جدار الحماية أو شغّل
  `scripts/riff-mobile-firewall.ps1` كمسؤول.
- لا تفتح المنفذ على الراوتر؛ هذا للشبكة المحلية فقط.
