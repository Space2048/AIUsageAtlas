# ---------- 构建阶段 ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY . .
RUN npx nuxt build

# ---------- 运行阶段 ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
COPY --from=builder /app/.output /app/.output
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
