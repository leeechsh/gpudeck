ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

CREATE TABLE node_system_users (
    node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    username text NOT NULL,
    uid bigint NOT NULL,
    shell text NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (node_id, username)
);
