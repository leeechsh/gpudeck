#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "This installer must run with sudo." >&2
    exit 1
fi

registration_file=${1:-/tmp/racktop-node-registration.json}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname -- "$script_dir")
agent_binary="$repo_dir/target/release/racktop-agent"

test -x "$agent_binary" || { echo "Missing release agent binary: $agent_binary" >&2; exit 1; }
test -r "$registration_file" || { echo "Missing node registration: $registration_file" >&2; exit 1; }

node_id=$(jq -er '.id' "$registration_file")
agent_token=$(jq -er '.token' "$registration_file")

getent group racktop-agent >/dev/null || groupadd --system racktop-agent
id racktop-agent >/dev/null 2>&1 || useradd --system --gid racktop-agent --no-create-home --shell /usr/sbin/nologin racktop-agent

install -o root -g root -m 0755 "$agent_binary" /usr/local/bin/racktop-agent
install -o root -g racktop-agent -m 0640 /dev/null /etc/racktop-agent.env
printf '%s\n' \
    'RACKTOP_HUB_URL=http://100.77.69.72:37935' \
    "RACKTOP_NODE_ID=$node_id" \
    "RACKTOP_AGENT_TOKEN=$agent_token" \
    'RACKTOP_SAMPLE_SECONDS=5' \
    'RUST_LOG=racktop_agent=info' > /etc/racktop-agent.env
chown root:racktop-agent /etc/racktop-agent.env
chmod 0640 /etc/racktop-agent.env

install -o root -g root -m 0644 "$script_dir/racktop-agent.service" /etc/systemd/system/racktop-agent.service
systemctl daemon-reload
systemctl enable --now racktop-agent.service
rm -f "$registration_file"

echo "RackTop Agent installed and started."
systemctl --no-pager --full status racktop-agent.service
