#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "This installer must run with sudo." >&2
    exit 1
fi

registration_file=${1:-/tmp/gpudeck-node-registration.json}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname -- "$script_dir")
agent_binary="$repo_dir/target/release/gpudeck-agent"

test -x "$agent_binary" || { echo "Missing release agent binary: $agent_binary" >&2; exit 1; }
test -r "$registration_file" || { echo "Missing node registration: $registration_file" >&2; exit 1; }

node_id=$(jq -er '.id' "$registration_file")
agent_token=$(jq -er '.token' "$registration_file")

getent group gpudeck-agent >/dev/null || groupadd --system gpudeck-agent
id gpudeck-agent >/dev/null 2>&1 || useradd --system --gid gpudeck-agent --no-create-home --shell /usr/sbin/nologin gpudeck-agent

install -o root -g root -m 0755 "$agent_binary" /usr/local/bin/gpudeck-agent
install -o root -g gpudeck-agent -m 0640 /dev/null /etc/gpudeck-agent.env
printf '%s\n' \
    'GPUDECK_HUB_URL=http://100.77.69.72:37935' \
    "GPUDECK_NODE_ID=$node_id" \
    "GPUDECK_AGENT_TOKEN=$agent_token" \
    'GPUDECK_SAMPLE_SECONDS=5' \
    'RUST_LOG=gpudeck_agent=info' > /etc/gpudeck-agent.env
chown root:gpudeck-agent /etc/gpudeck-agent.env
chmod 0640 /etc/gpudeck-agent.env

install -o root -g root -m 0644 "$script_dir/gpudeck-agent.service" /etc/systemd/system/gpudeck-agent.service
systemctl daemon-reload
systemctl enable --now gpudeck-agent.service
rm -f "$registration_file"

echo "GPUDeck Agent installed and started."
systemctl --no-pager --full status gpudeck-agent.service
