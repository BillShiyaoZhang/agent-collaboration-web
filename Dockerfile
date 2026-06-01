FROM node:20-alpine AS base
RUN sed -i 's/https/http/g' /etc/apk/repositories && apk add --no-cache openssl

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Rebuild the source code only when needed
FROM deps AS builder
WORKDIR /app
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Install SWC binary for Alpine Linux (musl)
RUN npm install @next/swc-linux-x64-musl

# Run npm build
RUN npm run build

# Production image, copy all the files and run next
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production

RUN sed -i 's/https/http/g' /etc/apk/repositories && apk add --no-cache openssl && npm install -g prisma@5.22.0

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

ENTRYPOINT ["./docker-entrypoint.sh"]