import { randomUUID } from "node:crypto";
import { downloadAudio } from "./ytdlp.js";

/**
 * In-memory job store for download tasks. Jobs are processed one at a time
 * through a simple FIFO queue to avoid saturating CPU/network on a small
 * home server.
 */
const jobs = new Map();
const queue = [];
let active = false;

const PROGRESS_RE = /\[download\]\s+([\d.]+)%/;

function createJob(target, outputDir, options) {
  const id = randomUUID();
  const job = {
    id,
    target,
    status: "queued", // queued | running | done | error
    progress: 0,
    title: target,
    filepath: null,
    error: null,
    log: [],
    createdAt: Date.now(),
    _outputDir: outputDir,
    _options: options,
  };
  jobs.set(id, job);
  queue.push(id);
  processQueue();
  return job;
}

async function processQueue() {
  if (active) return;
  const id = queue.shift();
  if (!id) return;
  active = true;

  const job = jobs.get(id);
  if (!job) {
    active = false;
    return processQueue();
  }

  job.status = "running";
  try {
    const { filepath } = await downloadAudio(job.target, job._outputDir, {
      ...job._options,
      onProgress: (line) => {
        if (job.log.length < 500) job.log.push(line);
        const m = line.match(PROGRESS_RE);
        if (m) job.progress = Math.min(100, parseFloat(m[1]));
        const titleMatch = line.match(/\[ExtractAudio\] Destination: .*\/(.+)\.\w+$/);
        if (titleMatch) job.title = titleMatch[1];
      },
    });
    job.filepath = filepath;
    job.progress = 100;
    job.status = "done";
  } catch (err) {
    job.status = "error";
    job.error = err.message;
  } finally {
    active = false;
    processQueue();
  }
}

function publicJob(job) {
  if (!job) return null;
  const { _outputDir, _options, ...rest } = job;
  return rest;
}

export const Jobs = {
  enqueue: (target, outputDir, options) => publicJob(createJob(target, outputDir, options)),
  get: (id) => publicJob(jobs.get(id)),
  list: () =>
    [...jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map(publicJob),
};
