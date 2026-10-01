#!/bin/bash
# Update an existing standard systemd installation; never execute downloaded scripts.
set -Eeuo pipefail
umask 077
component=''
version=latest
check=false
health_url=''
download_prefix=''
usage() { echo 'Usage: sudo bash update-from-release.sh --component hub|agent [--version latest|vX.Y.Z] [--download-prefix https://gh-proxy.com/] [--health-url http://IP:PORT/healthz] [--check]'; }
while [[ $# -gt 0 ]]; do
    case "$1" in
        --component|--version|--health-url|--download-prefix)
            [[ $# -ge 2 ]] || { usage; exit 1; }
            case "$1" in --component) component=$2;; --version) version=$2;; --health-url) health_url=$2;; --download-prefix) download_prefix=$2;; esac
            shift 2;;
        --check) check=true; shift;;
        --help) usage; exit 0;;
        *) usage; exit 1;;
    esac
done
[[ "$component" == hub || "$component" == agent ]] || { usage; exit 1; }
if [[ -n "$download_prefix" ]]; then
    [[ "$download_prefix" == https://gh-proxy.com || "$download_prefix" == https://gh-proxy.com/ ]] || { echo 'Supported download prefix: https://gh-proxy.com/' >&2; exit 1; }
    download_prefix=https://gh-proxy.com/
    echo 'Using third-party GitHub download proxy: https://gh-proxy.com/'
fi
[[ "$version" == latest || "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid version.' >&2; exit 1; }
[[ $(uname -s) == Linux ]] || { echo 'Only Linux is supported.' >&2; exit 1; }
case $(uname -m) in x86_64|amd64) arch=x86_64;; aarch64|arm64) arch=aarch64;; *) echo 'Unsupported architecture.' >&2; exit 1;; esac
for tool in curl jq sha256sum gzip mktemp timeout; do command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }; done
if [[ "$check" != true && $(id -u) != 0 ]]; then echo 'Run with sudo, or use --check.' >&2; exit 1; fi
task_dir=$(mktemp -d /tmp/gpudeck-update.XXXXXX)
backup=''
changed=false
service="gpudeck-$component.service"
binary="/usr/local/bin/gpudeck-$component"
cleanup() { rm -rf -- "$task_dir"; }
rollback() {
    local code=$1
    trap - ERR INT TERM
    if [[ "$changed" == true ]]; then
        echo "Update failed; restoring executable. Backup: $backup" >&2
        systemctl stop "$service" || true
        if install -o root -g root -m 0755 "$backup/gpudeck-$component" "$binary.rollback" && mv -f "$binary.rollback" "$binary"; then
            systemctl start "$service" || echo 'Unable to restart previous service; manual recovery required.' >&2
        else echo 'Unable to restore executable; manual recovery required.' >&2; fi
        echo 'Database/config are NOT automatically restored. A newer version may have migrated data; review logs and the retained backup before recovery.' >&2
    fi
    exit "$code"
}
trap cleanup EXIT
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM
repo=leeechsh/gpudeck
api="https://api.github.com/repos/$repo/releases"
if [[ "$version" == latest ]]; then api+='/latest'; else api+="/tags/$version"; fi
curl_args=(--fail --show-error --silent --location --retry 3 --connect-timeout 15 --max-time 300 --proto '=https' --proto-redir '=https')
curl "${curl_args[@]}" "${download_prefix}${api}" -o "$task_dir/release.json"
tag=$(jq -er 'select(.draft == false) | .tag_name' "$task_dir/release.json")
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid release tag.' >&2; exit 1; }
[[ "$version" == latest || "$tag" == "$version" ]] || { echo 'Release tag mismatch.' >&2; exit 1; }
number=${tag#v}
asset="gpudeck-$component-$number-linux-$arch.gz"
checksum="SHA256SUMS-$number-linux-$arch"
for name in "$asset" "$checksum"; do
    url=$(jq -er --arg name "$name" '[.assets[] | select(.name == $name)] | select(length == 1) | .[0].browser_download_url' "$task_dir/release.json")
    [[ "$url" == "https://github.com/$repo/releases/download/$tag/$name" ]] || { echo 'Unexpected download URL.' >&2; exit 1; }
    curl "${curl_args[@]}" "${download_prefix}${url}" -o "$task_dir/$name"
done
expected=$(awk -v name="$asset" '$2 == name {print $1}' "$task_dir/$checksum")
[[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || { echo 'Missing/invalid checksum.' >&2; exit 1; }
actual=$(sha256sum "$task_dir/$asset"); actual=${actual%% *}
[[ "${expected,,}" == "$actual" ]] || { echo 'SHA-256 mismatch; service unchanged.' >&2; exit 1; }
gzip -dc "$task_dir/$asset" > "$task_dir/new-binary"
chmod 0755 "$task_dir/new-binary"
new_version=$(timeout 5 env -i PATH="$PATH" "$task_dir/new-binary" --version)
[[ "$new_version" == "gpudeck-$component $number" ]] || { echo 'Executable version mismatch.' >&2; exit 1; }
echo "Verified $new_version ($arch)."
if [[ "$check" == true ]]; then echo 'Check only: no installation, service, configuration or database changes.'; exit 0; fi
command -v flock >/dev/null
exec 9>"/run/gpudeck-$component-update.lock"
flock -n 9 || { echo 'Another update is running.' >&2; exit 1; }
[[ -f "$binary" && ! -L "$binary" ]] || { echo 'Standard installation missing.' >&2; exit 1; }
if [[ "$component" == hub ]]; then config=/etc/gpudeck/hub.env; else config=/etc/gpudeck-agent.env; fi
[[ -f "$config" && ! -L "$config" ]]
[[ $(systemctl show "$service" --property=ExecStart --value) == *"path=$binary ;"* ]] || { echo 'Custom ExecStart is unsupported.' >&2; exit 1; }
systemctl is-active --quiet "$service"
old_version=$(timeout 5 env -i PATH="$PATH" "$binary" --version 2>/dev/null) || old_version='unknown legacy version'
old_number=''
if [[ "$old_version" =~ ^gpudeck-$component\ ([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    old_number=${BASH_REMATCH[1]}
elif [[ "$component" != agent ]]; then echo 'Cannot determine installed Hub version.' >&2; exit 1;
else echo 'Legacy Agent: installed version unknown; downgrade detection unavailable.' >&2; fi
if [[ "$old_number" == "$number" ]]; then echo 'Already up to date.'; exit 0; fi
if [[ -n "$old_number" ]]; then
    [[ $(printf '%s\n%s\n' "$old_number" "$number" | sort -V | tail -n 1) == "$number" ]] || { echo 'Downgrades are refused.' >&2; exit 1; }
fi
if [[ "$component" == hub ]]; then
    # Parse data as text, never source/eval the environment file.
    database=$(sed -n 's/^DATABASE_URL=//p' "$config")
    [[ "$database" == sqlite:///var/lib/gpudeck/gpudeck.sqlite && -f /var/lib/gpudeck/gpudeck.sqlite ]] || { echo 'Custom database path unsupported; use manual upgrade.' >&2; exit 1; }
    if [[ -z "$health_url" ]]; then
        listen=$(sed -n 's/^GPUDECK_LISTEN=//p' "$config")
        [[ "$listen" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]+$ ]] || { echo 'Supply --health-url for custom/IPv6 listeners.' >&2; exit 1; }
        listen=${listen/#0.0.0.0:/127.0.0.1:}
        health_url="http://$listen/healthz"
    fi
    [[ "$health_url" == http://* || "$health_url" == https://* ]]
    curl --noproxy '*' -fsS --connect-timeout 3 --max-time 5 "$health_url" >/dev/null
fi
backup=$(mktemp -d "/var/lib/gpudeck-$component-update.XXXXXX")
cp -p "$binary" "$backup/gpudeck-$component"
cp -p "$config" "$backup/$(basename "$config")"
systemctl cat "$service" > "$backup/service.txt"
install -o root -g root -m 0755 "$task_dir/new-binary" "$binary.new"
changed=true
systemctl stop "$service"
if [[ "$component" == hub ]]; then
    for file in gpudeck.sqlite gpudeck.sqlite-wal gpudeck.sqlite-shm; do
        if [[ -f "/var/lib/gpudeck/$file" ]]; then cp -p "/var/lib/gpudeck/$file" "$backup/$file"; fi
    done
fi
mv -f "$binary.new" "$binary"
systemctl start "$service"
healthy=false
for attempt in {1..15}; do
    if systemctl is-active --quiet "$service"; then
        if [[ "$component" == hub ]]; then
            if curl --noproxy '*' -fsS --connect-timeout 2 --max-time 2 "$health_url" >/dev/null; then healthy=true; break; fi
        else
            # Agent has no health endpoint; stable process != confirmed Hub telemetry.
            agent_pid=$(systemctl show "$service" --property=MainPID --value)
            sleep 5
            if [[ "$agent_pid" =~ ^[1-9][0-9]*$ ]] && systemctl is-active --quiet "$service" && [[ $(systemctl show "$service" --property=MainPID --value) == "$agent_pid" ]]; then healthy=true; break; fi
        fi
    fi
    sleep 1
done
if [[ "$healthy" != true ]]; then echo 'Service health check failed.' >&2; rollback 1; fi
changed=false
echo "Updated $old_version -> $new_version. Backup retained: $backup"
if [[ "$component" == agent ]]; then echo 'Confirm node telemetry/last-seen in Hub; process health alone does not prove successful reporting.'; fi
