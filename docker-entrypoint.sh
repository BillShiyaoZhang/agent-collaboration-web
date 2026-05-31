#!/bin/sh
set -e

# Run database migration using local prisma
echo "Running database migration..."
./node_modules/.bin/prisma migrate deploy || echo "Migration failed, continuing..."

# Start the application
exec node server.js