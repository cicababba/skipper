FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# ---- Dependencies ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
RUN pnpm install --frozen-lockfile

# ---- Builder ----
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/ ./
COPY . .

# Build all packages then the web app
RUN pnpm turbo build

# ---- Runner ----
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nestbrain

# Copy standalone Next.js output
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

# Data directories
RUN mkdir -p /app/data/raw/assets /app/data/wiki/sources /app/data/wiki/concepts /app/data/wiki/outputs /app/data/chromadb && \
    chown -R nestbrain:nodejs /app/data

USER nestbrain
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
