# 新服务器快速部署（Linux + systemd）

运行机器只需 Linux/systemd、curl、CA 证书；GPU 节点还需 NVIDIA 驱动及可用的 `nvidia-smi`。安装需要 sudo，服务使用独立非 root 用户。无需 Docker、数据库服务、Node.js 或 Rust 运行环境。

## 1. 在构建机器生成部署包

### 自动下载部署（无需本地编译）

下载仓库提供的部署入口，建议先审阅脚本再用 sudo 执行：

```bash
curl -fL --proto '=https' --proto-redir '=https' \
  https://raw.githubusercontent.com/leeechsh/gpudeck/main/deploy/install-from-release.sh \
  -o install-from-release.sh
```

Hub 示例（替换为自己的 IP；安装时交互输入初始管理员密码）：

```bash
sudo bash install-from-release.sh --component hub --version latest \
  --listen 100.100.100.10:37935 --public-url http://100.100.100.10:37935
```

Agent 示例（先在 Hub 注册节点并下载 `.env`）：

```bash
sudo bash install-from-release.sh --component agent --version latest \
  --config /absolute/path/node.env --hub-url http://100.100.100.10:37935
```

入口自动识别 Linux x86_64/aarch64（含 amd64/arm64 别名），查询已公开 Release，下载完整部署包与对应 SHA256SUMS，通过校验和归档安全检查后执行原首次安装脚本。依赖 Bash、curl、jq、tar、sha256sum；运行需兼容的 glibc/systemd。不会自动安装系统依赖，也不会覆盖已有部署。

指定版本可用 `--version v2.11.0`（该版本须已公开且有完整附件）；`--check` 仅下载校验并检查参数，不修改服务。`latest` 可能没有新格式附件，此时脚本会明确报错，不回退到未经校验的下载。凭据不上传到 GitHub。互联网代理仍遵循 curl 的环境配置。

### 从源码构建

也可从 GitHub Releases 下载与机器架构匹配的完整部署包：`gpudeck-版本-linux-x86_64.tar.gz` 或 `gpudeck-版本-linux-aarch64.tar.gz`。标签触发双架构原生构建，通过测试与校验后自动发布；以实际可见附件为准。CI 使用 Ubuntu 22.04/glibc，并非全静态或 Alpine/musl 包。

构建机器需要 Node.js/npm、Rust、C 编译器、tar。目标机器须与构建机 CPU 架构及 Linux/glibc 兼容；不是跨平台完全静态程序。

```bash
git clone https://github.com/leeechsh/gpudeck.git
cd gpudeck
bash deploy/build-server-bundle.sh
```

将 `target/server-bundles/` 中生成的 `.tar.gz` 复制到新服务器，解压后进入解压目录（例如先创建 `gpudeck-server`，使用 `tar -xzf 包名.tar.gz -C gpudeck-server`）。包中没有密码、节点 Token 或数据库。

## 2. 在 Hub 新服务器安装

仅 Tailscale/可信内网 HTTP 示例（将 IP 换成新 Hub 的地址）：

```bash
sudo bash deploy/install-hub.sh \
  --listen 100.100.100.10:37935 \
  --public-url http://100.100.100.10:37935 \
  --admin admin
```

脚本交互读取管理员密码两次，不将密码放入命令行或日志；首次安装要求至少 8 个可打印 ASCII 字符。默认用户名 `admin`，无默认密码。安装后创建 `/var/lib/gpudeck/gpudeck.sqlite`、`/etc/gpudeck/hub.env` 和 `gpudeck-hub.service`，健康检查成功后移除初始化密码文件。

HTTPS 反向代理示例：

```bash
sudo bash deploy/install-hub.sh \
  --listen 127.0.0.1:37935 \
  --public-url https://gpudeck.example.org
```

此命令不会自动配置 HTTPS、DNS、FRP、防火墙或 Tailscale；须另行配置代理转发到 Hub。`https://` 公网 URL 自动启用 Secure Cookie，`http://` 自动关闭；HTTP 仅用于可信内网，不建议公开暴露。Agent 必须使用从节点可达的 URL。

## 3. 在每台 GPU 新服务器安装 Agent

管理员登录 Hub，打开“管理面板 → 注册服务器节点”，为每台物理服务器独立注册，并下载 `.env`，复制到对应 GPU 服务器。Token 仅显示一次，禁止多台服务器共用身份。

在解压目录执行：

```bash
sudo bash deploy/install-agent.sh --config /absolute/path/node.env
```

若下载配置中的公网地址不可达，可改用 Hub 的 Tailscale 地址：

```bash
sudo bash deploy/install-agent.sh \
  --config /absolute/path/node.env \
  --hub-url http://100.100.100.10:37935
```

脚本检查配置格式、Hub 健康和 NVIDIA 驱动，安装 `/usr/local/bin/gpudeck-agent`、权限为 0640 的 `/etc/gpudeck-agent.env` 及 `gpudeck-agent.service`。配置不会作为 shell 执行，原下载文件不会自动删除；安装确认后请安全处理原凭据文件。

## 4. 检查

```bash
sudo systemctl status gpudeck-hub      # Hub 主机
sudo journalctl -u gpudeck-hub -n 30 --no-pager
sudo systemctl status gpudeck-agent    # GPU 主机
sudo journalctl -u gpudeck-agent -n 30 --no-pager
```

Hub 约 5 秒后应显示节点在线。Agent 服务进程运行不等于凭据认证成功，应以 Hub 在线状态及日志为准。若某些进程受 `/proc` 隐私配置限制，Agent 可能无法采集完整用户进程。

两个安装脚本均支持 `--check` 做无写入的参数检查，支持 `--binary PATH` 指定单独拷贝的程序；脚本旁需要保留对应 `.service` 文件。拒绝覆盖已有程序、数据库、配置或服务；安装失败保留文件供排查，不自动删除数据。已有部署不要重复执行首次安装。

### 更新已有服务

在已安装的服务器下载 `deploy/update-from-release.sh`（随包含此功能的分支合并 main 后可使用以下链接）：

```bash
curl -fL https://raw.githubusercontent.com/leeechsh/gpudeck/main/deploy/update-from-release.sh -o update-from-release.sh
sudo bash update-from-release.sh --component hub
# 或在 GPU 服务器更新 Agent：
sudo bash update-from-release.sh --component agent
```

默认更新到最新公开 Release；指定版本可加 `--version v2.12.0`，该版本必须已经发布。仅下载和校验、不改服务可加 `--check`。需要 curl、jq、gzip、sha256sum、timeout 和 flock，兼容 Linux/glibc 与 systemd。

Hub 使用 `/etc/gpudeck/hub.env` 中的监听地址执行健康检查，`0.0.0.0` 自动换为 `127.0.0.1`；IPv6/自定义地址可传 `--health-url http://127.0.0.1:37935/healthz`。只支持标准程序路径、服务和 SQLite 数据地址，不修改配置、节点 Token 或服务定义。

Hub 在服务停止后备份 SQLite 主文件和 WAL/SHM，备份保留于打印的 `/var/lib/gpudeck-hub-update.*` 私有目录。失败时恢复旧程序；数据库不自动恢复，如新版执行过迁移须审查备份后手动恢复。Agent 仅检查进程稳定，更新后须在 Hub 核对最新遥测。
