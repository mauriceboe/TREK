# Stage 1: React Client bauen
FROM node:22-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Stage 2: Produktions-Server
FROM node:22-alpine

WORKDIR /app

# Timezone support + Server-Dependencies (better-sqlite3 braucht Build-Tools)
COPY server/package*.json ./
RUN apk add --no-cache tzdata su-exec python3 make g++ && \
    npm ci --production && \
    apk del python3 make g++

# Server-Code kopieren
COPY server/ ./

# Gebauten Client kopieren
COPY --from=client-builder /app/client/dist ./public

# Fonts für PDF-Export kopieren
COPY --from=client-builder /app/client/public/fonts ./public/fonts

# Verzeichnisse erstellen + Symlink für Abwärtskompatibilität (alte docker-compose mounten nach /app/server/uploads)
RUN mkdir -p /app/data /app/uploads/files /app/uploads/covers /app/uploads/avatars /app/uploads/photos && \
    mkdir -p /app/server && ln -s /app/uploads /app/server/uploads && ln -s /app/data /app/server/data

# Fix permissions on mounted volumes at runtime and run as node user
RUN chown -R node:node /app

# Umgebung setzen
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# Entrypoint: fix volume permissions then start as node
CMD ["sh", "-c", "chown -R node:node /app/data /app/uploads 2>/dev/null; exec su-exec node node --import tsx src/index.ts"]
