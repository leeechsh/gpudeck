#!/bin/sh
set -eu
db_password=$(cat /run/racktop-secrets/postgres_password)
export DATABASE_URL="postgres://racktop:${db_password}@postgres/racktop?sslmode=disable"
exec /usr/local/bin/racktop-hub
