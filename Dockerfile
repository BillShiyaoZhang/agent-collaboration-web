FROM node:24-alpine AS base
RUN apk add --no-cache openssl

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
COPY packages/client-contract ./packages/client-contract
RUN npm ci --registry=https://registry.npmjs.org

# Rebuild the source code only when needed
FROM deps AS builder
WORKDIR /app
COPY . .

# Generate Prisma Client
RUN npx --no-install prisma generate

# Run npm build
RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache su-exec

# Use the lockfile's migration CLI instead of a separate global installation.
COPY --from=deps /app/node_modules/prisma /opt/prisma/node_modules/prisma
COPY --from=deps /app/node_modules/@prisma /opt/prisma/node_modules/@prisma
RUN ln -s /opt/prisma/node_modules/prisma/build/index.js /usr/local/bin/prisma

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh
RUN mkdir -p /app/data /app/.next/cache && chown -R nextjs:nodejs /app/data /app/.next/cache

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./docker-entrypoint.sh"]
