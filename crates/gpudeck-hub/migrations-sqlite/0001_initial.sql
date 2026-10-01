CREATE TABLE users (
    id BLOB PRIMARY KEY,
    username text NOT NULL UNIQUE,
    display_name text NOT NULL,
    linux_username text NOT NULL UNIQUE,
    wecom_user_id text,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('user', 'admin')),
    concurrent_gpu_limit integer NOT NULL DEFAULT 2 CHECK (concurrent_gpu_limit BETWEEN 1 AND 14),
    enabled boolean NOT NULL DEFAULT true,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id BLOB NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token text NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE login_attempts (
    key text PRIMARY KEY,
    failures integer NOT NULL DEFAULT 0,
    window_started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    locked_until TEXT
);

CREATE TABLE nodes (
    id BLOB PRIMARY KEY,
    name text NOT NULL UNIQUE,
    hostname text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    enabled boolean NOT NULL DEFAULT true,
    last_sequence bigint NOT NULL DEFAULT -1,
    last_seen_at TEXT,
    last_sample_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE gpus (
    id BLOB PRIMARY KEY,
    node_id BLOB NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    gpu_uuid text NOT NULL UNIQUE,
    display_index integer NOT NULL,
    name text NOT NULL,
    memory_total_mb bigint NOT NULL,
    last_seen_at TEXT NOT NULL,
    maintenance boolean NOT NULL DEFAULT false,
    missing boolean NOT NULL DEFAULT false
);

CREATE TABLE current_gpu_state (
    gpu_id BLOB PRIMARY KEY REFERENCES gpus(id) ON DELETE CASCADE,
    sampled_at TEXT NOT NULL,
    memory_used_mb bigint NOT NULL,
    utilization_percent double precision NOT NULL,
    temperature_celsius double precision
);

CREATE TABLE current_processes (
    gpu_id BLOB NOT NULL REFERENCES gpus(id) ON DELETE CASCADE,
    pid bigint NOT NULL,
    username text NOT NULL,
    command text NOT NULL,
    memory_used_mb bigint NOT NULL,
    sampled_at TEXT NOT NULL,
    PRIMARY KEY (gpu_id, pid)
);

CREATE TABLE reservations (
    id BLOB PRIMARY KEY,
    owner_id BLOB NOT NULL REFERENCES users(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    project_name text NOT NULL,
    purpose text NOT NULL,
    status text NOT NULL CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')),
    checked_in_at TEXT,
    ended_early_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (ends_at > starts_at),
    CHECK (julianday(ends_at) - julianday(starts_at) <= 2.00000001),
    CHECK (julianday(starts_at) <= julianday(created_at) + 14)
);

CREATE TABLE reservation_allocations (
    id BLOB PRIMARY KEY,
    reservation_id BLOB NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    gpu_id BLOB NOT NULL REFERENCES gpus(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    CHECK (ends_at > starts_at)
);

CREATE TABLE usage_minutes (
    gpu_id BLOB NOT NULL REFERENCES gpus(id) ON DELETE CASCADE,
    username text NOT NULL,
    minute TEXT NOT NULL,
    active_seconds integer NOT NULL,
    memory_mb_seconds bigint NOT NULL,
    coverage_seconds integer NOT NULL,
    PRIMARY KEY (gpu_id, username, minute)
);

CREATE TABLE usage_hours (
    gpu_id BLOB NOT NULL REFERENCES gpus(id) ON DELETE CASCADE,
    username text NOT NULL,
    hour TEXT NOT NULL,
    active_seconds bigint NOT NULL,
    memory_mb_seconds bigint NOT NULL,
    coverage_seconds bigint NOT NULL,
    PRIMARY KEY (gpu_id, username, hour)
);

CREATE TABLE notification_outbox (
    id BLOB PRIMARY KEY,
    event_type text NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    content text NOT NULL,
    mentioned_user_ids TEXT NOT NULL DEFAULT '[]',
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    sent_at TEXT,
    last_error text,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE audit_events (
    id BLOB PRIMARY KEY,
    actor_id BLOB REFERENCES users(id),
    action text NOT NULL,
    object_type text NOT NULL,
    object_id text NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    ip_address text,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX reservations_owner_time_idx ON reservations(owner_id, starts_at, ends_at);
CREATE INDEX processes_username_idx ON current_processes(username);
CREATE INDEX outbox_pending_idx ON notification_outbox(next_attempt_at) WHERE sent_at IS NULL;


ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
CREATE TABLE node_system_users (
    node_id BLOB NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    username TEXT NOT NULL,
    uid INTEGER NOT NULL,
    shell TEXT NOT NULL,
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (node_id, username)
);
CREATE TABLE hub_settings (
    id INTEGER PRIMARY KEY CHECK (id=1),
    concurrent_gpu_limit INTEGER NOT NULL DEFAULT 2 CHECK (concurrent_gpu_limit BETWEEN 1 AND 14)
);
INSERT INTO hub_settings (id) VALUES (1);
CREATE TRIGGER users_global_gpu_limit AFTER INSERT ON users BEGIN
    UPDATE users SET concurrent_gpu_limit=(SELECT concurrent_gpu_limit FROM hub_settings WHERE id=1) WHERE id=NEW.id;
END;
CREATE INDEX allocations_gpu_time_idx ON reservation_allocations(gpu_id,starts_at,ends_at);
CREATE TRIGGER allocations_no_overlap_insert BEFORE INSERT ON reservation_allocations
WHEN EXISTS (SELECT 1 FROM reservation_allocations a WHERE a.gpu_id=NEW.gpu_id AND a.starts_at<NEW.ends_at AND a.ends_at>NEW.starts_at)
BEGIN SELECT RAISE(ABORT, 'reservation_allocations_overlap'); END;
CREATE TRIGGER allocations_no_overlap_update BEFORE UPDATE ON reservation_allocations
WHEN EXISTS (SELECT 1 FROM reservation_allocations a WHERE a.id<>NEW.id AND a.gpu_id=NEW.gpu_id AND a.starts_at<NEW.ends_at AND a.ends_at>NEW.starts_at)
BEGIN SELECT RAISE(ABORT, 'reservation_allocations_overlap'); END;
