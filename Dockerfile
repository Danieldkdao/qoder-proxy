FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN node scripts/build.mts

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:24-slim AS runtime
ARG QODERCLI_VERSION=1.1.84
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g @qoder-ai/qodercli@${QODERCLI_VERSION} && qodercli --version
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 QODERCLI_BIN=/usr/local/bin/qodercli
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=production-dependencies --chown=node:node /app/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /app/dist/ ./dist/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=8s --start-period=15s --retries=3 CMD node -e "require('node:http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node","dist/server.js"]
