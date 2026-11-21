# syntax=docker/dockerfile:1
#
# The Express demo backend for compose.yaml: serves the demo page (built for this backend, so its
# form posts to /demo/submit) and checks the form's token with belarusian-captcha/server.
# An example, not a product image; it is never published.
#
# Build context: the repository root (the backend is an npm workspace and uses the root lock file,
# the Node SDK and the widget). Dockerfile.dockerignore next to this file limits the context.
#
#   docker build -f demo/backends/express/Dockerfile -t bc-demo-express .
#
# Base images: the same pinned digests as the server's Dockerfile.
ARG BUILD_IMAGE=node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot@sha256:6abfcb367ebc291572c774c1592a986be2ab26a2486f73093401327495a5962a

# --- compile: the SDK's server part, this backend, the widget and the demo page. Pure JavaScript.
FROM --platform=$BUILDPLATFORM ${BUILD_IMAGE} AS compile
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY widget/package.json widget/
COPY sdk/node/package.json sdk/node/
COPY demo/backends/express/package.json demo/backends/express/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY shared/tsconfig.json shared/
COPY shared/src shared/src
COPY widget/tsconfig.json widget/build.mjs widget/
COPY widget/src widget/src
COPY sdk/node/tsconfig.json sdk/node/
COPY sdk/node/src sdk/node/src
COPY demo/backends/express/tsconfig.json demo/backends/express/
COPY demo/backends/express/src demo/backends/express/src
COPY demo/build.mjs demo/
COPY demo/src demo/src
# tsc builds the SDK first through the project reference; this backend uses only its ./server.
RUN node widget/build.mjs && npx tsc -b --builders 1 demo/backends/express
# The page's defaults: the API as the browser reaches it, and the form posting to this backend.
ARG BC_DEMO_API=http://localhost:8080
ARG BC_DEMO_SITEKEY=demo-sitekey-0001
ARG BC_DEMO_SITE_URL=http://localhost:3000/
RUN BC_DEMO_API="$BC_DEMO_API" BC_DEMO_SITEKEY="$BC_DEMO_SITEKEY" \
    BC_DEMO_SITE_URL="$BC_DEMO_SITE_URL" BC_DEMO_BACKEND=/demo/submit node demo/build.mjs

# --- deps: production dependencies of this backend only (Express; the SDK has none).
FROM ${BUILD_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY widget/package.json widget/
COPY sdk/node/package.json sdk/node/
COPY demo/backends/express/package.json demo/backends/express/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund -w demo/backends/express

# --- runtime: distroless Node 24, no shell.
FROM ${RUNTIME_IMAGE} AS runtime
LABEL org.opencontainers.image.title="belarusian-captcha-demo-express" \
      org.opencontainers.image.description="belarusian-captcha demo backend (Express); an example" \
      org.opencontainers.image.source="https://github.com/YauhenBichel/belarusian-captcha" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json ./
COPY --from=compile /src/sdk/node/package.json sdk/node/
COPY --from=compile /src/sdk/node/dist sdk/node/dist
COPY --from=compile /src/demo/backends/express/package.json demo/backends/express/
COPY --from=compile /src/demo/backends/express/dist demo/backends/express/dist
COPY --from=compile /src/demo/dist demo/dist
COPY LICENSE NOTICE ./
USER 65532:65532
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["demo/backends/express/dist/main.js"]
