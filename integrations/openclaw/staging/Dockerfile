# sales-management STAGING cho Phase 2 (OpenClaw). Build từ ĐÚNG một git ref
# (mặc định tag release đang chạy production) — xem scripts/build-staging-api.sh,
# không build từ working tree của developer.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=staging
# typeorm nằm trong devDependencies nên giữ nguyên node_modules của bước build.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# FcmService đọc service account theo đường dẫn tương đối với cwd.
COPY --from=build /app/src/config ./src/config
# Nhiều module tạo ./uploads/<x> ngay lúc khởi động — user node phải ghi được.
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads
USER node
EXPOSE 3021
CMD ["node", "dist/main.js"]
