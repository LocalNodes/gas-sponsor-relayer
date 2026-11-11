# gas-sponsor-relayer image (25-05, D-01). One container per instance, one sqlite volume at /data.
#
# Base: node:24-alpine, pinned by the digest of the multi-platform index (resolved with
# `docker buildx imagetools inspect node:24-alpine`; tag and digest are recorded in README.md).
# To move to a newer base, resolve the digest again, rebuild and re-measure.
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8

WORKDIR /app

# .npmrc carries ignore-scripts=true; the install adds the 13 packages of the viem 2.57.10
# verdict from the checked lockfile and nothing else.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY config ./config

# /data holds the sqlite file and is owned by the non-root user the process runs as.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

ENV SPONSOR_RELAYER_DB=/data/relayer.sqlite \
    SPONSOR_RELAYER_PORT=8080

# No EXPOSE and no published port: Drupal reaches the relayer on the internal network only.
# WEB3_ENABLED is deliberately not set here; without it the relayer is keyless and only /healthz answers.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "src/server.js"]
