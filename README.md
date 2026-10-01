<div align="right">

简体中文 · [English](README_EN.md)

</div>

# GPUDeck

Hub 预约无需手动签到：每 10 秒检查一次近期 GPU 进程，当预约时段内任意一张所预约 GPU 上的进程 Linux 用户名与预约人的 Linux 用户名一致时，自动记录已开始使用。仅采用最近 2 分钟且不早于预约开始时间的采样；首次检测记录会保留。预约开始 15 分钟仍未检测到匹配进程时提醒一次，不自动释放预约。节点离线时无法确认实际使用情况。

企业微信推送使用 [官方文档](https://developer.work.weixin.qq.com/document/path/99110) 支持的普通 Markdown：统一标题、状态颜色、用户／项目／GPU／北京时间和 Hub 链接；已配置企业微信用户 ID 时通过 `<@userid>` 提醒对应成员。新消息遵守 4096 UTF-8 字节限制，防止用户填写的内容注入链接或 @ 提醒；升级前队列中的纯文本消息仍按原格式发送。事件触发、去重和重试逻辑不变。

**Collaborative GPU Resource Management for Research Labs and AI Teams**

面向研究实验室与 AI 团队的协作式 GPU 资源管理平台。将多台服务器的 GPU 状态、人员占用、预约日历和使用统计集中到一个 Web 门户，无需部署 Slurm。

当前开发版本：**v2.11.1**。仓库：[leeechsh/gpudeck](https://github.com/leeechsh/gpudeck)。许可证：[GPL-3.0](LICENSE)。

## 能做什么

- **中央资源看板**：查看节点在线状态、GPU 利用率、显存、温度及 GPU 进程。
- **人员占用总览**：按占用 GPU 数量查看用户，并查看空闲卡总数和各型号可用数量；实际占用与预约分开呈现。
- **GPU 预约日历**：横向时间轴、纵向 GPU，支持点击和拖动选择时段及多张卡；支持当前半小时窗口，时间选择为 24 小时制。
- **预约冲突提醒**：检查同卡时间重叠、用户并发上限、不可用 GPU，并提示离线节点和实际占用风险；后端同步校验。
- **用户与管理员**：节点注册、Linux 用户同步、首次登录改密，以及全局并发 GPU 上限设置。
- **我的进程**：按登录账号关联的 Linux 用户名查看已接入节点上的 GPU 进程。
- **通知与统计**：支持配置企业微信群机器人，提供预约相关提醒和 GPU 使用统计。

GPUDeck 是**协作式预约系统，不是作业调度器**：预约不会分配 CUDA 设备、锁定显卡，也不会启动、暂停或终止用户进程。用户仍通过 SSH 或现有工具运行任务；未按预约使用资源只能被观察、标记和通知。

## 组件与部署方式

| 组件 | 职责 | 运行位置 |
| --- | --- | --- |
| gpudeck-web | React/TypeScript Web 界面，构建后内嵌到 Hub | 用户浏览器 |
| gpudeck-hub | Rust/Axum API、身份、预约、通知与 SQLite | 一台中央服务器 |
| gpudeck-agent | 只读采集 GPU、进程及可登录 Linux 用户，每 5 秒上报 | 每台 GPU 服务器 |

推荐 **单可执行文件 + systemd + SQLite**：运行服务器无需 Docker、Node.js、Rust 或 PostgreSQL。Web 与 API 由同一个 Hub 进程提供；数据仍保存在外部 SQLite 文件中。Docker 部署保留为可选方案。

本仓库仍包含继承自 RackTop 的 Tauri 桌面代码，但其 SSH 终端、项目同步和任务启动能力不应视为当前 Hub 的功能，也不作为下面部署流程的依赖。

## 快速部署到新服务器

无需编译的自动下载入口：参见 [从 GitHub Release 自动安装 Hub/Agent](docs/QUICKSTART.md#自动下载部署无需本地编译)。脚本自动匹配 x86-64/ARM64、支持 latest/指定版本，校验后安装；要求目标版本已公开发布且包含部署附件。

### 1. 构建部署包

在 Linux 构建机安装 Node.js/npm、Rust 和 C 编译器，然后执行：

```bash
git clone https://github.com/leeechsh/gpudeck.git
cd gpudeck
npm ci
bash deploy/build-server-bundle.sh
```

部署包输出到 `target/server-bundles/`，包含 Hub、Agent、首次安装脚本、systemd 服务文件和部署说明，不含凭据或数据库。

将包复制到目标服务器并解压，进入解压目录。目标主机须使用兼容的 CPU 架构和 Linux/glibc；这不是任意平台通用的完全静态二进制。

### 2. 安装 Hub

以下为可信内网或 Tailscale 示例，将地址替换为新 Hub 的实际 IP：

```bash
sudo bash deploy/install-hub.sh \
  --listen 100.100.100.10:37935 \
  --public-url http://100.100.100.10:37935 \
  --admin admin
```

脚本交互读取初始管理员密码，创建独立服务用户、SQLite 数据目录及 systemd 服务，拒绝覆盖已有部署。默认没有管理员密码，首次安装须输入至少 8 个可打印 ASCII 字符。

公网访问应配置 HTTPS 反向代理，并使用 `--public-url https://你的域名`；HTTPS URL 会启用 Secure Cookie。脚本不配置 DNS、证书、FRP、防火墙或 Tailscale。

### 3. 接入 Agent

管理员登录 Hub，在“管理面板 → 注册服务器节点”为每台服务器独立注册，下载节点 `.env` 并复制到对应 GPU 服务器。Token 仅显示一次，不能共用节点身份。

在 GPU 服务器的解压目录执行：

```bash
sudo bash deploy/install-agent.sh \
  --config /absolute/path/node.env \
  --hub-url http://100.100.100.10:37935
```

GPU 节点需安装 NVIDIA 驱动，并能够运行 `nvidia-smi`；Hub URL 必须从节点可达。约 5 秒后在 Hub 确认节点在线。

完整步骤及故障排查：[新服务器快速部署](docs/QUICKSTART.md)。

已有 systemd 部署可使用 `deploy/update-from-release.sh --component hub` 或 `--component agent` 更新到最新公开 Release；支持 `--version vX.Y.Z` 和仅校验的 `--check`。脚本自动识别架构、校验下载文件，保留配置并在更新失败时恢复旧程序。Hub 停止服务后备份 SQLite，数据库不自动回滚。详见 [更新已有服务](docs/QUICKSTART.md#更新已有服务)。

GitHub 直连超时时，安装和更新脚本均支持 `--download-prefix https://gh-proxy.com/`，同时加速 Release API 与附件下载。默认仍直连 GitHub；该选项依赖第三方代理，SHA-256 校验不等同于独立签名认证。

## 用户与预约规则

- 普通账号可由 Agent 上报的 Linux 用户同步生成：登录名为系统用户名，初始密码为“用户名@123456”，首次登录必须修改。
- 用户新密码至少 8 个字符；首次 Hub 管理员密码由安装者设置，不使用上述默认规则。
- 每次预约最多 48 小时，最早可从当前半小时窗口开始，最晚在未来 14 天内开始；结束时间须晚于当前时间。
- 同一张卡的重叠时段不可预约，结束与开始边界相接不算冲突。
- 默认并发上限为 2 张 GPU；管理员可通过全局设置统一调整所有用户，新账号继承该设置。
- “实际空闲”不等于“时段未预约”，实际进程占用与预约冲突是不同概念。

## 安全、持久化与运维

- Hub 密码使用 Argon2 哈希，采用服务端会话及 CSRF 校验；节点使用独立 Token 身份。
- HTTPS 部署使用 Secure Cookie；启用后浏览器无法通过普通 HTTP 完成会话登录。Agent 使用 Token，不依赖浏览器 Cookie。
- Hub 与 Agent systemd 服务均以专用非 root 用户运行；安装服务需要 sudo。
- Hub 数据默认位于 `/var/lib/gpudeck/gpudeck.sqlite`，配置位于 `/etc/gpudeck/hub.env`；Agent 配置位于 `/etc/gpudeck-agent.env`。
- 数据库及备份含账号、会话和节点相关敏感信息，须限制权限并保存在独立存储。不要直接复制正在写入的 SQLite 主文件；应使用 SQLite 在线备份或停写后完整备份。
- 当前 SQLite Hub 按单实例部署；不要将同一数据库文件用于多实例或放在共享网络文件系统上。

查看运行状态：

```bash
sudo systemctl status gpudeck-hub
sudo journalctl -u gpudeck-hub -n 50 --no-pager
sudo systemctl status gpudeck-agent
sudo journalctl -u gpudeck-agent -n 50 --no-pager
```

现有部署的升级、历史 Docker 迁移和回退参见 [单文件部署说明](docs/STANDALONE.md)。其中 `*-current-*` 脚本针对已有当前服务器，不是通用的新服务器安装入口。

## 开发与验证

```bash
npm ci
npm test
npm run build
cargo test --locked --workspace
node scripts/test-fresh-installers.mjs
bash -n deploy/*.sh
```

编译 Hub 前必须先构建 Web。构建两个服务器程序及部署包：

```bash
bash deploy/build-server-bundle.sh
```

启动前端开发预览，并将 API 代理到本地运行的 Hub：

```bash
VITE_HUB_PROXY_TARGET=http://127.0.0.1:37935 npm run dev
```

默认预览端口为 1420；代理不会绕过 Hub 身份验证。首次启动 Hub 需配置数据库地址、监听地址及初始化管理员密码，详见 [单文件部署说明](docs/STANDALONE.md)。

## 文档与发布状态

- [新服务器快速部署](docs/QUICKSTART.md)
- [单文件部署、升级与迁移](docs/STANDALONE.md)
- [Docker 部署及预约配置](docs/DEPLOYMENT.md)
- [详细版本记录](docs/VERSION_INFOS.md)
- [简明更新说明](docs/Version_overview.md)

推送与版本号匹配的 `v*` 标签后，Linux 工作流会在 x86-64 和 ARM64 原生 runner 上构建、测试，再自动上传部署包、Hub/Agent 的 gzip 压缩可执行文件及 SHA256SUMS 到 [GitHub Releases](https://github.com/leeechsh/gpudeck/releases)。两种架构均成功，下载校验和 GitHub Assets Digest 匹配后才公开 Release；已有公开 Release 不会被自动覆盖。

文件名中 x86-64 为 `x86_64`，ARM64 为 `aarch64`。CI 基于 Ubuntu 22.04/glibc 构建，需要兼容的 Linux 运行环境；单独 `.gz` 程序需 `gunzip` 解压并 `chmod +x`。main/PR/手动分支运行只生成 Actions Artifact，不发布 Release。Linux 服务器发布不代表 macOS/Windows 桌面安装包已验证或发布，以实际附件为准。

## 致谢与许可证

GPUDeck 的界面与桌面基础源自 [Tongzh-SEU/RackTop](https://github.com/Tongzh-SEU/RackTop)，在此基础上增加中央 Hub、Agent、团队身份与协作式 GPU 预约。保留上游贡献与许可证要求，采用 [GPL-3.0](LICENSE)。
