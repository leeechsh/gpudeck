#!/bin/bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/.." && pwd)
binary="$repo/target/release/gpudeck-hub"
[[ -x "$binary" && -f /usr/local/bin/gpudeck-hub && -f /var/lib/gpudeck/gpudeck.sqlite && -f /etc/gpudeck/hub.env ]]
systemctl is-active --quiet gpudeck-hub.service
"$binary" --version
backup="/var/lib/gpudeck/backups/upgrade-$(date +%Y%m%d-%H%M%S)"
install -d -o root -g root -m 0700 "$backup"
cp /usr/local/bin/gpudeck-hub "$backup/gpudeck-hub"
cp /etc/gpudeck/hub.env "$backup/hub.env"
install -o root -g root -m 0755 "$binary" /usr/local/bin/gpudeck-hub.new
rollback() {
    code=$?
    systemctl stop gpudeck-hub.service || true
    install -o root -g root -m 0755 "$backup/gpudeck-hub" /usr/local/bin/gpudeck-hub
    systemctl start gpudeck-hub.service || true
    echo "Upgrade failed; previous executable restored. Backup: $backup" >&2
    exit "$code"
}
trap rollback ERR
systemctl stop gpudeck-hub.service
# Copy main DB plus any remaining WAL/SHM only after all writers stopped.
for file in gpudeck.sqlite gpudeck.sqlite-wal gpudeck.sqlite-shm; do
    if [[ -f "/var/lib/gpudeck/$file" ]]; then cp "/var/lib/gpudeck/$file" "$backup/$file"; fi
done
mv /usr/local/bin/gpudeck-hub.new /usr/local/bin/gpudeck-hub
systemctl start gpudeck-hub.service
healthy=false
for attempt in {1..30}; do
    if curl --noproxy '*' -fsS http://100.77.69.72:37935/healthz >/dev/null; then healthy=true; break; fi
    sleep 1
done
[[ "$healthy" == true ]]
trap - ERR
echo "Upgrade complete. Data/config retained. Backup: $backup"
systemctl --no-pager --full status gpudeck-hub.service
