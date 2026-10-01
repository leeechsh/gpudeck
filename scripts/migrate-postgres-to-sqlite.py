#!/usr/bin/env python3
"""Offline, verified PostgreSQL -> SQLite cutover. Stop Hub writes first.

Never overwrites an existing destination. Retains a private PostgreSQL dump and
consistent JSON snapshot. Requires Docker, Python 3 and the new Hub binary.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import uuid

TABLES = ["users", "sessions", "login_attempts", "nodes", "gpus", "current_gpu_state",
          "current_processes", "reservations", "reservation_allocations", "usage_minutes",
          "usage_hours", "notification_outbox", "audit_events", "node_system_users", "hub_settings"]


def canonical(value):
    if isinstance(value, bytes):
        return value.hex()
    return value


def fingerprint(rows):
    # Order-independent full-row verification, including credentials and tokens.
    hashes = [hashlib.sha256(json.dumps([canonical(v) for v in row], ensure_ascii=False,
              separators=(",", ":")).encode()).hexdigest() for row in rows]
    return hashlib.sha256("".join(sorted(hashes)).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--backup-dir", required=True, type=Path)
    parser.add_argument("--hub-binary", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.output.exists():
        raise SystemExit("Refusing to overwrite destination database")
    args.backup_dir.mkdir(parents=True, exist_ok=False)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with (args.backup_dir / "postgres.dump").open("xb") as output:
        subprocess.run(["docker", "exec", args.container, "pg_dump", "-U", "gpudeck", "-d", "gpudeck", "-Fc"], stdout=output, check=True)
    statements = ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"]
    for table in TABLES:
        statements.append(f"SELECT json_build_object('table','{table}','types',json_object_agg(column_name,data_type)) FROM information_schema.columns WHERE table_schema='public' AND table_name='{table}';")
        source = f"(SELECT id,reservation_id,gpu_id,lower(slot) AS starts_at,upper(slot) AS ends_at FROM {table})" if table == "reservation_allocations" else table
        statements.append(f"SELECT json_build_object('table','{table}','row',row_to_json(t)) FROM {source} t;")
    statements.append("COMMIT;")
    snapshot = args.backup_dir / "snapshot.jsonl"
    with snapshot.open("xb") as output:
        subprocess.run(["docker", "exec", args.container, "psql", "-U", "gpudeck", "-d", "gpudeck", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", "\n".join(statements)], stdout=output, check=True)
    subprocess.run([str(args.hub_binary.resolve()), "--init-db-only"],
                   env={**os.environ, "DATABASE_URL": f"sqlite://{args.output.resolve()}"}, check=True)
    expected = {table: [] for table in TABLES}
    columns = {}
    types = {}
    db = sqlite3.connect(args.output)
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE")
        db.execute("DELETE FROM hub_settings")
        # Account inheritance is restored unchanged after exact historical import.
        db.execute("DROP TRIGGER users_global_gpu_limit")
        with snapshot.open() as source:
            for line in source:
                entry = json.loads(line)
                table = entry["table"]
                if "types" in entry:
                    if entry["types"] is None:
                        raise RuntimeError(f"Missing source table: {table}")
                    types[table] = entry["types"]
                    continue
                row = entry["row"]
                converted = {}
                for name, value in row.items():
                    kind = types[table].get(name)
                    if table == "reservation_allocations" and name in ("starts_at", "ends_at"):
                        kind = "timestamp with time zone"
                    if value is None:
                        converted[name] = None
                    elif kind == "uuid":
                        converted[name] = uuid.UUID(value).bytes
                    elif kind == "timestamp with time zone":
                        iso = re.sub(r"\.(\d+)", lambda match: "." + match.group(1)[:6].ljust(6, "0"), value.replace("Z", "+00:00"))
                        converted[name] = dt.datetime.fromisoformat(iso).astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                    elif kind in ("jsonb", "json", "ARRAY"):
                        converted[name] = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                    elif isinstance(value, bool):
                        converted[name] = int(value)
                    elif kind in ("double precision", "real"):
                        converted[name] = float(value)
                    else:
                        converted[name] = value
                names = sorted(converted)
                columns[table] = names
                values = [converted[name] for name in names]
                db.execute(f'INSERT INTO "{table}" ({",".join(names)}) VALUES ({",".join("?" for _ in names)})', values)
                expected[table].append(values)
        db.execute("CREATE TRIGGER users_global_gpu_limit AFTER INSERT ON users BEGIN UPDATE users SET concurrent_gpu_limit=(SELECT concurrent_gpu_limit FROM hub_settings WHERE id=1) WHERE id=NEW.id; END")
        report = {}
        for table in TABLES:
            count = db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
            if count != len(expected[table]):
                raise RuntimeError(f"Row count mismatch: {table}")
            if count:
                actual = list(db.execute(f'SELECT {",".join(columns[table])} FROM "{table}"'))
                if fingerprint(actual) != fingerprint(expected[table]):
                    raise RuntimeError(f"Full-row checksum mismatch: {table}")
            report[table] = count
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("Foreign-key validation failed")
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Database integrity validation failed")
        db.commit()
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        (args.backup_dir / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"verifiedRows": report, "database": str(args.output), "backup": str(args.backup_dir)}))
    except BaseException:
        db.rollback()
        print("Import failed; source is unchanged. Retain backups and do not start the new Hub.")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
