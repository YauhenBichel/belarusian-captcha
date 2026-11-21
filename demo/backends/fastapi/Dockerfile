# syntax=docker/dockerfile:1
#
# The FastAPI demo backend for compose.yaml: serves the demo page (built for this backend, so its
# form posts to /demo/submit) and checks the form's token with the Python SDK.
# An example, not a product image; it is never published.
#
# Build context: the repository root (the demo page is built with the Node toolchain, and the
# backend uses the Python SDK from sdk/python). Dockerfile.dockerignore next to this file limits
# the context.
#
#   docker build -f demo/backends/fastapi/Dockerfile -t bc-demo-fastapi .
#
# Base images: the Node build image is the server's; the Python images are pinned by digest.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
ARG RUNTIME_IMAGE=gcr.io/distroless/python3-debian13:nonroot@sha256:6c4cb3bfa4b555429dd19541796a6ba6b30c84675b460bd0bd5072f7d5bdae71

# --- page: the widget and the demo page. Pure JavaScript, built once on the build platform.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS page
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY widget/package.json widget/
COPY sdk/node/package.json sdk/node/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY shared/tsconfig.json shared/
COPY shared/src shared/src
COPY widget/tsconfig.json widget/build.mjs widget/
COPY widget/src widget/src
COPY demo/build.mjs demo/
COPY demo/src demo/src
# The page's defaults: the API as the browser reaches it, and the form posting to this backend.
ARG BC_DEMO_API=http://localhost:8080
ARG BC_DEMO_SITEKEY=demo-sitekey-0001
ARG BC_DEMO_SITE_URL=http://localhost:3003/
RUN node widget/build.mjs && \
    BC_DEMO_API="$BC_DEMO_API" BC_DEMO_SITEKEY="$BC_DEMO_SITEKEY" \
    BC_DEMO_SITE_URL="$BC_DEMO_SITE_URL" BC_DEMO_BACKEND=/demo/submit node demo/build.mjs

# --- deps: FastAPI and uvicorn, hash-pinned, for the target platform (pydantic-core is compiled).
FROM ${PYTHON_IMAGE} AS deps
COPY demo/backends/fastapi/requirements.txt /tmp/
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --no-compile --require-hashes --no-deps --only-binary=:all: \
      --target /app/lib -r /tmp/requirements.txt

# --- runtime: distroless Python 3.13 (Debian's), no shell, no pip.
FROM ${RUNTIME_IMAGE} AS runtime
LABEL org.opencontainers.image.title="belarusian-captcha-demo-fastapi" \
      org.opencontainers.image.description="belarusian-captcha demo backend (FastAPI); an example" \
      org.opencontainers.image.source="https://github.com/YauhenBichel/belarusian-captcha" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV PYTHONPATH=/app/lib:/app/src PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 PORT=3003 BC_DEMO_DIR=/app/demo/dist
WORKDIR /app
COPY --from=deps /app/lib lib
# The SDK is standard library only: its package is copied, not installed.
COPY sdk/python/src/belarusian_captcha src/belarusian_captcha
COPY demo/backends/fastapi/src/demo_fastapi src/demo_fastapi
COPY --from=page /src/demo/dist demo/dist
COPY LICENSE NOTICE ./
USER 65532:65532
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
  CMD ["/usr/bin/python3", "-c", "import os,urllib.request as u; u.urlopen('http://127.0.0.1:'+os.environ.get('PORT','3003')+'/healthz', timeout=3)"]
ENTRYPOINT ["/usr/bin/python3"]
CMD ["-m", "demo_fastapi"]
