#!/bin/sh
set -eu
db_password=$(cat /run/gpudeck-secrets/postgres_password)
export DATABASE_URL="postgres://gpudeck:${db_password}@gpudeck-postgres/gpudeck?sslmode=disable"
exec /usr/local/bin/gpudeck-hub
