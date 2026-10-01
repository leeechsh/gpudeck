# 单可执行文件部署

Hub 将 Web 资源内嵌到同一个 Linux 可执行文件，运行时不需要 Docker、Node.js、Caddy 或 PostgreSQL。SQLite 数据和配置仍是外部文件；这不是所有平台通用的完全静态二进制，需要与构建环境兼容的 Linux/glibc。

## 构建

构建机器需要 Node.js/npm、Rust 和 C 编译器：

```bash
bash deploy/build-standalone.sh
```

产物为 `target/release/gpudeck-hub`。直接运行示例（首次启动须设置至少 8 位的 `GPUDECK_BOOTSTRAP_PASSWORD` 或密码文件）：

```bash
export DATABASE_URL=sqlite:///absolute/path/gpudeck.sqlite
export GPUDECK_LISTEN=127.0.0.1:37935
export GPUDECK_PUBLIC_URL=http://localhost:37935
export GPUDECK_SECURE_COOKIE=false
./gpudeck-hub
```

`--version` 输出版本，`--init-db-only` 只初始化数据库。必须先执行 `npm run build` 再编译/测试 Hub，确保内嵌页面最新。

## 当前服务器迁移

```bash
sudo bash /home/leeechsh/Workspace/gpudeck/deploy/install-current-hub-root.sh
```

此脚本仅针对当前 Compose 容器 `deploy-gpudeck-hub-1`、`deploy-gpudeck-web-1`，拒绝覆盖已有独立安装。先安装文件、检查容器，再停写、执行 SQLite `.backup`、复制完整数据库并启动 systemd；启动健康检查失败会重新启动原 Docker 服务。首次切换期间有短暂中断。

脚本默认显式连接当前服务器的共享 Docker socket `unix:///home/metaiot/docker-shared/docker.sock`，避免 sudo 丢弃 `DOCKER_HOST` 后误连系统 Docker。其他部署可将 Docker endpoint 作为第一个参数传入；所有备份、停容器和回退操作使用同一 endpoint。

- 服务：`gpudeck-hub.service`，非 root 用户 `gpudeck`。
- 程序：`/usr/local/bin/gpudeck-hub`。
- 数据：`/var/lib/gpudeck/gpudeck.sqlite`，包括账号密码、会话、预约、节点与统计。
- 配置：`/etc/gpudeck/hub.env`，保留现有公网 URL、通知和 Secure Cookie 配置。
- 地址：`100.77.69.72:37935`，Agent 无须重新注册。
- 备份：`deploy/backups/standalone-时间戳/`，含数据库与原配置，不提交到 Git。

```bash
sudo systemctl status gpudeck-hub
sudo journalctl -u gpudeck-hub -n 100 --no-pager
```

当前 `GPUDECK_SECURE_COOKIE=true`，应通过 HTTPS 公网域名登录；HTTP Tailscale 地址仍用于 Agent，但浏览器不会在 HTTP 上发送 Secure 会话 Cookie。迁移不改变这一设置。

## 回退与升级

启动失败的自动回退仅发生在切换尚未开始接收新写入时。若切换成功后再手动回退，必须先停 systemd，备份最新 SQLite 并将其恢复到 Docker 数据卷，避免丢失切换后的预约/账号变更；不能直接启动旧数据库。保留原 Docker 容器和卷，不执行 `docker compose down -v`。

后续当前服务器升级：先构建，再执行下列命令；不要重复运行一次性迁移脚本。

```bash
sudo /home/leeechsh/Workspace/gpudeck/deploy/upgrade-current-hub-root.sh
```

升级脚本停服务后备份数据库及剩余 WAL/SHM、原程序与配置到 `/var/lib/gpudeck/backups/upgrade-时间戳/`，替换程序并健康检查，失败恢复原程序。不会覆盖数据库或更改配置。本次 2.8.0 没有数据库结构变更；涉及不兼容结构变更的未来升级须另行设计数据恢复，不能仅回退程序。不要直接复制正在写入的 SQLite 主文件，应使用 SQLite `.backup` 或停写后完整备份。
