#!/bin/bash
set -euo pipefail
assets=$(realpath "${1:?asset directory required}")
tag=${RELEASE_TAG:?release tag required}
version=${tag#v}
[[ "$tag" == "v$(node -p "require('./package.json').version")" ]]
for arch in x86_64 aarch64; do
    for file in "gpudeck-$version-linux-$arch.tar.gz" "gpudeck-hub-$version-linux-$arch.gz" "gpudeck-agent-$version-linux-$arch.gz" "SHA256SUMS-$version-linux-$arch"; do
        test -s "$assets/$file"
    done
    (cd "$assets" && sha256sum -c "SHA256SUMS-$version-linux-$arch")
done
# Never mutate an already-published release or unrelated desktop assets.
if gh release view "$tag" --json isDraft --jq .isDraft > /tmp/gpudeck-release-draft-state; then
    [[ $(< /tmp/gpudeck-release-draft-state) == true ]] || { echo 'Release already published; refusing to overwrite assets.' >&2; exit 1; }
else
    gh release create "$tag" --verify-tag --draft --title "GPUDeck $tag Linux Server" --notes 'Linux server packages; publication pending asset verification.'
fi
upload=()
for arch in x86_64 aarch64; do
    upload+=("$assets/gpudeck-$version-linux-$arch.tar.gz" "$assets/gpudeck-hub-$version-linux-$arch.gz" "$assets/gpudeck-agent-$version-linux-$arch.gz" "$assets/SHA256SUMS-$version-linux-$arch")
done
gh release upload "$tag" "${upload[@]}" --clobber
verify_dir=$(mktemp -d)
for file in "${upload[@]}"; do gh release download "$tag" --pattern "$(basename "$file")" --dir "$verify_dir"; done
for arch in x86_64 aarch64; do (cd "$verify_dir" && sha256sum -c "SHA256SUMS-$version-linux-$arch"); done
# Match GitHub Assets digests against locally verified checksums.
gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" > "$verify_dir/metadata.json"
node scripts/verify-server-assets.mjs "$assets" "$verify_dir/metadata.json"
notes="$verify_dir/notes.md"
{
    printf '## 主要更新\n\n- 自动构建并验证 Linux x86-64 与 ARM64 的 Hub 和 Agent。\n- 提供包含安装脚本的服务器部署包。\n\n## 下载\n\n'
    for arch in x86_64 aarch64; do
        printf -- '- `gpudeck-%s-linux-%s.tar.gz`：完整部署包。\n' "$version" "$arch"
        printf -- '- `gpudeck-hub-%s-linux-%s.gz`：内嵌 Web 的 Hub 可执行文件。\n' "$version" "$arch"
        printf -- '- `gpudeck-agent-%s-linux-%s.gz`：Agent 可执行文件。\n' "$version" "$arch"
        printf -- '- `SHA256SUMS-%s-linux-%s`：文件校验清单。\n' "$version" "$arch"
    done
    printf '\n基于 Ubuntu 22.04/glibc 原生构建，运行需兼容的 Linux 环境；ARM64 文件名使用 aarch64。独立程序需 gunzip 解压并 chmod +x。非桌面安装包，非全静态二进制。\n'
} > "$notes"
gh release edit "$tag" --draft=false --latest --notes-file "$notes"
gh release view "$tag" --json url,isDraft,assets
