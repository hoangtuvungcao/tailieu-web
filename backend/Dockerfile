# =============================================================================
# TAILIEU TTN API — multi-stage production image
# =============================================================================
# Build context is ./backend (see docker-compose.yml).
#
# The final image runs as a non-root user and contains only production
# dependencies plus compiled JS — no TypeScript, no dev tooling, no source.
# =============================================================================

# --- Stage 1: dependencies ---------------------------------------------------
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# argon2 ships prebuilt binaries for common platforms, but the fallback path
# needs a toolchain. Install it so the build never fails on an unusual arch.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund


# --- Stage 2: build ----------------------------------------------------------
FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# The build script runs `tsx scripts/copy-sql.ts`, which tsc does not emit.
COPY scripts ./scripts
RUN npm run build


# --- Stage 3: runtime --------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    TINI_VERSION=v0.19.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./
# Migrations are SQL files applied at deploy time, not build time.
COPY drizzle ./drizzle

# Never run as root: a container escape should not land as uid 0.
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin tailieu \
    && chown -R tailieu:tailieu /app
USER tailieu

EXPOSE 4000

# Compose/orchestrator healthcheck. Uses the liveness endpoint, which has no
# dependencies — a database blip must not cause a container restart loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:4000/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
