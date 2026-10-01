#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -d node_modules ]; then npm ci; fi
npm run build
cargo build --locked --release -p gpudeck-hub
target/release/gpudeck-hub --version
