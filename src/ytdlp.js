import { spawn } from "node:child_process";

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
        reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
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
    ...authArgs(),
  ];

  let finalPath = null;
  const stdout = await runYtDlp(args, {
    onProgress: (line) => {
      // Capture the final filepath printed via after_move:filepath
      if (line.startsWith(outputDir) || /\.(mp3|m4a|opus|flac)$/i.test(line)) {
        finalPath = line;
      }
      if (onProgress) onProgress(line);
    },
  });

  // Fallback: scan full stdout for a printed path
  if (!finalPath) {
    const match = stdout.split("\n").reverse().find((l) => /\.(mp3|m4a|opus|flac)$/i.test(l.trim()));
    if (match) finalPath = match.trim();
  }

  return { filepath: finalPath };
}

/** Verify yt-dlp is callable; returns version string. */
export async function ytDlpVersion() {
  const out = await runYtDlp(["--version"]);
  return out.trim();
}
