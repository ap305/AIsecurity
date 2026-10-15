# ============================================================
# AI安全教学实验系统 — 多阶段构建
# Stage 1: Node build (pnpm + Vite)
# Stage 2: Nginx Alpine (DaoCloud mirror)
# ============================================================

# ---- Stage 1: Build ----
FROM docker.m.daocloud.io/library/node:20-alpine AS builder

# Install pnpm via npm (with retry-friendly registry)
RUN npm install -g pnpm@9

WORKDIR /app

# Install dependencies first (cache layer)
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY package.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

RUN pnpm --filter web build

# ---- Stage 2: Serve ----
FROM docker.m.daocloud.io/library/nginx:stable-alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom nginx config
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Copy built assets from builder
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
