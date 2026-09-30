#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
    echo "This upgrader must run with sudo." >&2
    exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(dirname -- "$script_dir")
agent_binary="$repo_dir/target/release/gpudeck-agent"

test -x "$agent_binary" || { echo "Missing release agent binary: $agent_binary" >&2; exit 1; }
getent group gpudeck-agent >/dev/null || groupadd --system gpudeck-agent
id gpudeck-agent >/dev/null 2>&1 || useradd --system --gid gpudeck-agent --no-create-home --shell /usr/sbin/nologin gpudeck-agent

test -r /etc/gpudeck-agent.env || { echo "Missing /etc/gpudeck-agent.env" >&2; exit 1; }
chown root:gpudeck-agent /etc/gpudeck-agent.env
chmod 0640 /etc/gpudeck-agent.env

install -o root -g root -m 0755 "$agent_binary" /usr/local/bin/gpudeck-agent
install -o root -g root -m 0644 "$script_dir/gpudeck-agent.service" /etc/systemd/system/gpudeck-agent.service
systemctl daemon-reload
systemctl enable --now gpudeck-agent.service

echo "GPUDeck Agent upgraded and restarted."
systemctl --no-pager --full status gpudeck-agent.service
