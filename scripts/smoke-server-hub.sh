#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_dir=$(mktemp -d)
pid=''
cleanup() { if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true; fi; }
trap cleanup EXIT
export DATABASE_URL="sqlite://$task_dir/smoke.sqlite"
export GPUDECK_LISTEN=127.0.0.1:37946
export GPUDECK_SECURE_COOKIE=false
export GPUDECK_BOOTSTRAP_PASSWORD=SmokeTestOnly123456
export TOKIO_WORKER_THREADS=2
target/release/gpudeck-hub > "$task_dir/hub.log" 2>&1 &
pid=$!
healthy=false
for attempt in {1..30}; do
    if curl --noproxy '*' -fsS http://127.0.0.1:37946/healthz >/dev/null; then healthy=true; break; fi
    kill -0 "$pid" || { cat "$task_dir/hub.log"; exit 1; }
    sleep 1
done
[[ "$healthy" == true ]]
curl --noproxy '*' -fsS http://127.0.0.1:37946/ > "$task_dir/index.html"
grep -q '<!doctype html>' "$task_dir/index.html"
test "$(curl --noproxy '*' -s -o /dev/null -w '%{http_code}' http://127.0.0.1:37946/api/v1/missing)" = 404
test -s "$task_dir/smoke.sqlite"
echo 'Native Hub smoke test passed: SQLite startup, embedded Web, health and API boundaries.'
