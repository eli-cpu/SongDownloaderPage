# 🎵 Music Grabber

A self-hosted web app that downloads music from YouTube into your **Navidrome**
library. Search for a song or paste a YouTube link, and it extracts the audio
(MP3 by default) with embedded metadata and cover art, straight into your music
folder. Built to run in Docker on a **ZimaOS** server.

![stack](https://img.shields.io/badge/Node-20-green) ![ytdlp](https://img.shields.io/badge/yt--dlp-bundled-blue) ![ffmpeg](https://img.shields.io/badge/ffmpeg-bundled-red)

---

## Features

- 🔎 Search YouTube from the browser, or paste any YouTube URL
- 🎧 Extracts audio to MP3 / M4A / Opus / FLAC with `yt-dlp` + `ffmpeg`
- 🏷️ Embeds title/artist metadata and thumbnail as cover art
- 📂 Saves into `Artist/Title.mp3` layout that Navidrome understands
- 📊 Live download progress in the UI
- 🔁 Simple job queue (one download at a time, friendly to small servers)
- 👤 Correct file ownership via `PUID`/`PGID` so Navidrome can read the files

---

## How it works

```
Browser UI  ──▶  Express API  ──▶  yt-dlp + ffmpeg  ──▶  /music  ──▶  Navidrome scans it
```

The backend shells out to `yt-dlp`, streams progress back to the frontend, and
writes finished files into the mounted music library.

---

## Quick start (any Docker host)

```bash
git clone <this-repo> music-grabber
cd music-grabber
cp .env.example .env
# edit .env — set MUSIC_LIBRARY and PUID/PGID (see below)
docker compose up -d --build
```

Open `http://<server-ip>:8080`.

---

## Deploying on ZimaOS

ZimaOS runs Docker under the hood and exposes it through the **App Store →
Custom Install / Docker Compose** feature. There are two easy paths.

### 1. Find your music path and user IDs

1. Open the **Files** app in ZimaOS and locate the folder Navidrome scans.
   It's usually under `/DATA`, for example:
   - `/DATA/Media/Music`
   - `/DATA/AppData/navidrome/music`
2. SSH into the ZimaOS host (or use the terminal) and run `id` to get your
   user/group IDs:
   ```bash
   id
   # uid=1000(zimauser) gid=1000(zimauser) ...
   ```
   Use those numbers for `PUID`/`PGID`. On most ZimaOS installs this is `1000:1000`.

### 2a. Deploy via Docker Compose (recommended)

1. Copy this project onto the server (e.g. into `/DATA/AppData/music-grabber`).
   You can use the Files app, `scp`, or `git clone`.
2. Create your `.env`:
   ```bash
   cp .env.example .env
   nano .env
   ```
   Set at least:
   ```ini
   MUSIC_LIBRARY=/DATA/Media/Music   # <- your real path from step 1
   PUID=1000
   PGID=1000
   ```
3. Build and start:
   ```bash
   docker compose up -d --build
   ```
4. In ZimaOS, the container will appear in the Docker/Apps view. The UI is at
   `http://<zima-ip>:8080`.

### 2b. Deploy via the ZimaOS App Store (Custom Install)

If you prefer the GUI, use **App Store → Install a customized app** and fill in:

- **Image:** build locally first (`docker build -t music-grabber .`) or push to a
  registry and reference it (e.g. `ghcr.io/youruser/music-grabber:latest`).
- **Port:** `8080` → `8080`
- **Volume:** host `/DATA/Media/Music` → container `/music`
- **Environment:** `PUID=1000`, `PGID=1000`, `MUSIC_DIR=/music`, `AUDIO_FORMAT=mp3`

---

## Running Navidrome together (optional)

If you don't already run Navidrome, this repo can start it alongside the grabber,
sharing the same library:

```bash
docker compose --profile with-navidrome up -d --build
```

- Music Grabber UI: `http://<server-ip>:8080`
- Navidrome UI: `http://<server-ip>:4533`

Both point at `MUSIC_LIBRARY`. The grabber writes files; Navidrome scans them
(every minute by default via `ND_SCANSCHEDULE`).

---

## Configuration

All settings live in `.env` (see `.env.example`):

| Variable        | Default              | Description                                            |
|-----------------|----------------------|--------------------------------------------------------|
| `WEB_PORT`      | `8080`               | Host port for the web UI                               |
| `MUSIC_LIBRARY` | `/DATA/Media/Music`  | Host path to your Navidrome library                    |
| `PUID` / `PGID` | `1000` / `1000`      | Owner of downloaded files (match your music share)     |
| `AUDIO_FORMAT`  | `mp3`                | `mp3`, `m4a`, `opus`, or `flac`                        |
| `AUDIO_QUALITY` | `0`                  | yt-dlp audio quality (`0` = best VBR for mp3)          |
| `SEARCH_LIMIT`  | `8`                  | Number of search results to show                       |
| `COOKIES_FILE`  | *(empty)*            | In-container path to a cookies.txt to authenticate YouTube |

### YouTube "confirm you're not a bot" errors

YouTube sometimes blocks downloads from server/VPS IPs with errors like
*"Sign in to confirm you're not a bot"* or *"The page needs to be reloaded"*.
To get past this, give yt-dlp your YouTube cookies:

1. In your browser, install a **"Get cookies.txt"** extension and log in to
   `youtube.com`.
2. Export cookies for youtube.com and save them over the `cookies.txt` file in
   this project (Netscape format).
3. In `.env` set:
   ```ini
   COOKIES_FILE=/cookies.txt
   ```
4. `docker compose up -d` to apply.

Keep updating `yt-dlp` too (`--build-arg YTDLP_VERSION=latest`) since these
checks change frequently.

### Pinning / updating yt-dlp

The Dockerfile pins a `yt-dlp` version via build arg for reproducible builds.
YouTube changes often, so to grab the newest release:

```bash
docker compose build --build-arg YTDLP_VERSION=latest
docker compose up -d
```

---

## API

| Method | Endpoint           | Description                                  |
|--------|--------------------|----------------------------------------------|
| GET    | `/api/health`      | Health + yt-dlp version + music dir          |
| GET    | `/api/search?q=`   | Search YouTube, returns candidate list       |
| POST   | `/api/download`    | Body `{ "target": "<url or search term>" }`  |
| GET    | `/api/jobs`        | List recent jobs                             |
| GET    | `/api/jobs/:id`    | Poll a single job's status/progress          |

Other applications can drive these endpoints to queue downloads. Full reference
with request/response schemas, the job lifecycle, and curl/Python/Node examples
is in **[docs/API.md](docs/API.md)**.

---

## Local development (without Docker)

Requires Node 20+, plus `yt-dlp` and `ffmpeg` on your `PATH`.

```bash
npm install
MUSIC_DIR=./downloads npm run dev
# open http://localhost:8080
```

---

## Troubleshooting

- **Files show up but Navidrome doesn't list them** — check `PUID`/`PGID` match
  the owner of the music share, and that `MUSIC_LIBRARY` is the exact folder
  Navidrome scans. Trigger a manual scan in Navidrome if needed.
- **Downloads fail with extraction errors** — YouTube likely changed something;
  rebuild with `--build-arg YTDLP_VERSION=latest`.
- **Permission denied writing to /music** — the host folder isn't writable by
  `PUID:PGID`. Fix ownership on the host: `chown -R 1000:1000 /DATA/Media/Music`.

---

## Legal note

Only download content you have the right to download. Respect YouTube's Terms of
Service and the copyright of creators. This tool is intended for personal use
with content you own or that is appropriately licensed.
