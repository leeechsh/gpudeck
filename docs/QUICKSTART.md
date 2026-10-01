# 新服务器快速部署（Linux + systemd）

运行机器只需 Linux/systemd、curl、CA 证书；GPU 节点还需 NVIDIA 驱动及可用的 `nvidia-smi`。安装需要 sudo，服务使用独立非 root 用户。无需 Docker、数据库服务、Node.js 或 Rust 运行环境。

## 1. 在构建机器生成部署包

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

两个安装脚本均支持 `--check` 做无写入的参数检查，支持 `--binary PATH` 指定单独拷贝的程序；脚本旁需要保留对应 `.service` 文件。拒绝覆盖已有程序、数据库、配置或服务；安装失败保留文件供排查，不自动删除数据。已有部署升级参见 `STANDALONE.md`，不要重复执行首次安装。
