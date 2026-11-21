#!/usr/bin/env bash
# Smoke test for the server image: start it the way an operator would (read-only root filesystem,
# no capabilities, mounted sites, keys and pack, a volume for /data), wait for the HEALTHCHECK,
# read /healthz and /metrics, check the widget it serves against the image's sri.json, then stop it with SIGTERM and require a clean drain (exit code 0).
# The key file and a site are made with bc-admin inside the same image, so the CLI is tested where
# operators run it.
#
#   scripts/docker-smoke.sh [image]        (default: belarusian-captcha-server:ci)
#
# The key file and the site secret are throwaways made for this run and deleted with it. The pack
# is the synthetic test fixture.
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

# bc-admin as an operator runs it: the image's node, the work folder mounted, run as this user.
admin() {
  docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
    --user "$(id -u):$(id -g)" -v "$work:/work" "$image" server/dist/admin.js "$@"
}
admin keys init --keys /work/bc-keys.json >/dev/null || fail "bc-admin keys init failed"
admin keys rotate --keys /work/bc-keys.json >/dev/null 2>&1 || fail "bc-admin keys rotate failed"
cp "$root/server/sites.example.yaml" "$work/sites.yaml"
# Prints a throwaway site secret; this test does not call siteverify, so it is discarded.
admin site add --sites /work/sites.yaml --host smoke.localhost >/dev/null 2>&1 || fail "bc-admin site add failed"
admin site list --sites /work/sites.yaml | grep -q 'smoke.localhost' || fail "bc-admin site list does not show the new site"
echo "bc-admin: keys init, keys rotate, site add, site list ok"
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

# The widget: the bytes served must hash to the image's sri.json (the hashes a release publishes).
docker cp "$name:/app/widget/dist/sri.json" "$work/sri.json" >/dev/null || fail "no widget/dist/sri.json in the image"
for f in widget.js widget.worker.js; do
  curl -fsS -D "$work/$f.headers" -o "$work/$f" "http://127.0.0.1:${api_port}/$f" || fail "GET /$f failed"
  want="$(jq -er --arg f "$f" '.[$f].sri' "$work/sri.json")" || fail "sri.json has no hash for $f"
  got="sha384-$(openssl dgst -sha384 -binary "$work/$f" | openssl base64 -A)"
  [ "$got" = "$want" ] || fail "/$f hashes to $got, sri.json says $want"
  grep -qi '^content-type: text/javascript' "$work/$f.headers" || fail "/$f is not text/javascript"
  grep -qi '^cache-control: public, max-age=' "$work/$f.headers" || fail "/$f has no Cache-Control"
  grep -qi '^access-control-allow-origin: \*' "$work/$f.headers" || fail "/$f is not readable cross-origin"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -H "if-none-match: \"$want\"" "http://127.0.0.1:${api_port}/$f")"
  [ "$code" = "304" ] || fail "/$f with its ETag answered $code, expected 304"
  echo "widget: /$f ok ($want)"
done

echo "stopping with SIGTERM"
docker stop -t 30 "$name" >/dev/null
code="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
docker logs "$name" 2>&1 | grep -q 'shutting down' || fail "no drain log line after SIGTERM"
[ "$code" = "0" ] || fail "exit code $code after SIGTERM, expected 0"
echo "smoke test passed: healthy, /healthz ok, /metrics ok, widget ok, SIGTERM drained, exit 0"
