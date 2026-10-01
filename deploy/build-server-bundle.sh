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
platform="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)"
for component in hub agent; do
    gzip -n -c "target/release/gpudeck-$component" > "target/server-bundles/gpudeck-$component-$version-$platform.gz"
done
(cd target/server-bundles && sha256sum "gpudeck-$version-$platform.tar.gz" "gpudeck-hub-$version-$platform.gz" "gpudeck-agent-$version-$platform.gz" > "SHA256SUMS-$version-$platform")
