import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { searchYouTube, ytDlpVersion } from "./ytdlp.js";
import { Jobs } from "./jobs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8080;
const MUSIC_DIR = process.env.MUSIC_DIR || "/music";
const SEARCH_LIMIT = parseInt(process.env.SEARCH_LIMIT || "8", 10);

const app = express();
app.use(express.json());

// Serve static frontend
app.use(express.static(join(__dirname, "..", "public")));

// Health check + environment info
app.get("/api/health", async (_req, res) => {
  try {
    const version = await ytDlpVersion();
    res.json({ ok: true, ytdlp: version, musicDir: MUSIC_DIR });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Search YouTube
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing query parameter 'q'." });
  try {
    const results = await searchYouTube(q, SEARCH_LIMIT);
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start a download job (accepts a URL or a free-text search term)
app.post("/api/download", async (req, res) => {
  const target = (req.body?.target || "").toString().trim();
  if (!target) return res.status(400).json({ error: "Missing 'target' (URL or search term)." });
  try {
    await mkdir(MUSIC_DIR, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `Cannot access music dir: ${err.message}` });
  }
  const job = Jobs.enqueue(target, MUSIC_DIR, {
    format: process.env.AUDIO_FORMAT || "mp3",
    quality: process.env.AUDIO_QUALITY || "0",
  });
  res.status(202).json({ job });
});

// Poll a single job
app.get("/api/jobs/:id", (req, res) => {
  const job = Jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json({ job });
});

// List recent jobs
app.get("/api/jobs", (_req, res) => {
  res.json({ jobs: Jobs.list() });
});

app.listen(PORT, () => {
  console.log(`Song downloader listening on http://0.0.0.0:${PORT}`);
  console.log(`Downloading into: ${MUSIC_DIR}`);
});
