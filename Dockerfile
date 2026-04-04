# Stage 1: Build React client
FROM node:22-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Production server
FROM node:22-alpine

WORKDIR /app

# Timezone support + native deps (better-sqlite3 needs build tools)
COPY server/package*.json ./
RUN apk add --no-cache tzdata dumb-init su-exec python3 make g++ && \
    npm ci --production && \
    apk del python3 make g++

COPY server/ ./
COPY --from=client-builder /app/client/dist ./public
COPY --from=client-builder /app/client/public/fonts ./public/fonts

RUN mkdir -p /app/data/logs /app/uploads/files /app/uploads/covers /app/uploads/avatars /app/uploads/photos && \
    mkdir -p /app/server && ln -s /app/uploads /app/server/uploads && ln -s /app/data /app/server/data && \
    chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "chown -R node:node /app/data /app/uploads 2>/dev/null || true; exec su-exec node node --import tsx src/index.ts"]
