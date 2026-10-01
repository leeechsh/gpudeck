# GPUDeck Hub — 协作式 GPU 预约

推荐非 Docker 部署：参见 [单可执行文件 / systemd 部署与迁移](STANDALONE.md)。下文保留 Docker 方式供回退与可选部署。

这是基于 GPUDeck 的无 Slurm 团队版：中央看板、具体 GPU 预约、门户账号、企业微信通知和使用统计。Hub 与 Agent **不会执行、暂停或终止用户进程**；SSH 仍可绕过预约，因此违规使用只会被标记和通知。

## 架构

- Web：React/Vite，统一看板、预约日历、统计。
- Hub：Rust/Axum + SQLite，单实例运行，WAL、外键、写事务与冲突触发器保护预约，Argon2 密码、服务端会话与 CSRF。
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

SQLite 数据库位于 Hub 容器的 `/data/gpudeck.sqlite`，持久化在 `gpudeck-data` 命名卷中；初始管理员密码保存在独立 secrets 卷中。使用 `docker compose run --rm --no-deps secrets-init cat /secrets/admin_password` 在服务器终端读取初始密码。公网部署前请把 `.env` 中域名和企业微信 webhook 改为真实值；Caddy 可自动签发 HTTPS 证书。初始管理员只会在数据库没有管理员时创建。

不要执行 `docker compose down -v`，它会删除数据库卷。SQLite 模式仅支持单实例 Hub 和本地持久化磁盘，不使用网络共享文件系统，也不适用于没有持久化磁盘的容器平台。

### 数据备份

运行期间使用 SQLite 在线备份，不能只复制正在运行的主数据库文件而忽略 WAL：

```bash
docker compose exec -T gpudeck-hub sqlite3 /data/gpudeck.sqlite ".backup '/data/gpudeck-backup.sqlite'"
docker compose exec -T gpudeck-hub sqlite3 /data/gpudeck-backup.sqlite 'PRAGMA integrity_check;'
docker cp deploy-gpudeck-hub-1:/data/gpudeck-backup.sqlite ./gpudeck-backup.sqlite
chmod 600 ./gpudeck-backup.sqlite
```

数据库包含密码哈希、会话和节点凭据哈希；备份应保密并另存到独立存储。非 Docker 部署可使用 `python3 scripts/backup-sqlite.py SOURCE.sqlite NEW-BACKUP.sqlite`。

### 从旧 PostgreSQL 部署迁移

不要直接让新版 Hub 启动空数据库。先构建新版二进制和镜像，停止旧 Hub 写入（Agent 会暂时上报失败，训练不受影响），再运行：

```bash
python3 scripts/migrate-postgres-to-sqlite.py \
  --container deploy-gpudeck-postgres-1 \
  --output deploy/data/gpudeck.sqlite \
  --backup-dir deploy/backups/NEW-CUTOVER-DIRECTORY \
  --hub-binary target/debug/gpudeck-hub
docker compose create data-init
docker cp deploy/data/gpudeck.sqlite deploy-data-init-1:/data/gpudeck.sqlite
docker compose up -d gpudeck-web
```

脚本拒绝覆盖目标数据库，保留 PostgreSQL dump 和一致性快照，核对全部表的行数及转换后的完整行校验值，再检查外键和数据库完整性。UUID 转为 BLOB，时间统一为 UTC 毫秒，JSON/通知名单转为 JSON 文本，密码哈希不变。迁移失败时不要启动新版，恢复旧镜像及旧 Compose 配置即可继续使用 PostgreSQL。

确认新服务、节点上报与备份正常后，可停止旧 PostgreSQL 容器，但保留数据卷及回退镜像。回退到旧数据快照不会包含切换后新增的数据，需要明确选择回退时间点。

Hub 新密码、管理员创建账号和初始管理员密码均要求至少 8 位；已有密码不受影响。

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

- 默认每用户同一时间最多 2 张 GPU；管理员通过全局预约设置统一调整。
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
