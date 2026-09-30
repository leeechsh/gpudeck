# GPUDeck Hub — 协作式 GPU 预约

这是基于 GPUDeck 的无 Slurm 团队版：中央看板、具体 GPU 预约、门户账号、企业微信通知和使用统计。Hub 与 Agent **不会执行、暂停或终止用户进程**；SSH 仍可绕过预约，因此违规使用只会被标记和通知。

## 架构

- Web：React/Vite，统一看板、预约日历、统计。
- Hub：Rust/Axum + PostgreSQL，事务级冲突校验、Argon2 密码、服务端会话与 CSRF。
- Agent：Rust 单二进制，每 5 秒只读 `nvidia-smi`、`/proc` 和 `/etc/passwd`，以 GPU UUID 上报；不会修改系统用户。
- 通知：企业微信群机器人；支持预约提醒、未签到、未预约使用和超时占用，均做幂等去重。

## Hub 部署

```bash
cd deploy
cp .env.example .env
mkdir -p secrets
chmod 600 .env
docker compose up -d --build
```

数据库和初始管理员密码由一次性初始化容器生成并保存在仅 Docker 可访问的命名卷中。使用 `docker compose exec secrets-init cat /secrets/admin_password` 在服务器终端读取初始密码。公网部署前请把 `.env` 中域名和企业微信 webhook 改为真实值；Caddy 可自动签发 HTTPS 证书。初始管理员只会在数据库没有管理员时创建。

## 全局预约设置

管理员打开“管理面板 → 全局预约设置”，设置每个账号的并发 GPU 上限（1–14 张），点击“保存并应用到所有用户”。初始值为 2；所有现有账号（包括管理员和停用账号）统一更新，新注册、自动创建或手动同步的账号继承该值。

上限按任一时刻预约的 GPU 总数计算，不是预约条数，也不限制实际进程。降低上限不取消已有预约，新预约按新值校验；在线页面在下一次刷新时更新账号上限。保存失败保留输入，可重试。

管理接口：`GET /api/v1/admin/settings` 查询，`PUT /api/v1/admin/settings` 保存，JSON 请求体为 `{"concurrentGpuLimit":4}`。保存需要管理员会话及 `X-CSRF-Token`，返回 `concurrentGpuLimit` 和 `updatedUserCount`；修改会记录审计事件。

## 节点接入

1. 管理员登录 Web 后打开“管理面板 → 注册服务器节点”；也可调用 `POST /api/v1/admin/nodes` 创建节点。响应中的 Agent token 只显示一次。
2. 构建：`cargo build --release -p gpudeck-agent`。
3. 在现有账号 Ansible inventory 中增加 Server3，保持既有 UID/GID/SSH 公钥流程；为每台主机设置独立 `gpudeck_node_id`、`gpudeck_agent_token`。
4. 运行 `deploy/ansible/install-agent.yml`。Agent 用户无需 Docker、sudo 或写 GPU 权限。

管理员可通过 `GET /api/v1/admin/nodes` 查看节点注册、启用状态和最近上报时间；普通用户访问管理接口会返回 403。

## 系统用户同步

Agent 会采集各节点 UID 不小于 1000、具有可登录 shell 的 Linux 用户（排除 `nobody`），Hub 按用户名跨节点去重并自动创建普通账号。初始密码为 `用户名@123456`；首次登录只能查看身份、退出或修改密码，完成改密后才可使用资源看板和预约功能。管理员也可在管理面板点击“同步系统用户”补做同步。

## 默认规则

- 每用户同一时间最多 2 张 GPU；管理员创建用户时可调整。
- 单次最长 48 小时，最多提前 14 天，提交即确认。
- 未签到不释放；预约到期不续期也不杀进程；未预约使用只通知。
- 分钟数据保留 90 天，小时汇总保留 1 年。

## 本地开发

```bash
cargo test --workspace
npm ci
npm run dev
```

Hub Web 默认启用。若要运行原 GPUDeck 桌面 UI，设置 `VITE_GPUDECK_HUB=false`。

本机部署默认只绑定 `127.0.0.1`。需要通过 Tailscale 接入节点时，将 `.env` 中的 `GPUDECK_BIND_ADDRESS` 和 `GPUDECK_PUBLIC_URL` 分别改为服务器的 Tailscale IP 与完整 URL；不要直接绑定公网地址并继续使用明文 HTTP。
