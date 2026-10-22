# syntax=docker/dockerfile:1

FROM node:20-alpine

# System deps: ffmpeg for audio extraction, python3 for yt-dlp runtime,
# su-exec to drop privileges, tini as PID 1, ca-certs for HTTPS.
RUN apk add --no-cache \
      ffmpeg \
      python3 \
      ca-certificates \
      su-exec \
      tini \
      curl

# Install yt-dlp as a standalone binary. Pin a version for reproducible builds;
# override at build time with --build-arg YTDLP_VERSION=<version or 'latest'>.
ARG YTDLP_VERSION=2025.09.26
RUN set -eux; \
    if [ "$YTDLP_VERSION" = "latest" ]; then \
      url="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"; \
    else \
      url="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp"; \
    fi; \
    curl -fsSL "$url" -o /usr/local/bin/yt-dlp; \
    chmod a+rx /usr/local/bin/yt-dlp; \
    /usr/local/bin/yt-dlp --version

WORKDIR /app

# Install node deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# App source
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=8080 \
    MUSIC_DIR=/music \
    PUID=1000 \
    PGID=1000

EXPOSE 8080
VOLUME ["/music"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8080/api/health || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
