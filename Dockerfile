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

# Public contact is compiled into client bundles. Never pass mail API secrets here.
ARG NEXT_PUBLIC_SUPPORT_EMAIL=""
ENV NEXT_PUBLIC_SUPPORT_EMAIL=$NEXT_PUBLIC_SUPPORT_EMAIL

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
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts/migrate-account-email.cjs ./scripts/migrate-account-email.cjs
COPY --from=builder /app/docker-entrypoint.sh ./

# A source checkout may have been created with umask 077. Docker COPY retains
# those 0600/0700 modes, but migrations and Next run as UID 1001. Normalize
# only image files after every COPY; keep runtime code root-owned and writable
# database/cache directories separately owned by nextjs.
RUN chmod -R a+rX /app /opt/prisma \
    && chmod a+rx /app/docker-entrypoint.sh \
    && mkdir -p /app/data /app/.next/cache \
    && chown -R nextjs:nodejs /app/data /app/.next/cache

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./docker-entrypoint.sh"]
