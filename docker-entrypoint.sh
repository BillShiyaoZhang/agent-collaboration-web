#!/bin/sh
set -e
# Migrate ownership of existing named volumes from older root-run images, then
# drop privileges before either the database migration or network service runs.
if [ "$(id -u)" = "0" ]; then
    mkdir -p /app/data
    chown -hR nextjs:nodejs /app/data
    exec su-exec nextjs:nodejs "$0" "$@"
fi
umask 077
# This migration only adds console tables. Fail startup if migration fails.
prisma db execute --file prisma/remote-console.sql --schema prisma/schema.prisma
exec node server.js
