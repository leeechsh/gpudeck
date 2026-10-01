<div align="right">

[简体中文](README.md) · English

</div>

# GPUDeck

**Collaborative GPU Resource Management for Research Labs and AI Teams**

A shared Web portal for GPU telemetry, user occupancy, reservations and usage statistics across multiple servers. No Slurm required.

Current development version: **v2.11.0**. Repository: [leeechsh/gpudeck](https://github.com/leeechsh/gpudeck). License: [GPL-3.0](LICENSE).

## Features

- Central dashboard for node availability, GPU utilization, VRAM, temperature and GPU processes.
- User occupancy ranked by GPU count, with free GPUs grouped by model; live occupancy is separate from reservations.
- GPU calendar with a horizontal time axis and one row per GPU; click or drag to select time ranges and multiple cards.
- Current half-hour window booking and explicit 24-hour time selection.
- Client and server validation for overlapping reservations, per-user concurrent limits and unavailable GPUs; warnings for offline nodes and live occupancy.
- Administrator node registration, Linux user synchronization, mandatory initial password changes and a global concurrent GPU limit.
- My Processes filtered by the account's associated Linux username.
- Configurable WeCom group-bot notifications and GPU usage statistics.

**GPUDeck is a collaborative reservation system, not a job scheduler.** Reservations do not assign CUDA devices, lock GPUs, launch jobs or stop processes. Users continue running jobs through SSH or existing tools. Usage outside reservations can be observed, flagged and notified, not forcibly prevented.

## Components

| Component | Responsibility | Location |
| --- | --- | --- |
| gpudeck-web | React/TypeScript UI embedded into Hub at build time | Browser |
| gpudeck-hub | Rust/Axum API, identity, reservations, notifications and SQLite | One central server |
| gpudeck-agent | Read-only GPU/process/Linux-user collection, reported every 5 seconds | Each GPU server |

Recommended deployment: **one executable + systemd + SQLite**. Runtime hosts do not need Docker, Node.js, Rust or PostgreSQL. Hub serves both Web assets and API; SQLite remains an external file. Docker remains an optional deployment method.

Inherited RackTop Tauri desktop code is still present. Its SSH terminal, project synchronization and job-launch features are not current Hub features and are not required by this deployment.

## Quick deployment on new servers

For installation without compiling, see the [Release download installer](docs/QUICKSTART.md). It detects Linux x86-64/ARM64, selects latest or a pinned version, validates the bundle, and invokes the fresh installer. Published release assets are required; tags alone are insufficient.

### 1. Build the server bundle

On a Linux build host with Node.js/npm, Rust and a C compiler:

```bash
git clone https://github.com/leeechsh/gpudeck.git
cd gpudeck
npm ci
bash deploy/build-server-bundle.sh
```

The archive in `target/server-bundles/` contains Hub, Agent, fresh installers, systemd units and instructions. It does not contain credentials or databases.

Copy and extract it on target hosts, then enter the extracted directory. CPU architecture and Linux/glibc must be compatible with the build host; this is not a universally portable static binary.

### 2. Install Hub

Replace the example address with the new Hub's trusted-network or Tailscale IP:

```bash
sudo bash deploy/install-hub.sh \
  --listen 100.100.100.10:37935 \
  --public-url http://100.100.100.10:37935 \
  --admin admin
```

The installer prompts for the initial administrator password, creates a dedicated service user, SQLite directory and systemd service, and refuses to overwrite existing installations. There is no default administrator password; initial installation requires at least 8 printable ASCII characters.

For public access, configure an HTTPS reverse proxy and use `--public-url https://your-domain`. HTTPS URLs enable Secure cookies. The installer does not provision DNS, certificates, FRP, firewall rules or Tailscale.

### 3. Install each Agent

In Hub's administrator panel, register each physical server separately. Download its node `.env` and copy it to that GPU host. Tokens are shown once; never share node identities.

From the extracted bundle directory:

```bash
sudo bash deploy/install-agent.sh \
  --config /absolute/path/node.env \
  --hub-url http://100.100.100.10:37935
```

GPU hosts require an NVIDIA driver and working `nvidia-smi`. The Hub URL must be reachable from the node. Confirm the node is online in Hub after approximately 5 seconds.

See [fresh-server quick deployment](docs/QUICKSTART.md) for full instructions and troubleshooting.

## Accounts and reservation policy

- Linux users reported by Agents can be synchronized into ordinary accounts. The login name is the system username; the initial password is `username@123456`, with a mandatory first-login change.
- New user passwords require at least 8 characters. The initial Hub administrator password is chosen by the installer, not derived from the username.
- Each reservation may last up to 48 hours and start within the current half-hour window or the next 14 days. Its end must be later than the current time.
- Overlapping bookings on the same GPU are rejected; touching time boundaries are allowed.
- The default concurrent limit is 2 GPUs. Administrators can change the global limit for all users, which new accounts inherit.
- A live idle GPU is not necessarily unreserved for a future interval.

## Security, data and operations

- Hub uses Argon2 password hashes, server-side sessions and CSRF validation; Agents authenticate with separate node tokens.
- Secure cookies require HTTPS for browser sessions. Agent tokens do not depend on browser cookies.
- Both systemd services use dedicated non-root users. Installing services requires sudo.
- Default Hub database: `/var/lib/gpudeck/gpudeck.sqlite`; Hub config: `/etc/gpudeck/hub.env`; Agent config: `/etc/gpudeck-agent.env`.
- Databases and backups contain sensitive account/session/node data. Restrict access and keep independent backups. Use SQLite online backup or stop writers before a complete backup; do not copy a live main database file alone.
- Deploy SQLite Hub as a single instance. Do not share the database between replicas or place it on a shared network filesystem.

```bash
sudo systemctl status gpudeck-hub
sudo journalctl -u gpudeck-hub -n 50 --no-pager
sudo systemctl status gpudeck-agent
sudo journalctl -u gpudeck-agent -n 50 --no-pager
```

See [standalone operations](docs/STANDALONE.md) for existing deployments, historical Docker migration and rollback. Scripts containing `-current-` target the existing host, not arbitrary fresh servers.

## Development and verification

```bash
npm ci
npm test
npm run build
cargo test --locked --workspace
node scripts/test-fresh-installers.mjs
bash -n deploy/*.sh
```

Build Web before compiling Hub. To build both server executables and the deployment archive:

```bash
bash deploy/build-server-bundle.sh
```

Preview Web with API requests proxied to a running local Hub:

```bash
VITE_HUB_PROXY_TARGET=http://127.0.0.1:37935 npm run dev
```

The preview defaults to port 1420; it does not bypass authentication. First Hub startup requires database/listen configuration and an administrator bootstrap password; see [standalone deployment](docs/STANDALONE.md).

## Documentation and release status

- [Fresh-server quick deployment](docs/QUICKSTART.md)
- [Standalone deployment, upgrades and migration](docs/STANDALONE.md)
- [Docker deployment and reservation settings](docs/DEPLOYMENT.md)
- [Detailed version history](docs/VERSION_INFOS.md)
- [Short changelog](docs/Version_overview.md)

Matching `v*` tags trigger native x86-64 and ARM64 builds and tests, followed by automatic publication of server bundles, gzip-compressed Hub/Agent executables and SHA256SUMS to [GitHub Releases](https://github.com/leeechsh/gpudeck/releases). Both architectures must succeed; downloaded checksums and GitHub Assets digests are verified before publication. Existing published releases are not overwritten.

Asset names use `x86_64` and `aarch64`. CI builds on Ubuntu 22.04/glibc; use a compatible Linux host. Standalone `.gz` executables require `gunzip` and `chmod +x`. Main/PR/manual branch runs only generate Actions artifacts. Server releases do not imply verified or published macOS/Windows desktop installers.

## Attribution and license

GPUDeck builds on the UI and desktop foundation of [Tongzh-SEU/RackTop](https://github.com/Tongzh-SEU/RackTop), adding central Hub/Agent services, team identity and collaborative GPU reservations. Upstream attribution and license obligations are retained. Licensed under [GPL-3.0](LICENSE).
