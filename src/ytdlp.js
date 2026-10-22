import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";

/**
 * Build the optional authentication args. YouTube increasingly requires a
 * logged-in session to avoid "Sign in to confirm you're not a bot" errors,
 * especially from datacenter/VPS IPs. Users can supply either a cookies.txt
 * file (COOKIES_FILE) or a browser to read cookies from (COOKIES_FROM_BROWSER).
 */
function authArgs() {
  const args = [];
  if (process.env.COOKIES_FILE) {
    args.push("--cookies", process.env.COOKIES_FILE);
  } else if (process.env.COOKIES_FROM_BROWSER) {
    args.push("--cookies-from-browser", process.env.COOKIES_FROM_BROWSER);
  }
  return args;
}

/**
 * YouTube-specific extractor args. YouTube frequently breaks individual player
 * clients (e.g. the "The page needs to be reloaded." error comes from the
 * tv/tv_downgraded client). Selecting a set of known-working clients lets
 * yt-dlp fall back when one is blocked. Override with YTDLP_PLAYER_CLIENT, e.g.
 *   YTDLP_PLAYER_CLIENT=default,-tv_downgraded
 *   YTDLP_PLAYER_CLIENT=android,web_safari,tv
 * Set it to "none" to disable this override entirely.
 */
function extractorArgs() {
  const client = (process.env.YTDLP_PLAYER_CLIENT ?? "default,-tv_downgraded").trim();
  if (!client || client.toLowerCase() === "none") return [];
  return ["--extractor-args", `youtube:player_client=${client}`];
}

/**
 * Turn common (and cryptic) YouTube/yt-dlp failures into an actionable hint.
 */
function explainError(stderr) {
  if (!stderr) return stderr;
  const lower = stderr.toLowerCase();
  const isBotBlock =
    lower.includes("page needs to be reloaded") ||
    lower.includes("sign in to confirm") ||
    lower.includes("confirm you're not a bot") ||
    lower.includes("player response playability");
  if (isBotBlock) {
    return (
      "YouTube blocked this request (bot/anti-automation check). Try: " +
      "1) update yt-dlp to the latest version, " +
      "2) provide a cookies.txt export via COOKIES_FILE, and/or " +
      "3) set YTDLP_PLAYER_CLIENT to a working client. " +
      `Original error: ${stderr}`
    );
  }
  return stderr;
}

/**
 * Run yt-dlp with the given args. Returns a promise resolving to stdout.
 * Optionally streams progress lines to onProgress(line).
 */
function runYtDlp(args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let stdoutBuf = "";

    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onProgress) {
        stdoutBuf += text;
        const lines = stdoutBuf.split(/\r|\n/);
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) onProgress(line.trim());
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error(`yt-dlp binary not found at "${YTDLP_BIN}". Is it installed?`));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      if (onProgress && stdoutBuf.trim()) onProgress(stdoutBuf.trim());
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(explainError(stderr.trim()) || `yt-dlp exited with code ${code}`));
      }
    });
  });
}

/**
 * Search YouTube and return a list of candidate results (no download).
 * Uses yt-dlp's ytsearch with --dump-json and flat extraction.
 */
export async function searchYouTube(query, limit = 8) {
  const args = [
    `ytsearch${limit}:${query}`,
    "--dump-json",
    "--no-warnings",
    "--flat-playlist",
    "--default-search",
    "ytsearch",
    ...extractorArgs(),
    ...authArgs(),
  ];

  const stdout = await runYtDlp(args);
  const results = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const data = JSON.parse(trimmed);
      results.push({
        id: data.id,
        title: data.title ?? "Unknown title",
        uploader: data.uploader ?? data.channel ?? "Unknown",
        duration: data.duration ?? null,
        url: data.url || data.webpage_url || `https://www.youtube.com/watch?v=${data.id}`,
        thumbnail: pickThumbnail(data),
      });
    } catch {
      // skip non-JSON lines
    }
  }
  return results;
}

function pickThumbnail(data) {
  if (Array.isArray(data.thumbnails) && data.thumbnails.length) {
    return data.thumbnails[data.thumbnails.length - 1].url;
  }
  if (data.thumbnail) return data.thumbnail;
  if (data.id) return `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`;
  return null;
}

/**
 * Download audio from a URL (or search term) as MP3 with embedded metadata
 * and thumbnail, into outputDir. Streams progress via onProgress.
 */
export async function downloadAudio(target, outputDir, { onProgress, format = "mp3", quality = "0" } = {}) {
  const isUrl = /^https?:\/\//i.test(target);
  const source = isUrl ? target : `ytsearch1:${target}`;

  const args = [
    source,
    "--no-playlist",
    "--extract-audio",
    "--audio-format", format,
    "--audio-quality", quality,
    "--embed-metadata",
    "--embed-thumbnail",
    "--add-metadata",
    "--no-warnings",
    "--newline",
    "--restrict-filenames",
    "--output", `${outputDir}/%(uploader)s/%(title)s.%(ext)s`,
    "--print", "after_move:filepath",
    ...extractorArgs(),
    ...authArgs(),
  ];

  // The `--print after_move:filepath` line is the authoritative final path.
  // yt-dlp prints it on its own line (no log prefix) only after the file has
  // been fully written and moved into place. We deliberately do NOT treat
  // progress/info lines (e.g. "[download] Destination: ...", "[ExtractAudio]
  // Destination: ...") as the result, because those point at intermediate or
  // not-yet-finished files and caused jobs to report success with no file.
  const candidates = [];
  const stdout = await runYtDlp(args, {
    onProgress: (line) => {
      const trimmed = line.trim();
      // A bare path line with no yt-dlp "[...]" prefix is the printed filepath.
      if (
        !trimmed.startsWith("[") &&
        (trimmed.startsWith(outputDir) || /\.(mp3|m4a|opus|flac)$/i.test(trimmed))
      ) {
        candidates.push(trimmed);
      }
      if (onProgress) onProgress(line);
    },
  });

  // Fallback: scan full stdout for a bare printed path.
  if (!candidates.length) {
    for (const l of stdout.split("\n")) {
      const t = l.trim();
      if (!t.startsWith("[") && /\.(mp3|m4a|opus|flac)$/i.test(t)) candidates.push(t);
    }
  }

  // Verify on disk. A job must not be reported as done unless the file is
  // actually present. Prefer the last candidate (the final destination).
  for (const candidate of candidates.reverse()) {
    try {
      const info = await stat(candidate);
      if (info.isFile() && info.size > 0) {
        return { filepath: candidate };
      }
    } catch {
      // not this one; keep looking
    }
  }

  throw new Error(
    "yt-dlp finished but no output file was found on disk. " +
      (candidates.length
        ? `Expected: ${candidates[candidates.length - 1]}. `
        : "No destination path was reported. ") +
      "Check that the music volume is mounted correctly and writable."
  );
}

/** Verify yt-dlp is callable; returns version string. */
export async function ytDlpVersion() {
  const out = await runYtDlp(["--version"]);
  return out.trim();
}
