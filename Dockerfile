# syntax=docker/dockerfile:1
#
# The verify API server (docs/DESIGN.md sections 2.4 and 5.3), with the widget build it serves at
# /widget.js and /widget.worker.js (section 5.1; BC_WIDGET_DIR).
#
# The build context is the repository root, not server/: the server is an npm workspace that needs
# the root package-lock.json and the shared/ package, so this file lives next to them and
# `docker build .` works with no flags.
#
# Nothing secret is in the image. At run time mount (paths are the defaults set below):
#   /etc/bc/sites.yaml          site keys and secret hashes        (read-only)
#   /run/secrets/bc-keys.json   the key ring                       (read-only)
#   /etc/bc/pack.json           the content pack                   (read-only)
#   /data                       the SQLite spent store             (the one writable volume)
# The process runs as uid/gid 65532 (distroless "nonroot"): mounted files must be readable by it,
# and /data writable (a named volume inherits the right owner from the image).
#
# Base images are pinned by the digest of their multi-arch index; a bump moves tag and digest
# together. Both are Debian 13 (trixie), so the glibc the addon is installed against is the one it
# runs on.
ARG BUILD_IMAGE=node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:6abfcb367ebc291572c774c1592a986be2ab26a2486f73093401327495a5962a

# --- compile: TypeScript to JavaScript, and the widget bundle with esbuild. The output is platform
# independent, so this stage runs on the build machine's own architecture even in a multi-arch
# build (no emulation for tsc or esbuild), and both architectures carry the same widget bytes.
FROM --platform=$BUILDPLATFORM ${BUILD_IMAGE} AS compile
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY widget/package.json widget/
# --ignore-scripts: tsc needs no native addon, so better-sqlite3's node-gyp step is skipped here
# (esbuild's binary comes from its platform package and needs no install script).
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY shared/tsconfig.json shared/
COPY shared/src shared/src
COPY server/tsconfig.json server/
COPY server/src server/src
# Builds shared/ first through the project reference; the tools project (tests) is not built.
RUN npx tsc -b --builders 1 server
# The widget bundles shared/src directly; build.mjs also writes sri.json and enforces the size budget.
COPY widget/tsconfig.json widget/build.mjs widget/
COPY widget/src widget/src
RUN node widget/build.mjs

# --- deps: production dependencies for the target architecture. better-sqlite3 ships prebuilt
# N-API binaries for linux-x64 and linux-arm64 (glibc) inside its npm package, but npm still runs
# its node-gyp step, which needs Python, make and a C++ compiler: it finds the prebuild and builds
# nothing, or compiles SQLite from source when no prebuild matches. The toolchain stays in this
# stage; the binaries for other platforms and the bundled sources are dropped before the copy.
FROM ${BUILD_IMAGE} AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund \
 && arch="$(node -p 'process.arch')" \
 && find node_modules/better-sqlite3/prebuilds -type f ! -name "linux-${arch}.node" -delete \
 && rm -rf node_modules/better-sqlite3/deps node_modules/better-sqlite3/src \
 && node -e "new (require('better-sqlite3'))(':memory:').close()" \
 && mkdir -p /out/data

# --- runtime: distroless Node 24, no shell, no package manager, no npm.
FROM ${RUNTIME_IMAGE} AS runtime
LABEL org.opencontainers.image.title="belarusian-captcha-server" \
      org.opencontainers.image.description="The belarusian-captcha verify API server" \
      org.opencontainers.image.source="https://github.com/YauhenBichel/belarusian-captcha" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production \
    BC_SITES=/etc/bc/sites.yaml \
    BC_KEYS_FILE=/run/secrets/bc-keys.json \
    BC_PACK=/etc/bc/pack.json \
    BC_STORE=sqlite:/data/bc.sqlite \
    BC_PORT=8080 \
    BC_METRICS_PORT=9464 \
    BC_METRICS_HOST=0.0.0.0 \
    BC_WIDGET_DIR=/app/widget/dist
WORKDIR /app
# Application files stay owned by root, so the process cannot change them.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json ./
COPY --from=compile /src/shared/package.json shared/
COPY --from=compile /src/shared/dist shared/dist
COPY --from=compile /src/server/package.json server/
COPY --from=compile /src/server/dist server/dist
COPY --from=compile /src/widget/dist/widget.js /src/widget/dist/widget.worker.js \
     /src/widget/dist/sri.json widget/dist/
COPY LICENSE NOTICE ./
COPY --from=deps --chown=65532:65532 /out/data /data
VOLUME ["/data"]
USER 65532:65532
# 8080: the API. 9464: Prometheus /metrics, for the internal network only; never publish it.
EXPOSE 8080 9464
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.BC_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Exec form, no shell: node is PID 1 and receives SIGTERM itself; main.ts then drains in-flight
# requests for up to BC_SHUTDOWN_TIMEOUT_MS (default 10 s) and exits 0. Give `docker stop -t` (or
# the pod's terminationGracePeriodSeconds) more than that.
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["server/dist/main.js"]
