#!/bin/bash
# Download verified server assets; no git, Node.js or Rust needed at runtime.
set -euo pipefail
component=''
version=latest
check=false
installer_args=()
usage() {
    echo 'Usage: sudo bash install-from-release.sh --component hub|agent [--version latest|vX.Y.Z] [--check] [installer options]'
    echo 'Hub: --listen IP:PORT --public-url URL --admin NAME'
    echo 'Agent: --config /absolute/path/node.env --hub-url URL'
}
while [[ $# -gt 0 ]]; do
    case "$1" in
        --component|--version)
            [[ $# -ge 2 ]] || { usage; exit 1; }
            case "$1" in --component) component=$2;; --version) version=$2;; esac
            shift 2;;
        --listen|--public-url|--admin|--config|--hub-url)
            [[ $# -ge 2 ]] || { usage; exit 1; }
            installer_args+=("$1" "$2"); shift 2;;
        --check) check=true; shift;;
        --help) usage; exit 0;;
        *) echo "Unknown option: $1" >&2; usage; exit 1;;
    esac
done
[[ "$component" == hub || "$component" == agent ]] || { usage; exit 1; }
[[ "$version" == latest || "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Version must be latest or vX.Y.Z.' >&2; exit 1; }
[[ $(uname -s) == Linux ]] || { echo 'Only Linux is supported.' >&2; exit 1; }
case $(uname -m) in x86_64|amd64) arch=x86_64;; aarch64|arm64) arch=aarch64;; *) echo 'Unsupported CPU architecture; expected x86-64 or ARM64.' >&2; exit 1;; esac
for tool in curl jq sha256sum tar mktemp; do command -v "$tool" >/dev/null || { echo "Required command missing: $tool" >&2; exit 1; }; done
if [[ "$check" != true && $(id -u) != 0 ]]; then echo 'Run with sudo, or use --check for download/config validation only.' >&2; exit 1; fi
task_dir=$(mktemp -d)
trap 'rm -rf -- "$task_dir"' EXIT
umask 0077
repo=leeechsh/gpudeck
api="https://api.github.com/repos/$repo/releases"
if [[ "$version" == latest ]]; then api+='/latest'; else api+="/tags/$version"; fi
curl_args=(--fail --show-error --silent --location --retry 3 --connect-timeout 15 --max-time 300 --proto '=https' --proto-redir '=https')
if ! curl "${curl_args[@]}" "$api" -o "$task_dir/release.json"; then
    echo "Unable to fetch published release $version. Tags/Actions artifacts are not downloadable Releases; check GitHub Releases and connectivity." >&2
    exit 1
fi
tag=$(jq -er 'select(.draft == false) | .tag_name' "$task_dir/release.json")
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Unsupported release tag.' >&2; exit 1; }
[[ "$version" == latest || "$tag" == "$version" ]] || { echo 'Release tag mismatch.' >&2; exit 1; }
number=${tag#v}
archive="gpudeck-$number-linux-$arch.tar.gz"
checksum="SHA256SUMS-$number-linux-$arch"
for name in "$archive" "$checksum"; do
    url=$(jq -er --arg name "$name" '[.assets[] | select(.name == $name)] | select(length == 1) | .[0].browser_download_url' "$task_dir/release.json") || { echo "Release $tag has no matching asset: $name" >&2; exit 1; }
    [[ "$url" == "https://github.com/$repo/releases/download/$tag/$name" ]] || { echo 'Unexpected asset download URL.' >&2; exit 1; }
    curl "${curl_args[@]}" "$url" -o "$task_dir/$name"
done
expected=$(awk -v name="$archive" '$2 == name {print $1}' "$task_dir/$checksum")
[[ "$expected" =~ ^[0-9a-fA-F]{64}$ ]] || { echo 'Missing or invalid bundle checksum.' >&2; exit 1; }
actual=$(sha256sum "$task_dir/$archive"); actual=${actual%% *}
[[ "${expected,,}" == "$actual" ]] || { echo 'Bundle SHA-256 mismatch; installation aborted.' >&2; exit 1; }
# Accept only the exact file layout shipped by our bundle builder; no links,
# absolute paths, traversal, extra files or arbitrary archive scripts.
tar -tzf "$task_dir/$archive" > "$task_dir/members"
while IFS= read -r member; do
    case "$member" in target/release/gpudeck-hub|target/release/gpudeck-agent|deploy/install-hub.sh|deploy/install-agent.sh|deploy/gpudeck-hub.service|deploy/gpudeck-agent.service|docs/QUICKSTART.md) ;; *) echo "Unexpected archive member: $member" >&2; exit 1;; esac
done < "$task_dir/members"
[[ $(wc -l < "$task_dir/members") == 7 && $(sort -u "$task_dir/members" | wc -l) == 7 ]] || { echo 'Incomplete or duplicate archive members.' >&2; exit 1; }
tar -tvzf "$task_dir/$archive" | awk 'substr($0,1,1)!="-" {bad=1} END {exit bad}' || { echo 'Archive links or special files are not allowed.' >&2; exit 1; }
mkdir "$task_dir/package"
tar --no-same-owner --no-same-permissions -xzf "$task_dir/$archive" -C "$task_dir/package"
if [[ "$check" == true ]]; then installer_args+=(--check); fi
echo "Verified GPUDeck $tag Linux $arch; installing $component. Requires compatible glibc and systemd."
bash "$task_dir/package/deploy/install-$component.sh" "${installer_args[@]}"
