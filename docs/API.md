# Music Grabber — Backend API

HTTP API for searching YouTube and downloading audio into the configured music
library. Any application that can make HTTP requests can drive it.

- **Base URL:** `http://<host>:8080` (host port is set by `WEB_PORT`, default `8080`)
- **Content type:** JSON (`application/json`) for request/response bodies
- **Auth:** none — the API is unauthenticated. Only expose it on a trusted
  network, or put a reverse proxy with auth in front of it.
- **Concurrency:** downloads run through a single global FIFO queue — one job
  at a time. Submitting multiple jobs queues them; they do not run in parallel.
- **Persistence:** job state is held **in memory**. It is lost on container
  restart. Finished files remain on disk regardless.

---

## Conventions

- All successful responses are JSON objects.
- Errors return a JSON body `{ "error": "<message>" }` with a non-2xx status.
- Timestamps (`createdAt`) are **epoch milliseconds** (`Date.now()`).
- There is no rate limiting. Be reasonable when polling (see below).

---

## Endpoints

### GET `/api/health`

Liveness check plus environment info. Confirms the `yt-dlp` binary is callable.

**Response `200 OK`**
```json
{
  "ok": true,
  "ytdlp": "2025.09.26",
  "musicDir": "/music"
}
```

**Response `500 Internal Server Error`** — `yt-dlp` not found / not runnable:
```json
{
  "ok": false,
  "error": "yt-dlp binary not found at \"yt-dlp\". Is it installed?"
}
```

| Field      | Type    | Description                                   |
|------------|---------|-----------------------------------------------|
| `ok`       | boolean | `true` when the backend and yt-dlp are healthy |
| `ytdlp`    | string  | yt-dlp version string                          |
| `musicDir` | string  | In-container directory downloads are written to |

---

### GET `/api/search`

Search YouTube and return candidate results. **Does not download anything.**
The number of results is capped by the server's `SEARCH_LIMIT` (default `8`).

**Query parameters**

| Param | Required | Description                     |
|-------|----------|---------------------------------|
| `q`   | yes      | Search text (URL-encode it)     |

**Response `200 OK`**
```json
{
  "results": [
    {
      "id": "Xf3-4A-uEc8",
      "title": "Deep Focus Lofi Mix",
      "uploader": "Chill Village",
      "duration": 42898,
      "url": "https://www.youtube.com/watch?v=Xf3-4A-uEc8",
      "thumbnail": "https://i.ytimg.com/vi/Xf3-4A-uEc8/hq720.jpg"
    }
  ]
}
```

| Field            | Type           | Description                                   |
|------------------|----------------|-----------------------------------------------|
| `results`        | array          | Candidate videos (may be empty)               |
| `results[].id`   | string         | YouTube video ID                              |
| `results[].title`| string         | Video title                                   |
| `results[].uploader` | string     | Channel / uploader name                       |
| `results[].duration` | number\|null | Duration in seconds (null if unknown)       |
| `results[].url`  | string         | Canonical watch URL — pass this to `/api/download` |
| `results[].thumbnail` | string\|null | Thumbnail image URL                        |

**Errors**
- `400` — missing `q`: `{ "error": "Missing query parameter 'q'." }`
- `500` — search failed (e.g. yt-dlp/network/YouTube error): `{ "error": "<detail>" }`

---

### POST `/api/download`

Enqueue a download job. Accepts either a direct URL **or** a free-text search
term (the server downloads the top match for a search term). Returns
immediately with a `queued` job — poll it to track progress.

**Request body**
```json
{ "target": "https://www.youtube.com/watch?v=Xf3-4A-uEc8" }
```
or
```json
{ "target": "daft punk one more time" }
```

| Field    | Required | Type   | Description                                      |
|----------|----------|--------|--------------------------------------------------|
| `target` | yes      | string | A YouTube URL, or a search term (top hit is used) |

**Response `202 Accepted`**
```json
{
  "job": {
    "id": "5806770b-77fa-40ff-8395-3635a2e42f25",
    "target": "https://www.youtube.com/watch?v=Xf3-4A-uEc8",
    "status": "queued",
    "progress": 0,
    "title": "https://www.youtube.com/watch?v=Xf3-4A-uEc8",
    "filepath": null,
    "error": null,
    "log": [],
    "createdAt": 1792507727788
  }
}
```

The audio format and quality are controlled **server-side** by the
`AUDIO_FORMAT` and `AUDIO_QUALITY` environment variables — they cannot be set
per request.

**Errors**
- `400` — missing/empty `target`: `{ "error": "Missing 'target' (URL or search term)." }`
- `500` — music directory not writable: `{ "error": "Cannot access music dir: <detail>" }`

---

### GET `/api/jobs/:id`

Fetch the current state of a single job. Poll this after `POST /api/download`.

**Response `200 OK`** — same shape as the job object above, e.g. completed:
```json
{
  "job": {
    "id": "5806770b-77fa-40ff-8395-3635a2e42f25",
    "target": "https://www.youtube.com/watch?v=Xf3-4A-uEc8",
    "status": "done",
    "progress": 100,
    "title": "Deep Focus Lofi Mix",
    "filepath": "/music/Chill_Village/Deep_Focus_Lofi_Mix.mp3",
    "error": null,
    "log": ["[youtube] Extracting URL: ...", "[download] 100% of 3.2MiB"],
    "createdAt": 1792507727788
  }
}
```

**Errors**
- `404` — unknown id (or lost after a restart): `{ "error": "Job not found." }`

---

### GET `/api/jobs`

List recent jobs, newest first. Returns up to the **50** most recent jobs held
in memory.

**Response `200 OK`**
```json
{
  "jobs": [
    { "id": "…", "status": "done", "progress": 100, "...": "..." },
    { "id": "…", "status": "running", "progress": 42, "...": "..." }
  ]
}
```

---

## The Job object

Returned by `/api/download`, `/api/jobs`, and `/api/jobs/:id`.

| Field       | Type            | Description                                                        |
|-------------|-----------------|--------------------------------------------------------------------|
| `id`        | string (UUID)   | Unique job identifier                                              |
| `target`    | string          | The URL or search term that was submitted                         |
| `status`    | string          | One of `queued`, `running`, `done`, `error`                        |
| `progress`  | number (0–100)  | Download percentage. `100` when done                              |
| `title`     | string          | Best-known title; starts as `target`, refined once extraction starts |
| `filepath`  | string\|null    | In-container path to the finished file (set when `status=done`)    |
| `error`     | string\|null    | Error message when `status=error`                                  |
| `log`       | string[]        | Raw yt-dlp output lines (capped at 500)                            |
| `createdAt` | number          | Creation time, epoch milliseconds                                  |

### Job lifecycle

```
POST /api/download
        │
        ▼
    [queued] ──▶ [running] ──▶ [done]   (filepath set, progress 100)
                      │
                      └──────▶ [error]  (error message set)
```

A job is terminal when `status` is `done` or `error`. Stop polling then.

---

## Integration guide

Typical flow for another application:

1. (Optional) `GET /api/health` to confirm the service is up.
2. Either:
   - `GET /api/search?q=...`, let the user/app pick a result, then
     `POST /api/download` with the chosen `result.url`; **or**
   - `POST /api/download` directly with a URL or a search term.
3. Read the returned `job.id`.
4. Poll `GET /api/jobs/:id` (e.g. every 1–2 seconds) until `status` is
   `done` or `error`.
5. On `done`, the file is at `job.filepath` inside the container (under the
   mounted music library on the host). Navidrome picks it up on its next scan.

> **Polling cadence:** 1–2 seconds is plenty. Because downloads are serialized,
> a queued job won't start until the one ahead of it finishes.

### Example — curl

```bash
# Fire-and-forget download, then poll until finished
JOB=$(curl -fsS -X POST http://localhost:8080/api/download \
  -H "Content-Type: application/json" \
  -d '{"target":"https://www.youtube.com/watch?v=Xf3-4A-uEc8"}')
ID=$(echo "$JOB" | jq -r .job.id)

while :; do
  STATE=$(curl -fsS "http://localhost:8080/api/jobs/$ID")
  STATUS=$(echo "$STATE" | jq -r .job.status)
  echo "status=$STATUS progress=$(echo "$STATE" | jq -r .job.progress)"
  [ "$STATUS" = "done" ] && { echo "saved: $(echo "$STATE" | jq -r .job.filepath)"; break; }
  [ "$STATUS" = "error" ] && { echo "failed: $(echo "$STATE" | jq -r .job.error)"; break; }
  sleep 2
done
```

### Example — Python

```python
import time
import requests

BASE = "http://localhost:8080"

def download(target: str) -> dict:
    job = requests.post(f"{BASE}/api/download", json={"target": target}, timeout=30)
    job.raise_for_status()
    job_id = job.json()["job"]["id"]

    while True:
        state = requests.get(f"{BASE}/api/jobs/{job_id}", timeout=30).json()["job"]
        if state["status"] == "done":
            return state           # state["filepath"] has the saved path
        if state["status"] == "error":
            raise RuntimeError(state["error"])
        time.sleep(2)

result = download("https://www.youtube.com/watch?v=Xf3-4A-uEc8")
print("Saved to", result["filepath"])
```

### Example — Node.js (fetch)

```js
const BASE = "http://localhost:8080";

async function download(target) {
  const start = await fetch(`${BASE}/api/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
  if (!start.ok) throw new Error((await start.json()).error);
  const { job } = await start.json();

  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const { job: j } = await (await fetch(`${BASE}/api/jobs/${job.id}`)).json();
    if (j.status === "done") return j;        // j.filepath = saved path
    if (j.status === "error") throw new Error(j.error);
  }
}

download("daft punk one more time").then((j) => console.log("Saved:", j.filepath));
```

---

## Notes & caveats for integrators

- **In-memory jobs:** restarting the container clears all job history. Capture
  `filepath` when a job finishes if you need a durable record.
- **Single worker:** only one download runs at a time by design (small-server
  friendly). High-volume callers should expect queueing, not parallelism.
- **Server-controlled format:** `AUDIO_FORMAT` / `AUDIO_QUALITY` are global env
  settings, not request parameters.
- **`filepath` is a container path:** it reflects the path inside the container
  (e.g. under `/music`), which maps to your host music library via the volume
  mount. Layout is `/<MUSIC_DIR>/<Uploader>/<Title>.<ext>` with restricted
  (ASCII-safe) filenames.
- **YouTube anti-bot:** downloads can fail with *"confirm you're not a bot"* /
  *"page needs to be reloaded"*. The `error` field will contain the yt-dlp
  message. See the README for the `COOKIES_FILE` workaround.
- **No CORS headers** are set. For browser-based cross-origin callers, put a
  reverse proxy in front to add the headers you need.
