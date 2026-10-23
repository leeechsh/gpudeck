CREATE TABLE unreserved_usage (
    username TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);
