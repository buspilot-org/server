# buspilot-engine. Node runs the TypeScript sources directly (type stripping),
# so there is no build step.
FROM node:26-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:${PORT:-8080}/healthz > /dev/null || exit 1
CMD ["node", "src/main.ts"]
