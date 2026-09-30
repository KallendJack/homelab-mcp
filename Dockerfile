# Stage 1: production dependencies only, installed with the pnpm version pinned in package.json.
FROM node:24-alpine3.24 AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod --ignore-scripts

# Stage 2: the server. Node 24 runs the TypeScript directly, so there is no build step.
FROM node:24-alpine3.24
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# The image's own unprivileged user. The server writes nothing, so it also runs with a read-only root filesystem.
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 8765}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.ts"]
