FROM node:20-bookworm-slim AS build

WORKDIR /app
RUN npm install -g npm@latest

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY backend/validation-harness/package.json backend/validation-harness/package-lock.json backend/validation-harness/
COPY frontend/package.json frontend/package.json
RUN npm ci --ignore-scripts \
  && npm ci --prefix backend/validation-harness

COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
RUN npm install -g npm@latest

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY backend/validation-harness/package.json backend/validation-harness/package-lock.json backend/validation-harness/
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --ignore-scripts \
  && npm ci --prefix backend/validation-harness \
  && npm rebuild better-sqlite3 -w backend

COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist frontend/dist
COPY backend/validation-harness/eslint.config.js backend/validation-harness/vitest.config.js backend/validation-harness/
RUN mkdir -p backend/validation-harness/runs \
  && chown -R node:node /app
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "backend/dist/server.js"]
