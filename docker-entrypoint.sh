#!/bin/sh
set -e
# This migration only adds console tables. Fail startup if migration fails.
prisma db execute --file prisma/remote-console.sql --schema prisma/schema.prisma
exec node server.js
