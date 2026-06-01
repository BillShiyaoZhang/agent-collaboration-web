#!/bin/sh
set -e

# Run database schema push using prisma
echo "Running database schema push..."
prisma db push --skip-generate --accept-data-loss || npx prisma db push --skip-generate --accept-data-loss || echo "Database push failed, continuing..."

# Start the application
exec node server.js