#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash deploy/build-standalone.sh
cargo build --locked --release -p gpudeck-agent
version=$(target/release/gpudeck-hub --version | awk '{print $2}')
mkdir -p target/server-bundles
archive="target/server-bundles/gpudeck-${version}-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m).tar.gz"
tar -czf "$archive" target/release/gpudeck-hub target/release/gpudeck-agent deploy/install-hub.sh deploy/install-agent.sh deploy/gpudeck-hub.service deploy/gpudeck-agent.service docs/QUICKSTART.md
echo "Server bundle: $archive"
sha256sum "$archive"
