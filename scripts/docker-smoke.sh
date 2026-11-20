#!/usr/bin/env bash
# Smoke test for the server image: start it the way an operator would (read-only root filesystem,
# no capabilities, mounted sites, keys and pack, a volume for /data), wait for the HEALTHCHECK,
# read /healthz and /metrics, then stop it with SIGTERM and require a clean drain (exit code 0).
#
#   scripts/docker-smoke.sh [image]        (default: belarusian-captcha-server:ci)
#
# The key file is a throwaway, all-zero test key ('A' x 43 in base64url): it is not a secret and
# must never be used outside this test. The pack is the synthetic test fixture.
set -euo pipefail

image="${1:-belarusian-captcha-server:ci}"
root="$(cd "$(dirname "$0")/.." && pwd)"
name="bc-smoke-$$"
api_port="${SMOKE_API_PORT:-18080}"
metrics_port="${SMOKE_METRICS_PORT:-19464}"
work="$(mktemp -d)"

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- container logs"
    docker logs "$name" 2>&1 | tail -n 50 || true
  fi
  docker rm -f -v "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

fail() { echo "::error::smoke: $*"; exit 1; }

printf '{"active":"k1","keys":{"k1":"%s"}}\n' "$(printf 'A%.0s' $(seq 1 43))" > "$work/bc-keys.json"
cp "$root/server/sites.example.yaml" "$work/sites.yaml"
cp "$root/server/test/fixtures/synthetic-pack.json" "$work/pack.json"
# The container runs as uid 65532; the mounted files must be readable by it.
chmod 0644 "$work"/*

docker run -d --name "$name" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p "127.0.0.1:${api_port}:8080" -p "127.0.0.1:${metrics_port}:9464" \
  -v "$work/sites.yaml:/etc/bc/sites.yaml:ro" \
  -v "$work/bc-keys.json:/run/secrets/bc-keys.json:ro" \
  -v "$work/pack.json:/etc/bc/pack.json:ro" \
  --mount type=volume,dst=/data \
  -e BC_SHUTDOWN_TIMEOUT_MS=5000 \
  "$image" >/dev/null

echo "waiting for the HEALTHCHECK"
health=""
for _ in $(seq 1 60); do
  health="$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo gone)"
  [ "$health" = "healthy" ] && break
  [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = "true" ] || fail "container exited during start"
  sleep 1
done
[ "$health" = "healthy" ] || fail "not healthy after 60 s (last status: $health)"

body="$(curl -fsS "http://127.0.0.1:${api_port}/healthz")" || fail "GET /healthz failed"
echo "healthz: $body"
case "$body" in *'"ok":true'*) ;; *) fail "/healthz did not report ok" ;; esac

curl -fsS "http://127.0.0.1:${metrics_port}/metrics" | grep -q '^# TYPE ' || fail "GET /metrics returned no metrics"
echo "metrics: ok"

echo "stopping with SIGTERM"
docker stop -t 30 "$name" >/dev/null
code="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
docker logs "$name" 2>&1 | grep -q 'shutting down' || fail "no drain log line after SIGTERM"
[ "$code" = "0" ] || fail "exit code $code after SIGTERM, expected 0"
echo "smoke test passed: healthy, /healthz ok, /metrics ok, SIGTERM drained, exit 0"
