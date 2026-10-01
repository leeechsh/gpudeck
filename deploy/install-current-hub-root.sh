#!/bin/bash
# One-time migration of this host's Compose SQLite Hub to systemd.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run this script with sudo.' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/.." && pwd)
binary="$repo/target/release/gpudeck-hub"
hub=deploy-gpudeck-hub-1
web=deploy-gpudeck-web-1
[[ -x "$binary" && -r "$repo/deploy/.env" ]] || { echo 'Build standalone Hub first; deploy/.env is required.' >&2; exit 1; }
[[ ! -e /var/lib/gpudeck/gpudeck.sqlite && ! -e /etc/gpudeck/hub.env ]] || { echo 'Existing standalone installation detected; refusing to overwrite data/config.' >&2; exit 1; }
for tool in docker curl systemctl getent install; do command -v "$tool" >/dev/null; done
# sudo drops DOCKER_HOST. Pin every operation, including rollback, to the
# shared daemon hosting this server's Compose deployment, not root's default.
docker_endpoint=${1:-unix:///home/metaiot/docker-shared/docker.sock}
docker() { command docker --host "$docker_endpoint" "$@"; }
echo "Source Docker endpoint: $docker_endpoint"
[[ $(docker inspect -f '{{.State.Running}}' "$hub") == true ]]
[[ $(docker inspect -f '{{.State.Running}}' "$web") == true ]]
"$binary" --version
backup="$repo/deploy/backups/standalone-$(date +%Y%m%d-%H%M%S)"
install -d -m 0700 "$backup"
cp "$repo/deploy/.env" "$backup/docker.env"
chmod 0600 "$backup/docker.env"
getent group gpudeck >/dev/null || groupadd --system gpudeck
id gpudeck >/dev/null 2>&1 || useradd --system --gid gpudeck --no-create-home --shell /usr/sbin/nologin gpudeck
install -d -o gpudeck -g gpudeck -m 0700 /var/lib/gpudeck
install -d -o root -g gpudeck -m 0750 /etc/gpudeck
install -o root -g root -m 0755 "$binary" /usr/local/bin/gpudeck-hub
install -o root -g root -m 0644 "$repo/deploy/gpudeck-hub.service" /etc/systemd/system/gpudeck-hub.service
# Preserve public URL, secure cookies and notification settings without evaluating shell input.
install -o root -g root -m 0600 "$repo/deploy/.env" /etc/gpudeck/hub.env
printf '\nDATABASE_URL=sqlite:///var/lib/gpudeck/gpudeck.sqlite\nGPUDECK_LISTEN=100.77.69.72:37935\n' >> /etc/gpudeck/hub.env
systemctl daemon-reload
stopped=false
rollback() {
    code=$?
    if [[ "$stopped" == true ]]; then
        systemctl disable --now gpudeck-hub.service || true
        docker start "$hub" "$web" || true
        echo "Cutover failed. Docker restarted; backup retained at $backup. Standalone files retained for inspection." >&2
    fi
    exit "$code"
}
trap rollback ERR
# Stop API writers first. A helper container opens the retained named volume,
# recovers any WAL and creates a consistent SQLite backup (never copy a live main file).
stopped=true
docker stop "$web" "$hub"
image=$(docker inspect -f '{{.Config.Image}}' "$hub")
helper="gpudeck-backup-$(date +%s)"
docker run --name "$helper" --user 65532:65532 --volumes-from "$hub" --entrypoint sqlite3 "$image" /data/gpudeck.sqlite ".backup /data/standalone-cutover.sqlite"
[[ $(docker run --rm --user 65532:65532 --volumes-from "$hub" --entrypoint sqlite3 "$image" /data/standalone-cutover.sqlite 'PRAGMA integrity_check;') == ok ]]
docker cp "$helper:/data/standalone-cutover.sqlite" "$backup/gpudeck.sqlite"
docker rm "$helper"
chmod 0600 "$backup/gpudeck.sqlite"
install -o gpudeck -g gpudeck -m 0600 "$backup/gpudeck.sqlite" /var/lib/gpudeck/gpudeck.sqlite
systemctl enable --now gpudeck-hub.service
healthy=false
for attempt in {1..30}; do
    if curl --noproxy '*' -fsS http://100.77.69.72:37935/healthz >/dev/null; then healthy=true; break; fi
    sleep 1
done
[[ "$healthy" == true ]]
curl --noproxy '*' -fsS http://100.77.69.72:37935/ | head -c 1024 | grep -q '<!doctype html>'
trap - ERR
echo "GPUDeck standalone Hub installed. Docker containers and their original data remain stopped for rollback. Backup: $backup"
echo 'Cookie security settings were preserved; Secure cookies require HTTPS.'
systemctl --no-pager --full status gpudeck-hub.service
