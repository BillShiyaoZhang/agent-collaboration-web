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
# Apply additive workspace/account tables and fields; preserve identities and data.
# Fail startup if either migration fails.
prisma db execute --file prisma/remote-console.sql --schema prisma/schema.prisma
node scripts/migrate-account-email.cjs
exec node server.js
