#!/bin/sh
set -eu
umask 077
export DATABASE_URL="${DATABASE_URL:-sqlite:///data/gpudeck.sqlite}"
exec /usr/local/bin/gpudeck-hub
