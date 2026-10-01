#!/bin/bash
# Accept the .env downloaded from Hub node registration. Never execute it.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
binary="$here/../target/release/gpudeck-agent"
config=''
hub_url=''
check=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --binary|--config|--hub-url)
            [[ $# -ge 2 ]] || { echo "Missing value: $1" >&2; exit 1; }
            case "$1" in --binary) binary=$2;; --config) config=$2;; --hub-url) hub_url=$2;; esac
            shift 2;;
        --check) check=true; shift;;
        --help) echo 'Usage: sudo bash install-agent.sh --config NODE.env [--binary PATH] [--hub-url http://HUB:37935] [--check]'; exit 0;;
        *) echo "Unknown option: $1" >&2; exit 1;;
    esac
done
[[ -x "$binary" && -f "$config" && -r "$config" ]] || { echo 'Executable Agent binary and readable node .env required.' >&2; exit 1; }
[[ -r "$here/gpudeck-agent.service" ]] || { echo 'Missing gpudeck-agent.service beside installer.' >&2; exit 1; }
declare -A settings=()
while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    [[ -n "$line" && "$line" != \#* ]] || continue
    [[ "$line" == *=* ]] || { echo 'Invalid config line.' >&2; exit 1; }
    key=${line%%=*}; value=${line#*=}
    case "$key" in GPUDECK_HUB_URL|GPUDECK_NODE_ID|GPUDECK_AGENT_TOKEN|GPUDECK_SAMPLE_SECONDS|RUST_LOG) ;; *) echo "Unsupported config key: $key" >&2; exit 1;; esac
    [[ ! -v "settings[$key]" ]] || { echo "Duplicate config key: $key" >&2; exit 1; }
    settings[$key]=$value
done < "$config"
[[ -z "$hub_url" ]] || settings[GPUDECK_HUB_URL]=$hub_url
origin_pattern='^https?://(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9][a-zA-Z0-9.-]*)(:[0-9]{1,5})?/?$'
[[ ${settings[GPUDECK_HUB_URL]:-} =~ $origin_pattern ]] || { echo 'Invalid Hub URL.' >&2; exit 1; }
[[ ${settings[GPUDECK_NODE_ID]:-} =~ ^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$ ]] || { echo 'Invalid Node ID.' >&2; exit 1; }
[[ ${settings[GPUDECK_AGENT_TOKEN]:-} =~ ^[a-zA-Z0-9_-]{32,256}$ ]] || { echo 'Invalid Agent token.' >&2; exit 1; }
seconds=${settings[GPUDECK_SAMPLE_SECONDS]:-5}
[[ "$seconds" =~ ^[0-9]{1,5}$ ]] && (( 10#$seconds >= 1 && 10#$seconds <= 3600 )) || { echo 'Invalid sampling interval.' >&2; exit 1; }
log=${settings[RUST_LOG]:-gpudeck_agent=info}
[[ "$log" =~ ^[a-zA-Z0-9_,=:-]+$ ]] || { echo 'Invalid log filter.' >&2; exit 1; }
if [[ "$check" == true ]]; then echo 'Agent config valid; no changes made.'; exit 0; fi
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
for tool in systemctl install getent curl nvidia-smi; do command -v "$tool" >/dev/null; done
[[ -d /run/systemd/system ]] || { echo 'A running systemd host is required.' >&2; exit 1; }
for path in /etc/gpudeck-agent.env /usr/local/bin/gpudeck-agent /etc/systemd/system/gpudeck-agent.service; do
    [[ ! -e "$path" ]] || { echo "Existing installation: $path; refusing to replace node identity." >&2; exit 1; }
done
curl --noproxy '*' --connect-timeout 5 --max-time 10 -fsS "${settings[GPUDECK_HUB_URL]%/}/healthz" >/dev/null
nvidia-smi -L >/dev/null
getent group gpudeck-agent >/dev/null || groupadd --system gpudeck-agent
id gpudeck-agent >/dev/null 2>&1 || useradd --system --gid gpudeck-agent --no-create-home --shell /usr/sbin/nologin gpudeck-agent
umask 0077
printf '%s\n' "GPUDECK_HUB_URL=${settings[GPUDECK_HUB_URL]}" "GPUDECK_NODE_ID=${settings[GPUDECK_NODE_ID]}" "GPUDECK_AGENT_TOKEN=${settings[GPUDECK_AGENT_TOKEN]}" "GPUDECK_SAMPLE_SECONDS=$seconds" "RUST_LOG=$log" > /etc/gpudeck-agent.env
chown root:gpudeck-agent /etc/gpudeck-agent.env
chmod 0640 /etc/gpudeck-agent.env
install -o root -g root -m 0755 "$binary" /usr/local/bin/gpudeck-agent
install -o root -g root -m 0644 "$here/gpudeck-agent.service" /etc/systemd/system/gpudeck-agent.service
systemctl daemon-reload
systemctl enable --now gpudeck-agent.service
sleep 2
systemctl is-active --quiet gpudeck-agent.service || { systemctl disable --now gpudeck-agent.service || true; echo 'Agent startup failed; check journalctl -u gpudeck-agent. Files retained for diagnosis.' >&2; exit 1; }
echo 'Agent started. Confirm node online in Hub after about 5 seconds; service activity alone does not prove token acceptance.'
echo 'Remove your downloaded node .env securely after confirming installation; the source file was not deleted.'
