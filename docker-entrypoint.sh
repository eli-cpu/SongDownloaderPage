#!/bin/sh
set -e

# Map the container's runtime user to the host-provided PUID/PGID so that
# files written into /music are owned correctly for Navidrome / ZimaOS shares.
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

# Create group/user if they don't already exist for these IDs.
if ! getent group "$PGID" >/dev/null 2>&1; then
  addgroup -g "$PGID" appgroup 2>/dev/null || true
fi
if ! getent passwd "$PUID" >/dev/null 2>&1; then
  adduser -D -H -u "$PUID" -G "$(getent group "$PGID" | cut -d: -f1)" appuser 2>/dev/null || true
fi

# Keep yt-dlp current. YouTube regularly changes its player and breaks older
# yt-dlp builds (e.g. the "The page needs to be reloaded." error). Self-updating
# on start pulls the latest fix without rebuilding the image. Disable by setting
# YTDLP_AUTO_UPDATE=0 (e.g. to pin a specific tested version).
if [ "${YTDLP_AUTO_UPDATE:-1}" != "0" ]; then
  echo "Updating yt-dlp to the latest release..."
  "${YTDLP_BIN:-yt-dlp}" -U 2>/dev/null \
    || echo "yt-dlp self-update skipped (will use the bundled version)."
fi

# Ensure the music directory exists and is writable by the runtime user.
mkdir -p "${MUSIC_DIR:-/music}"
chown "$PUID:$PGID" "${MUSIC_DIR:-/music}" 2>/dev/null || true

echo "Starting as UID:GID ${PUID}:${PGID}, music dir ${MUSIC_DIR:-/music}"

# Drop privileges and exec the main process.
exec su-exec "$PUID:$PGID" "$@"
