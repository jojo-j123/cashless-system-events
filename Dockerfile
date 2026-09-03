# syntax=docker/dockerfile:1

# Production image for the cashless points system.
#
# Deliberately NOT using Next's `output: 'standalone'`. Standalone ships only
# the dependencies Next can statically trace from the app, and the migration
# entrypoint imports `drizzle-orm/node-postgres/migrator`, which the app itself
# never imports and the tracer therefore drops. A smaller image is not worth a
# release command that fails the first time you run it against production.

# ---------------------------------------------------------------- build deps
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --------------------------------------------------------------------- build
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# NEXT_PUBLIC_* values are inlined into the client bundle at build time, not
# read at boot. The simulator must be compiled out of a production image, so it
# defaults off here and can only be turned on by an explicit build arg.
ARG NEXT_PUBLIC_ENABLE_NFC_SIMULATOR=false
ENV NEXT_PUBLIC_ENABLE_NFC_SIMULATOR=$NEXT_PUBLIC_ENABLE_NFC_SIMULATOR

RUN npm run build

# --------------------------------------------------------------- runtime deps
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# -------------------------------------------------------------------- runtime
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Never run the money handler as root.
RUN addgroup -S app && adduser -S -G app app

COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/.next ./.next
COPY --chown=app:app package.json next.config.ts ./

# The release command needs these; they are not part of the Next build output.
COPY --chown=app:app lib/db/migrations ./lib/db/migrations
COPY --chown=app:app scripts/migrate.mjs ./scripts/migrate.mjs

USER app
EXPOSE 3000

# Hits the real health route, which does a database round trip. A container
# that cannot reach Postgres is not healthy, however alive its event loop is.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1 || exit 1

# Migrations are a deliberate release step (`npm run db:migrate`), not part of
# boot: a container that migrates on start races its own replicas and turns a
# rollback into a schema change. See docs/deployment.md.
CMD ["npm", "run", "start"]
