CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE users (
    id uuid PRIMARY KEY,
    username text NOT NULL UNIQUE,
    display_name text NOT NULL,
    linux_username text NOT NULL UNIQUE,
    wecom_user_id text,
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('user', 'admin')),
    concurrent_gpu_limit integer NOT NULL DEFAULT 2 CHECK (concurrent_gpu_limit BETWEEN 1 AND 14),
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token text NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_attempts (
    key text PRIMARY KEY,
    failures integer NOT NULL DEFAULT 0,
    window_started_at timestamptz NOT NULL DEFAULT now(),
    locked_until timestamptz
);

CREATE TABLE nodes (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    hostname text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    enabled boolean NOT NULL DEFAULT true,
    last_sequence bigint NOT NULL DEFAULT -1,
    last_seen_at timestamptz,
    last_sample_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gpus (
    id uuid PRIMARY KEY,
    node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    gpu_uuid text NOT NULL UNIQUE,
    display_index integer NOT NULL,
    name text NOT NULL,
    memory_total_mb bigint NOT NULL,
    last_seen_at timestamptz NOT NULL,
    maintenance boolean NOT NULL DEFAULT false,
    missing boolean NOT NULL DEFAULT false
);

CREATE TABLE current_gpu_state (
    gpu_id uuid PRIMARY KEY REFERENCES gpus(id) ON DELETE CASCADE,
    sampled_at timestamptz NOT NULL,
    memory_used_mb bigint NOT NULL,
    utilization_percent double precision NOT NULL,
    temperature_celsius double precision
);

CREATE TABLE current_processes (
    gpu_id uuid NOT NULL REFERENCES gpus(id) ON DELETE CASCADE,
    pid bigint NOT NULL,
    username text NOT NULL,
    command text NOT NULL,
    memory_used_mb bigint NOT NULL,
    sampled_at timestamptz NOT NULL,
    PRIMARY KEY (gpu_id, pid)
);

CREATE TABLE reservations (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    project_name text NOT NULL,
    purpose text NOT NULL,
    status text NOT NULL CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')),
    checked_in_at timestamptz,
    ended_early_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at),
    CHECK (ends_at - starts_at <= interval '48 hours'),
    CHECK (starts_at <= created_at + interval '14 days')
);

CREATE TABLE reservation_allocations (
    id uuid PRIMARY KEY,
    reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    gpu_id uuid NOT NULL REFERENCES gpus(id),
    slot tstzrange NOT NULL,
    EXCLUDE USING gist (gpu_id WITH =, slot WITH &&)
);

CREATE TABLE usage_minutes (
    gpu_id uuid NOT NULL REFERENCES gpus(id) ON DELETE CASCADE,
    username text NOT NULL,
    minute timestamptz NOT NULL,
    active_seconds integer NOT NULL,
    memory_mb_seconds bigint NOT NULL,
    coverage_seconds integer NOT NULL,
    PRIMARY KEY (gpu_id, username, minute)
);

CREATE TABLE usage_hours (
    gpu_id uuid NOT NULL REFERENCES gpus(id) ON DELETE CASCADE,
    username text NOT NULL,
    hour timestamptz NOT NULL,
    active_seconds bigint NOT NULL,
    memory_mb_seconds bigint NOT NULL,
    coverage_seconds bigint NOT NULL,
    PRIMARY KEY (gpu_id, username, hour)
);

CREATE TABLE notification_outbox (
    id uuid PRIMARY KEY,
    event_type text NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    content text NOT NULL,
    mentioned_user_ids text[] NOT NULL DEFAULT '{}',
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    actor_id uuid REFERENCES users(id),
    action text NOT NULL,
    object_type text NOT NULL,
    object_id text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}',
    ip_address text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reservations_owner_time_idx ON reservations(owner_id, starts_at, ends_at);
CREATE INDEX processes_username_idx ON current_processes(username);
CREATE INDEX outbox_pending_idx ON notification_outbox(next_attempt_at) WHERE sent_at IS NULL;

