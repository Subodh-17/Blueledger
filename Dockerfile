# Multi-stage production Dockerfile for SIH25038 Blue Carbon Registry & MRV

# ── Stage 1: Dependency Assembly ─────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package manifests
COPY backend/package*.json ./backend/

WORKDIR /app/backend
RUN npm ci --omit=dev

# ── Stage 2: Production Minimal Runtime ──────────────────────────────────────
FROM node:22-alpine AS runner

# Install healthcheck utility and timezone data
RUN apk add --no-cache curl tzdata && rm -rf /var/cache/apk/*

WORKDIR /app

# Configure persistent upload directory and permissions
RUN mkdir -p /app/backend /app/frontend /app/database /app/uploads && \
    chown -R node:node /app

USER node

# Copy dependencies and application source
COPY --chown=node:node --from=builder /app/backend/node_modules ./backend/node_modules
COPY --chown=node:node backend/ ./backend/
COPY --chown=node:node frontend/ ./frontend/
COPY --chown=node:node database/ ./database/

# Production environment defaults
ENV NODE_ENV=production \
    PORT=4000 \
    DB_HOST=db \
    DB_PORT=5432 \
    DB_NAME=blue_carbon_mrv \
    DB_USER=postgres \
    TZ=UTC \
    UPLOAD_DIR=/app/uploads

EXPOSE 4000

# Periodic container healthcheck against Express endpoint
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://127.0.0.1:4000/health || exit 1

WORKDIR /app/backend
CMD ["node", "src/index.js"]
