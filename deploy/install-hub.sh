#!/bin/bash
# Fresh Linux/systemd installation; never migrates or overwrites existing data.
set -euo pipefail
export LC_ALL=C
here=$(cd "$(dirname "$0")" && pwd)
binary="$here/../target/release/gpudeck-hub"
listen=127.0.0.1:37935
url=http://localhost:37935
admin=admin
check=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --binary|--listen|--public-url|--admin)
            [[ $# -ge 2 ]] || { echo "Missing value: $1" >&2; exit 1; }
            case "$1" in --binary) binary=$2;; --listen) listen=$2;; --public-url) url=$2;; --admin) admin=$2;; esac
            shift 2;;
        --check) check=true; shift;;
        --help) echo 'Usage: sudo bash install-hub.sh [--binary PATH] [--listen IP:PORT] [--public-url https://host] [--admin NAME] [--check]'; exit 0;;
        *) echo "Unknown option: $1" >&2; exit 1;;
    esac
done
[[ -x "$binary" ]] || { echo 'Missing executable Hub binary.' >&2; exit 1; }
[[ -r "$here/gpudeck-hub.service" ]] || { echo 'Missing gpudeck-hub.service beside installer.' >&2; exit 1; }
[[ "$listen" =~ ^[0-9.]+:[0-9]{1,5}$ || "$listen" =~ ^\[[0-9a-fA-F:]+\]:[0-9]{1,5}$ ]] || { echo 'Listen must be numeric IP:PORT (IPv6 in brackets).' >&2; exit 1; }
port=${listen##*:}
(( 10#$port >= 1 && 10#$port <= 65535 )) || { echo 'Invalid port.' >&2; exit 1; }
origin_pattern='^https?://(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*)(:[0-9]{1,5})?/?$'
[[ "$url" =~ $origin_pattern ]] || { echo 'Public URL must be an HTTP(S) origin without credentials/path.' >&2; exit 1; }
[[ "$admin" =~ ^[a-zA-Z0-9_.-]{1,64}$ ]] || { echo 'Invalid administrator name.' >&2; exit 1; }
"$binary" --version
if [[ "$check" == true ]]; then echo 'Hub arguments valid; no changes made.'; exit 0; fi
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
for tool in systemctl install getent curl; do command -v "$tool" >/dev/null; done
[[ -d /run/systemd/system ]] || { echo 'A running systemd host is required.' >&2; exit 1; }
for path in /etc/gpudeck /var/lib/gpudeck /usr/local/bin/gpudeck-hub /etc/systemd/system/gpudeck-hub.service; do
    [[ ! -e "$path" ]] || { echo "Existing installation: $path; use the upgrade workflow instead." >&2; exit 1; }
done
read -r -s -p 'Initial administrator password (at least 8 ASCII characters): ' password
echo
read -r -s -p 'Confirm password: ' confirmation
echo
[[ "$password" == "$confirmation" && "$password" =~ ^[[:print:]]{8,}$ ]] || { echo 'Passwords differ or do not meet the minimum.' >&2; exit 1; }
unset confirmation
getent group gpudeck >/dev/null || groupadd --system gpudeck
id gpudeck >/dev/null 2>&1 || useradd --system --gid gpudeck --no-create-home --shell /usr/sbin/nologin gpudeck
install -d -o root -g gpudeck -m 0750 /etc/gpudeck
install -d -o gpudeck -g gpudeck -m 0700 /var/lib/gpudeck
umask 0077
printf '%s' "$password" > /etc/gpudeck/bootstrap-password
unset password
chown root:gpudeck /etc/gpudeck/bootstrap-password
chmod 0640 /etc/gpudeck/bootstrap-password
secure=false
[[ "$url" != https://* ]] || secure=true
printf '%s\n' "DATABASE_URL=sqlite:///var/lib/gpudeck/gpudeck.sqlite" "GPUDECK_LISTEN=$listen" "GPUDECK_PUBLIC_URL=$url" "GPUDECK_SECURE_COOKIE=$secure" "GPUDECK_BOOTSTRAP_ADMIN=$admin" 'GPUDECK_BOOTSTRAP_PASSWORD_FILE=/etc/gpudeck/bootstrap-password' 'RUST_LOG=gpudeck_hub=info,tower_http=info' > /etc/gpudeck/hub.env
install -o root -g root -m 0755 "$binary" /usr/local/bin/gpudeck-hub
install -o root -g root -m 0644 "$here/gpudeck-hub.service" /etc/systemd/system/gpudeck-hub.service
systemctl daemon-reload
systemctl enable --now gpudeck-hub.service
host=${listen%:*}
[[ "$host" != 0.0.0.0 ]] || host=127.0.0.1
[[ "$host" != '[::]' ]] || host='[::1]'
for attempt in {1..30}; do
    if systemctl is-active --quiet gpudeck-hub.service && curl --noproxy '*' -fsS "http://$host:$port/healthz" >/dev/null; then
        rm /etc/gpudeck/bootstrap-password
        echo "Hub ready: $url (listen $listen). Bootstrap password file removed."
        exit 0
    fi
    sleep 1
done
systemctl disable --now gpudeck-hub.service || true
echo 'Hub startup failed; files retained for diagnosis, no existing data overwritten. Check journalctl -u gpudeck-hub.' >&2
exit 1
