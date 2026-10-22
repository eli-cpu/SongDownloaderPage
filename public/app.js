const $ = (sel) => document.querySelector(sel);
const queryEl = $("#query");
const searchBtn = $("#searchBtn");
const grabBtn = $("#grabBtn");
const resultsEl = $("#results");
const jobsEl = $("#jobs");
const statusEl = $("#status");

const trackedJobs = new Map();
let pollTimer = null;

const URL_RE = /^https?:\/\//i;

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return "";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function checkHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (data.ok) {
      setStatus(`Ready · yt-dlp ${data.ytdlp} · saving to ${data.musicDir}`, "ok");
    } else {
      setStatus(`Backend problem: ${data.error}`, "err");
    }
  } catch {
    setStatus("Cannot reach backend.", "err");
  }
}

async function doSearch() {
  const q = queryEl.value.trim();
  if (!q) return;

  if (URL_RE.test(q)) {
    // It's a URL — just grab it.
    return startDownload(q);
  }

  searchBtn.disabled = true;
  searchBtn.innerHTML = '<span class="spinner"></span>';
  resultsEl.innerHTML = "";
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Search failed");
    renderResults(data.results || []);
    if (!data.results?.length) setStatus("No results found.", "");
  } catch (err) {
    setStatus(err.message, "err");
  } finally {
    searchBtn.disabled = false;
    searchBtn.textContent = "Search";
  }
}

function renderResults(results) {
  resultsEl.innerHTML = "";
  for (const r of results) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <img loading="lazy" src="${escapeHtml(r.thumbnail || "")}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="meta">
        <div class="title">${escapeHtml(r.title)}</div>
        <div class="by">${escapeHtml(r.uploader)} <span class="dur">${fmtDuration(r.duration)}</span></div>
      </div>
      <button class="btn primary">Download</button>
    `;
    card.querySelector("button").addEventListener("click", () => startDownload(r.url, r.title));
    resultsEl.appendChild(card);
  }
}

async function startDownload(target, title) {
  try {
    setStatus("Queuing download…");
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Download failed to start");
    const job = data.job;
    if (title) job.title = title;
    trackedJobs.set(job.id, job);
    renderJobs();
    setStatus("");
    startPolling();
  } catch (err) {
    setStatus(err.message, "err");
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollJobs, 1200);
  pollJobs();
}

async function pollJobs() {
  const pending = [...trackedJobs.values()].filter(
    (j) => j.status === "queued" || j.status === "running"
  );
  if (!pending.length) {
    clearInterval(pollTimer);
    pollTimer = null;
    return;
  }
  await Promise.all(
    pending.map(async (j) => {
      try {
        const res = await fetch(`/api/jobs/${j.id}`);
        if (!res.ok) return;
        const data = await res.json();
        const existing = trackedJobs.get(j.id);
        trackedJobs.set(j.id, { ...data.job, title: data.job.title || existing?.title });
      } catch {
        /* keep previous state */
      }
    })
  );
  renderJobs();
}

function renderJobs() {
  const list = [...trackedJobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!list.length) {
    jobsEl.innerHTML = '<div class="empty">No downloads yet.</div>';
    return;
  }
  jobsEl.innerHTML = "";
  for (const job of list) {
    const el = document.createElement("div");
    el.className = "job";
    const pct = Math.round(job.progress || 0);
    const fileName = job.filepath ? job.filepath.split("/").pop() : "";
    el.innerHTML = `
      <div class="row">
        <div class="name">${escapeHtml(job.title || job.target)}</div>
        <div class="state ${job.status}">${job.status}${
      job.status === "running" ? " " + pct + "%" : ""
    }</div>
      </div>
      <div class="bar"><span style="width:${job.status === "done" ? 100 : pct}%"></span></div>
      ${job.error ? `<div class="err-msg">${escapeHtml(job.error)}</div>` : ""}
      ${job.status === "done" && fileName ? `<div class="path">Saved: ${escapeHtml(fileName)}</div>` : ""}
    `;
    jobsEl.appendChild(el);
  }
}

// Load any existing jobs from the backend on startup.
async function loadExistingJobs() {
  try {
    const res = await fetch("/api/jobs");
    const data = await res.json();
    for (const j of data.jobs || []) trackedJobs.set(j.id, j);
    renderJobs();
    if ((data.jobs || []).some((j) => j.status === "running" || j.status === "queued")) {
      startPolling();
    }
  } catch {
    renderJobs();
  }
}

searchBtn.addEventListener("click", doSearch);
grabBtn.addEventListener("click", () => {
  const q = queryEl.value.trim();
  if (q) startDownload(q);
});
queryEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
});

checkHealth();
loadExistingJobs();
