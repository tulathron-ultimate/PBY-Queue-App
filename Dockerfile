# syntax=docker/dockerfile:1

# ---- deps: all workspace dependencies (dev included) for the build ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# better-sqlite3 ships prebuilt binaries (glibc and musl, x64 and arm64), and no other
# dependency needs an install script, so nothing is compiled and no build tools are needed.
RUN npm ci --ignore-scripts --no-audit --no-fund

# ---- build: shared → server → web ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build

# ---- prod-deps: only what the server needs at runtime ----
FROM deps AS prod-deps
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund \
  --workspace @pby/server --include-workspace-root=false

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/pby-queue.db \
    WEB_DIST=/app/web/dist
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/package.json ./web/
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
